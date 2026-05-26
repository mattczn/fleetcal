/**
 * Mudflap email parser.
 *
 * Mudflap sends a receipt email to fuel@curzontrucking.com after every
 * fuel-up. A Google Apps Script polls Gmail, forwards each unread
 * message to POST /v1/fuel-transactions/inbound-email with the full
 * raw MIME plus an optional base64-encoded PDF attachment. This module
 * pulls the transaction fields out of the HTML body.
 *
 * The HTML body has a stable table-row structure:
 *
 *   PURCHASE DATE   →  "Mon, May 25, 2026"
 *   TRANSACTION ID  →  "T724791761063"
 *   PURCHASED BY    →  "Kevin Duron"
 *
 *   You made a purchase at the following stop:
 *   <b>Maverik #625 - North Salt Lake, UT<br>
 *     24 N Redwood Rd<br>
 *     I-215, EXIT 27 & CR-68, North Salt Lake, UT, 84054</b>
 *
 *   DIESEL #2
 *     GALLONS         86.000
 *     RETAIL PRICE    $5.56/gal
 *     MUDFLAP PRICE   $5.47/gal
 *     TOTAL           $470.33
 *
 *   DEF
 *     GALLONS         8.160
 *     RETAIL PRICE    $4.80/gal
 *     MUDFLAP PRICE   $4.80/gal
 *     TOTAL           $39.17
 *
 *   SUBTOTAL          $509.50
 *   CHARGED           $509.50
 *   PAYMENT METHOD    JPMORGAN CHASE BANK, NA •••• 3605
 *                     You saved $7.74
 *   TOTAL CHARGED     $509.50
 *
 * Note: the email body is quoted-printable encoded (lines wrapped with
 * trailing `=` and `=3D` for `=`). We decode that first, then run
 * regex against the resulting HTML. No HTML parser dep is needed
 * because the structure is deterministic.
 *
 * The receipt does NOT include a truck unit number — Mudflap doesn't
 * collect that. The auto-matcher relies on driver name + date + gallons
 * to pair this with a driver-app fuel_report.
 */

import type { FuelTransactionProvider } from "@fleetcal/types";

export interface ParsedMudflapTransaction {
  provider:              FuelTransactionProvider;
  providerTransactionId: string;
  transactionDate:       string;   // YYYY-MM-DD
  driverName?:           string;
  location?:             string;
  matchedTruck?:         string;
  dieselGallons?:        number;
  dieselRetailPrice?:    number;
  dieselDiscountPrice?:  number;
  dieselTotal?:          number;
  defGallons?:           number;
  defRetailPrice?:       number;
  defDiscountPrice?:     number;
  defTotal?:             number;
  totalCharged:          number;
  totalSaved:            number;
  paymentLast4?:         string;
}

export type ParseResult =
  | { ok: true;  transaction: ParsedMudflapTransaction }
  | { ok: false; reason: string };

// ── Quoted-printable decoder ───────────────────────────────────────────
//
// Mudflap encodes the HTML body as quoted-printable (RFC 2045 §6.7):
//   • `=` at end of line means "soft line break" — join with next line
//   • `=XX` (two hex chars) is a byte (decimal value of hex) interpreted
//     as the email's declared charset (UTF-8 in our case)
// We don't have to handle non-UTF-8 — Mudflap's Content-Type explicitly
// says charset=UTF-8.

function decodeQuotedPrintable(input: string): string {
  // First, undo soft line breaks (trailing `=` followed by newline).
  const joined = input.replace(/=\r?\n/g, "");
  // Then decode =XX byte escapes. We collect bytes into a buffer and
  // UTF-8 decode at the end so multi-byte sequences (• = E2 80 A2) come
  // out as their actual character, not three garbage characters.
  const out: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i];
    if (ch === "=" && i + 2 < joined.length) {
      const hex = joined.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    // Plain ASCII char — store its UTF-8 byte (always 1 byte for code points < 128).
    out.push(ch.charCodeAt(0));
  }
  return Buffer.from(out).toString("utf8");
}

// ── MIME body extraction ───────────────────────────────────────────────

/**
 * Pull the text/html part out of a multipart MIME message. Mudflap
 * sends a multipart/alternative inside multipart/mixed (the outer
 * carries the PDF attachment); we want the HTML alternative.
 */
function extractHtmlBody(raw: string): string | null {
  // Find every part header; pick the first one declaring text/html.
  // We anchor on the Content-Type header followed by a blank line then
  // body content, terminated by a MIME boundary line (`--…`).
  //
  // Normalize CRLF → LF first so our anchors don't need to handle both
  // line-ending styles. Mudflap (Amazon SES) sends CRLF.
  const norm = raw.replace(/\r\n/g, "\n");
  const m = norm.match(
    /Content-Type:\s*text\/html[^\n]*\n(?:[^\n]+\n)*?\n([\s\S]*?)\n--/i,
  );
  if (!m) return null;
  return m[1];
}

// ── Field extractors ───────────────────────────────────────────────────

function moneyToNumber(s: string): number | undefined {
  const m = s.match(/\$?\s*([\d,]+\.?\d*)/);
  if (!m) return undefined;
  return Number(m[1].replace(/,/g, ""));
}

/** Find the value B in a row like "<td...>A</td>...<td...><b>B</b></td>". */
function findRowValue(html: string, labelPattern: RegExp): string | undefined {
  // After the label-cell, skip any whitespace + html tags until we hit <b>...</b>
  const re = new RegExp(
    labelPattern.source +
      // The label is in a <td>; the value <b> may be one or more rows down
      // depending on rowspan / spacing. We scan up to ~600 chars.
      "[\\s\\S]{0,600}?<b[^>]*>\\s*([^<]+?)\\s*</b>",
    labelPattern.flags,
  );
  const m = html.match(re);
  return m?.[1]?.trim();
}

/** Parse "Mon, May 25, 2026" → "2026-05-25". Returns "" on parse error. */
function parseHumanDate(s: string): string {
  // JS Date parses this format natively. We only want the date, so
  // we anchor to UTC midnight to avoid TZ drift.
  const t = Date.parse(s);
  if (isNaN(t)) return "";
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Extract a per-fuel-type block.  e.g. extractFuelSection(html, "DIESEL")
 *  returns the gallons / retail / discount / total for diesel.  */
interface FuelBlock {
  gallons?:       number;
  retailPrice?:   number;
  discountPrice?: number;
  total?:         number;
}
function extractFuelSection(html: string, label: RegExp): FuelBlock {
  // Find the <b>LABEL</b> header, then read the next ~4 rows for
  // GALLONS / RETAIL PRICE / MUDFLAP PRICE / TOTAL. The section ends
  // at the next <b>HEADER</b> or </table>.
  const headerMatch = html.match(label);
  if (!headerMatch) return {};
  const start = headerMatch.index! + headerMatch[0].length;
  // Cut to next fuel-type header or divider so we don't grab the next
  // section's values.
  const tail = html.slice(start);
  const stopMatch = tail.match(/<b>\s*(?:DIESEL|DEF|GASOLINE|REEFER)/i);
  const cropped = stopMatch ? tail.slice(0, stopMatch.index!) : tail;

  const gallons     = findRowValue(cropped, /GALLONS/i);
  const retail      = findRowValue(cropped, /RETAIL PRICE/i);
  const discount    = findRowValue(cropped, /MUDFLAP PRICE/i);
  const total       = findRowValue(cropped, /TOTAL/i);

  return {
    gallons:       gallons       != null ? Number(gallons.replace(/,/g, "")) : undefined,
    retailPrice:   retail        != null ? moneyToNumber(retail) : undefined,
    discountPrice: discount      != null ? moneyToNumber(discount) : undefined,
    total:         total         != null ? moneyToNumber(total) : undefined,
  };
}

/** Strip the second line of a multi-line stop address. Mudflap renders:
 *    Maverik #625 - North Salt Lake, UT<br>
 *      24 N Redwood Rd<br>
 *      I-215, EXIT 27 & CR-68, North Salt Lake, UT, 84054
 *  We keep the first line — that's the canonical station name + city. */
function firstLine(s: string): string {
  return s.split(/\r?\n|<br\s*\/?>/i)[0].trim();
}

// ── Main parser ────────────────────────────────────────────────────────

export async function parseMudflapEmail(args: {
  raw:     string;
  pdfB64?: string;
}): Promise<ParseResult> {
  const htmlEncoded = extractHtmlBody(args.raw);
  if (!htmlEncoded) {
    return { ok: false, reason: "no_html_body_found" };
  }
  const html = decodeQuotedPrintable(htmlEncoded);

  // Transaction ID — required. If it's missing, we can't dedup so we bail.
  const txId = findRowValue(html, /TRANSACTION ID/i);
  if (!txId || !/^T\d+/.test(txId)) {
    return { ok: false, reason: "transaction_id_missing" };
  }

  // Purchase date — required.
  const purchaseDateStr = findRowValue(html, /PURCHASE DATE/i);
  const transactionDate = purchaseDateStr ? parseHumanDate(purchaseDateStr) : "";
  if (!transactionDate) {
    return { ok: false, reason: `bad_purchase_date: "${purchaseDateStr ?? ""}"` };
  }

  // Driver name — optional ("PURCHASED BY"). We store the full name as
  // shown; the matcher does case-insensitive substring against driver
  // records so "Kevin Duron" matches a driver named "Kevin" too.
  const driverName = findRowValue(html, /PURCHASED BY/i);

  // Location — pull the first <b>...</b> after "purchase at the following
  // stop:". Note: the open-tag matcher requires a space or `>` after the
  // `b` so it doesn't accidentally match `<br>` (Mudflap puts a `<br>`
  // between the marker and the actual location <b>, and `<b[^>]*>` would
  // greedily consume `<br>` because `r` matches `[^>]*`).
  const locMatch = html.match(/purchase at the following stop:\s*<\/span>[\s\S]{0,200}?<b(?:\s[^>]*)?>\s*([^]+?)\s*<\/b>/i);
  const location = locMatch ? firstLine(locMatch[1]) : undefined;

  // Fuel sections. DIESEL #2 is the common label; the regex covers
  // variants Mudflap might send (DIESEL, DIESEL #1, etc.).
  const diesel = extractFuelSection(html, /<b>\s*DIESEL[^<]*<\/b>/i);
  const def    = extractFuelSection(html, /<b>\s*DEF\s*<\/b>/i);

  // Final totals. "TOTAL CHARGED" appears AFTER "CHARGED" / "SUBTOTAL".
  // We anchor on TOTAL CHARGED so we get the final number even if a
  // partial charge was applied (CHARGED can equal SUBTOTAL when no
  // discount block sits between them).
  const totalChargedStr = findRowValue(html, /TOTAL CHARGED/i);
  const totalCharged = totalChargedStr ? moneyToNumber(totalChargedStr) : undefined;
  if (totalCharged == null) {
    return { ok: false, reason: "total_charged_missing" };
  }

  // Discount total — "You saved $X.XX". May appear in two places (the
  // intro paragraph and the per-section). The intro line is most stable.
  const savedMatch = html.match(/You saved\s*\$([\d,]+\.?\d*)/i);
  const totalSaved = savedMatch ? Number(savedMatch[1].replace(/,/g, "")) : 0;

  // Payment last 4 — "JPMORGAN CHASE BANK, NA •••• 3605". Mudflap uses
  // U+2022 bullets between the bank and the digits.
  const payMatch = html.match(/[••●]{2,}\s*<\/span>\s*<b>\s*(\d{4})/);
  const paymentLast4 = payMatch?.[1];

  return {
    ok: true,
    transaction: {
      provider:             "mudflap",
      providerTransactionId: txId,
      transactionDate,
      driverName,
      location,
      matchedTruck:         undefined, // Mudflap doesn't include unit #
      dieselGallons:        diesel.gallons,
      dieselRetailPrice:    diesel.retailPrice,
      dieselDiscountPrice:  diesel.discountPrice,
      dieselTotal:          diesel.total,
      defGallons:           def.gallons,
      defRetailPrice:       def.retailPrice,
      defDiscountPrice:     def.discountPrice,
      defTotal:             def.total,
      totalCharged,
      totalSaved,
      paymentLast4,
    },
  };
}

export type MudflapEmailInput = Parameters<typeof parseMudflapEmail>[0];
