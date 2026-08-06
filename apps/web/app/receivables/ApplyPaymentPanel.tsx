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

export default function ApplyPaymentPanel({
  customers, initialCustomerId, onClose, onSaved,
}: ApplyPaymentPanelProps) {
  const [file,    setFile]    = useState<File | null>(null);
  const [parsed,  setParsed]  = useState<ParsePaymentResponse | null>(null);
  const [customerId, setCustomerId] = useState<string>(initialCustomerId ?? '');
  const [skip,    setSkip]    = useState<Set<number>>(new Set());
  const [busy,    setBusy]    = useState(false);
  const [phase,   setPhase]   = useState<'idle' | 'reading' | 'applying'>('idle');
  const [err,     setErr]     = useState<string | null>(null);
  const [done,    setDone]    = useState(0);
  const [dragOver, setDragOver] = useState(false);
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
      // Default to applying everything that matched — EXCEPT invoices that
      // are already settled. Those are the signature of a re-uploaded
      // remittance, and re-applying would push them overpaid.
      setPicked({}); setSearchFor(null);
      setSkip(new Set(
        res.lines.filter(l => !l.invoiceId || l.alreadyPaid).map(l => l.rowIndex),
      ));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not read that document');
      setParsed(null);
    } finally {
      setBusy(false); setPhase('idle');
    }
  }, []);

  const accept = useCallback(async (f: File | null) => {
    if (!f) return;
    setFile(f); setParsed(null); setErr(null);
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
        void run(f, customerId || null, csv);
      } catch {
        setErr("Couldn't read that spreadsheet — try exporting the sheet as CSV.");
      }
      return;
    }
    setSheetCsv(null);
    void run(f, customerId || null);
  }, [run, customerId]);

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
  const includedTotal = useMemo(
    () => Math.round(included.reduce((s, l) => s + l.amount, 0) * 100) / 100,
    [included],
  );

  // Already-credited invoices that this document is evidence FOR. The money
  // is on the books; what's missing is the proof. Ticking such a row means
  // "credit it again anyway", so ticked rows drop out of this set.
  const attachable = useMemo(
    () => lines.filter(l => l.invoiceId && l.alreadyPaid && skip.has(l.rowIndex)),
    [lines, skip],
  );

  const totalsFailed = parsed?.totals ? !parsed.totals.ok : false;
  const canApply  = !!parsed?.isRemittance && !totalsFailed && included.length > 0 && !busy;
  const canAttach = !!parsed?.isRemittance && attachable.length > 0 && !busy;
  const doc = parsed?.doc ?? null;
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
        kind:       'remittance',
        source:     'upload',
        occurredOn: parsed.doc.paymentDate,
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
      } else if (linked === 0) {
        setErr('Those payments already have proof attached — nothing to link.');
      } else {
        onClose();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to attach the proof');
    } finally {
      setBusy(false); setPhase('idle');
    }
  }

  async function handleApply() {
    if (!parsed?.doc || !canApply) return;
    setBusy(true); setPhase('applying'); setErr(null); setDone(0);
    try {
      const created = await railway.createPaymentProof({
        kind:       'remittance',
        source:     'upload',
        occurredOn: parsed.doc.paymentDate,
        // The proof records what the payer SENT, not what we managed to
        // apply. Any remainder stays visible as unapplied evidence rather
        // than disappearing.
        amount:     parsed.doc.paymentTotal,
        ...(parsed.doc.externalId ? { reference: parsed.doc.externalId } : {}),
        ...(parsed.doc.payerNameAsPrinted ? { payerRaw: parsed.doc.payerNameAsPrinted } : {}),
        ...(customerId ? { customerId } : {}),
      });
      if (file) await railway.uploadProofAttachment(created.proof.id, file);

      // Sequential: each write recomputes its invoice server-side, and one
      // failure must not abandon the rest.
      const failed: string[] = [];
      for (const l of included) {
        try {
          await railway.createInvoicePayment(l.invoiceId!, {
            amount:  l.amount,
            paidOn:  parsed.doc.paymentDate,
            proofId: created.proof.id,
            note:    `Remittance ${parsed.doc.externalId ?? ''} row ${l.rowIndex + 1}`.trim(),
          });
          setDone(d => d + 1);
        } catch (e) {
          failed.push(l.invoiceNumber ?? String(l.referenceAsPrinted));
          console.warn('[apply payment] failed for', l.invoiceNumber, e);
        }
      }

      onSaved();
      if (failed.length) setErr(`${failed.length} of ${included.length} could not be recorded: ${failed.join(', ')}`);
      else onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to apply payment');
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
        width:     !file ? 'min(96vw, 520px)'
                 : isPage ? 'min(97vw, 1400px)' : 'min(96vw, 1120px)',
        height:    !file ? undefined
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
            {doc ? (
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
                  <MetaChip>{shortDate(doc.paymentDate) ?? doc.paymentDate}</MetaChip>
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
                    void accept(e.dataTransfer.files?.[0] ?? null);
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
              <input ref={inputRef} type="file" className="hidden" disabled={busy}
                     accept=".pdf,.csv,.txt,.eml,.xlsx,.xlsm,.xls,.png,.jpg,.jpeg,.gif,.webp,application/pdf,text/csv,text/plain,image/*"
                     onChange={e => { void accept(e.target.files?.[0] ?? null); }} />

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
                     style={parsed.totals.ok
                       ? { borderColor: 'var(--gc-border)', color: 'var(--gc-text-2)' }
                       : { borderColor: RED, background: RED_BG, color: '#991b1b' }}>
                  {parsed.totals.ok
                    ? <Check size={14} className="shrink-0 mt-px" style={{ color: GREEN }} />
                    : <AlertTriangle size={14} className="shrink-0 mt-px" />}
                  <span>
                    {parsed.totals.ok ? (
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

        {/* ── footer ── */}
        {(file || parsed) && (
          <div className="shrink-0 px-5 py-3 flex items-center gap-3"
               style={{ borderTop: '1px solid var(--gc-border)' }}>
            <div className="min-w-0 mr-auto">
              {busy && phase === 'applying' ? (
                <span className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                  {done} of {included.length} recorded…
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
            <button onClick={onClose} disabled={busy}
                    className="text-xs font-semibold px-3 py-1.5 rounded border shrink-0"
                    style={{ borderColor: 'var(--gc-border)', color: 'var(--gc-text-2)' }}>
              Cancel
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
              {included.length
                ? <>Apply to {included.length} invoice{included.length === 1 ? '' : 's'}</>
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
  const short   = matched && line.invoiceTotal != null
    && Math.abs(line.invoiceTotal - line.amount) > 0.005;

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
          {short && (
            <span style={{ color: AMBER }}>
              {' · '}invoice {money2(line.invoiceTotal!)}
              {line.deductionLabel ? ` · ${line.deductionLabel}` : ' · short-paid'}
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
