/**
 * Remittance matcher.
 *
 * Turns a remittance document — from any source, in any format — into a set
 * of proposed invoice_payments allocations.
 *
 * One generic extractor handles every source. There are no per-vendor code
 * paths, by design: vendor knowledge lives in per-customer DATA (reference
 * rules, aliases, few-shot examples) that can be edited, replayed over
 * history, and retired, rather than in branches that have to be found and
 * unpicked when a vendor changes format.
 *
 *     raw document (csv | pdf | email body | xlsx)
 *            ↓  extract          ← one path, schema-constrained
 *       RemittanceDoc            ← universal contract (this file)
 *            ↓  checkTotals      ← invariant; a failed doc never reaches the DB
 *            ↓  resolveLines     ← candidate generation + namespace lookup
 *       ResolvedLine[]           ← invoice_id | null, with confidence + reason
 *            ↓  caller
 *     payment_proof + invoice_payments  (or the review queue)
 *
 * Design rules, each of which is a direct response to a defect in the
 * predecessor system (my-calendar `ar_remittance_parser.py`):
 *
 *  1. Lines carry their OWN amount. The old parser emitted a bare
 *     `invoice_references: string[]`, which left the caller no choice but to
 *     prorate the total across references — the cause of a $150 invoice
 *     being recorded as $3,675 paid. A line without an amount is not a line.
 *
 *  2. `sum(lines) === total` is enforced before anything is written. The old
 *     parser truncated input at 4,000 chars and capped output at 512 tokens,
 *     so long remittances silently lost rows with no error anywhere.
 *
 *  3. The REFERENCE matches. The AMOUNT only adjusts confidence — with one
 *     tightly fenced exception. Matching on amount alone produces confident
 *     wrong allocations, which are worse than no allocation because nobody
 *     goes looking for them, so `scoreLine` cannot turn an amount into a
 *     match. The exception is a last-resort fallback used only when the
 *     reference is unusable, and only when BOTH guards hold: the search is
 *     scoped to a single customer, and exactly one of their open invoices
 *     carries that exact balance. It scores 70 — below AUTO_APPLY_THRESHOLD
 *     — so it always reaches a human. It suggests; it never applies.
 *
 *  4. References are stored verbatim and normalized by RULE, not by prompt.
 *     Observed in the corpus: ITS prints `4419274-21 | 4419274-21` for what
 *     is one reference. Normalization is versioned code so a customer's
 *     format change is a data edit and past extractions can be replayed.
 *
 *  5. Ambiguity is never resolved by guessing. Two candidate invoices means
 *     confidence 0 and a trip to the review queue.
 *
 * Corpus calibration (billing@curzontrucking.com, 2026-07-16..08-03):
 *   • RTS/Cheema  `payment_remittance.csv` → carries invoice_number directly.
 *     22/22 resolved, amounts exact to the cent.
 *   • Loop/Transportation One `LP*.csv` → invoice_number + load number.
 *     2/2 resolved, exact.
 *   • ePayManager (Tin Goose, FreightTec, River City, NTG, Trident) →
 *     `Carrier Reference #` blank on 133/133 rows. No carrier-side identifier
 *     is transmitted at all. These cannot be matched by extraction and are
 *     routed to PROCESSOR_REF, which needs the submission-side link table.
 */

import { supabase as supabaseTyped } from "./supabase.js";
import { round2 } from "./invoicePayments.js";

// remittance_* tables aren't in generated types until migrations run.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

// ── The universal contract ────────────────────────────────────────────

/**
 * The MEDIUM a document arrived in — deliberately not the vendor.
 *
 * One generic extractor handles every source. Naming sources after vendors
 * ("rts_csv", "epay_csv") would push per-vendor branching into the type
 * system, and every such branch is an assumption that has to be unpicked
 * when the vendor changes format or a new one appears. Vendor-specific
 * handling, when it earns its place, belongs in per-customer DATA
 * (reference rules, few-shot examples) rather than in code paths.
 */
export type RemittanceSource =
  | "pdf"
  | "image"          // a screenshot or photo of a payment screen
  | "csv"
  | "spreadsheet"
  | "email_body"
  | "manual";        // keyed by a human

/** One printed row of a remittance. `referenceAsPrinted` is copied
 *  CHARACTER FOR CHARACTER from the document — adapters must not clean it
 *  up, because normalization is the resolver's job and it needs the
 *  original to work from. */
export interface RemittanceLine {
  rowIndex:            number;
  referenceAsPrinted:  string | null;
  /** What was actually paid on this line. Required — see design rule 1. */
  amount:              number;
  gross?:              number | null;
  deduction?:          number | null;
  deductionLabel?:     string | null;
}

export interface RemittanceDoc {
  source:              RemittanceSource;
  /** Payer name exactly as printed. May differ from both the customer's
   *  name in FleetCal and the descriptor on the bank line — e.g. the ITS
   *  remittance says "ITS National LLC" while the ACH says
   *  "ITS LOGISTICS LL", and Ardent's own email states the deposit will
   *  read "Forty Niner Logistics". Alias resolution is a separate concern. */
  payerNameAsPrinted:  string;
  paymentDate:         string;          // YYYY-MM-DD
  paymentTotal:        number;
  /** Vendor-side unique id, when the document has one: RTS `CK262330`,
   *  Loop `LP80765031`, ITS `REMIT208331`. Feeds
   *  payment_proofs.external_id, whose partial unique index on
   *  (org_id, source, external_id) makes re-ingest a no-op. */
  externalId:          string | null;
  lines:               RemittanceLine[];
  /** Rows the adapter could not read. Non-empty means a human should look,
   *  even if the totals happen to reconcile. */
  unparsedRows?:       string[];
}

// ── Invariant ─────────────────────────────────────────────────────────

export interface TotalsCheck {
  ok:        boolean;
  lineSum:   number;
  declared:  number;
  drift:     number;
  reason?:   string;
}

/** Cent tolerance, matching invoicePayments.ts. */
const CENT = 0.005;

/**
 * The single most valuable check in the pipeline. On a 40-line remittance a
 * dropped row is otherwise invisible: the allocations that DO land look
 * perfectly correct, and the invoice for the missing row silently stays
 * open. Nothing downstream can detect it after the fact.
 *
 * Callers must treat `ok === false` as fatal for the document — flag it for
 * review, do not write partial allocations from it.
 */
export function checkTotals(doc: RemittanceDoc): TotalsCheck {
  const lineSum  = round2(doc.lines.reduce((s, l) => s + (Number(l.amount) || 0), 0));
  const declared = round2(Number(doc.paymentTotal) || 0);
  const drift    = round2(lineSum - declared);

  if (!doc.lines.length) {
    return { ok: false, lineSum, declared, drift, reason: "no lines extracted" };
  }
  if (Math.abs(drift) > CENT) {
    return {
      ok: false, lineSum, declared, drift,
      reason: `line sum ${lineSum.toFixed(2)} != declared total ${declared.toFixed(2)}`,
    };
  }
  if (doc.unparsedRows?.length) {
    return {
      ok: false, lineSum, declared, drift,
      reason: `${doc.unparsedRows.length} row(s) could not be parsed`,
    };
  }
  return { ok: true, lineSum, declared, drift };
}

// ── Reference normalization ───────────────────────────────────────────

/** Per-customer transformations, applied in order. Stored as data
 *  (customer_payment_profiles.reference_rules) so a format change is an
 *  UPDATE rather than a deploy, and historical docs can be re-resolved. */
export type RefRule =
  | { kind: "split_take_first"; sep: string }        // ITS: "4419274-21 | 4419274-21"
  | { kind: "strip_suffix";     pattern: string }    // ITS: "-21"
  | { kind: "strip_prefix";     pattern: string }    // e.g. "INV"
  | { kind: "strip_zero_pad" }                       // Tin Goose: "0015873" → "15873"
  | { kind: "regex_extract";    pattern: string; group?: number };

/**
 * Produce every plausible form of a printed reference, cheapest first.
 *
 * Deliberately ACCUMULATES rather than reducing to a single normalized
 * string: over-normalizing loses hits that the raw form would have made,
 * and the lookup is a cheap indexed `in.(...)` either way. Order matters
 * only for tie-breaking — a hit is a hit regardless of which form produced
 * it.
 */
export interface RefCandidate {
  value: string;
  /** True only when a CUSTOMER-CONFIGURED rule produced this form. The
   *  built-in fallbacks are the same tested code on every document, so
   *  they carry no extra doubt; a freshly added rule does. */
  fromRule: boolean;
}

export function referenceCandidatesDetailed(
  raw: string | null, rules: RefRule[] = [],
): RefCandidate[] {
  if (!raw) return [];
  const out: RefCandidate[] = [];
  let inRules = false;
  const push = (v: string | null | undefined) => {
    const t = (v ?? "").trim();
    if (t && !out.some((c) => c.value === t)) out.push({ value: t, fromRule: inRules });
  };

  push(raw);
  let cur = raw.trim();

  inRules = true;
  for (const rule of rules) {
    try {
      switch (rule.kind) {
        case "split_take_first":
          cur = cur.split(rule.sep)[0] ?? cur;
          break;
        case "strip_suffix":
          if (cur.endsWith(rule.pattern)) cur = cur.slice(0, -rule.pattern.length);
          break;
        case "strip_prefix":
          if (cur.startsWith(rule.pattern)) cur = cur.slice(rule.pattern.length);
          break;
        case "strip_zero_pad":
          cur = cur.replace(/^0+(?=\d)/, "");
          break;
        case "regex_extract": {
          const m = new RegExp(rule.pattern).exec(cur);
          if (m) cur = m[rule.group ?? 1] ?? cur;
          break;
        }
      }
      // Trim the CARRY value, not just the pushed copy. `split` on
      // "4419274-21 | 4419274-21" leaves "4419274-21 " with a trailing
      // space, and a later strip_suffix("-21") then fails its endsWith
      // test — silently skipping the rule that matters.
      cur = cur.trim();
      push(cur);
    } catch {
      // A malformed rule must never take down ingest — skip it and keep the
      // candidates gathered so far.
    }
  }

  inRules = false;
  // Generic fallbacks, safe for every vendor because candidates only ever
  // ADD: a useless one simply matches nothing, and one that collides with a
  // real invoice produces `ambiguous` (a review item) rather than a wrong
  // allocation. See resolveLines.
  const digits = cur.replace(/\D/g, "");
  if (digits.length >= 4) {
    push(digits);
    push(digits.replace(/^0+(?=\d)/, ""));
  }

  // Compound references are common: payers routinely concatenate their own
  // identifier with ours, e.g. "A-92641B-13541" where 13541 is our invoice
  // number. Offer each delimited segment, and the numeric run at either end.
  for (const seg of cur.split(/[-_/|\s]+/)) {
    const t = seg.trim();
    if (t.length >= 3) {
      push(t);
      const d = t.replace(/\D/g, "");
      if (d.length >= 3) push(d);
    }
  }
  const tail = /(\d{3,})\s*$/.exec(cur);
  if (tail) push(tail[1]);
  const head = /^\s*(\d{3,})/.exec(cur);
  if (head) push(head[1]);

  return out;
}

/** Values only — the common case and what tests read. */
export function referenceCandidates(raw: string | null, rules: RefRule[] = []): string[] {
  return referenceCandidatesDetailed(raw, rules).map((c) => c.value);
}

// ── Resolution ────────────────────────────────────────────────────────

/** Which identifier namespace produced the match. Ordered by how much we
 *  trust it — see NAMESPACE_SCORE. */
export type MatchedBy =
  | "invoice_number"
  | "load_num"
  | "internal_load_id"
  /** A broker-side identifier recorded on the load — PO #, Order #, PRO #,
   *  BOL, Cust Ref. 66% of loads carry at least one. */
  | "ref_num"
  | "processor_ref"
  /** Last resort: exactly ONE open invoice for this customer has this exact
   *  balance. Never auto-applied — see NAMESPACE_SCORE. */
  | "amount"
  /** Inferred from the batch: the other lines on this document all settle
   *  invoices billed on one date, and exactly one unclaimed invoice from
   *  that same date matches this line's amount. A proposal, not a match. */
  | "cohort"
  | "ambiguous"
  | "none";

export interface ResolvedLine {
  line:        RemittanceLine;
  invoiceId:   string | null;
  matchedBy:   MatchedBy;
  confidence:  number;
  /** Every form we looked up. Shown in the review queue so a human can see
   *  what was tried rather than just "no match". */
  candidates:  string[];
  /** Populated when more than one invoice matched, so the reviewer can pick. */
  ambiguous?:  string[];
  note?:       string;
}

/**
 * Base scores leave headroom for the +5 exact-amount bonus, so a literal hit
 * that also pays the invoice exactly is the only thing reaching 100. Setting
 * a base to 100 would clamp an exact payment and a short-pay to the same
 * score and erase the distinction the bonus exists to make.
 *
 * The three direct namespaces score EQUALLY on purpose. `internal_load_id`
 * (and the `invoice_number` derived from it) is our number; `load_num` is
 * the customer's own. Which one shows up on a remittance is a fact about
 * that customer's back office, not a statement about reliability — ITS
 * prints its 7-digit `load_num` (4780754, 4378081), RTS prints our 5-digit
 * invoice number (13129). Ranking them would systematically distrust every
 * customer who happens to use their own numbering.
 */
const NAMESPACE_SCORE: Record<Exclude<MatchedBy, "ambiguous" | "none">, number> = {
  invoice_number:   95,
  load_num:         95,
  internal_load_id: 95,
  // Slightly under the canonical three. A broker's PO or Order number is a
  // real identifier, but it is THEIR field: one PO legitimately covers
  // several loads, so it collides more often. When it does, the
  // union-then-require-unique rule turns it into a review item, and this
  // score keeps a lone hit reviewable unless the amount agrees too.
  ref_num:          92,
  processor_ref:    65,
  // Deliberately below AUTO_APPLY_THRESHOLD. An amount match is a strong
  // SUGGESTION for a human, never an instruction to move money — the whole
  // reason amount-matching is fenced off is that it produces confident
  // wrong answers, and a wrong allocation is worse than an unapplied one
  // because nobody goes looking for it.
  amount:           70,
  // Two weak signals agreeing (same billing batch + exact balance) is
  // stronger than either alone, and still not a reference. Below
  // AUTO_APPLY_THRESHOLD on purpose: it hands the operator an answer to
  // confirm rather than moving money on an inference.
  cohort:           80,
};

/** At or above this, a line may be applied without human review. Set so
 *  that only a direct identifier hit qualifies — a rule-derived or
 *  processor-bridged match always gets looked at. */
export const AUTO_APPLY_THRESHOLD = 90;

interface InvoiceRow {
  id:             string;
  /** Numeric in the DB; PostgREST returns it as a number. */
  invoice_number: string | number | null;
  total:          number | null;
  status:         string | null;
  customer_id:    string | null;
  load_id:        string | null;
}

/**
 * Confidence for a line that already has a namespace hit.
 *
 * Note what this function does NOT do: it never converts an amount into a
 * match. By the time it runs, the invoice was already identified by
 * reference. Amount agreement only raises or lowers trust in that
 * identification. This is design rule 3, expressed as a type signature —
 * there is no path from `amount` to `invoiceId`.
 */
export function scoreLine(
  line:      RemittanceLine,
  matchedBy: Exclude<MatchedBy, "ambiguous" | "none">,
  invoice:   InvoiceRow,
  viaRule:   boolean,
): number {
  let score = NAMESPACE_SCORE[matchedBy];

  // Derived via a normalization rule rather than a literal hit. Penalised
  // enough that even a perfect rule-derived match lands below
  // AUTO_APPLY_THRESHOLD — a new or edited rule always gets eyes on it
  // before it starts moving money on its own.
  if (viaRule) score -= 15;

  const total = Number(invoice.total ?? 0);
  const paid  = Number(line.amount ?? 0);

  if (total > 0) {
    const diff = Math.abs(total - paid);
    if (diff <= CENT) {
      score += 5;                       // pays the invoice exactly
    } else if (paid < total) {
      // A short-pay is normal (quick-pay discount, deduction) and must NOT
      // be treated as a mismatch — the allocation is still correct, the
      // invoice simply keeps a balance. Only flag an implausible gap.
      const shortPct = diff / total;
      if (shortPct > 0.25) score -= 25;
    } else {
      // Overpayment against a single invoice is genuinely suspicious: it
      // usually means the reference points at the wrong invoice.
      score -= 30;
    }
  }

  return Math.max(0, Math.min(100, score));
}

export interface ResolveOptions {
  /** Narrow every lookup to one customer. Strongly preferred: the
   *  predecessor system collided five ID namespaces in a single global
   *  column. Within one customer, cross-namespace collisions are rare. */
  customerId?: string | null;
  /** Per-customer normalization rules from customer_payment_profiles. */
  rules?:      RefRule[];
}

/**
 * Resolve every line of a document to an invoice.
 *
 * Batches all lookups: three queries total regardless of line count, so a
 * 40-line remittance costs the same as a 1-line one.
 */
export async function resolveLines(
  orgId: string,
  doc:   RemittanceDoc,
  opts:  ResolveOptions = {},
): Promise<ResolvedLine[]> {
  const rules = opts.rules ?? [];

  // 1. Candidate forms for every line, and the flat set to look up.
  const perLine = doc.lines.map((line) => {
    const detailed = referenceCandidatesDetailed(line.referenceAsPrinted, rules);
    return { line, detailed, candidates: detailed.map((c) => c.value) };
  });
  const allCandidates = [...new Set(perLine.flatMap((p) => p.candidates))];

  if (!allCandidates.length) {
    return perLine.map(({ line, candidates }) => ({
      line, candidates, invoiceId: null, matchedBy: "none" as const, confidence: 0,
      note: "no reference printed on this line",
    }));
  }

  // 2. Namespace lookups, batched.
  const byInvoiceNumber = new Map<string, InvoiceRow[]>();
  const byLoadNum       = new Map<string, InvoiceRow[]>();
  const byInternalId    = new Map<string, InvoiceRow[]>();
  const byRefNum        = new Map<string, InvoiceRow[]>();

  // Coerce with String(): invoice_number and internal_load_id come back as
  // NUMBERS from PostgREST, not strings, so a bare .trim() throws. Candidates
  // are always strings (they came off a printed document), so both sides have
  // to be normalised to string before they can be compared at all.
  const index = (m: Map<string, InvoiceRow[]>, k: string | number | null, row: InvoiceRow) => {
    const key = String(k ?? "").trim();
    if (!key) return;
    const list = m.get(key) ?? [];
    list.push(row);
    m.set(key, list);
  };

  const invCols = "id,invoice_number,total,status,customer_id,load_id";

  let invQ = supabase
    .from("invoices")
    .select(invCols)
    .eq("org_id", orgId)
    .in("invoice_number", allCandidates);
  if (opts.customerId) invQ = invQ.eq("customer_id", opts.customerId);
  const { data: byNumber } = await invQ;
  for (const row of (byNumber ?? []) as InvoiceRow[]) {
    index(byInvoiceNumber, row.invoice_number, row);
  }

  // Loads carry two more namespaces. Queried SEPARATELY, and never through
  // a hand-built .or() string.
  //
  // The columns have different types and that difference is load-bearing:
  // `load_num` is text and accepts anything, but `internal_load_id` is an
  // INTEGER. Passing a printed reference like "4752138-21 | 4752138-21" to
  // it makes Postgres reject the whole statement (22P02), and the digits
  // fallback can overflow it besides (22003). Because both columns shared
  // one .or(), a single unparseable candidate killed BOTH namespaces for
  // the entire document — silently, since only `data` was destructured.
  // That is why references whose load was sitting right there resolved to
  // nothing.
  const numericCandidates = allCandidates.filter((c) => /^\d{1,9}$/.test(c));

  const loadRowsById = new Map<string, {
    id: string; load_num: string | number | null; internal_load_id: string | number | null;
  }>();

  const collectLoads = async (label: string, build: () => any) => {
    const { data, error } = await build();
    if (error) {
      // Loudly: a failure here silently disables a whole namespace.
      console.error(`[remittanceMatcher] load lookup by ${label} failed:`, error);
      return;
    }
    for (const row of (data ?? []) as Array<{ id: string }>) {
      loadRowsById.set(row.id, row as never);
    }
  };

  await collectLoads("load_num", () =>
    supabase
      .from("loads")
      .select("id,load_num,internal_load_id")
      .eq("org_id", orgId)
      .in("load_num", allCandidates),
  );
  if (numericCandidates.length) {
    await collectLoads("internal_load_id", () =>
      supabase
        .from("loads")
        .select("id,load_num,internal_load_id")
        .eq("org_id", orgId)
        .in("internal_load_id", numericCandidates),
    );
  }

  // ── ref_nums ────────────────────────────────────────────────────────
  //
  // Loads carry broker-side identifiers in `ref_nums` — a TEXT column
  // holding JSON like [{"label":"PRO #","value":"4752138"}]. Two thirds of
  // loads have one, and they hold 5,016 values that differ from load_num.
  // A remittance headed "PRO #" or "PO #" is quoting exactly this, so
  // ignoring the column threw away a whole namespace.
  //
  // Queried LOOSELY then verified EXACTLY: ilike finds rows whose JSON text
  // contains the candidate anywhere (including inside a longer number or a
  // label), and the parse below keeps only true value-equality. Getting
  // extra rows back is cheap; accepting a substring hit as a match is not.
  //
  // Only candidates made of safe characters are used, so nothing can break
  // the .or() the way an unescaped reference broke the load lookup.
  const SAFE = /^[A-Za-z0-9._-]{3,}$/;
  const refCandidates = allCandidates.filter((c) => SAFE.test(c));
  const refValueToLoadIds = new Map<string, Set<string>>();

  for (let i = 0; i < refCandidates.length; i += 20) {
    const chunk = refCandidates.slice(i, i + 20);
    const { data, error } = await supabase
      .from("loads")
      .select("id,load_num,internal_load_id,ref_nums")
      .eq("org_id", orgId)
      .or(chunk.map((c) => `ref_nums.ilike.*${c}*`).join(","));
    if (error) {
      console.error("[remittanceMatcher] ref_nums lookup failed:", error);
      continue;
    }
    for (const row of (data ?? []) as Array<{
      id: string; load_num: string | number | null;
      internal_load_id: string | number | null; ref_nums: string | null;
    }>) {
      let parsed: unknown;
      try {
        parsed = typeof row.ref_nums === "string" ? JSON.parse(row.ref_nums) : row.ref_nums;
      } catch { continue; }
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed) {
        const value = String((entry as { value?: unknown })?.value ?? "").trim();
        if (!value) continue;
        const set = refValueToLoadIds.get(value) ?? new Set<string>();
        set.add(row.id);
        refValueToLoadIds.set(value, set);
        loadRowsById.set(row.id, row as never);
      }
    }
  }

  const loads = [...loadRowsById.values()];

  if (loads.length) {
    let loadInvQ = supabase
      .from("invoices")
      .select(invCols)
      .eq("org_id", orgId)
      .in("load_id", loads.map((l) => l.id));
    if (opts.customerId) loadInvQ = loadInvQ.eq("customer_id", opts.customerId);
    const { data: loadInvoices } = await loadInvQ;

    const invByLoad = new Map<string, InvoiceRow[]>();
    for (const row of (loadInvoices ?? []) as InvoiceRow[]) {
      const list = invByLoad.get(row.load_id ?? "") ?? [];
      list.push(row);
      invByLoad.set(row.load_id ?? "", list);
    }
    for (const l of loads) {
      for (const inv of invByLoad.get(l.id) ?? []) {
        index(byLoadNum,    l.load_num,         inv);
        index(byInternalId, l.internal_load_id, inv);
      }
    }
    // Every verified ref value points at whatever invoices its load has.
    for (const [value, loadIdSet] of refValueToLoadIds) {
      for (const loadId of loadIdSet) {
        for (const inv of invByLoad.get(loadId) ?? []) index(byRefNum, value, inv);
      }
    }
  }

  // 2b. Amount fallback, customer-scoped only.
  //
  //     Some payers bill amounts that are effectively unique per load, so
  //     when a reference is unusable — truncated on the document, or an
  //     identifier we never recorded — the balance still identifies the
  //     invoice. This is safe ONLY under two conditions, both enforced
  //     here: the search is confined to one customer, and exactly one of
  //     their open invoices carries that exact balance. A second invoice
  //     at the same amount makes it ambiguous, and ambiguous is a review
  //     item, never a guess.
  //
  //     Org-wide amount matching is deliberately not offered. Across 135
  //     customers, round figures like 650.00 collide constantly.
  let byAmount: Map<string, InvoiceRow[]> | null = null;
  if (opts.customerId) {
    const { data: openRows } = await supabase
      .from("invoices")
      .select(invCols + ",paid_amount")
      .eq("org_id", orgId)
      .eq("customer_id", opts.customerId)
      .neq("status", "paid")
      .neq("status", "void");
    byAmount = new Map();
    for (const row of (openRows ?? []) as Array<InvoiceRow & { paid_amount?: number }>) {
      const bal = round2(Number(row.total ?? 0) - Number(row.paid_amount ?? 0));
      if (bal <= 0) continue;
      const key = bal.toFixed(2);
      const list = byAmount.get(key) ?? [];
      list.push(row);
      byAmount.set(key, list);
    }
  }

  // 3. UNION the hits from every namespace, then require exactly one distinct
  //    invoice.
  //
  //    Not a priority ladder. Because the namespaces are equally valid, a
  //    first-one-wins walk would let a `load_num` hit mask a DIFFERENT invoice
  //    reachable via `internal_load_id`, silently returning high confidence
  //    for the wrong invoice. That collision is real in this data, not
  //    hypothetical: 2 values currently live in both namespaces, and 7
  //    `load_num` values appear on more than one live load (customers reuse
  //    their own numbering; our `internal_load_id` is unique by construction).
  //
  //    Unioning turns every one of those cases into `ambiguous` — a review
  //    item instead of a wrong allocation.
  // Two TIERS, and the distinction matters.
  //
  // Tier 1 is our own record of the load: invoice_number, load_num and
  // internal_load_id are three views of one thing we control, so they carry
  // equal weight and are unioned together.
  //
  // Tier 2 is `ref_num` — the BROKER's field, populated from rate cons by a
  // parser, and demonstrably prone to error: in Curzon prod load 4743612
  // carries "PRO # 4743608", which is load 4743608's number. Unioned with
  // tier 1 that single bad row turned a perfect load_num match into an
  // ambiguity and cost a line that had every right to resolve.
  //
  // So tier 2 is consulted only when tier 1 finds nothing. That still covers
  // the case this namespace exists for — a payer quoting their own PO, or a
  // parser having filed our load number under ref_nums — while stopping one
  // mistyped reference from outvoting the canonical record.
  const TIER1: Array<[Exclude<MatchedBy, "ambiguous" | "none">, Map<string, InvoiceRow[]>]> = [
    ["invoice_number",   byInvoiceNumber],
    ["load_num",         byLoadNum],
    ["internal_load_id", byInternalId],
  ];
  const TIER2: Array<[Exclude<MatchedBy, "ambiguous" | "none">, Map<string, InvoiceRow[]>]> = [
    ["ref_num",          byRefNum],
  ];

  return perLine.map(({ line, detailed, candidates }): ResolvedLine => {
    type Hit = {
      row: InvoiceRow; via: Set<Exclude<MatchedBy, "ambiguous" | "none">>; minIdx: number;
    };
    const gather = (
      tier: Array<[Exclude<MatchedBy, "ambiguous" | "none">, Map<string, InvoiceRow[]>]>,
    ) => {
      const found = new Map<string, Hit>();
      for (const [ns, map] of tier) {
        for (const [i, cand] of candidates.entries()) {
          for (const row of map.get(cand) ?? []) {
            const cur = found.get(row.id);
            if (cur) {
              cur.via.add(ns);
              cur.minIdx = Math.min(cur.minIdx, i);
            } else {
              found.set(row.id, { row, via: new Set([ns]), minIdx: i });
            }
          }
        }
      }
      return found;
    };

    const tier1 = gather(TIER1);
    const hits  = tier1.size ? tier1 : gather(TIER2);

    if (hits.size === 1) {
      const hit = [...hits.values()][0]!;
      // Only a CUSTOMER-CONFIGURED rule counts as "derived". The built-in
      // segment/digit fallbacks run identically on every document and are
      // covered by tests, so penalising them would permanently hold back
      // every payer whose reference simply isn't a bare number — which is
      // most of them.
      const viaRule = detailed[hit.minIdx]?.fromRule ?? false;
      // Namespaces score equally, so this is a label for the reviewer, not a
      // ranking. Report the most human-recognisable one that hit.
      const matchedBy =
        (["invoice_number", "load_num", "internal_load_id", "ref_num"] as const)
          .find((n) => hit.via.has(n))!;
      return {
        line, candidates, invoiceId: hit.row.id, matchedBy,
        confidence: scoreLine(line, matchedBy, hit.row, viaRule),
        note: viaRule
          ? `matched via a normalization rule (${[...hit.via].join(", ")})`
          : hit.via.size > 1
            ? `matched in ${[...hit.via].join(" + ")}`
            : undefined,
      };
    }

    if (hits.size > 1) {
      return {
        line, candidates, invoiceId: null, matchedBy: "ambiguous", confidence: 0,
        ambiguous: [...hits.keys()],
        note: `${hits.size} distinct invoices matched — needs a human`,
      };
    }

    // Nothing resolved by reference. Try the balance, if we are scoped to a
    // customer and it picks out exactly one invoice.
    const amountHits = byAmount?.get(round2(line.amount).toFixed(2)) ?? [];
    if (amountHits.length === 1) {
      const inv = amountHits[0]!;
      return {
        line, candidates, invoiceId: inv.id, matchedBy: "amount",
        confidence: scoreLine(line, "amount", inv, false),
        note: "no usable reference — matched on the only open invoice for " +
              "this customer with this exact balance",
      };
    }
    if (amountHits.length > 1) {
      return {
        line, candidates, invoiceId: null, matchedBy: "ambiguous", confidence: 0,
        ambiguous: amountHits.map((i) => i.id),
        note: `${amountHits.length} open invoices share this amount — needs a human`,
      };
    }

    return {
      line, candidates, invoiceId: null, matchedBy: "none", confidence: 0,
      note: candidates.length
        ? "no invoice matched any candidate form"
        : "no reference printed on this line — the document may not carry a " +
          "carrier-side identifier at all",
    };
  });
}

// ── Roll-up ───────────────────────────────────────────────────────────

export interface RemittanceOutcome {
  totals:      TotalsCheck;
  resolved:    ResolvedLine[];
  autoApply:   ResolvedLine[];
  needsReview: ResolvedLine[];
  /** True only when the document reconciles AND every line resolved
   *  confidently. Anything less is a review-queue item, not a failure. */
  clean:       boolean;
}

export async function matchRemittance(
  orgId: string,
  doc:   RemittanceDoc,
  opts:  ResolveOptions = {},
): Promise<RemittanceOutcome> {
  const totals = checkTotals(doc);

  // A document that doesn't reconcile is never partially applied — that is
  // precisely how the predecessor lost rows silently.
  if (!totals.ok) {
    const resolved = doc.lines.map((line, i): ResolvedLine => ({
      line, candidates: [], invoiceId: null, matchedBy: "none", confidence: 0,
      note: `document failed totals check (${totals.reason}); line ${i} not resolved`,
    }));
    return { totals, resolved, autoApply: [], needsReview: resolved, clean: false };
  }

  const resolved    = await resolveLines(orgId, doc, opts);
  const autoApply   = resolved.filter((r) => r.invoiceId && r.confidence >= AUTO_APPLY_THRESHOLD);
  const needsReview = resolved.filter((r) => !r.invoiceId || r.confidence < AUTO_APPLY_THRESHOLD);

  return { totals, resolved, autoApply, needsReview, clean: needsReview.length === 0 };
}
