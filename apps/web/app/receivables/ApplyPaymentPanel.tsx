'use client';

/**
 * ApplyPaymentPanel — upload what the payer sent, confirm what it pays.
 *
 * The inverse of BulkPaymentPanel. There you pick invoices first and then
 * describe the payment; here the DOCUMENT leads: drop in a remittance and
 * it works out who paid, how much, and which open invoices it settles.
 * That is the order payments actually arrive in.
 *
 * Two rules this screen exists to enforce:
 *
 *  • Nothing is written until you confirm. The parse endpoint only reads.
 *    The Apply button then walks the ordinary proof + allocation
 *    endpoints — the same path Mark Paid uses — so there is one code path
 *    that moves money, not two.
 *
 *  • A document whose rows don't add up to its own printed total is
 *    BLOCKED, not warned about. That mismatch means a row was misread or
 *    missed, and applying the rows that did parse is the failure mode
 *    nobody catches later: the allocations that land look perfect and the
 *    invoice for the missing row just stays open.
 *
 * Several files can be dropped at once, and they form a QUEUE rather than a
 * batch: each is still parsed, shown against its source, and confirmed one
 * at a time. Backlogs arrive by the month — a broker who pays daily leaves
 * forty documents to file — and the cost of that is opening the panel forty
 * times, not the confirming. Batch-applying them unreviewed would trade the
 * one safeguard this screen exists for against the wrong kind of speed.
 *
 * Visual language is deliberately the Receivables ledger's own, at close
 * range: the same aging tints, the same tabular figures, the same chip
 * vocabulary. A payment screen that invented its own look would make the
 * operator re-learn what red means at the exact moment they are confirming
 * money movement.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Check, AlertTriangle, Loader2, FileText, HelpCircle, ExternalLink,
  UploadCloud, Building2, Truck, CircleAlert, Copy, Paperclip, Search, CalendarClock,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { railway } from '@/lib/railway';
import type {
  ParsePaymentResponse, ParsedPaymentLine, InvoiceSearchResult,
} from '@fleetcal/types';

// ── shared vocabulary with the ledger ─────────────────────────────────
// Same tints the bucket tiles and invoice rows use, so "amber" and "red"
// keep meaning exactly what they mean on the page behind this modal.
const GREEN = '#188038', GREEN_BG = '#e6f4ea';
const AMBER = '#b06000', AMBER_BG = '#fef7e0';
const RED   = '#c5221f', RED_BG   = '#fce8e6';
const BLUE  = '#1a73e8', BLUE_BG  = '#e8f0fe';

const money2 = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const money0 = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** Matches the ledger's Age column: not-yet-due is quiet, 1–30 amber, 31+ red. */
const ageColor = (d: number | null | undefined) =>
  d === null || d === undefined || d <= 0 ? 'var(--gc-text-3)' : d <= 30 ? AMBER : RED;

/**
 * Pull the server's own words out of a failed request.
 *
 * RailwayError carries the parsed body on `detail`, but Error.message is
 * just "POST /v1/payments/proofs → 400" — which tells the operator that
 * something failed and nothing about what. The API already returns a
 * `errors: string[]` explaining itself; this surfaces it.
 */
function errText(e: unknown, fallback: string): string {
  const detail = (e as { detail?: unknown })?.detail as
    { errors?: unknown; error?: unknown; detail?: unknown } | undefined;
  if (Array.isArray(detail?.errors) && detail.errors.length) {
    return detail.errors.map(String).join('; ');
  }
  if (detail?.detail) return String(detail.detail);
  if (detail?.error)  return String(detail.error);
  return e instanceof Error ? e.message : fallback;
}

const shortDate = (iso: string | null | undefined) => {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? null
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export interface ApplyPaymentPanelProps {
  customers: { id: string; name: string }[];
  /** Pre-selects the customer, and scopes the very first parse to them.
   *  Set when opening from inside a customer profile — narrowing the
   *  search there resolves references that are ambiguous org-wide. */
  initialCustomerId?: string | null;
  onClose:   () => void;
  /** Called after allocations land so the ledger can refetch. */
  onSaved:   () => void;
}

/** Browser File → base64 without the data: prefix. Chunked because
 *  String.fromCharCode blows the stack on a large spread. */
async function toBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 8192) {
    bin += String.fromCharCode(...buf.subarray(i, i + 8192));
  }
  return btoa(bin);
}

/** Minimal RFC4180 reader — quoted fields, escaped quotes, embedded commas
 *  and newlines. Enough to render a remittance CSV faithfully; this is for
 *  DISPLAY only, so the operator can see the source. Nothing downstream
 *  depends on it. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"')       { quoted = true; }
    else if (ch === ',')  { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') { cell += ch; }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

/** What became of one queued document. Pending is the ABSENCE of a result,
 *  not a value — so "have I dealt with this yet" is one lookup, not two. */
type QueueState = 'applied' | 'attached' | 'skipped' | 'failed';
type QueueResult = { state: QueueState; note?: string };

/** Uber names its remittances `CURZON TRUCKING LLC_2026-08-06_remittance.pdf`;
 *  factoring portals are no shorter. The date is the only part that tells one
 *  from another at a glance, so it is what the queue chip shows. */
function chipLabel(name: string): string {
  const iso = name.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${Number(iso[2])}/${Number(iso[3])}`;
  const stem = name.replace(/\.[^.]+$/, '');
  return stem.length > 12 ? `${stem.slice(0, 11)}…` : stem;
}

export default function ApplyPaymentPanel({
  customers, initialCustomerId, onClose, onSaved,
}: ApplyPaymentPanelProps) {
  /** The documents to work through, in the order they were dropped, and
   *  which one is on screen. A single file is just a queue of one. */
  const [queue,   setQueue]   = useState<File[]>([]);
  const [qIndex,  setQIndex]  = useState(0);
  const [results, setResults] = useState<Record<number, QueueResult>>({});
  const file = queue[qIndex] ?? null;

  const [parsed,  setParsed]  = useState<ParsePaymentResponse | null>(null);
  const [customerId, setCustomerId] = useState<string>(initialCustomerId ?? '');
  /** True once a human picked the customer, or the panel was opened from a
   *  customer's page. An inferred customer must NOT carry to the next
   *  document — a mixed drop would then be read against the wrong payer,
   *  and scoping the search that way turns wrong into confident. */
  const [customerLocked, setCustomerLocked] = useState(!!initialCustomerId);
  const [skip,    setSkip]    = useState<Set<number>>(new Set());
  const [busy,    setBusy]    = useState(false);
  const [phase,   setPhase]   = useState<'idle' | 'reading' | 'applying'>('idle');
  const [err,     setErr]     = useState<string | null>(null);
  const [done,    setDone]    = useState(0);
  const [dragOver, setDragOver] = useState(false);
  /** Filled in by hand when the document prints no payment date. */
  const [dateOverride, setDateOverride] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  /** Invoices chosen by hand for lines the resolver couldn't place, keyed
   *  by row. A truncated reference or an identifier we never recorded is
   *  unrecoverable by rule — but the operator still knows which load it is. */
  const [picked, setPicked] = useState<Record<number, InvoiceSearchResult>>({});
  const [searchFor, setSearchFor] = useState<number | null>(null);

  /** Links a row in the source document to its extracted line, both ways. */
  const [hoverRow, setHoverRow] = useState<number | null>(null);

  // The source document is shown beside the extraction because confirming
  // what the system read is meaningless without seeing what it read FROM —
  // otherwise "review" is just assent.
  //
  // Derived, not stored: setting state synchronously inside an effect causes
  // the cascading re-render React 19 warns about. The URL is computed from
  // the file, and the effect exists only to revoke it.
  const isExcel = !!file && /\.(xlsx|xlsm|xls)$/i.test(file.name);
  const isPdf   = !!file && (/\.pdf$/i.test(file.name) || file.type === 'application/pdf');
  const isImage = !!file && (/\.(png|jpe?g|gif|webp)$/i.test(file.name) || file.type.startsWith('image/'));
  const isPage  = isPdf || isImage;          // rendered documents need room
  const docUrl = useMemo(
    () => (file && isPage ? URL.createObjectURL(file) : null),
    [file, isPage],
  );

  /** Excel is a zip — neither the model nor the CSV reader can take it
   *  directly. Converted to CSV in the browser and sent down the existing
   *  text path, so there is still ONE extraction route. The original file
   *  is what gets attached as the proof; this is only what gets read. */
  const [sheetCsv, setSheetCsv] = useState<{ file: File; csv: string; sheets: string[] } | null>(null);
  const excelCsv = sheetCsv && sheetCsv.file === file ? sheetCsv.csv : null;
  useEffect(() => {
    if (!docUrl) return;
    return () => URL.revokeObjectURL(docUrl);
  }, [docUrl]);

  // Text has to be read asynchronously, so it must be state — but it is
  // stored WITH the file it came from, so a slow read for a replaced file
  // can never paint under the new one.
  const [textFor, setTextFor] = useState<{ file: File; text: string } | null>(null);
  useEffect(() => {
    if (!file || docUrl || isExcel) return;   // those render another way
    let alive = true;
    void file.text().then(t => { if (alive) setTextFor({ file, text: t }); });
    return () => { alive = false; };
  }, [file, docUrl, isExcel]);
  const docText = textFor && textFor.file === file ? textFor.text : null;

  // Esc closes, except mid-write — losing the modal while allocations are
  // being posted would hide which ones landed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const run = useCallback(async (
    f: File, forCustomer: string | null, asCsv?: string,
  ) => {
    setBusy(true); setPhase('reading'); setErr(null);
    try {
      // For a converted spreadsheet, send the CSV text under a .csv name so
      // the server takes its ordinary text path; the xlsx itself is still
      // what gets stored as the proof.
      const res = await railway.parsePaymentDocument({
        filename:   asCsv ? f.name.replace(/\.(xlsx|xlsm|xls)$/i, '.csv') : f.name,
        mimeType:   asCsv ? 'text/csv' : (f.type || 'application/octet-stream'),
        dataBase64: asCsv
          ? btoa(unescape(encodeURIComponent(asCsv)))
          : await toBase64(f),
        ...(forCustomer ? { customerId: forCustomer } : {}),
      });
      setParsed(res);
      // Prefer the customer the matched invoices point at over the printed
      // payer name — remittances are routinely sent by a factoring company
      // or under a legal entity we hold under a different name.
      if (!forCustomer && res.inferredCustomerId) setCustomerId(res.inferredCustomerId);
      // Default to applying everything that matched — EXCEPT anything the
      // books already account for. Two separate signals, and the second one
      // is the load-bearing one:
      //
      //   alreadyPaid      the invoice is settled
      //   alreadyOnInvoice this exact amount is already allocated to it
      //
      // Unticking only on status was the bug that double-credited 32
      // invoices: a quick-pay shortfall leaves an invoice `sent` forever,
      // so a re-uploaded remittance looked entirely fresh even though every
      // dollar of it was already recorded.
      setPicked({}); setSearchFor(null);
      setDateOverride(res.dateMissing ? new Date().toISOString().slice(0, 10) : '');
      setSkip(new Set(
        res.lines
          .filter(l => !l.invoiceId || l.alreadyPaid || l.alreadyOnInvoice)
          .map(l => l.rowIndex),
      ));
    } catch (e) {
      setErr(errText(e, 'Could not read that document'));
      setParsed(null);
    } finally {
      setBusy(false); setPhase('idle');
    }
  }, []);

  /** Put one document on screen. Excel is converted to CSV first so there
   *  is still a single extraction route behind this. */
  const openDoc = useCallback(async (f: File, forCustomer: string | null) => {
    // Every per-document decision resets. `run` clears most of these on a
    // successful parse, but a parse that throws would otherwise leave the
    // previous document's hand-picked invoices sitting under the new one.
    setParsed(null); setErr(null);
    setPicked({}); setSearchFor(null); setSkip(new Set()); setHoverRow(null);
    setDateOverride('');
    if (/\.(xlsx|xlsm|xls)$/i.test(f.name)) {
      try {
        const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
        // First sheet that actually has rows — workbooks routinely lead
        // with an empty cover or instructions tab.
        const name = wb.SheetNames.find(n => {
          const ref = wb.Sheets[n]?.['!ref'];
          return !!ref && ref !== 'A1:A1';
        }) ?? wb.SheetNames[0];
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
        setSheetCsv({ file: f, csv, sheets: wb.SheetNames });
        await run(f, forCustomer, csv);
      } catch {
        setErr("Couldn't read that spreadsheet — try exporting the sheet as CSV.");
      }
      return;
    }
    setSheetCsv(null);
    await run(f, forCustomer);
  }, [run]);

  /** The customer to read the NEXT document against. Only a deliberate
   *  choice carries forward; an inference belongs to the document it came
   *  from. See `customerLocked`. */
  const carryCustomer = useCallback(
    () => (customerLocked ? (customerId || null) : null),
    [customerLocked, customerId],
  );

  /** Start over with a new set of files. Dropping again replaces the queue
   *  rather than appending, which is what "Replace" has always meant here. */
  const accept = useCallback(async (files: FileList | File[] | null) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    setQueue(list); setQIndex(0); setResults({});
    if (!customerLocked) setCustomerId('');
    await openDoc(list[0], carryCustomer());
  }, [openDoc, carryCustomer, customerLocked]);

  const goTo = useCallback(async (i: number) => {
    if (i < 0 || i >= queue.length || busy) return;
    setQIndex(i);
    if (!customerLocked) setCustomerId('');
    await openDoc(queue[i], carryCustomer());
  }, [queue, busy, openDoc, carryCustomer, customerLocked]);

  /** Record what happened to the document on screen and move to the next one
   *  that hasn't been dealt with. A one-file queue keeps the old behaviour of
   *  closing outright — there is nothing to move on to. */
  const settle = useCallback(async (state: QueueState, note?: string) => {
    const next: Record<number, QueueResult> = { ...results, [qIndex]: { state, note } };
    setResults(next);
    if (queue.length <= 1) { onClose(); return; }
    // Forward first, then wrap — so skipping something to come back to it
    // later actually brings you back to it.
    let target = queue.findIndex((_, i) => i > qIndex && !next[i]);
    if (target < 0) target = queue.findIndex((_, i) => !next[i]);
    if (target < 0) return;                  // nothing left; the summary shows
    setQIndex(target);
    if (!customerLocked) setCustomerId('');
    await openDoc(queue[target], carryCustomer());
  }, [results, qIndex, queue, onClose, openDoc, carryCustomer, customerLocked]);

  const remaining = queue.filter((_, i) => !results[i]).length;
  const allDone   = queue.length > 1 && remaining === 0;
  /** An unresolved error keeps its own document on screen even when nothing
   *  is left to move on to — swapping in a cheerful summary over the top of
   *  "4 of 9 could not be recorded" would bury the one thing worth reading. */
  const showSummary = allDone && !err;

  /** Running total of what this sitting actually put on the books, added to
   *  as each document lands rather than reconstructed from the results. */
  const [appliedTotal, setAppliedTotal] = useState(0);
  const tally = useMemo(() => {
    const t = { applied: 0, attached: 0, skipped: 0, failed: 0 };
    for (const r of Object.values(results)) t[r.state] += 1;
    return t;
  }, [results]);

  // Memoized: `parsed?.lines ?? []` allocates a fresh array every render,
  // which would invalidate every downstream useMemo on each pass.
  const rawLines = useMemo(() => parsed?.lines ?? [], [parsed]);
  const lines    = useMemo(() => rawLines.map((l): ParsedPaymentLine => {
    const p = picked[l.rowIndex];
    if (!p) return l;
    return {
      ...l,
      invoiceId:     p.invoiceId,
      invoiceNumber: p.invoiceNumber,
      invoiceTotal:  p.invoiceTotal,
      invoicePaid:   p.invoicePaid,
      invoiceStatus: p.invoiceStatus,
      alreadyPaid:   p.invoiceStatus === 'paid',
      loadNum:       p.loadNum,
      title:         p.title,
      pickupAt:      p.pickupAt,
      agingDays:     p.agingDays,
      matchedBy:     'manual',
      confidence:    100,
      ambiguous:     null,
      note:          'chosen by hand',
    };
  }), [rawLines, picked]);
  const included = useMemo(
    () => lines.filter(l => l.invoiceId && !skip.has(l.rowIndex)),
    [lines, skip],
  );
  /** Invoices touched, which is what actually gets written — several
   *  charge lines on one invoice collapse into a single allocation. */
  const invoiceCount = useMemo(
    () => new Set(included.map(l => l.invoiceId)).size,
    [included],
  );
  const includedTotal = useMemo(
    () => Math.round(included.reduce((s, l) => s + l.amount, 0) * 100) / 100,
    [included],
  );

  // Already-credited invoices that this document is evidence FOR. The money
  // is on the books; what's missing is the proof. Ticking such a row means
  // "credit it again anyway", so ticked rows drop out of this set.
  const attachable = useMemo(
    () => lines.filter(l =>
      l.invoiceId && (l.alreadyPaid || l.alreadyOnInvoice) && skip.has(l.rowIndex)),
    [lines, skip],
  );

  /** Lines whose money is demonstrably already on the invoice — a stronger
   *  statement than "the invoice is settled", and the one worth saying out
   *  loud, because it means re-applying would literally double the figure. */
  const repeats = useMemo(() => lines.filter(l => l.alreadyOnInvoice), [lines]);

  /**
   * Charges that DON'T fit the invoice they were grouped onto.
   *
   * Grouping several document lines into one allocation is right when they
   * are a breakdown of one load — Uber's Linehaul $580 + Lumper $95 on a
   * $675 invoice. It is catastrophic when two DIFFERENT loads resolve to the
   * same invoice, because the sum is then written as one payment: an RXO
   * document put $1,250 + $1,250 onto a $1,250 invoice and paid it twice.
   *
   * The two cases look identical except for one thing I failed to check —
   * a real breakdown FITS. If the group sums past what the invoice still
   * owes, it isn't a breakdown, and the right move is to refuse rather than
   * guess which line belongs.
   */
  const overfilled = useMemo(() => {
    const by = new Map<string, ParsedPaymentLine[]>();
    for (const l of included) {
      const list = by.get(l.invoiceId!) ?? [];
      list.push(l);
      by.set(l.invoiceId!, list);
    }
    return [...by.entries()]
      .filter(([, g]) => g.length > 1)
      .map(([invoiceId, g]) => {
        const sum = Math.round(g.reduce((s, x) => s + x.amount, 0) * 100) / 100;
        const owed = Math.round(((g[0].invoiceTotal ?? 0) - (g[0].invoicePaid ?? 0)) * 100) / 100;
        return { invoiceId, group: g, sum, owed, over: Math.round((sum - owed) * 100) / 100 };
      })
      .filter(x => x.owed > 0 && x.over > 0.005);
  }, [included]);
  /** …and the ones ticked back on anyway, which is a deliberate re-credit. */
  const repeatsTicked = useMemo(
    () => repeats.filter(l => !skip.has(l.rowIndex)).length,
    [repeats, skip],
  );

  const doc = parsed?.doc ?? null;
  /** The date that will land on the proof and every allocation. Either the
   *  document's own, or the one the operator supplied when it has none. */
  const effectiveDate = doc ? (doc.paymentDate || dateOverride) : '';

  /** Many settlements reported together rather than one payment — a
   *  factoring portal's paid-transactions export. The invoices it names
   *  were really paid, so it applies like anything else; what changes is
   *  that it is never recorded AS a transfer. */
  const isStatement = parsed?.documentKind === 'statement';

  const totalsFailed = parsed?.totals ? !parsed.totals.ok : false;
  const canApply  = !!parsed?.isRemittance && !totalsFailed && included.length > 0
                    && !!effectiveDate && !busy && overfilled.length === 0;
  // Attaching creates a proof too, so it needs the date just as much as
  // applying does. Without this it posted occurredOn: '' and the server
  // rejected it — correctly, and unhelpfully.
  const canAttach = !!parsed?.isRemittance && attachable.length > 0
                    && !!effectiveDate && !busy;
  const chosenCustomer = customers.find(c => c.id === customerId) ?? null;
  const inferred = !!parsed?.inferredCustomerId && parsed.inferredCustomerId === customerId;

  /** Create the proof and hang it on the allocations that already exist,
   *  without crediting anything a second time.
   *
   *  This is the common case for anything credited before the evidence
   *  arrived — the imported payment history, a manual Mark Paid, a bank
   *  line matched by hand. The money was never in question; the document
   *  proving it simply had nowhere to live until now. */
  async function handleAttach() {
    if (!parsed?.doc || !canAttach) return;
    setBusy(true); setPhase('applying'); setErr(null); setDone(0);
    try {
      const created = await railway.createPaymentProof({
        kind:       isStatement ? 'statement' : 'remittance',
        source:     'upload',
        occurredOn: effectiveDate,
        amount:     parsed.doc.paymentTotal,
        ...(parsed.doc.externalId ? { reference: parsed.doc.externalId } : {}),
        ...(parsed.doc.payerNameAsPrinted ? { payerRaw: parsed.doc.payerNameAsPrinted } : {}),
        ...(customerId ? { customerId } : {}),
      });
      if (file) await railway.uploadProofAttachment(created.proof.id, file);

      const failed: string[] = [];
      let linked = 0;
      for (const l of attachable) {
        try {
          const { payments } = await railway.listInvoicePayments(l.invoiceId!);
          // Only fill in allocations that have no evidence yet — never
          // overwrite a proof someone already attached.
          const bare = payments.filter(p => !p.proofId);
          if (!bare.length) continue;
          for (const p of bare) {
            await railway.updateInvoicePayment(l.invoiceId!, p.id, { proofId: created.proof.id });
            linked++;
          }
          setDone(d => d + 1);
        } catch (e) {
          failed.push(l.invoiceNumber ?? String(l.referenceAsPrinted));
          console.warn('[attach proof] failed for', l.invoiceNumber, e);
        }
      }

      onSaved();
      if (failed.length) {
        setErr(`${failed.length} of ${attachable.length} could not be linked: ${failed.join(', ')}`);
        setResults(r => ({ ...r, [qIndex]: { state: 'failed', note: `${failed.length} not linked` } }));
      } else if (linked === 0) {
        setErr('Those payments already have proof attached — nothing to link.');
        setResults(r => ({ ...r, [qIndex]: { state: 'failed', note: 'already had proof' } }));
      } else {
        await settle('attached', `proof on ${linked} allocation${linked === 1 ? '' : 's'}`);
      }
    } catch (e) {
      setErr(errText(e, 'Failed to attach the proof'));
    } finally {
      setBusy(false); setPhase('idle');
    }
  }

  async function handleApply() {
    if (!parsed?.doc || !canApply) return;
    setBusy(true); setPhase('applying'); setErr(null); setDone(0);
    try {
      const created = await railway.createPaymentProof({
        // A settlement report is evidence that these invoices were paid, but
        // it is not one transfer. Filing it as a remittance would assert a
        // $55,400 wire that nobody sent, and bank matching would hunt for
        // that deposit forever.
        kind:       isStatement ? 'statement' : 'remittance',
        source:     'upload',
        occurredOn: effectiveDate,
        // The proof records what the payer SENT, not what we managed to
        // apply. Any remainder stays visible as unapplied evidence rather
        // than disappearing.
        amount:     parsed.doc.paymentTotal,
        ...(parsed.doc.externalId ? { reference: parsed.doc.externalId } : {}),
        ...(parsed.doc.payerNameAsPrinted ? { payerRaw: parsed.doc.payerNameAsPrinted } : {}),
        ...(customerId ? { customerId } : {}),
      });
      if (file) await railway.uploadProofAttachment(created.proof.id, file);

      // ONE allocation per invoice, not per document line.
      //
      // invoice_payments carries a unique index on (invoice_id, proof_id) —
      // it exists so a double-click can't book the same proof twice against
      // the same invoice. That means several charge lines from one document
      // cannot each become their own allocation: the second Uber charge on
      // an invoice hits the constraint and 409s, which is what rejected
      // 13125, 13124 and 13046 twice.
      //
      // Summing per invoice is also the truer record. An allocation answers
      // "how much of this payment went to this invoice", and that is one
      // number; the Linehaul/Lumper/Detention split is a fact about the
      // document, which is attached to the proof and spelled out in the note.
      const byInvoice = new Map<string, ParsedPaymentLine[]>();
      for (const l of included) {
        const list = byInvoice.get(l.invoiceId!) ?? [];
        list.push(l);
        byInvoice.set(l.invoiceId!, list);
      }

      // Sequential: each write recomputes its invoice server-side, and one
      // failure must not abandon the rest.
      const failed: string[] = [];
      for (const [invoiceId, group] of byInvoice) {
        const amount = Math.round(group.reduce((sum, g) => sum + g.amount, 0) * 100) / 100;
        const parts  = group
          .map(g => `${g.deductionLabel ?? 'charge'} ${money2(g.amount)}`)
          .join(' + ');
        // A shortfall the customer's quick-pay agreement accounts for is
        // recorded as one, which is what CLOSES the invoice. Without the
        // reason it stays `sent` at 99% forever — and an invoice that never
        // closes never looks settled, which is how the same remittance got
        // applied to it twice.
        const qp = group.find(g => g.quickPay)?.quickPay ?? null;
        try {
          await railway.createInvoicePayment(invoiceId, {
            amount,
            paidOn:  effectiveDate,
            proofId: created.proof.id,
            ...(qp ? { varianceReason: 'quick_pay' as const } : {}),
            note: [
              `Remittance ${parsed.doc.externalId ?? ''}`.trim(),
              group.length > 1 ? `${group.length} charges: ${parts}` : '',
              qp ? `quick pay ${(qp.rate * 100).toFixed(2).replace(/\.?0+$/, '')}% — ${money2(qp.withheld)} withheld` : '',
            ].filter(Boolean).join(' · '),
          });
          setDone(d => d + 1);
        } catch (e) {
          failed.push(group[0].invoiceNumber ?? String(group[0].referenceAsPrinted));
          console.warn('[apply payment] failed for', group[0].invoiceNumber, e);
        }
      }

      onSaved();
      if (failed.length) {
        setErr(`${failed.length} of ${invoiceCount} could not be recorded: ${failed.join(', ')}`);
        setResults(r => ({ ...r, [qIndex]: { state: 'failed', note: `${failed.length} not recorded` } }));
      } else {
        setAppliedTotal(t => Math.round((t + includedTotal) * 100) / 100);
        await settle('applied', `${money2(includedTotal)} · ${invoiceCount} invoice${invoiceCount === 1 ? '' : 's'}`);
      }
    } catch (e) {
      setErr(errText(e, 'Failed to apply payment'));
    } finally {
      setBusy(false); setPhase('idle');
    }
  }

  return (
    // Centered modal, matching the review queue and load modal so the app's
    // focused work surfaces read as one system.
    <div className="fixed inset-0 flex items-center justify-center p-4"
         style={{ background: 'rgba(0,0,0,0.36)', zIndex: 60 }}
         onMouseDown={e => { if (!busy && e.target === e.currentTarget) onClose(); }}>
      <div className="flex flex-col overflow-hidden" style={{
        width:     !file || showSummary ? 'min(96vw, 560px)'
                 : isPage ? 'min(97vw, 1400px)' : 'min(96vw, 1120px)',
        height:    !file || showSummary ? undefined
                 : isPage ? 'min(94vh, 980px)'  : 'min(88vh, 800px)',
        maxHeight: '94vh',
        transition: 'width .18s ease',
        borderRadius: 14,
        background:   'var(--gc-surface)',
        boxShadow:    'var(--shadow-3)',
      }}>

        {/* ── header: the payment itself, stated once, large ── */}
        <div className="shrink-0 flex items-start justify-between gap-4 px-5 pt-4 pb-3"
             style={{ borderBottom: '1px solid var(--gc-border)' }}>
          <div className="min-w-0">
            {showSummary ? (
              <>
                <div className="text-[15px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                  Done
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                  Nothing left in this batch
                </div>
              </>
            ) : doc ? (
              <>
                <div className="text-[11px] font-semibold uppercase tracking-wide"
                     style={{ color: 'var(--gc-text-3)' }}>
                  Payment received
                </div>
                <div className="flex items-baseline gap-2.5 mt-0.5 flex-wrap">
                  {/* The number they came here to check. Sized like the
                      bucket tiles on the page behind. */}
                  <span className="tabular-nums" style={{
                    fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em',
                    color: 'var(--gc-text-1)', lineHeight: 1.1,
                  }}>
                    {money2(doc.paymentTotal)}
                  </span>
                  <span className="text-[13px] font-semibold truncate"
                        style={{ color: 'var(--gc-text-2)' }}>
                    {doc.payerNameAsPrinted || 'Unknown payer'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  <MetaChip>{shortDate(effectiveDate) ?? 'no date'}</MetaChip>
                  {doc.externalId && <MetaChip mono>{doc.externalId}</MetaChip>}
                  <MetaChip>{lines.length} row{lines.length === 1 ? '' : 's'}</MetaChip>
                </div>
              </>
            ) : (
              <>
                <div className="text-[15px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                  Apply a payment
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                  Upload a remittance and confirm what it pays
                </div>
              </>
            )}
          </div>
          <button onClick={onClose} disabled={busy} className="p-1 rounded shrink-0"
                  style={{ color: 'var(--gc-text-3)' }} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {/* ── the queue: where you are in the stack, and where you've been ──
            Deliberately a rail of every document rather than "3 of 45": a
            backlog is filed over several sittings, and the thing you need to
            see is which ones you already dealt with. Chips are clickable so a
            skipped one can be come back to. */}
        {queue.length > 1 && !allDone && (
          <div className="shrink-0 flex items-center gap-2 px-5 py-2"
               style={{ borderBottom: '1px solid var(--gc-border)', background: 'var(--gc-bg)' }}>
            <span className="text-[11px] font-semibold shrink-0 tabular-nums"
                  style={{ color: 'var(--gc-text-3)' }}>
              {qIndex + 1}/{queue.length}
              <span className="ml-1.5" style={{ color: 'var(--gc-text-3)' }}>
                · {remaining} to go
              </span>
            </span>
            <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto">
              {queue.map((f, i) => {
                const r = results[i];
                const here = i === qIndex;
                const tint =
                  r?.state === 'applied' || r?.state === 'attached' ? { fg: GREEN, bg: GREEN_BG, bd: GREEN }
                  : r?.state === 'failed'                           ? { fg: RED,   bg: RED_BG,   bd: RED }
                  : r?.state === 'skipped'                          ? { fg: 'var(--gc-text-3)', bg: 'var(--gc-surface)', bd: 'var(--gc-border)' }
                  : here                                            ? { fg: BLUE,  bg: BLUE_BG,  bd: BLUE }
                  :                                                   { fg: 'var(--gc-text-3)', bg: 'var(--gc-surface)', bd: 'var(--gc-border)' };
                return (
                  <button key={`${f.name}-${i}`} onClick={() => { void goTo(i); }} disabled={busy}
                          title={`${f.name}${r?.note ? ` — ${r.note}` : ''}`}
                          className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums"
                          style={{
                            color: tint.fg, background: tint.bg,
                            border: `1px solid ${tint.bd}`,
                            outline: here ? `2px solid ${BLUE}` : 'none',
                            outlineOffset: 1,
                            opacity: r && !here ? 0.75 : 1,
                            cursor: busy ? 'default' : 'pointer',
                          }}>
                    {(r?.state === 'applied' || r?.state === 'attached') && <Check size={9} />}
                    {r?.state === 'failed' && <CircleAlert size={9} />}
                    {chipLabel(f.name)}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {showSummary ? (
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6">
            <div className="flex items-center gap-2">
              <Check size={18} style={{ color: GREEN }} />
              <span className="text-[15px] font-bold" style={{ color: 'var(--gc-text-1)' }}>
                {queue.length} documents worked through
              </span>
            </div>
            <div className="flex items-baseline gap-2 mt-3">
              <span className="tabular-nums" style={{
                fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em',
                color: 'var(--gc-text-1)', lineHeight: 1.1,
              }}>
                {money2(appliedTotal)}
              </span>
              <span className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                applied across {tally.applied} remittance{tally.applied === 1 ? '' : 's'}
              </span>
            </div>
            <div className="mt-4 rounded-lg border overflow-hidden"
                 style={{ borderColor: 'var(--gc-border)' }}>
              {queue.map((f, i) => {
                const r = results[i];
                const fg = r?.state === 'applied' || r?.state === 'attached' ? GREEN
                         : r?.state === 'failed' ? RED : 'var(--gc-text-3)';
                return (
                  <div key={`${f.name}-${i}`}
                       className="flex items-center gap-2 px-3 py-1.5 text-[11.5px]"
                       style={{ borderTop: i ? '1px solid var(--gc-border-light)' : 'none' }}>
                    <span className="flex-1 min-w-0 truncate" style={{ color: 'var(--gc-text-2)' }}>
                      {f.name}
                    </span>
                    <span className="shrink-0 font-semibold" style={{ color: fg }}>
                      {r?.state === 'applied'  ? 'applied'
                       : r?.state === 'attached' ? 'proof filed'
                       : r?.state === 'failed'   ? 'failed'
                       : 'skipped'}
                    </span>
                    {r?.note && (
                      <span className="shrink-0 tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
                        {r.note}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {tally.skipped > 0 && (
              <div className="text-[11px] mt-3" style={{ color: 'var(--gc-text-3)' }}>
                Skipped documents were not recorded and nothing about them changed —
                drop them in again whenever you want to deal with them.
              </div>
            )}
          </div>
        ) : (
        <div className="flex-1 min-h-0 flex">
          {/* ── left: the source document, verbatim ── */}
          {file && (
            <div className="min-w-0 overflow-hidden flex flex-col"
                 style={{ flex: isPage ? '1 1 62%' : '1 1 50%',
                          borderRight: '1px solid var(--gc-border)',
                          background: 'var(--gc-bg)' }}>
              <div className="shrink-0 px-4 py-2 flex items-center justify-between gap-2"
                   style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                <span className="text-[11px] font-semibold uppercase tracking-wide truncate"
                      style={{ color: 'var(--gc-text-3)' }}>
                  {file.name}
                </span>
                {docUrl && (
                  // Escape hatch: a dense multi-page settlement is easier to
                  // read at full window size than in half a modal.
                  <a href={docUrl} target="_blank" rel="noreferrer"
                     className="text-[11px] font-semibold inline-flex items-center gap-1 shrink-0"
                     style={{ color: BLUE }}>
                    Open full size <ExternalLink size={11} />
                  </a>
                )}
              </div>
              <DocumentPane
                text={excelCsv ?? docText} url={docUrl}
              filename={excelCsv ? file.name.replace(/\.(xlsx|xlsm|xls)$/i, '.csv') : file.name}
              isImage={isImage}
                hoverRow={hoverRow} onHoverRow={setHoverRow}
              />
            </div>
          )}

          {/* ── right: what we read out of it ── */}
          <div className="flex-1 min-h-0 overflow-y-auto" style={{ flex: '1 1 auto' }}>
            <div className="px-5 py-4">

              {/* ── upload ── */}
              {!file ? (
                <div
                  onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={e => {
                    e.preventDefault(); setDragOver(false);
                    void accept(e.dataTransfer.files);
                  }}
                  onClick={() => inputRef.current?.click()}
                  className="flex flex-col items-center justify-center text-center cursor-pointer"
                  style={{
                    padding: '34px 20px',
                    borderRadius: 12,
                    border: `1.5px dashed ${dragOver ? BLUE : 'var(--gc-border)'}`,
                    background: dragOver ? BLUE_BG : 'var(--gc-bg)',
                    transition: 'background .12s ease, border-color .12s ease',
                  }}>
                  <div className="flex items-center justify-center rounded-full mb-3"
                       style={{ width: 44, height: 44, background: dragOver ? '#fff' : BLUE_BG }}>
                    <UploadCloud size={21} style={{ color: BLUE }} />
                  </div>
                  <div className="text-[13.5px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                    Drop a remittance here
                  </div>
                  <div className="text-xs mt-1" style={{ color: 'var(--gc-text-3)' }}>
                    or <span style={{ color: BLUE, fontWeight: 600 }}>browse your files</span>
                  </div>
                  <div className="text-[11px] mt-1.5" style={{ color: 'var(--gc-text-3)' }}>
                    Drop several at once — you&apos;ll confirm them one at a time
                  </div>
                  <div className="flex items-center gap-1 mt-3 flex-wrap justify-center">
                    {['PDF', 'Screenshot', 'Excel', 'CSV', 'Email'].map(t => (
                      <span key={t} className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                            style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-3)',
                                     border: '1px solid var(--gc-border)' }}>
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <button onClick={() => inputRef.current?.click()} disabled={busy}
                        className="w-full flex items-center gap-2.5 rounded-lg border px-3 py-2 mb-3 text-left"
                        style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}>
                  <FileText size={14} style={{ color: BLUE }} className="shrink-0" />
                  <span className="flex-1 min-w-0 text-xs truncate" style={{ color: 'var(--gc-text-1)' }}>
                    {file.name}
                  </span>
                  <span className="text-[11px] font-semibold shrink-0" style={{ color: BLUE }}>
                    Replace
                  </span>
                </button>
              )}
              <input ref={inputRef} type="file" className="hidden" disabled={busy} multiple
                     accept=".pdf,.csv,.txt,.eml,.xlsx,.xlsm,.xls,.png,.jpg,.jpeg,.gif,.webp,application/pdf,text/csv,text/plain,image/*"
                     onChange={e => { void accept(e.target.files); }} />

              {busy && phase === 'reading' && (
                <div className="flex items-center gap-2 text-xs mt-3" style={{ color: 'var(--gc-text-3)' }}>
                  <Loader2 size={13} className="animate-spin" /> Reading the document…
                </div>
              )}

              {err && (
                <div className="rounded-lg border p-3 my-3 text-xs flex gap-2"
                     style={{ borderColor: RED, background: RED_BG, color: '#991b1b' }}>
                  <CircleAlert size={14} className="shrink-0 mt-px" />
                  <span>{err}</span>
                </div>
              )}

              {/* ── who this is being applied to ── */}
              {(file || customerId) && (
                <div className="rounded-lg border mt-3" style={{
                  borderColor: chosenCustomer ? (inferred ? GREEN : BLUE) : 'var(--gc-border)',
                  background:  chosenCustomer ? (inferred ? GREEN_BG : BLUE_BG) : 'var(--gc-surface)',
                }}>
                  <div className="px-3 pt-2.5 pb-1 flex items-center gap-1.5">
                    <Building2 size={12} style={{ color: chosenCustomer ? (inferred ? GREEN : BLUE) : 'var(--gc-text-3)' }} />
                    <span className="text-[11px] font-semibold uppercase tracking-wide"
                          style={{ color: chosenCustomer ? (inferred ? GREEN : BLUE) : 'var(--gc-text-3)' }}>
                      {chosenCustomer ? 'Applying to' : 'Which customer?'}
                    </span>
                    {inferred && (
                      <span className="text-[10px] font-semibold inline-flex items-center gap-0.5 ml-auto"
                            style={{ color: GREEN }}>
                        <Check size={10} /> matched from the document
                      </span>
                    )}
                  </div>
                  {/* Deliberately loud: applying a payment to the wrong
                      customer is the one mistake here that is tedious to
                      unwind, so the name is stated at size before the
                      dropdown that can change it. */}
                  {chosenCustomer && (
                    <div className="px-3 text-[15px] font-bold truncate"
                         style={{ color: 'var(--gc-text-1)' }}>
                      {chosenCustomer.name}
                    </div>
                  )}
                  <div className="px-3 pb-2.5 pt-1.5">
                    <select value={customerId} disabled={busy} style={inputStyle}
                            onChange={e => {
                              const v = e.target.value;
                              setCustomerId(v);
                              // A deliberate choice, so it carries to the rest
                              // of the queue. Choosing "let the document
                              // decide" hands that back.
                              setCustomerLocked(!!v);
                              // Re-read scoped to the customer: narrowing the
                              // search resolves references ambiguous org-wide.
                              if (file) void run(file, v || null, excelCsv ?? undefined);
                            }}>
                      <option value="">Let the document decide</option>
                      {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                </div>
              )}

              {/* ── not a remittance ── */}
              {parsed && !parsed.isRemittance && (
                <div className="rounded-lg border p-3 mt-3 text-xs flex gap-2"
                     style={{ borderColor: AMBER, background: AMBER_BG, color: '#92400e' }}>
                  <HelpCircle size={14} className="shrink-0 mt-px" />
                  <span>
                    <strong>This doesn&apos;t look like a remittance.</strong>
                    <span className="block mt-1">{parsed.reason}</span>
                  </span>
                </div>
              )}

              {/* A document we recognised but couldn't use must SAY so.
                  Rendering nothing reads as a silent failure. */}
              {parsed?.isRemittance && !parsed.doc && (
                <div className="rounded-lg border p-3 mt-3 text-xs flex gap-2"
                     style={{ borderColor: AMBER, background: AMBER_BG, color: '#92400e' }}>
                  <CircleAlert size={14} className="shrink-0 mt-px" />
                  <span>
                    <strong>This looks like a remittance, but nothing could be applied.</strong>
                    <span className="block mt-1">{parsed.reason}</span>
                  </span>
                </div>
              )}

              {/* What kind of document this is, when it isn't one payment.
                  Said before anything else, because everything below reads
                  differently once you know the total never moved as a
                  single sum. */}
              {isStatement && doc && (
                <div className="rounded-lg border p-3 mt-3 text-xs flex gap-2"
                     style={{ borderColor: BLUE, background: BLUE_BG, color: '#1558d6' }}>
                  <FileText size={14} className="shrink-0 mt-px" />
                  <span>
                    <strong>This is a settlement report, not a single payment.</strong>
                    <span className="block mt-1">
                      It lists {lines.length} transaction{lines.length === 1 ? '' : 's'} the
                      payer has already settled, paid at different times. The invoices below
                      are credited exactly as they would be from a remittance — but the
                      evidence is filed as a statement, not as a {money0(doc.paymentTotal)}{' '}
                      transfer, so nothing goes looking for a deposit that size.
                    </span>
                  </span>
                </div>
              )}

              {/* 2. Supply the date the document doesn't carry. */}
              {parsed?.dateMissing && doc && (
                <div className="rounded-lg border p-3 mt-3"
                     style={{ borderColor: AMBER, background: AMBER_BG }}>
                  <div className="text-xs mb-2" style={{ color: '#92400e' }}>
                    <strong>No payment date on this document.</strong> It is recorded on the
                    proof and on every allocation, so it is not guessed.
                    {isStatement && (
                      <span className="block mt-1">
                        A report like this rarely prints one. Its rows were settled on
                        different days, so whatever you put here is an approximation for all
                        of them — the report&apos;s own date is the usual choice.
                      </span>
                    )}
                  </div>
                  <input type="date" value={dateOverride}
                         onChange={e => setDateOverride(e.target.value)}
                         style={{ ...inputStyle, maxWidth: 200 }} />
                </div>
              )}

              {/* ── duplicate guard ── */}
              {parsed?.duplicate && (
                <div className="rounded-lg border p-3 mt-3 text-xs flex gap-2"
                     style={{ borderColor: AMBER, background: AMBER_BG, color: '#92400e' }}>
                  <Copy size={14} className="shrink-0 mt-px" />
                  <span>
                    <strong>This looks like it was already recorded.</strong>
                    <span className="block mt-1">
                      A payment referencing{' '}
                      <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                        {parsed.duplicate.reference}
                      </span>{' '}
                      for {money2(parsed.duplicate.amount)} was recorded on{' '}
                      {shortDate(parsed.duplicate.createdAt) ?? parsed.duplicate.createdAt}
                      {parsed.duplicate.appliedCount > 0
                        ? `, applied to ${parsed.duplicate.appliedCount} invoice${parsed.duplicate.appliedCount === 1 ? '' : 's'}.`
                        : ', but not applied to anything yet.'}
                      {' '}Applying it again would double-credit those invoices —
                      but you can still attach this document as the proof.
                    </span>
                  </span>
                </div>
              )}
              {/* Two document lines landing on ONE invoice and summing past
                  what it owes. Blocking rather than warning: this wrote
                  $2,500 against a $1,250 invoice before the check existed,
                  and the resulting allocation looks completely ordinary
                  afterwards — one payment, one invoice, plausible amount. */}
              {overfilled.length > 0 && (
                <div className="rounded-lg border p-3 mt-3 text-xs flex gap-2"
                     style={{ borderColor: RED, background: RED_BG, color: '#991b1b' }}>
                  <AlertTriangle size={14} className="shrink-0 mt-px" />
                  <span className="min-w-0">
                    <strong>
                      {overfilled.length === 1 ? 'A row pair doesn\u2019t fit its invoice.'
                        : `${overfilled.length} row groups don\u2019t fit their invoices.`}
                    </strong>
                    <span className="block mt-1">
                      Several rows resolved to the same invoice and together they
                      come to more than it still owes. That is two different loads
                      landing on one invoice, not a charge breakdown \u2014 applying
                      would pay it twice. Untick the row that doesn&apos;t belong, or
                      use <em>find</em> to point it at the right invoice.
                    </span>
                    <span className="block mt-1.5">
                      {overfilled.slice(0, 4).map(o => (
                        <span key={o.invoiceId} className="block truncate">
                          #{o.group[0].invoiceNumber} owes {money2(o.owed)} \u00b7 {o.group.length} rows
                          total {money2(o.sum)} \u00b7 {money2(o.over)} too much
                        </span>
                      ))}
                    </span>
                  </span>
                </div>
              )}

              {/* The sharpest signal there is: not "this invoice looks
                  settled" but "this exact figure is already sitting on it".
                  Stated before the softer status-based notice below, and
                  louder when it's about to happen anyway. */}
              {repeats.length > 0 && (
                <div className="rounded-lg border p-3 mt-3 text-xs flex gap-2"
                     style={repeatsTicked > 0
                       ? { borderColor: RED,   background: RED_BG,   color: '#991b1b' }
                       : { borderColor: AMBER, background: AMBER_BG, color: '#92400e' }}>
                  <Copy size={14} className="shrink-0 mt-px" />
                  <span className="min-w-0">
                    <strong>
                      {repeats.length} of these {repeats.length === 1 ? 'amount is' : 'amounts are'} already
                      recorded against the same invoice{repeats.length === 1 ? '' : 's'}.
                    </strong>
                    <span className="block mt-1">
                      {repeatsTicked > 0
                        ? `${repeatsTicked} ${repeatsTicked === 1 ? 'is' : 'are'} still ticked — applying now would credit that money a second time.`
                        : 'Unticked, so nothing gets credited twice. Attach this document as their proof instead.'}
                    </span>
                    <span className="block mt-1.5">
                      {repeats.slice(0, 5).map(l => (
                        <span key={l.rowIndex} className="block truncate">
                          #{l.invoiceNumber} · {money2(l.alreadyOnInvoice!.amount)} recorded{' '}
                          {shortDate(l.alreadyOnInvoice!.paidOn) ?? l.alreadyOnInvoice!.paidOn}
                          {l.alreadyOnInvoice!.hasProof ? ' · has proof' : ' · no proof yet'}
                        </span>
                      ))}
                      {repeats.length > 5 && (
                        <span className="block">…and {repeats.length - 5} more</span>
                      )}
                    </span>
                  </span>
                </div>
              )}

              {!parsed?.duplicate && (parsed?.summary?.alreadyPaid ?? 0) > 0 && (
                <div className="rounded-lg border p-3 mt-3 text-xs flex gap-2"
                     style={{ borderColor: AMBER, background: AMBER_BG, color: '#92400e' }}>
                  <Copy size={14} className="shrink-0 mt-px" />
                  <span>
                    <strong>
                      {parsed!.summary!.alreadyPaid} of these invoice
                      {parsed!.summary!.alreadyPaid === 1 ? ' is' : 's are'} already paid.
                    </strong>
                    <span className="block mt-1">
                      Unticked below so they aren&apos;t double-credited. Attach this
                      document as their proof instead, or tick them back on if it
                      really is a separate payment.
                    </span>
                  </span>
                </div>
              )}

              {/* ── totals invariant ── */}
              {parsed?.totals && (
                <div className="rounded-lg border p-3 mt-3 text-xs flex gap-2"
                     style={!parsed.totals.ok
                       ? { borderColor: RED, background: RED_BG, color: '#991b1b' }
                       : parsed.totalsDerived
                         ? { borderColor: AMBER, background: AMBER_BG, color: '#92400e' }
                         : { borderColor: 'var(--gc-border)', color: 'var(--gc-text-2)' }}>
                  {!parsed.totals.ok
                    ? <AlertTriangle size={14} className="shrink-0 mt-px" />
                    : parsed.totalsDerived
                      ? <AlertTriangle size={14} className="shrink-0 mt-px" />
                      : <Check size={14} className="shrink-0 mt-px" style={{ color: GREEN }} />}
                  <span>
                    {parsed.totals.ok && parsed.totalsDerived ? (
                      <>
                        <strong>No total printed on this document.</strong>
                        <span className="block mt-1">
                          The {money2(parsed.totals.lineSum)} above is the sum of its{' '}
                          {lines.length} rows, so nothing cross-checked them — a missed row
                          would not show up here. Worth comparing against the document.
                        </span>
                      </>
                    ) : parsed.totals.ok ? (
                      <>Every row adds up to the {money2(parsed.totals.declared)} printed on the document.</>
                    ) : (
                      <>
                        <strong>Rows don&apos;t match the document total.</strong>
                        <span className="block mt-1">
                          Rows add to {money2(parsed.totals.lineSum)} but the document says{' '}
                          {money2(parsed.totals.declared)} — a difference of{' '}
                          {money2(Math.abs(parsed.totals.drift))}. A row was probably misread,
                          so this can&apos;t be applied as-is.
                        </span>
                      </>
                    )}
                  </span>
                </div>
              )}

              {/* ── matched lines ── */}
              {parsed?.isRemittance && lines.length > 0 && (
                <>
                  <div className="flex items-baseline justify-between mt-4 mb-1.5">
                    <span className="text-[11px] font-semibold uppercase tracking-wide"
                          style={{ color: 'var(--gc-text-3)' }}>
                      What this pays
                    </span>
                    <span className="text-[11px] font-semibold"
                          style={{ color: (parsed.summary?.unmatched ?? 0) > 0 ? AMBER : GREEN }}>
                      {parsed.summary?.matched ?? 0} of {lines.length} matched
                    </span>
                  </div>
                  <div className="rounded-lg border overflow-hidden mb-2"
                       style={{ borderColor: 'var(--gc-border)' }}>
                    {lines.map(l => (
                      <LineRow key={l.rowIndex} line={l}
                               included={!!l.invoiceId && !skip.has(l.rowIndex)}
                               disabled={busy || !l.invoiceId}
                               hovered={hoverRow === l.rowIndex}
                               onHover={setHoverRow}
                               searching={searchFor === l.rowIndex}
                               onSearch={() => setSearchFor(searchFor === l.rowIndex ? null : l.rowIndex)}
                               customerId={customerId || null}
                               onPick={inv => {
                                 setPicked(p => ({ ...p, [l.rowIndex]: inv }));
                                 setSearchFor(null);
                                 // A hand-picked line is meant to be applied.
                                 setSkip(sk => { const n = new Set(sk); n.delete(l.rowIndex); return n; });
                               }}
                               onToggle={() => setSkip(s => {
                                 const n = new Set(s);
                                 if (n.has(l.rowIndex)) n.delete(l.rowIndex);
                                 else n.add(l.rowIndex);
                                 return n;
                               })} />
                    ))}
                  </div>
                  {parsed.cohort && parsed.cohort.missing.length > 0 && (
                    <div className="rounded-lg border p-3 mb-2 text-xs flex gap-2"
                         style={{ borderColor: AMBER, background: AMBER_BG, color: '#92400e' }}>
                      <CalendarClock size={14} className="shrink-0 mt-px" />
                      <span className="min-w-0">
                        <strong>
                          {parsed.cohort.missing.length} invoice
                          {parsed.cohort.missing.length === 1 ? '' : 's'} billed the same day
                          {parsed.cohort.missing.length === 1 ? ' is' : ' are'} not on this document.
                        </strong>
                        <span className="block mt-1">
                          {parsed.cohort.billedCount} invoice
                          {parsed.cohort.billedCount === 1 ? '' : 's'} billed{' '}
                          {parsed.cohort.dates.map(d => shortDate(d) ?? d).join(', ')};
                          this covers {parsed.cohort.onDocument}. Worth checking whether they were
                          short-paid or simply left out.
                        </span>
                        <span className="block mt-1.5">
                          {parsed.cohort.missing.slice(0, 6).map(m => (
                            <span key={m.invoiceId} className="block truncate">
                              #{m.invoiceNumber}
                              {m.loadNum ? ` · Load ${m.loadNum}` : ''}
                              {' · '}{money2(m.balance)}
                              {m.status === 'paid' ? ' · already paid' : ''}
                            </span>
                          ))}
                          {parsed.cohort.missing.length > 6 && (
                            <span className="block">…and {parsed.cohort.missing.length - 6} more</span>
                          )}
                        </span>
                      </span>
                    </div>
                  )}

                  {(parsed.summary?.unmatched ?? 0) > 0 && (
                    <div className="text-[11px] mb-2" style={{ color: 'var(--gc-text-3)' }}>
                      Unmatched rows aren&apos;t applied. The payment is still recorded in full,
                      so the remainder stays visible as unapplied evidence.
                    </div>
                  )}
                </>
              )}

              {parsed?.doc?.unparsedRows?.length ? (
                <div className="rounded-lg border p-3 text-xs mt-2"
                     style={{ borderColor: AMBER, background: AMBER_BG, color: '#92400e' }}>
                  {parsed.doc.unparsedRows.length} row(s) couldn&apos;t be read and were skipped.
                </div>
              ) : null}
            </div>
          </div>
        </div>
        )}

        {/* ── footer ── */}
        {showSummary ? (
          <div className="shrink-0 px-5 py-3 flex items-center gap-3"
               style={{ borderTop: '1px solid var(--gc-border)' }}>
            <span className="text-[11px] mr-auto" style={{ color: 'var(--gc-text-3)' }}>
              {tally.applied} applied
              {tally.attached ? ` · ${tally.attached} proof-only` : ''}
              {tally.skipped  ? ` · ${tally.skipped} skipped`     : ''}
              {tally.failed   ? ` · ${tally.failed} failed`       : ''}
            </span>
            <button onClick={onClose}
                    className="text-xs font-semibold px-3.5 py-2 rounded shrink-0"
                    style={{ background: BLUE, color: '#fff', cursor: 'pointer' }}>
              Close
            </button>
          </div>
        ) : (file || parsed) && (
          <div className="shrink-0 px-5 py-3 flex items-center gap-3"
               style={{ borderTop: '1px solid var(--gc-border)' }}>
            <div className="min-w-0 mr-auto">
              {busy && phase === 'applying' ? (
                <span className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                  {done} of {invoiceCount} recorded…
                </span>
              ) : doc && included.length === 0 && attachable.length > 0 ? (
                <span className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                  Already credited — this files the document as the proof.
                  No money moves.
                </span>
              ) : doc && included.length > 0 ? (
                <>
                  <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>Applying</div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="tabular-nums" style={{
                      fontSize: 16, fontWeight: 700, color: 'var(--gc-text-1)', lineHeight: 1.2,
                    }}>
                      {money2(includedTotal)}
                    </span>
                    {Math.abs(includedTotal - doc.paymentTotal) > 0.005 && (
                      <span className="text-[11px]" style={{ color: AMBER }}>
                        of {money0(doc.paymentTotal)} · {money0(doc.paymentTotal - includedTotal)} left over
                      </span>
                    )}
                  </div>
                </>
              ) : null}
            </div>
            {doc && !effectiveDate && (
              <span className="text-[11px] mr-1" style={{ color: AMBER }}>
                Set the payment date first
              </span>
            )}
            {queue.length > 1 && (
              // Leaves the document untouched and moves on. A backlog always
              // contains a few that need a decision made elsewhere first, and
              // stalling the whole queue on one of them is how the other
              // forty stay unfiled.
              <button onClick={() => { void settle('skipped'); }} disabled={busy}
                      className="text-xs font-semibold px-3 py-1.5 rounded border shrink-0"
                      style={{ borderColor: 'var(--gc-border)', color: 'var(--gc-text-2)' }}>
                Skip
              </button>
            )}
            <button onClick={onClose} disabled={busy}
                    className="text-xs font-semibold px-3 py-1.5 rounded border shrink-0"
                    style={{ borderColor: 'var(--gc-border)', color: 'var(--gc-text-2)' }}>
              {/* Once anything has landed, "Cancel" would be a lie. */}
              {Object.keys(results).length ? 'Close' : 'Cancel'}
            </button>
            {/* When every matched invoice is already credited there is nothing
                to apply — the useful action is to file the evidence against
                the payment that already exists. It becomes the primary button
                in that case, and a secondary one when both are possible. */}
            {canAttach && (
              <button onClick={() => { void handleAttach(); }} disabled={busy}
                      className="text-xs font-semibold px-3.5 py-2 rounded inline-flex items-center gap-1.5 shrink-0"
                      style={{
                        background: included.length === 0 ? BLUE : 'var(--gc-surface)',
                        color:      included.length === 0 ? '#fff' : BLUE,
                        border:     included.length === 0 ? 'none' : `1px solid ${BLUE}`,
                        cursor: 'pointer',
                      }}>
                {busy && phase === 'applying' && <Loader2 size={12} className="animate-spin" />}
                <Paperclip size={12} />
                Attach as proof to {attachable.length} invoice{attachable.length === 1 ? '' : 's'}
              </button>
            )}
            {(included.length > 0 || !canAttach) && (
            <button onClick={() => { void handleApply(); }} disabled={!canApply}
                    className="text-xs font-semibold px-3.5 py-2 rounded inline-flex items-center gap-1.5 shrink-0"
                    style={{
                      background: canApply ? BLUE : 'var(--gc-border)',
                      color: canApply ? '#fff' : 'var(--gc-text-3)',
                      cursor: canApply ? 'pointer' : 'default',
                    }}>
              {busy && phase === 'applying' && <Loader2 size={12} className="animate-spin" />}
              {invoiceCount
                ? <>Apply to {invoiceCount} invoice{invoiceCount === 1 ? '' : 's'}</>
                : 'Apply'}
            </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── bits ──────────────────────────────────────────────────────────────

function MetaChip({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <span className="text-[10.5px] px-1.5 py-0.5 rounded" style={{
      background: 'var(--gc-bg)', color: 'var(--gc-text-3)',
      border: '1px solid var(--gc-border-light)',
      fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
    }}>
      {children}
    </span>
  );
}

/** The source document rendered as-is. PDFs go to the browser's own viewer;
 *  CSVs become a table so rows line up with the extracted lines beside them.
 *  Display only — nothing here feeds the matcher. */
function DocumentPane({ text, url, filename, isImage, hoverRow, onHoverRow }: {
  text: string | null; url: string | null; filename: string; isImage: boolean;
  hoverRow: number | null; onHoverRow: (r: number | null) => void;
}) {
  const isCsv = /\.csv$/i.test(filename);
  const rows  = useMemo(() => (text && isCsv ? parseCsv(text) : null), [text, isCsv]);

  // Whether row 0 is a header, so a CSV row can be tied to an extracted
  // line. Heuristic: a header has no cell that looks like a number.
  // Highlighting is a convenience — if it's wrong the document is still
  // shown correctly, which is the point of this pane.
  const headerOffset = useMemo(() => {
    if (!rows?.length) return 0;
    return rows[0].some(c => /^-?[\d,]+(\.\d+)?$/.test(c.trim()) && c.trim() !== '') ? 0 : 1;
  }, [rows]);

  if (url && isImage) {
    // Scrollable at natural width rather than scaled to fit: a screenshot of
    // a payment screen is often tall and narrow, and shrinking it to the pane
    // is exactly what makes the amounts unreadable.
    return (
      <div className="flex-1 min-h-0 overflow-auto">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={filename} style={{ display: 'block', width: '100%', height: 'auto' }} />
      </div>
    );
  }
  if (url) {
    // navpanes=0 drops the thumbnail rail (~210px of the pane), toolbar=0
    // drops the zoom/print bar, and view=FitH makes the page fill the width
    // it just reclaimed. Without these the browser opens at ~39% zoom with
    // half the pane spent on chrome, which is unreadable.
    return (
      <iframe src={`${url}#toolbar=0&navpanes=0&statusbar=0&view=FitH`}
              title={filename} className="flex-1 min-h-0 w-full" style={{ border: 0 }} />
    );
  }
  if (!text) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs" style={{ color: 'var(--gc-text-3)' }}>
        <Loader2 size={13} className="animate-spin mr-1.5" /> Loading…
      </div>
    );
  }
  if (rows?.length) {
    return (
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full" style={{ borderCollapse: 'collapse', fontSize: 11 }}>
          <tbody>
            {rows.map((r, i) => {
              const dataRow  = i - headerOffset;
              const isHeader = i < headerOffset;
              const lit      = !isHeader && hoverRow === dataRow;
              return (
                <tr key={i}
                    onMouseEnter={() => !isHeader && onHoverRow(dataRow)}
                    onMouseLeave={() => onHoverRow(null)}
                    style={{ background: lit ? BLUE_BG : isHeader ? 'var(--gc-surface)' : 'transparent' }}>
                  <td className="px-1.5 py-1 tabular-nums select-none"
                      style={{ color: 'var(--gc-text-3)', borderBottom: '1px solid var(--gc-border-light)',
                               width: 26, textAlign: 'right' }}>
                    {isHeader ? '' : dataRow + 1}
                  </td>
                  {r.map((c, j) => (
                    <td key={j} className="px-1.5 py-1"
                        style={{
                          borderBottom: '1px solid var(--gc-border-light)',
                          color: isHeader ? 'var(--gc-text-3)' : 'var(--gc-text-1)',
                          fontWeight: isHeader ? 700 : 400,
                          whiteSpace: 'nowrap',
                        }}>
                      {c}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="flex-1 min-h-0 overflow-auto px-3 py-2">
      <pre className="whitespace-pre-wrap" style={{ fontSize: 11, color: 'var(--gc-text-1)', margin: 0 }}>
        {text}
      </pre>
    </div>
  );
}

/**
 * Two lines per row, mirroring the ledger's own invoice rows: the money
 * facts on top, the freight underneath. The load context matters because an
 * invoice number alone is not recognisable — "Load 61934, Salt Lake → Reno,
 * picked up Jul 1" is what tells the operator this is the right load.
 */
function LineRow({
  line, included, disabled, onToggle, hovered, onHover,
  searching, onSearch, onPick, customerId,
}: {
  line: ParsedPaymentLine; included: boolean; disabled: boolean; onToggle: () => void;
  hovered: boolean; onHover: (r: number | null) => void;
  searching: boolean; onSearch: () => void;
  onPick: (inv: InvoiceSearchResult) => void; customerId: string | null;
}) {
  const matched = !!line.invoiceId;
  const age     = line.agingDays;
  // Short-paid only if the WHOLE set of charges on this invoice falls short.
  // A $95 lumper line beside a $580 linehaul line is not a short payment.
  const grouped = line.chargeCount > 1;
  const short   = matched && line.invoiceTotal != null && !line.settlesInvoice
    && Math.abs(line.invoiceTotal - line.chargeTotal) > 0.005;

  return (
    <div style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
    <div className="flex items-start gap-2.5 px-2.5 py-2"
         onMouseEnter={() => onHover(line.rowIndex)}
         onMouseLeave={() => onHover(null)}
         style={{
           background: hovered ? BLUE_BG : included ? 'rgba(26,115,232,.055)' : 'transparent',
           boxShadow: hovered ? `inset 2px 0 0 ${BLUE}` : undefined,
         }}>
      <input type="checkbox" checked={included} disabled={disabled} onChange={onToggle}
             className="mt-0.5 shrink-0" />

      <span className="flex-1 min-w-0">
        {/* money line */}
        <span className="flex items-baseline gap-1.5">
          {matched ? (
            <span className="text-[13px] font-bold"
                  style={{ color: line.alreadyPaid ? 'var(--gc-text-3)' : BLUE }}>
              #{line.invoiceNumber}
            </span>
          ) : (
            <span className="text-[12.5px] font-bold" style={{ color: AMBER }}>
              No match
            </span>
          )}
          {line.alreadyPaid && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                  style={{ background: AMBER_BG, color: AMBER }}>
              already paid
            </span>
          )}
          {!line.alreadyPaid && age !== null && age !== undefined && age > 0 && (
            <span className="text-[10.5px] font-bold tabular-nums" style={{ color: ageColor(age) }}>
              {age}d
            </span>
          )}
          <span className="flex-1" />
          <span className="text-[13px] font-bold tabular-nums shrink-0"
                style={{ color: 'var(--gc-text-1)' }}>
            {money2(line.amount)}
          </span>
        </span>

        {/* freight line — what makes an invoice number recognisable */}
        <span className="block text-[11px] truncate mt-0.5" style={{ color: 'var(--gc-text-2)' }}>
          {matched ? (
            <>
              {line.loadNum && (
                <span className="inline-flex items-center gap-1 mr-1.5" style={{ color: 'var(--gc-text-3)' }}>
                  <Truck size={10} /> {line.loadNum}
                </span>
              )}
              {line.title ?? <span style={{ color: 'var(--gc-text-3)' }}>No load title</span>}
              {shortDate(line.pickupAt) && (
                <span style={{ color: 'var(--gc-text-3)' }}> · picked up {shortDate(line.pickupAt)}</span>
              )}
            </>
          ) : line.ambiguous?.length ? (
            <span style={{ color: AMBER }}>{line.ambiguous.length} possible invoices — pick one manually</span>
          ) : (
            <span style={{ color: 'var(--gc-text-3)' }}>Nothing in the ledger matches this reference</span>
          )}
        </span>

        {/* provenance — the printed reference, verbatim, plus any variance */}
        <span className="block text-[10.5px] mt-1 truncate" style={{ color: 'var(--gc-text-3)' }}>
          {line.referenceAsPrinted ? (
            <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
              {line.referenceAsPrinted}
            </span>
          ) : 'no reference printed'}
          {grouped && (
            <span style={{ color: line.settlesInvoice ? GREEN : AMBER }}>
              {' · '}charge {line.chargeCount > 1 ? `of ${money2(line.chargeTotal)}` : ''}
              {line.settlesInvoice ? ' · pays the invoice in full' : ''}
            </span>
          )}
          {/* An agreed shortfall is not a short payment, and saying so is
              the difference between an invoice that closes and one that
              sits in past due for $4.51 until someone gives up on it. */}
          {line.quickPay ? (
            <span style={{ color: GREEN }}>
              {' · '}quick pay {(line.quickPay.rate * 100).toFixed(2).replace(/\.?0+$/, '')}%
              {' · '}{money2(line.quickPay.withheld)} withheld · settles the invoice
            </span>
          ) : short && (
            <span style={{ color: AMBER }}>
              {' · '}invoice {money2(line.invoiceTotal!)}
              {line.deductionLabel ? ` · ${line.deductionLabel}` : ' · short-paid'}
            </span>
          )}
          {line.alreadyOnInvoice && (
            <span style={{ color: RED }}>
              {' · '}already recorded {shortDate(line.alreadyOnInvoice.paidOn) ?? ''}
            </span>
          )}
        </span>
      </span>

      <span className="flex flex-col items-end gap-1 shrink-0">
        <ConfidenceChip line={line} />
        {/* A reference the resolver can't place is not always recoverable —
            it may be truncated on the document, or an identifier we never
            recorded. The operator still knows the load, so let them say. */}
        <button type="button" onClick={onSearch}
                className="text-[10px] font-semibold inline-flex items-center gap-0.5"
                style={{ color: searching ? 'var(--gc-text-3)' : BLUE }}>
          <Search size={9} /> {line.invoiceId ? 'change' : 'find'}
        </button>
      </span>
    </div>

    {searching && (
      <InvoiceSearch customerId={customerId} amount={line.amount} onPick={onPick} />
    )}
    </div>
  );
}

/** Search this customer's invoices by invoice #, load #, or internal load
 *  id. Seeded blank rather than with the unusable reference — the whole
 *  reason we are here is that the printed one didn't resolve. */
function InvoiceSearch({ customerId, amount, onPick }: {
  customerId: string | null; amount: number; onPick: (inv: InvoiceSearchResult) => void;
}) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<InvoiceSearchResult[]>([]);
  const [busy, setBusy] = useState(false);

  // Both setState calls live inside async callbacks. Doing either in the
  // effect body synchronously is the cascading-render pattern React 19
  // warns about; stale rows are handled by deriving `shown` instead of
  // clearing them eagerly.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    let alive = true;
    const t = setTimeout(() => {
      if (!alive) return;
      setBusy(true);
      void railway.searchInvoices({ q: term, customerId, scope: 'open' })
        .then(r => { if (alive) setRows(r.invoices); })
        .catch(() => { if (alive) setRows([]); })
        .finally(() => { if (alive) setBusy(false); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q, customerId]);

  const shown = q.trim().length >= 2 ? rows : [];

  return (
    <div className="px-2.5 pb-2.5" style={{ background: 'var(--gc-bg)' }}>
      <div className="flex items-center gap-1.5 rounded border px-2 py-1.5 mb-1.5"
           style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}>
        <Search size={12} style={{ color: 'var(--gc-text-3)' }} />
        <input autoFocus value={q} onChange={e => setQ(e.target.value)}
               placeholder="Invoice #, load #, or internal load id…"
               className="flex-1 min-w-0 outline-none"
               style={{ fontSize: 12, background: 'transparent', color: 'var(--gc-text-1)' }} />
        {busy && <Loader2 size={11} className="animate-spin" style={{ color: 'var(--gc-text-3)' }} />}
      </div>

      {q.trim().length >= 2 && !busy && shown.length === 0 && (
        <div className="text-[11px] px-1 py-1" style={{ color: 'var(--gc-text-3)' }}>
          Nothing open matches that for this customer.
        </div>
      )}

      {shown.map(r => {
        // Same amount is a strong hint, so say so — without letting it pick.
        const exact = Math.abs(r.invoiceTotal - amount) < 0.005;
        return (
          <button key={r.invoiceId} type="button" onClick={() => onPick(r)}
                  className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded"
                  style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', marginBottom: 4 }}>
            <span className="flex-1 min-w-0">
              <span className="block text-[12px] font-bold truncate" style={{ color: BLUE }}>
                #{r.invoiceNumber}
                {r.loadNum && <span style={{ color: 'var(--gc-text-3)', fontWeight: 600 }}> · Load {r.loadNum}</span>}
              </span>
              <span className="block text-[10.5px] truncate" style={{ color: 'var(--gc-text-3)' }}>
                {r.title ?? 'No load title'}
                {shortDate(r.pickupAt) ? ` · picked up ${shortDate(r.pickupAt)}` : ''}
              </span>
            </span>
            {exact && (
              <span className="text-[9.5px] font-bold px-1 py-0.5 rounded shrink-0"
                    style={{ background: GREEN_BG, color: GREEN }}>same amount</span>
            )}
            <span className="text-[12px] font-bold tabular-nums shrink-0"
                  style={{ color: 'var(--gc-text-1)' }}>{money2(r.invoiceTotal)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Shows WHY a row matched, not just that it did — a reviewer confirming
 *  money movement needs to see whether it was a literal invoice number or a
 *  derived guess. */
function ConfidenceChip({ line }: { line: ParsedPaymentLine }) {
  const label =
    line.matchedBy === 'invoice_number'   ? 'invoice #' :
    line.matchedBy === 'load_num'         ? 'load #'    :
    line.matchedBy === 'internal_load_id' ? 'load id'   :
    line.matchedBy === 'ref_num'          ? 'ref #'     :
    line.matchedBy === 'ambiguous'        ? 'ambiguous' :
    line.matchedBy === 'processor_ref'    ? 'processor' :
    line.matchedBy === 'amount'           ? 'amount' :
    line.matchedBy === 'cohort'           ? 'same batch' :
    line.matchedBy === 'manual'           ? 'you picked' : '—';
  const strong = line.confidence >= 90;
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0 mt-0.5" style={{
      background: !line.invoiceId ? 'transparent' : strong ? GREEN_BG : AMBER_BG,
      color:      !line.invoiceId ? 'var(--gc-text-3)' : strong ? GREEN : AMBER,
      border:     `1px solid ${!line.invoiceId ? 'var(--gc-border)' : 'transparent'}`,
      whiteSpace: 'nowrap',
    }} title={line.note ?? `matched by ${line.matchedBy}, confidence ${line.confidence}`}>
      {label}
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', fontSize: 12, padding: '6px 8px', borderRadius: 6,
  border: '1px solid var(--gc-border)', background: 'var(--gc-surface)',
  color: 'var(--gc-text-1)',
};
