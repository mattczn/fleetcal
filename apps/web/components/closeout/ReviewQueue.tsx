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
import { X, ChevronLeft, ChevronRight, CheckCircle2, Circle, Flag, FileText, AlertCircle, Pin, FastForward, Copy, Check, Upload, Loader2, MessageSquare, Plus, Pencil, Trash2, Layers, MapPin, Receipt, RefreshCw, Download } from 'lucide-react';
import type { Load, CalendarEvent, Stop } from '@/lib/types';
import type { LoadDocument } from '@/lib/db';
import { fetchLoadDocuments, getLoadDocumentSignedUrl } from '@/lib/db';
import { railway } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';
import { parseNaiveIsoInTz } from '@/lib/time-utils';
import { displayBrokerName } from '@/lib/customerMatch';
import PdfCanvas from '@/components/pdf/PdfCanvas';
import DocViewer from './DocViewer';
import { FlagModal, type FlagReason } from './FlagModal';
import InternalNotesModal from './InternalNotesModal';
import ConfirmDialog from '@/components/ui/ConfirmDialog';

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

interface Props {
  loads: CalendarEvent[];      // pre-deduped queue
  startIndex?: number;
  onClose: () => void;
  /** Called after each successful release/flag with the affected load id
   *  so the parent (CloseoutView) can drop it from the queue locally. */
  onLoadResolved?: (loadId: string, action: 'verified' | 'flagged') => void;
  /** Open the full event modal for this load. Implemented by the parent
   *  so it can use its smart pickup-leg resolver. The parent should also
   *  dismiss the review queue when this fires (the modals don't stack —
   *  EventModal sits at a lower z-index). */
  onOpenLoadModal?: (load: CalendarEvent) => void;
  /** Override the modal's z-index. Defaults to 180 (closeout page).
   *  Pass a higher value (e.g. 250) when launched from inside the
   *  EventModal (z-200) so the review queue stacks on top. */
  zIndex?: number;
}

// Color tokens per document kind. Pulled from the same Google Material
// Design palette EventModal's STATUSES uses (and the existing --gc-blue
// css vars) so the doc UI feels consistent with the rest of the app
// instead of like a different design system bolted on. Pairs of
// foreground / lighter background — saturated enough to read at a
// glance, pale background so multi-chip rows stay readable.
// Solid saturated background + white text — mirrors how Google
// Calendar event cards render (asset color fill + white text +
// bold weights), so the closeout chrome reads as "the same product"
// instead of a tinted variant.
const KIND_TINT: Record<string, { bg: string; fg: string }> = {
  rate_con:     { bg: '#5b21b6', fg: '#fff' },  // Indigo
  pod:          { bg: '#188038', fg: '#fff' },  // Google green
  bol:          { bg: '#1a73e8', fg: '#fff' },  // Google blue
  scale:        { bg: '#e37400', fg: '#fff' },  // Google orange
  lumper:       { bg: '#a16207', fg: '#fff' },  // Amber, darkened for white-text contrast
  receipt:      { bg: '#c2185b', fg: '#fff' },  // Pink
  driver_sheet: { bg: '#00838f', fg: '#fff' },  // Teal
  invoice:      { bg: '#7b1fa2', fg: '#fff' },  // Purple
  other:        { bg: '#5f6368', fg: '#fff' },  // Graphite gray
};

// Display label per kind. snake_case → "Title Case" for the docs UI.
const KIND_LABEL: Record<string, string> = {
  rate_con:     'Rate Con',
  pod:          'POD',
  bol:          'BOL',
  scale:        'Scale',
  lumper:       'Lumper',
  receipt:      'Receipt',
  driver_sheet: 'Driver Sheet',
  invoice:      'Invoice',
  other:        'Other',
};

// Display labels for accessorial categories — used by the banner in
// the review panel so dispatchers see the human-readable name instead
// of the snake_case enum value.
const ACCESSORIAL_LABEL: Record<string, string> = {
  detention:    'Detention',
  lumper:       'Lumper',
  layover:      'Layover',
  scale_ticket: 'Scale ticket',
  extra_stop:   'Extra stop',
  other:        'Other',
};

// Upload-chip order in the "Add paperwork" panel — most-frequent first
// so dispatchers hit common buttons by muscle memory. Rate Con goes
// first since it's required for release alongside POD.
const KIND_OPTIONS: ReadonlyArray<{ kind: import('@fleetcal/types').DocumentKind; label: string; tint: { bg: string; fg: string } }> = [
  { kind: 'pod',          label: 'POD',          tint: KIND_TINT.pod },
  { kind: 'rate_con',     label: 'Rate Con',     tint: KIND_TINT.rate_con },
  { kind: 'bol',          label: 'BOL',          tint: KIND_TINT.bol },
  { kind: 'lumper',       label: 'Lumper',       tint: KIND_TINT.lumper },
  { kind: 'scale',        label: 'Scale',        tint: KIND_TINT.scale },
  { kind: 'receipt',      label: 'Receipt',      tint: KIND_TINT.receipt },
  { kind: 'driver_sheet', label: 'Driver Sheet', tint: KIND_TINT.driver_sheet },
  { kind: 'invoice',      label: 'Invoice',      tint: KIND_TINT.invoice },
  { kind: 'other',        label: 'Other',        tint: KIND_TINT.other },
];

function ageDays(iso: string): number {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86_400_000);
}

export default function ReviewQueue({ loads, startIndex = 0, onClose, onLoadResolved, onOpenLoadModal, zIndex = 180 }: Props) {
  const customers = useCalendarStore(s => s.customers);
  // Used to look up the delivery partner of a relay so the meta line
  // can show the actual delivery date, not the pickup-leg's end (which
  // is the relay handoff time).
  const allEvents = useCalendarStore(s => s.events);
  // True when the load detail (EventModal) is open over us. We pause
  // our keyboard shortcuts and the backdrop-click-to-close while it's
  // up so EscClose / arrow keys / clicks belong to the modal on top,
  // not the review queue underneath.
  const eventModalOpen = useCalendarStore(s => s.modalOpen);
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
  // Active draft invoice for the current load, if any. Drives whether
  // the action button says "Generate invoice" or "Regenerate invoice".
  // Loaded on load-change via listInvoices; refreshed locally after
  // generate / regenerate so the UI flips state without a refetch.
  const [activeInvoice, setActiveInvoice] = useState<import('@fleetcal/types').Invoice | null>(null);
  const [invoiceBusy,   setInvoiceBusy]   = useState(false);
  const [invoiceError,  setInvoiceError]  = useState<string | null>(null);

  const loadId = current?.loadId ?? current?.id;
  const orgId  = useCalendarStore(s => s.orgId);
  const tz     = useCalendarStore(s => s.calendarTimezone);

  // Per-load assets cache — docs list + signed URL for every doc +
  // rate-con URL. Populated up-front for current/next/prev so prev/next
  // navigation renders instantly without a network round-trip per
  // signed URL. Rate-con and doc URLs all expire in ~1h, well past a
  // typical review session.
  const [rateConUrl, setRateConUrl] = useState<string | null>(null);
  // Selected rate-con for the left-panel viewer.
  //   null                    → show the canonical rate con (rateConUrl)
  //   RATE_CON_PRIMARY_ID     → same as null (the canonical), but with an
  //                             explicit selection highlight in the list
  //   other id                → a secondary rate-con load_document; left
  //                             viewer reads its URL via secondaryRateConUrl
  const [activeRateConId, setActiveRateConId]       = useState<string | null>(null);
  const [secondaryRateConUrl, setSecondaryRateConUrl] = useState<string | null>(null);
  interface LoadAssets {
    docs:        LoadDocument[];
    urlByDocId:  Map<string, string>;
    rateConUrl:  string | null;
    fetchedAt:   number;
  }
  const docsCacheRef = useRef<Map<string, LoadAssets>>(new Map());

  // Prefetch (or no-op if already cached) all assets for one load:
  // docs list + every doc's signed URL + rate-con URL, all in
  // parallel.
  const prefetchLoadAssets = async (
    targetLoadId: string | undefined,
    rateConPresent: boolean,
  ) => {
    if (!targetLoadId || !orgId) return;
    if (docsCacheRef.current.has(targetLoadId)) return;
    try {
      const [docList, rcUrl] = await Promise.all([
        fetchLoadDocuments(targetLoadId, orgId),
        rateConPresent
          ? railway.getRateConUrl(targetLoadId).then(r => r.url).catch(() => null)
          : Promise.resolve(null),
      ]);
      const urlByDocId = new Map<string, string>();
      // Fan out signed-URL fetches in parallel — typically 0–4 docs.
      await Promise.all(docList.map(async d => {
        const u = await getLoadDocumentSignedUrl(d.id);
        if (u) urlByDocId.set(d.id, u);
      }));
      docsCacheRef.current.set(targetLoadId, {
        docs:       docList,
        urlByDocId,
        rateConUrl: rcUrl,
        fetchedAt:  Date.now(),
      });
    } catch (err) {
      console.error('[review queue] prefetch failed for load', targetLoadId, err);
    }
  };

  // On idx change: render current load's assets from cache (instant if
  // already prefetched, fall through to fetch+render otherwise), and
  // kick off background prefetches for next + prev so they're ready
  // when the user advances.
  useEffect(() => {
    if (!loadId || !orgId) {
      setDocs([]);
      setActiveDocUrl(null);
      setRateConUrl(null);
      setSecondaryRateConUrl(null);
      setActiveRateConId(null);
      setIncludedDocIds(new Set());
      return;
    }

    let cancelled = false;
    const applyAssets = (assets: LoadAssets) => {
      setDocs(assets.docs);
      setActiveDocIdx(0);
      setRateConUrl(assets.rateConUrl);
      // Reset the secondary rate-con selection — the canonical is the
      // default until the user picks a different one from the right
      // sidebar's Rate Confirmations list.
      setSecondaryRateConUrl(null);
      setActiveRateConId(null);
      // Default invoice selection — same heuristic as before: prior
      // saved selection wins, else PODs near delivery time.
      // current.end is naive ISO in the org's dispatch zone; interpret
      // accordingly so the "POD uploaded near delivery" auto-select
      // window stays accurate regardless of dispatcher's browser tz.
      const deliveredAt = current?.end ? parseNaiveIsoInTz(current.end, tz) : 0;
      const presetFromDb = (current as Load).invoiceDocIds ?? [];
      const ids = new Set<string>(presetFromDb.length > 0
        ? presetFromDb
        : assets.docs
            .filter(x => x.kind === 'pod' && new Date(x.uploadedAt).getTime() >= deliveredAt - 86_400_000)
            .map(x => x.id),
      );
      setIncludedDocIds(ids);
    };

    const cached = docsCacheRef.current.get(loadId);
    if (cached) {
      // Cache hit → instant paint. No spinner.
      applyAssets(cached);
      setDocsLoading(false);
    } else {
      setDocsLoading(true);
      void prefetchLoadAssets(loadId, !!current?.rateConPdf).then(() => {
        if (cancelled) return;
        const fresh = docsCacheRef.current.get(loadId);
        if (fresh) applyAssets(fresh);
        setDocsLoading(false);
      });
    }

    // Always kick off neighbor prefetches in the background.
    const nxt = loads[safeIdx + 1];
    const prv = loads[safeIdx - 1];
    if (nxt) void prefetchLoadAssets(nxt.loadId ?? nxt.id, !!nxt.rateConPdf);
    if (prv) void prefetchLoadAssets(prv.loadId ?? prv.id, !!prv.rateConPdf);

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadId, orgId, safeIdx]);

  // Fetch the load's active invoice (draft / sent / paid — anything not
  // void) on load-change. Drives the Generate vs Regenerate toggle in
  // the "Include in invoice" panel. A failure here is non-fatal — the
  // panel falls back to showing "Generate invoice" so the user can at
  // least attempt creation; a 409 from the API will surface the real
  // state if there's a conflict.
  useEffect(() => {
    if (!loadId || !orgId) { setActiveInvoice(null); setInvoiceError(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await railway.listInvoices({ loadId });
        if (cancelled) return;
        // Most-recent non-void invoice wins. Multiple drafts shouldn't
        // exist (unique partial index) but if they somehow do, take the
        // newest.
        const active = (res.invoices ?? [])
          .filter(inv => inv.status !== 'void')
          .sort((a, b) => (b.issuedAt ?? '').localeCompare(a.issuedAt ?? ''))[0] ?? null;
        setActiveInvoice(active);
        setInvoiceError(null);
      } catch (err) {
        if (!cancelled) {
          console.warn('[review queue] listInvoices failed:', err);
          setActiveInvoice(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [loadId, orgId]);

  // Resolve the currently selected doc to its signed URL — preferring
  // the cached one. Falls back to a per-doc fetch only if the cache
  // doesn't have it (e.g., a freshly uploaded doc whose URL hasn't
  // been prefetched yet).
  //
  // Indexes into nonRateConDocs (defined below — but it's a simple
  // derived list, so the temporal dead zone is fine inside an effect
  // that fires on render). Rate cons are handled by the left-panel
  // viewer via selectRateCon, not the middle viewer.
  useEffect(() => {
    const list = docs.filter(d => d.kind !== 'rate_con');
    if (list.length === 0) { setActiveDocUrl(null); return; }
    const d = list[Math.min(activeDocIdx, list.length - 1)];
    if (!d) { setActiveDocUrl(null); return; }
    const cached = loadId ? docsCacheRef.current.get(loadId) : undefined;
    const cachedUrl = cached?.urlByDocId.get(d.id);
    if (cachedUrl) {
      setActiveDocUrl(cachedUrl);
      return;
    }
    let cancelled = false;
    setActiveDocUrl(null);
    void getLoadDocumentSignedUrl(d.id).then(url => {
      if (cancelled || !url) return;
      setActiveDocUrl(url);
      // Backfill the cache so subsequent tab clicks / revisits are
      // instant too.
      if (loadId) {
        const entry = docsCacheRef.current.get(loadId);
        if (entry) entry.urlByDocId.set(d.id, url);
      }
    });
    return () => { cancelled = true; };
  }, [docs, activeDocIdx, loadId]);

  // ── Verification checklist ────────────────────────────────────────
  // Required for release: Rate Con + POD. Lumper / Scale are
  // conditionally required when the load carries the matching
  // accessorial (brokers only pay those when the supporting doc is
  // present). Everything else (BOL, Receipt, Driver Sheet, Invoice,
  // Other) is freely uploadable but doesn't block closeout.
  const isTonu = current?.status === 'tonu';
  const hasPod     = useMemo(() => docs.some(d => d.kind === 'pod'), [docs]);
  const hasRateCon = useMemo(
    () => !!current?.rateConPdf || docs.some(d => d.kind === 'rate_con'),
    [docs, current?.rateConPdf],
  );
  const accCategories = (current?.accessorials ?? []).map(a => a.category);
  const needsLumper = accCategories.includes('lumper');
  const hasLumper   = useMemo(() => docs.some(d => d.kind === 'lumper'), [docs]);
  const needsScale  = accCategories.includes('scale_ticket');
  const hasScale    = useMemo(() => docs.some(d => d.kind === 'scale'), [docs]);

  const checklist = [
    { id: 'rate_con', label: 'Rate confirmation', pass: hasRateCon,                 skip: false },
    { id: 'pod',      label: 'POD uploaded',       pass: isTonu || hasPod,           skip: isTonu },
    { id: 'lumper',   label: 'Lumper receipt',     pass: !needsLumper || hasLumper,  skip: !needsLumper },
    { id: 'scale',    label: 'Scale ticket',       pass: !needsScale || hasScale,    skip: !needsScale },
  ];
  const requiredPass = checklist.filter(c => !c.skip).every(c => c.pass);

  // ── Actions ───────────────────────────────────────────────────────
  async function persistInvoiceDocs() {
    if (!current) return;
    const targetId = (current as Load).loadId ?? current.id;
    // markLoadSelfWrite suppresses the realtime echo from popping the
    // "updated by another dispatcher" banner on the dispatcher who
    // just made the change. Stamping the same loadId we're about to
    // write to is sufficient — markLoadSelfWrite finds every cached
    // event sharing that loadId (both relay legs included).
    useCalendarStore.getState().markLoadSelfWrite(targetId);
    await railway.updateLoadCloseout(targetId, {
      action: 'set_invoice_docs',
      invoiceDocIds: Array.from(includedDocIds),
    });
  }

  /**
   * Generate or regenerate the invoice for the current load. Persists
   * the include-in-invoice doc selection first so the snapshot picks up
   * whatever the dispatcher checked, then either:
   *   - calls POST /v1/invoices (fresh) when no active invoice exists, or
   *   - calls POST /v1/invoices/:id/regenerate (atomic void + new) when
   *     an existing draft is present.
   *
   * Sent / paid invoices block regeneration server-side; UI also gates
   * the button text to "Generate" vs "Regenerate" so dispatchers see
   * the right verb based on state.
   */
  async function handleGenerateOrRegenerate() {
    if (!current || invoiceBusy) return;
    const targetLoadId = (current as Load).loadId ?? current.id;
    setInvoiceBusy(true);
    setInvoiceError(null);
    try {
      // Save the doc selection before snapshot — the server only sees
      // what's currently persisted on the load.
      await persistInvoiceDocs();

      let result: import('@fleetcal/types').CreateInvoiceResponse;
      if (activeInvoice && activeInvoice.status === 'draft') {
        result = await railway.regenerateInvoice(activeInvoice.id);
      } else if (activeInvoice && activeInvoice.status !== 'draft') {
        // Server would 409 — fail fast with a clearer message.
        setInvoiceError(`Cannot regenerate a ${activeInvoice.status} invoice. Void it first if you need to replace it.`);
        return;
      } else {
        result = await railway.createInvoice({ loadId: targetLoadId });
      }
      setActiveInvoice(result.invoice);
    } catch (err) {
      const msg = (err as Error).message ?? 'Unknown error';
      console.error('[review queue] invoice generate/regenerate failed:', err);
      setInvoiceError(msg);
    } finally {
      setInvoiceBusy(false);
    }
  }

  async function handleRelease() {
    if (!current || busy) return;
    // Idempotency guard — once a load is released, clicking again
    // (or hitting the R hotkey) should be a no-op rather than
    // re-stamping verified_at and bumping the audit trail. The
    // accounting workflow takes over from here.
    if (current.billingStatus === 'verified'
      || current.billingStatus === 'invoiced'
      || current.billingStatus === 'paid') {
      return;
    }
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
      // Re-stamp because persistInvoiceDocs above already consumed
      // the 5-second window; the verify call also fires a realtime
      // echo and needs its own suppression.
      useCalendarStore.getState().markLoadSelfWrite(targetId);
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
      useCalendarStore.getState().markLoadSelfWrite(targetId);
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

  // ── Internal notes ────────────────────────────────────────────────
  // Opens an InternalNotesModal on top of the review queue. We pause
  // the queue's keyboard handler while it's open so Esc / arrows /
  // Cmd+Enter all belong to the notes composer.
  const [notesOpen, setNotesOpen] = useState(false);

  // Left panel toggle — dispatcher's choice of seeing the rate-con
  // (default) vs the load's stops list. Stops view is useful when
  // verifying delivery against the planned route or when the rate-
  // con doesn't carry the appointment / facility detail.
  const [leftPanelView, setLeftPanelView] = useState<'rateCon' | 'stops'>('rateCon');

  // (The old horizontal POD-tab strip lived here — replaced by the
  // vertical doc-row list in the redesign. The scroll affordances and
  // chevron buttons were only there to page through a row of pill tabs
  // when many PODs existed; with vertical rows native scrolling handles
  // it. If keyboard nav between docs lands later, re-add a small
  // scroll-into-view effect targeting a data-doc-row-idx attribute.)

  // ── Inline doc rename ──────────────────────────────────────────────
  // When the user clicks Rename in the kebab menu we swap that tab
  // into an inline text input. The keyboard handler pauses while a
  // rename input has focus (covered by the existing INPUT/TEXTAREA
  // tag check).
  const [renamingDocId, setRenamingDocId]     = useState<string | null>(null);
  const [renameDraft,   setRenameDraft]       = useState('');
  const [renameSaving,  setRenameSaving]      = useState(false);

  // Confirm dialog for delete — replaces window.confirm with a styled
  // yes/no surface that fits the rest of the app.
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const startRename = (docId: string, currentName: string) => {
    setRenamingDocId(docId);
    // Drop the extension so the user types the name, not the format.
    const base = currentName.replace(/\.[^.]+$/, '');
    setRenameDraft(base);
  };
  const cancelRename = () => { setRenamingDocId(null); setRenameDraft(''); };
  const commitRename = async () => {
    if (!renamingDocId || renameSaving) return;
    const target = docs.find(d => d.id === renamingDocId);
    if (!target) { cancelRename(); return; }
    const ext = (target.fileName.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase();
    const nextName = `${renameDraft.trim()}${ext}`;
    if (!renameDraft.trim() || nextName === target.fileName) { cancelRename(); return; }
    setRenameSaving(true);
    try {
      // Document mutations bump load_documents.updated_at, which the
      // realtime channel echoes via parent-load refetch. Suppress
      // before the write so the dispatcher doing the rename doesn't
      // see "updated by another dispatcher".
      if (loadId) useCalendarStore.getState().markLoadSelfWrite(loadId);
      await railway.renameDocument(renamingDocId, nextName);
      // Optimistic update in the local docs list + the prefetch cache
      // so the new name shows up immediately and survives the next
      // load-revisit.
      setDocs(prev => prev.map(d => d.id === renamingDocId ? { ...d, fileName: nextName } : d));
      if (loadId) {
        const entry = docsCacheRef.current.get(loadId);
        if (entry) {
          docsCacheRef.current.set(loadId, {
            ...entry,
            docs: entry.docs.map(d => d.id === renamingDocId ? { ...d, fileName: nextName } : d),
          });
        }
      }
      cancelRename();
    } catch (err) {
      console.error('[review queue] rename failed:', err);
      alert(`Rename failed: ${(err as Error).message ?? 'Unknown error'}`);
    } finally {
      setRenameSaving(false);
    }
  };

  // Delete a doc — irreversible (the storage blob is removed too).
  // Confirmation is gated on the ConfirmDialog higher up; this fn
  // is only invoked after the user clicks "Delete" there.
  // Updates the local docs list, the prefetch cache, the active tab
  // index (so the viewer doesn't try to render a stale id), and the
  // includedDocIds set.
  const handleDeleteDoc = async (docId: string) => {
    if (!loadId) return;
    try {
      // Suppress the realtime echo from popping the conflict banner
      // on the dispatcher who just deleted.
      useCalendarStore.getState().markLoadSelfWrite(loadId);
      await railway.deleteDocument(docId);
      const removedIdx = docs.findIndex(d => d.id === docId);
      const nextDocs   = docs.filter(d => d.id !== docId);
      setDocs(nextDocs);
      // Cache stays in sync so leaving + returning to this load
      // doesn't bring the doc back from a stale snapshot.
      const entry = docsCacheRef.current.get(loadId);
      if (entry) {
        docsCacheRef.current.set(loadId, { ...entry, docs: nextDocs });
      }
      // If we just removed the active doc (or one before it), pull
      // activeDocIdx back so the viewer points at something valid.
      if (removedIdx !== -1 && removedIdx <= activeDocIdx) {
        setActiveDocIdx(Math.max(0, Math.min(activeDocIdx - 1, nextDocs.length - 1)));
      }
      // Drop from invoice-included set if it was checked.
      setIncludedDocIds(prev => {
        if (!prev.has(docId)) return prev;
        const next = new Set(prev);
        next.delete(docId);
        return next;
      });
    } catch (err) {
      console.error('[review queue] delete failed:', err);
      alert(`Delete failed: ${(err as Error).message ?? 'Unknown error'}`);
    }
  };

  // Change a doc's kind. The API may auto-rename the display fileName
  // (it uses the same {LOAD_NUM}_{KIND}{_N}.{ext} convention as upload),
  // so we read back the new fileName off the response and apply both
  // kind + fileName to the local docs list AND the prefetch cache.
  // Optimistic update keeps the dialog responsive without a full
  // refetch round-trip.
  const handleChangeKind = async (docId: string, newKind: import('@fleetcal/types').DocumentKind) => {
    if (!loadId) return;
    try {
      useCalendarStore.getState().markLoadSelfWrite(loadId);
      const res = await railway.updateDocumentKind(docId, newKind);
      const nextFileName = res.fileName;
      setDocs(prev => prev.map(d => d.id === docId
        ? { ...d, kind: newKind, ...(nextFileName ? { fileName: nextFileName } : {}) }
        : d
      ));
      const entry = docsCacheRef.current.get(loadId);
      if (entry) {
        docsCacheRef.current.set(loadId, {
          ...entry,
          docs: entry.docs.map(d => d.id === docId
            ? { ...d, kind: newKind, ...(nextFileName ? { fileName: nextFileName } : {}) }
            : d
          ),
        });
      }
    } catch (err) {
      console.error('[review queue] change kind failed:', err);
      alert(`Change kind failed: ${(err as Error).message ?? 'Unknown error'}`);
    }
  };

  // ── Upload paperwork ──────────────────────────────────────────────
  // Two-stage flow: file picker (multi-select allowed) → kind picker.
  // Multiple files get merged into a single PDF locally via pdfMerge
  // before upload so the broker invoice packet stays as one PDF per
  // doc kind. Pending list lives here so the user can re-order /
  // remove / change kind without re-picking files.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploading, setUploading]       = useState(false);
  const [uploadError, setUploadError]   = useState<string | null>(null);
  const [mergeStatus, setMergeStatus]   = useState<string | null>(null);

  // Merge selected docs into a single PDF — kept separate from the
  // "include in invoice" checkboxes so the two workflows don't fight
  // each other. The merge button (in the invoice section) opens a
  // dedicated dialog with its own selection list; the merge result is
  // appended to the docs list as a new entry. Originals stay — the
  // user can delete them after if they want to, but losing them
  // implicitly would be too aggressive.
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeSelection,  setMergeSelection]  = useState<Set<string>>(new Set());
  const [merging,         setMerging]         = useState(false);

  // Convert non-PDF docs into PDF copies. Driver phone uploads often
  // land as JPEG/HEIC; brokers usually want PDF for invoice packets,
  // so let the user batch-convert what they have. Originals stay; a
  // new PDF doc with the same kind is added per source.
  const [convertDialogOpen, setConvertDialogOpen] = useState(false);
  const [convertSelection,  setConvertSelection]  = useState<Set<string>>(new Set());
  const [converting,        setConverting]        = useState(false);
  const isPdfDoc = (d: LoadDocument): boolean =>
    (d.mimeType ?? '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(d.fileName);
  // Convert candidates = load_documents that aren't already PDF. The
  // virtual rate-con primary is excluded since we don't reliably know
  // its mime type without an extra fetch.
  const convertCandidates = useMemo<LoadDocument[]>(() => docs.filter(d => !isPdfDoc(d)), [docs]);
  const handleConvertSelected = async () => {
    if (!loadId || converting) return;
    const selected = convertCandidates.filter(d => convertSelection.has(d.id));
    if (selected.length === 0) return;
    setConverting(true);
    try {
      const cache = docsCacheRef.current.get(loadId);
      const { mergeFilesToPdf } = await import('@/lib/pdfMerge');
      for (const d of selected) {
        const url = cache?.urlByDocId.get(d.id) ?? await getLoadDocumentSignedUrl(d.id);
        if (!url) continue;
        const res = await fetch(url);
        if (!res.ok) continue;
        const blob = await res.blob();
        const sourceFile = new File([blob], d.fileName, { type: blob.type || 'application/octet-stream' });
        // mergeFilesToPdf with a single file wraps it as a single-page
        // PDF (image → embed; HEIC routes through heic2any first).
        const pdfBlob = await mergeFilesToPdf([sourceFile]);
        const pdfFile = new File(
          [pdfBlob],
          d.fileName.replace(/\.[^.]+$/, '') + '.pdf',
          { type: 'application/pdf' },
        );
        useCalendarStore.getState().markLoadSelfWrite(loadId);
        await railway.uploadLoadDocument(loadId, pdfFile, d.kind as import('@fleetcal/types').DocumentKind);
      }
      // Refresh: invalidate cache + re-prefetch.
      docsCacheRef.current.delete(loadId);
      await prefetchLoadAssets(loadId, !!current?.rateConPdf);
      const fresh = docsCacheRef.current.get(loadId);
      if (fresh) {
        setDocs(fresh.docs);
      }
    } catch (err) {
      console.error('[review queue] convert failed:', err);
      alert(`Conversion failed: ${(err as Error).message ?? 'Unknown error'}`);
    } finally {
      setConverting(false);
      setConvertDialogOpen(false);
      setConvertSelection(new Set());
    }
  };

  // Sentinel id for the primary rate-con (loads.rate_con_pdf). When
  // the rate con isn't represented by a kind=rate_con row in
  // load_documents — which is the case for legacy loads + the
  // first rate-con before the API mirror existed — we synthesize a
  // virtual doc entry so the user can still pick it for merging.
  const RATE_CON_PRIMARY_ID = '__rate_con_primary__';
  const mergeCandidates = useMemo<LoadDocument[]>(() => {
    const hasRateConDoc = docs.some(d => d.kind === 'rate_con');
    if (!current?.rateConPdf || hasRateConDoc) return docs;
    const virtual = {
      id:         RATE_CON_PRIMARY_ID,
      loadId:     loadId ?? null,
      fileName:   `Rate Con${current?.loadNum ? ` — #${current.loadNum}` : ''}`,
      mimeType:   undefined,
      sizeBytes:  undefined,
      kind:       'rate_con',
      uploadedAt: '',
    } as unknown as LoadDocument;
    return [virtual, ...docs];
  }, [docs, current?.rateConPdf, current?.loadNum, loadId]);

  // ── Right-sidebar section splits ───────────────────────────────────
  // Rate Confirmations and Documents render as separate sub-lists in the
  // right sidebar. Rate Confirmations includes:
  //   • every load_documents row with kind='rate_con'
  //   • PLUS a synthetic "canonical" row when loads.rate_con_pdf is set
  //     but no kind='rate_con' load_document exists (legacy + first-upload
  //     before the API mirror existed). Same sentinel id reused from
  //     mergeCandidates above so the merge dialog still picks it up.
  const rateConDocs = useMemo<LoadDocument[]>(() => {
    const fromDocs = docs.filter(d => d.kind === 'rate_con');
    if (fromDocs.length > 0) return fromDocs;
    if (!current?.rateConPdf) return [];
    const virtual = {
      id:         RATE_CON_PRIMARY_ID,
      loadId:     loadId ?? null,
      fileName:   `Rate Con${current?.loadNum ? ` — #${current.loadNum}` : ''}`,
      mimeType:   undefined,
      sizeBytes:  undefined,
      kind:       'rate_con',
      uploadedAt: '',
    } as unknown as LoadDocument;
    return [virtual];
  }, [docs, current?.rateConPdf, current?.loadNum, loadId]);
  const nonRateConDocs = useMemo<LoadDocument[]>(
    () => docs.filter(d => d.kind !== 'rate_con'),
    [docs],
  );

  // Click handler for a row in the Rate Confirmations section: swap the
  // left-panel viewer to the selected rate-con. The canonical (virtual)
  // row falls back to rateConUrl; secondary rows resolve their signed
  // URL via the existing prefetch cache, fetching fresh only if the
  // cache hasn't seen them yet.
  const selectRateCon = (doc: LoadDocument) => {
    setLeftPanelView('rateCon');
    setActiveRateConId(doc.id);
    if (doc.id === RATE_CON_PRIMARY_ID) {
      setSecondaryRateConUrl(null);
      return;
    }
    const cached = loadId ? docsCacheRef.current.get(loadId) : undefined;
    const cachedUrl = cached?.urlByDocId.get(doc.id);
    if (cachedUrl) {
      setSecondaryRateConUrl(cachedUrl);
      return;
    }
    setSecondaryRateConUrl(null);
    void getLoadDocumentSignedUrl(doc.id).then(url => {
      if (!url) return;
      setSecondaryRateConUrl(url);
      if (loadId) {
        const entry = docsCacheRef.current.get(loadId);
        if (entry) entry.urlByDocId.set(doc.id, url);
      }
    });
  };

  /**
   * Core merge — pulls bytes for a list of docs, runs them through
   * pdf-lib, uploads the result with the resolved kind. Extracted from
   * handleMergeSelected so the same engine drives:
   *   • the per-row checkbox merge (handleMergeSelected)
   *   • the "Merge by type" auto-group flow (handleMergeByType), which
   *     calls this once per kind-bucket.
   * Returns the new doc on success, or null when the source list is
   * too small. Caller is responsible for refreshing the docs list
   * after a batch of calls.
   *
   * When `forceKind` is provided it wins over the per-doc resolution
   * (used by Merge by type, which already knows the bucket's kind).
   * Otherwise the same security-first rule from before applies:
   * rate_con > invoice > driver_sheet > most-common(rest).
   */
  const mergeDocsToPdf = async (
    sources: LoadDocument[],
    forceKind?: import('@fleetcal/types').DocumentKind,
  ): Promise<{ id: string } | null> => {
    if (!loadId || sources.length < 2) return null;
    const cache = docsCacheRef.current.get(loadId);
    const files: File[] = [];
    for (const d of sources) {
      // The virtual rate-con entry has no load_documents row — its
      // signed URL comes from the rate-con cache slot or a fresh
      // getRateConUrl. Everything else routes through the regular
      // per-doc URL cache.
      let url: string | null = null;
      if (d.id === RATE_CON_PRIMARY_ID) {
        url = cache?.rateConUrl ?? (await railway.getRateConUrl(loadId).then(r => r.url).catch(() => null));
      } else {
        url = cache?.urlByDocId.get(d.id) ?? await getLoadDocumentSignedUrl(d.id);
      }
      if (!url) throw new Error(`No signed URL for ${d.fileName}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const blob = await res.blob();
      files.push(new File([blob], d.fileName, { type: blob.type || 'application/octet-stream' }));
    }
    const { mergeFilesToPdf } = await import('@/lib/pdfMerge');
    const mergedBlob = await mergeFilesToPdf(files);
    const mergedFile = new File([mergedBlob], `merged.pdf`, { type: 'application/pdf' });
    let mergedKind: import('@fleetcal/types').DocumentKind;
    if (forceKind) {
      mergedKind = forceKind;
    } else {
      // Determine the merged kind with a security-first rule: if ANY
      // input is dispatcher-only (rate_con / invoice / driver_sheet),
      // the merged file inherits the most-restrictive kind among the
      // inputs. Order: rate_con > invoice > driver_sheet > most-common.
      const DISPATCHER_ONLY_KINDS = new Set(['rate_con', 'invoice', 'driver_sheet']);
      const RESTRICTIVENESS: Record<string, number> = { rate_con: 3, invoice: 2, driver_sheet: 1 };
      const dispatcherKindsInSelection = sources
        .map(d => d.kind)
        .filter(k => DISPATCHER_ONLY_KINDS.has(k));
      if (dispatcherKindsInSelection.length > 0) {
        mergedKind = dispatcherKindsInSelection
          .sort((a, b) => (RESTRICTIVENESS[b] ?? 0) - (RESTRICTIVENESS[a] ?? 0))[0] as import('@fleetcal/types').DocumentKind;
      } else {
        const kindCounts = new Map<string, number>();
        for (const d of sources) kindCounts.set(d.kind, (kindCounts.get(d.kind) ?? 0) + 1);
        mergedKind = ([...kindCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? sources[0].kind) as import('@fleetcal/types').DocumentKind;
      }
    }
    useCalendarStore.getState().markLoadSelfWrite(loadId);
    const { document: newDoc } = await railway.uploadLoadDocument(loadId, mergedFile, mergedKind);
    return { id: newDoc.id };
  };

  const handleMergeSelected = async () => {
    if (!loadId || merging) return;
    const selected = mergeCandidates.filter(d => mergeSelection.has(d.id));
    if (selected.length < 2) return;
    setMerging(true);
    try {
      const result = await mergeDocsToPdf(selected);
      // Originals are NOT deleted — the merged doc is appended.
      // Refresh: invalidate cache + re-prefetch.
      docsCacheRef.current.delete(loadId);
      await prefetchLoadAssets(loadId, !!current?.rateConPdf);
      const fresh = docsCacheRef.current.get(loadId);
      if (fresh) {
        setDocs(fresh.docs);
        if (result) {
          const newIdx = fresh.docs.findIndex(d => d.id === result.id);
          if (newIdx !== -1) setActiveDocIdx(newIdx);
          // Auto-include the merged result in the invoice packet —
          // typically that's what the user wants. Originals stay in
          // their existing included/excluded state.
          setIncludedDocIds(prev => new Set([...prev, result.id]));
        }
      }
    } catch (err) {
      console.error('[review queue] merge failed:', err);
      alert(`Merge failed: ${(err as Error).message ?? 'Unknown error'}`);
    } finally {
      setMerging(false);
      setMergeDialogOpen(false);
      setMergeSelection(new Set());
    }
  };

  /**
   * Merge by type — groups every doc on the load by kind, and for each
   * kind with ≥2 docs runs the merge engine and tags the result with
   * that same kind. Originals stay; the user can delete them after if
   * they want to clean up. Runs groups sequentially to avoid hammering
   * the storage signed-URL endpoint and to give pdf-lib room to work
   * on one bucket at a time.
   *
   * Skips singletons (≥2 only) and the synthetic rate-con sentinel
   * row (it doesn't have a real source URL pattern we can re-upload
   * back into a new load_documents row safely). The user can still
   * merge rate cons via the per-row checkbox flow.
   *
   * Returns a result object so the dialog can surface a red inline
   * error chip when nothing's mergeable (instead of a blocking alert).
   * `ok: true` → at least one bucket merged; `ok: false` → the reason
   * to show next to the Merge by type button.
   */
  const handleMergeByType = async (): Promise<{ ok: boolean; error?: string }> => {
    if (!loadId || merging) return { ok: false };
    // Group all docs (incl. uploaded rate-con rows, excl. the virtual
    // canonical sentinel) by kind.
    const byKind = new Map<import('@fleetcal/types').DocumentKind, LoadDocument[]>();
    for (const d of docs) {
      if (d.id === RATE_CON_PRIMARY_ID) continue;
      const k = d.kind as import('@fleetcal/types').DocumentKind;
      const bucket = byKind.get(k) ?? [];
      bucket.push(d);
      byKind.set(k, bucket);
    }
    const mergeable = [...byKind.entries()].filter(([, list]) => list.length >= 2);
    if (mergeable.length === 0) {
      return { ok: false, error: 'No type has 2+ docs to merge.' };
    }
    setMerging(true);
    setMergeStatus(null);
    try {
      const newIds: string[] = [];
      for (const [kind, group] of mergeable) {
        setMergeStatus(`Merging ${group.length} ${KIND_LABEL[kind] ?? kind}…`);
        const res = await mergeDocsToPdf(group, kind);
        if (res) newIds.push(res.id);
      }
      // One refresh after all groups land — cheaper than refetching
      // between each bucket.
      docsCacheRef.current.delete(loadId);
      await prefetchLoadAssets(loadId, !!current?.rateConPdf);
      const fresh = docsCacheRef.current.get(loadId);
      if (fresh) {
        setDocs(fresh.docs);
        setIncludedDocIds(prev => {
          const next = new Set(prev);
          for (const id of newIds) next.add(id);
          return next;
        });
      }
      return { ok: true };
    } catch (err) {
      console.error('[review queue] merge-by-type failed:', err);
      return { ok: false, error: `Merge failed: ${(err as Error).message ?? 'unknown'}` };
    } finally {
      setMergeStatus(null);
      setMerging(false);
    }
  };

  /**
   * Per-row download — fetches the signed URL, pulls bytes, and
   * triggers a same-origin <a download> click so the browser saves
   * with the doc's fileName. <a download> doesn't honor cross-origin
   * URLs (Supabase signed URLs are cross-origin), which is why we
   * have to blob it locally first.
   */
  const handleDownloadDoc = async (id: string, fileName: string) => {
    if (!loadId) return;
    try {
      let url: string | null = null;
      const cache = docsCacheRef.current.get(loadId);
      if (id === RATE_CON_PRIMARY_ID) {
        url = cache?.rateConUrl ?? (await railway.getRateConUrl(loadId).then(r => r.url).catch(() => null));
      } else {
        url = cache?.urlByDocId.get(id) ?? await getLoadDocumentSignedUrl(id);
      }
      if (!url) throw new Error('No signed URL');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Give the click a tick to dispatch before revoking. Mobile
      // Safari occasionally cancels the download if revoke fires same
      // microtask.
      setTimeout(() => URL.revokeObjectURL(objUrl), 1500);
    } catch (err) {
      console.error('[review queue] download failed:', err);
      alert(`Download failed: ${(err as Error).message ?? 'Unknown error'}`);
    }
  };

  // Rate-con replace shortcut — separate ref so the user can swap or
  // add a new rate con without going through the multi-step "Add
  // paperwork" panel. The API mirrors the new file's storage path
  // onto loads.rate_con_pdf so the rate-con viewer always shows the
  // latest; older versions remain accessible in the docs strip
  // (kind=rate_con).
  const rateConInputRef = useRef<HTMLInputElement>(null);
  const [rateConUploading, setRateConUploading] = useState(false);
  const uploadRateCon = async (file: File) => {
    if (!loadId || rateConUploading) return;
    setRateConUploading(true);
    try {
      useCalendarStore.getState().markLoadSelfWrite(loadId);
      const { document } = await railway.uploadLoadDocument(loadId, file, 'rate_con');
      // Invalidate the cache for this load and re-fetch so:
      //   - the Rate Con viewer pulls the new signed URL
      //   - the new rate_con doc shows up in the docs strip
      docsCacheRef.current.delete(loadId);
      await prefetchLoadAssets(loadId, true);
      const fresh = docsCacheRef.current.get(loadId);
      if (fresh) {
        setDocs(fresh.docs);
        setRateConUrl(fresh.rateConUrl);
      }
      // Optimistic: also surface the new doc in the local list in case
      // the prefetch was already in flight and missed our row.
      setDocs(prev => prev.some(d => d.id === document.id) ? prev : [...prev, {
        id:         document.id,
        loadId:     document.loadId ?? loadId,
        fileName:   document.fileName,
        mimeType:   document.mimeType,
        sizeBytes:  document.sizeBytes,
        kind:       document.kind,
        uploadedAt: document.uploadedAt,
      } as LoadDocument]);
    } catch (err) {
      console.error('[review queue] rate-con upload failed:', err);
      alert(`Upload failed: ${(err as Error).message ?? 'Unknown error'}`);
    } finally {
      setRateConUploading(false);
    }
  };

  function pickFile() {
    setUploadError(null);
    fileInputRef.current?.click();
  }

  async function uploadAs(kind: import('@fleetcal/types').DocumentKind) {
    if (pendingFiles.length === 0 || !loadId || uploading) return;
    setUploading(true);
    setUploadError(null);
    setMergeStatus(null);
    try {
      // Single-file fast path: skip the merge entirely so PDF →
      // upload is byte-for-byte the original file. Multi-file path
      // funnels every input through pdfMerge so we hand the API one
      // PDF blob regardless of mix.
      let toUpload: File;
      if (pendingFiles.length === 1) {
        toUpload = pendingFiles[0];
      } else {
        const { mergeFilesToPdf } = await import('@/lib/pdfMerge');
        const mergedBlob = await mergeFilesToPdf(pendingFiles, {
          onProgress: (i, total, name) => {
            setMergeStatus(`Merging ${i + 1} of ${total}: ${name}`);
          },
        });
        // Name is cosmetic — the API rewrites to {LoadNum}_{KIND}.pdf
        // on insert, so anything sensible works here.
        toUpload = new File([mergedBlob], `merged-${kind}.pdf`, { type: 'application/pdf' });
        setMergeStatus(`Uploading…`);
      }
      useCalendarStore.getState().markLoadSelfWrite(loadId);
      const { document } = await railway.uploadLoadDocument(loadId, toUpload, kind);
      const newDoc: LoadDocument = {
        id:         document.id,
        loadId:     document.loadId ?? loadId,
        fileName:   document.fileName,
        mimeType:   document.mimeType,
        sizeBytes:  document.sizeBytes,
        kind:       document.kind,
        uploadedAt: document.uploadedAt,
      } as LoadDocument;
      // Optimistic insert into the local docs list so the new doc shows
      // up immediately in the tabs + checklist + invoice picker.
      setDocs(prev => [...prev, newDoc]);
      // Keep the cache in sync so leaving and returning to this load
      // still shows the upload — otherwise the next idx revisit would
      // overwrite docs from the stale cache entry.
      const entry = docsCacheRef.current.get(loadId);
      if (entry) {
        docsCacheRef.current.set(loadId, { ...entry, docs: [...entry.docs, newDoc] });
      }
      // PODs auto-include in the invoice packet (matches the default
      // behavior elsewhere in this view).
      if (kind === 'pod') {
        setIncludedDocIds(prev => new Set(prev).add(document.id));
      }
      // Switch the viewer to the freshly uploaded doc so the user can
      // sanity-check the right page is up.
      setActiveDocIdx(docs.length); // length pre-update == new index
      setPendingFiles([]);
      setMergeStatus(null);
    } catch (err) {
      console.error('[review queue] upload failed:', err);
      setUploadError((err as Error).message ?? 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────
  const releaseRef = useRef(handleRelease);
  releaseRef.current = handleRelease;
  useEffect(() => {
    // Don't fight the EventModal or the notes modal for the keyboard
    // when they're stacked on top — their own handlers should own Esc
    // / Cmd+Enter rather than us advancing the queue underneath.
    if (eventModalOpen || notesOpen) return;
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
  }, [showFlag, onClose, eventModalOpen, notesOpen]);

  // ── Render ────────────────────────────────────────────────────────
  if (!current) {
    return (
      <Shell onClose={onClose} blocked={eventModalOpen} zIndex={zIndex}>
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

  // Combined-stops list for the Stops view in the left panel. For
  // non-relays this is just the load's stops; for relays we append
  // the delivery-leg's stops so the panel shows the entire journey.
  const allStopsForView: typeof stops = (() => {
    const own = current.stops ?? [];
    if (current.relayRole === 'pickup' && current.relayGroupId) {
      const partner = allEvents.find(e =>
        e.id !== current.id &&
        e.relayRole === 'delivery' &&
        ((current.loadId && e.loadId === current.loadId) ||
         (current.relayGroupId && e.relayGroupId === current.relayGroupId)),
      );
      if (partner?.stops?.length) {
        return [...own, ...partner.stops];
      }
    }
    return own;
  })();

  // Pickup date = pickup leg's start. For non-relays it's also delivery
  // start; for relays we want the *actual* delivery date which lives on
  // the delivery leg's end. If we can find the partner in the calendar
  // store, use it; otherwise fall back to current.end (correct for
  // non-relays and acceptable degraded info for orphan pickup legs).
  const pickupDate = current.start;
  const deliveryPartner = (current.relayGroupId && current.relayRole === 'pickup')
    ? allEvents.find(e =>
        e.id !== current.id &&
        e.relayRole === 'delivery' &&
        ((current.loadId && e.loadId === current.loadId) ||
         (current.relayGroupId && e.relayGroupId === current.relayGroupId)),
      )
    : null;
  const deliveryDate = deliveryPartner?.end ?? current.end;

  // Driver(s) — pickup leg's driver, plus the delivery leg's driver for
  // relays when distinct. Falls back to "Unassigned" so a missing driver
  // is visible rather than the line collapsing.
  const drivers: string[] = [];
  if (current.driverName) drivers.push(current.driverName);
  if (deliveryPartner?.driverName && deliveryPartner.driverName !== current.driverName) {
    drivers.push(deliveryPartner.driverName);
  }

  return (
    <>
      <Shell onClose={onClose} blocked={eventModalOpen} zIndex={zIndex}>
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
            {onOpenLoadModal ? (
              <button type="button"
                onClick={() => onOpenLoadModal(current)}
                className="text-base font-extrabold truncate text-left hover:underline transition-colors"
                style={{ color: 'var(--gc-blue)' }}
                title="Open full load details">
                {current.title}
              </button>
            ) : (
              <div className="text-base font-extrabold truncate" style={{ color: 'var(--gc-text-1)' }}>
                {current.title}
              </div>
            )}
            <div className="text-xs flex items-center gap-3 flex-wrap" style={{ color: 'var(--gc-text-3)' }}>
              <span className="tabular-nums">
                {fmtMetaDate(pickupDate)} <span style={{ opacity: 0.6 }}>→</span> {fmtMetaDate(deliveryDate)}
              </span>
              {cust && (
                <>
                  <Sep />
                  <span className="truncate max-w-[200px]" title={cust}>{cust}</span>
                </>
              )}
              {current.loadNum && (
                <>
                  <Sep />
                  <CopyLoadNum value={current.loadNum} />
                </>
              )}
              {(current.totalBillable ?? current.loadPrice) != null && (
                <>
                  <Sep />
                  {/* Show total billable when it differs from linehaul
                      (i.e., when there's at least one billable accessorial);
                      otherwise show the bare linehaul. The full breakdown
                      lives in the load modal — this strip just answers
                      "how much does this load bill?". */}
                  <span className="tabular-nums font-semibold" style={{ color: 'var(--gc-text-2) ' }}
                        title={current.totalBillable != null && current.loadPrice != null && current.totalBillable !== current.loadPrice
                          ? `Linehaul ${moneyFmt.format(current.loadPrice)} + accessorials = ${moneyFmt.format(current.totalBillable)}`
                          : undefined}>
                    {moneyFmt.format(current.totalBillable ?? current.loadPrice!)}
                  </span>
                </>
              )}
              <Sep />
              {drivers.length === 0 ? (
                <span style={{ color: 'var(--gc-text-3)', fontStyle: 'italic' }}>Unassigned</span>
              ) : drivers.length === 1 ? (
                <span className="truncate max-w-[160px]" title={drivers[0]} style={{ color: 'var(--gc-text-2)' }}>
                  {drivers[0]}
                </span>
              ) : (
                <span className="truncate max-w-[260px]" title={drivers.join(' → ')} style={{ color: 'var(--gc-text-2)' }}>
                  {drivers[0]} <span style={{ opacity: 0.5 }}>→</span> {drivers[1]}
                </span>
              )}
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

        {/* Internal notes — banner when there are notes, slim "Add note"
            row when there aren't. Both surfaces open the full thread
            modal so the user can read older entries / compose new ones. */}
        {(() => {
          const notes = current.internalNotes ?? [];
          if (notes.length === 0) {
            return (
              <div className="shrink-0 flex items-center justify-between px-5 py-1.5"
                style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border-light)' }}>
                <span className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                  No internal notes on this load.
                </span>
                <button onClick={() => setNotesOpen(true)}
                  className="flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-lg transition-colors"
                  style={{ color: 'var(--gc-blue)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(26,115,232,0.08)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <Plus size={11} /> Add note
                </button>
              </div>
            );
          }
          return (
            <div className="shrink-0 px-5 py-2.5"
              style={{ background: '#fef9c3', borderBottom: '1px solid #fde68a' }}>
              <div className="flex items-start gap-2">
                <Pin size={13} style={{ color: '#a16207', marginTop: 3, flexShrink: 0 }} />
                <div className="flex-1 min-w-0">
                  {notes.map(n => (
                    <div key={n.id} className="text-[13px]" style={{ color: '#78350f', whiteSpace: 'pre-wrap' }}>
                      {n.text}
                      <span className="text-[11px] ml-2" style={{ color: '#a16207' }}>
                        — {n.author ?? 'Unknown'}, {new Date(n.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </span>
                    </div>
                  ))}
                </div>
                <button onClick={() => setNotesOpen(true)}
                  className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg transition-colors flex-shrink-0"
                  style={{
                    background: 'rgba(161, 98, 7, 0.15)',
                    color:      '#854d0e',
                    border:     '1px solid rgba(161, 98, 7, 0.3)',
                  }}
                  title="View all notes / add new"
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(161, 98, 7, 0.25)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'rgba(161, 98, 7, 0.15)')}>
                  <MessageSquare size={10} />
                  {notes.length > 1 ? `${notes.length} notes` : 'Add'}
                </button>
              </div>
            </div>
          );
        })()}

        {/* Main: 3-column grid (rate-con | docs | sidebar). The
            sidebar is the priority surface — it holds the verification
            checklist and action buttons, so it gets an explicit fixed
            track width that nothing else can encroach on. The two PDF
            columns split what remains via minmax(0, 1fr), which has
            a *true* zero minimum (unlike flex's "min-width: auto"
            footgun) so their content has no choice but to scroll
            inside its track rather than push the sidebar offscreen. */}
        <div className="flex-1 min-h-0"
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) 320px',
            // Explicit single row at the container's height. Without
            // this, grid implicit-row sizing defaults to `auto`, so
            // when the middle column's PdfCanvas wants to render a
            // tall doc at fit-to-width, the grid row grows to that
            // doc's height and the right column inherits the same
            // height — pushing the Release/Flag/Skip buttons way
            // below the viewport. minmax(0, 1fr) here is the row
            // analog of the minmax(0, 1fr) we already use on the
            // columns: real zero minimum so children must scroll
            // inside their track instead of dictating its height.
            gridTemplateRows: 'minmax(0, 1fr)',
          }}>
          {/* display:contents wrapper kept so the inner column DOM
              below doesn't need a 200-line renumber. The wrapper
              vanishes from the layout tree — rate-con and docs
              participate directly in the grid as tracks 1 and 2. */}
          <div style={{ display: 'contents' }}>
            {/* Left panel — toggle between Rate Con and Stops. The
                stops view is handy when verifying delivery against
                the planned route, or when the rate-con doesn't carry
                appointment / facility detail clearly. */}
            <div className="flex-1 flex flex-col min-w-0 border-r" style={{ borderColor: 'var(--gc-border-light)' }}>
              <div className="shrink-0 flex items-center justify-between px-3 py-2 gap-2"
                style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border-light)' }}>
                {/* Tab toggle (Rate Con / Stops) */}
                <div className="flex items-center gap-0.5 p-0.5 rounded-full"
                  style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
                  {([
                    { key: 'rateCon' as const, label: 'Rate Con' },
                    { key: 'stops'   as const, label: `Stops${allStopsForView.length ? ` (${allStopsForView.length})` : ''}` },
                  ]).map(t => {
                    const active = leftPanelView === t.key;
                    return (
                      <button key={t.key} type="button"
                        onClick={() => setLeftPanelView(t.key)}
                        className="px-3 py-1 rounded-lg text-[11px] font-extrabold uppercase tracking-wider transition-colors"
                        style={{
                          background: active ? 'var(--gc-blue)' : 'transparent',
                          color:      active ? '#fff' : 'var(--gc-text-2)',
                          textShadow: active ? '0 1px 1px rgba(0,0,0,0.25)' : undefined,
                        }}>
                        {t.label}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2">
                  {leftPanelView === 'rateCon' && !current.rateConPdf && (
                    <span className="text-xs font-bold" style={{ color: '#dc2626' }}>Not attached</span>
                  )}
                  {leftPanelView === 'rateCon' && loadId && (
                    <button type="button"
                      onClick={() => rateConInputRef.current?.click()}
                      disabled={rateConUploading}
                      className="flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-wider px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50"
                      style={{
                        background: KIND_TINT.rate_con.bg,
                        color:      KIND_TINT.rate_con.fg,
                        textShadow: '0 1px 1px rgba(0,0,0,0.25)',
                        boxShadow:  '0 1px 3px rgba(0,0,0,0.12)',
                      }}
                      title={current.rateConPdf ? 'Upload a new rate confirmation' : 'Upload rate confirmation'}>
                      {rateConUploading
                        ? <Loader2 size={10} className="animate-spin" />
                        : <Plus size={10} />}
                      {current.rateConPdf ? 'Replace' : 'Upload'}
                    </button>
                  )}
                </div>
              </div>
              {leftPanelView === 'rateCon'
                ? (() => {
                    // Left viewer shows whichever rate con the user picked
                    // from the right sidebar's Rate Confirmations list.
                    // Defaults to the canonical (loads.rate_con_pdf →
                    // rateConUrl); secondaryRateConUrl overrides when the
                    // user clicks a non-canonical kind='rate_con' row.
                    const url = secondaryRateConUrl ?? rateConUrl ?? '';
                    const hasAny = current.rateConPdf || rateConDocs.length > 0;
                    if (!hasAny) {
                      return <NoDocPanel label="No rate-con uploaded for this load." />;
                    }
                    return (
                      <PdfCanvas dataUrl={url}
                        onRetry={() => loadId && railway.getRateConUrl(loadId).then(({ url: u }) => setRateConUrl(u))} />
                    );
                  })()
                : <StopsView stops={allStopsForView} />}
              {/* Hidden file input — fired by the Replace/Upload button. */}
              <input ref={rateConInputRef} type="file" accept=".pdf,application/pdf,image/*"
                style={{ display: 'none' }}
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (f) void uploadRateCon(f);
                  e.target.value = '';
                }} />
            </div>

            {/* Middle column — viewer with a thin header.
                Header shape mirrors the Rate Con tab's header (left:
                doc identity, right: "+ Replace"-style action). Here the
                action is "+ Add Documents" since uploading is a fresh
                doc, not a replacement.

                Doc list + Manage Documents live in the right sidebar;
                verification chips live in the right sidebar's header. */}
            <div className="flex-1 flex flex-col min-w-0">
              {/* Viewer header */}
              <div className="shrink-0 px-3 py-2 flex items-center justify-between gap-3"
                style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border-light)', minHeight: 40 }}>
                {(() => {
                  // Middle viewer only shows non-rate-con docs. Rate cons
                  // render in the left panel via selectRateCon.
                  const active = nonRateConDocs[Math.min(activeDocIdx, nonRateConDocs.length - 1)];
                  if (!active) {
                    return (
                      <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
                        Documents
                      </span>
                    );
                  }
                  const tint = KIND_TINT[active.kind] ?? KIND_TINT.other;
                  // Enumerate same-kind docs as POD 1 / POD 2 for context,
                  // matching the right sidebar list's row labels.
                  const sameKindCount = nonRateConDocs.filter(x => x.kind === active.kind).length;
                  const seq           = nonRateConDocs.slice(0, activeDocIdx + 1).filter(x => x.kind === active.kind).length;
                  const labelText     = KIND_LABEL[active.kind] ?? active.kind;
                  const kindLabel     = sameKindCount > 1 ? `${labelText} ${seq}` : labelText;
                  return (
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                        style={{ background: tint.bg, color: tint.fg }}>
                        {kindLabel}
                      </span>
                      <span className="text-[12px] font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}
                        title={active.fileName}>
                        {active.fileName}
                      </span>
                    </div>
                  );
                })()}
                {loadId && (
                  <button type="button" onClick={pickFile} disabled={uploading}
                    className="flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-wider px-2.5 py-1 rounded-lg transition-opacity disabled:opacity-50 shrink-0"
                    style={{
                      background:  'var(--gc-blue)',
                      color:       '#fff',
                      textShadow:  '0 1px 1px rgba(0,0,0,0.25)',
                      boxShadow:   '0 1px 3px rgba(0,0,0,0.12)',
                    }}>
                    {uploading ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />}
                    Add Documents
                  </button>
                )}
              </div>

              {nonRateConDocs.length > 0 ? (() => {
                const active = nonRateConDocs[Math.min(activeDocIdx, nonRateConDocs.length - 1)];
                return (
                  <DocViewer
                    url={activeDocUrl ?? ''}
                    mimeType={active?.mimeType}
                    fileName={active?.fileName}
                  />
                );
              })() : <NoDocPanel label="No documents uploaded yet for this load." />}

              {/* Hidden file input — wired by pickFile(), which is fired
                  from the right sidebar's "+ Add Documents" button.
                  Lives here at the bottom of the column so it stays
                  mounted across all rendering branches. */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,application/pdf,image/*"
                multiple
                style={{ display: 'none' }}
                onChange={e => {
                  const picked = Array.from(e.target.files ?? []);
                  if (picked.length > 0) setPendingFiles(prev => [...prev, ...picked]);
                  e.target.value = '';
                }}
              />
            </div>
          </div>

          {/* Right: actions sidebar. Width is dictated by the parent
              grid's third track (320px) — no width prop here so the
              two values can't drift out of sync. */}
          {/* Right sidebar column. min-h-0 + overflow-hidden are
              load-bearing — without them, when content above pushes
              (pending file list grows, PdfCanvas in the middle column
              fires its ResizeObserver) the flex algorithm can't compress
              the "Include in invoice" track and the action buttons at
              the bottom get pushed below the visible area in an
              oscillating layout fight. */}
          <div className="flex flex-col min-h-0 overflow-hidden" style={{ borderLeft: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)' }}>
            {/* Accessorials banner — surfaces detention / lumper / scale
                etc. with their amounts so the dispatcher knows what
                support docs they're verifying against. */}
            {(current.accessorials ?? []).length > 0 && (
              <div className="shrink-0 px-4 py-3" style={{ background: '#fef9c3', borderBottom: '1px solid #fde68a' }}>
                <div className="text-[11px] font-bold uppercase tracking-wider mb-1.5" style={{ color: '#854d0e' }}>
                  Accessorials ({(current.accessorials ?? []).length})
                </div>
                <ul className="space-y-1">
                  {(current.accessorials ?? []).map((a, i) => (
                    <li key={i} className="flex items-center justify-between text-[12px]">
                      <span style={{ color: '#78350f' }}>
                        {ACCESSORIAL_LABEL[a.category] ?? a.category}
                        {a.description && <span className="ml-1" style={{ color: '#a16207', fontSize: 11 }}>· {a.description}</span>}
                      </span>
                      <span className="font-semibold tabular-nums" style={{ color: '#78350f' }}>
                        {a.amount != null ? moneyFmt.format(a.amount) : '—'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Document management lives here. Layout, top → bottom:
                  ┌─ "Docs · N" label + Verification chips (Rate Con ✓,
                  │   POD ✓, Lumper / Scale if accessorials require them)
                  ├─ Pending file kind picker (only when uploading)
                  ├─ Doc rows (flex-1 — scrolls when many docs)
                  └─ "Manage documents" button (opens merge / convert)

                The "+ Add Documents" button lives in the middle column's
                viewer header (mirrors the Rate Con tab's "+ Replace"
                pattern) so the upload affordance sits where the result
                shows up. */}
            <div className="shrink-0 px-3 py-2.5 flex items-center justify-between gap-2 flex-wrap"
              style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border-light)' }}>
              <span className="text-[11px] font-bold uppercase tracking-wider shrink-0" style={{ color: 'var(--gc-text-3)' }}>
                Docs {docs.length > 0 && <span style={{ color: 'var(--gc-text-2)' }}>· {docs.length}</span>}
              </span>
              {/* Verification chips — Rate Con + POD (+ Lumper / Scale
                  if the load's accessorials require them). Green check
                  when present, red ! when missing. TONU shows a blue
                  badge instead (POD not required). flex-wrap on the
                  container so a long load with all four checks gracefully
                  drops the last chip to a second row. */}
              <div className="flex items-center gap-2 flex-wrap justify-end">
                {isTonu && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold"
                    style={{ background: '#dbeafe', color: '#1e40af', border: '1px solid #bfdbfe' }}>
                    TONU
                  </span>
                )}
                {checklist.filter(c => !c.skip).map(c => (
                  <span key={c.id} className="flex items-center gap-1 text-[11px] font-semibold"
                    style={{ color: c.pass ? 'var(--gc-text-1)' : '#dc2626' }}>
                    {c.pass
                      ? <CheckCircle2 size={12} style={{ color: '#15803d' }} />
                      : <AlertCircle  size={12} style={{ color: '#dc2626' }} />}
                    <span>{c.label}</span>
                  </span>
                ))}
              </div>
            </div>

            {/* Pending file kind picker — only when files are queued.
                Lives above the doc list so the user sees their picked
                file at the top of the panel, then chooses the kind.
                Hidden when the Manage Documents dialog is open — the
                dialog renders its own copy of this UI inline so the
                upload workflow stays in one modal. */}
            {pendingFiles.length > 0 && !mergeDialogOpen && (
              <div className="shrink-0 px-3 py-2.5 space-y-2"
                style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border-light)' }}>
                <div className="space-y-1">
                  {pendingFiles.map((f, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-[12px] px-1.5 py-1 rounded"
                      style={{ background: 'var(--gc-surface)' }}>
                      <span className="text-[10px] font-bold tabular-nums" style={{ color: 'var(--gc-text-3)', minWidth: 14 }}>
                        {i + 1}.
                      </span>
                      <FileText size={11} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />
                      <span className="truncate flex-1" title={f.name} style={{ color: 'var(--gc-text-1)' }}>
                        {f.name}
                      </span>
                      <button onClick={() => setPendingFiles(prev => prev.filter((_, j) => j !== i))}
                        disabled={uploading}
                        className="p-0.5 rounded hover:bg-[var(--gc-hover)]" title="Remove from list">
                        <X size={11} style={{ color: 'var(--gc-text-3)' }} />
                      </button>
                    </div>
                  ))}
                  <button onClick={pickFile} disabled={uploading}
                    className="w-full flex items-center justify-center gap-1.5 text-[11px] py-1 rounded transition-colors"
                    style={{ color: 'var(--gc-blue)', background: 'transparent', border: '1px dashed var(--gc-border-light)' }}>
                    <Plus size={11} /> Add more
                  </button>
                </div>
                {pendingFiles.length > 1 && (
                  <div className="text-[10px] px-2 py-1 rounded flex items-start gap-1.5"
                    style={{ background: '#e0f2fe', color: '#0c4a6e' }}>
                    <FileText size={10} style={{ marginTop: 1, flexShrink: 0 }} />
                    <span>
                      {pendingFiles.length} files will be merged into one PDF before upload.
                    </span>
                  </div>
                )}
                <div className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'var(--gc-text-3)' }}>
                  {pendingFiles.length > 1 ? 'Save merged PDF as' : 'What is this?'}
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {KIND_OPTIONS.map(opt => (
                    <button key={opt.kind}
                      onClick={() => void uploadAs(opt.kind)}
                      disabled={uploading}
                      className="flex items-center justify-center gap-1.5 rounded-lg text-[11px] font-black uppercase tracking-wider py-2 transition-opacity disabled:opacity-50"
                      style={{
                        background:  opt.tint.bg,
                        color:       opt.tint.fg,
                        boxShadow:   '0 1px 3px rgba(0,0,0,0.12)',
                        textShadow:  '0 1px 1px rgba(0,0,0,0.25)',
                      }}>
                      {uploading ? <Loader2 size={11} className="animate-spin" /> : null}
                      {opt.label}
                    </button>
                  ))}
                </div>
                {uploading && mergeStatus && (
                  <div className="text-[10px] flex items-center gap-1.5 px-2 py-1 rounded"
                    style={{ background: 'var(--gc-hover)', color: 'var(--gc-text-2)' }}>
                    <Loader2 size={10} className="animate-spin" />
                    <span className="truncate flex-1">{mergeStatus}</span>
                  </div>
                )}
                {uploadError && (
                  <div className="text-[11px] flex items-start gap-1" style={{ color: '#dc2626' }}>
                    <AlertCircle size={11} style={{ marginTop: 1, flexShrink: 0 }} /> {uploadError}
                  </div>
                )}
              </div>
            )}

            {/* Manage documents — opens the full CRUD popup (add /
                rename / retype / delete / download / merge-by-type).
                Lives ABOVE the Rate Confirmations + Documents sub-lists
                because it's the entry point to bulk-manage them. Always
                rendered once we have a loadId — the dialog itself
                handles the empty state and exposes "+ Add Documents"
                so users can populate the load from here without
                leaving the right sidebar. */}
            {loadId && (
              <div className="shrink-0 px-3 py-2"
                style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                <button type="button"
                  onClick={() => { setMergeSelection(new Set()); setMergeDialogOpen(true); }}
                  disabled={merging}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-extrabold uppercase tracking-wider transition-colors disabled:opacity-50"
                  style={{
                    background: 'transparent',
                    color:      'var(--gc-text-2)',
                    border:     '1px dashed var(--gc-border)',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  {merging ? <Loader2 size={11} className="animate-spin" /> : <Layers size={11} />}
                  Manage documents
                </button>
              </div>
            )}

            {/* Two sections — Rate Confirmations + Documents.
                Rate Confirmations always renders first (closer to the
                top, mirrors workflow: review rate con, then verify
                supporting docs). Click a row to view it in the left
                panel; the Documents list still drives the middle viewer.

                Rate-con rows skip the Invoice toggle — they're always
                auto-included in the invoice packet by the API
                (resolvePacketDocsForLoad + resolveRateConPathForLoad).

                The virtual canonical row (id === RATE_CON_PRIMARY_ID)
                represents loads.rate_con_pdf when no kind='rate_con'
                load_document exists. It can't be renamed or deleted
                inline (no real row to mutate), so those affordances
                are gated on the sentinel. */}
            <div className="flex-1 overflow-y-auto px-2 py-1.5 space-y-2"
              style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
              {/* RATE CONFIRMATIONS */}
              {rateConDocs.length > 0 && (
                <div>
                  <div className="px-1.5 pt-1 pb-1.5 text-[10px] font-bold uppercase tracking-wider"
                    style={{ color: 'var(--gc-text-3)' }}>
                    Rate Confirmations · {rateConDocs.length}
                  </div>
                  <div className="space-y-1">
                    {rateConDocs.map((d, i) => {
                      const tint     = KIND_TINT[d.kind] ?? KIND_TINT.other;
                      const isVirtual = d.id === RATE_CON_PRIMARY_ID;
                      // The canonical highlights when nothing else is
                      // explicitly selected (activeRateConId === null),
                      // matching the default left-viewer state.
                      const active   = activeRateConId === d.id
                                     || (activeRateConId === null && isVirtual);
                      const sameKindCount = rateConDocs.length;
                      const seq           = i + 1;
                      const labelText     = KIND_LABEL[d.kind] ?? d.kind;
                      const rowKindLabel  = sameKindCount > 1 ? `${labelText} ${seq}` : labelText;
                      return (
                        <div key={d.id}
                          className="group flex items-center gap-1.5 rounded-lg px-1.5 py-1.5 transition-colors cursor-pointer"
                          style={{
                            background: active ? tint.bg + '14' : 'transparent',
                            border:     active ? `1.5px solid ${tint.bg}` : '1.5px solid transparent',
                          }}
                          onClick={() => selectRateCon(d)}
                          onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                          onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
                          <span className="text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                            style={{ background: tint.bg, color: tint.fg }}>
                            {rowKindLabel}
                          </span>
                          {renamingDocId === d.id ? (
                            <input
                              autoFocus
                              value={renameDraft}
                              disabled={renameSaving}
                              onClick={e => e.stopPropagation()}
                              onChange={e => setRenameDraft(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter')  { e.preventDefault(); void commitRename(); }
                                if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                              }}
                              onBlur={() => { if (!renameSaving) void commitRename(); }}
                              className="flex-1 text-[12px] font-semibold bg-transparent outline-none border-b"
                              style={{ color: 'var(--gc-text-1)', borderColor: tint.bg }}
                            />
                          ) : (
                            <span className="flex-1 truncate text-[12px]" style={{ color: 'var(--gc-text-1)' }}
                              title={d.fileName}>
                              {d.fileName}
                            </span>
                          )}
                          {!isVirtual && renamingDocId !== d.id && (
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                              <button type="button"
                                onClick={e => { e.stopPropagation(); startRename(d.id, d.fileName); }}
                                className="rounded-full p-1 transition-colors"
                                title={`Rename — ${d.fileName}`}
                                style={{ color: tint.bg, background: 'transparent' }}
                                onMouseEnter={ev => (ev.currentTarget.style.background = tint.bg + '14')}
                                onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}>
                                <Pencil size={11} />
                              </button>
                              <button type="button"
                                onClick={e => { e.stopPropagation(); setDeleteTarget({ id: d.id, name: d.fileName }); }}
                                className="rounded-full p-1 transition-colors"
                                title={`Delete — ${d.fileName}`}
                                style={{ color: '#d93025', background: 'transparent' }}
                                onMouseEnter={ev => (ev.currentTarget.style.background = '#fce8e6')}
                                onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}>
                                <Trash2 size={11} />
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* DOCUMENTS */}
              <div>
                <div className="px-1.5 pt-1 pb-1.5 text-[10px] font-bold uppercase tracking-wider"
                  style={{ color: 'var(--gc-text-3)' }}>
                  Documents · {nonRateConDocs.length}
                </div>
                {nonRateConDocs.length === 0 ? (
                  <div className="text-xs italic px-2 py-3" style={{ color: 'var(--gc-text-3)' }}>
                    {docsLoading ? 'Loading…' : 'No documents uploaded yet for this load.'}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {nonRateConDocs.map((d, i) => {
                      const tint     = KIND_TINT[d.kind] ?? KIND_TINT.other;
                      const active   = i === activeDocIdx;
                      const included = includedDocIds.has(d.id);
                      const sameKindCount = nonRateConDocs.filter(x => x.kind === d.kind).length;
                      const seq           = nonRateConDocs.slice(0, i + 1).filter(x => x.kind === d.kind).length;
                      const labelText     = KIND_LABEL[d.kind] ?? d.kind;
                      const rowKindLabel  = sameKindCount > 1 ? `${labelText} ${seq}` : labelText;
                      return (
                        <div key={d.id}
                          className="group flex items-center gap-1.5 rounded-lg px-1.5 py-1.5 transition-colors cursor-pointer"
                          style={{
                            background: active ? tint.bg + '14' : 'transparent',
                            border:     active ? `1.5px solid ${tint.bg}` : '1.5px solid transparent',
                          }}
                          onClick={() => setActiveDocIdx(i)}
                          onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                          onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
                          <span className="text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                            style={{ background: tint.bg, color: tint.fg }}>
                            {rowKindLabel}
                          </span>
                          {renamingDocId === d.id ? (
                            <input
                              autoFocus
                              value={renameDraft}
                              disabled={renameSaving}
                              onClick={e => e.stopPropagation()}
                              onChange={e => setRenameDraft(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter')  { e.preventDefault(); void commitRename(); }
                                if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                              }}
                              onBlur={() => { if (!renameSaving) void commitRename(); }}
                              className="flex-1 text-[12px] font-semibold bg-transparent outline-none border-b"
                              style={{ color: 'var(--gc-text-1)', borderColor: tint.bg }}
                            />
                          ) : (
                            <span className="flex-1 truncate text-[12px]" style={{ color: 'var(--gc-text-1)' }}
                              title={d.fileName}>
                              {d.fileName}
                            </span>
                          )}
                          {renamingDocId !== d.id && (
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                              <button type="button"
                                onClick={e => { e.stopPropagation(); startRename(d.id, d.fileName); }}
                                className="rounded-full p-1 transition-colors"
                                title={`Rename — ${d.fileName}`}
                                style={{ color: tint.bg, background: 'transparent' }}
                                onMouseEnter={ev => (ev.currentTarget.style.background = tint.bg + '14')}
                                onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}>
                                <Pencil size={11} />
                              </button>
                              <button type="button"
                                onClick={e => { e.stopPropagation(); setDeleteTarget({ id: d.id, name: d.fileName }); }}
                                className="rounded-full p-1 transition-colors"
                                title={`Delete — ${d.fileName}`}
                                style={{ color: '#d93025', background: 'transparent' }}
                                onMouseEnter={ev => (ev.currentTarget.style.background = '#fce8e6')}
                                onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}>
                                <Trash2 size={11} />
                              </button>
                            </div>
                          )}
                          {/* Per-row include-in-invoice toggle. */}
                          <button type="button"
                            onClick={e => {
                              e.stopPropagation();
                              setIncludedDocIds(prev => {
                                const next = new Set(prev);
                                if (next.has(d.id)) next.delete(d.id); else next.add(d.id);
                                return next;
                              });
                            }}
                            className="flex items-center gap-1 px-1.5 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-colors shrink-0"
                            style={{
                              background: included ? '#dcfce7' : 'var(--gc-bg)',
                              color:      included ? '#166534' : 'var(--gc-text-3)',
                              border:     `1px solid ${included ? '#86efac' : 'var(--gc-border)'}`,
                            }}
                            title={included ? 'Included in invoice — click to exclude' : 'Click to include in invoice'}>
                            {included ? <CheckCircle2 size={11} /> : <Circle size={11} />}
                            Invoice
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Manage documents button used to live here — moved to
                the top of the sidebar (above Rate Confirmations) so
                it's discoverable before the user scans the doc lists. */}

            {/* Action buttons. Stack order top→bottom:
                  1. (optional) "Convert to PDF" when non-PDF docs exist
                  2. Generate / Regenerate invoice — primary green CTA
                  3. Release for invoicing  /  Released stamp
                  4. Flag
                  5. Skip
                The release CTA flips to a passive "Released" stamp once
                the load's billing_status leaves 'pending' — re-clicking
                would re-stamp the verified_at timestamp and add noise to
                the audit trail. */}
            <div className="shrink-0 px-4 py-4 space-y-2" style={{ background: 'var(--gc-bg)' }}>
              {/* Convert to PDF used to live here as a standalone CTA;
                  it moved into the Manage Documents dialog (passed in
                  via the dialog's `extraAction` slot) so the sidebar
                  stays focused on the invoice + release path. */}
              {/* Generate / Regenerate invoice — primary green CTA.
                  Persists the per-row invoice selection from the doc
                  list above before firing. Verb flips by activeInvoice:
                    • no active invoice  → "Generate invoice"
                    • active draft       → "Regenerate invoice"
                    • sent / paid        → disabled with explainer

                  Hidden entirely while billing_status is still 'pending'
                  — invoice generation is a post-release action. Surfacing
                  it during review encouraged people to generate before
                  the load was verified, which then required a void +
                  regenerate cycle when accessorials or notes changed in
                  the final review pass. The Release CTA below is the
                  only path forward from 'pending'; once released, this
                  block lights up. */}
              {current.billingStatus !== 'pending' && (() => {
                const hasDraft     = activeInvoice?.status === 'draft';
                const hasNonDraft  = activeInvoice && activeInvoice.status !== 'draft';
                const label =
                  hasDraft     ? 'Regenerate invoice' :
                  hasNonDraft  ? `Invoice ${activeInvoice!.status}` :
                                 'Generate invoice';
                const Icon = hasDraft ? RefreshCw : Receipt;
                return (
                  <button type="button"
                    onClick={() => void handleGenerateOrRegenerate()}
                    disabled={invoiceBusy || !!hasNonDraft}
                    title={hasNonDraft ? `Cannot regenerate a ${activeInvoice!.status} invoice — void it first.` : undefined}
                    className="w-full flex items-center justify-center gap-1.5 text-[12px] font-extrabold uppercase tracking-wider px-3 py-2 rounded-lg transition-opacity disabled:opacity-50"
                    style={{
                      background: hasNonDraft ? 'var(--gc-surface)' : '#188038',
                      color:      hasNonDraft ? 'var(--gc-text-3)'  : '#fff',
                      border:     hasNonDraft ? '1.5px solid var(--gc-border)' : 'none',
                      textShadow: hasNonDraft ? undefined : '0 1px 1px rgba(0,0,0,0.2)',
                      boxShadow:  hasNonDraft ? undefined : '0 1px 3px rgba(0,0,0,0.12)',
                    }}>
                    {invoiceBusy ? <Loader2 size={12} className="animate-spin" /> : <Icon size={12} />}
                    {label}
                  </button>
                );
              })()}
              {current.billingStatus !== 'pending' && invoiceError && (
                <div className="text-[11px] px-2 py-1.5 rounded" style={{ color: '#b71c1c', background: '#fce8e6', border: '1px solid #fcd2cf' }}>
                  {invoiceError}
                </div>
              )}
              {(current.billingStatus === 'verified'
                || current.billingStatus === 'invoiced'
                || current.billingStatus === 'paid') ? (
                <div
                  className="w-full flex items-center justify-center gap-2 rounded-lg text-sm font-bold"
                  style={{
                    background: '#dcfce7',
                    color:      '#166534',
                    border:     '1px solid #bbf7d0',
                    padding:    '10px 14px',
                  }}
                  title={
                    current.billingStatus === 'paid'      ? 'Already paid'
                    : current.billingStatus === 'invoiced' ? 'Invoice sent — see accounting'
                    : 'Released to accounting'
                  }>
                  <CheckCircle2 size={15} />
                  {current.billingStatus === 'paid'      ? 'Paid'
                  : current.billingStatus === 'invoiced' ? 'Invoiced'
                  : 'Released'}
                  {current.verifiedAt && (
                    <span className="text-[11px] font-normal opacity-75">
                      · {new Date(current.verifiedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  )}
                </div>
              ) : (
                <button onClick={() => void handleRelease()} disabled={busy}
                  className="w-full flex items-center justify-center gap-2 rounded-lg text-sm font-bold transition-colors disabled:opacity-50"
                  style={{ background: '#15803d', color: '#fff', padding: '10px 14px' }}
                  title={requiredPass ? 'Release for invoicing' : 'Required docs missing — confirm before releasing'}>
                  <CheckCircle2 size={15} /> Release for invoicing
                  <span className="text-[10px] font-mono opacity-70 ml-1">R</span>
                </button>
              )}
              <button onClick={() => setShowFlag(true)} disabled={busy}
                className="w-full flex items-center justify-center gap-2 rounded-lg text-sm font-bold transition-colors disabled:opacity-50"
                style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a', padding: '10px 14px' }}>
                <Flag size={15} /> Flag for follow-up
                <span className="text-[10px] font-mono opacity-70 ml-1">F</span>
              </button>
              <button onClick={next} disabled={busy || safeIdx >= loads.length - 1}
                className="w-full flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
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

      {notesOpen && (
        <InternalNotesModal
          load={current as Load}
          actorName={user?.fullName ?? user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? undefined}
          // Always one tier above our own Shell. Sized off `zIndex` so
          // that when the queue is hoisted (e.g. opened from the load
          // modal at z-250), our nested overlays follow rather than
          // getting stranded behind the queue panel.
          zIndex={zIndex + 50}
          onClose={() => setNotesOpen(false)}
          onSaved={() => { /* nothing to refresh — note appears
                              optimistically in the modal's local thread */ }}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete document?"
          message={`"${deleteTarget.name}" will be removed. This can't be undone.`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          destructive
          // Above the queue Shell (and above the notes modal, see
          // above) — destructive confirms are always topmost.
          zIndex={zIndex + 60}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const id = deleteTarget.id;
            setDeleteTarget(null);
            void handleDeleteDoc(id);
          }}
        />
      )}

      {mergeDialogOpen && (
        <DocSelectionDialog
          title="Manage Documents"
          description=""
          docs={mergeCandidates}
          selected={mergeSelection}
          onToggle={(id) => setMergeSelection(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
          })}
          onSelectAll={() => setMergeSelection(new Set(mergeCandidates.map(d => d.id)))}
          onSelectNone={() => setMergeSelection(new Set())}
          onCancel={() => { setMergeDialogOpen(false); setMergeSelection(new Set()); }}
          onConfirm={() => void handleMergeSelected()}
          busy={merging}
          busyLabel="Merging…"
          minSelect={2}
          actionIcon={<Layers size={13} />}
          actionLabel={count => `Merge ${count} files`}
          ctaWhenLow="Pick at least 2"
          kindLabel={KIND_LABEL}
          kindTint={KIND_TINT}
          // ── Manage-mode wiring ──────────────────────────────────────
          // Turns on per-row pencil (rename) + trash (delete) + clickable
          // kind chip (change kind). Add button surfaces in the header.
          // All mutations call back to the parent's existing handlers,
          // which already own the optimistic update + cache patching.
          manageMode
          onAdd={pickFile}
          onRename={async (id, newName) => { await railway.renameDocument(id, newName); setDocs(prev => prev.map(d => d.id === id ? { ...d, fileName: newName } : d)); if (loadId) { const entry = docsCacheRef.current.get(loadId); if (entry) docsCacheRef.current.set(loadId, { ...entry, docs: entry.docs.map(d => d.id === id ? { ...d, fileName: newName } : d) }); } }}
          onChangeKind={handleChangeKind}
          onDelete={handleDeleteDoc}
          onDownload={handleDownloadDoc}
          onMergeByType={handleMergeByType}
          kindOptions={KIND_OPTIONS}
          // Pending kind picker — when the user clicks "+ Add document"
          // and picks files, the OS file picker fires (via pickFile).
          // Picked files land in pendingFiles state. We render the kind
          // picker INSIDE the dialog so the upload workflow stays in
          // one modal instead of bouncing to the sidebar.
          pendingArea={pendingFiles.length > 0 ? (
            <div className="mx-5 mb-3 px-3 py-2.5 space-y-2 rounded-lg"
              style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)' }}>
              <div className="space-y-1">
                {pendingFiles.map((f, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-[12px] px-1.5 py-1 rounded"
                    style={{ background: 'var(--gc-surface)' }}>
                    <span className="text-[10px] font-bold tabular-nums" style={{ color: 'var(--gc-text-3)', minWidth: 14 }}>
                      {i + 1}.
                    </span>
                    <FileText size={11} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />
                    <span className="truncate flex-1" title={f.name} style={{ color: 'var(--gc-text-1)' }}>
                      {f.name}
                    </span>
                    <button onClick={() => setPendingFiles(prev => prev.filter((_, j) => j !== i))}
                      disabled={uploading}
                      className="p-0.5 rounded hover:bg-[var(--gc-hover)]" title="Remove from list">
                      <X size={11} style={{ color: 'var(--gc-text-3)' }} />
                    </button>
                  </div>
                ))}
                <button onClick={pickFile} disabled={uploading}
                  className="w-full flex items-center justify-center gap-1.5 text-[11px] py-1 rounded transition-colors"
                  style={{ color: 'var(--gc-blue)', background: 'transparent', border: '1px dashed var(--gc-border-light)' }}>
                  <Plus size={11} /> Add more
                </button>
              </div>
              {pendingFiles.length > 1 && (
                <div className="text-[10px] px-2 py-1 rounded flex items-start gap-1.5"
                  style={{ background: '#e0f2fe', color: '#0c4a6e' }}>
                  <FileText size={10} style={{ marginTop: 1, flexShrink: 0 }} />
                  <span>{pendingFiles.length} files will be merged into one PDF before upload.</span>
                </div>
              )}
              <div className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'var(--gc-text-3)' }}>
                {pendingFiles.length > 1 ? 'Save merged PDF as' : 'What is this?'}
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {KIND_OPTIONS.map(opt => (
                  <button key={opt.kind}
                    onClick={() => void uploadAs(opt.kind)}
                    disabled={uploading}
                    className="flex items-center justify-center gap-1.5 rounded-lg text-[11px] font-black uppercase tracking-wider py-2 transition-opacity disabled:opacity-50"
                    style={{
                      background:  opt.tint.bg,
                      color:       opt.tint.fg,
                      boxShadow:   '0 1px 3px rgba(0,0,0,0.12)',
                      textShadow:  '0 1px 1px rgba(0,0,0,0.25)',
                    }}>
                    {uploading ? <Loader2 size={11} className="animate-spin" /> : null}
                    {opt.label}
                  </button>
                ))}
              </div>
              {uploading && mergeStatus && (
                <div className="text-[10px] flex items-center gap-1.5 px-2 py-1 rounded"
                  style={{ background: 'var(--gc-hover)', color: 'var(--gc-text-2)' }}>
                  <Loader2 size={10} className="animate-spin" />
                  <span className="truncate flex-1">{mergeStatus}</span>
                </div>
              )}
              {uploadError && (
                <div className="text-[11px] flex items-start gap-1" style={{ color: '#dc2626' }}>
                  <AlertCircle size={11} style={{ marginTop: 1, flexShrink: 0 }} /> {uploadError}
                </div>
              )}
            </div>
          ) : undefined}
          // Convert-to-PDF lives here as a secondary action chip.
          // Closes Manage Documents and opens the convert flow. Hidden
          // when there's nothing non-PDF on the load.
          extraAction={convertCandidates.length >= 1 ? (
            <button type="button"
              onClick={() => {
                setMergeDialogOpen(false);
                setMergeSelection(new Set());
                setConvertSelection(new Set());
                setConvertDialogOpen(true);
              }}
              disabled={merging || converting}
              className="flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-wider px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50"
              style={{
                background: 'var(--gc-surface)',
                color:      'var(--gc-blue)',
                border:     '1px solid var(--gc-blue)',
              }}
              title={`Convert ${convertCandidates.length} non-PDF doc${convertCandidates.length === 1 ? '' : 's'} to PDF`}>
              <FileText size={11} /> Convert to PDF
            </button>
          ) : undefined}
          zIndex={zIndex + 60}
        />
      )}

      {convertDialogOpen && (
        <DocSelectionDialog
          title="Convert to PDF"
          description="Pick non-PDF documents to convert. A PDF copy is added per source; originals stay in the list."
          docs={convertCandidates}
          selected={convertSelection}
          onToggle={(id) => setConvertSelection(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
          })}
          onSelectAll={() => setConvertSelection(new Set(convertCandidates.map(d => d.id)))}
          onSelectNone={() => setConvertSelection(new Set())}
          onCancel={() => { setConvertDialogOpen(false); setConvertSelection(new Set()); }}
          onConfirm={() => void handleConvertSelected()}
          busy={converting}
          busyLabel="Converting…"
          minSelect={1}
          actionIcon={<FileText size={13} />}
          actionLabel={count => count === 1 ? 'Convert 1 file' : `Convert ${count} files`}
          ctaWhenLow="Pick at least 1"
          emptyMessage="Every document on this load is already a PDF."
          kindLabel={KIND_LABEL}
          kindTint={KIND_TINT}
          zIndex={zIndex + 60}
        />
      )}

    </>
  );
}

function Shell({ children, onClose, blocked, zIndex }: { children: React.ReactNode; onClose: () => void; blocked?: boolean; zIndex: number }) {
  // Centered modal with a dim backdrop. The closeout page stays visible
  // behind so opening the review queue doesn't feel like leaving — just
  // a focused work surface on top of the existing context. Backdrop
  // click closes; Esc is wired by the parent. When `blocked` (load
  // detail modal stacked on top), backdrop click is a no-op so the
  // user doesn't accidentally lose their queue position when the click
  // bubbles past EventModal's backdrop.
  return (
    <div className="fixed inset-0 flex items-center justify-center p-4"
      style={{ background: 'rgba(15, 23, 42, 0.55)', backdropFilter: 'blur(2px)', zIndex }}
      onMouseDown={e => { if (!blocked && e.target === e.currentTarget) onClose(); }}>
      <div
        className="flex flex-col rounded-2xl overflow-hidden"
        style={{
          // Sized so the 320px verification sidebar + two PDF columns
          // fit comfortably even on a 14" laptop. Capped to leave a
          // sliver of backdrop on ultrawides so it still reads as a
          // modal rather than a takeover.
          width:      'min(99vw, 1900px)',
          height:     'min(95vh, 1100px)',
          background: 'var(--gc-bg)',
          boxShadow:  '0 24px 64px rgba(0,0,0,0.45)',
          border:     '1px solid var(--gc-border)',
        }}>
        {children}
      </div>
    </div>
  );
}

function fmtMetaDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function Sep() {
  return <span aria-hidden="true" style={{ color: 'var(--gc-text-3)', opacity: 0.4 }}>·</span>;
}

/** Inline copy-to-clipboard for the load number; mirrors the table's
 *  CopyableLoadNum but compacted for the review queue header. */
function CopyLoadNum({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async e => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard blocked — silent */ }
      }}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors"
      style={{
        background: copied ? '#dcfce7' : 'transparent',
        color:      copied ? '#15803d' : 'var(--gc-text-2)',
        fontWeight: 600,
      }}
      title={copied ? 'Copied!' : 'Copy load #'}
      onMouseEnter={e => { if (!copied) e.currentTarget.style.background = 'var(--gc-hover)'; }}
      onMouseLeave={e => { if (!copied) e.currentTarget.style.background = 'transparent'; }}>
      #{value}
      {copied
        ? <Check size={11} style={{ color: '#15803d' }} />
        : <Copy  size={11} style={{ color: 'var(--gc-text-3)' }} />}
    </button>
  );
}

/**
 * StopsView — left-panel alternate that lists every stop on the load
 * (pickup leg + delivery leg for relays). Helps the dispatcher verify
 * delivery against the planned route when the rate-con doesn't carry
 * the appointment / facility detail clearly.
 */
function StopsView({ stops }: { stops: Stop[] }) {
  if (stops.length === 0) {
    return <NoDocPanel label="No stops on this load." />;
  }
  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-2.5" style={{ background: 'var(--gc-bg)' }}>
      {stops.map((s, i) => (
        <StopRow key={`${s.id}-${i}`} stop={s} index={i} isLast={i === stops.length - 1} />
      ))}
    </div>
  );
}

// Stop-type styling — matches the canonical palette used by
// StopsSection in the load modal so the closeout view feels like
// the same product. `color` is the darker text/border tint;
// `bg` is the pale fill version used for label chips.
const STOP_TINT: Record<string, { color: string; bg: string; label: string }> = {
  pickup:    { color: '#166534', bg: '#dcfce7', label: 'Pickup'   },
  delivery:  { color: '#991b1b', bg: '#fee2e2', label: 'Delivery' },
  drop:      { color: '#0e7490', bg: '#cffafe', label: 'Drop'     },
  drop_hook: { color: '#1e40af', bg: '#dbeafe', label: 'D&H'      },
  stop:      { color: '#92400e', bg: '#fef3c7', label: 'Stop'     },
  relay:     { color: '#6d28d9', bg: '#f5f3ff', label: 'Relay'    },
};

function StopRow({ stop, index, isLast }: { stop: Stop; index: number; isLast: boolean }) {
  const tint = STOP_TINT[stop.type] ?? STOP_TINT.stop;
  const arrived = !!stop.arrivedAt;
  const apptText = fmtApptWindow(stop.apptStart, stop.apptEnd, stop.timezone);
  const arrivedText = stop.arrivedAt ? fmtArrived(stop.arrivedAt) : null;
  return (
    <div className="relative">
      {/* Connector line between stops. Drawn at zIndex 0 so the card
          + circle (zIndex 1) sit on top of it — without explicit
          z-indexes, absolute-positioned siblings render on top of
          static ones, putting the line in front of the card. */}
      {!isLast && (
        <div style={{
          position: 'absolute',
          left:     19,
          top:      20,
          bottom:   -10,
          width:    2,
          background: 'var(--gc-border)',
          zIndex:   0,
        }} />
      )}
      <div className="flex items-start gap-3 rounded-xl p-3"
        style={{
          background: 'var(--gc-surface)',
          border:     '1px solid var(--gc-border-light)',
          boxShadow:  '0 1px 2px rgba(0,0,0,0.04)',
          position:   'relative',
          zIndex:     1,
        }}>
        {/* Type chip + sequence */}
        <div className="flex items-center justify-center font-black text-xs tabular-nums"
          style={{
            width: 40, height: 40, borderRadius: '50%',
            background: tint.color, color: '#fff',
            textShadow: '0 1px 1px rgba(0,0,0,0.25)',
            boxShadow:  '0 1px 3px rgba(0,0,0,0.15)',
            flexShrink: 0,
          }}>
          {index + 1}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{ background: tint.bg, color: tint.color }}>
              {tint.label}
            </span>
            {arrived && (
              <span className="text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded"
                style={{ background: '#dcfce7', color: '#15803d' }}>
                <CheckCircle2 size={9} style={{ display: 'inline', marginRight: 3 }} />
                Arrived
              </span>
            )}
          </div>
          {stop.facilityName && (
            <div className="text-[13px] font-bold truncate" style={{ color: 'var(--gc-text-1)' }}>
              {stop.facilityName}
            </div>
          )}
          {(stop.address || stop.city || stop.state) && (
            <div className="text-[12px] font-medium flex items-start gap-1" style={{ color: 'var(--gc-text-2)' }}>
              <MapPin size={11} style={{ flexShrink: 0, marginTop: 2 }} />
              <span className="truncate">
                {[stop.address, stop.city, stop.state].filter(Boolean).join(', ')}
              </span>
            </div>
          )}
          {apptText && (
            <div className="text-[12px] font-semibold mt-1" style={{ color: 'var(--gc-text-1)' }}>
              {apptText}
            </div>
          )}
          {arrivedText && (
            <div className="text-[11px] font-semibold" style={{ color: '#15803d' }}>
              {arrivedText}
            </div>
          )}
          {stop.instructions && (
            <div className="text-[11px] mt-1 px-2 py-1 rounded font-medium"
              style={{ background: 'var(--gc-bg)', color: 'var(--gc-text-2)' }}>
              {stop.instructions}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtApptWindow(start: string | undefined, end: string | undefined, tz: string | undefined): string {
  if (!start && !end) return '';
  const formatter = (iso: string) => {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleString('en-US', {
        month:  'short', day: 'numeric',
        hour:   'numeric', minute: '2-digit',
        ...(tz ? { timeZone: tz } : {}),
      });
    } catch {
      return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }
  };
  if (start && end && start !== end) {
    const s = formatter(start);
    const e = formatter(end);
    // Drop the date prefix on the end if it's the same day as the start.
    if (s.split(',')[0] === e.split(',')[0]) {
      const endTime = e.split(',').slice(1).join(',').trim();
      return `${s} – ${endTime}`;
    }
    return `${s} – ${e}`;
  }
  return formatter(start ?? end!);
}

function fmtArrived(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `Arrived ${d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
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

/**
 * DocSelectionDialog — popup with a list of docs and checkboxes,
 * parameterized for any "pick some, then do X" workflow. Used for
 * Merge files (≥2 selected, combines into one PDF) and Convert to
 * PDF (≥1 selected, wraps each non-PDF in its own PDF). The result
 * is appended to the doc list as new entries; originals stay.
 */
function DocSelectionDialog({
  title, description,
  docs, selected, onToggle, onSelectAll, onSelectNone, onCancel, onConfirm,
  busy, busyLabel,
  minSelect,
  actionIcon, actionLabel, ctaWhenLow,
  kindLabel, kindTint,
  emptyMessage,
  extraAction,
  manageMode,
  onAdd,
  onRename,
  onChangeKind,
  onDelete,
  onDownload,
  onMergeByType,
  kindOptions,
  pendingArea,
  zIndex = 240,
}: {
  title: string;
  description: string;
  docs: LoadDocument[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
  busyLabel: string;
  minSelect: number;
  actionIcon: React.ReactNode;
  actionLabel: (count: number) => string;
  ctaWhenLow: string;
  kindLabel: Record<string, string>;
  kindTint:  Record<string, { bg: string; fg: string }>;
  emptyMessage?: string;
  /** Optional secondary action chip rendered in the select-all bar
   *  on the right (just before the "N selected" counter). The merge
   *  dialog uses this to surface "Convert to PDF" when non-PDF docs
   *  exist; the convert dialog leaves it undefined. Keeps the dialog
   *  generic — the secondary action is owned by the caller. */
  extraAction?: React.ReactNode;
  /** When true, the dialog gains per-row management affordances:
   *  rename (pencil), change kind (kind chip becomes a native <select>),
   *  and delete (trash with inline 2-step confirm). The caller wires the
   *  callbacks below; the dialog owns the local UI state (in-flight
   *  rename draft, delete-confirm pending id). */
  manageMode?: boolean;
  /** Triggers the parent's pickFile flow. Rendered as a primary "+
   *  Add Document" button at the top of the dialog when defined. */
  onAdd?: () => void;
  /** Persist a doc's new fileName. Caller handles the optimistic
   *  update + cache refresh. */
  onRename?: (id: string, newName: string) => Promise<void>;
  /** Persist a doc's new kind. Caller handles the optimistic update.
   *  Server may auto-rename the displayed fileName. */
  onChangeKind?: (id: string, newKind: import('@fleetcal/types').DocumentKind) => Promise<void>;
  /** Hard-delete the doc + its storage blob. Caller handles the
   *  optimistic update. Dialog renders an inline two-step confirm
   *  (trash icon → red "Delete?" button → commits on second click)
   *  so we don't stack a modal-inside-a-modal. */
  onDelete?: (id: string) => Promise<void>;
  /** Per-row download — pulls bytes from the signed URL and saves
   *  via a transient <a download>. Caller handles the actual fetch
   *  (the dialog just needs to fire it). */
  onDownload?: (id: string, fileName: string) => Promise<void>;
  /** Header action — groups every doc by kind and merges each bucket
   *  with ≥2 docs into a single PDF (kind preserved). Returns
   *  `{ ok: false, error }` when nothing qualifies (or the merge
   *  failed) so the dialog can show a red inline message next to the
   *  button instead of a blocking alert. */
  onMergeByType?: () => Promise<{ ok: boolean; error?: string }>;
  /** Drives the kind <select> options in manageMode. Same shape as the
   *  parent's KIND_OPTIONS constant. ReadonlyArray so the parent's
   *  `as const` literal is assignable without a defensive copy. */
  kindOptions?: ReadonlyArray<{ kind: import('@fleetcal/types').DocumentKind; label: string; tint: { bg: string; fg: string } }>;
  /** Optional JSX rendered above the doc list. The merge dialog uses
   *  this to surface the pending-files kind picker INSIDE the dialog
   *  when "+ Add Document" was clicked from here — so the upload
   *  workflow stays in the same modal instead of bouncing the user
   *  back to the sidebar. */
  pendingArea?: React.ReactNode;
  /** Override stacking so this dialog can sit above a hoisted parent
   *  (e.g. ReviewQueue opened from the load modal at z-250). Defaults
   *  to 240 — fine for the standalone closeout page case. */
  zIndex?: number;
}) {
  const count = selected.size;
  const canConfirm = count >= minSelect && !busy;
  // Local management state — only meaningful when manageMode is true.
  //   renamingId / renameDraft: the row currently being inline-renamed
  //   deleteConfirmId:          row pending 2-step delete confirm
  //   pendingActionId:          row with an in-flight mutation (prevents
  //                             double-click; visual loader on that row)
  const [renamingId, setRenamingId]         = useState<string | null>(null);
  const [renameDraft, setRenameDraft]       = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  // Inline error shown next to the Merge by type button when the
  // user clicks it and nothing on the load has 2+ docs of the same
  // kind. Auto-clears on the next click (so retrying after adding
  // docs doesn't leave a stale error chip).
  const [mergeByTypeError, setMergeByTypeError] = useState<string | null>(null);

  const startRename = (id: string, currentName: string) => {
    // Strip the extension so the user edits only the human-readable part;
    // commit re-appends the original extension. Matches the sidebar's
    // commitRename behavior.
    const stem = currentName.replace(/\.[^.]+$/, '');
    setRenamingId(id);
    setRenameDraft(stem);
    setDeleteConfirmId(null);
  };
  const cancelRename = () => { setRenamingId(null); setRenameDraft(''); };
  const commitDialogRename = async (originalName: string) => {
    if (!onRename || !renamingId) return;
    const ext = (originalName.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase();
    const next = `${renameDraft.trim()}${ext}`;
    if (!renameDraft.trim() || next === originalName) { cancelRename(); return; }
    setPendingActionId(renamingId);
    try {
      await onRename(renamingId, next);
      cancelRename();
    } finally {
      setPendingActionId(null);
    }
  };
  const handleKindChange = async (id: string, newKind: import('@fleetcal/types').DocumentKind) => {
    if (!onChangeKind) return;
    setPendingActionId(id);
    try { await onChangeKind(id, newKind); }
    finally { setPendingActionId(null); }
  };
  const handleDeleteClick = async (id: string) => {
    if (!onDelete) return;
    if (deleteConfirmId !== id) {
      // Two-step click — first arms the confirm, second commits. Tap
      // anywhere else (or the X) to cancel.
      setDeleteConfirmId(id);
      return;
    }
    setPendingActionId(id);
    try {
      await onDelete(id);
      setDeleteConfirmId(null);
    } finally {
      setPendingActionId(null);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center px-4"
      style={{ background: 'rgba(0,0,0,0.5)', zIndex }}
      onMouseDown={e => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="rounded-2xl flex flex-col w-full"
        style={{
          maxWidth:   manageMode ? 560 : 480,
          maxHeight:  '85vh',
          background: 'var(--gc-surface)',
          boxShadow:  '0 16px 48px rgba(0,0,0,0.25)',
          border:     '1px solid var(--gc-border)',
          // overflow:hidden is load-bearing — without it the footer's
          // var(--gc-bg) background paints past the rounded corners
          // and produces square bottom corners against the rounded
          // outer modal (the ugly dark-corner artifact users were
          // seeing). Clipping at the container forces every child
          // background to respect the 16px radius.
          overflow:   'hidden',
        }}>
        {/* Header — title + close. In manage mode the "+ Add
            Documents" CTA moves to the bottom of the doc list so the
            primary upload affordance lives near where the new row
            will appear; in non-manage (Convert) mode the header
            stays compact with just the close X. */}
        <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-3">
          <div className="min-w-0">
            <div className="text-[16px] font-extrabold" style={{ color: 'var(--gc-text-1)' }}>
              {title}
            </div>
            {description && (
              <div className="text-[12px] font-medium mt-1" style={{ color: 'var(--gc-text-2)' }}>
                {description}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={onCancel} disabled={busy}
              className="p-1 rounded-full hover:bg-[var(--gc-hover)]" title="Close">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Action bar. Convert / standalone merge flows show the
            classic Select-all / None pair (driven by the footer
            confirm). Manage mode replaces both with the "Merge by
            type" chip — there's no per-row confirm action, so the
            selection-based UI would be misleading. The convert-flow
            extraAction (Convert to PDF) still slots in either layout. */}
        <div className="flex items-center gap-2 px-5 pb-2 flex-wrap">
          {!manageMode && (
            <>
              <button type="button" onClick={onSelectAll} disabled={busy || docs.length === 0}
                className="text-[11px] font-extrabold uppercase tracking-wider px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50"
                style={{ background: 'var(--gc-bg)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}>
                Select all
              </button>
              <button type="button" onClick={onSelectNone} disabled={busy}
                className="text-[11px] font-extrabold uppercase tracking-wider px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50"
                style={{ background: 'var(--gc-bg)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}>
                None
              </button>
            </>
          )}
          {manageMode && onMergeByType && docs.length >= 2 && (
            <>
              <button type="button"
                onClick={async () => {
                  setMergeByTypeError(null);
                  const result = await onMergeByType();
                  if (!result.ok && result.error) setMergeByTypeError(result.error);
                }}
                disabled={busy}
                className="flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-wider px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50"
                style={{
                  background: 'var(--gc-surface)',
                  color:      '#7c3aed',
                  border:     '1px solid #ddd6fe',
                }}
                title="Merge every document type with 2+ files into one PDF per type">
                {busy ? <Loader2 size={11} className="animate-spin" /> : <Layers size={11} />}
                Merge by type
              </button>
              {mergeByTypeError && (
                <span className="flex items-center gap-1 text-[11px] font-bold"
                  style={{ color: '#d93025' }}
                  title={mergeByTypeError}>
                  <AlertCircle size={11} />
                  {mergeByTypeError}
                </span>
              )}
            </>
          )}
          <div className="flex-1" />
          {extraAction}
          {/* The "N selected" hint only makes sense paired with the
              footer Merge action — manage mode hides both. */}
          {!manageMode && (
            <span className="text-[11px] font-bold" style={{ color: canConfirm ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}>
              {count} selected
            </span>
          )}
        </div>

        {/* Pending kind picker (manage mode only). Lives above the doc
            list so the user sees the file they just picked at the top
            of the panel. */}
        {pendingArea}

        {/* Doc list */}
        <div className="flex-1 overflow-y-auto px-5 pb-3" style={{ minHeight: 80, minWidth: 0 }}>
          {docs.length === 0 ? (
            <div className="text-[13px] italic py-8 text-center" style={{ color: 'var(--gc-text-3)' }}>
              {emptyMessage ?? 'No documents on this load.'}
            </div>
          ) : (
            <ul className="space-y-1">
              {docs.map(d => {
                const tint        = kindTint[d.kind] ?? kindTint.other;
                const isOn        = selected.has(d.id);
                const isRenaming  = renamingId === d.id;
                const isDeleting  = deleteConfirmId === d.id;
                const isPending   = pendingActionId === d.id;
                const rowDisabled = busy || (isPending && !isRenaming);
                return (
                  <li key={d.id}>
                    <div className="flex items-center gap-2 rounded-lg px-2 py-2 transition-colors"
                      style={{
                        background: isDeleting    ? '#fee2e2'
                                  : isRenaming    ? 'rgba(26,115,232,0.06)'
                                  : isOn          ? 'rgba(26,115,232,0.06)'
                                  : 'transparent',
                      }}>
                      {/* Row checkbox only renders outside manage mode —
                          the merge/convert flows need it to drive the
                          footer action. Manage mode replaces per-row
                          selection with the "Merge by type" header chip,
                          so a checkbox column would be inert noise. */}
                      {!manageMode && (
                        <input type="checkbox" checked={isOn} disabled={rowDisabled}
                          style={{ accentColor: 'var(--gc-blue)', cursor: rowDisabled ? 'not-allowed' : 'pointer' }}
                          onChange={() => onToggle(d.id)} />
                      )}

                      {/* Kind chip — static label by default, native
                          <select> dropdown in manageMode so the user can
                          change the doc's kind without leaving the dialog.
                          Native select inherits the tint background +
                          text color for visual consistency. */}
                      {manageMode && onChangeKind && kindOptions && kindOptions.length > 0 ? (
                        <select
                          value={d.kind}
                          disabled={isPending || busy || isRenaming}
                          onChange={e => void handleKindChange(d.id, e.target.value as import('@fleetcal/types').DocumentKind)}
                          className="text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-1 rounded shrink-0 cursor-pointer"
                          style={{
                            background: tint.bg,
                            color:      tint.fg,
                            border:     'none',
                            // Prevent inherited padding / appearance from
                            // bloating the chip in non-Chromium browsers.
                            appearance: 'none',
                            WebkitAppearance: 'none',
                            paddingRight: 18,
                            backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='${encodeURIComponent(tint.fg)}' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>")`,
                            backgroundRepeat:   'no-repeat',
                            backgroundPosition: 'right 4px center',
                          }}
                          title="Change document type">
                          {kindOptions.map(opt => (
                            <option key={opt.kind} value={opt.kind}>{opt.label}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                          style={{ background: tint.bg, color: tint.fg }}>
                          {kindLabel[d.kind] ?? d.kind}
                        </span>
                      )}

                      {/* Filename — inline editable in manageMode rename
                          state; otherwise a click on the row toggles the
                          checkbox via label-for. In manage mode we
                          stack the upload date under the filename so
                          the row carries enough context to find the
                          right doc when there are several PODs / lumpers
                          with similar names. */}
                      {isRenaming ? (
                        <input
                          autoFocus
                          value={renameDraft}
                          disabled={isPending}
                          onChange={e => setRenameDraft(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter')  { e.preventDefault(); void commitDialogRename(d.fileName); }
                            if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                          }}
                          onBlur={() => { if (!isPending) void commitDialogRename(d.fileName); }}
                          className="flex-1 text-[12px] font-semibold bg-transparent outline-none border-b min-w-0"
                          style={{ color: 'var(--gc-text-1)', borderColor: tint.bg }}
                        />
                      ) : (
                        <button type="button"
                          onClick={() => onToggle(d.id)}
                          disabled={rowDisabled}
                          className="flex-1 text-left min-w-0"
                          style={{ cursor: rowDisabled ? 'not-allowed' : 'pointer' }}
                          title={d.fileName}>
                          <div className="truncate text-[12px] font-semibold"
                            style={{ color: 'var(--gc-text-1)' }}>
                            {d.fileName}
                          </div>
                          {manageMode && d.uploadedAt && (
                            <div className="text-[10px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                              Uploaded {new Date(d.uploadedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                              {' · '}
                              {new Date(d.uploadedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                            </div>
                          )}
                        </button>
                      )}

                      {/* Per-row management actions — only in manageMode. */}
                      {manageMode && !isRenaming && (
                        <div className="flex items-center gap-0.5 shrink-0">
                          {isPending && (
                            <Loader2 size={12} className="animate-spin" style={{ color: 'var(--gc-text-3)' }} />
                          )}
                          {onDownload && !isPending && (
                            <button type="button"
                              onClick={e => { e.stopPropagation(); void onDownload(d.id, d.fileName); }}
                              className="rounded-full p-1 transition-colors"
                              title={`Download — ${d.fileName}`}
                              style={{ color: 'var(--gc-text-2)', background: 'transparent' }}
                              onMouseEnter={ev => (ev.currentTarget.style.background = 'var(--gc-hover)')}
                              onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}>
                              <Download size={12} />
                            </button>
                          )}
                          {onRename && !isPending && (
                            <button type="button"
                              onClick={e => { e.stopPropagation(); startRename(d.id, d.fileName); }}
                              className="rounded-full p-1 transition-colors"
                              title={`Rename — ${d.fileName}`}
                              style={{ color: tint.bg, background: 'transparent' }}
                              onMouseEnter={ev => (ev.currentTarget.style.background = tint.bg + '14')}
                              onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}>
                              <Pencil size={12} />
                            </button>
                          )}
                          {onDelete && !isPending && (
                            isDeleting ? (
                              <>
                                <button type="button"
                                  onClick={e => { e.stopPropagation(); void handleDeleteClick(d.id); }}
                                  className="rounded text-[10px] font-extrabold uppercase tracking-wider px-2 py-1 transition-colors"
                                  style={{ background: '#d93025', color: '#fff' }}
                                  title="Confirm delete">
                                  Delete
                                </button>
                                <button type="button"
                                  onClick={e => { e.stopPropagation(); setDeleteConfirmId(null); }}
                                  className="rounded-full p-1 transition-colors"
                                  title="Cancel"
                                  style={{ color: 'var(--gc-text-3)' }}
                                  onMouseEnter={ev => (ev.currentTarget.style.background = 'var(--gc-hover)')}
                                  onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}>
                                  <X size={12} />
                                </button>
                              </>
                            ) : (
                              <button type="button"
                                onClick={e => { e.stopPropagation(); void handleDeleteClick(d.id); }}
                                className="rounded-full p-1 transition-colors"
                                title={`Delete — ${d.fileName}`}
                                style={{ color: '#d93025', background: 'transparent' }}
                                onMouseEnter={ev => (ev.currentTarget.style.background = '#fce8e6')}
                                onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}>
                                <Trash2 size={12} />
                              </button>
                            )
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Bottom "+ Add Documents" — manage mode only. Sits inside
            the scrollable list area (just under the last row) so
            users land on it naturally after scanning what's already
            attached. Full-width dashed primary so it reads as a
            row-equivalent, not a footer action. */}
        {manageMode && onAdd && (
          <div className="px-5 pb-4">
            <button type="button" onClick={onAdd} disabled={busy}
              className="w-full flex items-center justify-center gap-1.5 text-[12px] font-extrabold uppercase tracking-wider px-3 py-2.5 rounded-lg transition-colors disabled:opacity-50"
              style={{
                background: 'transparent',
                color:      'var(--gc-blue)',
                border:     '1.5px dashed var(--gc-blue)',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(26,115,232,0.06)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <Plus size={13} /> Add Documents
            </button>
          </div>
        )}

        {/* Footer — manage mode is read/CRUD only, so the footer
            collapses to a single Close button. Convert + standalone
            merge flows still need their Cancel/Confirm action pair
            (they're driven by selection counts, not row-level
            mutations). */}
        {manageMode ? (
          <div className="flex items-center justify-end gap-2 px-5 py-4"
            style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
            <button type="button" onClick={onCancel} disabled={busy}
              className="text-[13px] font-extrabold px-5 py-2 rounded-lg transition-opacity text-white disabled:opacity-40"
              style={{ background: 'var(--gc-blue)' }}>
              Close
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2 px-5 py-4"
            style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
            <button type="button" onClick={onCancel} disabled={busy}
              className="text-[13px] font-bold px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}>
              Cancel
            </button>
            <button type="button"
              onClick={() => { if (canConfirm) onConfirm(); }}
              disabled={!canConfirm}
              className="flex items-center gap-1.5 text-[13px] font-extrabold px-4 py-2 rounded-lg transition-opacity text-white disabled:opacity-40"
              style={{ background: 'var(--gc-blue)' }}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : actionIcon}
              {busy ? busyLabel : count >= minSelect ? actionLabel(count) : ctaWhenLow}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
