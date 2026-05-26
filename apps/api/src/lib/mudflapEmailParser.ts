/**
 * Mudflap email parser.
 *
 * Mudflap sends a receipt email to fuel@curzontrucking.com after every
 * fuel-up. A Google Apps Script polls Gmail, forwards each unread
 * message to POST /v1/fuel-transactions/inbound-email with the full
 * raw MIME plus an optional base64-encoded PDF attachment. This module
 * pulls the transaction fields out of one of those payloads.
 *
 * STATUS: stub. The parser body is not implemented because we don't
 * have a sample email yet — once one lands in fuel@curzontrucking.com
 * and the user forwards a copy, we'll port the parsing logic here
 * (likely: HTML body has a deterministic table structure; PDF is a
 * backup if the HTML can't be relied on).
 *
 * Current behaviour: returns `ok: false` with reason 'parser_not_implemented'
 * so the GAS sees a soft failure and DOESN'T mark the message read.
 * Once we ship the real parser, the GAS will replay any messages that
 * accumulated in the meantime.
 */

import type { FuelTransaction, FuelTransactionProvider } from "@fleetcal/types";

/**
 * Output shape for a successful parse. Note we strip orgId / id /
 * timestamps / match fields — those are set by the calling endpoint
 * (the parser knows nothing about the org context).
 */
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

export async function parseMudflapEmail(args: {
  raw:     string;
  pdfB64?: string;
}): Promise<ParseResult> {
  // Re-suppress unused-vars warnings until the real parser uses them.
  void args.raw;
  void args.pdfB64;
  return {
    ok:     false,
    reason: "parser_not_implemented — waiting on sample Mudflap email to model the extractor",
  };
}

// Re-export the input args shape too so tests / future parsers can
// import it without redeclaring.
export type MudflapEmailInput = Parameters<typeof parseMudflapEmail>[0];

// Satisfy `FuelTransaction` re-export users.
export type { FuelTransaction };
