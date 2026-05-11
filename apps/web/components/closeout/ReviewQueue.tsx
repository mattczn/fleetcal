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
import { X, ChevronLeft, ChevronRight, CheckCircle2, Flag, FileText, AlertCircle, Pin, Clock, FastForward, Copy, Check, Upload, Loader2, MessageSquare, Plus, Pencil, Trash2, MoreHorizontal } from 'lucide-react';
import type { Load, CalendarEvent } from '@/lib/types';
import type { LoadDocument } from '@/lib/db';
import { fetchLoadDocuments, getLoadDocumentSignedUrl } from '@/lib/db';
import { railway } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';
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

  const loadId = current?.loadId ?? current?.id;
  const orgId  = useCalendarStore(s => s.orgId);

  // Per-load assets cache — docs list + signed URL for every doc +
  // rate-con URL. Populated up-front for current/next/prev so prev/next
  // navigation renders instantly without a network round-trip per
  // signed URL. Rate-con and doc URLs all expire in ~1h, well past a
  // typical review session.
  const [rateConUrl, setRateConUrl] = useState<string | null>(null);
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
      setIncludedDocIds(new Set());
      return;
    }

    let cancelled = false;
    const applyAssets = (assets: LoadAssets) => {
      setDocs(assets.docs);
      setActiveDocIdx(0);
      setRateConUrl(assets.rateConUrl);
      // Default invoice selection — same heuristic as before: prior
      // saved selection wins, else PODs near delivery time.
      const deliveredAt = current?.end ? new Date(current.end).getTime() : 0;
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

  // Resolve the currently selected doc to its signed URL — preferring
  // the cached one. Falls back to a per-doc fetch only if the cache
  // doesn't have it (e.g., a freshly uploaded doc whose URL hasn't
  // been prefetched yet).
  useEffect(() => {
    if (docs.length === 0) { setActiveDocUrl(null); return; }
    const d = docs[Math.min(activeDocIdx, docs.length - 1)];
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

  // ── Internal notes ────────────────────────────────────────────────
  // Opens an InternalNotesModal on top of the review queue. We pause
  // the queue's keyboard handler while it's open so Esc / arrows /
  // Cmd+Enter all belong to the notes composer.
  const [notesOpen, setNotesOpen] = useState(false);

  // ── Doc tab actions (rename + delete) ─────────────────────────────
  // Kebab menu collapses rename + delete into a single "•••" button
  // per active tab so the strip stays compact when there are several
  // docs.
  const [tabMenuDocId, setTabMenuDocId] = useState<string | null>(null);
  // Click-outside dismissal for the kebab menu.
  useEffect(() => {
    if (!tabMenuDocId) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-tabmenu]')) setTabMenuDocId(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [tabMenuDocId]);

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
              {current.loadPrice != null && (
                <>
                  <Sep />
                  <span className="tabular-nums font-semibold" style={{ color: 'var(--gc-text-2)' }}>
                    {moneyFmt.format(current.loadPrice)}
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
                  className="flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full transition-colors"
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
                  className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full transition-colors flex-shrink-0"
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
                  const renaming = renamingDocId === d.id;
                  // Sequence among same-kind docs on this load. Only
                  // shown when there are multiples — single POD stays
                  // just "POD" but two PODs become "POD 1" / "POD 2".
                  // Filename (often a redundant restating of
                  // {loadNum}_{KIND}) goes to the tooltip instead so
                  // the tab stays compact and scannable.
                  const sameKindCount = docs.filter(x => x.kind === d.kind).length;
                  const seq           = docs.slice(0, i + 1).filter(x => x.kind === d.kind).length;
                  const labelText     = KIND_LABEL[d.kind] ?? d.kind;
                  const tabLabel      = sameKindCount > 1 ? `${labelText} ${seq}` : labelText;
                  if (renaming) {
                    // Swap the tab for an inline input. Enter commits,
                    // Esc cancels, blur commits to avoid losing input
                    // if the user clicks away.
                    return (
                      <div key={d.id} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full shrink-0"
                        style={{ background: tint.bg }}>
                        <FileText size={11} style={{ color: tint.fg }} />
                        <span className="text-[12px] font-extrabold" style={{ color: tint.fg }}>
                          {KIND_LABEL[d.kind] ?? d.kind} ·
                        </span>
                        <input
                          autoFocus
                          value={renameDraft}
                          disabled={renameSaving}
                          onChange={e => setRenameDraft(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter')  { e.preventDefault(); void commitRename(); }
                            if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                          }}
                          onBlur={() => { if (!renameSaving) void commitRename(); }}
                          className="text-[12px] font-extrabold bg-transparent outline-none border-b"
                          style={{ color: tint.fg, borderColor: 'rgba(255,255,255,0.5)', minWidth: 140, maxWidth: 240 }}
                        />
                      </div>
                    );
                  }
                  return (
                    <div key={d.id} className="flex items-center gap-1 shrink-0">
                      <button onClick={() => setActiveDocIdx(i)}
                        title={d.fileName}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-extrabold whitespace-nowrap transition-colors"
                        style={{
                          background: active ? tint.bg : 'transparent',
                          color:      active ? tint.fg : tint.bg,
                          border:     `1.5px solid ${tint.bg}`,
                        }}
                        onMouseEnter={e => { if (!active) e.currentTarget.style.background = tint.bg + '14'; }}
                        onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
                        <FileText size={11} style={{ flexShrink: 0 }} /> {tabLabel}
                      </button>
                      {active && (
                        <div className="relative" data-tabmenu>
                          <button onClick={() => setTabMenuDocId(prev => prev === d.id ? null : d.id)}
                            className="rounded-full p-1.5 transition-colors"
                            title="More"
                            style={{ color: tint.bg, background: 'transparent' }}
                            onMouseEnter={e => (e.currentTarget.style.background = tint.bg + '14')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                            <MoreHorizontal size={13} />
                          </button>
                          {tabMenuDocId === d.id && (
                            <div className="absolute right-0 top-full mt-1 rounded-xl py-1 z-30"
                              style={{
                                background: 'var(--gc-surface)',
                                border:     '1px solid var(--gc-border)',
                                boxShadow:  '0 8px 24px rgba(0,0,0,0.15)',
                                minWidth:   160,
                              }}>
                              <button onClick={() => { setTabMenuDocId(null); startRename(d.id, d.fileName); }}
                                className="w-full flex items-center gap-2 px-3 py-2 text-[12px] font-semibold text-left transition-colors hover:bg-[var(--gc-hover)]"
                                style={{ color: 'var(--gc-text-1)' }}>
                                <Pencil size={12} /> Rename
                              </button>
                              <button onClick={() => { setTabMenuDocId(null); setDeleteTarget({ id: d.id, name: d.fileName }); }}
                                className="w-full flex items-center gap-2 px-3 py-2 text-[12px] font-semibold text-left transition-colors hover:bg-[var(--gc-hover)]"
                                style={{ color: '#d93025' }}>
                                <Trash2 size={12} /> Delete
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {docs.length > 0 ? (() => {
                const active = docs[Math.min(activeDocIdx, docs.length - 1)];
                return (
                  <DocViewer
                    url={activeDocUrl ?? ''}
                    mimeType={active?.mimeType}
                    fileName={active?.fileName}
                  />
                );
              })() : <NoDocPanel label="No documents uploaded yet for this load." />}
            </div>
          </div>

          {/* Right: actions sidebar */}
          <div className="shrink-0 flex flex-col" style={{ width: 300, borderLeft: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)' }}>
            {/* Accessorials banner — surfaces detention / lumper / scale
                etc. with their amounts so the dispatcher knows what
                support docs they're verifying against. */}
            {(current.accessorials ?? []).length > 0 && (
              <div className="px-4 py-3" style={{ background: '#fef9c3', borderBottom: '1px solid #fde68a' }}>
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

            {/* Upload paperwork */}
            <div className="px-4 py-3.5" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
              <div className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--gc-text-3)' }}>
                Add paperwork
              </div>
              {pendingFiles.length === 0 ? (
                <button onClick={pickFile} disabled={uploading}
                  className="w-full flex items-center justify-center gap-2 rounded-lg text-[12px] font-semibold py-2 transition-colors"
                  style={{
                    background: 'var(--gc-bg)',
                    color:      'var(--gc-text-1)',
                    border:     '1px dashed var(--gc-border)',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-bg)')}>
                  <Upload size={13} /> Pick file{pendingFiles.length === 0 ? 's' : ''}
                </button>
              ) : (
                <div className="space-y-2">
                  {/* File list — each row has a remove button. Order
                      is the merge order, so listing top→bottom matches
                      page order in the resulting PDF. */}
                  <div className="space-y-1">
                    {pendingFiles.map((f, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-[12px] px-1.5 py-1 rounded"
                        style={{ background: 'var(--gc-bg)' }}>
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

                  {/* Merge banner — shown only for multi-file. Sets
                      expectation about what the kind chips will do. */}
                  {pendingFiles.length > 1 && (
                    <div className="text-[10px] px-2 py-1 rounded flex items-start gap-1.5"
                      style={{ background: '#e0f2fe', color: '#0c4a6e' }}>
                      <FileText size={10} style={{ marginTop: 1, flexShrink: 0 }} />
                      <span>
                        {pendingFiles.length} files will be merged into one PDF before upload.
                      </span>
                    </div>
                  )}

                  {/* Kind picker */}
                  <div className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'var(--gc-text-3)' }}>
                    {pendingFiles.length > 1 ? 'Save merged PDF as' : 'What is this?'}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {KIND_OPTIONS.map(opt => (
                      <button key={opt.kind}
                        onClick={() => void uploadAs(opt.kind)}
                        disabled={uploading}
                        className="flex items-center justify-center gap-1.5 rounded-lg text-[12px] font-black uppercase tracking-wider py-2.5 transition-opacity disabled:opacity-50"
                        style={{
                          background:  opt.tint.bg,
                          color:       opt.tint.fg,
                          boxShadow:   '0 1px 3px rgba(0,0,0,0.12)',
                          textShadow:  '0 1px 1px rgba(0,0,0,0.25)',
                        }}>
                        {uploading ? <Loader2 size={12} className="animate-spin" /> : null}
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  {/* Live merge / upload progress */}
                  {uploading && mergeStatus && (
                    <div className="text-[10px] flex items-center gap-1.5 px-2 py-1 rounded"
                      style={{ background: 'var(--gc-hover)', color: 'var(--gc-text-2)' }}>
                      <Loader2 size={10} className="animate-spin" />
                      <span className="truncate flex-1">{mergeStatus}</span>
                    </div>
                  )}
                </div>
              )}
              {uploadError && (
                <div className="mt-2 text-[11px] flex items-start gap-1" style={{ color: '#dc2626' }}>
                  <AlertCircle size={11} style={{ marginTop: 1, flexShrink: 0 }} /> {uploadError}
                </div>
              )}
              {/* Hidden file input — wired by pickFile(). multiple=true
                  so a single OS file picker can pick the whole stack. */}
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
                <div className="space-y-1.5">
                  {docs.map(d => {
                    const checked = includedDocIds.has(d.id);
                    const tint    = KIND_TINT[d.kind] ?? KIND_TINT.other;
                    return (
                      <label key={d.id} className="flex items-start gap-2 cursor-pointer rounded-lg px-1.5 py-1.5 transition-colors hover:bg-[var(--gc-hover)]">
                        <input type="checkbox" checked={checked} className="mt-1"
                          style={{ accentColor: tint.bg }}
                          onChange={() => {
                            setIncludedDocIds(prev => {
                              const next = new Set(prev);
                              if (next.has(d.id)) next.delete(d.id); else next.add(d.id);
                              return next;
                            });
                          }} />
                        <div className="flex-1 min-w-0">
                          <span className="inline-block text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded"
                            style={{ background: tint.bg, color: tint.fg }}>
                            {KIND_LABEL[d.kind] ?? d.kind}
                          </span>
                          <div className="text-[12px] font-semibold truncate mt-0.5" style={{ color: 'var(--gc-text-1)' }}>
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

      {notesOpen && (
        <InternalNotesModal
          load={current as Load}
          actorName={user?.fullName ?? user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? undefined}
          // z-[230] sits above the review queue (z-180) and any open
          // EventModal (z-200) so the notes panel is always reachable
          // and dismissible without keyboard ambiguity.
          zIndex={230}
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
          // Sits above the review queue (z-180) but below the notes
          // modal (z-230) so behavior matches expected stacking.
          zIndex={240}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const id = deleteTarget.id;
            setDeleteTarget(null);
            void handleDeleteDoc(id);
          }}
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
          // ~15% larger than the original modal sizing — still capped so
          // it doesn't span an ultrawide, but uses more of a laptop
          // screen so the PDFs render at a comfortable size.
          width:      'min(98vw, 1725px)',
          height:     'min(94vh, 1080px)',
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
