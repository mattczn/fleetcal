'use client';

/**
 * Two-pane "manage docs" modal — used from accounting (the original
 * site) and the per-load detail page. Left pane lists every doc
 * attached to the load (rate con pinned at the top, supporting docs
 * below) with include-in-packet checkboxes; right pane previews the
 * selected doc. Save persists per-doc include flips via PATCH
 * /v1/documents/:id/invoice-include and either calls back with the
 * new included set or just closes when no callback is wired.
 *
 * Lifted out of `apps/web/app/accounting/page.tsx` so the load detail
 * page renders the exact same widget — any visual or behavioral change
 * here lands in both surfaces without drift.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, AlertCircle, Eye, X, Check } from 'lucide-react';
import Tooltip from '@/components/ui/Tooltip';
import { railway } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';

/** Doc kinds that the server's resolveDefaultPacketDocs considers when
 *  no explicit included_in_invoice is set on a load_documents row. */
const PACKET_KINDS: readonly string[] = ['pod', 'bol', 'lumper', 'scale', 'receipt', 'driver_sheet'];

const KIND_LABEL: Record<string, string> = {
  rate_con: 'Rate Con', pod: 'POD', bol: 'BOL', lumper: 'Lumper',
  scale: 'Scale', receipt: 'Receipt', driver_sheet: 'Driver Sheet',
  invoice: 'Invoice', other: 'Other',
};

const KIND_TINT: Record<string, { bg: string; fg: string }> = {
  rate_con: { bg: '#f5f3ff', fg: '#7c3aed' },
  pod:      { bg: '#dcfce7', fg: '#166534' },
  bol:      { bg: '#fef3c7', fg: '#854d0e' },
  lumper:   { bg: '#fce7f3', fg: '#9f1239' },
  scale:    { bg: '#dbeafe', fg: '#1e40af' },
  receipt:  { bg: '#fee2e2', fg: '#991b1b' },
  driver_sheet: { bg: '#fed7aa', fg: '#9a3412' },
  other:    { bg: 'var(--gc-bg)', fg: 'var(--gc-text-3)' },
};

const RATE_CON_ACTIVE_ID = '__rate_con__';

/**
 * Minimal load shape this modal needs — duck-typed so any caller can
 * pass either a full LoadSummary or a Load object without converting.
 */
export interface LoadDocsPreviewModalLoad {
  loadId: string;
  loadNum?: string;
  rateConPdf?: string | null;
}

export function LoadDocsPreviewModal({ load, onClose, onSaved }: {
  load: LoadDocsPreviewModalLoad;
  onClose: () => void;
  /** Fired after Save selection persists. Receives the new included-doc
   *  IDs so the parent can patch the row in place (no table-wide refresh).
   *  When omitted, save just calls onClose (legacy behaviour). */
  onSaved?: (nextIncludedIds: string[]) => void;
}) {
  type LoadDoc = import('@fleetcal/types').DocumentSummary;
  const [docs, setDocs]               = useState<LoadDoc[] | null>(null);
  const [error, setError]             = useState<string | null>(null);
  // Active = the doc the user is currently viewing. Special sentinel
  // RATE_CON_ACTIVE_ID means "show the rate con" since rate cons
  // aren't always backed by a load_documents row.
  const [activeId, setActiveId]       = useState<string | null>(null);
  const [activeUrl, setActiveUrl]     = useState<string | null>(null);
  const [urlLoading, setUrlLoading]   = useState(false);
  const [urlError, setUrlError]       = useState<string | null>(null);
  // Per-doc pending toggles — only the docs the user actually flipped.
  // Lets Save target exactly those rows via per-doc PATCH instead of
  // re-stamping the whole load (which would lose the NULL=heuristic
  // distinction for untouched docs).
  const [pendingChanges, setPendingChanges] = useState<Record<string, boolean>>({});
  const [saving, setSaving]           = useState(false);
  const [saveError, setSaveError]     = useState<string | null>(null);

  const hasRateCon = !!load.rateConPdf;

  useEffect(() => {
    let cancelled = false;
    void import('@/lib/db').then(({ fetchLoadDocuments }) =>
      fetchLoadDocuments(load.loadId, '').then(d => {
        if (!cancelled) setDocs(d);
      }).catch(err => {
        if (!cancelled) setError((err as Error)?.message ?? 'fetch failed');
      }),
    );
    return () => { cancelled = true; };
  }, [load.loadId]);

  // Derived effective include state.
  //   1. Pending toggle wins (the user just clicked it).
  //   2. Else d.includedInInvoice when not null (server-stored choice).
  //   3. Else newest-per-kind heuristic among PACKET_KINDS — same
  //      rule the server's resolveDefaultPacketDocs runs.
  const heuristicIncluded: Set<string> = useMemo(() => {
    if (!docs) return new Set();
    const byKind = new Map<string, LoadDoc>();
    const sorted = [...docs].sort((a, b) =>
      (b.uploadedAt ?? '').localeCompare(a.uploadedAt ?? ''),
    );
    for (const d of sorted) {
      if (PACKET_KINDS.includes(d.kind) && !byKind.has(d.kind)) {
        byKind.set(d.kind, d);
      }
    }
    return new Set(Array.from(byKind.values()).map(d => d.id));
  }, [docs]);
  const effectiveInclude = (d: LoadDoc): boolean => {
    if (Object.prototype.hasOwnProperty.call(pendingChanges, d.id)) {
      return pendingChanges[d.id];
    }
    if (d.includedInInvoice === true)  return true;
    if (d.includedInInvoice === false) return false;
    return heuristicIncluded.has(d.id);
  };
  const included: Set<string> = useMemo(() => {
    const s = new Set<string>();
    for (const d of (docs ?? [])) if (effectiveInclude(d)) s.add(d.id);
    return s;
    // effectiveInclude reads pendingChanges + heuristicIncluded via
    // closure; both are listed inputs to the derivation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs, pendingChanges, heuristicIncluded]);

  // Default the viewer to the rate con (or the first uploaded doc).
  useEffect(() => {
    if (activeId || !docs) return;
    if (hasRateCon) setActiveId(RATE_CON_ACTIVE_ID);
    else if (docs.length > 0) setActiveId(docs[0].id);
  }, [docs, hasRateCon, activeId]);

  // Resolve signed URL for whatever's active. Rate con goes through
  // a separate endpoint (loads.rate_con_pdf may live in legacy form);
  // regular docs use the per-doc signer.
  useEffect(() => {
    if (!activeId) { setActiveUrl(null); return; }
    let cancelled = false;
    setUrlLoading(true);
    setUrlError(null);
    setActiveUrl(null);
    const run = async () => {
      try {
        if (activeId === RATE_CON_ACTIVE_ID) {
          const { url } = await railway.getRateConUrl(load.loadId);
          if (!cancelled) setActiveUrl(url);
        } else {
          const { getLoadDocumentSignedUrl } = await import('@/lib/db');
          const url = await getLoadDocumentSignedUrl(activeId);
          if (!cancelled) setActiveUrl(url ?? null);
        }
      } catch (err) {
        if (!cancelled) setUrlError((err as Error)?.message ?? 'load failed');
      } finally {
        if (!cancelled) setUrlLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [activeId, load.loadId]);

  // Per-doc PATCH for every flipped row. Skip when nothing pending
  // so an accidental click-Save click doesn't write no-ops.
  async function handleSave() {
    const entries = Object.entries(pendingChanges);
    if (entries.length === 0 || saving) { onClose(); return; }
    setSaving(true);
    setSaveError(null);
    try {
      useCalendarStore.getState().markLoadSelfWrite(load.loadId);
      await Promise.all(entries.map(([id, val]) =>
        railway.updateDocumentInvoiceInclude(id, val)
      ));
      // Snapshot the final effective-include set BEFORE clearing the
      // pending overrides — parent uses this to patch the row in place.
      const nextIncludedIds = (docs ?? [])
        .filter(d => effectiveInclude(d))
        .map(d => d.id);
      // Clear local overrides so the next render reads from server.
      setPendingChanges({});
      if (onSaved) onSaved(nextIncludedIds); else onClose();
    } catch (err) {
      setSaveError((err as Error)?.message ?? 'save failed');
      setSaving(false);
    }
  }

  // Toggle drops the pending entry when the new value matches the
  // doc's persisted (or heuristic) value — so a flip-back doesn't
  // leave a no-op in the dirty bucket and force a redundant save.
  const toggle = (id: string) => {
    if (!docs) return;
    const doc = docs.find(d => d.id === id);
    if (!doc) return;
    const persisted: boolean = doc.includedInInvoice === true  ? true
                              : doc.includedInInvoice === false ? false
                              : heuristicIncluded.has(id);
    const nextVal = !included.has(id);
    setPendingChanges(prev => {
      const copy = { ...prev };
      if (persisted === nextVal) delete copy[id];
      else                       copy[id] = nextVal;
      return copy;
    });
  };
  const dirtyCount = Object.keys(pendingChanges).length;

  const tintFor = (k: string) => KIND_TINT[k] ?? KIND_TINT.other;
  const nonRateConDocs = (docs ?? []).filter(d => d.kind !== 'rate_con');
  const includedSupportingCount = included
    ? nonRateConDocs.filter(d => included.has(d.id)).length
    : 0;
  const totalAttached = (hasRateCon ? 1 : 0) + includedSupportingCount;

  // Render the active doc — `<img>` for image MIME types, `<iframe>`
  // otherwise (PDFs render natively in every modern browser; for
  // anything else the iframe falls back to the browser's default
  // viewer or the download prompt).
  function renderViewer() {
    if (!activeId) {
      return (
        <div className="flex items-center justify-center h-full text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
          Pick a doc on the left to preview.
        </div>
      );
    }
    if (urlLoading) {
      return (
        <div className="flex items-center justify-center h-full text-[13px] gap-2" style={{ color: 'var(--gc-text-3)' }}>
          <Loader2 size={14} className="animate-spin" /> Loading preview…
        </div>
      );
    }
    if (urlError || !activeUrl) {
      return (
        <div className="flex items-center justify-center h-full text-[13px]" style={{ color: '#991b1b' }}>
          {urlError ?? "Couldn't load preview."}
        </div>
      );
    }
    const activeDoc = nonRateConDocs.find(d => d.id === activeId);
    const isImage =
      activeId !== RATE_CON_ACTIVE_ID &&
      activeDoc?.mimeType?.startsWith('image/');
    if (isImage) {
      return (
        <div className="w-full h-full flex items-center justify-center" style={{ background: 'var(--gc-bg)' }}>
          <img src={activeUrl} alt={activeDoc?.fileName ?? 'doc'}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        </div>
      );
    }
    return (
      <iframe
        src={activeUrl}
        title={activeId === RATE_CON_ACTIVE_ID ? 'Rate confirmation' : activeDoc?.fileName ?? 'doc'}
        style={{ width: '100%', height: '100%', border: 'none', background: 'var(--gc-bg)' }}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rounded-2xl overflow-hidden flex flex-col"
        style={{ width: 1100, maxWidth: '96vw', height: '88vh', background: 'var(--gc-surface)', boxShadow: '0 16px 40px rgba(0,0,0,0.25)' }}
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-4 flex items-center gap-3 shrink-0" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <Eye size={16} style={{ color: '#1a73e8' }} />
          <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>
            Invoice packet
            {load.loadNum && <span className="ml-1" style={{ color: 'var(--gc-text-3)' }}>· #{load.loadNum}</span>}
          </div>
          <span className="text-[11px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ml-1"
            style={{ background: '#dbeafe', color: '#1e40af' }}>
            {totalAttached} attached
          </span>
          <button onClick={onClose} className="ml-auto p-1.5 rounded-lg hover:bg-[var(--gc-hover)]">
            <X size={14} />
          </button>
        </div>

        {/* Two-pane body */}
        <div className="flex-1 flex min-h-0">
          {/* Left: doc list + checkboxes */}
          <div className="shrink-0 flex flex-col" style={{ width: 320, borderRight: '1px solid var(--gc-border-light)' }}>
            <div className="flex-1 overflow-y-auto px-3 py-3">
              {!docs && !error && (
                <div className="text-[12.5px] flex items-center gap-2" style={{ color: 'var(--gc-text-3)' }}>
                  <Loader2 size={13} className="animate-spin" /> Loading docs…
                </div>
              )}
              {error && (
                <div className="text-[12px] flex items-start gap-2 px-2 py-2 rounded-lg"
                  style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
                  <AlertCircle size={12} style={{ marginTop: 1 }} /> {error}
                </div>
              )}
              {docs && !error && (
                <ul className="space-y-1">
                  {hasRateCon && (() => {
                    const tint = tintFor('rate_con');
                    const active = activeId === RATE_CON_ACTIVE_ID;
                    return (
                      <li>
                        <button type="button" onClick={() => setActiveId(RATE_CON_ACTIVE_ID)}
                          className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left transition-colors"
                          style={{
                            background: active ? 'rgba(26,115,232,0.10)' : 'transparent',
                            border: active ? '1px solid var(--gc-blue)' : '1px solid transparent',
                          }}>
                          {/* Rate con isn't user-toggleable — always
                              auto-included via loads.rate_con_pdf.
                              Use a non-interactive checkmark so the
                              row visually balances with the doc rows
                              below. */}
                          <span className="flex items-center justify-center shrink-0"
                            style={{ width: 14, height: 14, borderRadius: 3, background: '#86efac', color: '#166534' }}
                            title="Rate con is always attached">
                            <Check size={10} />
                          </span>
                          <span className="text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                            style={{ background: tint.bg, color: tint.fg }}>
                            Rate Con
                          </span>
                          <span className="flex-1 truncate text-[12.5px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                            Rate confirmation
                          </span>
                        </button>
                      </li>
                    );
                  })()}
                  {nonRateConDocs.map(d => {
                    const tint = tintFor(d.kind);
                    const isIncluded = included.has(d.id);
                    const active = activeId === d.id;
                    return (
                      <li key={d.id}>
                        <div className="flex items-center gap-2 px-2 py-2 rounded-lg transition-colors"
                          style={{
                            background: active ? 'rgba(26,115,232,0.10)' : 'transparent',
                            border: active ? '1px solid var(--gc-blue)' : '1px solid transparent',
                          }}>
                          <Tooltip
                            content={
                              isIncluded ? (
                                <>
                                  <strong>Included in the invoice packet.</strong> This PDF will be bundled into the packet sent to the customer when the invoice is generated. Uncheck to <strong>skip</strong>.
                                </>
                              ) : (
                                <>
                                  <strong>Not included in the invoice packet.</strong> This PDF will <strong>not</strong> be bundled into the packet sent to the customer. Check to <strong>include</strong>.
                                </>
                              )
                            }>
                            <input type="checkbox" checked={isIncluded}
                              onChange={() => toggle(d.id)}
                              disabled={!docs}
                              style={{ width: 14, height: 14, accentColor: 'var(--gc-blue)', cursor: 'pointer' }}
                              onClick={e => e.stopPropagation()} />
                          </Tooltip>
                          <button type="button" onClick={() => setActiveId(d.id)}
                            className="flex-1 flex items-center gap-2 min-w-0 text-left">
                            <span className="text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                              style={{ background: tint.bg, color: tint.fg }}>
                              {KIND_LABEL[d.kind] ?? d.kind}
                            </span>
                            <span className="flex-1 truncate text-[12.5px]"
                              style={{ color: isIncluded ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}
                              title={d.fileName}>
                              {d.fileName}
                            </span>
                          </button>
                        </div>
                      </li>
                    );
                  })}
                  {!hasRateCon && nonRateConDocs.length === 0 && (
                    <li className="text-[12.5px] italic px-2 py-3" style={{ color: 'var(--gc-text-3)' }}>
                      No docs on this load yet.
                    </li>
                  )}
                </ul>
              )}
            </div>
            {/* Warnings — same gaps the original peek modal surfaced. */}
            {(!hasRateCon || (docs && includedSupportingCount === 0)) && (
              <div className="px-3 py-2 text-[11.5px] shrink-0"
                style={{ background: '#fff7ed', color: '#9a3412', borderTop: '1px solid #fed7aa' }}>
                {!hasRateCon
                  ? 'No rate confirmation on file.'
                  : 'No supporting docs selected — customers usually expect at least a POD.'}
              </div>
            )}
          </div>

          {/* Right: viewer */}
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            {renderViewer()}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 flex items-center gap-2 shrink-0"
          style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
          {saveError && (
            <div className="text-[11.5px] flex items-center gap-1.5" style={{ color: '#991b1b' }}>
              <AlertCircle size={11} /> {saveError}
            </div>
          )}
          <div className="flex-1" />
          <button onClick={onClose} disabled={saving}
            className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
            style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}>
            Cancel
          </button>
          <button onClick={() => void handleSave()} disabled={saving || dirtyCount === 0}
            className="text-[12px] font-semibold px-4 py-1.5 rounded-lg disabled:opacity-60"
            style={{ background: '#1a73e8', color: '#fff' }}
            title={dirtyCount === 0 ? 'Nothing to save' : `Save ${dirtyCount} change${dirtyCount === 1 ? '' : 's'}`}>
            {saving ? <Loader2 size={12} className="animate-spin inline mr-1.5" /> : null}
            {saving
              ? 'Saving…'
              : dirtyCount === 0
                ? 'Save selection'
                : `Save ${dirtyCount} change${dirtyCount === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
