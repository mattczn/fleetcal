'use client';

/**
 * Closeout review queue — full-screen, single-load focused mode for
 * blasting through PODs in 24h.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  Load summary · age · close                                  │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │  📌 Internal notes (sticky if any)                          │
 *   ├───────────────────────────┬──────────────────────────────────┤
 *   │                           │  Verification ✔                  │
 *   │   Rate Con PDF            │  Include in invoice ☑           │
 *   │   (selectable text)       │                                  │
 *   │                           │  [Release]  [Flag]  [Skip]       │
 *   ├───────────────────────────┤                                  │
 *   │   Uploaded docs           │                                  │
 *   │   (tabs + PDF canvas)     │                                  │
 *   └───────────────────────────┴──────────────────────────────────┘
 *
 * Keyboard:
 *   R / Enter  — release for invoicing
 *   F          — flag (opens FlagModal)
 *   →          — skip / next
 *   ←          — previous
 *   Esc        — close
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useUser } from '@clerk/nextjs';
import { X, ChevronLeft, ChevronRight, CheckCircle2, Flag, FileText, AlertCircle, Pin, Clock, FastForward } from 'lucide-react';
import type { Load, CalendarEvent } from '@/lib/types';
import type { LoadDocument } from '@/lib/db';
import { fetchLoadDocuments, getLoadDocumentSignedUrl } from '@/lib/db';
import { railway } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';
import { displayBrokerName } from '@/lib/customerMatch';
import PdfCanvas from '@/components/pdf/PdfCanvas';
import { FlagModal, type FlagReason } from './FlagModal';

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

interface Props {
  loads: CalendarEvent[];      // pre-deduped queue
  startIndex?: number;
  onClose: () => void;
  /** Called after each successful release/flag with the affected load id
   *  so the parent (CloseoutView) can drop it from the queue locally. */
  onLoadResolved?: (loadId: string, action: 'verified' | 'flagged') => void;
}

const KIND_TINT: Record<string, { bg: string; fg: string }> = {
  bol:   { bg: '#e8f0fe', fg: '#1558d6' },
  pod:   { bg: '#dcfce7', fg: '#15803d' },
  scale: { bg: '#fff7ed', fg: '#9a3412' },
  other: { bg: '#f1f3f4', fg: '#3c4043' },
};

function ageDays(iso: string): number {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86_400_000);
}

export default function ReviewQueue({ loads, startIndex = 0, onClose, onLoadResolved }: Props) {
  const customers = useCalendarStore(s => s.customers);
  const { user } = useUser();
  const [idx, setIdx] = useState(startIndex);
  const [showFlag, setShowFlag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resolved, setResolved] = useState<Set<string>>(new Set());

  // Bound idx whenever the queue changes underneath us.
  const safeIdx = Math.min(Math.max(idx, 0), Math.max(loads.length - 1, 0));
  const current = loads[safeIdx];

  const next = () => setIdx(i => Math.min(i + 1, loads.length - 1));
  const prev = () => setIdx(i => Math.max(i - 1, 0));

  // ── Documents for the current load ────────────────────────────────
  const [docs, setDocs] = useState<LoadDocument[]>([]);
  const [activeDocIdx, setActiveDocIdx] = useState(0);
  const [activeDocUrl, setActiveDocUrl] = useState<string | null>(null);
  const [docsLoading, setDocsLoading] = useState(false);
  // Invoice doc selection: defaults to PODs uploaded on/after delivery
  const [includedDocIds, setIncludedDocIds] = useState<Set<string>>(new Set());

  const loadId = current?.loadId ?? current?.id;
  const orgId  = useCalendarStore(s => s.orgId);

  // Fetch docs whenever the active load changes
  useEffect(() => {
    if (!loadId || !orgId) { setDocs([]); setIncludedDocIds(new Set()); return; }
    let cancelled = false;
    setDocsLoading(true);
    fetchLoadDocuments(loadId, orgId).then(d => {
      if (cancelled) return;
      setDocs(d);
      setActiveDocIdx(0);
      // Default included = any doc with kind=pod uploaded on/after delivery
      const deliveredAt = current?.end ? new Date(current.end).getTime() : 0;
      const presetFromDb = (current as Load).invoiceDocIds ?? [];
      const ids = new Set<string>(presetFromDb.length > 0
        ? presetFromDb
        : d.filter(x => x.kind === 'pod' && new Date(x.uploadedAt).getTime() >= deliveredAt - 86_400_000).map(x => x.id),
      );
      setIncludedDocIds(ids);
    }).finally(() => { if (!cancelled) setDocsLoading(false); });
    return () => { cancelled = true; };
  }, [loadId, orgId, current]);

  // Resolve the currently selected doc to a fresh signed URL
  useEffect(() => {
    if (docs.length === 0) { setActiveDocUrl(null); return; }
    const d = docs[Math.min(activeDocIdx, docs.length - 1)];
    if (!d) { setActiveDocUrl(null); return; }
    let cancelled = false;
    setActiveDocUrl(null);
    void getLoadDocumentSignedUrl(d.id).then(url => {
      if (!cancelled) setActiveDocUrl(url);
    });
    return () => { cancelled = true; };
  }, [docs, activeDocIdx]);

  // Rate con signed URL
  const [rateConUrl, setRateConUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!loadId || !current?.rateConPdf) { setRateConUrl(null); return; }
    let cancelled = false;
    setRateConUrl(null);
    railway.getRateConUrl(loadId).then(({ url }) => {
      if (!cancelled) setRateConUrl(url);
    }).catch(() => { if (!cancelled) setRateConUrl(null); });
    return () => { cancelled = true; };
  }, [loadId, current?.rateConPdf]);

  // ── Verification checklist ────────────────────────────────────────
  const isTonu = current?.status === 'tonu';
  const hasPod = useMemo(() => docs.some(d => d.kind === 'pod'), [docs]);
  const hasBol = useMemo(() => docs.some(d => d.kind === 'bol'), [docs]);
  const accCategories = (current?.accessorials ?? []).map(a => a.category);
  const needsLumper = accCategories.includes('lumper');
  const hasLumper   = useMemo(() => docs.some(d => /lumper/i.test(d.fileName)), [docs]);
  const needsScale  = accCategories.includes('scale_ticket');
  const hasScale    = useMemo(() => docs.some(d => d.kind === 'scale'), [docs]);

  const checklist = [
    { id: 'pod',    label: 'POD uploaded',     pass: isTonu || hasPod,     skip: isTonu },
    { id: 'bol',    label: 'BOL uploaded',     pass: hasBol,               skip: false },
    { id: 'lumper', label: 'Lumper receipt',   pass: !needsLumper || hasLumper, skip: !needsLumper },
    { id: 'scale',  label: 'Scale ticket',     pass: !needsScale || hasScale,    skip: !needsScale },
  ];
  const requiredPass = checklist.filter(c => !c.skip).every(c => c.pass);

  // ── Actions ───────────────────────────────────────────────────────
  async function persistInvoiceDocs() {
    if (!current) return;
    const targetId = (current as Load).loadId ?? current.id;
    await railway.updateLoadCloseout(targetId, {
      action: 'set_invoice_docs',
      invoiceDocIds: Array.from(includedDocIds),
    });
  }

  async function handleRelease() {
    if (!current || busy) return;
    // Required-doc gate runs inside the click handler — putting it in
    // the button's `disabled` prop fires the confirm() on every render.
    if (!requiredPass) {
      const ok = window.confirm('Required docs are missing for this load. Release anyway?');
      if (!ok) return;
    }
    setBusy(true);
    try {
      const targetId = (current as Load).loadId ?? current.id;
      const actorName = user?.fullName ?? user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? undefined;
      await persistInvoiceDocs();
      await railway.updateLoadCloseout(targetId, { action: 'verify', actorName });
      setResolved(prev => new Set(prev).add(targetId));
      onLoadResolved?.(targetId, 'verified');
      // Auto-advance
      if (idx >= loads.length - 1) onClose();
      else next();
    } catch (err) {
      alert(`Release failed: ${(err as Error).message ?? 'Unknown error'}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleFlag(reason: FlagReason, note: string) {
    if (!current || busy) return;
    setBusy(true);
    try {
      const targetId = (current as Load).loadId ?? current.id;
      const actorName = user?.fullName ?? user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? undefined;
      await railway.updateLoadCloseout(targetId, { action: 'flag', flagReason: reason, flagNote: note, actorName });
      setResolved(prev => new Set(prev).add(targetId));
      onLoadResolved?.(targetId, 'flagged');
      setShowFlag(false);
      if (idx >= loads.length - 1) onClose();
      else next();
    } catch (err) {
      alert(`Flag failed: ${(err as Error).message ?? 'Unknown error'}`);
    } finally {
      setBusy(false);
    }
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────
  const releaseRef = useRef(handleRelease);
  releaseRef.current = handleRelease;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showFlag) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape')      { onClose(); }
      else if (e.key === 'ArrowRight' || e.key === 'j') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft'  || e.key === 'k') { e.preventDefault(); prev(); }
      else if (e.key === 'r' || e.key === 'R' || e.key === 'Enter') { e.preventDefault(); void releaseRef.current(); }
      else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); setShowFlag(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showFlag, onClose]);

  // ── Render ────────────────────────────────────────────────────────
  if (!current) {
    return (
      <Shell onClose={onClose}>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center" style={{ color: 'var(--gc-text-3)' }}>
            <CheckCircle2 size={32} className="mx-auto mb-2" style={{ color: '#15803d' }} />
            <div className="text-base font-semibold" style={{ color: 'var(--gc-text-1)' }}>Queue cleared</div>
            <div className="text-sm">Nothing left to review.</div>
          </div>
        </div>
      </Shell>
    );
  }

  const days = ageDays(current.end);
  const ageColor =
    days <= 1 ? { bg: '#dcfce7', fg: '#15803d' } :
    days <= 3 ? { bg: '#fef3c7', fg: '#92400e' } :
    days <= 7 ? { bg: '#fed7aa', fg: '#9a3412' } :
                { bg: '#fee2e2', fg: '#991b1b' };

  const cust = displayBrokerName(current.broker, customers);
  const stops = current.stops ?? [];
  const route = stops.length > 0
    ? `${stops[0]?.city ?? '—'} → ${stops[stops.length - 1]?.city ?? '—'}`
    : null;

  return (
    <>
      <Shell onClose={onClose}>
        {/* Top bar */}
        <div className="shrink-0 flex items-center gap-3 px-5 py-3"
          style={{ borderBottom: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)' }}>
          <span className="text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--gc-text-3)' }}>
            {safeIdx + 1} of {loads.length}
          </span>
          <span style={{ background: ageColor.bg, color: ageColor.fg, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
            {days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`}
          </span>
          <div className="flex flex-col flex-1 min-w-0">
            <div className="text-base font-extrabold truncate" style={{ color: 'var(--gc-text-1)' }}>
              {current.title}
            </div>
            <div className="text-xs flex items-center gap-3" style={{ color: 'var(--gc-text-3)' }}>
              {cust && <span>{cust}</span>}
              {route && <span>{route}</span>}
              {current.loadNum && <span>#{current.loadNum}</span>}
              {current.loadPrice != null && <span>{moneyFmt.format(current.loadPrice)}</span>}
              {current.driverName && <span>{current.driverName}</span>}
              {current.assetName && <span>{current.assetName}</span>}
            </div>
          </div>
          <button onClick={prev} disabled={safeIdx === 0}
            className="p-2 rounded-full transition-colors disabled:opacity-30"
            title="Previous (←)"
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <ChevronLeft size={18} />
          </button>
          <button onClick={next} disabled={safeIdx >= loads.length - 1}
            className="p-2 rounded-full transition-colors disabled:opacity-30"
            title="Next (→)"
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <ChevronRight size={18} />
          </button>
          <button onClick={onClose}
            className="p-2 rounded-full transition-colors"
            title="Close (Esc)"
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <X size={18} />
          </button>
        </div>

        {/* Internal notes sticky banner */}
        {(current.internalNotes ?? []).length > 0 && (
          <div className="shrink-0 px-5 py-2.5"
            style={{ background: '#fef9c3', borderBottom: '1px solid #fde68a' }}>
            <div className="flex items-start gap-2">
              <Pin size={13} style={{ color: '#a16207', marginTop: 3 }} />
              <div className="flex-1 min-w-0">
                {(current.internalNotes ?? []).map(n => (
                  <div key={n.id} className="text-[13px]" style={{ color: '#78350f', whiteSpace: 'pre-wrap' }}>
                    {n.text}
                    <span className="text-[11px] ml-2" style={{ color: '#a16207' }}>
                      — {n.author ?? 'Unknown'}, {new Date(n.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Main: rate-con + uploaded docs (left) + sidebar (right) */}
        <div className="flex-1 flex min-h-0">
          {/* Left/middle: PDFs */}
          <div className="flex-1 flex min-h-0">
            {/* Rate Con */}
            <div className="flex-1 flex flex-col min-w-0 border-r" style={{ borderColor: 'var(--gc-border-light)' }}>
              <div className="shrink-0 flex items-center justify-between px-3 py-2"
                style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border-light)' }}>
                <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
                  Rate Con
                </span>
                {!current.rateConPdf && <span className="text-xs" style={{ color: '#dc2626' }}>Not attached</span>}
              </div>
              {current.rateConPdf
                ? <PdfCanvas dataUrl={rateConUrl ?? ''} onRetry={() => loadId && railway.getRateConUrl(loadId).then(({ url }) => setRateConUrl(url))} />
                : <NoDocPanel label="No rate-con uploaded for this load." />}
            </div>

            {/* Uploaded docs */}
            <div className="flex-1 flex flex-col min-w-0">
              <div className="shrink-0 flex items-center gap-1 px-3 py-2 overflow-x-auto"
                style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border-light)' }}>
                <span className="text-[11px] font-bold uppercase tracking-wider mr-2 shrink-0" style={{ color: 'var(--gc-text-3)' }}>
                  Uploaded
                </span>
                {docs.length === 0 && (
                  <span className="text-xs" style={{ color: 'var(--gc-text-3)' }}>
                    {docsLoading ? 'Loading…' : 'No documents uploaded'}
                  </span>
                )}
                {docs.map((d, i) => {
                  const tint = KIND_TINT[d.kind] ?? KIND_TINT.other;
                  const active = i === activeDocIdx;
                  return (
                    <button key={d.id} onClick={() => setActiveDocIdx(i)}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold whitespace-nowrap transition-colors shrink-0"
                      style={{
                        background: active ? tint.bg : 'transparent',
                        color: active ? tint.fg : 'var(--gc-text-3)',
                        border: `1px solid ${active ? tint.fg + '50' : 'var(--gc-border-light)'}`,
                      }}>
                      <FileText size={10} /> {d.kind.toUpperCase()} · {d.fileName.replace(/\.[^.]+$/, '').slice(0, 18)}
                    </button>
                  );
                })}
              </div>
              {docs.length > 0
                ? <PdfCanvas dataUrl={activeDocUrl ?? ''} />
                : <NoDocPanel label="No documents uploaded yet for this load." />}
            </div>
          </div>

          {/* Right: actions sidebar */}
          <div className="shrink-0 flex flex-col" style={{ width: 300, borderLeft: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)' }}>
            {/* Verification checklist */}
            <div className="px-4 py-4" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
              <div className="text-[11px] font-bold uppercase tracking-wider mb-2.5" style={{ color: 'var(--gc-text-3)' }}>
                Verification
              </div>
              {isTonu && (
                <div className="text-[11px] mb-2 px-2 py-1 rounded" style={{ background: '#dbeafe', color: '#1e40af', border: '1px solid #bfdbfe' }}>
                  TONU — POD not required
                </div>
              )}
              <div className="space-y-1.5">
                {checklist.map(c => (
                  <div key={c.id} className="flex items-center gap-2 text-[13px]"
                    style={{ color: c.skip ? 'var(--gc-text-3)' : c.pass ? 'var(--gc-text-1)' : '#dc2626', opacity: c.skip ? 0.6 : 1 }}>
                    {c.skip
                      ? <Clock      size={13} style={{ color: 'var(--gc-text-3)' }} />
                      : c.pass
                        ? <CheckCircle2 size={13} style={{ color: '#15803d' }} />
                        : <AlertCircle size={13} style={{ color: '#dc2626' }} />}
                    <span>{c.label}</span>
                    {c.skip && <span className="text-[10px]" style={{ color: 'var(--gc-text-3)' }}>(n/a)</span>}
                  </div>
                ))}
              </div>
            </div>

            {/* Invoice doc selection */}
            <div className="px-4 py-4 flex-1 overflow-y-auto" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
              <div className="text-[11px] font-bold uppercase tracking-wider mb-2.5" style={{ color: 'var(--gc-text-3)' }}>
                Include in invoice
              </div>
              {docs.length === 0 ? (
                <div className="text-xs" style={{ color: 'var(--gc-text-3)' }}>
                  Nothing to include yet.
                </div>
              ) : (
                <div className="space-y-1">
                  {docs.map(d => {
                    const checked = includedDocIds.has(d.id);
                    return (
                      <label key={d.id} className="flex items-start gap-2 cursor-pointer rounded px-1 py-1 transition-colors hover:bg-[var(--gc-hover)]">
                        <input type="checkbox" checked={checked} className="mt-0.5"
                          onChange={() => {
                            setIncludedDocIds(prev => {
                              const next = new Set(prev);
                              if (next.has(d.id)) next.delete(d.id); else next.add(d.id);
                              return next;
                            });
                          }} />
                        <div className="flex-1 min-w-0">
                          <div className="text-[12px] font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
                            {d.kind.toUpperCase()}
                          </div>
                          <div className="text-[11px] truncate" style={{ color: 'var(--gc-text-3)' }}>
                            {d.fileName}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Action buttons */}
            <div className="shrink-0 px-4 py-4 space-y-2" style={{ background: 'var(--gc-bg)' }}>
              <button onClick={() => void handleRelease()} disabled={busy}
                className="w-full flex items-center justify-center gap-2 rounded-full text-sm font-bold transition-colors disabled:opacity-50"
                style={{ background: '#15803d', color: '#fff', padding: '10px 14px' }}
                title={requiredPass ? 'Release for invoicing' : 'Required docs missing — confirm before releasing'}>
                <CheckCircle2 size={15} /> Release for invoicing
                <span className="text-[10px] font-mono opacity-70 ml-1">R</span>
              </button>
              <button onClick={() => setShowFlag(true)} disabled={busy}
                className="w-full flex items-center justify-center gap-2 rounded-full text-sm font-bold transition-colors disabled:opacity-50"
                style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a', padding: '10px 14px' }}>
                <Flag size={15} /> Flag for follow-up
                <span className="text-[10px] font-mono opacity-70 ml-1">F</span>
              </button>
              <button onClick={next} disabled={busy || safeIdx >= loads.length - 1}
                className="w-full flex items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors disabled:opacity-50"
                style={{ background: 'transparent', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)', padding: '10px 14px' }}>
                <FastForward size={14} /> Skip
                <span className="text-[10px] font-mono opacity-70 ml-1">→</span>
              </button>
              {resolved.has((current as Load).loadId ?? current.id) && (
                <div className="text-[11px] text-center pt-1" style={{ color: '#15803d' }}>
                  ✓ Resolved — moving on
                </div>
              )}
            </div>
          </div>
        </div>
      </Shell>

      {showFlag && (
        <FlagModal
          loadLabel={`${current.title}${current.loadNum ? ` · #${current.loadNum}` : ''}`}
          onCancel={() => setShowFlag(false)}
          onConfirm={handleFlag}
        />
      )}
    </>
  );
}

function Shell({ children, onClose: _onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[180] flex flex-col" style={{ background: 'var(--gc-bg)' }}>
      {children}
    </div>
  );
}

function NoDocPanel({ label }: { label: string }) {
  return (
    <div className="flex-1 flex items-center justify-center" style={{ background: '#525659' }}>
      <div className="text-center" style={{ color: 'rgba(255,255,255,0.6)' }}>
        <FileText size={28} className="mx-auto mb-2" />
        <div className="text-sm">{label}</div>
      </div>
    </div>
  );
}
