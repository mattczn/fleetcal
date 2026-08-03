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
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  X, Upload, Check, AlertTriangle, Loader2, FileText, HelpCircle,
} from 'lucide-react';
import { railway } from '@/lib/railway';
import type { ParsePaymentResponse, ParsedPaymentLine } from '@fleetcal/types';

const money2 = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

export interface ApplyPaymentPanelProps {
  customers: { id: string; name: string }[];
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

export default function ApplyPaymentPanel({ customers, onClose, onSaved }: ApplyPaymentPanelProps) {
  const [file,    setFile]    = useState<File | null>(null);
  const [parsed,  setParsed]  = useState<ParsePaymentResponse | null>(null);
  const [customerId, setCustomerId] = useState<string>('');
  const [skip,    setSkip]    = useState<Set<number>>(new Set());
  const [busy,    setBusy]    = useState(false);
  const [phase,   setPhase]   = useState<'idle' | 'reading' | 'applying'>('idle');
  const [err,     setErr]     = useState<string | null>(null);
  const [done,    setDone]    = useState(0);

  // The source document, shown beside the extraction. Confirming what the
  // system read is meaningless without being able to see what it read FROM
  // — otherwise "review" is just assent.
  const [hoverRow, setHoverRow] = useState<number | null>(null);

  // Derived, not stored: setting state synchronously inside an effect causes
  // the cascading re-render React 19 warns about. The URL is computed from
  // the file, and the effect exists only to revoke it.
  const docUrl = useMemo(() => {
    if (!file) return null;
    const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
    return isPdf ? URL.createObjectURL(file) : null;
  }, [file]);
  useEffect(() => {
    if (!docUrl) return;
    return () => URL.revokeObjectURL(docUrl);
  }, [docUrl]);

  // Text has to be read asynchronously, so it must be state — but it is
  // stored WITH the file it came from, so a slow read for a replaced file
  // can never paint under the new one.
  const [textFor, setTextFor] = useState<{ file: File; text: string } | null>(null);
  useEffect(() => {
    if (!file || docUrl) return;          // PDFs render from the object URL
    let alive = true;
    void file.text().then(t => { if (alive) setTextFor({ file, text: t }); });
    return () => { alive = false; };
  }, [file, docUrl]);
  const docText = textFor && textFor.file === file ? textFor.text : null;

  const run = useCallback(async (f: File, forCustomer: string | null) => {
    setBusy(true); setPhase('reading'); setErr(null);
    try {
      const res = await railway.parsePaymentDocument({
        filename: f.name,
        mimeType: f.type || 'application/octet-stream',
        dataBase64: await toBase64(f),
        ...(forCustomer ? { customerId: forCustomer } : {}),
      });
      setParsed(res);
      // Prefer the customer the matched invoices point at over the printed
      // payer name — remittances are routinely sent by a factoring company
      // or under a legal entity we hold under a different name.
      if (!forCustomer && res.inferredCustomerId) setCustomerId(res.inferredCustomerId);
      // Default to applying everything that matched; unmatched rows can't be.
      setSkip(new Set(res.lines.filter(l => !l.invoiceId).map(l => l.rowIndex)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not read that document');
      setParsed(null);
    } finally {
      setBusy(false); setPhase('idle');
    }
  }, []);

  // Memoized: `parsed?.lines ?? []` allocates a fresh array every render,
  // which would invalidate every downstream useMemo on each pass.
  const lines    = useMemo(() => parsed?.lines ?? [], [parsed]);
  const included = useMemo(
    () => lines.filter(l => l.invoiceId && !skip.has(l.rowIndex)),
    [lines, skip],
  );
  const includedTotal = useMemo(
    () => Math.round(included.reduce((s, l) => s + l.amount, 0) * 100) / 100,
    [included],
  );

  const totalsFailed = parsed?.totals ? !parsed.totals.ok : false;
  const canApply = !!parsed?.isRemittance && !totalsFailed && included.length > 0 && !busy;

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
    <>
      <div className="fixed inset-0" style={{ zIndex: 60, background: 'rgba(0,0,0,.35)' }}
           onClick={busy ? undefined : onClose} />
      {/* Widens once there's a document to show. Starting wide would put a
          large empty pane in front of someone who hasn't uploaded yet. */}
      <aside className="fixed top-0 right-0 h-full flex flex-col" style={{
        zIndex: 61, width: file ? 'min(1180px, 100vw)' : 620, maxWidth: '100vw',
        transition: 'width .18s ease',
        background: 'var(--gc-surface)', borderLeft: '1px solid var(--gc-border)',
        boxShadow: '0 0 32px rgba(0,0,0,.18)',
      }}>
        {/* header */}
        <div className="shrink-0 px-5 pt-4 pb-3 flex items-start justify-between gap-3"
             style={{ borderBottom: '1px solid var(--gc-border)' }}>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
              Apply a payment
            </div>
            <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--gc-text-3)' }}>
              {parsed?.doc
                ? `${parsed.doc.payerNameAsPrinted || 'Unknown payer'} · ${parsed.doc.paymentDate} · ${money2(parsed.doc.paymentTotal)}`
                : 'Upload a remittance and confirm what it pays'}
            </div>
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
               style={{ flex: '1 1 52%', borderRight: '1px solid var(--gc-border)' }}>
            <div className="shrink-0 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide"
                 style={{ color: 'var(--gc-text-3)', borderBottom: '1px solid var(--gc-border-light)' }}>
              What the document says
            </div>
            <DocumentPane
              text={docText} url={docUrl} filename={file.name}
              hoverRow={hoverRow} onHoverRow={setHoverRow}
            />
          </div>
        )}

        {/* ── right: what we read out of it ── */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4" style={{ flex: '1 1 48%' }}>
          {/* ── upload ── */}
          <SectionLabel>Document</SectionLabel>
          <label className="flex items-center gap-2.5 rounded-lg border px-3 py-2.5 mb-3 cursor-pointer"
                 style={{ borderColor: 'var(--gc-border)', borderStyle: file ? 'solid' : 'dashed' }}>
            {file ? <FileText size={15} style={{ color: '#1a73e8' }} />
                  : <Upload size={15} style={{ color: 'var(--gc-text-3)' }} />}
            <span className="flex-1 min-w-0 text-xs truncate"
                  style={{ color: file ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}>
              {file ? file.name : 'Choose a PDF, CSV, or text file…'}
            </span>
            <input type="file" accept=".pdf,.csv,.txt,.eml,application/pdf,text/csv,text/plain"
                   className="hidden" disabled={busy}
                   onChange={e => {
                     const f = e.target.files?.[0] ?? null;
                     setFile(f); setParsed(null); setErr(null);
                     if (f) void run(f, customerId || null);
                   }} />
          </label>

          <Field label="Customer">
            <select value={customerId} disabled={busy} style={inputStyle}
                    onChange={e => {
                      const v = e.target.value;
                      setCustomerId(v);
                      // Re-read scoped to the customer: narrowing the search
                      // resolves references that are ambiguous org-wide.
                      if (file) void run(file, v || null);
                    }}>
              <option value="">Let the document decide</option>
              {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>

          {busy && phase === 'reading' && (
            <div className="flex items-center gap-2 text-xs mt-3" style={{ color: 'var(--gc-text-3)' }}>
              <Loader2 size={13} className="animate-spin" /> Reading the document…
            </div>
          )}

          {err && (
            <div className="rounded-lg border p-3 my-3 text-xs"
                 style={{ borderColor: '#ef4444', background: '#fef2f2', color: '#991b1b' }}>
              {err}
            </div>
          )}

          {/* ── not a remittance ── */}
          {parsed && !parsed.isRemittance && (
            <div className="rounded-lg border p-3 mt-3 text-xs flex gap-2"
                 style={{ borderColor: '#f59e0b', background: '#fffbeb', color: '#92400e' }}>
              <HelpCircle size={14} className="shrink-0 mt-px" />
              <span>
                <strong>This doesn&apos;t look like a remittance.</strong>
                <span className="block mt-1">{parsed.reason}</span>
              </span>
            </div>
          )}

          {/* ── totals invariant ── */}
          {parsed?.totals && (
            <div className="rounded-lg border p-3 mt-3 text-xs flex gap-2"
                 style={parsed.totals.ok
                   ? { borderColor: 'var(--gc-border)', color: 'var(--gc-text-2)' }
                   : { borderColor: '#ef4444', background: '#fef2f2', color: '#991b1b' }}>
              {parsed.totals.ok
                ? <Check size={14} className="shrink-0 mt-px" style={{ color: '#188038' }} />
                : <AlertTriangle size={14} className="shrink-0 mt-px" />}
              <span>
                {parsed.totals.ok ? (
                  <>The {lines.length} rows add up to the {money2(parsed.totals.declared)} printed on the document.</>
                ) : (
                  <>
                    <strong>Rows don&apos;t match the document total.</strong>
                    <span className="block mt-1">
                      Rows add to {money2(parsed.totals.lineSum)} but the document says{' '}
                      {money2(parsed.totals.declared)} — a difference of {money2(Math.abs(parsed.totals.drift))}.
                      A row was probably misread, so this can&apos;t be applied as-is.
                    </span>
                  </>
                )}
              </span>
            </div>
          )}

          {/* ── matched lines ── */}
          {parsed?.isRemittance && lines.length > 0 && (
            <>
              <div style={{ height: 14 }} />
              <SectionLabel>
                What this pays · {parsed.summary?.matched ?? 0} of {lines.length} matched
              </SectionLabel>
              <div className="rounded-lg border overflow-hidden mb-2" style={{ borderColor: 'var(--gc-border)' }}>
                {lines.map(l => (
                  <LineRow key={l.rowIndex} line={l}
                           included={!!l.invoiceId && !skip.has(l.rowIndex)}
                           disabled={busy || !l.invoiceId}
                           hovered={hoverRow === l.rowIndex}
                           onHover={setHoverRow}
                           onToggle={() => setSkip(s => {
                             const n = new Set(s);
                             if (n.has(l.rowIndex)) n.delete(l.rowIndex);
                             else n.add(l.rowIndex);
                             return n;
                           })} />
                ))}
              </div>
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
                 style={{ borderColor: '#f59e0b', background: '#fffbeb', color: '#92400e' }}>
              {parsed.doc.unparsedRows.length} row(s) couldn&apos;t be read and were skipped.
            </div>
          ) : null}
        </div>
        </div>

        {/* footer */}
        <div className="shrink-0 px-5 py-3 flex items-center justify-end gap-2"
             style={{ borderTop: '1px solid var(--gc-border)' }}>
          {busy && phase === 'applying' && (
            <span className="text-[11px] mr-auto" style={{ color: 'var(--gc-text-3)' }}>
              {done} of {included.length} recorded…
            </span>
          )}
          <button onClick={onClose} disabled={busy}
                  className="text-xs font-semibold px-3 py-1.5 rounded border"
                  style={{ borderColor: 'var(--gc-border)', color: 'var(--gc-text-2)' }}>
            Cancel
          </button>
          <button onClick={() => void handleApply()} disabled={!canApply}
                  className="text-xs font-semibold px-3 py-1.5 rounded inline-flex items-center gap-1.5"
                  style={{
                    background: canApply ? '#1a73e8' : 'var(--gc-border)',
                    color: canApply ? '#fff' : 'var(--gc-text-3)',
                    cursor: canApply ? 'pointer' : 'default',
                  }}>
            {busy && phase === 'applying' && <Loader2 size={12} className="animate-spin" />}
            {included.length
              ? <>Apply to {included.length} invoice{included.length === 1 ? '' : 's'} · {money2(includedTotal)}</>
              : 'Apply'}
          </button>
        </div>
      </aside>
    </>
  );
}

// ── bits ──────────────────────────────────────────────────────────────

/** The source document rendered as-is. PDFs go to the browser's own viewer;
 *  CSVs become a table so rows line up with the extracted lines beside them.
 *  Display only — nothing here feeds the matcher. */
function DocumentPane({ text, url, filename, hoverRow, onHoverRow }: {
  text: string | null; url: string | null; filename: string;
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

  if (url) {
    return <iframe src={url} title={filename} className="flex-1 min-h-0 w-full" style={{ border: 0 }} />;
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
                    style={{ background: lit ? 'var(--gc-blue-bg, #e8f0fe)' : 'transparent' }}>
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

function LineRow({ line, included, disabled, onToggle, hovered, onHover }: {
  line: ParsedPaymentLine; included: boolean; disabled: boolean; onToggle: () => void;
  hovered: boolean; onHover: (r: number | null) => void;
}) {
  const matched = !!line.invoiceId;
  return (
    <div className="flex items-center gap-2 px-2.5 py-2"
         onMouseEnter={() => onHover(line.rowIndex)}
         onMouseLeave={() => onHover(null)}
         style={{
           borderBottom: '1px solid var(--gc-border-light)',
           background: hovered ? 'var(--gc-blue-bg, #e8f0fe)'
                     : included ? 'var(--gc-blue-bg, #e8f0fe)' : 'transparent',
           boxShadow: hovered ? 'inset 2px 0 0 #1a73e8' : undefined,
           opacity: matched ? 1 : 0.72,
         }}>
      <input type="checkbox" checked={included} disabled={disabled} onChange={onToggle} />

      <span className="flex-1 min-w-0">
        <span className="block text-xs font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
          {matched ? (
            <>
              <span style={{ color: '#1967d2' }}>#{line.invoiceNumber}</span>
              {line.loadNum ? <span style={{ color: 'var(--gc-text-3)' }}> · Load {line.loadNum}</span> : null}
            </>
          ) : (
            <span style={{ color: '#b45309' }}>No match</span>
          )}
        </span>
        {/* The printed reference, verbatim — so the reviewer can eyeball it
            against the document rather than trusting a normalized form. */}
        <span className="block text-[11px] truncate" style={{ color: 'var(--gc-text-3)' }}>
          {line.referenceAsPrinted
            ? <>ref <code>{line.referenceAsPrinted}</code></>
            : 'no reference printed'}
          {matched && line.invoiceTotal != null && Math.abs(line.invoiceTotal - line.amount) > 0.005
            ? <> · invoice {money2(line.invoiceTotal)}
                {line.deductionLabel ? ` · ${line.deductionLabel}` : ' · short-paid'}</>
            : null}
          {!matched && line.ambiguous?.length ? ` · ${line.ambiguous.length} possible invoices` : null}
        </span>
      </span>

      <span className="text-xs tabular-nums shrink-0" style={{ color: 'var(--gc-text-1)', fontWeight: 600 }}>
        {money2(line.amount)}
      </span>
      <ConfidenceChip line={line} />
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
    line.matchedBy === 'ambiguous'        ? 'ambiguous' :
    line.matchedBy === 'processor_ref'    ? 'processor' : '—';
  const strong = line.confidence >= 90;
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{
      background: !line.invoiceId ? 'transparent' : strong ? '#e6f4ea' : '#fef7e0',
      color:      !line.invoiceId ? 'var(--gc-text-3)' : strong ? '#188038' : '#b45309',
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-wide mb-1.5"
         style={{ color: 'var(--gc-text-3)' }}>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block mb-2">
      <span className="block text-[11px] mb-1" style={{ color: 'var(--gc-text-3)' }}>{label}</span>
      {children}
    </label>
  );
}
