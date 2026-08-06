/**
 * Remittance extraction — the single generic path from a raw document to a
 * RemittanceDoc.
 *
 * There is deliberately no per-vendor adapter here. Every remittance, from
 * any payer, in any format, goes through this one function. What varies per
 * customer is DATA passed in as context (`ExtractContext`), never a code
 * branch — so a vendor changing its layout is a row edit plus a replay, not
 * a deploy.
 *
 * Two things make one generic path viable:
 *
 *  1. **Schema-constrained output.** `output_config.format` forces the model
 *     to return exactly the RemittanceDoc shape. The predecessor asked for
 *     JSON in prose and then regex-scraped the reply, which fails open —
 *     malformed output became a silent parse error. Here it cannot happen.
 *
 *  2. **The totals invariant downstream.** `checkTotals` catches a dropped
 *     or misread row regardless of which vendor produced the document, so
 *     extraction does not have to be trusted blindly. It is checked.
 *
 * The extractor also answers "is this a remittance at all?" (`isRemittance`),
 * which is stage ① of the pipeline. Roughly 84% of the billing mailbox is
 * BOL confirmations, portal workflow notices, PODs and paperwork replies —
 * asking the model to say so is cheaper and far more general than
 * maintaining sender/subject rules per vendor.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  DocumentBlockParam,
  ImageBlockParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { env } from "./env.js";
import type { RemittanceDoc, RemittanceLine, RemittanceSource } from "./remittanceMatcher.js";

const client = new Anthropic({ apiKey: env.anthropicApiKey });

/** Extraction is the accuracy-critical stage: everything downstream can only
 *  be as good as the rows pulled off the page, and a misread row costs a
 *  wrong allocation or a support ticket. Documents are small, so this is a
 *  few cents each — not a place to economise. */
const EXTRACT_MODEL = "claude-opus-5";

// ── Input ─────────────────────────────────────────────────────────────

export interface ExtractInput {
  /** How the document arrived. Drives block type only, not prompt content. */
  kind:      RemittanceSource;
  /** Base64 for `pdf` and `image`; UTF-8 text for the rest. */
  data:      string;
  /** Required for `image` — the model needs the real media type. */
  mediaType?: string | null;
  filename?: string | null;
  /** Email sender / subject, when there is one. Context for the payer name,
   *  never used to select a code path. */
  senderHint?:  string | null;
  subjectHint?: string | null;
}

/** Per-customer knowledge, supplied as data. All optional — the extractor
 *  works with none of it, just less well. */
export interface ExtractContext {
  customerName?: string | null;
  /** Free-text operator notes from customer_payment_profiles. */
  notes?: string | null;
  /** Confirmed past extractions for this customer: a short document excerpt
   *  paired with the output a human approved. This is what "gets smarter per
   *  customer" actually means in practice — inspectable rows that can be
   *  added, corrected, or deleted one at a time, rather than weights. */
  examples?: Array<{ excerpt: string; output: unknown }>;
}

export interface ExtractResult {
  doc:        RemittanceDoc | null;
  isRemittance: boolean;
  reason?:    string;
  /** The document printed no total, so paymentTotal is the sum of its rows.
   *  The dropped-row check cannot run against a figure derived FROM the
   *  rows it is meant to check — the caller must say so rather than show a
   *  green tick that means nothing. */
  derivedTotal?: boolean;
  /** The document carries no payment date. The operator supplies one. */
  missingDate?:  boolean;
  /** Raw model output, kept for the review queue and for replaying an
   *  extraction after a rule or prompt change. */
  raw:        unknown;
  usage?:     { input: number; output: number };
}

// ── Output schema ─────────────────────────────────────────────────────

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] };

const LINE_SCHEMA = {
  type: "object",
  properties: {
    rowIndex:           { type: "integer" },
    referenceAsPrinted: nullableString,
    amount:             { type: "number" },
    gross:              nullableNumber,
    deduction:          nullableNumber,
    deductionLabel:     nullableString,
  },
  required: ["rowIndex", "referenceAsPrinted", "amount", "gross", "deduction", "deductionLabel"],
  additionalProperties: false,
} as const;

const DOC_SCHEMA = {
  type: "object",
  properties: {
    isRemittance:        { type: "boolean" },
    notRemittanceReason: nullableString,
    payerNameAsPrinted:  { type: "string" },
    paymentDate:         nullableString,
    paymentTotal:        nullableNumber,
    externalId:          nullableString,
    lines:               { type: "array", items: LINE_SCHEMA },
    unparsedRows:        { type: "array", items: { type: "string" } },
  },
  required: [
    "isRemittance", "notRemittanceReason", "payerNameAsPrinted",
    "paymentDate", "paymentTotal", "externalId", "lines", "unparsedRows",
  ],
  additionalProperties: false,
} as const;

// ── Prompt ────────────────────────────────────────────────────────────

/**
 * Vendor-neutral by construction. Every rule below is about how to READ a
 * document, not about who sent it.
 *
 * The verbatim rule is the load-bearing one. ITS prints
 * `4419274-21 | 4419274-21` for a single reference; a model asked to tidy
 * that field returns something plausible and inconsistent, and the
 * normalization rules downstream then have nothing stable to work from.
 * Cleaning is versioned code's job precisely so it can be replayed and
 * corrected.
 */
const BASE_PROMPT = `You are extracting a payment remittance for a trucking carrier, so its payments can be applied to the right invoices.

FIRST decide whether this document is a remittance / payment advice at all — a notice that money HAS BEEN SENT to the carrier. Set isRemittance accordingly.

These are NOT remittances (set isRemittance false and explain in notRemittanceReason):
  • bills or invoices the carrier OWES someone
  • proof-of-delivery, bills of lading, or document-submission confirmations
  • "invoice received / pending approval / rejected" workflow notices
  • account statements, rate confirmations, general correspondence

If it IS a remittance, transcribe it. Follow these rules exactly:

1. COPY REFERENCES CHARACTER FOR CHARACTER into referenceAsPrinted.
   Do not tidy, trim, de-duplicate, pad, unpad, or reformat them. If a cell
   repeats the same value with a separator, return the whole cell as shown.
   If a value has leading zeros, keep them. If it has a prefix or suffix you
   suspect is decoration, keep it anyway. Downstream code normalises against
   per-payer rules; it needs the untouched original to do that.

2. ONE OBJECT PER PRINTED ROW. Never merge rows that share an amount or a
   reference, never split one row into several. rowIndex is the row's
   position on the page, starting at 0.

3. amount is what was actually PAID on that row. If the row shows a gross
   amount and a deduction (quick-pay discount, chargeback, claim), put the
   gross in gross, the reduction in deduction with its printed label in
   deductionLabel, and the NET actually paid in amount.

4. The reference is whatever identifies the freight or the bill — it may be
   labelled invoice #, PRO #, load #, order #, BOL, reference, or carry no
   label at all. Choose by CONTENT, not by column heading: pick the column
   whose values identify a specific shipment or bill. Column headings lie.
   A column headed "Reference" may hold repeated charge codes rather than
   identifiers; if the same short code repeats on every row, it is a charge
   type, not a reference. If a row genuinely has no identifier, set
   referenceAsPrinted to null rather than substituting a different column.

5. paymentTotal is the total of the payment as DECLARED on the document
   (check total, ACH total, amount paid). Do not compute it yourself by
   adding the rows — the declared figure is checked against the row sum
   downstream, and that comparison is what catches a row you missed.

6. externalId is the document's own unique identifier if it has one — check
   number, remittance advice number, transaction id, payment reference.
   null if absent.

7. If any row is unreadable or you are unsure of its values, put the raw text
   of that row in unparsedRows rather than guessing. A row in unparsedRows is
   handled by a human; a guessed row corrupts the books.

8. Dates are YYYY-MM-DD. Amounts are plain numbers — no currency symbols,
   no thousands separators.

9. If the document is a screenshot or photo, read the table exactly as laid
   out on screen. Keep each visual row intact — the column a number sits in
   is what gives it meaning, so never pair an amount with a reference from a
   different row. If the image is cut off, blurred, or a row is partly
   obscured, put that row in unparsedRows instead of inferring it. A payment
   total that is visible but whose rows are not fully readable should still
   be reported, with the unreadable rows listed.`;

function buildPrompt(input: ExtractInput, ctx: ExtractContext): string {
  const parts = [BASE_PROMPT];

  const hints: string[] = [];
  if (input.filename)    hints.push(`filename: ${input.filename}`);
  if (input.senderHint)  hints.push(`from: ${input.senderHint}`);
  if (input.subjectHint) hints.push(`subject: ${input.subjectHint}`);
  if (hints.length) {
    parts.push(
      `\nDOCUMENT METADATA (context only — the document itself is authoritative):\n` +
      hints.map((h) => `  ${h}`).join("\n"),
    );
  }

  if (ctx.customerName || ctx.notes) {
    parts.push(
      `\nWHAT WE KNOW ABOUT THIS PAYER:\n` +
      (ctx.customerName ? `  known to us as: ${ctx.customerName}\n` : "") +
      (ctx.notes ? `  operator notes: ${ctx.notes}\n` : "") +
      `  Treat this as background. If the document disagrees, the document wins.`,
    );
  }

  if (ctx.examples?.length) {
    parts.push(
      `\nPREVIOUSLY CONFIRMED EXTRACTIONS FOR THIS PAYER\n` +
      `(a human verified each of these; match this reading of the layout):\n` +
      ctx.examples
        .slice(0, 3)
        .map((e, i) =>
          `--- example ${i + 1} ---\n${e.excerpt.slice(0, 1500)}\n` +
          `→ ${JSON.stringify(e.output)}`)
        .join("\n"),
    );
  }

  return parts.join("\n");
}

// ── Extraction ────────────────────────────────────────────────────────

interface RawDoc {
  isRemittance:        boolean;
  notRemittanceReason: string | null;
  payerNameAsPrinted:  string;
  paymentDate:         string | null;
  paymentTotal:        number | null;
  externalId:          string | null;
  lines:               Array<{
    rowIndex:           number;
    referenceAsPrinted: string | null;
    amount:             number;
    gross:              number | null;
    deduction:          number | null;
    deductionLabel:     string | null;
  }>;
  unparsedRows:        string[];
}

export async function extractRemittance(
  input: ExtractInput,
  ctx:   ExtractContext = {},
): Promise<ExtractResult> {
  const prompt = buildPrompt(input, ctx);

  const content: ContentBlockParam[] = [];
  if (input.kind === "pdf") {
    const doc: DocumentBlockParam = {
      type:   "document",
      source: { type: "base64", media_type: "application/pdf", data: input.data },
    };
    content.push(doc);
  } else if (input.kind === "image") {
    // Screenshots of a payment screen are common — some payers send nothing
    // else. Read natively rather than through an OCR service: OCR would
    // return a flat character soup and lose the table structure that tells
    // us which amount belongs to which reference, which is the entire point.
    const media = (input.mediaType ?? "").toLowerCase();
    const supported = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    const image: ImageBlockParam = {
      type:   "image",
      source: {
        type: "base64",
        media_type: (supported.includes(media) ? media : "image/png") as
          "image/jpeg" | "image/png" | "image/gif" | "image/webp",
        data: input.data,
      },
    };
    content.push(image);
  } else {
    // CSV / spreadsheet text / email body all read the same way: as text.
    // Fenced so the model can see exactly where the document begins and ends.
    const body: TextBlockParam = {
      type: "text",
      text: `DOCUMENT (${input.kind}${input.filename ? `, ${input.filename}` : ""}):\n\`\`\`\n${input.data}\n\`\`\``,
    };
    content.push(body);
  }
  content.push({ type: "text", text: prompt } satisfies TextBlockParam);

  // Streamed: a long remittance plus adaptive thinking can run past the
  // non-streaming HTTP timeout, and a timeout here looks identical to a
  // parse failure from the caller's side.
  const stream = client.messages.stream({
    model:      EXTRACT_MODEL,
    max_tokens: 16000,
    thinking:   { type: "adaptive" },
    output_config: {
      format: { type: "json_schema", schema: DOC_SCHEMA as unknown as Record<string, unknown> },
    },
    messages: [{ role: "user", content }],
  } as Parameters<typeof client.messages.stream>[0]);

  const message = await stream.finalMessage();
  const text = message.content.find((b) => b.type === "text");
  const raw: RawDoc = JSON.parse(text && text.type === "text" ? text.text : "{}");

  const usage = {
    input:  message.usage?.input_tokens  ?? 0,
    output: message.usage?.output_tokens ?? 0,
  };

  if (!raw.isRemittance) {
    return {
      doc: null, isRemittance: false, raw, usage,
      reason: raw.notRemittanceReason ?? "not a remittance",
    };
  }

  // Plenty of real remittances print neither a total nor a payment date —
  // a check stub listing bills is still a payment. Refusing those outright
  // threw away documents whose rows were perfectly readable, so missing
  // header fields are now degradations, not failures. What cannot be
  // degraded is having no rows: with nothing to apply there is no payment.
  if (!raw.lines?.length) {
    return {
      doc: null, isRemittance: true, raw, usage,
      reason: "no payment rows could be read from this document",
    };
  }

  const lines: RemittanceLine[] = (raw.lines ?? []).map((l, i) => ({
    rowIndex:           Number.isFinite(l.rowIndex) ? l.rowIndex : i,
    referenceAsPrinted: l.referenceAsPrinted ?? null,
    amount:             Number(l.amount) || 0,
    gross:              l.gross ?? null,
    deduction:          l.deduction ?? null,
    deductionLabel:     l.deductionLabel ?? null,
  }));

  const derivedTotal = raw.paymentTotal == null;
  const missingDate   = !raw.paymentDate;
  const lineSum = Math.round(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0) * 100) / 100;

  const doc: RemittanceDoc = {
    source:             input.kind,
    payerNameAsPrinted: raw.payerNameAsPrinted ?? "",
    // Empty rather than invented. The panel makes the operator supply it,
    // because a guessed payment date lands on the proof and then on every
    // allocation citing it.
    paymentDate:        missingDate ? "" : String(raw.paymentDate).slice(0, 10),
    paymentTotal:       derivedTotal ? lineSum : (Number(raw.paymentTotal) || 0),
    externalId:         raw.externalId ?? null,
    lines,
    unparsedRows:       raw.unparsedRows ?? [],
  };

  return { doc, isRemittance: true, raw, usage, derivedTotal, missingDate };
}
