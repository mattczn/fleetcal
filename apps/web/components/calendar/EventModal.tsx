'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Trash2, Calendar, ArrowLeftRight, FileText, Loader2, CheckCircle2, AlertCircle, AlertTriangle, Copy, Eye, Paperclip, Download, Plus, Phone, MapPin, RefreshCw, Star, Clock, ExternalLink, Pin, Play, Pencil } from 'lucide-react';
import ReviewQueue from '@/components/closeout/ReviewQueue';
import FinalizedPayBanner from '@/components/payroll/FinalizedPayBanner';
import { useLoadPayFinalized } from '@/lib/useLoadPayFinalized';
import DocViewer from '@/components/closeout/DocViewer';
import LinkedWorkOrdersSection from './LinkedWorkOrdersSection';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { StyledSelect } from '@/components/ui/StyledSelect';
import { useUser } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import { usePermissions } from '@/lib/usePermissions';
import { useModules } from '@/lib/useModules';
import { useCalendarStore } from '@/store/useCalendarStore';
import Tooltip from '@/components/ui/Tooltip';
import { localDateStr, parseTimeInput } from '@/lib/time-utils';
import { isActiveOn } from '@/lib/lifecycle';
import { AssetSelect } from './AssetSelect';
import type { CalendarEvent, Driver, EventStatus, Accessorial, Stop, RefNum, LoadAuditEntry, AccessorialChange, CustomerMatchResult } from '@/lib/types';
import { NON_REVENUE_TYPES } from '@/lib/types';
import { matchCustomer } from '@/lib/customerMatch';
import { cleanBrokerName } from '@/lib/brokerName';
import { NewBrokerReviewModal } from './NewBrokerReviewModal';
import { LOAD_ACCENT, LOAD_ACCENT_BG, LOAD_ACCENT_BG_HOVER, LOAD_ACCENT_BORDER, LOAD_ACCENT_HOVER } from '@/lib/loadAccent';
import { RefNumsField } from '@/components/forms/EventModalForm';
import { CustomerCombobox } from '@/components/forms/CustomerCombobox';
import { generateLoadTitle } from '@/lib/generateTitle';
import { ALL_FIELDS, FieldDef, getEnabledFieldsForSection, SECTION_LABELS } from '@/lib/fields';
import DatePicker from './DatePicker';
import TimePicker from './TimePicker';
import StopsSection from './StopsSection';
import RelayLegsEditor, { RelayLegView, RelayHandoffView, RelayHandoffPhoto } from './RelayLegsEditor';
import { legRoleFor, legLabel, byLegIndex, handoffIndexes, handoffTimesOf, isHandoffStop } from '@fleetcal/types';
import { legStraightMiles } from '@/lib/legMiles';
import { errorToast } from '@/lib/errorToast';
import RouteMapPanel from './RouteMapPanel';
import DriverSummaryPanel from './DriverSummaryPanel';
import NotifyDriverPopover from './NotifyDriverPopover';
import { uploadRateCon } from '@/lib/storage';
import BrokerProfileModal from '@/components/brokers/BrokerProfileModal';
import CheckCallsSection from '@/components/calendar/CheckCallsSection';

const RELAY_COLOR = '#7c3aed';

/**
 * One entry of the leg plan — the ordered list of legs the dispatcher
 * is building. `eventId` is the persisted event this leg IS; absent
 * means a genuinely new leg. `key` is a stable local id so React keys
 * and the per-leg edit buffers survive re-renders and reordering.
 */
interface PlannedLeg {
  key:      string;
  eventId?: string;
}

/** Build the initial plan from the load's persisted legs, in leg order. */
function planFromLegs(legs: Array<{ id: string }>): PlannedLeg[] {
  return legs.map(l => ({ key: l.id, eventId: l.id }));
}

function driverDisplayName(d: Driver): string {
  const full = `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim();
  return full || d.name;
}

function timeAgoModal(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}


const STATUSES: { value: EventStatus; label: string; color: string; bg: string }[] = [
  { value: 'scheduled',  label: 'Scheduled',  color: '#1a73e8', bg: '#e8f0fe' },
  { value: 'assigned',   label: 'Assigned',   color: '#5b21b6', bg: '#ede9fe' },
  { value: 'dispatched', label: 'Dispatched', color: '#1558d6', bg: '#e8f0fe' },
  { value: 'en_route',   label: 'En Route',   color: '#e37400', bg: '#fef3e2' },
  { value: 'picked_up',  label: 'Picked Up',  color: '#7b1fa2', bg: '#f3e5f5' },
  { value: 'delivered',  label: 'Delivered',  color: '#188038', bg: '#e6f4ea' },
  { value: 'cancelled',  label: 'Cancelled',  color: '#d93025', bg: '#fce8e6' },
  { value: 'tonu',       label: 'TONU',       color: '#92400e', bg: '#fef3c7' },
  { value: 'problem',    label: 'Problem',    color: '#c2410c', bg: '#ffedd5' },
];

/** Thin wrapper around the shared TimePicker so the load modal's
 *  start/end time fields pick up the hour/minute popover affordance
 *  alongside the typing UX. Width + padding scale tokens match the
 *  former inline input so the pill keeps its visual proportions
 *  at every --ui-scale preset. */
function SmartTimeInput({ value, onChange, headerColor }: {
  value: string; onChange: (v: string) => void; placeholder?: string; headerColor: string;
}) {
  return (
    <TimePicker
      value={value}
      onChange={onChange}
      headerColor={headerColor}
      inputWidth={'calc(100px * var(--ui-scale, 1))'}
      inputStyle={{
        padding: 'calc(8.5px * var(--ui-scale, 1)) calc(11px * var(--ui-scale, 1))',
        fontSize: 'calc(13.5px * var(--ui-scale, 1))',
      }}
    />
  );
}

function inputStyle(): React.CSSProperties {
  // Field sizing follows the surrounding `.ui-scale-scope --ui-scale`
  // (set by the modal root from Settings → Appearance → Calendar card
  // text). Base values dropped from 10/12 padding · 15 font to
  // 8.5/11 padding · 13.5 font so fields read a touch tighter on a
  // laptop and line up with the modal's new text-base default. Outside
  // a scoped surface the var falls back to 1 so other callers keep
  // their original feel.
  return {
    border: '1px solid var(--gc-border)',
    borderRadius: 8,
    padding: 'calc(8.5px * var(--ui-scale, 1)) calc(11px * var(--ui-scale, 1))',
    fontSize: 'calc(13.5px * var(--ui-scale, 1))',
    color: 'var(--gc-text-1)',
    outline: 'none',
    background: 'var(--gc-surface)',
    width: '100%',
    transition: 'border-color 150ms',
    cursor: 'auto',
  };
}

function CopyLabelBtn({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button"
      onClick={() => { navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
      title={copied ? 'Copied!' : 'Copy'}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 20, height: 20, borderRadius: 4, marginLeft: 4,
        cursor: 'pointer',
        border: '1px solid var(--gc-border)',
        background: 'var(--gc-bg)',
        color: copied ? '#15803d' : 'var(--gc-text-3)',
        transition: 'color 120ms, background 120ms',
      }}
      onMouseEnter={e => { if (!copied) e.currentTarget.style.background = 'var(--gc-hover)'; }}
      onMouseLeave={e => { if (!copied) e.currentTarget.style.background = 'var(--gc-bg)'; }}>
      {copied ? <CheckCircle2 size={11} /> : <Copy size={11} />}
    </button>
  );
}

// Driver phone row under the driver picker. Click to copy. Brief
// "Copied!" feedback for 1.5s; falls back to silent no-op if clipboard
// API isn't available (very old Safari, etc.).
function DriverPhoneCopy({ phone }: { phone: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = () => {
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(phone).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button type="button" onClick={onClick}
      title={copied ? 'Copied!' : 'Click to copy'}
      className="mt-1.5 text-xs flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors"
      style={{ color: copied ? '#15803d' : 'var(--gc-text-3)', background: 'transparent', border: 'none', cursor: 'pointer' }}
      onMouseEnter={e => { if (!copied) e.currentTarget.style.background = 'var(--gc-hover)'; }}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      <Phone size={11} />
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{phone}</span>
      {copied && (
        <span style={{ fontSize: 10, fontWeight: 700, marginLeft: 4 }}>✓</span>
      )}
    </button>
  );
}

const BLOCKED_REF_LABELS = new Set(['mc', 'dot', 'mc number', 'dot number', 'mc#', 'dot#', 'mc no', 'dot no']);
const BLANK_REF_VALUES   = new Set(['', 'n/a', 'na', 'none', '-', '--', 'unknown', 'tbd', 'n/a.', 'not available']);

function isValidRefNum(r: RefNum): boolean {
  if (BLOCKED_REF_LABELS.has(r.label.toLowerCase().trim())) return false;
  const v = r.value.toLowerCase().trim();
  if (!v || BLANK_REF_VALUES.has(v)) return false;
  return true;
}

function parseAiRefNums(raw: unknown): RefNum[] {
  let result: RefNum[];
  if (Array.isArray(raw)) {
    if (raw.length === 0) return [];
    if (typeof raw[0] === 'object' && raw[0] !== null && 'value' in raw[0]) result = raw as RefNum[];
    else result = (raw as string[]).filter(Boolean).map(v => ({ label: '', value: String(v) }));
  } else {
    const str = String(raw ?? '').trim();
    if (!str) return [];
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) return parseAiRefNums(parsed);
    } catch { /* not JSON */ }
    result = str.split(',').map(s => s.trim()).filter(Boolean).map(v => ({ label: '', value: v }));
  }
  return result.filter(isValidRefNum);
}

/**
 * Safety-net for the rate-con AI parser: snap any stop appointment
 * dates that fall outside the load's [start, end] window back into
 * range, preserving the time-of-day.
 *
 * Why: the model usually nails start/end (those come from the load
 * confirmation header) but occasionally drifts on per-stop dates,
 * producing rate cons where load = 6/4–6/5 but pickup stop = 6/7
 * and delivery stop = 6/8 (real recurring failure mode observed in
 * production). The prompt has explicit consistency rules now, but
 * this catches the cases where the model ignores them.
 *
 * Heuristic per stop:
 *   - If the date is already inside [startDate, endDate] inclusive,
 *     leave it alone — the AI's stop date is trusted within range.
 *   - Otherwise, snap the date to the closest valid date in the
 *     window AND preserve the original HH:mm. First stop snaps to
 *     startDate, last stop snaps to endDate, intermediates snap to
 *     whichever bound they're closer to.
 *   - Apply to both apptStart and apptEnd.
 *
 * Returns a NEW stops array; the input is not mutated. If start or
 * end can't be parsed, returns the input unchanged (no false
 * corrections on partial extractions).
 */
function snapStopsToLoadWindow<S extends { apptStart?: string; apptEnd?: string }>(
  stops: S[],
  start: string | undefined,
  end:   string | undefined,
): S[] {
  if (!stops.length || !start || !end) return stops;
  const startDate = start.split('T')[0];
  const endDate   = end.split('T')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return stops;
  // String comparison works for YYYY-MM-DD — lexicographic order ==
  // chronological order. No Date parsing needed (and no TZ surprises).
  const inWindow = (d: string) => d >= startDate && d <= endDate;
  const snap = (iso: string, isFirst: boolean, isLast: boolean): string => {
    const [d, t] = iso.split('T');
    if (!d || inWindow(d)) return iso;
    // Pick the target date based on which end of the load the stop
    // belongs to. Mid-load stops snap to the closer bound by string
    // distance, which matches calendar distance for adjacent days.
    let target: string;
    if (isFirst) target = startDate;
    else if (isLast) target = endDate;
    else target = (d < startDate) ? startDate : endDate;
    return t ? `${target}T${t}` : target;
  };
  return stops.map((s, i) => {
    const isFirst = i === 0;
    const isLast  = i === stops.length - 1;
    const next: S = { ...s };
    if (s.apptStart) next.apptStart = snap(s.apptStart, isFirst, isLast);
    if (s.apptEnd)   next.apptEnd   = snap(s.apptEnd,   isFirst, isLast);
    return next;
  });
}


function Field({ label, labelSuffix, children }: { label: string; labelSuffix?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <label className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
          {label}
        </label>
        {labelSuffix}
      </div>
      {children}
    </div>
  );
}

/**
 * Inline chip rendered beneath a Driver / Asset select when the user
 * picked a value whose preferred partner differs from the current
 * partner-field value. Click the label/Switch button to apply,
 * click ✕ to dismiss. Used only in edit mode — new loads auto-apply
 * the partner swap silently (no chip needed).
 */
function SuggestionChip({ label, onApply, onDismiss }: { label: string; onApply: () => void; onDismiss: () => void }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 4px 4px 10px',
        background: 'var(--gc-blue-light)',
        color: 'var(--gc-blue)',
        borderRadius: 999,
        border: '1px solid #c6dafc',
        fontWeight: 600,
        fontSize: 12,
        flexShrink: 0,
        whiteSpace: 'nowrap',
      }}>
      <span>{label}</span>
      <button type="button" onClick={onApply}
        className="rounded-full px-2 py-0.5 transition-colors"
        style={{ background: 'var(--gc-blue)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}
        onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-blue-hover)')}
        onMouseOut={e => (e.currentTarget.style.background = 'var(--gc-blue)')}>
        Switch
      </button>
      <button type="button" onClick={onDismiss}
        title="Dismiss"
        className="rounded-full transition-colors"
        style={{ background: 'transparent', color: 'var(--gc-blue)', border: 'none', cursor: 'pointer', width: 18, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
        onMouseOver={e => (e.currentTarget.style.background = 'rgba(26,115,232,0.15)')}
        onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
        <X size={11} />
      </button>
    </div>
  );
}

/** Number input prefixed with $. Empty string = unset (omitted on save). */
function NumberInputWithDollar({ value, onChange, headerColor, disabled, disabledTitle }: {
  value: number | '';
  onChange: (v: number | '') => void;
  headerColor: string;
  disabled?: boolean;
  disabledTitle?: string;
}) {
  return (
    <div style={{ position: 'relative' }}>
      <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--gc-text-3)', fontSize: 13, pointerEvents: 'none' }}>$</span>
      <input
        type="number"
        inputMode="decimal"
        step="0.01"
        value={value}
        disabled={disabled}
        title={disabled ? disabledTitle : undefined}
        onChange={e => {
          const raw = e.target.value;
          if (raw === '') onChange('');
          else {
            const n = parseFloat(raw);
            onChange(Number.isFinite(n) ? n : '');
          }
        }}
        placeholder="0.00"
        className="w-full rounded-lg outline-none text-sm"
        style={{
          border: '1px solid var(--gc-border)',
          padding: '8px 10px 8px 22px',
          color: disabled ? 'var(--gc-text-3)' : 'var(--gc-text-1)',
          background: disabled ? '#f1f5f9' : 'var(--gc-surface)',
          cursor: disabled ? 'not-allowed' : 'text',
        }}
        onFocus={e => { if (!disabled) e.currentTarget.style.borderColor = headerColor; }}
        onBlur={e => { if (!disabled) e.currentTarget.style.borderColor = 'var(--gc-border)'; }}
      />
    </div>
  );
}

const PDF_ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];

// Renders a PDF data URL to canvas elements via PDF.js with zoom controls.
function UploadedDocsPanel({
  docs, invoices, selectedId, onSelect, signedUrl, headerColor, loadId, onChange, onSignedUrlError, onPendingChange, legacyDocIds,
}: {
  docs: import('@/lib/db').LoadDocument[];
  /** Set of doc ids that should render with a "Legacy" tag next to
   *  the kind chip. EventModal passes the ids of all `kind='rate_con'`
   *  rows other than the current primary, so the user sees prior
   *  rate-cons in the Documents panel with a clear label. */
  legacyDocIds?: Set<string>;
  /** Generated invoices for this load. Rendered as virtual rows at the
   *  top of the docs list — clicking opens /accounting/invoices/[id]
   *  in a new tab so the load modal stays open underneath. */
  invoices?: import('@fleetcal/types').Invoice[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  signedUrl: string | null;
  headerColor: string;
  /** Required for upload + delete. Without it, the panel renders
   *  read-only — covers the create-mode case where no load exists yet. */
  loadId?: string;
  /** Fires after a successful upload or delete so the parent can
   *  re-fetch the docs list. */
  onChange?: () => void;
  /** Fires when the <img> / <iframe> fails to render — almost always a
   *  stale signed URL. Parent re-mints and pushes a fresh `signedUrl`
   *  back in via props on the next render. */
  onSignedUrlError?: () => void;
  /** Fires whenever the staged-file state changes (true = a file has
   *  been picked but no type chosen yet). EventModal listens so it can
   *  show a "you have a doc waiting for a type" dialog if the user
   *  tries to close the load modal mid-upload. */
  onPendingChange?: (hasPending: boolean) => void;
}) {
  const addFileRef = useRef<HTMLInputElement>(null);
  // Two-stage upload: pick file → choose kind → commit. Pending file
  // stays in state so the user can change kind without re-picking.
  const [pendingFile,   setPendingFile]   = useState<File | null>(null);
  // Bubble pendingFile state up so the load modal can intercept its
  // close path and prompt the user — otherwise the staged file is
  // silently dropped if they tap X mid-upload.
  useEffect(() => { onPendingChange?.(pendingFile !== null); }, [pendingFile, onPendingChange]);
  const [uploading,     setUploading]     = useState(false);
  const [uploadError,   setUploadError]   = useState<string | null>(null);
  const [deletingId,    setDeletingId]    = useState<string | null>(null);
  // Tracks signed URLs we've already asked the parent to refresh so a
  // broken/expired URL only triggers ONE refetch — otherwise an asset
  // that's genuinely missing (deleted from storage) would loop forever
  // between <img onError> and the parent re-minting the same dead URL.
  const refreshedUrlsRef = useRef<Set<string>>(new Set());
  // Per-doc render diagnosis. Populated when the <img> fires onError
  // AND the refresh-once retry has been exhausted — we then fetch the
  // first 16 bytes off the signed URL and sniff the magic number to
  // figure out what the file actually is. The #1 cause of "this one
  // JPG won't render but others do" is an iPhone HEIC saved with a
  // .jpg extension — browsers don't decode HEIC, so showing the user
  // a clear message ("This is HEIC, not JPG — please re-upload as
  // JPG or PNG") is much better than a broken-image glyph.
  const [previewError, setPreviewError] = useState<{
    docId: string;
    kind: 'heic' | 'empty' | 'http' | 'unknown';
    detail: string;
  } | null>(null);

  // Best-effort byte sniffer. Reads the first chunk of the response
  // body and matches against well-known magic numbers. Runs once per
  // doc — gated by the docId compare in the onError handler.
  const diagnosePreview = useCallback(async (docId: string, url: string) => {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        setPreviewError({ docId, kind: 'http', detail: `HTTP ${res.status}` });
        return;
      }
      const blob = await res.blob();
      if (blob.size === 0) {
        setPreviewError({ docId, kind: 'empty', detail: '0 bytes' });
        return;
      }
      const buf = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
      // HEIC/HEIF: bytes 4–11 spell "ftyp" + brand code (heic, heix,
      // mif1, msf1, hevc, hevx). The first 4 bytes are the box length
      // and are arbitrary, so we anchor on offset 4.
      const isFtyp = buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
      if (isFtyp) {
        const brand = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]);
        const heicBrands = new Set(['heic', 'heix', 'mif1', 'msf1', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);
        if (heicBrands.has(brand)) {
          setPreviewError({ docId, kind: 'heic', detail: `HEIC (brand: ${brand})` });
          return;
        }
      }
      // JPG starts with FF D8 FF — if we got here with a valid JPG the
      // browser's decoder choked on something inside (corrupt EXIF,
      // truncated, etc.). Show the bytes so it can be reported.
      const hex = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join(' ');
      setPreviewError({ docId, kind: 'unknown', detail: `bytes: ${hex}` });
    } catch (err) {
      setPreviewError({ docId, kind: 'unknown', detail: (err as Error).message });
    }
  }, []);
  // Inline kind editor — when the user clicks the pencil on a row,
  // an inline chip picker appears under that row. Server auto-renames
  // the fileName when kind changes (PATCH /v1/documents/:id), so a
  // 45280_POD.pdf flipped to BOL becomes 45280_BOL.pdf in one action.
  const [editingDocId,  setEditingDocId]  = useState<string | null>(null);
  const [savingEdit,    setSavingEdit]    = useState(false);

  // Rate Con is intentionally NOT in the Uploaded tab's kind picker —
  // rate cons have a dedicated upload path (the "+ Add Rate Con" CTA on
  // the Rate Con tab) and a dedicated storage bucket. Allowing them
  // here was the source of the misclick leaks reported earlier: a
  // dispatcher would pick a rate-con PDF and accidentally classify it
  // as POD or Other, which then surfaced to drivers.
  const orgDocumentTypes = useCalendarStore((s) => s.documentTypes);
  const KIND_UPLOAD_OPTIONS = useMemo(() => {
    const all: ReadonlyArray<{ kind: import('@fleetcal/types').DocumentKind; label: string }> = [
      { kind: 'pod',           label: 'POD' },
      { kind: 'bol',           label: 'BOL' },
      { kind: 'lumper',        label: 'Lumper' },
      { kind: 'scale',         label: 'Scale' },
      { kind: 'receipt',       label: 'Receipt' },
      { kind: 'driver_sheet',  label: 'Driver Sheet' },
      { kind: 'invoice',       label: 'Invoice' },
      { kind: 'relay_handoff', label: 'Relay Handoff' },
      { kind: 'other',         label: 'Other' },
    ];
    // Filter by the org's enabled kinds (Settings → Documents). When
    // documentTypes hasn't hydrated yet (null) we show everything so a
    // slow settings fetch doesn't briefly hide options.
    if (!orgDocumentTypes) return all;
    const enabledSet = new Set(orgDocumentTypes.filter(t => t.enabled).map(t => t.kind));
    return all.filter(opt => enabledSet.has(opt.kind));
  }, [orgDocumentTypes]);

  const uploadAs = async (kind: import('@fleetcal/types').DocumentKind) => {
    if (!pendingFile || !loadId || uploading) return;
    setUploading(true);
    setUploadError(null);
    try {
      const { railway } = await import('@/lib/railway');
      // Suppress the "another dispatcher" banner on our own realtime echo.
      useCalendarStore.getState().markLoadSelfWrite(loadId);
      await railway.uploadLoadDocument(loadId, pendingFile, kind);
      setPendingFile(null);
      onChange?.();
    } catch (err) {
      console.error('[UploadedDocsPanel] upload failed:', err);
      setUploadError((err as Error).message ?? 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  // Doc delete — actual call is split from the trigger so we can route
  // the trigger through the ConfirmDialog (styled yes/no surface). The
  // dialog state lives on `deleteTarget`; on confirm we call this.
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const performDelete = async (docId: string) => {
    if (!loadId) return;
    setDeletingId(docId);
    try {
      const { railway } = await import('@/lib/railway');
      // Suppress realtime echo so the dispatcher who just deleted
      // doesn't see "updated by another dispatcher" pop on themselves.
      useCalendarStore.getState().markLoadSelfWrite(loadId);
      await railway.deleteDocument(docId);
      onSelect(null);
      onChange?.();
    } catch (err) {
      console.error('[UploadedDocsPanel] delete failed:', err);
      alert(`Delete failed: ${(err as Error).message ?? 'Unknown error'}`);
    } finally {
      setDeletingId(null);
    }
  };

  // Save a kind change for the doc currently being edited. PATCH auto-
  // renames the fileName to match the new kind, so we don't compute the
  // name client-side. After saving we mark the load as a self-write so
  // the realtime echo from this PATCH doesn't pop the conflict banner,
  // then onChange? to refetch the docs list.
  const saveKindEdit = async (docId: string, nextKind: import('@fleetcal/types').DocumentKind) => {
    if (savingEdit) return;
    setSavingEdit(true);
    try {
      const { railway } = await import('@/lib/railway');
      if (loadId) useCalendarStore.getState().markLoadSelfWrite(loadId);
      await railway.updateDocumentKind(docId, nextKind);
      setEditingDocId(null);
      onChange?.();
    } catch (err) {
      console.error('[UploadedDocsPanel] kind update failed:', err);
      alert(`Update failed: ${(err as Error).message ?? 'Unknown error'}`);
    } finally {
      setSavingEdit(false);
    }
  };

  // Doc category styling — solid fill + white text, same as calendar
  // event cards. Mirror of KIND_TINT in closeout ReviewQueue. Keeping
  // them in sync is a manual chore but extracting a shared module
  // would mean cross-component coupling without much payoff.
  const KIND_TINT: Record<string, { bg: string; fg: string }> = {
    rate_con:      { bg: '#5b21b6', fg: '#fff' },  // Indigo
    pod:           { bg: '#188038', fg: '#fff' },  // Google green
    bol:           { bg: '#1a73e8', fg: '#fff' },  // Google blue
    scale:         { bg: '#e37400', fg: '#fff' },  // Google orange
    lumper:        { bg: '#a16207', fg: '#fff' },  // Amber, darkened for white text
    receipt:       { bg: '#c2185b', fg: '#fff' },  // Pink
    driver_sheet:  { bg: '#00838f', fg: '#fff' },  // Teal
    invoice:       { bg: '#7b1fa2', fg: '#fff' },  // Purple
    relay_handoff: { bg: '#6b21a8', fg: '#fff' },  // Purple (matches relay banner)
    other:         { bg: '#5f6368', fg: '#fff' },  // Gray
  };
  const KIND_LABEL: Record<string, string> = {
    rate_con:      'Rate Con',
    pod:           'POD',
    bol:           'BOL',
    scale:         'Scale',
    lumper:        'Lumper',
    receipt:       'Receipt',
    driver_sheet:  'Driver Sheet',
    invoice:       'Invoice',
    relay_handoff: 'Relay Handoff',
    other:         'Other',
  };
  const fmt = (iso: string) => new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const isImage = (mime?: string, name?: string) =>
    (mime ?? '').startsWith('image/') || /\.(jpe?g|png|webp|heic)$/i.test(name ?? '');

  const selected = selectedId ? docs.find(d => d.id === selectedId) ?? null : null;

  // Drop stale preview diagnostics when the user switches docs — the
  // diagnosis is keyed by docId but clearing eagerly avoids a flicker
  // where the previous error briefly shows for the wrong doc.
  useEffect(() => {
    if (!selected || (previewError && previewError.docId !== selected.id)) {
      setPreviewError(null);
    }
  }, [selected, previewError]);

  // Upload header — always rendered when loadId is known so the user
  // can add docs even from the empty state.
  const uploadHeader = loadId ? (
    <div className="shrink-0 px-3 py-2"
      style={{ background: 'var(--gc-surface)', borderBottom: '1px solid var(--gc-border-light)' }}>
      {!pendingFile ? (
        <button onClick={() => addFileRef.current?.click()}
          type="button"
          className="w-full flex items-center justify-center gap-1.5 text-[12px] font-semibold py-1.5 rounded-lg transition-colors"
          style={{ color: 'var(--gc-text-2)', background: 'var(--gc-bg)', border: '1px dashed var(--gc-border)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-bg)')}>
          <Plus size={12} /> Add document
        </button>
      ) : (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[12px]">
            <FileText size={11} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />
            <span className="truncate flex-1" title={pendingFile.name} style={{ color: 'var(--gc-text-1)' }}>
              {pendingFile.name}
            </span>
            <button onClick={() => { setPendingFile(null); setUploadError(null); }} type="button"
              className="p-0.5 rounded hover:bg-[var(--gc-hover)]" title="Cancel">
              <X size={11} style={{ color: 'var(--gc-text-3)' }} />
            </button>
          </div>
          <div className="text-[11px] uppercase tracking-wider font-extrabold" style={{ color: 'var(--gc-text-2)' }}>
            What is this?
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {KIND_UPLOAD_OPTIONS.map(opt => {
              const tint = KIND_TINT[opt.kind] ?? KIND_TINT.other;
              return (
                <button key={opt.kind} type="button"
                  onClick={() => void uploadAs(opt.kind)}
                  disabled={uploading}
                  className="flex items-center justify-center gap-1 rounded-lg text-[11px] font-black uppercase tracking-wider py-2 transition-opacity disabled:opacity-50"
                  style={{
                    background: tint.bg,
                    color:      tint.fg,
                    boxShadow:  '0 1px 3px rgba(0,0,0,0.12)',
                    textShadow: '0 1px 1px rgba(0,0,0,0.25)',
                  }}>
                  {uploading ? <Loader2 size={11} className="animate-spin" /> : null}
                  {opt.label}
                </button>
              );
            })}
          </div>
          {uploadError && (
            <div className="text-[10px] flex items-start gap-1" style={{ color: '#d93025' }}>
              <AlertCircle size={10} style={{ marginTop: 1, flexShrink: 0 }} /> {uploadError}
            </div>
          )}
        </div>
      )}
      <input ref={addFileRef} type="file" accept=".pdf,application/pdf,image/*"
        style={{ display: 'none' }}
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) { setPendingFile(f); setUploadError(null); }
          e.target.value = '';
        }} />
    </div>
  ) : null;

  // Virtual rows for generated invoices. Rendered as siblings of the
  // uploaded docs so the user sees one unified list of artifacts on the
  // load. Click opens the accounting page in a new tab — the load modal
  // stays mounted underneath.
  //
  // Dedupe: an invoice that's been persisted to load_documents (Phase 4)
  // already shows up as a real row via `docs`. Drop the virtual entry
  // for those — the persisted PDF is the canonical one and supports
  // direct view/download without leaving the modal. We only render
  // virtual rows for invoices that haven't been archived yet (e.g. when
  // the load_documents.invoice_id migration hasn't been applied).
  const persistedInvoiceIds = new Set(
    docs
      .filter(d => d.kind === 'invoice' && d.invoiceId)
      .map(d => d.invoiceId as string),
  );
  const invoiceRows = (invoices ?? []).filter(inv => !persistedInvoiceIds.has(inv.id));
  const invoiceTint = KIND_TINT.invoice ?? KIND_TINT.other;

  const renderInvoiceRows = () => invoiceRows.map((inv) => (
    <a key={`inv-${inv.id}`} href={`/accounting/invoices/${inv.id}`} target="_blank" rel="noopener noreferrer"
      className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors"
      style={{ borderBottom: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)', textDecoration: 'none' }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-surface)')}>
      <div className="flex items-center justify-center" style={{ width: 36, height: 36, borderRadius: 8, background: invoiceTint.bg, flexShrink: 0, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
        <FileText size={16} style={{ color: invoiceTint.fg }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2" style={{ marginBottom: 2 }}>
          <span className="text-[10px] font-extrabold uppercase tracking-wider" style={{ color: invoiceTint.fg, background: invoiceTint.bg, padding: '2px 7px', borderRadius: 999 }}>
            Invoice
          </span>
          <span className="text-[10px] font-extrabold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)', border: '1px solid var(--gc-border-light)', padding: '1px 6px', borderRadius: 999 }}>
            {/* DB enum says 'draft' but the PDF is final the moment it
                exists — surface that to the user as 'Unsent' instead. */}
            {inv.status === 'draft' ? 'Unsent' : inv.status}
          </span>
        </div>
        <div className="text-sm font-bold truncate" style={{ color: 'var(--gc-text-1)' }}>
          Invoice #{inv.invoiceNumber} · ${inv.total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        <div className="text-xs font-medium" style={{ color: 'var(--gc-text-3)' }}>
          Issued {fmt(inv.issuedAt)}{inv.sentAt ? ` · Sent ${fmt(inv.sentAt)}` : ''}{inv.paidAt ? ` · Paid ${fmt(inv.paidAt)}` : ''}
        </div>
      </div>
    </a>
  ));

  if (docs.length === 0 && invoiceRows.length === 0) {
    // Empty state mirrors the Rate Con tab — centered icon + hint copy
    // + a single primary "+ Add Documents" CTA tinted with the asset's
    // headerColor. Once the user picks a file the empty state stays
    // visible but we mount `uploadHeader` at the top so the kind
    // picker ("What is this?" + chips) renders — without it the click
    // on "+ Add Documents" appeared to do nothing because the empty
    // state had no surface for the post-pick step.
    return (
      <div className="flex-1 flex flex-col" style={{ background: 'var(--gc-bg)' }}>
        {/* Kind picker — only renders when a file is queued. Same
            JSX `uploadHeader` uses in the list/viewer branches, so
            the pending-file → choose-kind → upload flow is identical
            across all three rendering branches. */}
        {pendingFile && uploadHeader}
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="flex items-center justify-center" style={{ width: 56, height: 56, borderRadius: 14, background: `${headerColor}15`, color: headerColor }}>
            <FileText size={26} />
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--gc-text-2)' }}>
            {pendingFile ? 'Choose a document type above to upload' : 'No Documents uploaded for this load yet'}
          </div>
          {loadId && !pendingFile && (
            <button type="button" onClick={() => addFileRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all"
              style={{ color: 'white', background: headerColor, border: `1px solid ${headerColor}` }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.9')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
              <Plus size={14} /> Add Documents
            </button>
          )}
        </div>
        {/* Hidden file input lives at the empty-state root so the
            centered "+ Add Documents" button has something to click
            even when uploadHeader (which mounts its own copy) isn't
            rendered yet. Once a file is picked, this input
            unmounts and uploadHeader's copy takes over via the same
            addFileRef. */}
        {loadId && !pendingFile && (
          <input ref={addFileRef} type="file" accept=".pdf,application/pdf,image/*"
            style={{ display: 'none' }}
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) { setPendingFile(f); setUploadError(null); }
              e.target.value = '';
            }} />
        )}
      </div>
    );
  }

  // List view — when no doc is selected
  if (!selected) {
    return (
      <div className="flex-1 flex flex-col" style={{ background: 'var(--gc-bg)' }}>
        {uploadHeader}
        <div className="flex-1 overflow-y-auto">
        {renderInvoiceRows()}
        {docs.map((d) => {
          const tint = KIND_TINT[d.kind] ?? KIND_TINT.other;
          return (
            <div key={d.id} style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
              <div className="w-full flex items-center gap-3 px-4 py-3 transition-colors" style={{ background: 'var(--gc-surface)' }}>
                <button type="button" onClick={() => onSelect(d.id)}
                  className="flex items-center gap-3 text-left flex-1 min-w-0"
                  style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}>
                  <div className="flex items-center justify-center" style={{ width: 36, height: 36, borderRadius: 8, background: tint.bg, flexShrink: 0, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
                    <FileText size={16} style={{ color: tint.fg }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2" style={{ marginBottom: 2 }}>
                      <span className="text-[10px] font-extrabold uppercase tracking-wider" style={{ color: tint.fg, background: tint.bg, padding: '2px 7px', borderRadius: 999 }}>
                        {KIND_LABEL[d.kind] ?? d.kind}
                      </span>
                      {/* "Legacy" tag — the kind chip stays "Rate Con"
                          so search / sort still treats this as a
                          rate-con; the orange Legacy pill makes the
                          state visible at a glance. */}
                      {legacyDocIds?.has(d.id) && (
                        <span className="text-[10px] font-extrabold uppercase tracking-wider"
                          style={{
                            color: '#9a3412', background: '#ffedd5',
                            border: '1px solid #fdba74',
                            padding: '2px 7px', borderRadius: 999,
                          }}
                          title="Older rate-con kept on the load for reference. The current primary rate-con shows in the Rate Con tab.">
                          Legacy
                        </span>
                      )}
                    </div>
                    <div className="text-sm font-bold truncate" style={{ color: 'var(--gc-text-1)' }}>{d.fileName}</div>
                    <div className="text-xs font-medium" style={{ color: 'var(--gc-text-3)' }}>{fmt(d.uploadedAt)}</div>
                  </div>
                </button>
                {/* Per-card action group: Download · Edit (change type) · Delete.
                    Lets the user manage a doc without opening the viewer.
                    Edit kind toggles the inline picker below; Delete + Download
                    follow the same flow the in-viewer buttons use so the wire
                    behavior is identical. Hidden when no loadId (create-mode
                    rendering of the panel — docs aren't attached anywhere yet). */}
                {loadId && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Tooltip content="Download">
                      <button type="button"
                        onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            const { railway } = await import('@/lib/railway');
                            const { url } = await railway.getDocumentUrl(d.id);
                            if (!url) return;
                            const res = await fetch(url);
                            const blob = await res.blob();
                            const blobUrl = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = blobUrl;
                            a.download = d.fileName;
                            document.body.appendChild(a);
                            a.click();
                            a.remove();
                            setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
                          } catch (err) {
                            console.error('[doc download from card] failed', err);
                          }
                        }}
                        className="flex items-center justify-center transition-colors"
                        style={{
                          width: 28, height: 28, borderRadius: 8,
                          color: 'var(--gc-text-3)',
                          background: 'transparent',
                          border: '1px solid var(--gc-border-light)',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                        <Download size={12} />
                      </button>
                    </Tooltip>
                    <Tooltip content={editingDocId === d.id ? 'Cancel' : 'Change type'}>
                      <button type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingDocId(prev => prev === d.id ? null : d.id);
                        }}
                        className="flex items-center justify-center transition-colors"
                        style={{
                          width: 28, height: 28, borderRadius: 8,
                          color: editingDocId === d.id ? LOAD_ACCENT : 'var(--gc-text-3)',
                          background: editingDocId === d.id ? LOAD_ACCENT_BG : 'transparent',
                          border: `1px solid ${editingDocId === d.id ? LOAD_ACCENT_BORDER : 'var(--gc-border-light)'}`,
                        }}
                        onMouseEnter={e => { if (editingDocId !== d.id) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                        onMouseLeave={e => { if (editingDocId !== d.id) e.currentTarget.style.background = 'transparent'; }}>
                        <Pencil size={12} />
                      </button>
                    </Tooltip>
                    <Tooltip content="Delete">
                      <button type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget({ id: d.id, name: d.fileName });
                        }}
                        className="flex items-center justify-center transition-colors"
                        style={{
                          width: 28, height: 28, borderRadius: 8,
                          color: 'var(--gc-text-3)',
                          background: 'transparent',
                          border: '1px solid var(--gc-border-light)',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = '#fee2e2'; e.currentTarget.style.color = '#d93025'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent';  e.currentTarget.style.color = 'var(--gc-text-3)'; }}>
                        <Trash2 size={12} />
                      </button>
                    </Tooltip>
                  </div>
                )}
              </div>
              {editingDocId === d.id && (
                <div style={{ padding: '8px 14px 12px', background: 'var(--gc-bg)', borderTop: '1px solid var(--gc-border-light)' }}>
                  <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)', marginBottom: 6 }}>
                    Change document type
                  </div>
                  {/* Mirror the upload "WHAT IS THIS?" picker — same
                      3-column grid of tinted pill buttons so the
                      change-type flow visually matches the create
                      flow. The active kind shows a check + dims to
                      muted styling to signal "you're already here." */}
                  <div className="grid grid-cols-3 gap-1.5">
                    {KIND_UPLOAD_OPTIONS.map(opt => {
                      const tint   = KIND_TINT[opt.kind] ?? KIND_TINT.other;
                      const active = opt.kind === d.kind;
                      return (
                        <button key={opt.kind} type="button"
                          disabled={savingEdit || active}
                          onClick={() => void saveKindEdit(d.id, opt.kind)}
                          className="flex items-center justify-center gap-1 rounded-lg text-[11px] font-black uppercase tracking-wider py-2 transition-opacity disabled:opacity-50"
                          style={{
                            background: tint.bg,
                            color:      tint.fg,
                            boxShadow:  '0 1px 3px rgba(0,0,0,0.12)',
                            textShadow: '0 1px 1px rgba(0,0,0,0.25)',
                            opacity:    active ? 0.55 : 1,
                            cursor:     active ? 'default' : 'pointer',
                          }}>
                          {active && <CheckCircle2 size={11} />}
                          {savingEdit && !active ? <Loader2 size={11} className="animate-spin" /> : null}
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="text-[10px]" style={{ color: 'var(--gc-text-3)', marginTop: 6 }}>
                    Filename will be renamed to match the new type.
                  </div>
                </div>
              )}
            </div>
          );
        })}
        </div>
        {/* Confirm-delete dialog also lives here so the per-card Delete
            button works from the LIST view, not just the viewer. Before
            this, setDeleteTarget fired but the dialog only existed in
            the viewer branch — clicks did nothing until the user opened
            a doc. */}
        {deleteTarget && (
          <ConfirmDialog
            title="Delete document?"
            message={`"${deleteTarget.name}" will be removed. This can't be undone.`}
            confirmLabel="Delete"
            cancelLabel="Cancel"
            destructive
            zIndex={240}
            onCancel={() => setDeleteTarget(null)}
            onConfirm={() => {
              const id = deleteTarget.id;
              setDeleteTarget(null);
              void performDelete(id);
            }}
          />
        )}
      </div>
    );
  }

  // Viewer — when a doc is selected
  return (
    // minHeight: 0 lets the inner flex-1 scroll container respect the
    // panel's bounded height instead of growing to fit its tall child
    // (the image). Without it, overflow-auto on the scroll container
    // does nothing — the flex chain grows freely and a tall JPEG gets
    // cut off at the bottom with no way to scroll. Same flex-overflow
    // gotcha that bites every modal viewer.
    <div className="flex-1 flex flex-col" style={{ background: 'var(--gc-bg)', minHeight: 0 }}>
      {uploadHeader}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)' }}>
        <button type="button" onClick={() => onSelect(null)}
          className="text-xs font-medium px-2 py-1 rounded transition-colors"
          style={{ color: LOAD_ACCENT, border: `1px solid ${LOAD_ACCENT_BORDER}` }}
          onMouseEnter={e => (e.currentTarget.style.background = LOAD_ACCENT_BG)}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          ← Back
        </button>
        <span className="text-xs font-semibold truncate" style={{ color: 'var(--gc-text-1)', flex: 1 }}>{selected.fileName}</span>
        {signedUrl && (
          <button type="button"
            // <a download> is ignored by browsers when the href is
            // cross-origin (Supabase signed URLs are), so the link
            // was just navigating to a viewer tab. Fetch the bytes
            // into a blob and trigger a true download via a hidden
            // anchor — same pattern the Rate Con download uses.
            onClick={async () => {
              try {
                const res = await fetch(signedUrl);
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = selected.fileName;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch (err) {
                console.error('[doc download] failed', err);
                window.open(signedUrl, '_blank', 'noopener');
              }
            }}
            className="text-xs font-medium px-2 py-1 rounded transition-colors"
            style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border-light)', background: 'transparent', cursor: 'pointer' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <Download size={11} style={{ display: 'inline', marginRight: 4 }} /> Download
          </button>
        )}
        {loadId && (
          <button type="button"
            onClick={() => setDeleteTarget({ id: selected.id, name: selected.fileName })}
            disabled={deletingId === selected.id}
            className="text-xs font-medium px-2 py-1 rounded transition-colors disabled:opacity-50"
            title={`Delete — ${selected.fileName}`}
            style={{ color: '#d93025', border: '1px solid #fcd2cf', background: '#fce8e6' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#fad5d2')}
            onMouseLeave={e => (e.currentTarget.style.background = '#fce8e6')}>
            <Trash2 size={11} style={{ display: 'inline', marginRight: 4 }} /> Delete
          </button>
        )}
      </div>
      {/* Shared multi-format DocViewer. Same component the closeout
          review queue uses — handles PDF (PdfCanvas), JPG/PNG/WEBP/GIF
          (<img>), HEIC/HEIF (heic2any → JPEG), with a graceful
          "Download to view" fallback for anything else.
          Routing through this drops the old img/iframe split (which
          couldn't render the HEIC files iPhone drivers upload) and
          gives the load modal the same coverage as the review queue. */}
      <DocViewer
        url={signedUrl ?? ''}
        mimeType={selected.mimeType}
        fileName={selected.fileName}
        onRetry={onSignedUrlError}
      />
      {deleteTarget && (
        <ConfirmDialog
          title="Delete document?"
          message={`"${deleteTarget.name}" will be removed. This can't be undone.`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          destructive
          // Above EventModal main (z-200) and confirms (z-220).
          zIndex={240}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const id = deleteTarget.id;
            setDeleteTarget(null);
            void performDelete(id);
          }}
        />
      )}
    </div>
  );
}

/**
 * Inline "this preview can't render" panel shown inside UploadedDocsPanel
 * when the <img>/<iframe> errors after a signed-URL retry. Pulls double
 * duty as a diagnostic — `detail` carries either a human reason (HEIC
 * detected, empty file, HTTP status) or the raw header bytes. The
 * Download button always works, so the user can grab the file even
 * when the in-browser preview can't render it.
 */
function PreviewErrorPanel({
  fileName, kind, detail, signedUrl,
}: {
  fileName: string;
  kind: 'heic' | 'empty' | 'http' | 'unknown';
  detail: string;
  signedUrl: string;
}) {
  const headline =
    kind === 'heic'    ? 'This file is HEIC, not JPG' :
    kind === 'empty'   ? 'This file is empty (0 bytes)' :
    kind === 'http'    ? "Couldn't load this file" :
                         "This file can't be previewed";
  const body =
    kind === 'heic'    ? "iPhones sometimes save photos as HEIC even when the extension is .jpg — browsers can't decode HEIC. Ask the driver to re-upload, or convert to JPG/PNG on your end. (Tip: on iPhone, Settings → Camera → Formats → Most Compatible saves real JPGs.)" :
    kind === 'empty'   ? 'The upload finished but the file has no contents. It was probably interrupted mid-upload. Delete it and re-upload.' :
    kind === 'http'    ? 'The storage URL responded with an error. Try downloading the file directly — if that works, this is a viewer bug. If it fails too, the file is gone from storage.' :
                         "The browser's image decoder rejected this file. Try downloading and opening locally — if it opens fine elsewhere, the file is using an unusual encoding (CMYK JPG, progressive markers, etc.).";
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-8 text-center" style={{ color: '#ffffff', maxWidth: 520 }}>
      <AlertCircle size={32} style={{ color: '#fbbc04' }} />
      <div className="text-base font-semibold">{headline}</div>
      <div className="text-xs leading-relaxed" style={{ color: '#cccccc' }}>{body}</div>
      <div className="text-[10px] font-mono mt-1" style={{ color: '#888888' }}>{fileName} · {detail}</div>
      <a
        href={signedUrl}
        download={fileName}
        className="text-xs font-medium px-3 py-1.5 rounded transition-colors mt-2"
        style={{ color: '#ffffff', border: '1px solid #ffffff44', background: '#ffffff11' }}>
        <Download size={11} style={{ display: 'inline', marginRight: 4 }} /> Download original
      </a>
    </div>
  );
}

// Pinned to match the version in package.json — sidesteps Next.js webpack
// .mjs bundling bugs by loading pdfjs from jsdelivr at runtime.
const PDFJS_VERSION = '5.6.205';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pdfJsPromise: Promise<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadPdfJsFromCDN(): Promise<any> {
  if (pdfJsPromise) return pdfJsPromise;
  // `Function('return import(...)')` evaluates the import() at runtime so webpack
  // never sees it — guaranteed to skip bundler analysis.
  const url = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
  pdfJsPromise = new Function('u', 'return import(u)')(url);
  return pdfJsPromise!;
}

function PdfCanvas({ dataUrl, onRetry }: { dataUrl: string; onRetry?: () => void }) {
  const boxRef      = useRef<HTMLDivElement>(null);
  const pdfRef      = useRef<any>(null);
  const fitScaleRef = useRef(0);

  const [ready,    setReady]    = useState(false);
  const [error,    setError]    = useState('');
  const [zoomMult, setZoomMult] = useState(1.0);
  const [retryKey, setRetryKey] = useState(0);

  // Load PDF once per dataUrl (retryKey bump forces a fresh attempt).
  // Empty dataUrl is treated as "still loading" — common path: signed-URL
  // fetch hasn't returned yet — so we stay in the spinner state instead
  // of flashing an error and a Retry button.
  useEffect(() => {
    let cancelled = false;
    pdfRef.current = null;
    setReady(false);
    setError('');
    if (!dataUrl) return; // wait for parent to provide a URL

    (async () => {
      // Load pdfjs from CDN (sidesteps webpack/Next.js .mjs bundling bugs that
      // produce "Object.defineProperty called on non-object" with v5).
      const pdfjsLib = await loadPdfJsFromCDN();
      if (!pdfjsLib.GlobalWorkerOptions.workerSrc)
        pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

      const src = dataUrl.startsWith('http') || dataUrl.startsWith('blob:')
        ? { url: dataUrl }
        : { data: Uint8Array.from(atob(dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl), c => c.charCodeAt(0)) };
      const pdf = await pdfjsLib.getDocument(src).promise;
      if (cancelled) return;

      const page    = await pdf.getPage(1);
      const natural = page.getViewport({ scale: 1 });

      // Compute pane width from final modal geometry (immune to CSS transition timing).
      // Modal: min(96vw, 1800px), PDF pane: 44%, padding: 16px each side.
      const paneW       = Math.min(window.innerWidth * 0.96, 1800) * 0.44;
      fitScaleRef.current = Math.max(0.1, (paneW - 32) / natural.width);

      pdfRef.current = pdf;
      if (!cancelled) setReady(true);
    })().catch(err => { if (!cancelled) setError(String(err)); });

    return () => { cancelled = true; };
  }, [dataUrl, retryKey]);

  // Re-render whenever ready state flips or zoom changes
  useEffect(() => {
    if (!ready || !pdfRef.current || fitScaleRef.current === 0) return;
    let cancelled = false;

    (async () => {
      const box = boxRef.current;
      const pdf = pdfRef.current;
      if (!box || !pdf) return;

      while (box.firstChild) box.removeChild(box.firstChild);

      const scale = fitScaleRef.current * zoomMult;
      const pdfjsLib = await loadPdfJsFromCDN();

      for (let n = 1; n <= pdf.numPages; n++) {
        if (cancelled) return;
        const page     = await pdf.getPage(n);
        const viewport = page.getViewport({ scale });
        const dpr      = window.devicePixelRatio || 1;

        // Wrapper so the text layer can absolute-position over the canvas.
        const wrap = document.createElement('div');
        wrap.style.position      = 'relative';
        wrap.style.width         = Math.round(viewport.width)  + 'px';
        wrap.style.height        = Math.round(viewport.height) + 'px';
        wrap.style.marginBottom  = n < pdf.numPages ? '8px' : '0';
        wrap.style.boxShadow     = '0 2px 8px rgba(0,0,0,.4)';
        box.appendChild(wrap);

        const canvas        = document.createElement('canvas');
        canvas.width        = Math.round(viewport.width  * dpr);
        canvas.height       = Math.round(viewport.height * dpr);
        canvas.style.width  = Math.round(viewport.width)  + 'px';
        canvas.style.height = Math.round(viewport.height) + 'px';
        canvas.style.display = 'block';
        wrap.appendChild(canvas);

        const ctx = canvas.getContext('2d')!;
        ctx.scale(dpr, dpr);
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;

        // Transparent selectable text overlay (uses PDF.js TextLayer API,
        // available in pdfjs-dist 4+). Each glyph is positioned over its
        // rasterized counterpart so the browser's native selection works
        // and copy-paste produces real text from the rate con.
        if (cancelled) return;
        const textLayerDiv = document.createElement('div');
        textLayerDiv.className     = 'pdfTextLayer';
        textLayerDiv.style.position = 'absolute';
        textLayerDiv.style.inset    = '0';
        textLayerDiv.style.overflow = 'hidden';
        textLayerDiv.style.opacity  = '1';
        textLayerDiv.style.lineHeight = '1';
        wrap.appendChild(textLayerDiv);
        try {
          const TextLayerCtor = (pdfjsLib as { TextLayer?: new (args: object) => { render: () => Promise<void> } }).TextLayer;
          if (TextLayerCtor) {
            const tl = new TextLayerCtor({
              textContentSource: page.streamTextContent(),
              container: textLayerDiv,
              viewport,
            });
            await tl.render();
          }
        } catch (err) {
          // Selection is a nice-to-have — the canvas still renders
          // correctly even if the text layer fails to mount.
          console.warn('[PdfCanvas] text layer failed:', err);
        }
      }
    })().catch(err => console.error('[PdfCanvas] render:', err));

    return () => { cancelled = true; };
  }, [ready, zoomMult]);

  const zoomIn  = () => { const n = PDF_ZOOM_STEPS.find(z => z > zoomMult + 0.01); if (n) setZoomMult(n); };
  const zoomOut = () => { const n = [...PDF_ZOOM_STEPS].reverse().find(z => z < zoomMult - 0.01); if (n) setZoomMult(n); };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Zoom toolbar */}
      <div className="shrink-0 flex items-center gap-1 px-3 py-1.5" style={{ background: '#3c3c3c', borderBottom: '1px solid rgba(0,0,0,.3)' }}>
        <button onClick={zoomOut} disabled={zoomMult <= PDF_ZOOM_STEPS[0]}
          className="w-7 h-7 flex items-center justify-center rounded text-base font-medium transition-colors disabled:opacity-30"
          style={{ color: 'rgba(255,255,255,.85)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,.15)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          −
        </button>
        <span className="text-xs font-mono select-none" style={{ color: 'rgba(255,255,255,.7)', minWidth: 36, textAlign: 'center' }}>
          {Math.round(zoomMult * 100)}%
        </span>
        <button onClick={zoomIn} disabled={zoomMult >= PDF_ZOOM_STEPS[PDF_ZOOM_STEPS.length - 1]}
          className="w-7 h-7 flex items-center justify-center rounded text-base font-medium transition-colors disabled:opacity-30"
          style={{ color: 'rgba(255,255,255,.85)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,.15)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          +
        </button>
        <button onClick={() => setZoomMult(1.0)}
          className="text-xs px-2 py-0.5 rounded ml-1 transition-colors"
          style={{ color: 'rgba(255,255,255,.5)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,.1)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          Fit
        </button>
      </div>

      {/* Canvas scroll area */}
      <div className="flex-1 overflow-auto" style={{ background: '#525659', padding: 16 }}>
        {!ready && !error && (
          <div className="flex items-center justify-center gap-2 py-16 text-sm" style={{ color: 'rgba(255,255,255,.5)' }}>
            <Loader2 size={16} className="animate-spin" /> {dataUrl ? 'Rendering…' : 'Loading…'}
          </div>
        )}
        {error && (
          <div className="py-16 flex flex-col items-center gap-3">
            <div className="text-sm" style={{ color: '#fca5a5' }}>Could not render PDF</div>
            <div className="text-xs font-mono px-3 py-1 rounded" style={{ color: 'rgba(255,255,255,0.4)', background: 'rgba(0,0,0,0.3)', maxWidth: 320, wordBreak: 'break-all', textAlign: 'center' }}>{error}</div>
            <button
              type="button"
              onClick={() => { onRetry?.(); setRetryKey(k => k + 1); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
              style={{ color: '#ffffff', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.25)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.18)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.1)')}
            >
              <RefreshCw size={12} /> Retry
            </button>
          </div>
        )}
        <div ref={boxRef} />
      </div>
    </div>
  );
}

function AutoResizeTextarea({ value, onChange, placeholder, style, onFocus, onBlur }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
  style?: React.CSSProperties;
  onFocus?: React.FocusEventHandler<HTMLTextAreaElement>;
  onBlur?: React.FocusEventHandler<HTMLTextAreaElement>;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={e => { onChange(e.target.value); e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = e.currentTarget.scrollHeight + 'px'; }}
      placeholder={placeholder}
      style={{ ...style, resize: 'none', overflow: 'hidden', minHeight: 80 }}
      onFocus={onFocus} onBlur={onBlur}
    />
  );
}

/** "5m ago" / "2h ago" / "yesterday" — used by in-modal card
 *  displays (TrailerLocationCard) where the page is alive and
 *  the relative form is the most readable. Share blobs use
 *  fmtShareTime below instead, since chat pastes go stale. */
function relTime(iso: string | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 60_000)      return 'just now';
  if (diff < 3_600_000)   return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000)  return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

/** Absolute "5/21 5:30am MDT" format in the org's configured
 *  timezone (calendarTimezone). Used by share-to-clipboard blobs —
 *  drivers + dispatchers read those in chat tools where a relative
 *  "5m ago" string goes stale the moment it's pasted. */
function fmtShareTime(iso: string | undefined, tz: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone:     tz,
    month:        'numeric',
    day:          'numeric',
    hour:         'numeric',
    minute:       '2-digit',
    hour12:       true,
    timeZoneName: 'short',
  }).formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const m   = get('month');
  const day = get('day');
  const hr  = get('hour');
  const min = get('minute');
  const ap  = get('dayPeriod').toLowerCase();
  const tzn = get('timeZoneName');
  return `${m}/${day} ${hr}:${min}${ap} ${tzn}`;
}

/** Compact "copy to clipboard" button. Matches the row of small
 *  inline action buttons under the Driver picker (Driver Summary /
 *  Notify Driver) so the row of buttons under Asset reads the same
 *  way. Flips to "Copied!" for 1.5s after a successful copy. */
function ShareLocationRow({ label, text, accentColor }: { label: string; text: string; accentColor?: string }) {
  const tint = accentColor ?? '#1a73e8';
  const [copied, setCopied] = useState(false);
  const [hovered, setHovered] = useState(false);

  const onCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Synchronous fallback for environments without the async API.
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('[ShareLocationRow] copy failed:', err);
    }
  };

  const active = copied || hovered;
  return (
    <button
      type="button"
      onClick={onCopy}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="mt-1.5 text-xs flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors"
      style={{
        color: active ? tint : 'var(--gc-text-3)',
        background: active ? `${tint}14` : 'transparent',
        border: 'none',
        cursor: 'pointer',
      }}
    >
      <Copy size={11} />
      <span>{copied ? 'Copied!' : label}</span>
    </button>
  );
}

/** Inline card used by the relay purple block to show + edit the
 *  dispatcher-set trailer drop ADDRESS as the primary handoff
 *  location, with the driver's GPS pin (when present) shown
 *  underneath as a secondary verification layer. Both have copy-to-
 *  clipboard share buttons that build Google Maps URLs.
 *
 *  - Pickup-leg view (editable=true): address input the dispatcher
 *    types into. Saves on blur via onAddressChange.
 *  - Delivery-leg view (editable=false): read-only display of the
 *    partner pickup event's address + pin (the data already lives on
 *    the partner event row, surfaced via the events store).
 */
function TrailerLocationCard({
  editable,
  address,
  onAddressChange,
  pinLat,
  pinLng,
  pinAt,
  tz,
}: {
  editable:         boolean;
  address?:         string;
  onAddressChange?: (v: string) => void;
  pinLat?:          number;
  pinLng?:          number;
  pinAt?:           string;
  /** Org timezone — used to format the absolute "Last updated"
   *  stamp inside the share-to-clipboard blob. */
  tz:               string;
}) {
  const [draft, setDraft] = useState(address ?? '');
  // Keep the draft synced when the parent props update (e.g. after a
  // save round-trip). Don't fight the user mid-typing.
  useEffect(() => { setDraft(address ?? ''); }, [address]);

  const trimmed   = draft.trim();
  const hasPin    = pinLat != null && pinLng != null;
  const addrUrl   = trimmed
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(trimmed)}`
    : null;
  const pinUrl    = hasPin
    ? `https://www.google.com/maps?q=${pinLat},${pinLng}`
    : null;

  const shareBlob = (() => {
    const lines: string[] = ['Trailer Drop Location'];
    if (trimmed) lines.push(trimmed);
    if (hasPin) {
      lines.push(`Pin (driver-verified): ${pinLat?.toFixed(5)}, ${pinLng?.toFixed(5)}`);
      if (pinAt) lines.push(`Last updated ${fmtShareTime(pinAt, tz)}`);
    }
    // Prefer the address-based URL when set; fall back to the pin URL.
    if (addrUrl) lines.push(addrUrl);
    else if (pinUrl) lines.push(pinUrl);
    return lines.join('\n');
  })();

  return (
    <div style={{
      background: '#fafaff',
      border: '1px dashed #c4b5fd',
      borderRadius: 10,
      padding: '12px 14px',
    }}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <span style={{ fontSize: 11, fontWeight: 700, color: RELAY_COLOR, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Trailer Drop Location
        </span>
      </div>

      {editable ? (
        <input
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => {
            const next = draft.trim();
            if ((next || '') !== (address ?? '')) onAddressChange?.(next);
          }}
          placeholder="e.g. 123 Industrial Blvd, Denver CO"
          className="w-full rounded-md text-sm"
          style={{
            border: '1px solid var(--gc-border)',
            background: '#ffffff',
            padding: '8px 10px',
            color: 'var(--gc-text-1)',
            outline: 'none',
          }}
          onFocus={e => (e.currentTarget.style.borderColor = RELAY_COLOR)}
          onBlurCapture={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
        />
      ) : (
        <div style={{
          fontSize: 13,
          fontWeight: 600,
          color: trimmed ? '#5b21b6' : '#9aa0a6',
          background: '#ede9fe',
          borderRadius: 6,
          padding: '8px 10px',
        }}>
          {trimmed || 'Pickup-leg dispatcher hasn\'t set an address yet.'}
        </div>
      )}

      {/* Driver pin — secondary layer. Always rendered as read-only,
          regardless of which leg is being viewed. */}
      {hasPin && (
        <div style={{
          marginTop: 8,
          padding: '8px 10px',
          background: '#f5f3ff',
          border: '1px solid #ede9fe',
          borderRadius: 6,
          fontSize: 12,
          color: '#6b21a8',
        }}>
          <div style={{ fontWeight: 600 }}>
            Driver pin · {pinAt ? relTime(pinAt) : 'recently'}
          </div>
          <div style={{ marginTop: 2, color: '#7e22ce', fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 11 }}>
            {pinLat?.toFixed(5)}, {pinLng?.toFixed(5)}
          </div>
        </div>
      )}

      {(trimmed || hasPin) && (
        <ShareLocationRow label="Share location" text={shareBlob} accentColor={RELAY_COLOR} />
      )}
    </div>
  );
}

// StyledSelect moved to apps/web/components/ui/StyledSelect.tsx so
// the maintenance work-order modal can share it. Imported above.

function focusColor(color: string) {
  return (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    (e.currentTarget.style.borderColor = color);
}
function blurColor(e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = 'var(--gc-border)';
}

// Toggle (boolean field)
function Toggle({ checked, onChange, accentColor }: { checked: boolean; onChange: (v: boolean) => void; accentColor: string }) {
  return (
    <button type="button" onClick={() => onChange(!checked)}
      className="relative flex items-center shrink-0 rounded-full transition-colors"
      style={{ width: 40, height: 22, background: checked ? accentColor : 'var(--gc-border)', transition: 'background 150ms' }}>
      <span className="absolute rounded-full bg-white transition-transform"
        style={{ width: 16, height: 16, left: 3, transform: checked ? 'translateX(18px)' : 'translateX(0)', transition: 'transform 150ms', boxShadow: '0 1px 3px rgba(0,0,0,.2)' }} />
    </button>
  );
}

// Renders a single optional field's input
function FieldInput({ field, value, onChange, headerColor }: {
  field: FieldDef;
  value: string | number | boolean | undefined;
  onChange: (v: string | number | boolean) => void;
  headerColor: string;
}) {
  const iStyle = inputStyle();
  const focusH = focusColor(headerColor);

  if (field.type === 'boolean') {
    return (
      <div className="flex items-center gap-3 h-[42px]">
        <Toggle checked={!!value} onChange={onChange} accentColor={headerColor} />
        <span className="text-sm" style={{ color: value ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}>
          {value ? 'Yes' : 'No'}
        </span>
      </div>
    );
  }

  if (field.type === 'textarea') {
    return (
      <AutoResizeTextarea
        value={String(value ?? '')}
        onChange={onChange as (v: string) => void}
        placeholder={field.placeholder}
        style={{ ...iStyle, cursor: 'text', fontFamily: 'inherit', lineHeight: '1.5' } as React.CSSProperties}
        onFocus={focusH as any} onBlur={blurColor as any}
      />
    );
  }

  if (field.type === 'select' && field.options) {
    return (
      <StyledSelect value={String(value ?? '')} onChange={e => onChange(e.target.value)}
        style={{ ...iStyle, cursor: 'pointer' }} onFocus={focusH} onBlur={blurColor}>
        {field.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </StyledSelect>
    );
  }

  return (
    <input
      type={field.type === 'number' ? 'number' : 'text'}
      min={field.type === 'number' ? 0 : undefined}
      step={field.type === 'number' ? 0.01 : undefined}
      value={String(value ?? '')}
      onChange={e => onChange(field.type === 'number' ? e.target.value : e.target.value)}
      placeholder={field.placeholder}
      style={iStyle}
      onFocus={focusH} onBlur={blurColor}
    />
  );
}

// Searchable combobox for selecting a customer/broker from the org's customer list
// Renders a section of optional fields in a 2-col grid (booleans and textareas take full width)
function BrokerMatchBanner({ match, onConfirmMatch, onRejectMatch, onCreateNew, onFocusSearch }: {
  match: CustomerMatchResult;
  onConfirmMatch: (c: import('@/lib/types').Customer) => void;
  onRejectMatch: () => void;
  onCreateNew: (name: string) => Promise<void> | void;
  onFocusSearch: () => void;
}) {
  const [creating, setCreating] = useState(false);

  if (match.status === 'confirm') {
    return (
      <div className="rounded-xl p-3 space-y-2" style={{ background: '#fffbeb', border: '1px solid #fcd34d' }}>
        <div className="flex items-center gap-2">
          <AlertCircle size={13} style={{ color: '#b45309', flexShrink: 0 }} />
          <span style={{ fontSize: 12, color: '#92400e' }}>
            Possible match: <strong>{match.customer.name}</strong>{' '}
            <span style={{ opacity: 0.6 }}>({Math.round(match.score * 100)}%)</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => onConfirmMatch(match.customer)}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg"
            style={{ background: '#1a73e8', color: '#fff', border: 'none', cursor: 'pointer' }}>
            Yes, use {match.customer.name}
          </button>
          <button type="button" onClick={onRejectMatch}
            className="text-xs px-3 py-1.5 rounded-lg"
            style={{ border: '1px solid #fcd34d', background: 'transparent', color: '#92400e', cursor: 'pointer' }}>
            Not this one
          </button>
        </div>
      </div>
    );
  }

  if (match.status === 'new') {
    return (
      <div className="rounded-xl p-3 space-y-2" style={{ background: '#f0f9ff', border: '1px solid #bae6fd' }}>
        <div className="flex items-center gap-2">
          <Plus size={13} style={{ color: '#0369a1', flexShrink: 0 }} />
          <span style={{ fontSize: 12, color: '#0c4a6e' }}>
            New customer: <strong>{match.extracted}</strong>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button"
            disabled={creating}
            onClick={async () => { setCreating(true); await onCreateNew(match.extracted); setCreating(false); }}
            className="flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg"
            style={{ background: '#0369a1', color: '#fff', border: 'none', cursor: 'pointer' }}>
            {creating ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />} Save as customer
          </button>
          <button type="button" onClick={onFocusSearch}
            className="text-xs px-3 py-1.5 rounded-lg"
            style={{ border: '1px solid #bae6fd', background: 'transparent', color: '#0369a1', cursor: 'pointer' }}>
            Search list
          </button>
        </div>
      </div>
    );
  }

  return null;
}

function SectionFields({ fields, fieldValues, onChange, headerColor, overrides, labelSuffixes, noLabelFields }: {
  fields: FieldDef[];
  fieldValues: Record<string, string | number | boolean | string[] | RefNum[]>;
  onChange: (id: string, v: string | number | boolean) => void;
  headerColor: string;
  overrides?: Record<string, React.ReactNode>;
  labelSuffixes?: Record<string, React.ReactNode>;
  noLabelFields?: Set<string>;
}) {
  // Pair text/number fields into 2-col rows; booleans, textareas, and span:true go full-width
  const rows: FieldDef[][] = [];
  let i = 0;
  while (i < fields.length) {
    const f = fields[i];
    if (f.type === 'boolean' || f.type === 'textarea' || f.span) {
      rows.push([f]);
      i++;
    } else {
      const next = fields[i + 1];
      if (next && next.type !== 'boolean' && next.type !== 'textarea' && !next.span) {
        rows.push([f, next]);
        i += 2;
      } else {
        rows.push([f]);
        i++;
      }
    }
  }

  return (
    <div className="space-y-4">
      {rows.map((row, idx) => (
        <div key={idx} className={row.length === 2 ? 'grid grid-cols-2 gap-4' : ''}>
          {row.map(f => (
            noLabelFields?.has(f.id)
              ? <div key={f.id}>{overrides?.[f.id] ?? <FieldInput field={f} value={Array.isArray(fieldValues[f.id]) ? '' : fieldValues[f.id] as string | number | boolean} onChange={v => onChange(f.id, v)} headerColor={headerColor} />}</div>
              : <Field key={f.id} label={f.label} labelSuffix={labelSuffixes?.[f.id]}>
                  {overrides?.[f.id] ?? <FieldInput field={f} value={Array.isArray(fieldValues[f.id]) ? '' : fieldValues[f.id] as string | number | boolean} onChange={v => onChange(f.id, v)} headerColor={headerColor} />}
                </Field>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function EventModal() {
  const {
    assets, events, drivers, driverPrefs, driverPrefsSecondary, currentDate,
    modalOpen, modalMode, modalEventId, modalDefaults, modalShowMap, modalConflict, clearModalConflict,
    prefillWorkOrderLinkIds,
    refetchEvent, refetchingEventIds,
    addEvent, updateEvent, removeEvent, cancelEventKeepLoad, closeModal,
    openEditModal, openCreateModal,
    createRelayLegs, splitToRelay, saveRelayLegs, removeRelay, configureLegs,
    fieldSettings, sectionOrder, promptInstructions, promptVariables,
    batchItems, batchIndex, batchNext, clearBatch,
    orgId, dispatchers, customers, addCustomer, addCustomerAlias, addCustomerContact, updateCustomer,
    trailers,
    driverPayPct,
    eldLocations,
    mergeEvents,
    calendarTimezone,
    cardFontScale,
  } = useCalendarStore();

  const { user } = useUser();
  const currentUserName = user?.fullName ?? user?.firstName ?? 'Unknown';
  // Router for the "Open detail page" button next to the load ID chip.
  const router = useRouter();
  // Driver-pay visibility — Dispatcher and Maintenance roles don't
  // get to see what we're paying drivers. The input is removed from
  // the financial section's field list (and from the relay per-leg
  // pay block) when this is false.
  const { can: canDo } = usePermissions();
  // Module gates — controls feature-gated sub-sections inside the
  // modal. The full non-revenue type list stays available to every
  // org (a dispatcher can schedule any kind of non-revenue event
  // regardless of subscription tier); MVP orgs simply can't LINK
  // those events to work orders because they don't have the
  // maintenance module — the Linked Work Orders panel further down
  // is hidden, not the type chip.
  const { enabled: moduleEnabled } = useModules();
  const maintenanceEnabled = moduleEnabled('maintenance');
  // Driver-app module gates the Notify-driver popover below. Default
  // is ON for new orgs since 2026-06-22 (the mobile app went
  // multi-tenant); only orgs that explicitly turned the module off
  // hide the button now. Carriers running without the driver app
  // still see this as disabled — nothing to nudge if no one's on the
  // other end of the push.
  const driverAppEnabled   = moduleEnabled('driver_app');
  const canViewDriverPay = canDo('loads.view_driver_pay');
  // Hide the load price / rate field for roles without loads.view_price
  // (Maintenance). Same pattern as canViewDriverPay below — strip the
  // field from the rendered list and from any inline summaries.
  const canViewPrice = canDo('loads.view_price');
  // Gate the rate confirmation PDF viewer + the "View PDF" buttons
  // that open it. Maintenance has loads.view but lacks the rate-con
  // visibility cap.
  const canViewRateCon = canDo('loads.view_rate_con');
  // Revenue-load vs non-revenue-event capability split. Maintenance
  // has nonRevenueEvents.* but not loads.* — when they open the
  // create modal we force eventKind to 'non_revenue' and disable the
  // Revenue toggle so they can't accidentally submit a load they
  // wouldn't be allowed to save.
  const canCreateRevenue    = canDo('loads.create');
  const canCreateNonRevenue = canDo('nonRevenueEvents.create');
  // Both revenue destructive paths (Cancel load → permanent / Remove
  // a cancelled load) call DELETE /v1/loads/:id under the hood. Hide
  // the buttons entirely from roles that lack the capability — the
  // server rejects them anyway, and showing the button lets the user
  // trigger an optimistic local removal before the 403 comes back.
  const canDeleteLoad = canDo('loads.delete');
  // Once a load has moved past the closeout step (released for
  // billing), cancelling it would create accounting drift — there's
  // potentially an open invoice referencing it. The server enforces
  // this gate (events.ts PATCH returns 409 billing_status_locked);
  // we hide the affordance here so users don't try the action and
  // get an error back. To genuinely walk one back: void the
  // invoice first, billing_status drops back to 'pending', then
  // cancel is offered again.
  const cancelLockedEv = modalEventId ? events.find(e => e.id === modalEventId) : undefined;
  const cancelLocked = !!cancelLockedEv?.billingStatus && cancelLockedEv.billingStatus !== 'pending';
  // ── Read-only gate for this modal ────────────────────────────────
  // Maintenance opens a revenue load → has loads.view but not
  // loads.edit, so the form should be a static view. We disable all
  // form controls via a wrapping <fieldset disabled>, suppress the
  // Save button, and show a small banner at the top. For non-revenue
  // events the matching gate is nonRevenueEvents.edit.

  const isEdit  = modalMode === 'edit';
  const isBatch = batchItems.length > 0;

  // Canonical display name — prefers the modern firstName + lastName
  // combo so a driver that was renamed via the new fields surfaces
  // their full name everywhere. Falls back to the legacy `.name` for
  // records that haven't been split yet.
  const canonicalDriverName = (d: { firstName?: string; lastName?: string; name?: string }) => {
    const full = `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim();
    return full || d.name || '';
  };

  // Resolve a driver name string (legacy or canonical) back to the
  // matching driver record. Matches by canonical name OR by the
  // legacy .name field, case-insensitive — so a load saved before
  // the firstName/lastName split still finds the right person.
  const findDriverByName = (name: string | undefined) => {
    if (!name) return undefined;
    const lower = name.trim().toLowerCase();
    if (!lower) return undefined;
    return drivers.find(d =>
      canonicalDriverName(d).toLowerCase() === lower ||
      (d.name ?? '').toLowerCase() === lower
    );
  };

  // Preferred-driver autofill when an asset is selected. Looks up
  // the asset's preferred driverId in driverPrefs, resolves to the
  // current driver record, and returns the canonical display name.
  // Previously this returned d.name (legacy) which surfaced empty
  // when a driver was renamed but the legacy field stayed blank —
  // the asset change would clear the driver field instead of
  // filling it.
  const preferredDriverName = (aid: number) => {
    const driverId = driverPrefs[aid];
    if (!driverId) return '';
    const d = drivers.find(x => x.id === driverId);
    return d ? canonicalDriverName(d) : '';
  };

  // Reverse autofill — given a driver name (the value coming out of
  // the StyledSelect), find the asset where this driver is the
  // primary OR secondary preference. Primary wins if the same driver
  // sits in two rows (shouldn't happen but defensively prefer the
  // truck owner). Returns null if no match.
  const preferredAssetForDriverName = (name: string): number | null => {
    if (!name) return null;
    const d = drivers.find(x => canonicalDriverName(x) === name || x.name === name);
    if (!d) return null;
    // Primary first
    for (const [assetIdStr, did] of Object.entries(driverPrefs)) {
      if (did === d.id) return Number(assetIdStr);
    }
    // Fall back to secondary
    for (const [assetIdStr, did] of Object.entries(driverPrefsSecondary)) {
      if (did === d.id) return Number(assetIdStr);
    }
    return null;
  };

  // Core fields (always visible)
  const [title,      setTitle]      = useState('');
  const [assetId,    setAssetId]    = useState(assets[0]?.id ?? 1);
  const [driverName, setDriverName] = useState('');
  const [startDate,  setStartDate]  = useState('');
  const [startTime,  setStartTime]  = useState('08:00');
  const [endDate,    setEndDate]    = useState('');
  const [endTime,    setEndTime]    = useState('17:00');

  // Pre-flight check: pickup datetime must be on or before delivery
  // datetime. Mirrors the server-side validation at POST /v1/loads
  // (events[0]: start must be <= end). String comparison works because
  // the naive YYYY-MM-DDTHH:mm format is lex-sortable.
  //
  // The DatePicker on the end-date field uses min={startDate}, which
  // catches same-or-later-day, but a same-DAY load with pickup 14:00
  // and delivery 08:00 slips through that. This check covers it.
  //
  // Surfaced as an inline red banner under the date row (rendered in
  // the form below) AND blocks doSave from firing the POST, so the
  // user sees the problem before clicking Save instead of after a 400
  // round trip.
  const dateOrderError = (startDate && startTime && endDate && endTime &&
    `${startDate}T${startTime}` > `${endDate}T${endTime}`)
    ? 'Delivery is before pickup. Fix the start / end before saving.'
    : null;

  // Inline "switch the partner field too?" suggestions for edit mode.
  // When the user picks a driver that's preferred on a different
  // asset (or vice versa), we surface a small inline chip below the
  // field they touched — clicking it applies the swap; clicking ✕
  // dismisses. Creating a fresh load auto-applies instead (no chip).
  // (The relay legs editor applies driver↔truck prefs silently on
  // draft legs instead of chip-suggesting, so only the main row keeps
  // suggestion state.)
  const [suggestAssetSwap,            setSuggestAssetSwap]            = useState<number | null>(null);
  const [suggestDriverSwap,           setSuggestDriverSwap]           = useState<string | null>(null);
  const [status,     setStatus]     = useState<EventStatus>('scheduled');
  const [priority,   setPriority]   = useState(false);
  const [eventKind,  setEventKind]  = useState<'revenue' | 'non_revenue'>('revenue');
  const [nonRevenueType, setNonRevenueType] = useState<string>('Maintenance');
  // Buffer of maintenance work-order IDs the dispatcher has checked
  // in the Linked Work Orders section, but not yet saved (because the
  // event is still being created). On a successful create save we
  // flush these via railway.updateMaintenanceActionItem for each id.
  // In edit mode the section persists toggles immediately and this
  // stays empty.
  const [pendingWorkOrderLinks, setPendingWorkOrderLinks] = useState<string[]>([]);
  // Read-only mode for this modal instance: true when the role can
  // VIEW the underlying record but not modify it (maintenance opening
  // a revenue load is the canonical case). Field controls get
  // wrapped in <fieldset disabled> further down so every input is
  // inert; the Save button is hidden and a banner explains why.
  const isReadOnly = (
    isEdit && (eventKind === 'non_revenue'
      ? !canDo('nonRevenueEvents.edit')
      : !canDo('loads.edit'))
  );
  const [confirmDel,           setConfirmDel]           = useState(false);
  const [cancelDialogOpen,     setCancelDialogOpen]    = useState(false);
  const [removeDialogOpen,     setRemoveDialogOpen]    = useState(false);
  const [historyExpanded,      setHistoryExpanded]      = useState(false);
  const [auditLog,             setAuditLog]             = useState<LoadAuditEntry[]>([]);
  const [confirmRemoveRateCon, setConfirmRemoveRateCon] = useState(false);
  // Closeout review queue launched from this modal — single-load mode.
  // Mounted at z-250 so it stacks above the modal (z-200) and any
  // confirm dialogs the modal might own (z-220).
  const [reviewQueueOpen,      setReviewQueueOpen]      = useState(false);
  const [loadIdCopied, setLoadIdCopied] = useState(false);
  const [confirmSkip,          setConfirmSkip]          = useState(false);
  const [confirmBatchCancel,   setConfirmBatchCancel]   = useState(false);

  // Optional field values (keyed by field id)
  const [fieldValues, setFieldValues] = useState<Record<string, string | number | boolean | string[] | RefNum[]>>({});

  // Stops (multi-stop routing — populated from rate con parse; UI built separately)
  const [stops, setStops] = useState<Stop[]>([]);
  const prevStartDateRef = useRef<string>(''); // tracks previous startDate to compute delta for stop shifting

  // Accessorials
  const [accessorials, setAccessorials] = useState<Accessorial[]>([]);
  const addAccessorial = () => {
    setAccessorials(prev => [...prev, { id: crypto.randomUUID(), category: 'detention', description: '', amount: 0, billable: true }]);
    markDirty();
  };
  const removeAccessorial = (id: string) => { setAccessorials(prev => prev.filter(a => a.id !== id)); markDirty(); };
  const updateAccessorial = (id: string, updates: Partial<Accessorial>) => {
    setAccessorials(prev => prev.map(a => a.id === id ? { ...a, ...updates } : a));
    markDirty();
  };
  // Sum of billable accessorials (NOT the grand total — that's
  // linehaul + this. Named to avoid clashing with loads.total_billable
  // which DOES mean linehaul + accessorials and is server-computed.)
  const accessorialsTotal = accessorials.filter(a => a.billable).reduce((sum, a) => sum + (a.amount || 0), 0);

  // Dirty tracking
  const [isDirty,        setIsDirty]        = useState(false);
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  // Mirror of UploadedDocsPanel's local pendingFile state. True when
  // the user has staged a doc but not yet picked a type. We block the
  // modal close path with a dedicated confirm so the staged file
  // doesn't silently disappear.
  const [hasPendingDoc, setHasPendingDoc] = useState(false);
  const [showDocCloseConfirm, setShowDocCloseConfirm] = useState(false);
  const [savePromptAfterNav, setSavePromptAfterNav] = useState<string | null>(null); // relay partner id to open after save
  const [dupLoadNum,     setDupLoadNum]     = useState<string | null>(null); // load# that triggered duplicate warning
  const [pendingSave,    setPendingSave]    = useState<'single' | 'batch' | null>(null);
  const [geocodeBlock,   setGeocodeBlock]   = useState<'single' | 'batch' | null>(null); // save target when ungeocoded stops detected
  const markDirty = () => setIsDirty(true);

  /** User-correctable save blocker → visible toast. errorToast renders
   *  the `message` of a 4xx-shaped error verbatim, which is exactly the
   *  contract we want for validation messages. Every abort path in
   *  doSave MUST go through this — silent returns caused "Save does
   *  nothing" bug reports. */
  const showSaveBlocked = (message: string) =>
    errorToast({ status: 400, message }, message);

  // Shift stop appointment times when the start date changes (duplicate/+1 Week flow).
  // Only manipulates the date portion — time portion is preserved as-is to avoid
  // UTC↔local conversion errors (new Date(localIso).toISOString() shifts by TZ offset).
  useEffect(() => {
    const prev = prevStartDateRef.current;
    if (!prev || !startDate || prev === startDate) { prevStartDateRef.current = startDate; return; }
    // Never bulk-shift stops while viewing one leg of a relay: the stop
    // list is the WHOLE load's, so a day change on this leg would move
    // every other leg's appointments and the handoff times with it.
    if (isExistingRelayLeg) { prevStartDateRef.current = startDate; return; }
    // Both are YYYY-MM-DD date-only strings → parse as UTC midnight for an exact day delta
    const deltaDays = Math.round(
      (new Date(startDate).getTime() - new Date(prev).getTime()) / (1000 * 60 * 60 * 24)
    );
    if (deltaDays === 0) { prevStartDateRef.current = startDate; return; }
    const shiftIso = (iso: string | undefined) => {
      if (!iso) return iso;
      const tIdx = iso.indexOf('T');
      const datePart = tIdx >= 0 ? iso.slice(0, tIdx) : iso;
      const timePart = tIdx >= 0 ? iso.slice(tIdx) : '';
      const [y, m, d] = datePart.split('-').map(Number);
      const shifted = new Date(Date.UTC(y, m - 1, d + deltaDays));
      const yy = shifted.getUTCFullYear();
      const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(shifted.getUTCDate()).padStart(2, '0');
      return `${yy}-${mm}-${dd}${timePart}`;
    };
    setStops(prev => prev.map(s => ({
      ...s,
      apptStart: shiftIso(s.apptStart),
      apptEnd:   shiftIso(s.apptEnd),
    })));
    prevStartDateRef.current = startDate;
  }, [startDate]); // eslint-disable-line react-hooks/exhaustive-deps

  const setField = (id: string, v: string | number | boolean) => {
    markDirty();
    if (id === 'driverPay') { driverPayAutoSet.current = false; setDriverPayIsAuto(false); setPrevDriverPay(null); }
    setFieldValues(prev => ({ ...prev, [id]: v }));
  };

  // PDF parse state
  const [parseState, setParseState] = useState<'idle' | 'parsing' | 'done' | 'error'>('idle');
  const [reparsing, setReparsing] = useState(false);
  const [loadedMiles,        setLoadedMiles]        = useState<number | null>(null);
  /** Computed road miles for the OTHER legs of a relay, keyed by event
   *  id — feeds the whole-haul header total + per-leg share chips. */
  const [otherLegMiles,      setOtherLegMiles]      = useState<Record<string, number>>({});
  const [parseError, setParseError] = useState('');
  const [brokerMatch, setBrokerMatch] = useState<CustomerMatchResult>({ status: 'none' });
  const [brokerSaveBlocked, setBrokerSaveBlocked] = useState(false);
  // The pending new-broker creation flow. Set when the user clicks one of
  // the "Save as customer" CTAs; the review modal renders when truthy.
  const [pendingNewBroker, setPendingNewBroker] = useState<string | null>(null);

  // Post-create handler shared by every "save new broker" CTA. The
  // NewBrokerReviewModal calls this with the (possibly-edited) payload
  // assembled by the user; we persist it and wire the new customer up
  // to the load.
  const confirmCreateBroker = async (payload: Parameters<typeof addCustomer>[0]) => {
    const created = await addCustomer(payload);
    if (created) setField('broker', created.name);
    setBrokerMatch({ status: 'none' });
    setBrokerSaveBlocked(false);
    setPendingNewBroker(null);
  };
  const [showBrokerProfile, setShowBrokerProfile] = useState(false);
  const brokerComboRef = useRef<HTMLInputElement | null>(null);
  const [linkedTrailerId, setLinkedTrailerId] = useState<number | undefined>(undefined);
  // Thread of internal notes pinned to the load. Composer text is held
  // separately so an unposted draft doesn't get serialized into the array.
  const [internalNotes, setInternalNotes] = useState<import('@fleetcal/types').InternalNote[]>([]);
  const [originalInternalNotes, setOriginalInternalNotes] = useState<import('@fleetcal/types').InternalNote[]>([]);
  const [noteComposer, setNoteComposer] = useState<string>('');
  const [noteComposerOpen, setNoteComposerOpen] = useState<boolean>(false);
  const driverPayAutoSet = useRef(false); // true when driverPay was auto-filled from pct
  const [driverPayIsAuto, setDriverPayIsAuto] = useState(false);
  const [prevDriverPay, setPrevDriverPay] = useState<number | null>(null);
  const fileInputRef       = useRef<HTMLInputElement>(null);
  const attachFileInputRef = useRef<HTMLInputElement>(null);

  // Rate con attachment
  const [rateConPdf,    setRateConPdf]    = useState<string | undefined>(undefined);
  // Snapshot of rateConPdf at modal-open / reinit time. The save
  // payload only includes `rateConPdf` when the current value
  // differs from this snapshot — otherwise an idle modal would
  // overwrite loads.rate_con_pdf with the value it loaded, racing
  // with concurrent uploads from ReviewQueue (which write straight
  // to loads.rate_con_pdf via the mirror in POST /v1/loads/:id/
  // documents). Re-seeded by reinitForm, the modal-close reset, and
  // the batch / relay-split refetch paths so a saved storage path
  // becomes the new "unchanged" baseline.
  const [rateConOriginal, setRateConOriginal] = useState<string | undefined>(undefined);
  const [showPdfViewer,  setShowPdfViewer]  = useState(false);
  const [showMapPanel,   setShowMapPanel]   = useState(false);
  const [showDriverSummary, setShowDriverSummary] = useState(false);
  // NOTE: the old single-purpose "Send confirm push" button + state was
  // retired in favor of NotifyDriverPopover which exposes the full set
  // of dispatcher nudges (confirm / mark_pickup / mark_delivery /
  // upload_pod / report_trailer) with shared history + soft-confirm.
  const [docsTab,        setDocsTab]        = useState<'rateCon' | 'uploaded'>('rateCon');
  const [loadDocuments,  setLoadDocuments]  = useState<import('@/lib/db').LoadDocument[]>([]);
  const [loadInvoices,   setLoadInvoices]   = useState<import('@fleetcal/types').Invoice[]>([]);
  const [selectedDocUrl, setSelectedDocUrl] = useState<string | null>(null);
  const [selectedDocId,  setSelectedDocId]  = useState<string | null>(null);

  // Fetch audit log when the modal opens with a saved event.
  // We strip audit_log from the calendar list query (can grow large) and load it on demand.
  useEffect(() => {
    if (!modalOpen || !modalEventId || !orgId) { setAuditLog([]); return; }
    let cancelled = false;
    (async () => {
      const { fetchEventAuditLog } = await import('@/lib/db');
      const log = await fetchEventAuditLog(modalEventId, orgId);
      if (!cancelled) setAuditLog(log ?? []);
    })();
    return () => { cancelled = true; };
  }, [modalOpen, modalEventId, orgId]);

  // Lazy: load full docs (with signed URLs) + invoices when the user
  // opens the docs viewer. Invoices live in their own table but
  // surface in the same panel as virtual rows above the uploaded docs.
  //
  // For relay loads we also load eagerly when the modal opens — the
  // handoff-photo grid in the relay block needs the photos
  // (and their signed URLs) to render thumbnails without an extra
  // round-trip on every modal open.
  useEffect(() => {
    if (!modalEventId || !orgId) return;
    const ev = events.find(e => e.id === modalEventId);
    if (!ev?.loadId) return; // documents are load-scoped
    const isRelayLeg = !!ev.relayRole; // 'pickup' or 'delivery'
    if (!isRelayLeg && !showPdfViewer) return;
    if (loadDocuments.length > 0 || loadInvoices.length > 0) return; // already loaded
    let cancelled = false;
    (async () => {
      const [{ fetchLoadDocuments }, { railway }] = await Promise.all([
        import('@/lib/db'),
        import('@/lib/railway'),
      ]);
      // Skip the invoice fetch when the role can't read /v1/invoices —
      // the endpoint 403s these requests, and the BillingCard / invoice
      // UI in this modal is hidden in that case anyway. Was responsible
      // for repeated forbidden entries in the api_errors dashboard
      // every time a non-accounting dispatcher opened a load.
      const [docs, invRes] = await Promise.all([
        fetchLoadDocuments(ev.loadId!, orgId),
        canDo('accounting.access')
          ? railway.listInvoices({ loadId: ev.loadId! }).catch(() => ({ invoices: [] }))
          : Promise.resolve({ invoices: [] }),
      ]);
      if (cancelled) return;
      setLoadDocuments(docs);
      setLoadInvoices(invRes.invoices);
    })();
    return () => { cancelled = true; };
  }, [showPdfViewer, modalEventId, orgId, loadDocuments.length, loadInvoices.length, events, canDo]);

  // When a doc gets selected, use the pre-fetched signed URL if we have one.
  useEffect(() => {
    if (!selectedDocId) { setSelectedDocUrl(null); return; }
    const doc = loadDocuments.find(d => d.id === selectedDocId);
    if (!doc) return;
    if (doc.signedUrl) { setSelectedDocUrl(doc.signedUrl); return; }
    // Fallback: refresh on demand (e.g. cached URL expired)
    let cancelled = false;
    (async () => {
      const { getLoadDocumentSignedUrl } = await import('@/lib/db');
      const url = await getLoadDocumentSignedUrl(doc.id);
      if (!cancelled) setSelectedDocUrl(url);
    })();
    return () => { cancelled = true; };
  }, [selectedDocId, loadDocuments]);

  // Forces a fresh signed URL mint for the currently-selected doc.
  // Used as the <img> onError fallback inside UploadedDocsPanel —
  // Supabase signed URLs default to a 1-hour TTL and the cached URL
  // shipped on the original docs list response goes stale once the
  // dispatcher leaves the modal open past the hour mark. Catching
  // the load error + re-minting recovers automatically without
  // needing them to close + reopen the modal.
  const refreshSelectedDocUrl = useCallback(async () => {
    if (!selectedDocId) return;
    const { getLoadDocumentSignedUrl } = await import('@/lib/db');
    const url = await getLoadDocumentSignedUrl(selectedDocId);
    if (url) setSelectedDocUrl(url);
  }, [selectedDocId]);
  const [pdfObjectUrl,  setPdfObjectUrl]  = useState('');
  const [pdfRetryKey,   setPdfRetryKey]   = useState(0);
  const [isDragOver,    setIsDragOver]    = useState(false);

  useEffect(() => {
    if (!rateConPdf || !showPdfViewer) { setPdfObjectUrl(''); return; }
    let cancelled = false;

    if (rateConPdf.startsWith('data:')) {
      // Fresh base64 upload (not yet uploaded) — convert to object URL locally.
      const byteStr = atob(rateConPdf.split(',')[1]);
      const ab = new ArrayBuffer(byteStr.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
      const blob = new Blob([ab], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      setPdfObjectUrl(url);
      return () => { cancelled = true; URL.revokeObjectURL(url); };
    }
    if (rateConPdf.startsWith('blob:')) {
      setPdfObjectUrl(rateConPdf);
      return () => { cancelled = true; };
    }

    // Stored on the load — ask the API for a signed URL (or pass-through
    // for legacy data: URLs stored before the storage migration).
    const ev = modalEventId ? events.find(e => e.id === modalEventId) : undefined;
    if (!ev?.loadId) { setPdfObjectUrl(''); return () => { cancelled = true; }; }
    setPdfObjectUrl(''); // clear stale URL while re-fetching
    import('@/lib/railway').then(({ railway }) => railway.getRateConUrl(ev.loadId!))
      .then(({ url }) => {
        if (cancelled) return;
        if (url) setPdfObjectUrl(url);
        // No rate-con on file is a normal state for loads that haven't
        // had one uploaded yet — keep the URL empty and let the docs
        // panel render "No rate con uploaded" without log noise.
      })
      .catch(err => { if (!cancelled) console.error('[PDF] rate-con URL fetch error:', err); });
    return () => { cancelled = true; };
  }, [rateConPdf, showPdfViewer, pdfRetryKey, modalEventId, events]);


  // Relay state — N-leg model. The legs themselves are DERIVED from the
  // store (every event sharing the load's load_id, in leg order); the
  // modal keeps only the edit buffers:
  //   legPays   — per-leg driver pay, keyed by event id ('leg0' for the
  //               first leg of a load being created, draft key for
  //               not-yet-saved legs).
  //   legEdits  — driver/truck overrides for persisted NON-viewed legs.
  //   draftLegs — legs that don't exist server-side yet (create-mode
  //               splits, or the single pending handoff in edit mode).
  //   pendingSplitStopId — the unsaved relay marker created by "Add
  //               handoff" in edit mode; Save turns it into a
  //               POST /split-relay against the viewed leg.
  const [relayGroupId,       setRelayGroupId]       = useState<string | undefined>(undefined);
  const [relayRole,          setRelayRole]          = useState<'pickup' | 'transfer' | 'delivery' | undefined>(undefined);
  const [legPays,            setLegPays]            = useState<Record<string, number | ''>>({});
  const [legEdits,           setLegEdits]           = useState<Record<string, { assetId?: number; driverName?: string }>>({});
  const [draftLegs,          setDraftLegs]          = useState<Array<{ key: string; assetId: number; driverName: string }>>([]);
  const [pendingSplitStopId, setPendingSplitStopId] = useState<string | null>(null);
  /** Event id of the leg the pending handoff splits — any leg, not just
   *  the viewed one (per-leg "+ Add handoff" on each card). null while
   *  no split is pending; falls back to the viewed leg for safety. */
  const [pendingSplitTargetId, setPendingSplitTargetId] = useState<string | null>(null);
  /** Synchronous re-entry lock for addHandoff in edit mode. State-based
   *  guards (pendingSplitStopId) read stale closures under rapid double
   *  clicks — two clicks in one commit both saw null and inserted two
   *  relay markers while draftLegs (a replace, not append) kept one
   *  draft leg. That marker/leg mismatch is what made Save no-op. A ref
   *  flips immediately, so the second click bails. */
  const pendingSplitLockRef = useRef(false);

  // ── Leg plan (identity follows the leg, never the index) ───────────
  //
  // The ordered list of legs the dispatcher is building, with each
  // entry's link to the persisted event it IS. Handoff operations
  // MUTATE this plan; it is rebuilt only when the modal opens or after
  // a successful reconcile — never re-derived per render.
  //
  // Deriving leg→event from array position (the old `relayLegs[i]`) is
  // what corrupted Matt's load: remove a handoff and every later leg
  // shifts down a slot, so an event silently reattaches to a different
  // route segment while leg count and handoff count stay consistent.
  const [legPlan, setLegPlan] = useState<PlannedLeg[]>([]);
  /** eventIds freed by a merge. They are soft-deleted on save and must
   *  NEVER be handed to a leg created later — remove-then-add is
   *  exactly the sequence that reattached the wrong driver. */
  const [releasedEventIds, setReleasedEventIds] = useState<string[]>([]);
  /** Stable keys for plan slots that have no persisted leg to adopt.
   *  Minted ONCE per slot and reused across refits — an index-derived
   *  key (`seg:i`) changes whenever the plan is refitted, which orphans
   *  that leg's entry in legEdits/legPays and silently reverts the
   *  dispatcher's driver/truck to the persisted (often empty) value.
   *  Index is not identity — the same mistake class as the original
   *  positional-leg bug. */
  const padKeysRef = useRef<string[]>([]);
  /** Load ids whose full leg set is currently being fetched. While a
   *  load is in here we KNOW the plan is incomplete, so slots we
   *  haven't loaded render as "loading" rather than as a blank
   *  editable card that reads like "unassigned". */
  const [legsFetchingLoadIds, setLegsFetchingLoadIds] = useState<string[]>([]);
  /** Fields the dispatcher explicitly cleared this session, keyed by
   *  eventId. Distinguishes "I chose — No driver —" (honour it) from
   *  "the buffer went missing" (never write the clear). */
  const [explicitClears, setExplicitClears] = useState<Record<string, { driver?: boolean }>>({});

  const isExistingRelayLeg = isEdit && !!relayRole;

  // ── Leg builder ────────────────────────────────────────────────────
  // On a saved revenue load, legs are DERIVED from the stop list's
  // handoff boundaries (a bare relay point OR a real stop flagged
  // isHandoff) rather than from persisted events, so the dispatcher can
  // author several handoffs and commit them in one PUT /legs reconcile.
  // Create mode keeps the draftLegs + POST /v1/loads path.
  const currentEv = isEdit && modalEventId ? events.find(e => e.id === modalEventId) : undefined;
  const isLegBuilder = isEdit && eventKind === 'revenue' && !!currentEv?.loadId && !isBatch;
  // Create mode gets the SAME builder affordances (rail, LEG tags,
  // per-stop handoff toggle, between-stops insert rows) so the surface
  // looks and behaves identically before and after the first save.
  // It can't hit the identity-drift bug class: there are no persisted
  // events, so nothing can be soft-deleted or mis-mapped — the worst
  // case is a driver on the wrong draft leg, visible before saving.
  // Its ordered leg list is `draftLegs` (leg 0 is the form itself),
  // which is already a keyed array — the plan minus eventId — so the
  // edit path's legPlan machinery is deliberately left untouched.
  const isCreateLegBuilder = !isEdit && eventKind === 'revenue' && !isBatch;
  /** Whether the builder affordances render at all (either mode). */
  const showLegBuilderUi = isLegBuilder || isCreateLegBuilder;
  const boundaryIdxs = useMemo(() => handoffIndexes(stops), [stops]);
  /** Leg count implied by the CURRENT stop list (what Apply would write). */
  const derivedLegCount = boundaryIdxs.length + 1;

  // All legs of the viewed load, leg order, straight from the store —
  // GET /v1/events/:id returns every leg and the open-effect backfills
  // any that fell outside the calendar's loaded window.
  const relayLegs = useMemo<CalendarEvent[]>(() => {
    if (!isEdit || !currentEv?.loadId) return [];
    if (!currentEv.relayRole) return [currentEv];
    return events.filter(e => e.loadId === currentEv.loadId).sort(byLegIndex);
  }, [events, isEdit, currentEv]);

  /**
   * The plan RECONCILED to the route. Stops are the single source of
   * truth for how many legs there are: a load has exactly one leg per
   * route segment (handoff boundaries + 1). This fits the stored plan
   * to that shape and silently repairs anything inconsistent —
   * duplicate, released or foreign eventIds lose their identity and
   * become new legs; surplus entries are dropped; missing entries are
   * appended. Nothing here ever blocks a save: an out-of-shape load
   * heals by pressing Save, which is what Matt asked for.
   *
   * Padded entries draw their key from padKeysRef — minted once per
   * slot and reused across refits. They were keyed by array index
   * (`seg:i`), which orphaned a slot's edit buffer the moment the plan
   * refitted and silently wrote nulls over an assignment on save. Index
   * is not identity here either.
   */
  const effectivePlan = useMemo<PlannedLeg[]>(() => {
    if (!isLegBuilder) return [];
    const base = legPlan.length > 0 ? legPlan : planFromLegs(relayLegs);
    const claimed = new Set<string>();
    // "Not in relayLegs" only means "not on this load" once we've
    // actually FETCHED this load's legs. While the backfill is in
    // flight, a leg we haven't received yet is missing from relayLegs —
    // and treating that as foreign dropped its identity. The plan then
    // read as "this leg is being removed" (a delete confirmation right
    // after the dispatcher ADDED one) and the save either recreated the
    // leg as new or was rejected. Worse, once the dispatcher touched the
    // plan it stopped being pristine, so the re-seed that would have
    // healed it never ran and the wrong state stuck.
    const legSetKnown = !currentEv?.loadId
      || !legsFetchingLoadIds.includes(currentEv.loadId);
    const cleaned: PlannedLeg[] = base.map(p => {
      if (!p.eventId) return p;
      const unusable = releasedEventIds.includes(p.eventId)
        || claimed.has(p.eventId)
        || (legSetKnown && !relayLegs.some(l => l.id === p.eventId));
      if (unusable) return { key: p.key };        // keep the slot, drop the identity
      claimed.add(p.eventId);
      return p;
    });
    const out = cleaned.slice(0, derivedLegCount);
    // Short plan → pad. Adopt any still-unclaimed persisted leg in leg
    // order FIRST (the same convergent adoption the server does), so a
    // padded slot arrives with its driver, truck, pay and eventId
    // intact. Only when nothing is left to adopt do we mint a genuinely
    // new leg. Blank padding is what left Matt's delivery leg
    // unassigned after a merge — and an assetId-less leg is exactly
    // what the server 400s on.
    const unclaimed = relayLegs.filter(l => !claimed.has(l.id) && !releasedEventIds.includes(l.id));
    let next = 0;
    for (let i = out.length; i < derivedLegCount; i++) {
      const adopt = unclaimed[next];
      if (adopt) {
        next++;
        claimed.add(adopt.id);
        out.push({ key: adopt.id, eventId: adopt.id });
      } else {
        // Nothing left to adopt — a genuinely new slot. Its key must
        // survive refits, so mint once and reuse.
        const nth = out.filter(p => !p.eventId && p.key.startsWith('pad:')).length;
        padKeysRef.current[nth] ??= `pad:${crypto.randomUUID()}`;
        out.push({ key: padKeysRef.current[nth] });
      }
    }
    return out;
  }, [isLegBuilder, legPlan, relayLegs, releasedEventIds, derivedLegCount]);
  /** True when the form's start/end describe ONE LEG of a multi-leg
   *  load rather than the whole load's pickup and delivery. Gates the
   *  start↔end and start↔stops linkages, which are correct only when
   *  the two fields really are the load's own window. */
  const isMultiLegView = isExistingRelayLeg || derivedLegCount > 1 || draftLegs.length > 0;
  /** True while this load's legs are still arriving: the backfill is in
   *  flight AND we can see fewer legs than the route has segments. The
   *  difference between "we don't know yet" and "genuinely unassigned"
   *  — the former must never render as an editable blank card. */
  const legsLoading = isLegBuilder
    && !!currentEv?.loadId
    && legsFetchingLoadIds.includes(currentEv.loadId)
    && relayLegs.length < derivedLegCount;
  const isRelayContext = draftLegs.length > 0 || isExistingRelayLeg
    || (isLegBuilder && derivedLegCount > 1);
  /**
   * The LOAD's overall window: first leg start → last leg end, taken
   * from the PERSISTED legs (server truth), never from the form.
   *
   * The form's startDate/endDate describe the VIEWED LEG, but a
   * dispatcher reads them as the load's pickup and delivery. Sourcing
   * the load window from them made every handoff drag the delivery
   * earlier (splitting clamps the viewed leg's end to the new handoff
   * time) and let an edit on one leg move another leg's boundary.
   * Adding or removing a handoff only subdivides the interior — this
   * window is invariant under it.
   */
  const loadWindow = useMemo<{ start: string; end: string } | null>(() => {
    if (relayLegs.length === 0) return null;
    let start = relayLegs[0].start;
    let end   = relayLegs[0].end;
    for (const l of relayLegs) {
      if (l.start && l.start < start) start = l.start;
      if (l.end   && l.end   > end)   end   = l.end;
    }
    return { start, end };
  }, [relayLegs]);
  const viewedArrIdx = relayLegs.findIndex(l => l.id === modalEventId);
  const otherLegs = useMemo(
    () => relayLegs.filter(l => l.id !== modalEventId),
    [relayLegs, modalEventId],
  );
  // Marker-relative position of the viewed leg (drives the per-leg
  // stops window + miles slice). Explicit legIndex wins; fall back to
  // array position, then to the legacy role mapping.
  const viewedLegIdx: number | undefined = isExistingRelayLeg
    ? (currentEv?.legIndex ?? (viewedArrIdx >= 0 && relayLegs.length > 1
        ? viewedArrIdx
        : relayRole === 'pickup' ? 0
        : relayRole === 'delivery' ? Math.max(1, (currentEv?.legCount ?? 2) - 1)
        : 1))
    : undefined;
  // ── Finalized-pay gate (solo loads) ───────────────────────────────
  // Relay legs get their own per-card gate inside RelayLegsEditor.
  const soloFinalized = useLoadPayFinalized(driverName, startDate);

  // Slice a full merged stop list down to one leg's window: marker i
  // sits between leg i and leg i+1; leg i runs from marker i-1 (or the
  // first stop) through marker i (or the last stop), boundary markers
  // included. legIdx==null → whole route minus the markers (create mode
  // editing the whole load).
  const legWindowSlice = (list: Stop[], legIdx: number | undefined): Stop[] => {
    // Boundaries are relay points AND real stops flagged isHandoff —
    // always via the shared helper, never a `type === 'relay'` test.
    const markerIdxs = handoffIndexes(list);
    if (markerIdxs.length === 0) return list;
    if (legIdx == null) return list.filter(s => s.type !== 'relay');
    const lo = legIdx === 0 ? 0 : (markerIdxs[legIdx - 1] ?? 0);
    const hi = legIdx >= markerIdxs.length ? list.length - 1 : markerIdxs[legIdx];
    return list.slice(lo, hi + 1);
  };

  // Compute loaded mileage from geocoded stops via Mapbox Directions.
  // For relay legs, only count stops inside the viewed leg's window.
  // Skipped when status is 'tonu' or 'cancelled' (load didn't move → 0 miles).
  useEffect(() => {
    if (status === 'tonu' || status === 'cancelled') {
      setLoadedMiles(0);
      return;
    }
    const legStops = legWindowSlice(stops, viewedLegIdx);
    const geocoded = legStops
      .filter(s => s.lat != null && s.lng != null)
      .map(s => ({ lat: s.lat!, lng: s.lng! }));
    if (geocoded.length < 2) { setLoadedMiles(null); return; }
    let cancelled = false;
    import('@/lib/directions').then(({ calcRoadMiles }) =>
      calcRoadMiles(geocoded).then(miles => { if (!cancelled) setLoadedMiles(miles); })
    );
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops, viewedLegIdx, status]);

  // Other legs' miles — relay loads only, so the header can show the
  // whole-haul total (Σ legs) and each leg card its share. Keyed by
  // event id. Recomputes only when a sibling leg's geometry actually
  // changes (stable key below), not on every store identity churn.
  const otherLegsGeomKey = useMemo(
    () => JSON.stringify(otherLegs.map(l => [
      l.id, l.legIndex,
      (l.stops ?? []).map(s => [s.type, s.lat, s.lng]),
    ])),
    [otherLegs],
  );
  useEffect(() => {
    if (otherLegs.length === 0) { setOtherLegMiles({}); return; }
    let cancelled = false;
    void import('@/lib/directions').then(({ calcRoadMiles }) => {
      for (const leg of otherLegs) {
        const ls = leg.stops ?? [];
        const mIdxs = ls.reduce<number[]>((acc, s, i) => { if (s.type === 'relay') acc.push(i); return acc; }, []);
        const li = leg.legIndex ?? (
          leg.relayRole === 'pickup' ? 0
          : leg.relayRole === 'delivery' ? mIdxs.length
          : Math.min(1, Math.max(0, mIdxs.length - 1)));
        const slice = legWindowSlice(ls, li)
          .filter(s => s.lat != null && s.lng != null)
          .map(s => ({ lat: s.lat!, lng: s.lng! }));
        if (slice.length < 2) continue;
        void calcRoadMiles(slice).then(m => {
          if (cancelled || m == null) return;
          setOtherLegMiles(prev => (prev[leg.id] === m ? prev : { ...prev, [leg.id]: m }));
        });
      }
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otherLegsGeomKey]);

  // ── Lazy cache: persist routed loadedMiles back to events.loaded_miles
  // so reports / dashboards can pull from the column instead of re-running
  // Google Directions. Fires once per modal-open when the computed value
  // differs from what's stored (rounded to 0.1 mi to avoid noisy writes).
  //
  // Also clears the column when the event no longer has enough
  // coordinates to compute miles (loadedMiles === null) but the DB
  // still has a stale value. Without this branch, a maintenance
  // event that briefly had geocoded stops keeps its 87-mi remnant
  // forever, polluting per-driver tables and any miles-based
  // analytics.
  useEffect(() => {
    if (!isEdit || !modalEventId) return;
    const ev = events.find(e => e.id === modalEventId);
    if (!ev) return;
    const stored = ev.loadedMiles ?? null;
    // Computed null + column has stale value → clear it. Cast to any
    // because CalendarEvent's local type is `number | undefined` but
    // the API accepts `number | null` for an explicit clear; the
    // store/buildEventByIdUpdate copies the field through verbatim,
    // so null on the wire is what we need.
    if (loadedMiles == null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (stored != null) void updateEvent(modalEventId, { loadedMiles: null as any });
      return;
    }
    const next = Math.round(loadedMiles * 10) / 10;
    if (stored != null && Math.abs(stored - next) < 0.1) return;
    void updateEvent(modalEventId, { loadedMiles: next });
  }, [loadedMiles, isEdit, modalEventId, events, updateEvent]);

  // Persist the other legs' computed miles back to events.loaded_miles
  // — same lazy-cache rule as the viewed leg above (0.1 mi threshold
  // keeps this from ping-ponging with its own optimistic write).
  useEffect(() => {
    for (const leg of otherLegs) {
      const computed = otherLegMiles[leg.id];
      if (computed == null) continue;
      const stored = leg.loadedMiles ?? null;
      const next   = Math.round(computed * 10) / 10;
      if (stored != null && Math.abs(stored - next) < 0.1) continue;
      void updateEvent(leg.id, { loadedMiles: next });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otherLegMiles]);

  // Auto-fill driver pay from percentage setting whenever load price changes.
  // Handles loadPrice as either number or numeric string (AI parses sometimes
  // return "1500.00"); only fills if driverPay is empty/zero or was previously
  // auto-set, so manual entries aren't clobbered.
  useEffect(() => {
    if (driverPayPct == null) return;
    const lpRaw = fieldValues['loadPrice'];
    const lp = typeof lpRaw === 'number' ? lpRaw : parseFloat(String(lpRaw ?? ''));
    if (!Number.isFinite(lp) || lp <= 0) return;
    const dpRaw = fieldValues['driverPay'];
    const dp = typeof dpRaw === 'number' ? dpRaw : parseFloat(String(dpRaw ?? ''));
    const dpIsSet = Number.isFinite(dp) && dp > 0;
    if (!driverPayAutoSet.current && dpIsSet) return;
    const auto = Math.round(lp * (driverPayPct / 100) * 100) / 100;
    if (dp === auto) return; // avoid no-op state updates
    setFieldValues(prev => ({ ...prev, driverPay: auto }));
    driverPayAutoSet.current = true;
    setDriverPayIsAuto(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldValues['loadPrice'], driverPayPct]);

  // Resolve the driver name to display for an event. Looks up by
  // driverId FK first — rename-resistant — then falls back to the
  // stored name string for legacy rows that don't have the FK set
  // yet. Empty string when neither resolves so the dropdown shows
  // "— No driver —".
  const resolveDriverNameForEvent = (ev: CalendarEvent): string => {
    if (ev.driverId != null) {
      const d = drivers.find(x => x.id === ev.driverId);
      if (d) return canonicalDriverName(d);
    }
    if (ev.driverName) {
      const d = findDriverByName(ev.driverName);
      if (d) return canonicalDriverName(d);
      return ev.driverName;
    }
    return '';
  };

  // Re-initialize form from a CalendarEvent (used by conflict "Reload" banner)
  const reinitForm = (ev: CalendarEvent) => {
    setTitle(ev.title);
    setAssetId(ev.assetId);
    setDriverName(resolveDriverNameForEvent(ev));
    const [sd, st = ''] = ev.start.split('T');
    const [ed, et = ''] = ev.end.split('T');
    prevStartDateRef.current = sd;
    setStartDate(sd); setStartTime(st.slice(0, 5));
    setEndDate(ed);   setEndTime(et.slice(0, 5));
    setStatus(ev.status ?? 'scheduled');
    setPriority(ev.priority ?? false);
    setLinkedTrailerId(ev.trailerId);
    const vals: Record<string, string | number | boolean | string[] | RefNum[]> = {};
    ALL_FIELDS.forEach(f => {
      const v = (ev as unknown as Record<string, unknown>)[f.id];
      if (v !== undefined) vals[f.id] = v as string | number | boolean;
    });
    // load.notes is the canonical column for the consolidated notes field
    if (vals['specialInstructions'] === undefined && ev.notes) vals['specialInstructions'] = ev.notes;
    // customerId isn't in ALL_FIELDS (internal FK, not a UI field) but
    // the broker→customerId sync effect compares against it on open.
    // Seed it from the loaded event so the effect doesn't see a phantom
    // mismatch and flag the form as dirty before the user touches it.
    if (ev.customerId) vals['customerId'] = ev.customerId;
    setFieldValues(vals);
    setRateConPdf(ev.rateConPdf ?? undefined);
    // Snapshot the loaded rate-con path so doSave can skip writing
    // it when the user didn't touch it (see rateConOriginal docs).
    setRateConOriginal(ev.rateConPdf ?? undefined);
    setAccessorials(ev.accessorials ?? []);
    setStops(ev.stops ?? []);
    setEventKind(ev.eventKind ?? 'revenue');
    setNonRevenueType(ev.nonRevenueType ?? 'Maintenance');
    setInternalNotes(ev.internalNotes ?? []);
    setOriginalInternalNotes(ev.internalNotes ?? []);
    setNoteComposer('');
    setNoteComposerOpen(false);
  };

  useEffect(() => {
    if (!modalOpen) { setConfirmDel(false); setConfirmRemoveRateCon(false); setConfirmSkip(false); setConfirmBatchCancel(false); setParseState('idle'); setParseError(''); setRateConPdf(undefined); setRateConOriginal(undefined); setShowPdfViewer(false); setShowMapPanel(false); setIsDirty(false); setShowSavePrompt(false); setAccessorials([]); setStops([]); setBrokerMatch({ status: 'none' }); setBrokerSaveBlocked(false); setShowBrokerProfile(false); setDupLoadNum(null); setPendingSave(null); setGeocodeBlock(null); setLoadedMiles(null); setOtherLegMiles({}); setShowDriverSummary(false); setLinkedTrailerId(undefined); setPriority(false); setEventKind('revenue'); setNonRevenueType('Maintenance'); setDocsTab('rateCon'); setLoadDocuments([]); setLoadInvoices([]); setSelectedDocUrl(null); setSelectedDocId(null); setAuditLog([]); setInternalNotes([]); setOriginalInternalNotes([]); setNoteComposer(''); setNoteComposerOpen(false); setPendingNewBroker(null); setLegPays({}); setLegEdits({}); setDraftLegs([]); setPendingSplitStopId(null); setPendingSplitTargetId(null); pendingSplitLockRef.current = false; setLegPlan([]); setReleasedEventIds([]); setExplicitClears({}); padKeysRef.current = []; setLegsFetchingLoadIds([]); setSuggestAssetSwap(null); setSuggestDriverSwap(null); return; }
    setParseState('idle'); setParseError('');
    setRateConPdf(undefined); setRateConOriginal(undefined); setShowPdfViewer(false); setShowMapPanel(modalShowMap);
    setIsDirty(false); setShowSavePrompt(false);
    setRelayGroupId(undefined); setRelayRole(undefined);
    setLegPays({}); setLegEdits({}); setDraftLegs([]); setPendingSplitStopId(null); setPendingSplitTargetId(null);
    pendingSplitLockRef.current = false;
    reinstatingRef.current = false;
    unsplittingRef.current = false;
    setLegPlan([]); setReleasedEventIds([]); setExplicitClears({});
    padKeysRef.current = [];
    setAccessorials([]);
    // Internal notes are scoped to a single load — never carry across
    // duplicate / +1 Week / drag-create transitions. The edit branch
    // re-seeds them from the loaded event below.
    setInternalNotes([]);
    setOriginalInternalNotes([]);
    setNoteComposer('');
    setNoteComposerOpen(false);
    setBrokerMatch({ status: 'none' }); setBrokerSaveBlocked(false); setShowBrokerProfile(false); setDupLoadNum(null); setPendingSave(null);
    setLinkedTrailerId(undefined);
    driverPayAutoSet.current = false;
    setDriverPayIsAuto(false);
    setPrevDriverPay(null);

    if (isEdit && modalEventId) {
      const ev = events.find(e => e.id === modalEventId);
      if (!ev) return;
      setTitle(ev.title);
      setAssetId(ev.assetId);
      setDriverName(resolveDriverNameForEvent(ev));
      const [sd, st = ''] = ev.start.split('T');
      const [ed, et = ''] = ev.end.split('T');
      prevStartDateRef.current = sd;
      setStartDate(sd); setStartTime(st.slice(0, 5));
      setEndDate(ed);   setEndTime(et.slice(0, 5));
      setStatus(ev.status ?? 'scheduled');
      setPriority(ev.priority ?? false);
      setLinkedTrailerId(ev.trailerId);

      // Load all optional field values from the event
      const vals: Record<string, string | number | boolean | string[] | RefNum[]> = {};
      ALL_FIELDS.forEach(f => {
        const v = (ev as unknown as Record<string, unknown>)[f.id];
        if (v !== undefined) vals[f.id] = v as string | number | boolean;
      });
      // load.notes is the canonical column for the consolidated notes field
      if (vals['specialInstructions'] === undefined && ev.notes) vals['specialInstructions'] = ev.notes;
      setFieldValues(vals);
      setRateConPdf(ev.rateConPdf ?? undefined);
      // Mirror reinitForm's baseline snapshot so this path doesn't
      // accidentally start the modal "dirty" with respect to rate con.
      setRateConOriginal(ev.rateConPdf ?? undefined);
      setAccessorials(ev.accessorials ?? []);
      setStops(ev.stops ?? []);
      setEventKind(ev.eventKind ?? 'revenue');
      setNonRevenueType(ev.nonRevenueType ?? 'Maintenance');
      setInternalNotes(ev.internalNotes ?? []);
      setOriginalInternalNotes(ev.internalNotes ?? []);
      setNoteComposer('');
      setNoteComposerOpen(false);

      // Treat the leg as part of a relay if EITHER load_id grouping (post-2.5a)
      // OR legacy relayGroupId is present, AND relayRole is set.
      const groupKey = ev.loadId ?? ev.relayGroupId;
      if (groupKey && ev.relayRole) {
        setRelayGroupId(groupKey);
        setRelayRole(ev.relayRole);
        // Sibling legs come straight from the store (relayLegs derives
        // from `events`); legPays seeds from them in the effect below.
        // Fallback: legs outside the calendar's loaded window → fetch
        // the whole load and merge every leg into the store.
        if (ev.loadId) {
          const cachedLegCount = events.filter(e => e.loadId === ev.loadId).length;
          const expected = ev.legCount ?? 2;
          if (cachedLegCount < expected) {
            const fetchingId = ev.loadId;
            setLegsFetchingLoadIds(prev => prev.includes(fetchingId) ? prev : [...prev, fetchingId]);
            import('@/lib/railway').then(({ railway }) => railway.getLoad(fetchingId))
              .then(({ loads }) => mergeEvents(loads as CalendarEvent[]))
              .catch(err => console.error('relay-legs fetch:', err))
              .finally(() => setLegsFetchingLoadIds(prev => prev.filter(id => id !== fetchingId)));
          }
        }
      }
    } else if (isBatch) {
      const batchItem = batchItems[batchIndex];
      if (batchItem) {
        const p = batchItem.parsed;
        const today = localDateStr(currentDate);
        // Title generated after broker+stops are resolved below
        const initialAssetId = assets[0]?.id ?? 1;
        setAssetId(initialAssetId);
        setDriverName(preferredDriverName(initialAssetId));
        if (typeof p.start === 'string') {
          const [sd, st = '08:00'] = p.start.split('T');
          prevStartDateRef.current = sd;
          setStartDate(sd); setStartTime(st.slice(0, 5));
          if (!p.end) setEndDate(sd);
        } else {
          prevStartDateRef.current = today;
          setStartDate(today); setStartTime('08:00');
          setEndDate(today);   setEndTime('17:00');
        }
        if (typeof p.end === 'string') {
          const [ed, et = '17:00'] = p.end.split('T');
          setEndDate(ed); setEndTime(et.slice(0, 5));
        }
        setStatus('scheduled');
        const vals: Record<string, string | number | boolean | string[] | RefNum[]> = {};
        ALL_FIELDS.forEach(f => {
          const v = p[f.id];
          if (v !== undefined) vals[f.id] = v as string | number | boolean;
        });
        setRateConPdf(batchItem.rateConPdf);
        // Don't reseed rateConOriginal — batch parse just dropped a
        // fresh rate con into a load context; leaving the baseline
        // alone (typically undefined for new loads) means the
        // skip-if-unchanged check sees a real change and saves the
        // new path. See rateConOriginal docs.
        setShowPdfViewer(true);
        if (Array.isArray(p.stops) && p.stops.length > 0) {
          setStops((p.stops as Stop[]).map((s, i) => ({ ...s, id: crypto.randomUUID(), eventId: '', sequence: i + 1 })));
        }
        // Run broker matching same as single-parse flow
        if (p.broker) {
          const match = matchCustomer(String(p.broker), customers);
          if (match.status === 'auto') {
            vals['broker']     = match.customer.name;
            vals['customerId'] = match.customer.id;
            if (String(p.broker).trim() !== match.customer.name) {
              void addCustomerAlias(match.customer.id, String(p.broker).trim());
            }
          }
          setBrokerMatch(match);
        }
        // Coerce numeric fields the AI may have returned as strings (e.g. "1500.00")
        const lpNum = vals['loadPrice'] != null ? parseFloat(String(vals['loadPrice'])) : NaN;
        if (Number.isFinite(lpNum)) vals['loadPrice'] = lpNum;
        const dpNum = vals['driverPay'] != null ? parseFloat(String(vals['driverPay'])) : NaN;
        if (Number.isFinite(dpNum)) vals['driverPay'] = dpNum;

        // Driver-pay: if a percentage is configured in settings, it always
        // wins. Otherwise keep whatever the AI extracted (if any).
        driverPayAutoSet.current = false;
        setDriverPayIsAuto(false);
        if (driverPayPct != null && Number.isFinite(lpNum) && lpNum > 0) {
          vals['driverPay'] = Math.round(lpNum * (driverPayPct / 100) * 100) / 100;
          driverPayAutoSet.current = true;
          setDriverPayIsAuto(true);
        }
        // Default dispatcher fallback (rate cons rarely name a dispatcher).
        const defaultDispatcher = dispatchers.find(d => d.isDefault);
        if (defaultDispatcher && !vals['dispatcher']) vals['dispatcher'] = `${defaultDispatcher.firstName} ${defaultDispatcher.lastName}`;
        setFieldValues(vals);
        // Generate title from resolved broker + stops (use raw values, not state which hasn't updated yet)
        const batchBroker = typeof vals['broker'] === 'string' ? vals['broker'] : (p.broker ? String(p.broker) : undefined);
        const batchStops  = Array.isArray(p.stops) && p.stops.length > 0
          ? (p.stops as Stop[]).map((s, i) => ({ ...s, id: crypto.randomUUID(), eventId: '', sequence: i + 1 }))
          : [];
        setTitle(generateLoadTitle(batchBroker, batchStops, customers) || (typeof p.summary === 'string' ? p.summary : ''));
        setParseState('done');
      }
    } else {
      const d = modalDefaults ?? {};
      const today = localDateStr(currentDate);
      const [sd, st = '08:00'] = (d.start ?? `${today}T08:00`).split('T');
      const [ed, et = '09:00'] = (d.end   ?? `${today}T09:00`).split('T');
      setTitle(d.title ?? '');
      // Apply event-kind defaults — without these the modal would
      // ignore eventKind/nonRevenueType from the caller and always
      // open as a revenue load. (See: WorkOrderModal's "Schedule on
      // calendar" handoff, which passes eventKind='non_revenue',
      // nonRevenueType='Maintenance' so the dispatcher lands on the
      // right form straight away.)
      if (d.eventKind)      setEventKind(d.eventKind);
      if (d.nonRevenueType) setNonRevenueType(d.nonRevenueType);
      const initialAssetId = d.assetId ?? assets[0]?.id ?? 1;
      setAssetId(initialAssetId);
      setDriverName(
        d.driverName
          ? (canonicalDriverName(findDriverByName(d.driverName) ?? { name: d.driverName }) || d.driverName)
          : preferredDriverName(initialAssetId)
      );
      prevStartDateRef.current = sd;
      setStartDate(sd); setStartTime(st.slice(0, 5));
      setEndDate(ed);   setEndTime(et.slice(0, 5));
      setStatus('scheduled');

      // Seed optional fields from defaults; auto-fill default dispatcher
      const vals: Record<string, string | number | boolean | string[] | RefNum[]> = {};
      ALL_FIELDS.forEach(f => {
        const v = (d as Record<string, unknown>)[f.id];
        if (v !== undefined) vals[f.id] = v as string | number | boolean;
      });
      const defaultDispatcher = dispatchers.find(d => d.isDefault);
      if (defaultDispatcher && !vals['dispatcher']) vals['dispatcher'] = `${defaultDispatcher.firstName} ${defaultDispatcher.lastName}`;
      setFieldValues(vals);
      if (Array.isArray(d.stops) && d.stops.length > 0) {
        setStops((d.stops as Stop[]).map((s, i) => ({ ...s, id: crypto.randomUUID(), eventId: '', sequence: i + 1 })));
      }
    }
    setConfirmDel(false);
    setConfirmSkip(false);
    setConfirmBatchCancel(false);
    // Drain the cross-page handoff buffer if it was set (e.g. user
    // came from a maintenance work order via "Schedule on calendar"
    // — that flow stuffs the WO IDs into prefillWorkOrderLinkIds so
    // they pre-check here and the very first save links them).
    // Otherwise clear, so a previous session's selections don't leak.
    setPendingWorkOrderLinks(prefillWorkOrderLinkIds ?? []);
  }, [modalOpen, modalEventId, batchIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // Seed the leg plan from the load's persisted legs. Runs when the
  // modal opens (plan empty) and when a late leg backfill lands while
  // the dispatcher hasn't started editing structure yet — never once
  // the plan diverges from the persisted set, because from that point
  // the plan IS the source of truth for leg identity.
  useEffect(() => {
    if (!modalOpen || !isLegBuilder) return;
    if (relayLegs.length === 0) return;
    setLegPlan(prev => {
      if (prev.length === 0) return planFromLegs(relayLegs);
      // Structure untouched so far (same events, same order) → refresh
      // in place so a backfilled sibling leg joins the plan.
      const prevIds = prev.map(p => p.eventId ?? '').join(',');
      const liveIds = relayLegs.map(l => l.id).join(',');
      if (prevIds === liveIds) return prev;
      // Only adopt the live set when the dispatcher hasn't touched
      // structure yet AND the arrival is a strict superset (a sibling
      // leg finished loading). Any edit in progress wins — the plan is
      // the source of truth for identity from the first mutation on.
      const planIsPristine = prev.every(p => p.eventId) && releasedEventIds.length === 0;
      const isBackfill = planIsPristine
        && relayLegs.length > prev.length
        && prev.every(p => relayLegs.some(l => l.id === p.eventId));
      return isBackfill ? planFromLegs(relayLegs) : prev;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalOpen, isLegBuilder, relayLegs.map(l => l.id).join(','), releasedEventIds.length]);

  // Seed per-leg pay from each leg's stored driver_pay as legs land in
  // the store (including the async whole-load backfill above). Only
  // ADDS missing keys — a value the dispatcher already typed (even a
  // deliberate clear to '') is never clobbered by late-arriving data.
  useEffect(() => {
    if (!modalOpen || !isExistingRelayLeg) return;
    setLegPays(prev => {
      let changed = false;
      const next = { ...prev };
      for (const leg of relayLegs) {
        if (!(leg.id in next)) { next[leg.id] = leg.driverPay ?? ''; changed = true; }
      }
      return changed ? next : prev;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalOpen, isExistingRelayLeg, relayLegs.map(l => l.id).join(',')]);

  // If the dispatcher deletes the PENDING handoff's relay point via the
  // stop trash icon, the split can no longer be saved — treat it as a
  // cancel: drop the draft leg and release the lock so the "+ Add
  // handoff" affordances come back. Without this, pendingSplitStopId
  // dangles and Save would keep erroring until Cancel leg was found.
  useEffect(() => {
    if (!pendingSplitStopId) return;
    if (stops.some(s => s.id === pendingSplitStopId)) return;
    setPendingSplitStopId(null);
    setPendingSplitTargetId(null);
    setDraftLegs([]);
    pendingSplitLockRef.current = false;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops, pendingSplitStopId]);

  // Auto-recover loads that landed in the cache with empty stops. The
  // user reported opening a load and seeing "+ Add Stop" instead of
  // the actual stops; we now fire a one-shot refetch in that case so
  // the form repopulates without them having to hit the refresh button.
  // Guarded on isEdit + a real event + non-relay (relay legs can
  // legitimately have a leg with empty draft stops mid-creation).
  //
  // ONE-SHOT — refetchedEventIdsRef tracks which event ids we've
  // already attempted recovery for in this modal session. Without it,
  // a load that genuinely has zero stops (or whose server response
  // doesn't include stops) sticks in an infinite refetch loop:
  // refetchEvent → updateEventFromRemote → `events` array gets a new
  // reference (even when the payload is identical) → this effect's
  // `events` dep fires again → stops still empty → refetch again.
  // The set is wiped when the modal closes or modalEventId changes,
  // so a stale recovery flag never leaks between loads.
  const refetchedEventIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!modalOpen) {
      refetchedEventIdsRef.current.clear();
    }
  }, [modalOpen]);
  useEffect(() => {
    refetchedEventIdsRef.current.clear();
  }, [modalEventId]);
  useEffect(() => {
    if (!modalOpen || !isEdit || !modalEventId) return;
    // Already attempted recovery for this event in this session —
    // accept whatever state the cache is in, don't loop.
    if (refetchedEventIdsRef.current.has(modalEventId)) return;
    const ev = events.find(e => e.id === modalEventId);
    // Don't stack refetches on top of an in-flight one.
    if (refetchingEventIds.has(modalEventId)) return;
    // Case A: event missing from the local cache entirely. Happens
    // when openEditModal was called with an event id from a different
    // week than the calendar's current view (e.g. clicking "View" on
    // a linked event from /equipment that's on next month). Without
    // this, the form-init useEffect silently bails on `if (!ev) return`
    // and the modal renders empty / stale — which is what the user
    // sees when "View doesn't show the correct event". Refetch by id
    // pulls just that row in and re-initializes the form.
    if (!ev) {
      refetchedEventIdsRef.current.add(modalEventId);
      void refetchEvent(modalEventId).then(() => {
        const fresh = useCalendarStore.getState().events.find(e => e.id === modalEventId) ?? useCalendarStore.getState().deletedEvents.find(e => e.id === modalEventId);
        if (fresh) reinitForm(fresh);
      });
      return;
    }
    // Case B: revenue load present but with empty stops (cache landed
    // in a partial state). Retry to fill stops.
    if (ev.eventKind === 'non_revenue') return;
    if ((ev.stops?.length ?? 0) > 0) return;
    refetchedEventIdsRef.current.add(modalEventId);
    void refetchEvent(modalEventId).then(() => {
      const fresh = useCalendarStore.getState().events.find(e => e.id === modalEventId) ?? useCalendarStore.getState().deletedEvents.find(e => e.id === modalEventId);
      if (fresh) reinitForm(fresh);
    });
  }, [modalOpen, modalEventId, events]); // eslint-disable-line react-hooks/exhaustive-deps

  // Force non-revenue for users without loads.create when opening the
  // modal in create mode. Maintenance has nonRevenueEvents.create only
  // — if they tried to save with eventKind='revenue' the API would
  // 403. Lock them into the right shape from the start.
  useEffect(() => {
    if (!modalOpen || isEdit) return;
    if (!canCreateRevenue && canCreateNonRevenue) {
      setEventKind('non_revenue');
    }
  }, [modalOpen, isEdit, canCreateRevenue, canCreateNonRevenue]);

  // Re-run broker matching when customers list loads after the modal opened.
  // (Initial match runs in the effect above with whatever customers were loaded at that moment;
  // if customers hadn't fetched yet, broker would be flagged 'new' incorrectly.)
  useEffect(() => {
    if (!modalOpen) return;
    const brokerVal = fieldValues['broker'];
    if (typeof brokerVal !== 'string' || !brokerVal.trim()) return;
    if (customers.length === 0) return;
    if (brokerMatch.status === 'auto' && brokerMatch.customer.name === brokerVal) return;
    const match = matchCustomer(brokerVal, customers);
    setBrokerMatch(match);
    if (match.status === 'auto' && brokerVal !== match.customer.name) {
      setFieldValues(prev => ({ ...prev, broker: match.customer.name }));
    }
  }, [customers, modalOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep `customerId` (the FK that downstream invoice generation
  // copies onto invoices.customer_id) in sync with the broker name.
  // Without this, every flow that sets `broker` — combobox pick,
  // banner confirm, AI parse, batch parse, new-customer create —
  // updates only the text and leaves customerId null. The result
  // was generated invoices with no broker linked, which then
  // couldn't be sent (no recipient lookup).
  //
  // Strategy: whenever broker text changes OR the customers list
  // changes, look the broker up by name+alias via matchCustomer.
  // Only `status === 'auto'` is an unambiguous match — for 'confirm'
  // and 'new' the user hasn't decided yet, so we leave customerId
  // alone (the banner action will eventually push the right name in
  // and trigger us again).
  useEffect(() => {
    if (!modalOpen) return;
    if (eventKind !== 'revenue') return;
    const brokerVal = String(fieldValues['broker'] ?? '').trim();
    const currentId = fieldValues['customerId'] as string | undefined;
    // setFieldValues directly (NOT setField) — this is an internal
    // correction, not a user edit, so it must not call markDirty.
    // Without that guard, every modal open for an existing load would
    // flag the form as dirty (the sync runs on init when fieldValues
    // is still being populated) and trigger a "save changes?" prompt
    // on close even when the user did nothing.
    const setCustomerId = (id: string) => setFieldValues(prev => ({ ...prev, customerId: id }));
    const clearCustomerId = () => setFieldValues(prev => {
      if (!('customerId' in prev)) return prev;
      const next = { ...prev };
      delete next.customerId;
      return next;
    });
    if (!brokerVal) {
      if (currentId) clearCustomerId();
      return;
    }
    if (customers.length === 0) return;
    const match = matchCustomer(brokerVal, customers);
    // ── Strict assign-only-on-strong-match policy ────────────────────
    // Previous behaviour also CLEARED currentId whenever the fuzzy
    // score dropped below 'auto' (0.85). That silently broke explicit
    // user picks: a dispatcher picks "England Logistics" from the
    // combobox → customerId set, broker text = "England Logistics".
    // Anything later that nudges the broker text — typo, AI re-parse,
    // banner edit — drops the score under 0.85, clearCustomerId fires,
    // and the FK is gone. The next save persists null and every
    // downstream invoice surface (Send modal, generate, batch-send)
    // shows "no broker linked" even though the dispatcher's table
    // still resolves the name visually via findCustomerForLoad's
    // text-fallback. That mismatch is exactly the "shows linked but
    // isn't linked" complaint.
    //
    // Now: only auto-SET when matchCustomer is confident. Never
    // auto-clear. An explicit pick stays sticky until the user
    // manually changes it via the picker (which writes a new FK
    // directly) or wipes the broker text (handled above).
    if (match.status === 'auto') {
      // Override when currentId is unset OR points to a different
      // customer than the one the broker text now identifies. The
      // common bug this catches:
      //   1. Load opens with broker="AM Trans", customer_id=null
      //   2. Sync auto-binds customerId → AM_TRANS_ID
      //   3. Dispatcher opens the picker, clicks "ITS National LLC"
      //      → onPick now writes both broker AND customerId. Done.
      //   4. (Or older path) if broker text just changes to a new
      //      customer's exact name via some other write — AI re-parse,
      //      banner confirm, alias update — we now correct customerId
      //      to match.
      // Score is ≥0.85 here so this is a confident match: trusting it
      // beats persisting a stale FK that the badge will lie about.
      // The earlier comment worried about clobbering "explicit user
      // picks" — those go through onPick now and set both fields
      // atomically, so the only override path left is when the broker
      // text itself definitively identifies a different customer.
      if (!currentId || currentId !== match.customer.id) {
        setCustomerId(match.customer.id);
      }
    }
    // 'confirm' / 'new' / 'none' with a currentId → keep currentId.
    // The banner flow handles ambiguous broker text by surfacing a
    // confirm UI; the auto-clear path here was racing that and
    // resolving the wrong way.
  }, [fieldValues['broker'], customers, modalOpen, eventKind]); // eslint-disable-line react-hooks/exhaustive-deps

  // If the asset list loads after the modal opened and the current assetId
  // doesn't exist in it, snap to the first available asset.
  // Skip in edit mode — the init effect already sets the correct assetId from
  // the event; running this correction would race and overwrite it with stale state.
  useEffect(() => {
    if (!modalOpen) return;
    if (assets.length === 0) return;
    if (isEdit && modalEventId && events.some(e => e.id === modalEventId)) return;
    if (assets.some(a => a.id === assetId)) return;
    const firstId = assets[0].id;
    setAssetId(firstId);
    if (!driverName) setDriverName(preferredDriverName(firstId));
  }, [assets, modalOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build optional payload from fieldValues
  const buildOptionalPayload = () => {
    const out: Record<string, unknown> = {};
    ALL_FIELDS.forEach(f => {
      if (f.id === 'trailer') return; // handled separately via linkedTrailerId
      const v = fieldValues[f.id];
      if (v === undefined || v === '' || v === false) { out[f.id] = undefined; return; }
      if (f.type === 'number') out[f.id] = v === '' ? undefined : parseFloat(String(v));
      else out[f.id] = v;
    });
    // customerId is an internal FK, deliberately absent from ALL_FIELDS
    // (it has no dedicated UI field — it's set by the broker picker as
    // a side-effect of choosing a real customer record, and by the
    // broker→customer sync effect when the typed text matches a
    // known customer's name). It MUST be included in the save payload
    // though, otherwise the FK never reaches the DB and downstream
    // batch-send / invoice flows can't reliably resolve the recipient.
    // Empty-string is normalised to null so a "(cleared)" picker write
    // actually clears the FK rather than landing as garbage.
    const cid = fieldValues['customerId'];
    out['customerId'] = (cid === undefined || cid === '') ? null : cid;
    return out;
  };

  // Mirrors apps/api/src/routes/loads.ts::diffAccessorialsForAudit so
  // an EventModal save and a /v1/loads PATCH from the load-detail
  // page produce structurally identical AccessorialChange[] entries.
  // If you extend the comparable field set here, also extend the
  // server helper — the two have to stay in sync or audit history
  // will look different depending on which surface edited the row.
  function diffAccessorials(prev: Accessorial[] = [], next: Accessorial[] = []): AccessorialChange[] {
    const changes: AccessorialChange[] = [];
    const prevMap = new Map(prev.map(a => [a.id, a]));
    const nextMap = new Map(next.map(a => [a.id, a]));
    for (const [id, a] of nextMap) {
      if (!prevMap.has(id)) {
        changes.push({
          action: 'added', id,
          category: a.category, description: a.description, amount: a.amount,
          newStatus:        a.status,
          newBillable:      a.billable,
          newPayToDriver:   a.payToDriver,
          newPayDriverName: a.payDriverName,
        });
      } else {
        const p = prevMap.get(id)!;
        const amountChanged       = (p.amount ?? 0) !== (a.amount ?? 0);
        const statusChanged       = (p.status ?? '') !== (a.status ?? '');
        const billableChanged     = !!p.billable     !== !!a.billable;
        const payToDriverChanged  = !!p.payToDriver  !== !!a.payToDriver;
        const payNameChanged      = (p.payDriverName ?? '') !== (a.payDriverName ?? '');
        const categoryChanged     = (p.category      ?? '') !== (a.category      ?? '');
        const descriptionChanged  = (p.description   ?? '') !== (a.description   ?? '');
        if (amountChanged || statusChanged || billableChanged || payToDriverChanged
            || payNameChanged || categoryChanged || descriptionChanged) {
          changes.push({
            action: 'updated', id,
            category: a.category, description: a.description,
            ...(amountChanged       ? { prevAmount: p.amount, amount: a.amount } : {}),
            ...(statusChanged       ? { prevStatus: p.status, newStatus: a.status } : {}),
            ...(billableChanged     ? { prevBillable: !!p.billable, newBillable: !!a.billable } : {}),
            ...(payToDriverChanged  ? { prevPayToDriver: !!p.payToDriver, newPayToDriver: !!a.payToDriver } : {}),
            ...(payNameChanged      ? { prevPayDriverName: p.payDriverName, newPayDriverName: a.payDriverName } : {}),
            ...(categoryChanged     ? { prevCategory: p.category } : {}),
            ...(descriptionChanged  ? { prevDescription: p.description, newDescription: a.description } : {}),
          });
        }
      }
    }
    for (const [id, a] of prevMap) {
      if (!nextMap.has(id)) {
        changes.push({
          action: 'removed', id,
          category: a.category, description: a.description, amount: a.amount,
          prevStatus:        a.status,
          prevBillable:      a.billable,
          prevPayToDriver:   a.payToDriver,
          prevPayDriverName: a.payDriverName,
        });
      }
    }
    return changes;
  }

  function buildAuditEntry(
    existing: CalendarEvent,
    next: {
      assetId: number;
      driverName?: string;
      newLoadPrice?: number;
      newDriverPay?: number;
      newStopCount: number;
      newAccessorials?: Accessorial[];
      relayCreated?: boolean;
      newBroker?: string;
      newCustomerId?: string;
      newCustomerName?: string;
      newDispatcher?: string;
      newTrailerId?: number;
      newTrailerNum?: string;
      newPriority?: boolean;
      newStart?: string;
      newEnd?: string;
    },
    // Callers resolve readable display names for any ID-typed fields
    // before invoking — the audit log is fetched later without the
    // customers / trailers lists in scope, so storing raw IDs alone
    // would render as opaque uuids. See the doSave caller for the
    // lookup pattern (find by id in customers / trailers arrays).
    prevNames: { customerName?: string; trailerNum?: string },
    byName: string,
  ): LoadAuditEntry | null {
    const driverChanged    = (existing.driverName ?? '') !== (next.driverName ?? '');
    const assetChanged     = existing.assetId !== next.assetId;
    const loadPriceChanged = (existing.loadPrice ?? 0) !== (next.newLoadPrice ?? 0) && (existing.loadPrice != null || next.newLoadPrice != null);
    const driverPayChanged = (existing.driverPay ?? 0) !== (next.newDriverPay ?? 0) && (existing.driverPay != null || next.newDriverPay != null);
    const prevStopCount    = existing.stops?.length ?? 0;
    const stopsAdded       = Math.max(0, next.newStopCount - prevStopCount);
    const stopsRemoved     = Math.max(0, prevStopCount - next.newStopCount);
    const accessorialsChanged = diffAccessorials(existing.accessorials, next.newAccessorials);

    // New diffs added per user request. Each is gated on (a) the field
    // actually changing AND (b) at least one side being defined — a
    // load with no broker that gets saved as no broker shouldn't write
    // an entry just because the empty-vs-undefined coercion differs.
    const brokerChanged     = (existing.broker ?? '') !== (next.newBroker ?? '') && (existing.broker || next.newBroker);
    const customerIdChanged = (existing.customerId ?? '') !== (next.newCustomerId ?? '') && (existing.customerId || next.newCustomerId);
    const dispatcherChanged = (existing.dispatcher ?? '') !== (next.newDispatcher ?? '') && (existing.dispatcher || next.newDispatcher);
    const trailerIdChanged  = (existing.trailerId ?? null) !== (next.newTrailerId ?? null);
    const priorityChanged   = !!existing.priority !== !!next.newPriority;
    const startChanged      = (existing.start ?? '') !== (next.newStart ?? '') && (existing.start || next.newStart);
    const endChanged        = (existing.end   ?? '') !== (next.newEnd   ?? '') && (existing.end   || next.newEnd);

    const hasChanges =
      driverChanged || assetChanged || loadPriceChanged || driverPayChanged ||
      stopsAdded > 0 || stopsRemoved > 0 || next.relayCreated ||
      accessorialsChanged.length > 0 ||
      brokerChanged || customerIdChanged || dispatcherChanged ||
      trailerIdChanged || priorityChanged || startChanged || endChanged;
    if (!hasChanges) return null;

    return {
      changedAt: new Date().toISOString(),
      changedByName: byName,
      ...(driverChanged          ? { prevDriverName: existing.driverName,  newDriverName: next.driverName }   : {}),
      ...(assetChanged           ? { prevAssetId:    existing.assetId,     newAssetId:    next.assetId }       : {}),
      ...(loadPriceChanged       ? { prevLoadPrice:  existing.loadPrice,   newLoadPrice:  next.newLoadPrice }  : {}),
      ...(driverPayChanged       ? { prevDriverPay:  existing.driverPay,   newDriverPay:  next.newDriverPay }  : {}),
      ...(brokerChanged          ? { prevBroker:     existing.broker,      newBroker:     next.newBroker }     : {}),
      ...(customerIdChanged      ? {
        prevCustomerId:   existing.customerId,
        newCustomerId:    next.newCustomerId,
        prevCustomerName: prevNames.customerName,
        newCustomerName:  next.newCustomerName,
      } : {}),
      ...(dispatcherChanged      ? { prevDispatcher: existing.dispatcher,  newDispatcher: next.newDispatcher } : {}),
      ...(trailerIdChanged       ? {
        prevTrailerId:  existing.trailerId,
        newTrailerId:   next.newTrailerId,
        prevTrailerNum: prevNames.trailerNum,
        newTrailerNum:  next.newTrailerNum,
      } : {}),
      ...(priorityChanged        ? { prevPriority: !!existing.priority, newPriority: !!next.newPriority }       : {}),
      ...(startChanged           ? { prevStart: existing.start, newStart: next.newStart }                       : {}),
      ...(endChanged             ? { prevEnd:   existing.end,   newEnd:   next.newEnd }                         : {}),
      ...(stopsAdded   > 0       ? { stopsAdded }   : {}),
      ...(stopsRemoved > 0       ? { stopsRemoved } : {}),
      ...(next.relayCreated      ? { relayCreated: true } : {}),
      ...(accessorialsChanged.length > 0 ? { accessorialsChanged } : {}),
    };
  }

  function appendAuditEntry(existing: LoadAuditEntry[] | undefined, entry: LoadAuditEntry | null): LoadAuditEntry[] {
    if (!entry) return existing ?? [];
    return [...(existing ?? []), entry];
  }

  /** Save in flight — disables the Save button and blocks doSave
   *  re-entry. The ref is the real guard (synchronous, so two clicks in
   *  one tick can't both read a stale `false`); the state drives the
   *  button label. */
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  /** Re-entry guards for the other paths that mutate server rows
   *  outside doSave: the reinstate round-trip (awaits before touching
   *  local state) and the legacy incremental unsplit (fire-and-forget
   *  store action that soft-deletes a leg). Both are cleared when the
   *  modal reopens. */
  const reinstatingRef = useRef(false);
  const unsplittingRef = useRef(false);

  const doSave = async (opts?: { skipGeocodeCheck?: boolean }) => {
    if (!title.trim() || !startDate || !endDate) return;

    // Re-entry guard. A save can take seconds (the legs reconcile writes
    // every leg and rewrites every leg's stop list), and nothing on
    // screen said so — a dispatcher who clicked Save again got a SECOND
    // reconcile carrying the same payload. Legs without an eventId mean
    // "create this leg", so each extra click created another leg: three
    // impatient clicks turned a 3-leg load into a 7-leg one. A ref,
    // not state, because clicks in the same tick would both read a
    // stale `false` from state.
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await runSave(opts);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const runSave = async (opts?: { skipGeocodeCheck?: boolean }) => {
    // Covers EVERY save branch, not just the reconcile: a load whose
    // legs are still arriving must not be written back from a
    // half-known plan.
    if (legsLoading) {
      showSaveBlocked('Still loading this load\u2019s legs — wait a moment and save again.');
      return;
    }

    // Block save if pickup is after delivery — the API enforces this
    // and a 400 would surface as a save-failure toast (and rollback
    // the optimistic update). Catching it here keeps the user in the
    // modal with the inline banner instead.
    if (dateOrderError) return;

    // Capability gate — match the API's enforcement so a read-only
    // role (e.g. maintenance opening a revenue load) can't trigger a
    // PATCH that the server will 403. Without this, the local Zustand
    // store would already have applied the optimistic update by the
    // time the API rejects, leaving phantom edits.
    const editCap = eventKind === 'non_revenue' ? 'nonRevenueEvents.edit' : 'loads.edit';
    const createCap = eventKind === 'non_revenue' ? 'nonRevenueEvents.create' : 'loads.create';
    if (isEdit ? !canDo(editCap) : !canDo(createCap)) return;

    // Block save if a new broker was detected but user hasn't resolved it
    if (brokerMatch.status === 'new') {
      setBrokerSaveBlocked(true);
      return;
    }

    // Warn if any stop failed to geocode (red-flag stops). Easy to overlook the
    // inline indicator, so surface a confirmation before saving.
    if (!opts?.skipGeocodeCheck && stops.some(s => s.geocodeStatus === 'failed')) {
      setGeocodeBlock('single');
      return;
    }

    // Warn on duplicate load number (new loads only, not edits)
    if (!isEdit && !dupLoadNum) {
      const loadNum = String(fieldValues['loadNum'] ?? '').trim();
      if (loadNum) {
        const dup = events.find(e => String(e.loadNum ?? '').trim() === loadNum);
        if (dup) { setDupLoadNum(loadNum); setPendingSave('single'); return; }
      }
    }

    const optionals = buildOptionalPayload();

    // Pre-assign IDs for new events so storage path matches the event ID
    const newEventId = crypto.randomUUID();
    const pickupId   = crypto.randomUUID();
    const delivId    = crypto.randomUUID();

    // Upload PDF to storage; drop it if upload fails to prevent oversized row.
    // Only run when the user actually touched rateConPdf — see
    // rateConOriginal docs. An idle modal save shouldn't re-upload an
    // unchanged storage path (and shouldn't race a concurrent
    // ReviewQueue rate-con upload by overwriting loads.rate_con_pdf).
    const rateConChanged = rateConPdf !== rateConOriginal;
    let storedPdf: string | undefined = rateConPdf?.startsWith('data:') ? undefined : rateConPdf;
    if (rateConChanged && rateConPdf?.startsWith('data:') && orgId) {
      const targetId = isEdit ? (modalEventId ?? newEventId) : newEventId;
      try { storedPdf = await uploadRateCon(rateConPdf, orgId, targetId); }
      catch (err) { console.error('PDF upload failed — rate con not saved, re-attach when editing:', err); }
    }

    // Flush any unposted draft in the composer so a user who typed and
    // hit Save (without clicking Post) doesn't lose the note.
    const authorName = user?.fullName ?? user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? null;
    const draft = noteComposer.trim();
    const finalNotes = draft
      ? [...internalNotes, { id: crypto.randomUUID(), text: draft, author: authorName, at: new Date().toISOString() }]
      : internalNotes;
    const notesChanged =
      finalNotes.length !== originalInternalNotes.length ||
      finalNotes.some((n, i) => n.id !== originalInternalNotes[i]?.id || n.text !== originalInternalNotes[i]?.text);
    const internalNoteFields: { internalNotes?: import('@fleetcal/types').InternalNote[] } = notesChanged
      ? { internalNotes: finalNotes }
      : {};
    // Explicit null (not undefined) clears the column on the API. JSON
    // serialization drops undefined keys entirely, so an undefined here
    // would leave the column unchanged when the user just deleted the
    // rate-con. Only include rateConPdf in the payload when it actually
    // changed (rateConChanged) — otherwise an idle modal save would
    // overwrite a fresh upload from ReviewQueue with the stale value
    // the modal loaded.
    const rateConField = storedPdf ?? null;
    const rateConPart = rateConChanged ? { rateConPdf: rateConField } : {};
    const shared = { title: title.trim(), ...optionals, priority, trailerId: linkedTrailerId, ...rateConPart, accessorials: accessorials.length > 0 ? accessorials : undefined, stops, eventKind, nonRevenueType: eventKind === 'non_revenue' ? nonRevenueType : undefined, ...internalNoteFields };

    // Resolve the typed driverId FROM the current driverName string
    // so every save persists the FK as well as the legacy name. Without
    // this, loads written from this modal kept driver_id NULL and
    // downstream features (payroll grouping, the driver-link button on
    // reports, etc.) had to limp along matching by name — which breaks
    // the moment a driver is renamed. Same logic for the relay's
    // delivery leg.
    const driverId = findDriverByName(driverName)?.id ?? undefined;

    // Relay markers in sequence order. Marker i sits between leg i and
    // leg i+1: apptStart = the earlier driver's drop, apptEnd = the next
    // driver's pickup. Leg i runs from marker i-1 (or the load start) to
    // marker i (or the load end).
    // Boundaries = bare relay points AND real stops flagged isHandoff.
    const relayMarkers = boundaryIdxs.map(i => stops[i]);
    // Per-leg driver pay from the legs editor. Empty input ⇒ undefined
    // so the API treats it as "no value" instead of zero.
    const legPayOf = (key: string): number | undefined => {
      const v = legPays[key];
      return v === '' || v == null ? undefined : v;
    };

    // Any multi-leg load (or one the route says should be multi-leg)
    // saves through the reconcile. It's convergent and idempotent
    // server-side, so this is also the heal path: a load whose stored
    // legs disagree with its route converges by pressing Save. No
    // special mode, no separate repair button.
    const useLegReconcile = isLegBuilder && (derivedLegCount > 1 || relayLegs.length > 1);
    if (useLegReconcile) {
      // ── Leg structure changed → atomic reconcile ───────────────────
      // The Save button and the legs editor's "Apply N legs" run the
      // same path, so a dispatcher who edits handoffs and hits Save
      // isn't told to go press a different button.
      const ok = await applyLegsNow();
      if (!ok) return;          // applyLegsNow already toasted the reason
      closeModal();
      return;

    } else if (isEdit && isExistingRelayLeg && modalEventId && !pendingSplitStopId) {
      // ── Existing relay: patch EVERY leg in one action ──────────────
      // Marker invariant: an N-leg relay carries exactly N-1 relay
      // points (orphans sneak in via the stop-type dropdown or stale
      // sessions and would corrupt every leg's window server-side).
      if (relayMarkers.length !== relayLegs.length - 1) {
        showSaveBlocked(
          `This load has ${relayMarkers.length} relay point${relayMarkers.length === 1 ? '' : 's'} for ${relayLegs.length} legs (expected ${relayLegs.length - 1}). ` +
          `Remove the extra relay point${relayMarkers.length - (relayLegs.length - 1) === 1 ? '' : 's'} with the trash icon — or use "+ Add handoff" on a leg card to add a leg for it — then save again.`,
        );
        return;
      }
      // Load-level fields ride on each leg's updates; saveRelayLegs
      // merges them with leg 0 winning (they're identical here anyway).
      const legsPayload = relayLegs.map((leg, i) => {
        const isViewed = leg.id === modalEventId;
        const edits = legEdits[leg.id] ?? {};
        const legDriverName = isViewed
          ? (driverName || undefined)
          : ((edits.driverName ?? resolveDriverNameForEvent(leg)) || undefined);
        // Boundary rule: handoff-adjacent boundaries come from the
        // marker times; outer boundaries come from the form (viewed
        // leg) or stay as-is (other legs).
        const start = i === 0
          ? (isViewed ? `${startDate}T${startTime}` : leg.start)
          : (handoffTimesOf(relayMarkers[i - 1]).pickup ?? handoffTimesOf(relayMarkers[i - 1]).drop
              ?? (isViewed ? `${startDate}T${startTime}` : leg.start));
        const end = i === relayLegs.length - 1
          ? (isViewed ? `${endDate}T${endTime}` : leg.end)
          : (relayMarkers[i]?.apptStart
              ?? (isViewed ? `${endDate}T${endTime}` : leg.end));
        const updates: Partial<Omit<CalendarEvent, 'id'>> = {
          ...shared,
          assetId: isViewed ? assetId : (edits.assetId ?? leg.assetId),
          driverName: legDriverName,
          driverId: findDriverByName(legDriverName)?.id ?? undefined,
          start, end,
          driverPay: legPayOf(leg.id),
          status: isViewed ? status : (leg.status ?? 'scheduled'),
          relayGroupId: relayGroupId ?? leg.loadId,
          relayRole: legRoleFor(i, relayLegs.length),
        };
        return { id: leg.id, updates };
      });
      saveRelayLegs(legsPayload);

    } else if (isEdit && isExistingRelayLeg && modalEventId && pendingSplitStopId) {
      // ── Existing relay + pending handoff: split the TARGET leg ─────
      // (any leg, per the per-leg "+" — defaults to the viewed one).
      const draft = draftLegs[0]; // edit mode allows one pending handoff per save
      const marker = stops.find(s => s.id === pendingSplitStopId);
      if (!draft || !marker) {
        // Shouldn't be reachable (a deleted pending marker auto-cancels
        // the split via the effect above) — but never fail silently.
        showSaveBlocked('The pending handoff is missing its relay point. Cancel the split and add the handoff again.');
        return;
      }
      if (!marker.apptStart) {
        showSaveBlocked('Set the drop time on the new handoff — the times are on the handoff row in the Relay section.');
        return;
      }
      // Marker invariant: existing legs carry legs-1 markers, plus the
      // one pending marker → exactly relayLegs.length in total.
      if (relayMarkers.length !== relayLegs.length) {
        showSaveBlocked(
          `This load has ${relayMarkers.length} relay point${relayMarkers.length === 1 ? '' : 's'} but ${relayLegs.length} ${relayLegs.length === 1 ? 'is' : 'are'} expected ` +
          `(${relayLegs.length - 1} existing plus the one being added). Remove the extra relay points with the trash icon, then save again.`,
        );
        return;
      }
      const targetId = pendingSplitTargetId ?? modalEventId;
      const targetLeg = relayLegs.find(l => l.id === targetId) ?? currentEv;
      if (!targetLeg) {
        showSaveBlocked('Could not resolve the leg being split. Cancel the split and try again.');
        return;
      }
      const isViewedTarget = targetLeg.id === modalEventId;
      // Persist every NON-target leg's event-level edits first —
      // splitToRelay only touches the split leg + load-level. Stops are
      // deliberately excluded here: splitRelay's mergedStops writes the
      // full list (incl. the new marker) onto every leg.
      const patchPayload = relayLegs
        .filter(leg => leg.id !== targetLeg.id)
        .map(leg => {
          const isViewed = leg.id === modalEventId;
          const edits = legEdits[leg.id] ?? {};
          const legDriverName = isViewed
            ? (driverName || undefined)
            : ((edits.driverName ?? resolveDriverNameForEvent(leg)) || undefined);
          const updates: Partial<Omit<CalendarEvent, 'id'>> = {
            assetId: isViewed ? assetId : (edits.assetId ?? leg.assetId),
            driverName: legDriverName,
            driverId: findDriverByName(legDriverName)?.id ?? undefined,
            driverPay: legPayOf(leg.id),
            // The viewed leg (when it isn't the split target) also
            // carries its form-level event fields.
            ...(isViewed ? { title: title.trim(), status, priority, trailerId: linkedTrailerId } : {}),
          };
          return { id: leg.id, updates };
        });
      if (patchPayload.length > 0) saveRelayLegs(patchPayload);
      const targetEdits = legEdits[targetLeg.id] ?? {};
      const targetDriverName = isViewedTarget
        ? (driverName || undefined)
        : ((targetEdits.driverName ?? resolveDriverNameForEvent(targetLeg)) || undefined);
      const targetUpdates: Partial<Omit<CalendarEvent, 'id'>> = {
        ...shared,
        assetId: isViewedTarget ? assetId : (targetEdits.assetId ?? targetLeg.assetId),
        driverName: targetDriverName,
        driverId: findDriverByName(targetDriverName)?.id ?? undefined,
        start: isViewedTarget ? `${startDate}T${startTime}` : targetLeg.start,
        end: marker.apptStart,
        driverPay: legPayOf(targetLeg.id),
        status: isViewedTarget ? status : (targetLeg.status ?? 'scheduled'),
      };
      const newLegData: Omit<CalendarEvent, 'id'> = {
        ...shared,
        assetId: draft.assetId,
        driverName: draft.driverName || undefined,
        driverId: findDriverByName(draft.driverName)?.id ?? undefined,
        start: marker.apptEnd ?? marker.apptStart,
        // The new leg inherits the split leg's original end.
        end: isViewedTarget ? `${endDate}T${endTime}` : targetLeg.end,
        driverPay: legPayOf(draft.key),
        status: 'scheduled',
        createdByName: currentUserName,
      };
      splitToRelay(targetLeg.id, targetUpdates, newLegData, delivId, { relayStopId: pendingSplitStopId });

    } else if (draftLegs.length > 0) {
      // ── Create-mode splits (or single→relay conversion in edit) ────
      // ── Create-mode identity invariant ──────────────────────────────
      // Boundary m opens leg m+1, i.e. draftLegs[m]. Every insert
      // splices the draft leg at the boundary's own ordinal and every
      // removal drops exactly that index, so the two arrays stay
      // aligned by construction — this asserts it before the POST goes
      // out, since a drift would put a driver on the wrong route. (It
      // was also the silent no-op behind an earlier "Save does
      // nothing" report, when orphan markers made the counts diverge.)
      if (relayMarkers.length !== draftLegs.length) {
        showSaveBlocked(
          relayMarkers.length > draftLegs.length
            ? `This load has ${relayMarkers.length} handoff${relayMarkers.length === 1 ? '' : 's'} but only ${draftLegs.length} added leg${draftLegs.length === 1 ? '' : 's'}. ` +
              'Remove the extra handoff (trash icon on a relay point, or the handoff toggle on a stop), then save again.'
            : `A handoff is missing for one of the added legs (${relayMarkers.length} handoff${relayMarkers.length === 1 ? '' : 's'} for ${draftLegs.length} added legs). ` +
              'Remove the affected leg in the relay section and add the handoff again.',
        );
        return;
      }
      // Boundaries must sit strictly inside the route — a first or last
      // handoff would leave a leg with no stops.
      if (boundaryIdxs.includes(0) || boundaryIdxs.includes(stops.length - 1)) {
        showSaveBlocked('The first and last stop cannot be handoffs — a handoff needs a leg on each side.');
        return;
      }
      if (relayMarkers.some(m => { const t = handoffTimesOf(m); return !t.drop && !t.pickup; })) {
        showSaveBlocked('Set the drop time on every handoff — the times are on the handoff rows in the Relay section.');
        return;
      }
      const rgId = crypto.randomUUID();
      const existingEv = isEdit && modalEventId ? events.find(e => e.id === modalEventId) : undefined;
      // Pre-resolve display names so the audit entry survives later
      // customer/trailer deletes — same pattern as the non-relay
      // path below. See doSave for the rationale.
      const _prevCustomerName = existingEv?.customerId
        ? customers.find(c => c.id === existingEv.customerId)?.name
        : undefined;
      const _newCustomerIdVal = typeof fieldValues['customerId'] === 'string' ? (fieldValues['customerId'] as string) : undefined;
      const _newCustomerName  = _newCustomerIdVal
        ? customers.find(c => c.id === _newCustomerIdVal)?.name
        : undefined;
      const _prevTrailerNum = existingEv?.trailerId
        ? trailers.find(t => t.id === existingEv.trailerId)?.trailerNumber
        : undefined;
      const _newTrailerNum = linkedTrailerId
        ? trailers.find(t => t.id === linkedTrailerId)?.trailerNumber
        : undefined;
      const relayAuditLog = isEdit && existingEv
        ? appendAuditEntry(auditLog, buildAuditEntry(
            existingEv,
            {
              assetId,
              driverName:      driverName || undefined,
              newLoadPrice:    parseFloat(String(fieldValues['loadPrice'] ?? '')) || undefined,
              newDriverPay:    parseFloat(String(fieldValues['driverPay'] ?? '')) || undefined,
              newStopCount:    stops.length,
              newAccessorials: accessorials,
              relayCreated:    true,
              newBroker:       typeof fieldValues['broker']     === 'string' ? (fieldValues['broker']     as string) : undefined,
              newCustomerId:   _newCustomerIdVal,
              newCustomerName: _newCustomerName,
              newDispatcher:   typeof fieldValues['dispatcher'] === 'string' ? (fieldValues['dispatcher'] as string) : undefined,
              newTrailerId:    linkedTrailerId,
              newTrailerNum:   _newTrailerNum,
              newPriority:     priority,
              newStart:        `${startDate}T${startTime}`,
              newEnd:          `${endDate}T${endTime}`,
            },
            { customerName: _prevCustomerName, trailerNum: _prevTrailerNum },
            currentUserName,
          ))
        : undefined;
      // Build every leg in leg order. Leg i starts at marker i-1's
      // pickup time (or the form start) and ends at marker i's drop time
      // (or the form end, date-extended when the last leg starts later).
      const n = draftLegs.length + 1;
      const legStartOf = (i: number): string =>
        i === 0
          ? `${startDate}T${startTime}`
          : (handoffTimesOf(relayMarkers[i - 1]).pickup ?? handoffTimesOf(relayMarkers[i - 1]).drop!);
      const legEndOf = (i: number): string => {
        if (i < n - 1) {
          const t = handoffTimesOf(relayMarkers[i]);
          return (t.drop ?? t.pickup)!;
        }
        const lastStartDate = legStartOf(i).split('T')[0];
        const delivEndDate = lastStartDate > endDate ? lastStartDate : endDate;
        return `${delivEndDate}T${endTime}`;
      };
      const legsData: Array<Omit<CalendarEvent, 'id'>> = [
        {
          ...shared, assetId, driverName: driverName || undefined, driverId,
          start: legStartOf(0), end: legEndOf(0),
          driverPay: legPayOf('leg0'),
          status, relayGroupId: rgId, relayRole: 'pickup',
          createdByName: isEdit ? (existingEv?.createdByName ?? currentUserName) : currentUserName,
          ...(isEdit ? { auditLog: relayAuditLog } : {}),
        },
        ...draftLegs.map((d, di) => {
          const i = di + 1;
          return {
            ...shared,
            assetId: d.assetId,
            driverName: d.driverName || undefined,
            driverId: findDriverByName(d.driverName)?.id ?? undefined,
            start: legStartOf(i), end: legEndOf(i),
            driverPay: legPayOf(d.key),
            status: 'scheduled' as EventStatus,
            relayGroupId: rgId,
            relayRole: legRoleFor(i, n),
            createdByName: currentUserName,
          };
        }),
      ];
      if (isEdit && modalEventId) {
        // Convert existing single load → relay. Both legs end up on the
        // same load (server-side via /v1/loads/:id/split-relay). Edit
        // mode allows one handoff per save, so legsData is exactly two.
        splitToRelay(modalEventId, legsData[0], legsData[1], delivId, { relayStopId: relayMarkers[0]?.id });
      } else {
        createRelayLegs(legsData, [pickupId, delivId]);
      }

    } else {
      const newDriverName = driverName || undefined;
      const existingEv = isEdit && modalEventId ? events.find(e => e.id === modalEventId) : undefined;
      // Resolve display names for the audit's ID-typed fields so the
      // history panel can render readable text later without needing
      // to refetch customers / trailers. Lookups use the current
      // arrays in scope; if a customer/trailer was deleted after this
      // save, the audit still carries the name that was correct then.
      const prevCustomerName = existingEv?.customerId
        ? customers.find(c => c.id === existingEv.customerId)?.name
        : undefined;
      const newCustomerIdVal = typeof fieldValues['customerId'] === 'string' ? (fieldValues['customerId'] as string) : undefined;
      const newCustomerName  = newCustomerIdVal
        ? customers.find(c => c.id === newCustomerIdVal)?.name
        : undefined;
      const prevTrailerNum = existingEv?.trailerId
        ? trailers.find(t => t.id === existingEv.trailerId)?.trailerNumber
        : undefined;
      const newTrailerNum = linkedTrailerId
        ? trailers.find(t => t.id === linkedTrailerId)?.trailerNumber
        : undefined;
      const newStart = `${startDate}T${startTime}`;
      const newEnd   = `${endDate}T${endTime}`;
      const nextAuditLog = isEdit && existingEv
        ? appendAuditEntry(auditLog, buildAuditEntry(
            existingEv,
            {
              assetId,
              driverName:      newDriverName,
              newLoadPrice:    parseFloat(String(fieldValues['loadPrice'] ?? '')) || undefined,
              newDriverPay:    parseFloat(String(fieldValues['driverPay'] ?? '')) || undefined,
              newStopCount:    stops.length,
              newAccessorials: accessorials,
              newBroker:       typeof fieldValues['broker']     === 'string' ? (fieldValues['broker']     as string) : undefined,
              newCustomerId:   newCustomerIdVal,
              newCustomerName,
              newDispatcher:   typeof fieldValues['dispatcher'] === 'string' ? (fieldValues['dispatcher'] as string) : undefined,
              newTrailerId:    linkedTrailerId,
              newTrailerNum,
              newPriority:     priority,
              newStart,
              newEnd,
            },
            { customerName: prevCustomerName, trailerNum: prevTrailerNum },
            currentUserName,
          ))
        : undefined;

      const payload: Omit<CalendarEvent, 'id'> = {
        ...shared, assetId, driverName: newDriverName, driverId,
        start: `${startDate}T${startTime}`, end: `${endDate}T${endTime}`,
        status,
        createdByName: isEdit ? (existingEv?.createdByName ?? currentUserName) : currentUserName,
        ...(isEdit ? { auditLog: nextAuditLog } : {}),
      };
      // Apply any pending work-order links collected by
      // LinkedWorkOrdersSection while the event was being composed.
      // Edit mode flushes immediately on each toggle (so the buffer
      // stays empty there); create mode defers to addEvent so the
      // link uses the SERVER-allocated event id (not the optimistic
      // tempId — that gets swapped out when the createEvent .then
      // resolves, leaving any link we fired here pointing at a
      // ghost uuid). Edit-mode pending list should be empty, but
      // we still flush defensively just in case.
      const pendingLinks = eventKind === 'non_revenue' ? pendingWorkOrderLinks : [];
      if (isEdit && modalEventId) {
        updateEvent(modalEventId, payload);
        if (pendingLinks.length > 0) {
          const targetEventId = modalEventId;
          // Multi-link: ADD this event id to each WO's existing
          // eventIds set so other event links survive.
          void import('@/lib/railway').then(({ railway }) =>
            Promise.all(
              pendingLinks.map(async woId => {
                try {
                  const cur = await railway.getMaintenanceActionItem(woId);
                  const existing = cur.actionItem.eventIds ?? (cur.actionItem.eventId ? [cur.actionItem.eventId] : []);
                  const next = Array.from(new Set([...existing, targetEventId]));
                  await railway.updateMaintenanceActionItem(woId, { eventIds: next });
                } catch (err) {
                  console.error('[EventModal] link work order failed:', woId, err);
                }
              })
            )
          );
        }
      } else {
        addEvent(payload, newEventId, pendingLinks.length > 0 ? { linkWorkOrderIds: pendingLinks } : undefined);
      }
    }
    closeModal();
  };

  const handleSave = (e: React.FormEvent) => { e.preventDefault(); void doSave(); };

  const handleBackdropClick = () => {
    if (isBatch) return;
    if (hasPendingDoc) { setShowDocCloseConfirm(true); return; }
    if (isDirty) setShowSavePrompt(true);
    else closeModal();
  };

  // Used by the explicit close affordances (X button, Cancel button).
  // Unlike the backdrop, these still work in batch mode.
  const attemptClose = () => {
    if (hasPendingDoc) { setShowDocCloseConfirm(true); return; }
    if (isDirty) setShowSavePrompt(true);
    else closeModal();
  };

  const handleDelete = () => {
    if (!confirmDel) { setConfirmDel(true); return; }
    if (modalEventId) {
      // Unlink EVERY sibling leg locally before the load-level delete
      // cascades server-side.
      for (const leg of otherLegs) {
        updateEvent(leg.id, { ...leg, relayGroupId: undefined, relayRole: undefined });
      }
      const deleteEntry: LoadAuditEntry = { changedAt: new Date().toISOString(), changedByName: currentUserName, loadDeleted: true };
      removeEvent(modalEventId, deleteEntry);
    }
    closeModal();
  };

  // ── Cancel flow ─────────────────────────────────────────────────────
  // Three paths; the dialog walks the user through them:
  //   1. Mark Cancelled    — sets status='cancelled', event stays
  //                           on the calendar greyed out.
  //   2. Remove from Cal.  — event soft-deleted, load preserved in
  //                           the system (search, accounting, TONU).
  //   3. Delete Permanent  — full soft-delete (load + event → Trash).
  function buildCancelAuditEntry(mode: 'status' | 'remove-event' | 'permanent'): LoadAuditEntry {
    // Snapshot rate + miles + driver pay so a future Reinstate can
    // restore them. Driver pay is zeroed alongside on cancel, but the
    // dispatcher can still type a TONU/layover amount back in — the
    // load stays visible in payroll either way.
    const prevLP = parseFloat(String(fieldValues['loadPrice'] ?? ''));
    const prevLM = loadedMiles;
    const prevDP = parseFloat(String(fieldValues['driverPay'] ?? ''));
    return {
      changedAt: new Date().toISOString(),
      changedByName: currentUserName,
      loadCancelled: {
        mode,
        ...(Number.isFinite(prevLP) && prevLP > 0 ? { prevLoadPrice: prevLP } : {}),
        ...(prevLM != null && prevLM > 0 ? { prevLoadedMiles: prevLM } : {}),
      },
      ...(Number.isFinite(prevDP) && prevDP > 0 ? { prevDriverPay: prevDP } : {}),
      // Surface the status flip in the audit timeline for mode='status'.
      ...(mode === 'status' ? { prevStatus: status as EventStatus, newStatus: 'cancelled' as EventStatus } : {}),
      // Mirror loadDeleted on permanent so existing audit renderers
      // still highlight it as a destructive event.
      ...(mode === 'permanent' ? { loadDeleted: true } : {}),
    };
  }
  const handleCancelMarkStatus = () => {
    if (!modalEventId) return;
    const entry = buildCancelAuditEntry('status');
    // Zero out rate + miles + driver pay so accounting/payroll don't
    // keep counting the original numbers. The load still shows up in
    // payroll though — dispatcher can type a TONU/layover/detention
    // amount back into driverPay manually.
    updateEvent(modalEventId, {
      status: 'cancelled',
      loadPrice: 0,
      loadedMiles: 0,
      driverPay: 0,
      auditLog: appendAuditEntry(auditLog, entry),
    });
    for (const leg of otherLegs) {
      updateEvent(leg.id, {
        status: 'cancelled',
        loadPrice: 0,
        loadedMiles: 0,
        driverPay: 0,
        auditLog: appendAuditEntry(leg.auditLog ?? [], entry),
      });
    }
    setCancelDialogOpen(false);
    closeModal();
  };
  const handleCancelRemoveEvent = () => {
    if (!modalEventId) return;
    if (otherLegs.length > 0) {
      // Drop the relay link on every sibling leg first so none ends up
      // half-orphaned, and zero their financials — the whole load is
      // being removed.
      for (const leg of otherLegs) {
        updateEvent(leg.id, {
          ...leg,
          relayGroupId: undefined,
          relayRole: undefined,
          loadPrice: 0,
          loadedMiles: 0,
          driverPay: 0,
        });
      }
    } else {
      // Single-leg load: zero rate on the load record before the
      // event row is deleted so the preserved load reads as cancelled.
      const evNow = events.find(e => e.id === modalEventId);
      if (evNow?.loadId) {
        const loadId = evNow.loadId;
        // Suppress the realtime echo of this load write so the
        // dispatcher running cancel doesn't get "updated by another
        // dispatcher" pop on themselves while the modal is still
        // closing.
        useCalendarStore.getState().markLoadSelfWrite(loadId);
        import('@/lib/railway').then(({ railway }) =>
          railway.updateLoad(loadId, { loadPrice: 0 }),
        ).catch((err) =>
          console.error('handleCancelRemoveEvent: zero loadPrice failed', err),
        );
      }
    }
    cancelEventKeepLoad(modalEventId, buildCancelAuditEntry('remove-event'));
    setCancelDialogOpen(false);
    closeModal();
  };
  const handleCancelPermanent = () => {
    if (!modalEventId) return;
    for (const leg of otherLegs) {
      updateEvent(leg.id, { ...leg, relayGroupId: undefined, relayRole: undefined });
    }
    removeEvent(modalEventId, buildCancelAuditEntry('permanent'));
    setCancelDialogOpen(false);
    closeModal();
  };

  // ── Reinstate ───────────────────────────────────────────────────────
  // Cancelled-state detection from the audit log. Picks up both
  // cancel modes (status / remove-event) and verifies no subsequent
  // reinstate has cleared it. mode='status' is also covered by the
  // simpler `status === 'cancelled'` check on the event row, but
  // mode='remove-event' has no event-row signal — the row gets
  // soft-deleted and the only durable marker lives in the load's
  // audit log.
  const lastCancelEntry = useMemo(() => {
    const entries = auditLog ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.loadReinstated)   return null;
      if (e.loadCancelled?.mode) return { entry: e, mode: e.loadCancelled.mode };
    }
    return null;
  }, [auditLog]);
  const isRemovedEventCancelled = lastCancelEntry?.mode === 'remove-event';
  // The combined "this load is cancelled" gate: a 'status'-mode cancel
  // shows status='cancelled' on the row; a 'remove-event'-mode cancel
  // only shows up via the audit log.
  const isCancelled = status === 'cancelled' || isRemovedEventCancelled;

  // Flip a cancelled load back to its previous status. Pulls prev rate
  // + miles from the most recent loadCancelled audit entry so a misclick
  // is fully recoverable. When the cancel mode was 'remove-event' the
  // event row itself was soft-deleted; we restore it via POST
  // /v1/events/:id/restore before updating client state.
  const handleReinstate = async () => {
    if (!modalEventId) return;
    // Re-entry guard: the restore below is awaited BEFORE any local
    // state changes and the button stays live during the round trip, so
    // an impatient double click would fire two restores and two
    // follow-up writes. Same lesson as the duplicate-save bug.
    if (reinstatingRef.current) return;
    reinstatingRef.current = true;
    try {
    // remove-event mode needs the server-side un-delete first; without
    // this the event row stays soft-deleted in the DB even though the
    // local store thinks it's active again.
    if (isRemovedEventCancelled) {
      try {
        const { railway } = await import('@/lib/railway');
        await railway.restoreEvent(modalEventId);
      } catch (err) {
        console.error('[handleReinstate] event restore failed:', err);
        alert(`Reinstate failed: ${(err as Error).message ?? 'unknown'}`);
        return;
      }
    }
    const lastCancel = [...(auditLog ?? [])].reverse().find(e => e.loadCancelled?.mode);
    const prevStatus = (lastCancel?.prevStatus as EventStatus | undefined) ?? 'scheduled';
    const prevLP = lastCancel?.loadCancelled?.prevLoadPrice;
    const prevLM = lastCancel?.loadCancelled?.prevLoadedMiles;
    const prevDP = lastCancel?.prevDriverPay;
    const entry: LoadAuditEntry = {
      changedAt: new Date().toISOString(),
      changedByName: currentUserName,
      loadReinstated: true,
      prevStatus: 'cancelled' as EventStatus,
      newStatus: prevStatus,
      ...(prevLP != null ? { newLoadPrice: prevLP } : {}),
      ...(prevDP != null ? { newDriverPay: prevDP } : {}),
    };
    updateEvent(modalEventId, {
      status: prevStatus,
      ...(prevLP != null ? { loadPrice: prevLP } : {}),
      ...(prevLM != null ? { loadedMiles: prevLM } : {}),
      ...(prevDP != null ? { driverPay: prevDP } : {}),
      auditLog: appendAuditEntry(auditLog, entry),
    });
    for (const leg of otherLegs) {
      const legEntry: LoadAuditEntry = {
        changedAt: new Date().toISOString(),
        changedByName: currentUserName,
        loadReinstated: true,
        prevStatus: 'cancelled' as EventStatus,
        newStatus: prevStatus,
      };
      updateEvent(leg.id, {
        status: prevStatus,
        ...(prevLP != null ? { loadPrice: prevLP } : {}),
        ...(prevLM != null ? { loadedMiles: prevLM } : {}),
        ...(prevDP != null ? { driverPay: prevDP } : {}),
        auditLog: appendAuditEntry(leg.auditLog ?? [], legEntry),
      });
    }
    closeModal();
    } finally {
      reinstatingRef.current = false;
    }
  };

  /** Undo one handoff. Draft markers (not yet saved) just vanish
   *  locally; persisted handoffs merge the two legs around the marker
   *  via unsplit-relay (keep = earlier leg, absorb = later leg — the
   *  2-leg case keeps the old pickup-keeps behavior). Confirm handled
   *  inside RelayLegsEditor. */
  const handleRemoveHandoff = (handoffIdx: number) => {
    const h = relayHandoffViews[handoffIdx];
    if (!h) return;
    if (isLegBuilder) {
      // Matt's rule: a handoff can always come off as long as the load
      // still has a leg and a route — you always have a pickup and a
      // delivery, so removing handoffs is fine down to 2 stops. Leg
      // bookkeeping never blocks it; the plan follows the stops.
      const removingLeavesARoute = stops.length >= 2;
      if (!removingLeavesARoute) {
        showSaveBlocked('A load needs at least two stops. Add a stop before removing this handoff.');
        return;
      }
      // Removing boundary h MERGES plan[h] and plan[h+1] into one leg
      // that keeps plan[h]'s identity. plan[h+1]'s eventId (if it had
      // one) is RELEASED — deleted on save, never reused by a later add.
      setLegPlan(prev => {
        const base = prev.length > 0 ? prev : planFromLegs(relayLegs);
        if (handoffIdx < 0 || handoffIdx + 1 >= base.length) return base;
        const dropped = base[handoffIdx + 1];
        if (dropped.eventId) {
          setReleasedEventIds(ids => ids.includes(dropped.eventId!) ? ids : [...ids, dropped.eventId!]);
        }
        // Identity follows the SURVIVOR (base[handoffIdx]), but the
        // assignment shouldn't evaporate: if the survivor has no driver
        // or truck and the leg being absorbed does, carry those forward.
        // Otherwise removing a handoff could leave the delivery leg
        // "unassigned" even though a driver was already on it.
        const survivor = base[handoffIdx];
        const survivorLeg = survivor.eventId ? relayLegs.find(l => l.id === survivor.eventId) : undefined;
        const droppedLeg = dropped.eventId ? relayLegs.find(l => l.id === dropped.eventId) : undefined;
        const survivorDriver = legEdits[survivor.key]?.driverName
          ?? (survivorLeg ? resolveDriverNameForEvent(survivorLeg) : undefined);
        const survivorAsset = legEdits[survivor.key]?.assetId ?? survivorLeg?.assetId;
        const droppedDriver = legEdits[dropped.key]?.driverName
          ?? (droppedLeg ? resolveDriverNameForEvent(droppedLeg) : undefined);
        const droppedAsset = legEdits[dropped.key]?.assetId ?? droppedLeg?.assetId;
        const inherit: { driverName?: string; assetId?: number } = {};
        if (!survivorDriver && droppedDriver) inherit.driverName = droppedDriver;
        if (!survivorAsset  && droppedAsset)  inherit.assetId    = droppedAsset;
        const survivorPay = legPays[survivor.key];
        const droppedPay  = legPays[dropped.key] ?? droppedLeg?.driverPay;
        if ((survivorPay === '' || survivorPay == null) && droppedPay != null && droppedPay !== '') {
          setLegPays(p => ({ ...p, [survivor.key]: droppedPay as number }));
        }
        if (Object.keys(inherit).length > 0) {
          setLegEdits(e => ({ ...e, [survivor.key]: { ...e[survivor.key], ...inherit } }));
        }
        // Drop the merged-away leg's edit buffers so a later add can't
        // inherit its driver/pay through a recycled key.
        setLegEdits(e => { const n = { ...e }; delete n[dropped.key]; return n; });
        setLegPays(p => { const n = { ...p }; delete n[dropped.key]; return n; });
        return [...base.slice(0, handoffIdx + 1), ...base.slice(handoffIdx + 2)];
      });
      // A real stop just loses its isHandoff flag (the stop stays on
      // the route); a bare relay point is deleted outright.
      setStops(prev => {
        const next = isHandoffStop(h.stop) && h.stop.type !== 'relay'
          ? prev.map(s => s.id === h.stop.id
              ? { ...s, isHandoff: false, handoffDropAt: undefined, handoffPickupAt: undefined }
              : s)
          : prev.filter(s => s.id !== h.stop.id);
        return next.map((s, i) => ({ ...s, sequence: i + 1 }));
      });
      markDirty();
      return;
    }
    if (h.isDraft) {
      // A handoff sitting ON a real stop only loses its flag — the stop
      // stays on the route. A bare relay point is removed outright.
      setStops(prev => {
        const next = isHandoffStop(h.stop) && h.stop.type !== 'relay'
          ? prev.map(s => s.id === h.stop.id
              ? { ...s, isHandoff: false, handoffDropAt: undefined, handoffPickupAt: undefined }
              : s)
          : prev.filter(s => s.id !== h.stop.id);
        return next.map((s, i) => ({ ...s, sequence: i + 1 }));
      });
      if (isExistingRelayLeg || pendingSplitStopId) {
        // Edit mode: the single pending handoff + its draft leg.
        setDraftLegs([]);
        setPendingSplitStopId(null);
        setPendingSplitTargetId(null);
        pendingSplitLockRef.current = false;
      } else {
        // Create mode: boundary m opens leg m+1, i.e. draftLegs[m], so
        // removing boundary m drops exactly that draft leg — the legs
        // stay aligned with the markers by construction.
        const dropped = draftLegs[handoffIdx];
        if (dropped) {
          setLegPays(p => { const n = { ...p }; delete n[dropped.key]; return n; });
        }
        setDraftLegs(prev => prev.filter((_, i) => i !== handoffIdx));
      }
      markDirty();
      return;
    }
    if (!h.keepEventId || !h.mergeEventId) return;
    // Legacy incremental unsplit — soft-deletes a leg server-side. Guard
    // re-entry: the store action is fire-and-forget, so two clicks
    // landing before closeModal unmounts would issue two merges.
    if (unsplittingRef.current) return;
    unsplittingRef.current = true;
    const entry: LoadAuditEntry = { changedAt: new Date().toISOString(), changedByName: currentUserName, relayRemoved: true };
    removeRelay(h.keepEventId, { mergeEventId: h.mergeEventId, auditLog: appendAuditEntry(auditLog, entry) });
    closeModal();
  };

  /** "Add handoff" — splits ONE leg by dropping a new relay point at
   *  the end of its stop window. Identical in create and edit mode:
   *  the per-leg "+" names the leg; the header "+" targets the viewed
   *  leg when editing and the LAST leg when creating (so the familiar
   *  "append another leg" behavior is preserved). Repeatable in both. */
  const addHandoff = (targetLegId?: string) => {
    // Builder affordances (saved OR unsaved load): a handoff is purely
    // a stop-list edit plus a positional splice into the leg list. No
    // pending-split state and no one-per-save limit.
    if (showLegBuilderUi) {
      const targetIdx = targetLegId
        ? Math.max(0, relayLegViews.findIndex(v => v.key === targetLegId || v.eventId === targetLegId))
        : (isEdit
            ? Math.max(0, relayLegViews.findIndex(v => v.isViewed))
            : boundaryIdxs.length);   // create: append after the last leg
      const windowEndIdx = targetIdx < boundaryIdxs.length ? boundaryIdxs[targetIdx] : stops.length - 1;
      // Insert before the window's closing stop so the new boundary
      // splits the leg rather than landing outside it. Guard against a
      // 1-stop window (nothing to split).
      const insertAfter = Math.max(0, windowEndIdx - 1);
      if (stops.length < 2 || windowEndIdx <= (targetIdx === 0 ? 0 : boundaryIdxs[targetIdx - 1])) {
        showSaveBlocked('This leg has no room for another handoff — add a stop to it first.');
        return;
      }
      handleInsertHandoffAfter(insertAfter);
      return;
    }
    // One unsaved handoff at a time in the legacy split flow. The ref
    // is the race-proof gate (flips synchronously); the state check is
    // belt + suspenders for anything that re-enables buttons early.
    if (isEdit && (pendingSplitStopId || pendingSplitLockRef.current)) return;
    // Structural guard: refuse to insert a marker when the stop list
    // already has more relay points than the load has handoffs (orphans
    // from the type dropdown or an old session). Piling on another
    // marker would deepen the mismatch that blocks Save.
    const allowedExisting = isEdit && isExistingRelayLeg
      ? Math.max(0, relayLegs.length - 1)
      : draftLegs.length;
    if (stops.filter(s => s.type === 'relay').length > allowedExisting) {
      showSaveBlocked('This load has extra relay points. Remove them (trash icon on the stop) before adding a new handoff.');
      return;
    }
    if (isEdit) pendingSplitLockRef.current = true;
    // Resolve the leg being split (edit mode on an existing relay only).
    const targetLeg = isEdit && isExistingRelayLeg
      ? (relayLegs.find(l => l.id === (targetLegId ?? modalEventId)) ?? relayLegs.find(l => l.id === modalEventId))
      : undefined;
    const isViewedTarget = !targetLeg || targetLeg.id === modalEventId;
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    const markerIdxsAll = stops.reduce<number[]>((acc, s, i) => { if (s.type === 'relay') acc.push(i); return acc; }, []);
    const markers = markerIdxsAll.map(i => stops[i]);

    // Window being split. Edit mode: the target leg's own start/end (the
    // form fields hold them when the target is the viewed leg; the store
    // row otherwise). Create mode: from the last marker's pickup time
    // (or the load start) to the load end.
    let windowStartIso: string;
    let windowEndIso: string;
    let markerOrdinal: number; // ordinal the NEW marker will take
    if (isEdit && isExistingRelayLeg && targetLeg) {
      windowStartIso = isViewedTarget ? `${startDate}T${startTime}` : targetLeg.start;
      windowEndIso   = isViewedTarget ? `${endDate || startDate}T${endTime || startTime}` : targetLeg.end;
      const tIdx = targetLeg.legIndex
        ?? (isViewedTarget ? viewedLegIdx : undefined)
        ?? Math.max(0, relayLegs.findIndex(l => l.id === targetLeg.id));
      markerOrdinal  = Math.min(tIdx, markerIdxsAll.length);
    } else {
      const lastMarker = markers[markers.length - 1];
      windowStartIso = lastMarker ? (lastMarker.apptEnd ?? lastMarker.apptStart ?? `${startDate}T${startTime}`) : `${startDate}T${startTime}`;
      windowEndIso   = `${endDate || startDate}T${endTime || startTime}`;
      markerOrdinal  = markers.length;
    }
    // Default times inside the window: next driver's pickup = 1hr before
    // the window end, drop = 1hr before that; short windows split into
    // thirds instead. Both clamp to the window start.
    const startDt = new Date(windowStartIso);
    const endDt   = new Date(windowEndIso);
    const spanMs  = Math.max(0, endDt.getTime() - startDt.getTime());
    const unit    = Math.min(60 * 60 * 1000, Math.floor(spanMs / 3));
    const nextPickup = new Date(Math.max(startDt.getTime(), endDt.getTime() - unit));
    const prevDrop   = new Date(Math.max(startDt.getTime(), endDt.getTime() - 2 * unit));
    const relayStop: Stop = {
      id: crypto.randomUUID(),
      eventId: '',
      sequence: 0,
      type: 'relay',
      geocodeStatus: 'pending',
      apptStart: fmt(prevDrop),
      apptEnd:   fmt(nextPickup),
    };
    // Insert position: end of the window being split, walking back past
    // any trailing delivery-flavored stops (old heuristic, scoped to the
    // window so mid-load splits don't jump legs).
    const windowStartIdx = markerOrdinal === 0 ? 0 : (markerIdxsAll[markerOrdinal - 1] + 1);
    const windowEndIdxExcl = markerOrdinal < markerIdxsAll.length ? markerIdxsAll[markerOrdinal] : stops.length;
    let insertIdx = windowEndIdxExcl;
    for (let i = windowEndIdxExcl - 1; i >= windowStartIdx; i--) {
      if (stops[i].type !== 'delivery' && stops[i].type !== 'drop_hook' && stops[i].type !== 'drop') { insertIdx = i + 1; break; }
      insertIdx = i;
    }
    const next = [...stops.slice(0, insertIdx), relayStop, ...stops.slice(insertIdx)];
    setStops(next.map((s, i) => ({ ...s, sequence: i + 1 })));

    // New leg defaults: a different truck than the leg being split, and
    // that truck's preferred driver.
    const splitLegAsset = targetLeg && !isViewedTarget
      ? (legEdits[targetLeg.id]?.assetId ?? targetLeg.assetId)
      : (!isEdit && draftLegs.length > 0) ? draftLegs[draftLegs.length - 1].assetId : assetId;
    const newAsset = assets.find(a => a.id !== splitLegAsset)?.id ?? splitLegAsset;
    const draft = { key: crypto.randomUUID(), assetId: newAsset, driverName: preferredDriverName(newAsset) };
    if (isEdit) {
      setDraftLegs([draft]);
      setPendingSplitStopId(relayStop.id);
      setPendingSplitTargetId(targetLeg?.id ?? modalEventId ?? null);
    } else {
      setDraftLegs(prev => [...prev, draft]);
    }
    markDirty();
  };

  /** Per-leg edits from RelayLegsEditor. The viewed leg routes to the
   *  main form state; drafts get the driver↔truck pref auto-applied
   *  (same silent-apply rule as create mode's main row); persisted
   *  non-viewed legs buffer in legEdits until Save. */
  const handleLegChange = (key: string, patch: { assetId?: number; driverName?: string; pay?: number | '' }) => {
    markDirty();
    if (patch.pay !== undefined) {
      const pay = patch.pay;
      setLegPays(prev => ({ ...prev, [key]: pay }));
    }
    const isViewedKey = key === 'leg0' || key === modalEventId;
    const draft = draftLegs.find(d => d.key === key);
    // A builder leg that doesn't exist server-side yet gets the same
    // silent driver↔truck pref application as a create-mode draft, but
    // its values live in legEdits (keyed by position).
    const isNewBuilderLeg = key.startsWith('newleg:');
    if (isNewBuilderLeg) {
      if (patch.driverName !== undefined) {
        const name = patch.driverName;
        const prefAid = preferredAssetForDriverName(name);
        setLegEdits(prev => ({
          ...prev,
          [key]: { ...prev[key], driverName: name, ...(prefAid != null ? { assetId: prefAid } : {}) },
        }));
      }
      if (patch.assetId !== undefined) {
        const aid = patch.assetId;
        const suggested = preferredDriverName(aid);
        setLegEdits(prev => ({
          ...prev,
          [key]: { ...prev[key], assetId: aid, ...(suggested ? { driverName: suggested } : {}) },
        }));
      }
      return;
    }
    if (patch.driverName !== undefined) {
      const name = patch.driverName;
      if (isViewedKey) {
        setDriverName(name);
      } else if (draft) {
        const prefAid = preferredAssetForDriverName(name);
        setDraftLegs(prev => prev.map(d => d.key === key
          ? { ...d, driverName: name, ...(prefAid != null ? { assetId: prefAid } : {}) }
          : d));
      } else {
        // Picking a driver also pulls that driver's truck across, and
        // an empty pick is an EXPLICIT clear — recorded so the payload
        // safety net can tell it apart from a lost buffer.
        const prefAid = preferredAssetForDriverName(name);
        setLegEdits(prev => ({
          ...prev,
          [key]: { ...prev[key], driverName: name, ...(prefAid != null ? { assetId: prefAid } : {}) },
        }));
        const evId = relayLegViews.find(v => v.key === key)?.eventId;
        if (evId) {
          setExplicitClears(prev => ({ ...prev, [evId]: { ...prev[evId], driver: !name.trim() } }));
        }
      }
    }
    if (patch.assetId !== undefined) {
      const aid = patch.assetId;
      if (isViewedKey) {
        setAssetId(aid);
      } else if (draft) {
        const suggested = preferredDriverName(aid);
        setDraftLegs(prev => prev.map(d => d.key === key
          ? { ...d, assetId: aid, ...(suggested ? { driverName: suggested } : {}) }
          : d));
      } else {
        // Driver-preference autofill applies to ANY leg without a
        // driver — including a persisted-but-unassigned one, which
        // previously fell through to the stored (empty) name and so
        // never picked up the truck's preferred driver.
        const view = relayLegViews.find(v => v.key === key);
        const currentDriver = (legEdits[key]?.driverName ?? view?.driverName ?? '').trim();
        const suggested = preferredDriverName(aid);
        const evId = view?.eventId;
        const clearedOnPurpose = !!(evId && explicitClears[evId]?.driver);
        const fillDriver = !currentDriver && !clearedOnPurpose && suggested;
        setLegEdits(prev => ({
          ...prev,
          [key]: { ...prev[key], assetId: aid, ...(fillDriver ? { driverName: suggested } : {}) },
        }));
      }
    }
  };

  /** Split planned leg `legIdx` in two. The FIRST half keeps the
   *  eventId (mirrors the server's split semantics: the target leg
   *  keeps its identity, its end clamps to the new boundary); the
   *  SECOND half is genuinely new — it must never inherit an eventId,
   *  released or otherwise. */
  const splitPlanAt = (legIdx: number) => {
    setLegPlan(prev => {
      const base = prev.length > 0 ? prev : planFromLegs(relayLegs);
      const i = Math.max(0, Math.min(legIdx, base.length - 1));
      if (base.length === 0) return base;
      return [
        ...base.slice(0, i + 1),
        { key: `newleg:${crypto.randomUUID()}` },   // no eventId — a new leg
        ...base.slice(i + 1),
      ];
    });
  };

  /** Which planned leg the stop at `stopIdx` sits in, using the CURRENT
   *  boundary positions (boundaries strictly before it). */
  const legIdxForStop = (stopIdx: number) => boundaryIdxs.filter(b => b < stopIdx).length;

  /** Create mode's analogue of splitPlanAt. Boundary ordinal `m` opens
   *  leg m+1, which is `draftLegs[m]` (leg 0 is the form itself), so a
   *  new boundary at ordinal m SPLICES a draft leg in at index m —
   *  never appends. That 1:1 marker↔draftLeg alignment is create
   *  mode's identity invariant; doSave asserts it before POSTing. */
  const spliceDraftLegAt = (m: number) => {
    setDraftLegs(prev => {
      const at = Math.max(0, Math.min(m, prev.length));
      // Default to a truck other than the leg being split, plus that
      // truck's preferred driver — same rule as the edit-path builder.
      const splitLegAsset = at === 0 ? assetId : (prev[at - 1]?.assetId ?? assetId);
      const newAsset = assets.find(a => a.id !== splitLegAsset)?.id ?? splitLegAsset;
      const draft = { key: crypto.randomUUID(), assetId: newAsset, driverName: preferredDriverName(newAsset) };
      return [...prev.slice(0, at), draft, ...prev.slice(at)];
    });
  };

  /** Toggle `isHandoff` on an intermediate stop — the leg-builder's
   *  "handoff on a real stop" affordance. Turning it ON seeds the two
   *  handoff times from the stop's own appointment window so the leg
   *  boundaries are valid immediately; turning it OFF merges the two
   *  adjacent legs (the earlier leg keeps its eventId; the later one's
   *  is released). Both directions mutate the leg PLAN, so identity
   *  travels with the leg rather than with its position. */
  const handleToggleStopHandoff = (idx: number) => {
    const stop = stops[idx];
    if (!stop) return;
    if (idx === 0 || idx === stops.length - 1) {
      showSaveBlocked('The first and last stop cannot be handoffs — a handoff needs a leg on each side.');
      return;
    }
    if (stop.isHandoff) {
      // Turning a boundary off is a merge — route it through the same
      // path as the divider's "Remove leg" so identity is released
      // consistently and the confirm/assertions stay in one place.
      handleRemoveHandoff(boundaryIdxs.indexOf(idx));
      return;
    }
    const newBoundaryOrdinal = legIdxForStop(idx);
    if (isLegBuilder) splitPlanAt(newBoundaryOrdinal);
    else if (isCreateLegBuilder) spliceDraftLegAt(newBoundaryOrdinal);
    setStops(prev => prev.map((s, i) => {
      if (i !== idx) return s;
      if (s.isHandoff) {
        return { ...s, isHandoff: false, handoffDropAt: undefined, handoffPickupAt: undefined };
      }
      const drop = s.apptEnd ?? s.apptStart;
      return {
        ...s,
        isHandoff: true,
        handoffDropAt:   s.handoffDropAt   ?? drop,
        handoffPickupAt: s.handoffPickupAt ?? drop,
      };
    }));
    markDirty();
  };

  /** "+ add handoff between these stops" — inserts a NEW relay-point
   *  stop in the gap after `idx` (the yard case: a handoff location
   *  that isn't a stop yet). Times default midway between the
   *  neighbours' known times so the leg windows stay ordered. */
  const handleInsertHandoffAfter = (idx: number) => {
    const before = stops[idx];
    const after  = stops[idx + 1];
    if (!before || !after) return;
    // The new marker lands at idx+1, so it splits the leg containing
    // that position. Boundaries at or before idx are already behind it.
    const newBoundaryOrdinal = boundaryIdxs.filter(b => b <= idx).length;
    if (isLegBuilder) splitPlanAt(newBoundaryOrdinal);
    else if (isCreateLegBuilder) spliceDraftLegAt(newBoundaryOrdinal);
    // Pre-fill both times by the existing rule: the handoff sits an
    // hour before the NEXT stop (thirds of the gap when it's shorter),
    // so the dispatcher can accept the defaults from the legs editor
    // without opening Locations at all.
    const prevIso = handoffTimesOf(before).pickup ?? handoffTimesOf(before).drop
      ?? before.apptEnd ?? before.apptStart ?? `${startDate}T${startTime}`;
    const nextIso = after.apptStart ?? after.apptEnd
      ?? `${endDate || startDate}T${endTime || startTime}`;
    const prevMs = Date.parse(prevIso);
    const nextMs = Date.parse(nextIso);
    const fmtLocal = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    let dropIso = prevIso;
    let pickupIso = prevIso;
    if (Number.isFinite(prevMs) && Number.isFinite(nextMs) && nextMs > prevMs) {
      const unit = Math.min(60 * 60 * 1000, Math.floor((nextMs - prevMs) / 3));
      pickupIso = fmtLocal(new Date(Math.max(prevMs, nextMs - unit)));
      dropIso   = fmtLocal(new Date(Math.max(prevMs, nextMs - 2 * unit)));
    }
    const relayStop: Stop = {
      id: crypto.randomUUID(),
      eventId: '',
      sequence: 0,
      type: 'relay',
      geocodeStatus: 'pending',
      apptStart: dropIso,
      apptEnd:   pickupIso,
    };
    setStops(prev => [...prev.slice(0, idx + 1), relayStop, ...prev.slice(idx + 1)]
      .map((s, i) => ({ ...s, sequence: i + 1 })));
    markDirty();
  };

  // ── Apply N legs (atomic reconcile) ────────────────────────────────
  // Reached from Save when the leg structure changed — the modal's own
  // saving indicator covers the in-flight state.
  /** Only checks the DISPATCHER can act on. Structural disagreement
   *  between the plan and the route is NOT an error — effectivePlan
   *  rebuilds from the stop list (stops are truth), so an inconsistent
   *  load heals by pressing Save instead of being refused. */
  const legsValidationError = (): string | null => {
    if (!currentEv?.loadId) return 'This load has not been saved yet — save it before configuring legs.';
    // Last hole through which a half-known load could be written back:
    // never build a payload from a plan whose legs are still arriving.
    if (legsLoading) {
      return 'Still loading this load\u2019s legs — wait a moment and save again.';
    }
    if (stops.length < 2) return 'Add at least two stops before splitting this load into legs.';
    if (boundaryIdxs.includes(0) || boundaryIdxs.includes(stops.length - 1)) {
      return 'The first and last stop cannot be handoffs — a handoff needs a leg on each side.';
    }
    // ── Payload audit: every field the server validates ─────────────
    // Catch these here with the leg named, rather than letting the API
    // 400 with an index the dispatcher can't map to anything on screen.
    const nameOf = (i: number) => legLabel(i, relayLegViews.length) || `Leg ${i + 1}`;
    const isNaiveIso = (v: string | undefined): v is string =>
      !!v && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v);
    for (let i = 0; i < relayLegViews.length; i++) {
      const l = relayLegViews[i];
      // assetId must be a real number that exists in the asset list.
      if (!l.assetId || !Number.isFinite(l.assetId) || !assets.some(a => a.id === l.assetId)) {
        return `${nameOf(i)} needs a truck before these legs can be saved.`;
      }
      // start / end must be present, well-formed and correctly ordered.
      const t = legBoundaryTimes(i);
      if (!isNaiveIso(t.start) || !isNaiveIso(t.end)) {
        return `${nameOf(i)} is missing a start or end time. Set the load's pickup and delivery times, and a drop time on each handoff.`;
      }
      if (t.start > t.end) {
        return `${nameOf(i)} ends before it starts. Check the handoff times around it.`;
      }
    }
    for (let i = 0; i < boundaryIdxs.length; i++) {
      const t = handoffTimesOf(stops[boundaryIdxs[i]]);
      if (!t.drop && !t.pickup) {
        return `Handoff ${i + 1} needs a drop time — set it on the handoff row in the Relay section.`;
      }
    }
    return null;
  };

  /** Legs the pending save would DELETE — persisted legs of this load
   *  that no longer appear in the plan (released by a merge, or gone
   *  for any other reason). */
  const legsBeingRemoved = (): CalendarEvent[] => {
    // Never compute removals from a half-loaded picture: a leg still in
    // flight isn't in relayLegs, and one whose identity we haven't
    // resolved yet would look "dropped". That produced a delete
    // confirmation immediately after the dispatcher ADDED a leg. Save is
    // blocked while loading anyway, so reporting nothing here is safe.
    if (legsLoading) return [];
    const kept = new Set(relayLegViews.map(l => l.eventId).filter(Boolean));
    return relayLegs.filter(l => !kept.has(l.id));
  };
  /** A removal is "drastic" when the leg carries work: a driver, pay, a
   *  status past `assigned`, or documents keyed to it. Removing an
   *  untouched leg is routine and needs no dialog. */
  const isProgressedLeg = (leg: CalendarEvent): boolean => {
    const beyondAssigned = !!leg.status && !['scheduled', 'assigned'].includes(leg.status);
    const hasDocs = loadDocuments.some(d => (d as { eventId?: string }).eventId === leg.id);
    return !!leg.driverName || !!leg.driverId || (leg.driverPay ?? 0) > 0 || beyondAssigned || hasDocs;
  };

  const [legRemovalConfirm, setLegRemovalConfirm] = useState<{ message: string; surplus?: boolean } | null>(null);
  const legRemovalResolver = useRef<((ok: boolean) => void) | null>(null);
  /** Describe exactly what a destructive save is about to drop, then
   *  wait for the dispatcher. Resolves false on cancel. */
  const confirmLegRemoval = (removed: CalendarEvent[]): Promise<boolean> => {
    const describe = (leg: CalendarEvent) => {
      const idx = relayLegs.findIndex(l => l.id === leg.id);
      const label = legLabel(idx >= 0 ? idx : 0, relayLegs.length) || `Leg ${(idx >= 0 ? idx : 0) + 1}`;
      const truck = assets.find(a => a.id === leg.assetId);
      const bits = [
        leg.driverName || 'no driver',
        truck ? (truck.unit ? `${truck.name} - ${truck.unit}` : truck.name) : 'no truck',
        (leg.driverPay ?? 0) > 0 ? `$${(leg.driverPay as number).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null,
      ].filter(Boolean);
      return `${label} (${bits.join(', ')})`;
    };
    // Two very different situations wear the same dialog, so say which
    // one this is. A leg the dispatcher just merged away is expected;
    // surplus legs that match no route segment are damaged data (the
    // duplicate-save bug) and reappear on every save until cleared —
    // alarming unless we name it.
    const surplusCount = Math.max(0, relayLegs.length - derivedLegCount);
    const removedIsSurplus = surplusCount > 0 && removed.length <= surplusCount
      && releasedEventIds.length === 0;
    const list = removed.map(describe).join(' and ');
    const message = removedIsSurplus
      ? `This load has ${removed.length} extra leg${removed.length === 1 ? '' : 's'} that ${removed.length === 1 ? "isn't" : "aren't"} part of its route (left behind by an earlier failed save): ${list}. Saving removes ${removed.length === 1 ? 'it' : 'them'} and leaves the ${derivedLegCount} leg${derivedLegCount === 1 ? '' : 's'} the route actually has. Continue?`
      : `Saving removes ${list}. Its pay and paperwork will be detached from the load. Continue?`;
    return new Promise<boolean>(resolve => {
      legRemovalResolver.current = resolve;
      setLegRemovalConfirm({ message, surplus: removedIsSurplus });
    });
  };

  /** Commit the planned legs in ONE PUT /v1/loads/:id/legs. Identity
   *  comes from the leg PLAN: entries with an eventId update that leg
   *  in place, entries without create one, and persisted legs absent
   *  from the array are soft-deleted server-side. Returns true when
   *  the reconcile landed. */
  const applyLegsNow = async (): Promise<boolean> => {
    const blocked = legsValidationError();
    if (blocked) { showSaveBlocked(blocked); return false; }
    const loadId = currentEv?.loadId;
    if (!loadId) return false;
    // Drastic-change gate: name what is going away before doing it.
    // The server independently refuses (409 leg_removal_blocked) unless
    // `force` is set, so an unconfirmed destructive save can't slip by.
    const removed = legsBeingRemoved();
    const progressed = removed.filter(isProgressedLeg);
    let force = false;
    if (progressed.length > 0) {
      const ok = await confirmLegRemoval(progressed);
      if (!ok) return false;
      force = true;
    }
    try {
      await configureLegs(loadId, {
        stops,
        legs: relayLegViews.map((l, i) => {
          const times = legBoundaryTimes(i);
          const payVal = legPays[l.key];
          // ── Never silently downgrade an assigned leg ───────────────
          // If this leg exists server-side and the payload would send a
          // BLANK driver/truck/pay while the stored row has one, that is
          // a lost edit buffer, not an intent — keep the stored value.
          // An explicit "— No driver —" pick is recorded separately and
          // still clears. Without this, a key that changed between
          // assigning and saving wrote null over the assignment and the
          // save reported success.
          const persisted = l.eventId ? relayLegs.find(e => e.id === l.eventId) : undefined;
          const clearedDriver = !!(l.eventId && explicitClears[l.eventId]?.driver);
          const driverName = l.driverName?.trim()
            ? l.driverName
            : (clearedDriver ? null : (persisted?.driverName ?? null));
          const assetId = l.assetId || persisted?.assetId;
          const driverPay = payVal === '' || payVal == null
            ? (persisted?.driverPay ?? null)
            : payVal;
          return {
            ...(l.eventId ? { eventId: l.eventId } : {}),
            assetId: assetId as number,
            driverId: findDriverByName(driverName ?? undefined)?.id ?? null,
            driverName: driverName || null,
            driverPay,
            start: times.start,
            end:   times.end,
            status: l.isViewed ? status : undefined,
            trailerId: l.isViewed ? (linkedTrailerId ?? null) : undefined,
          };
        }),
        ...(force ? { force: true } : {}),
      });
      // Reconcile landed — the plan is rebuilt from the server's
      // canonical legs on the next open; clear the release ledger so a
      // stale id can never influence a later edit.
      setReleasedEventIds([]);
      setLegPlan([]);
      return true;
    } catch {
      // configureLegs already toasted the failure (including the
      // server's leg_removal_blocked message).
      return false;
    }
  };

  /** Write a handoff's drop / pickup time from the legs editor. Mirrors
   *  handoffTimesOf's read branching: a handoff sitting ON a real stop
   *  uses handoffDropAt/handoffPickupAt (its own appointment window is
   *  a different thing and stays put); a bare relay point IS the
   *  handoff, so it uses apptStart/apptEnd. */
  const handleChangeHandoffTimes = (handoffIdx: number, patch: { drop?: string; pickup?: string }) => {
    const stopIdx = boundaryIdxs[handoffIdx];
    if (stopIdx == null) return;
    setStops(prev => prev.map((s, i) => {
      if (i !== stopIdx) return s;
      const onRealStop = s.type !== 'relay';
      if (onRealStop) {
        return {
          ...s,
          ...(patch.drop   !== undefined ? { handoffDropAt:   patch.drop   || undefined } : {}),
          ...(patch.pickup !== undefined ? { handoffPickupAt: patch.pickup || undefined } : {}),
        };
      }
      return {
        ...s,
        ...(patch.drop   !== undefined ? { apptStart: patch.drop   || undefined } : {}),
        ...(patch.pickup !== undefined ? { apptEnd:   patch.pickup || undefined } : {}),
      };
    }));
    markDirty();
  };

  /** Edit the handoff STOP itself (facility, address, and whatever the
   *  shared address input geocodes onto it — lat/lng/timezone/status).
   *  Writes straight to that stop, exactly as the Locations row does,
   *  so leg miles and the driver app see identical data. */
  const handleChangeHandoffStop = (handoffIdx: number, patch: Partial<Stop>) => {
    const stopIdx = boundaryIdxs[handoffIdx];
    if (stopIdx == null) return;
    setStops(prev => prev.map((s, i) => (i === stopIdx ? { ...s, ...patch } : s)));
    markDirty();
  };

  /** Re-pull the load's documents after a handoff-photo upload. */
  const refreshHandoffDocs = async () => {
    const lid = currentEv?.loadId;
    if (!lid || !orgId) return;
    const { fetchLoadDocuments } = await import('@/lib/db');
    setLoadDocuments(await fetchLoadDocuments(lid, orgId));
  };

  /** Strip the driver-check-in runtime fields off a stop. Used by
   *  Duplicate and +1 Week so a brand-new load draft doesn't inherit
   *  the original's "Arrived at 3:45pm" timestamps from when its
   *  driver actually checked in. The static load-definition fields
   *  (facility, address, appt window, etc.) all carry over. */
  const stripStopRuntime = (s: Stop): Stop => {
    const { arrivedAt: _arrivedAt, arrivedLat: _arrivedLat, arrivedLng: _arrivedLng, ...rest } = s;
    void _arrivedAt; void _arrivedLat; void _arrivedLng;
    return rest as Stop;
  };

  const handlePlusOneWeek = () => {
    const shiftDateStr = (dateStr: string) => {
      const [y, m, d] = dateStr.split('-').map(Number);
      return localDateStr(new Date(y, m - 1, d + 7));
    };
    const shiftIso = (iso: string | undefined) => {
      if (!iso) return iso;
      const tIdx = iso.indexOf('T');
      const datePart = tIdx >= 0 ? iso.slice(0, tIdx) : iso;
      const timePart = tIdx >= 0 ? iso.slice(tIdx) : '';
      const [y, m, d] = datePart.split('-').map(Number);
      const shifted = new Date(Date.UTC(y, m - 1, d + 7));
      const yy = shifted.getUTCFullYear();
      const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(shifted.getUTCDate()).padStart(2, '0');
      return `${yy}-${mm}-${dd}${timePart}`;
    };
    const shiftedStops = stops.map(s => ({
      ...stripStopRuntime(s),
      apptStart: shiftIso(s.apptStart),
      apptEnd:   shiftIso(s.apptEnd),
    }));
    // Strip per-load identifiers — same as Duplicate. The next-week copy
    // is logically a brand-new load that just inherits the route + asset.
    const { loadNum: _loadNum, refNums: _refNums, ...rest } = buildOptionalPayload();
    void _loadNum; void _refNums;
    openCreateModal({
      title: title || undefined, assetId, driverName: driverName || undefined,
      start: `${shiftDateStr(startDate)}T${startTime}`,
      end:   `${shiftDateStr(endDate)}T${endTime}`,
      ...rest,
      accessorials: accessorials.length > 0 ? accessorials : undefined,
      stops: shiftedStops.length > 0 ? shiftedStops : undefined,
    });
  };

  const handleDuplicate = () => {
    // Strip per-load identifiers — these should never carry over to a duplicate.
    const { loadNum: _loadNum, refNums: _refNums, ...rest } = buildOptionalPayload();
    void _loadNum; void _refNums;
    // Strip the driver-check-in runtime fields off each stop. The
    // duplicate is a fresh future load — it hasn't been driven yet.
    const cleanedStops = stops.map(stripStopRuntime);
    openCreateModal({
      title: title || undefined, assetId, driverName: driverName || undefined,
      start: `${startDate}T${startTime}`, end: `${endDate}T${endTime}`,
      ...rest,
      accessorials: accessorials.length > 0 ? accessorials : undefined,
      stops: cleanedStops.length > 0 ? cleanedStops : undefined,
    });
  };

  const handleParseFile = (file: File) => {
    if (!file || file.type !== 'application/pdf') return;
    setParseState('parsing'); setParseError('');
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];
      setRateConPdf(dataUrl);
      try {
        const res = await fetch('/api/parse-ratecon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            data: base64,
            enabledFields: Object.keys(fieldSettings).filter(k => fieldSettings[k]),
            customInstructions: promptInstructions,
            promptVariables,
          }),
        });
        const parsed = await res.json();
        if (parsed.error) throw new Error(parsed.error);

        let resolvedBroker: string | undefined;
        if (parsed.loadNum) setField('loadNum', parsed.loadNum);
        if (parsed.refNums) setFieldValues(prev => ({ ...prev, refNums: parseAiRefNums(parsed.refNums) }));
        if (parsed.start) {
          const [sd, st = '08:00'] = parsed.start.split('T');
          // Sync prevStartDateRef BEFORE setStartDate so the
          // stop-shift effect (line ~2141) sees prev === new and
          // skips the delta-shift. Without this, the freshly parsed
          // stops get shifted by however many days the parsed start
          // differs from the modal's pre-parse date, causing the
          // observed "appt dates jumped +N days" bug.
          prevStartDateRef.current = sd;
          setStartDate(sd); setStartTime(st.slice(0, 5));
          if (!parsed.end) setEndDate(sd);
        }
        if (parsed.end) {
          const [ed, et = '17:00'] = parsed.end.split('T');
          setEndDate(ed); setEndTime(et.slice(0, 5));
        }
        // Coerce numeric fields (AI sometimes returns "1500.00" strings).
        const lpNum = parsed.loadPrice != null ? parseFloat(String(parsed.loadPrice)) : NaN;
        const dpNum = parsed.driverPay != null ? parseFloat(String(parsed.driverPay)) : NaN;
        if (Number.isFinite(lpNum) && lpNum > 0) {
          setField('loadPrice', lpNum);
          // Driver-pay precedence: if a percentage is configured in settings,
          // it always wins (the user's intent — they set it to drive every load).
          // Only fall back to AI-extracted driverPay when no percentage is set.
          if (driverPayPct != null) {
            const auto = Math.round(lpNum * (driverPayPct / 100) * 100) / 100;
            setFieldValues(prev => ({ ...prev, driverPay: auto }));
            driverPayAutoSet.current = true;
            setDriverPayIsAuto(true);
          } else if (Number.isFinite(dpNum) && dpNum > 0) {
            setField('driverPay', dpNum);
            driverPayAutoSet.current = false;
            setDriverPayIsAuto(false);
          }
        }
        // Legacy AI prompts may still emit `notes` — funnel into specialInstructions.
        if (parsed.notes && !parsed.specialInstructions) parsed.specialInstructions = parsed.notes;
        if (parsed.broker) {
          const match = matchCustomer(String(parsed.broker), customers);
          if (match.status === 'auto') {
            resolvedBroker = match.customer.name;
            setField('broker', match.customer.name);
            setField('customerId', match.customer.id);
            if (String(parsed.broker).trim() !== match.customer.name) {
              void addCustomerAlias(match.customer.id, String(parsed.broker).trim());
            }
          } else {
            resolvedBroker = String(parsed.broker);
            setField('broker', parsed.broker);
          }
          setBrokerMatch(match);
        }
        if (parsed.trailerType) setField('trailerType', parsed.trailerType);
        // commodity + weight are extracted on every parse (see
        // ALWAYS_EXTRACT in lib/prompt.ts) so reefer / flatbed / hazmat
        // carriers get them autofilled out of the box, and Curzon (who
        // hides them on the modal) still persists the value to the
        // load row. setField writes regardless of UI visibility — the
        // save payload picks them up in buildOptionalPayload below.
        if (parsed.commodity)   setField('commodity', parsed.commodity);
        if (parsed.weight != null) {
          const w = parseFloat(String(parsed.weight));
          if (Number.isFinite(w) && w > 0) setField('weight', w);
        }
        if (parsed.specialInstructions) setField('specialInstructions', parsed.specialInstructions);
        // Snap any drifted stop dates back into the load window before
        // building the Stop[]. See snapStopsToLoadWindow docs for the
        // recurring AI-parser drift this catches.
        const rawStops = Array.isArray(parsed.stops) && parsed.stops.length > 0
          ? snapStopsToLoadWindow(parsed.stops as Stop[], parsed.start, parsed.end)
          : [];
        const parsedStops: Stop[] = rawStops.map((s, i) => ({
          ...s, id: crypto.randomUUID(), eventId: '', sequence: i + 1,
        }));
        if (parsedStops.length > 0) setStops(parsedStops);
        // Generate title from resolved broker + stops rather than AI summary
        setTitle(generateLoadTitle(resolvedBroker, parsedStops, customers) || (parsed.summary ? String(parsed.summary) : ''));
        setParseState('done');
        setShowPdfViewer(true);
      } catch (err) {
        setParseError((err as Error).message ?? 'Failed to parse PDF');
        setParseState('error');
      }
    };
    reader.readAsDataURL(file);
  };

  // Convert an ArrayBuffer to base64 in fixed-size chunks. Spreading a
  // typed array directly into String.fromCharCode hits the JS argument
  // limit (~125 KB on most engines) and throws "Maximum call stack size
  // exceeded" on PDFs larger than ~100 KB.
  const bufferToBase64 = (buf: ArrayBuffer): string => {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const CHUNK = 0x8000; // 32 KB — safely under any spread limit
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  };

  const handleQuickReparse = async () => {
    if (!rateConPdf || reparsing) return;
    setReparsing(true);
    try {
      // Resolve to base64 — rateConPdf may be a data URL, signed URL, or storage path
      let base64: string;
      if (rateConPdf.startsWith('data:')) {
        base64 = rateConPdf.split(',')[1];
      } else {
        // Fetch the PDF (signed URL or blob URL) and convert
        const resp = await fetch(pdfObjectUrl || rateConPdf);
        const buf  = await resp.arrayBuffer();
        base64 = bufferToBase64(buf);
      }
      const res = await fetch('/api/parse-ratecon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: base64, enabledFields: ['loadNum', 'refNums'], customInstructions: '', promptVariables: {} }),
      });
      const parsed = await res.json();
      if (parsed.error) throw new Error(parsed.error);
      if (parsed.loadNum) { setField('loadNum', parsed.loadNum); markDirty(); }
      if (parsed.refNums) { setFieldValues(prev => ({ ...prev, refNums: parseAiRefNums(parsed.refNums) })); markDirty(); }
    } catch (err) {
      console.error('Quick reparse failed:', err);
    } finally {
      setReparsing(false);
    }
  };

  /**
   * Full reparse from the doc viewer — re-runs the AI against the existing
   * rate-con PDF and overwrites the load's fields with the fresh extraction.
   * Used when a broker sends an updated rate-con (rate change, added stop,
   * etc.) and you want the form re-synced without re-uploading the PDF.
   *
   * The server runs a single Sonnet pass with conditional Haiku
   * retry on date-cross-check failure (see /api/parse-ratecon).
   * Customer matching is done client-side after the response lands,
   * not on the server — no roster injection needed.
   */
  const handleFullReparse = async () => {
    if (!rateConPdf || reparsing) return;
    setReparsing(true);
    try {
      let base64: string;
      if (rateConPdf.startsWith('data:')) {
        base64 = rateConPdf.split(',')[1];
      } else {
        const resp = await fetch(pdfObjectUrl || rateConPdf);
        const buf  = await resp.arrayBuffer();
        base64 = bufferToBase64(buf);
      }
      const res = await fetch('/api/parse-ratecon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: base64,
          enabledFields: Object.keys(fieldSettings).filter(k => fieldSettings[k]),
          customInstructions: promptInstructions,
          promptVariables,
        }),
      });
      const parsed = await res.json();
      if (parsed.error) throw new Error(parsed.error);

      // Push every extracted field through the modal's field setter,
      // mirroring the initial-parse handler so reparse and first-parse
      // behave identically.
      const lpNum = parsed.loadPrice != null ? parseFloat(String(parsed.loadPrice)) : NaN;
      const dpNum = parsed.driverPay != null ? parseFloat(String(parsed.driverPay)) : NaN;
      if (parsed.loadNum)     setField('loadNum', parsed.loadNum);
      if (parsed.refNums)     setFieldValues(prev => ({ ...prev, refNums: parseAiRefNums(parsed.refNums) }));
      if (parsed.dispatcher)  setField('dispatcher', parsed.dispatcher);
      if (parsed.commodity)   setField('commodity', parsed.commodity);
      // AI sometimes returns weight as a string (e.g. "40000"). Coerce
      // before writing so the number-typed field doesn't get a string
      // that fails downstream Number.isFinite checks.
      if (parsed.weight != null) {
        const w = parseFloat(String(parsed.weight));
        if (Number.isFinite(w) && w > 0) setField('weight', w);
      }
      if (parsed.trailerType) setField('trailerType', parsed.trailerType);
      if (parsed.specialInstructions) setField('specialInstructions', parsed.specialInstructions);
      if (Number.isFinite(lpNum) && lpNum > 0) {
        setField('loadPrice', lpNum);
        if (driverPayPct != null) {
          const auto = Math.round(lpNum * (driverPayPct / 100) * 100) / 100;
          setFieldValues(prev => ({ ...prev, driverPay: auto }));
          driverPayAutoSet.current = true;
          setDriverPayIsAuto(true);
        } else if (Number.isFinite(dpNum) && dpNum > 0) {
          setField('driverPay', dpNum);
        }
      }
      if (parsed.start) {
        const [sd, st = '08:00'] = parsed.start.split('T');
        // Sync prevStartDateRef BEFORE setStartDate so the stop-shift
        // effect doesn't apply a delta when the reparse moves
        // startDate. Same fix as the initial-parse path above.
        prevStartDateRef.current = sd;
        setStartDate(sd); setStartTime(st.slice(0, 5));
      }
      if (parsed.end) {
        const [ed, et = '17:00'] = parsed.end.split('T');
        setEndDate(ed); setEndTime(et.slice(0, 5));
      }
      if (Array.isArray(parsed.stops) && parsed.stops.length > 0) {
        // Same snap as the initial-parse path so reparse can't reintroduce
        // drifted stop dates.
        const snapped = snapStopsToLoadWindow(parsed.stops as Stop[], parsed.start, parsed.end);
        setStops(snapped.map((s, i) => ({ ...s, id: crypto.randomUUID(), eventId: '', sequence: i + 1 })));
      }
      markDirty();
    } catch (err) {
      console.error('Full reparse failed:', err);
      alert(`Reparse failed: ${(err as Error).message ?? 'Unknown error'}`);
    } finally {
      setReparsing(false);
    }
  };

  const handleDroppedFile = (file: File) => {
    if (!file || file.type !== 'application/pdf') return;
    if (!isEdit) {
      handleParseFile(file);
    } else {
      const reader = new FileReader();
      reader.onload = () => { markDirty(); setRateConPdf(reader.result as string); setShowPdfViewer(true); };
      reader.readAsDataURL(file);
    }
  };

  const handleBatchSave = (opts?: { skipGeocodeCheck?: boolean }) => {
    if (!title.trim() || !startDate || !endDate) return;
    if (dateOrderError) return;
    if (brokerMatch.status === 'new') { setBrokerSaveBlocked(true); return; }
    if (!opts?.skipGeocodeCheck && stops.some(s => s.geocodeStatus === 'failed')) {
      setGeocodeBlock('batch');
      return;
    }
    if (!dupLoadNum) {
      const loadNum = String(fieldValues['loadNum'] ?? '').trim();
      if (loadNum) {
        const dup = events.find(e => String(e.loadNum ?? '').trim() === loadNum);
        if (dup) { setDupLoadNum(loadNum); setPendingSave('batch'); return; }
      }
    }
    const newEventId = crypto.randomUUID();
    // Storage path is deterministic, so we can save the event row now and upload in the background.
    let storedPdf: string | undefined = rateConPdf?.startsWith('data:') ? undefined : rateConPdf;
    if (rateConPdf?.startsWith('data:') && orgId) {
      const pdf = rateConPdf;
      storedPdf = `${orgId}/${newEventId}.pdf`;
      void uploadRateCon(pdf, orgId, newEventId).catch(err => {
        console.error('PDF upload failed — rate con not saved, re-attach when editing:', err);
      });
    }
    const optionals = buildOptionalPayload();
    const payload: Omit<CalendarEvent, 'id'> = {
      title: title.trim(), ...optionals, trailerId: linkedTrailerId, rateConPdf: storedPdf,
      accessorials: accessorials.length > 0 ? accessorials : undefined,
      stops: stops.filter(s => s.type !== 'relay'),
      assetId, driverName: driverName || undefined,
      start: `${startDate}T${startTime}`, end: `${endDate}T${endTime}`,
      status, eventKind, nonRevenueType: eventKind === 'non_revenue' ? nonRevenueType : undefined,
    };
    addEvent(payload, newEventId);
    if (batchIndex >= batchItems.length - 1) {
      clearBatch();
      closeModal();
    } else {
      batchNext();
    }
  };

  const handleBatchSkip = () => {
    if (!confirmSkip) { setConfirmSkip(true); return; }
    setConfirmSkip(false);
    if (batchIndex >= batchItems.length - 1) {
      clearBatch();
      closeModal();
    } else {
      batchNext();
    }
  };

  const handleBatchCancel = () => {
    if (!confirmBatchCancel) { setConfirmBatchCancel(true); return; }
    clearBatch();
    closeModal();
  };

  if (!modalOpen) return null;

  const selectedAsset = assets.find(a => a.id === assetId);
  const headerColor   = selectedAsset?.color ?? '#1a73e8';
  const truckLoc = selectedAsset?.motiveVehicleId
    ? eldLocations.find(l => l.vehicleId === selectedAsset.motiveVehicleId) ?? null
    : null;
  const ACC_COLOR     = '#16a34a';
  const iStyle        = inputStyle();
  const focusH        = focusColor(headerColor);

  // Boundary legs get yard-flavored labels: any non-final leg ENDS at a
  // handoff, any non-first leg STARTS at one. (Count from primitives —
  // the view models aren't built yet at this point in the component.)
  const relayLegCountTotal = isExistingRelayLeg
    ? Math.max(relayLegs.length + (pendingSplitStopId ? 1 : 0), currentEv?.legCount ?? 2)
    : draftLegs.length + 1;
  const endLabel   = isExistingRelayLeg && viewedLegIdx != null && viewedLegIdx < relayLegCountTotal - 1 ? 'Drop at Yard' : 'End';
  const startLabel = isExistingRelayLeg && (viewedLegIdx ?? 0) > 0 ? 'Pickup from Yard' : 'Start';

  const driverPayPctValue = (() => {
    const lp = typeof fieldValues['loadPrice'] === 'number' ? fieldValues['loadPrice'] : parseFloat(String(fieldValues['loadPrice'] ?? '')) || 0;
    const dp = typeof fieldValues['driverPay']  === 'number' ? fieldValues['driverPay']  : parseFloat(String(fieldValues['driverPay']  ?? '')) || 0;
    if (lp <= 0 || dp <= 0) return null;
    return Math.round((dp / lp) * 1000) / 10;
  })();

  const recalcDriverPay = () => {
    const lp = typeof fieldValues['loadPrice'] === 'number' ? fieldValues['loadPrice'] : parseFloat(String(fieldValues['loadPrice'] ?? '')) || 0;
    if (driverPayPct == null || lp <= 0) return;
    const current = typeof fieldValues['driverPay'] === 'number' ? fieldValues['driverPay'] : parseFloat(String(fieldValues['driverPay'] ?? '')) || 0;
    setPrevDriverPay(current > 0 ? current : null);
    const auto = Math.round(lp * (driverPayPct / 100) * 100) / 100;
    setFieldValues(prev => ({ ...prev, driverPay: auto }));
    driverPayAutoSet.current = true;
    setDriverPayIsAuto(true);
  };

  const undoDriverPayReset = () => {
    if (prevDriverPay == null) return;
    setFieldValues(prev => ({ ...prev, driverPay: prevDriverPay }));
    driverPayAutoSet.current = false;
    setDriverPayIsAuto(false);
    setPrevDriverPay(null);
  };

  const driverPayLabelSuffix = driverPayPctValue !== null ? (
    <span className="flex items-center gap-1 normal-case tracking-normal font-semibold" style={{ fontSize: 10 }}>
      <span className="px-1.5 py-0.5 rounded-lg"
        style={{
          background: driverPayIsAuto ? '#dbeafe' : '#f1f3f4',
          color:      driverPayIsAuto ? '#1d4ed8' : 'var(--gc-text-3)',
          border:     `1px solid ${driverPayIsAuto ? '#bfdbfe' : 'var(--gc-border-light)'}`,
        }}>
        {driverPayPctValue % 1 === 0 ? driverPayPctValue.toFixed(0) : driverPayPctValue.toFixed(1)}%
      </span>
      {!driverPayIsAuto && driverPayPct != null && (
        <button type="button" onClick={recalcDriverPay}
          title={`Reset to ${driverPayPct}%`}
          className="flex items-center gap-1 rounded transition-colors"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--gc-text-3)', padding: '1px 4px' }}
          onMouseEnter={e => { e.currentTarget.style.color = '#1d4ed8'; e.currentTarget.style.background = '#dbeafe'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--gc-text-3)'; e.currentTarget.style.background = 'transparent'; }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
            <path d="M3 3v5h5"/>
          </svg>
          <span style={{ fontSize: 10 }}>Reset to default</span>
        </button>
      )}
      {driverPayIsAuto && prevDriverPay != null && (
        <button type="button" onClick={undoDriverPayReset}
          title="Undo reset"
          className="flex items-center gap-1 rounded transition-colors"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--gc-text-3)', padding: '1px 4px' }}
          onMouseEnter={e => { e.currentTarget.style.color = '#92400e'; e.currentTarget.style.background = '#fef3c7'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--gc-text-3)'; e.currentTarget.style.background = 'transparent'; }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 14 4 9l5-5"/>
            <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>
          </svg>
          <span style={{ fontSize: 10 }}>Undo</span>
        </button>
      )}
    </span>
  ) : null;

  // ── Relay leg view models ──────────────────────────────────────────
  // Everything the RelayLegsEditor renders, assembled from store legs +
  // the modal's edit buffers. The viewed leg's driver/truck mirror the
  // main form fields; other persisted legs read legEdits overrides;
  // draft legs read draftLegs.
  const relayMarkersInStops = boundaryIdxs.map(i => stops[i]);
  // Cheap haversine estimate for draft legs (no cached routed miles yet).
  const draftLegMilesEstimate = (legIdx: number): number | null => {
    const slice = legWindowSlice(stops, legIdx);
    const mi = legStraightMiles({ stops: slice });
    return mi > 0 ? mi : null;
  };
  /** Start/end for derived leg i, from the boundary times around it.
   *  Leg 0 starts at the form start; the last leg ends at the form end;
   *  interior boundaries supply pickup (next leg's start) and drop
   *  (this leg's end). handoffTimesOf normalizes relay-point stops
   *  (apptStart/apptEnd) and isHandoff stops (handoffDropAt/PickupAt). */
  const legBoundaryTimes = (i: number): { start: string; end: string } => {
    const formStart = `${startDate}T${startTime}`;
    const formEnd   = `${endDate || startDate}T${endTime || startTime}`;
    const before = i > 0 ? relayMarkersInStops[i - 1] : undefined;
    const after  = i < relayMarkersInStops.length ? relayMarkersInStops[i] : undefined;
    const bt = before ? handoffTimesOf(before) : undefined;
    const at = after  ? handoffTimesOf(after)  : undefined;
    // Interior boundaries come from the handoff itself. The OUTER
    // boundaries are the load's pickup and delivery: they may only come
    // from the form when the form is actually describing that leg —
    // otherwise they're pinned to the load window, so adding a handoff
    // can never drag the delivery earlier, and editing one leg can
    // never move another leg's outer boundary.
    const viewedIdx = viewedLegIdx ?? 0;
    const lastIdx = relayMarkersInStops.length;
    const loadStart = viewedIdx === 0      ? formStart : (loadWindow?.start ?? formStart);
    const loadEnd   = viewedIdx === lastIdx ? formEnd   : (loadWindow?.end   ?? formEnd);
    const start = bt ? (bt.pickup ?? bt.drop ?? loadStart) : loadStart;
    let end = at ? (at.drop ?? at.pickup ?? loadEnd) : loadEnd;
    // Never emit an inverted window — the server rejects start > end.
    if (end < start) end = start;
    return { start, end };
  };

  const relayLegViews: RelayLegView[] = (() => {
    // NB: computed for every builder load, not just ones the editor is
    // shown for. isRelayContext decides DISPLAY; this is the data the
    // save reconciles with — a load whose route collapsed to a single
    // segment still needs its one leg in the payload so the server can
    // converge (that's the heal path for a load with surplus legs).
    if (!isRelayContext && !isLegBuilder) return [];
    if (isLegBuilder) {
      // Builder: one view per PLANNED leg. Identity (which persisted
      // event a leg is) comes ONLY from the plan — never from array
      // position against relayLegs, which is what silently reattached
      // drivers to the wrong route segment.
      return effectivePlan.map((planned, i) => {
        const existing = planned.eventId
          ? relayLegs.find(l => l.id === planned.eventId)
          : undefined;
        const key = planned.key;
        const isViewed = !!existing && existing.id === modalEventId;
        const edits = legEdits[key] ?? {};
        // A brand-new leg defaults to a truck other than the previous
        // leg's, with that truck's preferred driver.
        const prevKey = i > 0 ? effectivePlan[i - 1].key : undefined;
        const prevExisting = i > 0 && effectivePlan[i - 1].eventId
          ? relayLegs.find(l => l.id === effectivePlan[i - 1].eventId)
          : undefined;
        const prevAssetId = i > 0
          ? ((prevKey ? legEdits[prevKey]?.assetId : undefined) ?? prevExisting?.assetId ?? assetId)
          : assetId;
        const prevDriver = i > 0
          ? ((prevKey ? legEdits[prevKey]?.driverName : undefined)
              ?? (prevExisting ? resolveDriverNameForEvent(prevExisting) : undefined))
          : driverName;
        // A leg must ALWAYS end up with a real truck — the server
        // rejects a leg without one, and a blank card reads as
        // "unassigned" to the dispatcher. Order of preference: the
        // persisted leg's own truck, then a truck other than the
        // previous leg's, then the previous leg's, then the form's.
        const candidateAsset = existing?.assetId
          ?? assets.find(a => a.id !== prevAssetId)?.id
          ?? prevAssetId
          ?? assetId;
        const fallbackAsset = assets.some(a => a.id === candidateAsset)
          ? candidateAsset
          : (assets[0]?.id ?? candidateAsset);
        const resolvedAsset = edits.assetId ?? (isViewed ? assetId : fallbackAsset);
        // Driver: the leg's own, else that truck's preferred driver,
        // else carry the previous leg's driver rather than blanking.
        const fallbackDriver = existing
          ? resolveDriverNameForEvent(existing)
          : (preferredDriverName(resolvedAsset) || prevDriver || '');
        return {
          key,
          eventId: existing?.id,
          legIndex: i,
          assetId: resolvedAsset,
          driverName: edits.driverName ?? (isViewed ? driverName : fallbackDriver),
          pay: legPays[key] ?? (existing?.driverPay ?? ''),
          startIso: isViewed ? startDate : (existing?.start ?? legBoundaryTimes(i).start),
          miles: isViewed
            ? loadedMiles
            : (existing ? (existing.loadedMiles ?? otherLegMiles[existing.id] ?? draftLegMilesEstimate(i))
                        : draftLegMilesEstimate(i)),
          isViewed,
          isDraft: !existing,
          // A padded slot while the backfill is in flight is a leg we
          // haven't loaded yet, NOT a new one — render it as loading.
          // A slot the dispatcher just created (splitPlanAt mints a
          // `newleg:` key into the plan) is never padded, so it stays
          // immediately editable.
          isLoading: legsLoading && !existing && key.startsWith('pad:'),
        };
      });
    }
    // Create mode — legs are the form's own leg 0 plus the drafts.
    return [
      {
        key: 'leg0', legIndex: 0, assetId, driverName,
        pay: legPays['leg0'] ?? '', startIso: startDate,
        miles: draftLegMilesEstimate(0), isViewed: true,
      },
      ...draftLegs.map((d, i) => ({
        key: d.key, legIndex: i + 1, assetId: d.assetId, driverName: d.driverName,
        pay: legPays[d.key] ?? '',
        startIso: relayMarkersInStops[i]
          ? (handoffTimesOf(relayMarkersInStops[i]).pickup ?? handoffTimesOf(relayMarkersInStops[i]).drop)
          : undefined,
        miles: draftLegMilesEstimate(i + 1), isViewed: false, isDraft: true as const,
      })),
    ];
  })();
  // Handoff photos, tagged with the marker ordinal when the driver app
  // supplied one (null = legacy photo, shown on every handoff).
  const relayHandoffPhotos: RelayHandoffPhoto[] = loadDocuments
    .filter(d => d.kind === 'relay_handoff')
    .map(d => ({
      id: d.id,
      uploadedAt: d.uploadedAt,
      handoffIndex: (d as { handoffIndex?: number | null }).handoffIndex ?? null,
    }));
  // Marker i sits between relayLegViews[i] and [i+1].
  const relayHandoffViews: RelayHandoffView[] = isRelayContext
    ? relayMarkersInStops.map((stop, m) => ({
        stop,
        // In builder mode a boundary is "draft" until the save writes
        // it — i.e. when the leg it opens has no event yet.
        isDraft: isLegBuilder
          ? !relayLegViews[m + 1]?.eventId
          : (isExistingRelayLeg ? stop.id === pendingSplitStopId : true),
        keepEventId: relayLegViews[m]?.eventId,
        mergeEventId: relayLegViews[m + 1]?.eventId,
      }))
    : [];
  // Whole-haul miles for the Locations header: Σ every leg (viewed leg's
  // live computation + siblings' cached/computed values). null while any
  // leg is still unknown so the header shows "—" instead of a per-leg
  // number that makes the RPM look wrong.
  const relayTotalMilesForHeader: number | null = (() => {
    if (!isExistingRelayLeg || relayLegs.length < 2) return loadedMiles;
    if (loadedMiles == null) return null;
    let sum = loadedMiles;
    for (const leg of otherLegs) {
      const mi = leg.loadedMiles ?? otherLegMiles[leg.id];
      if (mi == null) return null;
      sum += mi;
    }
    return sum;
  })();

  // ── Relay totals — used to swap the regular Driver Pay slot for a
  // read-only "Total Driver Pay" tile when the modal is in relay context.
  const relayLp = typeof fieldValues['loadPrice'] === 'number'
    ? fieldValues['loadPrice']
    : parseFloat(String(fieldValues['loadPrice'] ?? '')) || 0;
  const relayTotalPay    = relayLegViews.reduce((sum, l) => sum + (typeof l.pay === 'number' ? l.pay : 0), 0);
  const relayTotalPct    = relayLp > 0 && relayTotalPay > 0
    ? Math.round((relayTotalPay / relayLp) * 1000) / 10
    : null;
  const relayTotalSuffix = relayTotalPct !== null ? (
    <span className="px-1.5 py-0.5 rounded-lg normal-case tracking-normal font-semibold"
      style={{ fontSize: 10, background: '#f1f3f4', color: 'var(--gc-text-3)', border: '1px solid var(--gc-border-light)' }}>
      {relayTotalPct % 1 === 0 ? relayTotalPct.toFixed(0) : relayTotalPct.toFixed(1)}%
    </span>
  ) : null;
  // Self-contained slot replacement: uses noLabelFields so this Field
  // (with its own "Total Driver Pay" label + % chip) takes over the
  // driverPay grid position, sitting next to Load Price.
  const relayTotalDisplay = (
    <Field label="Total Driver Pay" labelSuffix={relayTotalSuffix}>
      <div className="flex items-center w-full rounded-lg text-sm"
        style={{ border: '1px solid var(--gc-border)', padding: '8px 10px', background: 'var(--gc-bg)', color: 'var(--gc-text-1)', minHeight: 38 }}>
        {relayTotalPay > 0
          ? `$${relayTotalPay.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
      </div>
    </Field>
  );

  const dispatcherLabelSuffixes: Record<string, React.ReactNode> = {
    driverPay: isRelayContext ? relayTotalSuffix : driverPayLabelSuffix,
    loadNum: fieldValues['loadNum'] ? <CopyLabelBtn value={String(fieldValues['loadNum'])} /> : null,
  };

  // Non-relay driverPay override — when the driver's pay for this
  // week has been finalized, replace the generic input with a
  // disabled NumberInputWithDollar so the value can't drift from
  // what was paid out. The Finalized banner renders below.
  const soloDriverPayDisabled = !isRelayContext && soloFinalized.finalized;
  const soloDriverPayNumValue: number | '' = (() => {
    const raw = fieldValues['driverPay'];
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string' && raw.trim() !== '') {
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : '';
    }
    return '';
  })();
  const soloDriverPayOverride = soloDriverPayDisabled ? (
    <NumberInputWithDollar
      value={soloDriverPayNumValue}
      onChange={(v) => setField('driverPay', typeof v === 'number' ? v : '')}
      headerColor={headerColor}
      disabled
      disabledTitle="Locked — driver pay has been finalized for this week. Reopen the payroll record on the Payroll page to edit."
    />
  ) : null;

  const dispatcherFieldOverride: Record<string, React.ReactNode> = {
    ...(isRelayContext ? { driverPay: relayTotalDisplay } : (soloDriverPayOverride ? { driverPay: soloDriverPayOverride } : {})),
    refNums: (
      <RefNumsField
        value={Array.isArray(fieldValues['refNums']) ? fieldValues['refNums'] as RefNum[] : []}
        onChange={v => { markDirty(); setFieldValues(prev => ({ ...prev, refNums: v })); }}
        headerColor={headerColor}
        chipBg={LOAD_ACCENT_BG}
        chipBorder={LOAD_ACCENT_BORDER}
      />
    ),
    trailer: (
      <StyledSelect
        value={String(linkedTrailerId ?? '')}
        onChange={e => { markDirty(); setLinkedTrailerId(e.target.value ? Number(e.target.value) : undefined); }}
        style={{ ...iStyle, cursor: 'pointer' }}
        onFocus={focusH} onBlur={blurColor}>
        <option value="">— None —</option>
        {trailers
          .filter(t => isActiveOn(t, startDate) || t.id === linkedTrailerId)
          .map(t => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
      </StyledSelect>
    ),
    dispatcher: (
      <StyledSelect
        value={String(fieldValues['dispatcher'] ?? '')}
        onChange={e => { markDirty(); setField('dispatcher', e.target.value); }}
        style={{ ...iStyle, cursor: 'pointer' }}
        onFocus={focusH}
        onBlur={blurColor}
      >
        <option value="">— None —</option>
        {/* Soft-deleted (active=false) dispatchers hidden from the
            picker so they can't be assigned to new loads; the legacy
            loads.dispatcher text column still preserves their name
            on historical rows. */}
        {dispatchers.filter(d => d.active).map(d => {
          const fullName = `${d.firstName} ${d.lastName}`;
          return (
            <option key={d.id} value={fullName}>{fullName}{d.isDefault ? ' ★' : ''}</option>
          );
        })}
      </StyledSelect>
    ),
    broker: (
      <div className="space-y-2">
        <CustomerCombobox
          value={String(fieldValues['broker'] ?? '')}
          onChange={val => { markDirty(); setField('broker', val); setBrokerSaveBlocked(false); setBrokerMatch({ status: 'none' }); }}
          // Explicit dropdown pick → bind FK atomically. This is the
          // only path that GUARANTEES customerId reflects the chosen
          // customer regardless of what was there before. The sync
          // effect can also bind it on text changes, but it's conservative
          // about overwriting an existing FK; this callback isn't.
          onPick={(customer) => {
            markDirty();
            setFieldValues(prev => ({ ...prev, broker: customer.name, customerId: customer.id }));
            setBrokerSaveBlocked(false);
            setBrokerMatch({ status: 'none' });
          }}
          customers={customers}
          inputRef={brokerComboRef}
          accentColor={headerColor}
          onCreateNew={(name) => { setPendingNewBroker(name); }}
        />
        {(brokerMatch.status === 'confirm' || brokerMatch.status === 'new') && (
          <BrokerMatchBanner
            match={brokerMatch}
            onConfirmMatch={(customer) => {
              setField('broker', customer.name);
              setField('customerId', customer.id);
              const extracted = String(fieldValues['broker'] ?? '');
              if (extracted && extracted !== customer.name) void addCustomerAlias(customer.id, extracted);
              setBrokerMatch({ status: 'none' });
              setBrokerSaveBlocked(false);
            }}
            onRejectMatch={() => {
              if (brokerMatch.status === 'confirm') {
                setBrokerMatch({ status: 'new', extracted: String(fieldValues['broker'] ?? '') });
              } else {
                setBrokerMatch({ status: 'none' });
              }
            }}
            onCreateNew={(name) => { setPendingNewBroker(name); }}
            onFocusSearch={() => {
              setTimeout(() => brokerComboRef.current?.focus(), 50);
            }}
          />
        )}
        {(() => {
          // Read from the FK, NOT from broker-text equality. The badge
          // is meant to confirm "this load is linked to this customer
          // in the database" — basing it on text matching means the
          // badge can light up green for an unlinked load whose broker
          // text happens to equal a customer name, while the actual
          // customer_id stays NULL (or points somewhere else after a
          // re-pick that only updated broker text). That mismatch is
          // exactly the "showed as linked, wasn't actually linked" bug.
          const currentCid = fieldValues['customerId'] as string | undefined;
          const linkedCustomer = currentCid ? customers.find(c => c.id === currentCid) : undefined;
          if (!linkedCustomer) return null;
          return (
            <>
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
                <CheckCircle2 size={13} style={{ color: '#16a34a', flexShrink: 0 }} />
                <span style={{ fontSize: 12, color: '#15803d' }}>
                  Linked to <strong>{linkedCustomer.name}</strong>
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowBrokerProfile(true)}
                className="flex items-center gap-1.5 text-xs font-medium"
                style={{ color: LOAD_ACCENT, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                <ExternalLink size={12} /> View customer profile
              </button>
            </>
          );
        })()}
      </div>
    ),
  };

  const assetLabel = (a: { name: string; unit?: string } | null | undefined) =>
    a ? (a.unit ? `${a.name} - ${a.unit}` : a.name) : '—';

  return (
    <>
    {dupLoadNum && (
      <div className="fixed inset-0 z-[220] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
        <div className="rounded-2xl p-6 space-y-4" style={{ background: 'var(--gc-surface)', boxShadow: 'var(--shadow-3)', width: 380, border: '1px solid var(--gc-border-light)' }}>
          <div className="flex items-start gap-3">
            <div style={{ background: '#fffbeb', borderRadius: 10, padding: 8, flexShrink: 0 }}>
              <AlertCircle size={18} style={{ color: '#b45309' }} />
            </div>
            <div>
              <div className="text-base font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>Duplicate load number</div>
              <div className="text-sm" style={{ color: 'var(--gc-text-2)' }}>
                Load <strong style={{ color: 'var(--gc-text-1)' }}>#{dupLoadNum}</strong> already exists. Do you want to create another load with the same number?
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => {
                const which = pendingSave;
                setDupLoadNum(null); setPendingSave(null);
                if (which === 'single') void doSave();
                else if (which === 'batch') handleBatchSave();
              }}
              className="w-full py-2.5 rounded-xl text-sm font-semibold"
              style={{ background: '#b45309', color: '#fff', border: 'none', cursor: 'pointer' }}>
              Yes, create anyway
            </button>
            <button
              type="button"
              onClick={() => {
                const which = pendingSave;
                setDupLoadNum(null); setPendingSave(null);
                if (which === 'batch') {
                  if (batchIndex >= batchItems.length - 1) { clearBatch(); closeModal(); } else batchNext();
                } else {
                  closeModal();
                }
              }}
              className="w-full py-2.5 rounded-xl text-sm font-medium"
              style={{ background: 'var(--gc-hover)', color: 'var(--gc-text-1)', border: '1px solid var(--gc-border)', cursor: 'pointer' }}>
              No, disregard this load
            </button>
            <button
              type="button"
              onClick={() => { setDupLoadNum(null); setPendingSave(null); }}
              className="w-full py-2.5 rounded-xl text-sm"
              style={{ background: 'none', color: 'var(--gc-text-3)', border: 'none', cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    )}
    {geocodeBlock && (() => {
      const ungeocoded = stops.filter(s => s.geocodeStatus === 'failed');
      const which = geocodeBlock;
      return (
        <div className="fixed inset-0 z-[220] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div className="rounded-2xl p-6 space-y-4" style={{ background: 'var(--gc-surface)', boxShadow: 'var(--shadow-3)', width: 420, border: '1px solid var(--gc-border-light)' }}>
            <div className="flex items-start gap-3">
              <div style={{ background: '#fef2f2', borderRadius: 10, padding: 8, flexShrink: 0 }}>
                <AlertTriangle size={18} style={{ color: '#dc2626' }} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="text-base font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>
                  {ungeocoded.length === 1 ? '1 location not geocoded' : `${ungeocoded.length} locations not geocoded`}
                </div>
                <div className="text-sm" style={{ color: 'var(--gc-text-2)' }}>
                  These stops don&apos;t have map coordinates and won&apos;t appear on the route map or in distance calculations.
                </div>
                <ul className="mt-2 space-y-0.5">
                  {ungeocoded.map((s, i) => {
                    const idx = stops.indexOf(s);
                    const label = s.facilityName?.trim() || s.address?.trim() || `Stop ${idx + 1}`;
                    return (
                      <li key={s.id ?? i} className="text-xs" style={{ color: 'var(--gc-text-3)' }}>
                        · Stop {idx + 1}: {label}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setGeocodeBlock(null)}
                className="w-full py-2.5 rounded-xl text-sm font-semibold"
                style={{ background: 'var(--gc-blue)', color: '#fff', border: 'none', cursor: 'pointer' }}>
                Edit
              </button>
              <button
                type="button"
                onClick={() => {
                  setGeocodeBlock(null);
                  if (which === 'batch') handleBatchSave({ skipGeocodeCheck: true });
                  else void doSave({ skipGeocodeCheck: true });
                }}
                className="w-full py-2.5 rounded-xl text-sm font-medium"
                style={{ background: 'var(--gc-hover)', color: 'var(--gc-text-1)', border: '1px solid var(--gc-border)', cursor: 'pointer' }}>
                Ignore and save
              </button>
            </div>
          </div>
        </div>
      );
    })()}
    {brokerSaveBlocked && brokerMatch.status === 'new' && (
      <div className="fixed inset-0 z-[220] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
        <div className="rounded-2xl p-6 space-y-4" style={{ background: 'var(--gc-surface)', boxShadow: 'var(--shadow-3)', width: 380, border: '1px solid var(--gc-border-light)' }}>
          <div className="flex items-start gap-3">
            <div style={{ background: '#f0f9ff', borderRadius: 10, padding: 8, flexShrink: 0 }}>
              <Plus size={18} style={{ color: '#0369a1' }} />
            </div>
            <div>
              <div className="text-base font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>New customer detected</div>
              <div className="text-sm" style={{ color: 'var(--gc-text-2)' }}>
                <strong style={{ color: 'var(--gc-text-1)' }}>{brokerMatch.extracted}</strong>{' '}isn&apos;t in your customer list yet.
                Save them before saving this load.
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => {
                // Dismiss this prompt before opening the review modal —
                // both render via portal-style fixed overlays, and this
                // prompt sits at z-[220] vs the review modal's z-[210],
                // so leaving it mounted blocks all interaction with the
                // form behind it.
                setBrokerSaveBlocked(false);
                setPendingNewBroker(brokerMatch.extracted);
              }}
              className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl text-sm font-semibold"
              style={{ background: '#0369a1', color: '#fff', border: 'none', cursor: 'pointer' }}>
              <Plus size={14} /> Review and save
            </button>
            <button
              type="button"
              onClick={() => {
                setBrokerSaveBlocked(false);
                setTimeout(() => brokerComboRef.current?.focus(), 100);
              }}
              className="w-full py-2.5 rounded-xl text-sm font-medium"
              style={{ background: 'var(--gc-hover)', color: 'var(--gc-text-1)', border: '1px solid var(--gc-border)', cursor: 'pointer' }}>
              Search existing customers
            </button>
            <button
              type="button"
              onClick={() => {
                setBrokerMatch({ status: 'none' });
                setBrokerSaveBlocked(false);
                if (isBatch) handleBatchSave();
                else void doSave();
              }}
              className="w-full py-2.5 rounded-xl text-sm font-medium"
              style={{ background: 'transparent', color: 'var(--gc-text-3)', border: 'none', cursor: 'pointer' }}>
              Save without linking customer
            </button>
          </div>
        </div>
      </div>
    )}
    {pendingNewBroker !== null && (
      <NewBrokerReviewModal
        initialName={pendingNewBroker}
        // Pass the rate-con regardless of format — data URL (fresh
        // upload + parse), signed URL (re-opened load), or storage
        // path. The modal detects the format and resolves bytes on
        // click via fetch + bufferToBase64.
        rateConPdf={rateConPdf}
        pdfObjectUrl={pdfObjectUrl}
        onCancel={() => setPendingNewBroker(null)}
        onConfirm={confirmCreateBroker}
      />
    )}
    {showDocCloseConfirm && (
      <ConfirmDialog
        title="Discard pending document?"
        message="You picked a file but haven't chosen a type yet. Close anyway and lose the upload?"
        confirmLabel="Discard upload"
        cancelLabel="Keep editing"
        destructive
        zIndex={240}
        onCancel={() => setShowDocCloseConfirm(false)}
        onConfirm={() => {
          setShowDocCloseConfirm(false);
          setHasPendingDoc(false);
          if (isDirty) setShowSavePrompt(true);
          else closeModal();
        }}
      />
    )}
    {showSavePrompt && (
      <div className="fixed inset-0 z-[210] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.4)' }}>
        <div
          className="rounded-2xl p-6 space-y-4"
          style={{ background: 'var(--gc-surface)', boxShadow: 'var(--shadow-3)', width: 380, border: '1px solid var(--gc-border-light)' }}
        >
          <div>
            <div className="text-base font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>Save changes?</div>
            <div className="text-sm" style={{ color: 'var(--gc-text-2)' }}>You have unsaved changes to this load.</div>
          </div>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => {
                const navTarget = savePromptAfterNav;
                setShowSavePrompt(false); setSavePromptAfterNav(null);
                void doSave().then(() => { if (navTarget) openEditModal(navTarget); });
              }}
              className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-colors"
              style={{ background: 'var(--gc-blue)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-blue)')}>
              Yes, save changes
            </button>
            <button
              onClick={() => {
                const navTarget = savePromptAfterNav;
                setShowSavePrompt(false); setSavePromptAfterNav(null);
                closeModal();
                if (navTarget) openEditModal(navTarget);
              }}
              className="w-full px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
              style={{ border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)', background: 'transparent' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              No, discard changes
            </button>
            <button
              onClick={() => { setShowSavePrompt(false); setSavePromptAfterNav(null); }}
              className="w-full px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
              style={{ color: 'var(--gc-text-3)', background: 'transparent' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              Keep editing
            </button>
          </div>
        </div>
      </div>
    )}
    {/* z-[200] keeps the load detail modal above the closeout review
        queue (z-180) so the user can pop it open without losing their
        review-queue position. Sub-dialogs below stack at +10/+20.
        ui-scale-scope opts the modal into the user's Settings →
        Appearance → "Calendar card text" preference; --ui-scale is
        consumed by the text utility overrides in globals.css. */}
    <div className="ui-scale-scope fixed inset-0 z-[200] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.36)', ['--ui-scale' as keyof React.CSSProperties]: cardFontScale ?? 1 } as React.CSSProperties}
      onMouseDown={e => { if (e.target === e.currentTarget) handleBackdropClick(); }}>
      <div className="flex"
        style={{
          width: ((showPdfViewer && canViewRateCon) || showMapPanel || showDriverSummary) ? '96vw' : '100%',
          maxWidth: ((showPdfViewer && canViewRateCon) || showMapPanel)
            ? (showDriverSummary ? 2180 : 1800)
            : (showDriverSummary ? 1400 : 1020),
          height: '92vh',
          borderRadius: 14,
          boxShadow: 'var(--shadow-3)',
          overflow: 'hidden',
          background: 'var(--gc-surface)',
          transition: 'max-width 250ms ease, width 250ms ease',
        }}>

        {/* ── Map pane (left, split mode only) ── */}
        {showMapPanel && !showPdfViewer && (
          <RouteMapPanel
            stops={stops}
            onClose={() => setShowMapPanel(false)}
            motiveVehicleId={assets.find(a => a.id === assetId)?.motiveVehicleId}
          />
        )}

        {/* ── PDF pane (left, split mode only) ── */}
        {showPdfViewer && canViewRateCon && (
          <div className="flex flex-col shrink-0" style={{ width: '44%', borderRight: '1px solid var(--gc-border)', background: 'var(--gc-bg)' }}>
            <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-2 flex-nowrap" style={{ borderBottom: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
              <div className="flex items-center gap-1 flex-nowrap min-w-0">
                <button type="button" onClick={() => { setDocsTab('rateCon'); setSelectedDocId(null); }}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap"
                  style={docsTab === 'rateCon'
                    ? { background: LOAD_ACCENT_BG, color: LOAD_ACCENT, border: `1px solid ${LOAD_ACCENT_BORDER}` }
                    : { color: 'var(--gc-text-3)', border: '1px solid transparent' }}>
                  <FileText size={13} /> Rate Con{rateConPdf ? '' : ' (none)'}
                </button>
                <button type="button" onClick={() => setDocsTab('uploaded')}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap"
                  style={docsTab === 'uploaded'
                    ? { background: LOAD_ACCENT_BG, color: LOAD_ACCENT, border: `1px solid ${LOAD_ACCENT_BORDER}` }
                    : { color: 'var(--gc-text-3)', border: '1px solid transparent' }}>
                  {(() => {
                    // Count = non-rate-cons + legacy rate-cons + invoices.
                    // The current primary rate-con (most recent kind=rate_con
                    // upload) lives in the Rate Con tab and isn't double-counted.
                    const rcs = loadDocuments.filter(d => d.kind === 'rate_con');
                    const primaryId = rcs.length === 0
                      ? undefined
                      : [...rcs].sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1))[0].id;
                    const visible = loadDocuments.filter(d =>
                      d.kind !== 'rate_con' || d.id !== primaryId,
                    );
                    return `Uploaded (${visible.length + loadInvoices.length})`;
                  })()}
                </button>
              </div>
              <div className="flex items-center gap-1 flex-nowrap shrink-0">
                {/* Rate-con-specific action buttons. Reparse / Replace /
                 *  Delete only make sense when a rate con actually exists;
                 *  hide them otherwise so the empty state's inline
                 *  "+ Add Rate Con" CTA is the single obvious action. */}
                {docsTab === 'rateCon' && rateConPdf && (<>
                <Tooltip content="Pull just the Load # and reference numbers off this rate-con (existing fields stay intact)">
                  <button type="button" onClick={() => void handleQuickReparse()} disabled={reparsing}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap"
                    style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border-light)', opacity: reparsing ? 0.6 : 1 }}
                    onMouseEnter={e => { if (!reparsing) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    {reparsing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                    {reparsing ? 'Parsing…' : 'Get Load #'}
                  </button>
                </Tooltip>
                <Tooltip content="Re-extract every field from this rate-con (overwrites current values)">
                  <button type="button" onClick={() => void handleFullReparse()} disabled={reparsing}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap"
                    style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border-light)', opacity: reparsing ? 0.6 : 1 }}
                    onMouseEnter={e => { if (!reparsing) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <RefreshCw size={11} /> Reparse
                  </button>
                </Tooltip>
                {pdfObjectUrl && (
                  <Tooltip content="Download Rate Con">
                    <button
                      type="button"
                      // Browsers ignore the <a download> attribute on
                      // cross-origin URLs (Supabase signed URL), so
                      // clicking the link just navigated to a viewer
                      // tab instead of downloading. Fetch the bytes
                      // into a blob, mint an object URL, and click a
                      // hidden anchor with the right filename — that
                      // forces a true download every time.
                      onClick={async () => {
                        try {
                          const res = await fetch(pdfObjectUrl);
                          const blob = await res.blob();
                          const objectUrl = URL.createObjectURL(blob);
                          const safeNum = String(
                            (events.find(e => e.id === modalEventId)?.loadNum)
                            ?? (fieldValues['loadNum'] ?? '')
                          ).replace(/[^A-Za-z0-9_-]/g, '');
                          const a = document.createElement('a');
                          a.href = objectUrl;
                          a.download = safeNum ? `${safeNum}_RATE_CON.pdf` : 'rate-con.pdf';
                          document.body.appendChild(a);
                          a.click();
                          a.remove();
                          // Revoke after a tick so the browser has
                          // started the download before the URL dies.
                          setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
                        } catch (err) {
                          console.error('[rate-con] download failed', err);
                          // Fallback: open the signed URL in a new
                          // tab so the user can save from there.
                          window.open(pdfObjectUrl, '_blank', 'noopener');
                        }
                      }}
                      className="flex items-center justify-center w-7 h-7 rounded-lg transition-colors"
                      style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border-light)', background: 'transparent' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <Download size={12} />
                    </button>
                  </Tooltip>
                )}
                <Tooltip content="Replace Rate Con">
                  <button type="button" onClick={() => attachFileInputRef.current?.click()}
                    className="flex items-center justify-center w-7 h-7 rounded-lg transition-colors"
                    style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border-light)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <Paperclip size={12} />
                  </button>
                </Tooltip>
                <Tooltip content={confirmRemoveRateCon ? 'Click again to confirm' : 'Delete Rate Con'}>
                  <button type="button"
                    onClick={() => {
                      if (!confirmRemoveRateCon) { setConfirmRemoveRateCon(true); return; }
                      setRateConPdf(undefined); setShowPdfViewer(false); setConfirmRemoveRateCon(false); markDirty();
                    }}
                    className={`flex items-center justify-center rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${confirmRemoveRateCon ? 'px-2.5 h-7' : 'w-7 h-7'}`}
                    style={confirmRemoveRateCon
                      ? { background: '#d93025', color: 'white', border: '1px solid #d93025' }
                      : { color: '#d93025', border: '1px solid var(--gc-border-light)' }}
                    onMouseEnter={e => { if (!confirmRemoveRateCon) { e.currentTarget.style.background = 'rgba(217,48,37,.08)'; e.currentTarget.style.borderColor = '#d93025'; } }}
                    onMouseLeave={e => { if (!confirmRemoveRateCon) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'var(--gc-border-light)'; } }}>
                    {confirmRemoveRateCon ? 'Confirm?' : <Trash2 size={12} />}
                  </button>
                </Tooltip>
                </>)}
                <button onClick={() => setShowPdfViewer(false)} title="Close PDF viewer"
                  className="p-1.5 rounded-full transition-colors" style={{ color: 'var(--gc-text-3)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <X size={15} />
                </button>
              </div>
            </div>
            {docsTab === 'rateCon' ? (
              rateConPdf
                ? <PdfCanvas dataUrl={pdfObjectUrl} onRetry={() => setPdfRetryKey(k => k + 1)} />
                : (
                  // Empty state — matches the Uploaded tab convention
                  // (centered hint copy + a single "Add" CTA). Tapping the
                  // button triggers the same hidden <input> the header
                  // Replace button uses; the existing change handler
                  // routes to POST /v1/loads/:id/documents with
                  // kind='rate_con' (and mirrors onto loads.rate_con_pdf).
                  <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center" style={{ background: 'var(--gc-bg)' }}>
                    <div className="flex items-center justify-center" style={{ width: 56, height: 56, borderRadius: 14, background: `${headerColor}15`, color: headerColor }}>
                      <FileText size={26} />
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--gc-text-2)' }}>
                      No Rate Con uploaded for this load yet
                    </div>
                    <button type="button" onClick={() => attachFileInputRef.current?.click()}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all"
                      style={{ color: 'white', background: headerColor, border: `1px solid ${headerColor}` }}
                      onMouseEnter={e => (e.currentTarget.style.opacity = '0.9')}
                      onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
                      <Plus size={14} /> Add Rate Con
                    </button>
                  </div>
                )
            ) : (() => {
              // Compute which rate-cons are "legacy" — every kind='rate_con'
              // row except the primary (most recent uploadedAt). Replace
              // Rate Con uploads now preserve the prior file as a load
              // document, so historical rate-cons live in the Documents
              // panel with a "Legacy" tag while the current primary stays
              // alone on the Rate Con tab.
              const rateCons = loadDocuments.filter(d => d.kind === 'rate_con');
              const primaryRateConId = rateCons.length === 0
                ? undefined
                : [...rateCons].sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1))[0].id;
              const legacyRateConIds = new Set(
                rateCons.filter(d => d.id !== primaryRateConId).map(d => d.id),
              );
              return (
              <UploadedDocsPanel
                // Rate cons: the *current primary* (the file shown in
                // the Rate Con tab + sent with the invoice) is hidden
                // from this list to keep the two tabs disjoint. Older
                // rate-cons surface here with a "Legacy" tag so the
                // dispatcher can find historical versions.
                docs={loadDocuments.filter(d => d.kind !== 'rate_con' || legacyRateConIds.has(d.id))}
                legacyDocIds={legacyRateConIds}
                invoices={loadInvoices}
                selectedId={selectedDocId}
                onSelect={setSelectedDocId}
                signedUrl={selectedDocUrl}
                onSignedUrlError={refreshSelectedDocUrl}
                headerColor={headerColor}
                loadId={(() => {
                  const ev = events.find(e => e.id === modalEventId);
                  return ev?.loadId;
                })()}
                onChange={async () => {
                  // Re-fetch the docs list after add/delete.
                  const ev = events.find(e => e.id === modalEventId);
                  if (!ev?.loadId || !orgId) return;
                  const { fetchLoadDocuments } = await import('@/lib/db');
                  const fresh = await fetchLoadDocuments(ev.loadId, orgId);
                  setLoadDocuments(fresh);
                }}
                onPendingChange={setHasPendingDoc}
              />
              );
            })()}
          </div>
        )}

        {/* ── Form pane (right, or full width when no PDF) ── */}
        <div className="flex flex-col flex-1 min-w-0" style={{ overflow: 'hidden', position: 'relative' }}
          onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer.types.includes('Files')) setIsDragOver(true); }}
          onDragLeave={e => { e.preventDefault(); if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false); }}
          onDrop={e => { e.preventDefault(); e.stopPropagation(); setIsDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleDroppedFile(f); }}>

          {/* Drop overlay */}
          {isDragOver && (
            <div className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none rounded-r-[14px]"
              style={{ background: `${headerColor}18`, border: `2px dashed ${headerColor}` }}>
              <div className="flex flex-col items-center gap-2">
                <FileText size={32} style={{ color: headerColor }} />
                <span className="text-base font-semibold" style={{ color: headerColor }}>Drop PDF to attach</span>
              </div>
            </div>
          )}

        {/* ── Conflict banner ── */}
        {modalConflict === 'deleted' && (
          <div className="shrink-0 flex items-center justify-between px-6 py-3 gap-3"
            style={{ background: '#fef2f2', borderBottom: '1px solid #fca5a5' }}>
            <div className="flex items-center gap-2">
              <AlertTriangle size={15} style={{ color: '#dc2626', flexShrink: 0 }} />
              <span className="text-sm font-medium" style={{ color: '#991b1b' }}>
                This load was deleted by another dispatcher.
              </span>
            </div>
            <button type="button" onClick={() => closeModal()}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
              style={{ background: '#dc2626', color: 'white', border: 'none', cursor: 'pointer' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#b91c1c')}
              onMouseLeave={e => (e.currentTarget.style.background = '#dc2626')}>
              Close
            </button>
          </div>
        )}
        {modalConflict === 'updated' && (
          <div className="shrink-0 flex items-center justify-between px-6 py-3 gap-3"
            style={{ background: '#eff6ff', borderBottom: '1px solid #93c5fd' }}>
            <div className="flex items-center gap-2">
              <RefreshCw size={14} style={{ color: '#2563eb', flexShrink: 0 }} />
              <span className="text-sm font-medium" style={{ color: '#1e40af' }}>
                This load was updated by another dispatcher.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button type="button"
                onClick={() => {
                  const ev = useCalendarStore.getState().events.find(e => e.id === modalEventId) ?? useCalendarStore.getState().deletedEvents.find(e => e.id === modalEventId);
                  if (ev) reinitForm(ev);
                  clearModalConflict();
                }}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                style={{ background: '#2563eb', color: 'white', border: 'none', cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#1d4ed8')}
                onMouseLeave={e => (e.currentTarget.style.background = '#2563eb')}>
                <RefreshCw size={11} /> Reload
              </button>
              <button type="button" onClick={clearModalConflict}
                className="p-1 rounded-full transition-colors"
                style={{ color: '#2563eb', background: 'transparent', border: 'none', cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#dbeafe')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <X size={14} />
              </button>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-8 py-5"
          style={{ background: `${headerColor}16`, borderBottom: `3px solid ${headerColor}` }}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: headerColor }}>
              <Calendar size={17} color="white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: headerColor }}>
                  {isBatch ? `Create Load ${batchIndex + 1} of ${batchItems.length}` : isEdit ? (eventKind === 'non_revenue' ? 'Edit Event' : 'Edit Load') : (eventKind === 'non_revenue' ? 'New Event' : 'New Load')}
                </div>
                {isEdit && (() => {
                  const ev = events.find(e => e.id === modalEventId);
                  if (!ev?.internalLoadId) return null;
                  return (
                    <>
                      <Tooltip content={loadIdCopied ? 'Copied!' : 'Click to copy load ID'}>
                        <button
                          type="button"
                          onClick={() => {
                            const idStr = String(ev.internalLoadId);
                            if (navigator.clipboard?.writeText) {
                              void navigator.clipboard.writeText(idStr);
                            }
                            setLoadIdCopied(true);
                            setTimeout(() => setLoadIdCopied(false), 1500);
                          }}
                          className="flex items-center gap-1 transition-colors"
                          style={{
                            fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
                            padding: '2px 8px', borderRadius: 8,
                            background: loadIdCopied ? '#dcfce7' : `${headerColor}20`,
                            color: loadIdCopied ? '#15803d' : headerColor,
                            border: `1px solid ${loadIdCopied ? '#86efac' : `${headerColor}40`}`,
                            fontVariantNumeric: 'tabular-nums', cursor: 'pointer',
                          }}
                          onMouseEnter={e => { if (!loadIdCopied) e.currentTarget.style.background = `${headerColor}30`; }}
                          onMouseLeave={e => { if (!loadIdCopied) e.currentTarget.style.background = `${headerColor}20`; }}
                        >
                          #{ev.internalLoadId}
                          {loadIdCopied
                            ? <CheckCircle2 size={10} />
                            : <Copy size={10} style={{ opacity: 0.7 }} />}
                        </button>
                      </Tooltip>
                      {ev.loadId && (
                        <Tooltip content="Open load detail page">
                          <button
                            type="button"
                            onClick={() => {
                              // Close the modal before navigating so the
                              // page mounts cleanly. Slug is the
                              // internal_load_id (the "#10761" the
                              // dispatcher already knows) so the URL is
                              // human-readable: /loads/10761.
                              const targetId = ev.internalLoadId;
                              closeModal();
                              router.push(`/loads/${targetId}`);
                            }}
                            className="flex items-center justify-center transition-colors"
                            style={{
                              width: 22, height: 22, borderRadius: 6,
                              background: `${headerColor}20`,
                              color: headerColor,
                              border: `1px solid ${headerColor}40`,
                              cursor: 'pointer',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background = `${headerColor}30`; }}
                            onMouseLeave={e => { e.currentTarget.style.background = `${headerColor}20`; }}
                          >
                            <ExternalLink size={11} />
                          </button>
                        </Tooltip>
                      )}
                    </>
                  );
                })()}
                {isExistingRelayLeg && viewedLegIdx != null && (
                  <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-lg"
                    style={{ background: RELAY_COLOR, color: 'white' }}>
                    ⇄ {legLabel(viewedLegIdx, Math.max(relayLegViews.length, currentEv?.legCount ?? 2)) || 'Relay Leg'}
                  </span>
                )}
                {/* Cancelled-state pill. Picks up both cancel modes
                    so a 'remove-event' cancel reopened from accounting
                    no longer looks like an active load. The wording
                    differs slightly so the dispatcher can tell at a
                    glance which mode they're in. */}
                {isCancelled && (
                  <span className="flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5"
                    style={{
                      background: '#fee2e2', color: '#991b1b',
                      border: '1px solid #fca5a5', borderRadius: 999,
                    }}
                    title={isRemovedEventCancelled
                      ? 'Removed from calendar — load kept for accounting. Reinstate to restore.'
                      : 'Marked cancelled on the calendar. Reinstate to restore.'}>
                    <AlertTriangle size={10} />
                    {isRemovedEventCancelled ? 'Removed from Calendar' : 'Cancelled'}
                  </span>
                )}
                {/* Confirmation visibility lives in the driver row
                    (next to the phone-copy / Driver Summary buttons),
                    not in this header, so we don't double up. */}
              </div>
              <div className="flex items-center gap-2 flex-wrap text-[13px]" style={{ color: 'var(--gc-text-2)' }}>
                <span>
                  {selectedAsset?.name ?? 'Select truck'}
                  {selectedAsset?.unit ? ` · #${selectedAsset.unit}` : ''}
                  {selectedAsset?.truck ? ` · ${selectedAsset.truck}` : ''}
                </span>
                {/* Hide the ELD location subtitle when any side panel is
                    open — Map/Docs/DriverSummary all narrow the header
                    and the "20.9 mi NW of Holden, UT · 2m ago" line
                    forced the title block to wrap into two rows. The
                    truck's live position is already visible in the Map
                    panel itself; suppressing it here keeps the header
                    a single row. */}
                {truckLoc && !showPdfViewer && !showMapPanel && !showDriverSummary && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--gc-text-3)' }}>
                    <span style={{ opacity: 0.4 }}>·</span>
                    <MapPin size={10} style={{ flexShrink: 0 }} />
                    {truckLoc.description}
                    <span style={{ opacity: 0.6 }}>· {timeAgoModal(truckLoc.locatedAt)}</span>
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isEdit && modalEventId && (() => {
              const isRefreshing = refetchingEventIds.has(modalEventId);
              return (
                <Tooltip content={isRefreshing ? 'Refreshing…' : 'Refresh this load from server'}>
                  <button
                    type="button"
                    disabled={isRefreshing}
                    onClick={() => {
                      void refetchEvent(modalEventId).then(() => {
                        // After the refetch lands, re-seed the form from the
                        // freshly cached event so the modal reflects the
                        // newly populated stops without forcing a close+reopen.
                        const ev = useCalendarStore.getState().events.find(e => e.id === modalEventId) ?? useCalendarStore.getState().deletedEvents.find(e => e.id === modalEventId);
                        if (ev) reinitForm(ev);
                      });
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px',
                      borderRadius: 8, border: `1px solid ${headerColor}40`,
                      background: `${headerColor}10`,
                      cursor: isRefreshing ? 'wait' : 'pointer',
                      opacity: isRefreshing ? 0.6 : 1,
                      transition: 'all 150ms',
                    }}
                    onMouseEnter={e => { if (!isRefreshing) e.currentTarget.style.background = `${headerColor}20`; }}
                    onMouseLeave={e => { if (!isRefreshing) e.currentTarget.style.background = `${headerColor}10`; }}
                  >
                    <RefreshCw
                      size={13}
                      style={{
                        color: headerColor,
                        animation: isRefreshing ? 'spin 0.8s linear infinite' : 'none',
                      }}
                    />
                  </button>
                </Tooltip>
              );
            })()}
            <Tooltip content={priority ? 'Remove Priority' : 'Mark as Priority'}>
              <button
                type="button"
                onClick={() => { markDirty(); setPriority(p => !p); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px',
                  borderRadius: 8, border: priority ? '1px solid #f59e0b' : `1px solid ${headerColor}40`,
                  background: priority ? '#fef3c7' : `${headerColor}10`,
                  cursor: 'pointer', transition: 'all 150ms',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = priority ? '#fde68a' : `${headerColor}20`; }}
                onMouseLeave={e => { e.currentTarget.style.background = priority ? '#fef3c7' : `${headerColor}10`; }}
              >
                <Star size={13} fill={priority ? '#f59e0b' : 'none'} style={{ color: priority ? '#f59e0b' : headerColor }} />
                {priority && <span style={{ fontSize: 12, fontWeight: 700, color: '#92400e' }}>Priority</span>}
              </button>
            </Tooltip>
            {eventKind === 'revenue' && (
              <StyledSelect value={status} onChange={e => { markDirty(); setStatus(e.target.value as EventStatus); }}
                style={{
                  border: `1px solid ${STATUSES.find(s => s.value === status)?.color ?? headerColor}50`,
                  borderRadius: 8, padding: '6px 32px 6px 12px', fontSize: 13, fontWeight: 600,
                  color: STATUSES.find(s => s.value === status)?.color ?? headerColor,
                  background: STATUSES.find(s => s.value === status)?.bg ?? `${headerColor}12`,
                  outline: 'none', cursor: 'pointer', width: 'auto', transition: 'border-color 150ms',
                }}>
                {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </StyledSelect>
            )}
            {eventKind === 'revenue' && stops.length >= 2 && stops.some(s => s.geocodeStatus === 'success') && (
              <button type="button" onClick={() => { setShowMapPanel(v => !v); setShowPdfViewer(false); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap"
                style={{ color: headerColor, border: `1px solid ${headerColor}50`, background: showMapPanel ? `${headerColor}22` : `${headerColor}12` }}
                onMouseEnter={e => (e.currentTarget.style.background = `${headerColor}22`)}
                onMouseLeave={e => (e.currentTarget.style.background = showMapPanel ? `${headerColor}22` : `${headerColor}12`)}>
                <MapPin size={13} /> {showMapPanel ? 'Hide' : 'Map'}
              </button>
            )}
            {eventKind === 'revenue' && (() => {
              // "View Docs" if ANYTHING is attached — rate con OR any
              // other uploaded doc. "Add Docs" only when both buckets
              // are empty.
              //
              // Source of truth: `event.documentCounts` — a per-kind
              // count aggregated server-side and joined onto the load
              // payload, so it's reliably present the moment the modal
              // opens. We were previously reading from `loadDocuments`,
              // which is a deferred fetch that doesn't fire until the
              // docs viewer is opened — that made the button show
              // "Add Docs" even when a POD existed, because the array
              // was still empty. `loadDocuments` is used as a fallback
              // for the rare case `documentCounts` is missing.
              const evCur = events.find(e => e.id === modalEventId);
              const countsTotal = evCur?.documentCounts
                ? Object.entries(evCur.documentCounts)
                    .filter(([k]) => k !== 'rate_con')
                    .reduce((sum, [, n]) => sum + (n || 0), 0)
                : null;
              const otherDocsCount = countsTotal != null
                ? countsTotal
                : loadDocuments.filter(d => d.kind !== 'rate_con').length;
              const hasAnything = !!rateConPdf || otherDocsCount > 0;
              // Default tab on open: Rate Con if one exists, otherwise
              // Uploaded so the dispatcher lands on the docs that DO
              // exist instead of an empty Rate Con tab.
              const openTab: 'rateCon' | 'uploaded' = rateConPdf ? 'rateCon' : 'uploaded';
              if (hasAnything) {
                return (
                  <button type="button" onClick={() => { setShowPdfViewer(v => !v); setShowMapPanel(false); setDocsTab(openTab); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap"
                    style={{ color: headerColor, border: `1px solid ${headerColor}50`, background: showPdfViewer ? `${headerColor}22` : `${headerColor}12` }}
                    onMouseEnter={e => (e.currentTarget.style.background = `${headerColor}22`)}
                    onMouseLeave={e => (e.currentTarget.style.background = showPdfViewer ? `${headerColor}22` : `${headerColor}12`)}>
                    <Eye size={13} /> {showPdfViewer ? 'Hide' : 'Docs'}
                  </button>
                );
              }
              // No docs at all — opens the docs viewer (Rate Con tab
              // default) where the user can either add a rate con or
              // tab over to Uploaded and add other docs.
              return (
                <button type="button" onClick={() => { setShowPdfViewer(v => !v); setShowMapPanel(false); setDocsTab('rateCon'); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap"
                  style={{ color: 'var(--gc-text-3)', border: '1px solid var(--gc-border-light)' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; e.currentTarget.style.color = 'var(--gc-text-2)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}>
                  <Paperclip size={13} /> {showPdfViewer ? 'Hide' : 'Add Docs'}
                </button>
              );
            })()}
            <button onClick={isBatch ? () => { clearBatch(); closeModal(); } : attemptClose} className="p-2 rounded-full transition-colors"
              style={{ color: 'var(--gc-text-2)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover-strong)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSave} className="flex flex-col overflow-y-auto flex-1"
          onKeyDown={e => { if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) e.preventDefault(); }}>
          {/* Read-only banner — shown when the role can view this
              record but lacks the edit cap (maintenance opening a
              revenue load is the canonical case). The fieldset below
              disables every input/select/textarea/button inside the
              form body, including all stop inputs and inline saves
              that bypass doSave. The Save button is hidden separately
              in the footer. */}
          {isReadOnly && (
            <div style={{
              padding: '10px 32px',
              background: '#fef3c7',
              borderBottom: '1px solid #fde68a',
              color: '#92400e',
              fontSize: 13,
              fontWeight: 600,
            }}>
              Read-only — your role can view this {eventKind === 'revenue' ? 'load' : 'event'} but can&apos;t make changes. Contact an admin if you need edit access.
            </div>
          )}
          <fieldset disabled={isReadOnly} style={{ border: 'none', padding: 0, margin: 0, minWidth: 0, display: 'flex', flexDirection: 'column', flex: 1 }}>
          <div className="px-8 py-6 space-y-5 flex-1">

            {/* Hidden file inputs */}
            <input ref={fileInputRef} type="file" accept=".pdf,application/pdf" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleParseFile(f); e.target.value = ''; }} />
            <input ref={attachFileInputRef} type="file" accept=".pdf,application/pdf,image/*" style={{ display: 'none' }}
              onChange={async e => {
                const f = e.target.files?.[0]; if (!f) return;
                e.target.value = '';
                const ev = modalEventId ? events.find(x => x.id === modalEventId) : undefined;
                // Create mode: stage as base64 — no load exists to
                // upload to yet, so we hold the new rate-con in local
                // state until the user clicks Create / Save.
                if (!ev?.loadId) {
                  const reader = new FileReader();
                  reader.onload = () => { markDirty(); setRateConPdf(reader.result as string); };
                  reader.readAsDataURL(f);
                  return;
                }
                // Edit mode: route through POST /v1/loads/:id/documents
                // with kind=rate_con. The API mirrors the new storage
                // path onto loads.rate_con_pdf so this becomes the
                // active rate-con; the previous one is preserved as a
                // kind=rate_con row in load_documents (history).
                try {
                  const { railway } = await import('@/lib/railway');
                  // Suppress the "another dispatcher" banner on our own
                  // realtime echo (the API mirrors the doc onto
                  // loads.rate_con_pdf, which bounces back through realtime).
                  useCalendarStore.getState().markLoadSelfWrite(ev.loadId);
                  await railway.uploadLoadDocument(ev.loadId, f, 'rate_con');
                  // Refresh: pull the updated load + events back into
                  // the calendar store, then sync the new path into
                  // local state directly. The state-reset effect's
                  // deps are [modalOpen, modalEventId, batchIndex] —
                  // it does NOT re-fire on events change — so we must
                  // setRateConPdf here ourselves.
                  const { loads: legs } = await railway.getLoad(ev.loadId);
                  mergeEvents(legs as CalendarEvent[]);
                  const updatedLeg =
                    (legs as CalendarEvent[]).find(l => l.id === modalEventId)
                    ?? (legs as CalendarEvent[])[0];
                  if (updatedLeg?.rateConPdf) {
                    setRateConPdf(updatedLeg.rateConPdf);
                    // Server is the source of truth post-split — reset
                    // the baseline so the next save doesn't try to
                    // re-write the rate con back to whatever we had
                    // before fetching.
                    setRateConOriginal(updatedLeg.rateConPdf);
                    setShowPdfViewer(true);
                    setDocsTab('rateCon');
                    setPdfRetryKey(k => k + 1);
                  }
                  // Also refresh the Uploaded docs tab so the new
                  // rate-con shows up there as a kind=rate_con entry.
                  if (orgId) {
                    const { fetchLoadDocuments } = await import('@/lib/db');
                    const fresh = await fetchLoadDocuments(ev.loadId, orgId);
                    setLoadDocuments(fresh);
                  }
                } catch (err) {
                  console.error('[EventModal] rate-con upload failed:', err);
                  alert(`Upload failed: ${(err as Error).message ?? 'Unknown error'}`);
                }
              }} />

            {/* Event kind toggle + closeout billing badge + Review jump.
                Three-column flex: empty spacer (left) keeps the toggle
                visually centered while the billing pill + Review button
                anchor to the right corner of the same row. */}
            <div className="flex items-center pb-3 gap-2">
              <div className="flex-1" />
              <div className="flex items-center gap-2">
                {(['revenue', 'non_revenue'] as const).map(kind => {
                  // Disable Revenue for users who lack loads.create (e.g.
                  // Maintenance role) — they can only make non-revenue
                  // events and the API would 403 a revenue submit anyway.
                  const blockedByPerm = !isEdit && kind === 'revenue' && !canCreateRevenue;
                  const disabled = isEdit || blockedByPerm;
                  const hidden   = blockedByPerm && eventKind !== 'revenue';
                  if (hidden) return null;
                  return (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => { if (!disabled) setEventKind(kind); }}
                      disabled={disabled}
                      title={blockedByPerm ? 'Your role can only create non-revenue events' : undefined}
                      className="text-xs px-3 py-1.5 rounded-lg font-medium"
                      style={{
                        background: eventKind === kind ? (kind === 'revenue' ? 'var(--gc-blue)' : '#7c3aed') : 'var(--gc-hover)',
                        color: eventKind === kind ? '#fff' : 'var(--gc-text-2)',
                        cursor: disabled ? 'default' : 'pointer',
                        opacity: disabled && eventKind !== kind ? 0.35 : 1,
                        transition: disabled ? 'none' : 'colors 150ms',
                      }}
                    >
                      {kind === 'revenue' ? 'Revenue' : 'Non-Revenue'}
                    </button>
                  );
                })}
              </div>
              <div className="flex-1 flex items-center justify-end gap-2">
                {eventKind === 'revenue' && isEdit && (() => {
                  const ev = events.find(e => e.id === modalEventId);
                  if (!ev) return null;
                  const bs = ev.billingStatus;
                  const bsTint = (() => {
                    switch (bs) {
                      case 'pending':   return { bg: '#fef3c7', fg: '#92400e', label: 'Pending' };
                      case 'on_hold':   return { bg: '#fee2e2', fg: '#991b1b', label: 'Flagged' };
                      case 'verified':  return { bg: '#dbeafe', fg: '#1e40af', label: 'Released' };
                      case 'invoiced':  return { bg: '#dcfce7', fg: '#15803d', label: 'Invoiced' };
                      case 'paid':      return { bg: '#d1fae5', fg: '#065f46', label: 'Paid' };
                      default:          return { bg: 'var(--gc-border-light)', fg: 'var(--gc-text-3)', label: '—' };
                    }
                  })();
                  return (
                    <>
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg whitespace-nowrap"
                        title={`Billing: ${bsTint.label}`}
                        style={{ background: bsTint.bg, color: bsTint.fg, border: `1px solid ${bsTint.fg}30` }}>
                        Billing: {bsTint.label}
                      </span>
                      <button type="button" onClick={() => setReviewQueueOpen(true)}
                        className="flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-lg transition-colors"
                        title="Open the closeout review panel for this load"
                        style={{ background: '#15803d', color: '#fff' }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#166534')}
                        onMouseLeave={e => (e.currentTarget.style.background = '#15803d')}>
                        <Play size={10} fill="currentColor" /> Review
                      </button>
                    </>
                  );
                })()}
              </div>
            </div>

            {/* AI disclaimer for batch parse */}
            {isBatch && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg" style={{ background: '#fffbeb', border: '1px solid #fcd34d' }}>
                <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1, color: '#b45309' }} />
                <span style={{ fontSize: 12, color: '#92400e', lineHeight: 1.4 }}>AI extraction may contain errors — always review all fields before saving.</span>
              </div>
            )}

            {/* PDF Rate Con Parser (create mode only, not in batch, revenue only) */}
            {!isEdit && !isBatch && eventKind === 'revenue' && (
              <div>
                {parseState === 'idle' && (
                  <div className="space-y-2">
                    <button type="button" onClick={() => fileInputRef.current?.click()}
                      className="w-full flex flex-col items-center justify-center gap-2 py-6 rounded-2xl border-2 border-dashed transition-all"
                      style={{ borderColor: headerColor, background: `${headerColor}08` }}
                      onMouseEnter={e => { e.currentTarget.style.background = `${headerColor}14`; e.currentTarget.style.boxShadow = 'var(--shadow-1)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = `${headerColor}08`; e.currentTarget.style.boxShadow = 'none'; }}>
                      <FileText size={28} style={{ color: headerColor }} />
                      <div className="text-center">
                        <div className="text-base font-semibold" style={{ color: headerColor }}>Parse Rate Con PDF</div>
                        <div className="text-sm mt-0.5" style={{ color: 'var(--gc-text-2)' }}>AI extracts all load details automatically</div>
                      </div>
                    </button>
                    <div className="flex items-start gap-2 px-3 py-2 rounded-lg" style={{ background: '#fffbeb', border: '1px solid #fcd34d' }}>
                      <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1, color: '#b45309' }} />
                      <span style={{ fontSize: 12, color: '#92400e', lineHeight: 1.4 }}>AI extraction may contain errors — always review all fields before saving.</span>
                    </div>
                  </div>
                )}
                {parseState === 'parsing' && (
                  <div className="w-full flex flex-col items-center justify-center gap-2 py-6 rounded-2xl border-2 border-dashed"
                    style={{ borderColor: headerColor, background: `${headerColor}08` }}>
                    <Loader2 size={28} className="animate-spin" style={{ color: headerColor }} />
                    <span className="text-base font-semibold" style={{ color: headerColor }}>Parsing with AI…</span>
                  </div>
                )}
                {parseState === 'done' && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between px-4 py-3 rounded-xl" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
                      <div className="flex items-center gap-2.5">
                        <CheckCircle2 size={17} style={{ color: '#16a34a', flexShrink: 0 }} />
                        <span className="text-sm font-medium" style={{ color: '#15803d' }}>Rate con parsed — review all fields before saving</span>
                      </div>
                      {rateConPdf && canViewRateCon && (
                        <button type="button" onClick={() => setShowPdfViewer(true)}
                          className="flex items-center gap-1.5 text-xs font-semibold shrink-0 ml-3"
                          style={{ color: '#16a34a' }}
                          onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                          onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}>
                          <Eye size={13} /> View PDF
                        </button>
                      )}
                    </div>
                    <div className="flex items-start gap-2 px-3 py-2 rounded-lg" style={{ background: '#fffbeb', border: '1px solid #fcd34d' }}>
                      <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1, color: '#b45309' }} />
                      <span style={{ fontSize: 12, color: '#92400e', lineHeight: 1.4 }}>AI can make mistakes — verify addresses, dates, and dollar amounts against the original document.</span>
                    </div>
                  </div>
                )}
                {parseState === 'error' && (
                  <div className="flex items-center justify-between px-4 py-3 rounded-xl gap-3" style={{ background: '#fef2f2', border: '1px solid #fecaca' }}>
                    {/* Title attr surfaces the full message on hover when
                        the banner is narrow and `truncate` clips it —
                        size-guard errors include the file size which
                        can push past the ~60-char visible window. */}
                    <div className="flex items-center gap-2.5 min-w-0 flex-1" title={parseError || 'Parse failed'}>
                      <AlertCircle size={17} style={{ color: '#dc2626', flexShrink: 0 }} />
                      <span className="text-sm font-medium truncate" style={{ color: '#dc2626' }}>{parseError || 'Parse failed'}</span>
                    </div>
                    <button type="button" onClick={() => fileInputRef.current?.click()}
                      className="text-xs font-medium shrink-0"
                      style={{ color: '#dc2626' }}
                      onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                      onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}>
                      Try again
                    </button>
                  </div>
                )}
              </div>
            )}


            {/* ── Core fields (always visible) ── */}
            <input autoFocus type="text" value={title} onChange={e => { markDirty(); setTitle(e.target.value); }}
              placeholder="Add title" required
              className="w-full bg-transparent outline-none font-medium"
              style={{ fontSize: 22, borderBottom: `2px solid ${title ? headerColor : 'var(--gc-border)'}`, paddingBottom: 8, color: 'var(--gc-text-1)', transition: 'border-color 150ms', cursor: 'text' }}
              onFocus={e => (e.currentTarget.style.borderBottomColor = headerColor)}
              onBlur={e => (e.currentTarget.style.borderBottomColor = title ? headerColor : 'var(--gc-border)')} />

            {/* Non-revenue type selector */}
            {eventKind === 'non_revenue' && (
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--gc-text-3)' }}>
                  Type
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {NON_REVENUE_TYPES.map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setNonRevenueType(t)}
                      className="text-xs px-2.5 py-1 rounded-lg transition-colors"
                      style={{
                        background: nonRevenueType === t ? '#7c3aed' : 'var(--gc-hover)',
                        color: nonRevenueType === t ? '#fff' : 'var(--gc-text-2)',
                      }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Linked work orders — only meaningful when this event
                represents shop time (Maintenance type). The section
                handles its own data fetch + asset-empty state; we
                just pass through eventId + the currently-selected
                truck. On save the parent flushes pendingWorkOrderLinks
                into PATCH calls. Also gated on the maintenance module
                — MVP orgs can still create non-revenue events (PTO,
                detention, etc.) but the "Linked Work Orders" section
                points at Equipment → Maintenance which they don't have. */}
            {maintenanceEnabled && eventKind === 'non_revenue' && nonRevenueType === 'Maintenance' && (
              <LinkedWorkOrdersSection
                eventId={isEdit ? (modalEventId ?? null) : null}
                assetId={assetId ?? null}
                pendingLinkIds={pendingWorkOrderLinks}
                onPendingLinkIdsChange={setPendingWorkOrderLinks}
              />
            )}

            <div className="grid grid-cols-2 gap-4">
              <Field label={startLabel}>
                <div className="flex gap-2">
                  <DatePicker value={startDate}
                    onChange={v => {
                      markDirty();
                      // Duration preservation (moving the start drags the
                      // end along) is right for a single-leg load, where
                      // these two fields ARE the load's pickup and
                      // delivery. On a relay leg they're one leg's
                      // boundaries, and dragging the other one rewrites a
                      // handoff — or the load's delivery — behind the
                      // dispatcher's back. Each boundary moves alone here.
                      if (startDate && endDate && !isMultiLegView) {
                        const diffMs = new Date(`${endDate}T${endTime}`).getTime() - new Date(`${startDate}T${startTime}`).getTime();
                        const newEndMs = new Date(`${v}T${startTime}`).getTime() + diffMs;
                        const d = new Date(newEndMs);
                        const pad = (n: number) => String(n).padStart(2, '0');
                        setEndDate(`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`);
                        setEndTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
                      }
                      setStartDate(v);
                    }}
                    headerColor={LOAD_ACCENT} required />
                  <SmartTimeInput value={startTime} onChange={v => { markDirty(); setStartTime(v); }} headerColor={headerColor} />
                </div>
              </Field>
              <Field label={endLabel}>
                <div className="flex gap-2">
                  <DatePicker value={endDate} onChange={v => { markDirty(); setEndDate(v); }} headerColor={LOAD_ACCENT} min={startDate} required />
                  <SmartTimeInput value={endTime} onChange={v => { markDirty(); setEndTime(v); }} headerColor={headerColor} />
                </div>
              </Field>
            </div>

            {/* Date-order error — blocks save with an inline red banner
                when pickup ends up after delivery (catches same-day
                time-of-day inversions that DatePicker's min={startDate}
                can't see). Matches the conflict-banner style at the top
                of this modal. */}
            {dateOrderError && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-md"
                style={{ background: '#fef2f2', border: '1px solid #fca5a5' }}>
                <AlertTriangle size={14} style={{ color: '#dc2626', flexShrink: 0 }} />
                <span className="text-sm font-medium" style={{ color: '#991b1b' }}>
                  {dateOrderError}
                </span>
              </div>
            )}

            {/* Driver / Asset row.
                Driver on the LEFT, Asset on the RIGHT — drivers are
                the more common entry point (dispatcher knows who's
                running before they pick the truck).
                Auto-fill behavior depends on mode:
                  - CREATE (!isEdit): bidirectional & unconditional.
                    Saves a tap when building a load from scratch.
                  - EDIT: a deliberate pick on one side never silently
                    overwrites the other. We confirm() the partner
                    swap only when the picked side has a preference
                    AND that preference differs from the current value
                    on the other side. The user's explicit choice
                    always lands either way.
                Both handlers run on synchronous onChange (no
                useEffect chain) so there's no feedback loop. */}
            <div className="grid grid-cols-2 gap-4">
              <Field label="Driver">
                {/* Flex row so the suggestion chip sits inline with
                    the select instead of dropping below it — gives
                    the chip equal visual weight as the field. */}
                <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                <StyledSelect value={driverName} onChange={e => {
                    markDirty();
                    const nextName = e.target.value;
                    setDriverName(nextName);
                    // User explicitly picked driver — any pending
                    // "switch driver to X" chip is now stale.
                    setSuggestDriverSwap(null);
                    const targetAid = preferredAssetForDriverName(nextName);
                    if (targetAid == null || targetAid === assetId) {
                      // Picked a driver with no asset pref, or the
                      // pref matches the current asset — nothing to
                      // suggest. Clear any stale suggestion.
                      setSuggestAssetSwap(null);
                      return;
                    }
                    if (!isEdit) {
                      // New load: auto-fill silently.
                      setAssetId(targetAid);
                      setSuggestAssetSwap(null);
                      return;
                    }
                    // Edit mode: don't touch the asset; surface a
                    // dismissible chip below the field.
                    setSuggestAssetSwap(targetAid);
                  }}
                  style={{ ...iStyle, cursor: 'pointer' }} onFocus={focusH} onBlur={blurColor}>
                  <option value="">— No driver —</option>
                  {drivers
                    .filter(d => isActiveOn(d, startDate) || canonicalDriverName(d) === driverName)
                    .map(d => {
                      const display = canonicalDriverName(d);
                      return <option key={d.id} value={display}>{display}</option>;
                    })}
                </StyledSelect>
                </div>
                {/* Driver-side chip — shown when the user picked an
                    asset whose primary driver differs from this
                    field's current value. Sits next to the field
                    it would update (the driver). */}
                {suggestDriverSwap && (
                  <SuggestionChip
                    label={`Use ${suggestDriverSwap}?`}
                    onApply={() => { setDriverName(suggestDriverSwap); setSuggestDriverSwap(null); }}
                    onDismiss={() => setSuggestDriverSwap(null)}
                  />
                )}
                </div>
                {(() => {
                  const sel = findDriverByName(driverName) ?? null;
                  const showSummaryBtn = eventKind === 'revenue' && isEdit;
                  const currentEv = modalEventId ? events.find(e => e.id === modalEventId) : undefined;
                  const showNotify = driverAppEnabled && eventKind === 'revenue' && isEdit && !!sel?.id && !!modalEventId;
                  if (!sel?.phone && !showSummaryBtn && !showNotify) return null;
                  // Per-kind ack state — drives which buttons in the
                  // popover are greyed out. The server is authoritative
                  // (it stamps acknowledged_at on rows), but we also
                  // disable buttons whose ack condition is already met
                  // so dispatch doesn't bother sending a redundant nudge.
                  const ackState = currentEv ? {
                    confirm:         !!currentEv.confirmedAt || ['dispatched','en_route','picked_up','delivered'].includes(currentEv.status ?? ''),
                    mark_pickup:     ['picked_up','delivered'].includes(currentEv.status ?? ''),
                    mark_delivery:   currentEv.status === 'delivered',
                    upload_pod:      loadDocuments.some(d => d.kind === 'pod'),
                    report_trailer:  currentEv.trailerId != null,
                    // Acks when at least one relay_handoff doc lands —
                    // the driver has uploaded photos of the trailer
                    // drop. The popover greys the button so dispatch
                    // doesn't double-nudge.
                    upload_handoff:  loadDocuments.some(d => d.kind === 'relay_handoff'),
                    // Informational kinds — popover never needs to gray
                    // them out client-side. Treat as always-acked so the
                    // type satisfies Record<LoadNotificationKind, bool>.
                    assigned:        true,
                    reassigned_away: true,
                    load_cancelled:  true,
                  } : { confirm:false, mark_pickup:false, mark_delivery:false, upload_pod:false, report_trailer:false, upload_handoff:false, assigned:true, reassigned_away:true, load_cancelled:true };
                  return (
                    <div className="mt-1.5 flex items-center gap-1.5 flex-wrap" style={{ position: 'relative' }}>
                      {sel?.phone && <DriverPhoneCopy phone={sel.phone} />}
                      {showSummaryBtn && (
                        <Tooltip content="Copy-pasteable load summary for driver group chats">
                          <button type="button" onClick={() => setShowDriverSummary(v => !v)}
                            className="text-xs flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors"
                            style={{
                              color: showDriverSummary ? headerColor : 'var(--gc-text-3)',
                              background: showDriverSummary ? `${headerColor}14` : 'transparent',
                              border: 'none', cursor: 'pointer',
                            }}
                            onMouseEnter={e => { if (!showDriverSummary) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                            onMouseLeave={e => (e.currentTarget.style.background = showDriverSummary ? `${headerColor}14` : 'transparent')}>
                            <Copy size={11} />
                            <span>Driver summary</span>
                          </button>
                        </Tooltip>
                      )}
                      {showNotify && sel && modalEventId && (
                        <NotifyDriverPopover
                          eventId={modalEventId}
                          event={currentEv}
                          driverId={sel.id}
                          currentUserName={currentUserName}
                          ackState={ackState}
                        />
                      )}
                    </div>
                  );
                })()}
              </Field>
              <Field label="Truck *">
                <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <AssetSelect
                      value={assetId}
                      options={assets.filter(a => isActiveOn(a, startDate) || a.id === assetId)}
                      onChange={(aid) => {
                        markDirty();
                        setAssetId(aid);
                        // User explicitly picked an asset — drop any
                        // stale "use suggested asset" chip.
                        setSuggestAssetSwap(null);
                        const suggested = preferredDriverName(aid);
                        if (!suggested || suggested === driverName) {
                          setSuggestDriverSwap(null);
                          return;
                        }
                        if (!isEdit) {
                          setDriverName(suggested);
                          setSuggestDriverSwap(null);
                          return;
                        }
                        // Edit mode: surface inline suggestion instead of
                        // silently overwriting the load's driver.
                        setSuggestDriverSwap(suggested);
                      }}
                      style={iStyle}
                      focusColor={headerColor}
                    />
                  </div>
                  {/* Asset-side chip — shown when the user picked a
                      driver whose preferred asset differs from this
                      field's current value. */}
                  {suggestAssetSwap != null && (() => {
                    const targetAsset = assets.find(a => a.id === suggestAssetSwap);
                    if (!targetAsset) return null;
                    return (
                      <SuggestionChip
                        label={`Use ${assetLabel(targetAsset)}?`}
                        onApply={() => { setAssetId(suggestAssetSwap); setSuggestAssetSwap(null); }}
                        onDismiss={() => setSuggestAssetSwap(null)}
                      />
                    );
                  })()}
                </div>
                {/* Share-truck-location row. Builds a Google Maps URL
                    around the truck's current ELD ping and copies a
                    short paste-ready block to the clipboard so the
                    dispatcher can drop it into Slack / SMS / email.
                    Timestamp is absolute in the org tz — chat pastes
                    outlive any "X min ago" string. */}
                {selectedAsset && truckLoc && (
                  <ShareLocationRow
                    label="Share truck location"
                    text={[
                      assetLabel(selectedAsset),
                      truckLoc.description || 'Location available',
                      ...(truckLoc.locatedAt ? [`Last updated ${fmtShareTime(truckLoc.locatedAt, calendarTimezone)}`] : []),
                      `https://www.google.com/maps?q=${truckLoc.lat},${truckLoc.lon}`,
                    ].join('\n')}
                    accentColor={headerColor}
                  />
                )}
              </Field>
            </div>

            {/* Internal notes — thread of pinned notes; revenue only */}
            {eventKind === 'revenue' && (
              internalNotes.length === 0 && !noteComposerOpen ? (
                <button
                  type="button"
                  onClick={() => { setNoteComposerOpen(true); }}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    fontSize: 12, fontWeight: 600, padding: '4px 10px',
                    borderRadius: 6, border: '1px dashed #d4a017',
                    background: 'transparent', color: '#a16207', cursor: 'pointer',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#fef9c3'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <Plus size={12} /> Internal Note
                </button>
              ) : (
                <div style={{
                  padding: '10px 12px', borderRadius: 8,
                  background: '#fef9c3', border: '1px solid #fde68a',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <Pin size={13} style={{ color: '#a16207', flexShrink: 0 }} />
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#92400e' }}>
                      Internal Notes
                    </div>
                  </div>
                  {internalNotes.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: noteComposerOpen ? 10 : 0 }}>
                      {internalNotes.map((n) => (
                        <div key={n.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, lineHeight: 1.4, color: '#78350f', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                              {n.text}
                            </div>
                            <div style={{ fontSize: 11, color: '#a16207', marginTop: 2 }}>
                              {n.author ? `${n.author}` : 'Unknown'}
                              {' · '}
                              {new Date(n.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => { setInternalNotes(internalNotes.filter(x => x.id !== n.id)); markDirty(); }}
                            title="Remove note"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#a16207' }}
                            onMouseEnter={e => { e.currentTarget.style.color = '#dc2626'; }}
                            onMouseLeave={e => { e.currentTarget.style.color = '#a16207'; }}
                          >
                            <X size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {noteComposerOpen ? (
                    <div style={{ borderTop: internalNotes.length > 0 ? '1px solid #fde68a' : 'none', paddingTop: internalNotes.length > 0 ? 10 : 0 }}>
                      <textarea
                        value={noteComposer}
                        onChange={e => { setNoteComposer(e.target.value); markDirty(); }}
                        placeholder="Add a note. Pinned to this load. Never sent to driver or customer."
                        rows={2}
                        autoFocus
                        style={{
                          width: '100%', fontSize: 13, lineHeight: 1.4, color: '#78350f',
                          background: 'transparent', border: 'none', outline: 'none', resize: 'vertical',
                          fontFamily: 'inherit',
                        }}
                      />
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 4 }}>
                        <button
                          type="button"
                          onClick={() => { setNoteComposer(''); setNoteComposerOpen(false); }}
                          style={{ fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 4, border: 'none', background: 'transparent', color: '#a16207', cursor: 'pointer' }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={!noteComposer.trim()}
                          onClick={() => {
                            const text = noteComposer.trim();
                            if (!text) return;
                            const authorName = user?.fullName ?? user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? null;
                            setInternalNotes([...internalNotes, { id: crypto.randomUUID(), text, author: authorName, at: new Date().toISOString() }]);
                            setNoteComposer('');
                            setNoteComposerOpen(false);
                            markDirty();
                          }}
                          style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 4, border: 'none', background: noteComposer.trim() ? '#a16207' : '#fde68a', color: '#fff', cursor: noteComposer.trim() ? 'pointer' : 'default' }}
                        >
                          Post
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setNoteComposerOpen(true)}
                      style={{ fontSize: 11, fontWeight: 600, padding: '3px 0', border: 'none', background: 'transparent', color: '#a16207', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    >
                      <Plus size={11} /> Add note
                    </button>
                  )}
                </div>
              )
            )}

            {/* ── Load Info (always pinned here, above relay + stops) — revenue only ── */}
            {eventKind === 'revenue' && (() => {
              const fields = getEnabledFieldsForSection('load', fieldSettings);
              if (fields.length === 0) return null;
              return (
                <div style={{ borderTop: '1px solid var(--gc-border-light)', paddingTop: 20 }}>
                  <div className="text-[11px] font-bold uppercase tracking-wider mb-4" style={{ color: 'var(--gc-text-3)' }}>
                    {SECTION_LABELS['load']}
                  </div>
                  <SectionFields fields={fields} fieldValues={fieldValues} onChange={setField} headerColor={headerColor} overrides={dispatcherFieldOverride} labelSuffixes={dispatcherLabelSuffixes} noLabelFields={new Set()} />
                </div>
              );
            })()}

            {/* ── Sections in user-defined order (load pinned above, locations = relay+stops) ── */}
            {(sectionOrder.includes('locations') ? sectionOrder : [...sectionOrder, 'locations' as const]).map(section => {
              if (section === 'load') return null; // pinned above
              if (section === 'locations') return (
                <div key="locations">
                  {/* Relay legs editor — one card per leg with a handoff
                      divider (relay point + photos + per-handoff undo)
                      between consecutive legs. Replaces the old fixed
                      pickup/delivery block. */}
                  {isRelayContext && (
                    <div style={{ borderTop: '1px solid var(--gc-border-light)', paddingTop: 20 }}>
                      <RelayLegsEditor
                        legs={relayLegViews}
                        handoffs={relayHandoffViews}
                        loadPrice={canViewPrice && relayLp > 0 ? relayLp : null}
                        assets={assets}
                        drivers={drivers}
                        startDate={startDate}
                        canViewDriverPay={canViewDriverPay}
                        disabled={isReadOnly}
                        loadId={currentEv?.loadId}
                        handoffPhotos={relayHandoffPhotos}
                        onSelectPhoto={(docId) => {
                          setShowPdfViewer(true);
                          setShowMapPanel(false);
                          setDocsTab('uploaded');
                          setSelectedDocId(docId);
                        }}
                        onPhotosUploaded={refreshHandoffDocs}
                        canonicalDriverName={canonicalDriverName}
                        onChangeLeg={handleLegChange}
                        onOpenLeg={(eventId) => {
                          if (isDirty) { setSavePromptAfterNav(eventId); setShowSavePrompt(true); }
                          else { openEditModal(eventId); }
                        }}
                        // Header "+" stacks handoffs in create mode; on an
                        // existing relay each leg card gets its own "+"
                        // instead (split THAT leg), gated to one pending
                        // handoff per save.
                        // Header "+" — kept for create mode (appends
                        // after the last leg) and the legacy split flow.
                        onAddHandoff={!isBatch && !isLegBuilder && !isExistingRelayLeg && !(isEdit && pendingSplitStopId) ? () => addHandoff() : undefined}
                        // Per-leg "+" — splits THAT leg, in either mode.
                        onAddHandoffForLeg={!isBatch && !isReadOnly && (showLegBuilderUi || (isExistingRelayLeg && !pendingSplitStopId))
                          ? (legKey) => addHandoff(legKey)
                          : undefined}
                        onRemoveHandoff={handleRemoveHandoff}
                        // Handoff times live here now — the Locations
                        // rows mirror them read-only.
                        onChangeHandoffTimes={!isReadOnly ? handleChangeHandoffTimes : undefined}
                        onChangeHandoffStop={!isReadOnly ? handleChangeHandoffStop : undefined}
                        // Builder mode: any leg can be split again before
                        // saving; Save reconciles the whole structure.
                        builderMode={showLegBuilderUi && !isReadOnly}
                      />
                    </div>
                  )}
                  {/* Stops section */}
                  <div style={{ borderTop: '1px solid var(--gc-border-light)', paddingTop: 20, position: 'relative' }}>
                    {isEdit && modalEventId && refetchingEventIds.has(modalEventId) && stops.length === 0 && (
                      // While a refresh is in flight and we have no stops to
                      // show, indicate progress so the user understands the
                      // "+ Add Stop" empty state isn't the final answer.
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '8px 12px', marginBottom: 12,
                        borderRadius: 8,
                        background: `${headerColor}10`,
                        border: `1px solid ${headerColor}30`,
                        fontSize: 12, color: headerColor, fontWeight: 600,
                      }}>
                        <RefreshCw size={12} style={{ animation: 'spin 0.8s linear infinite' }} />
                        Fetching stops…
                      </div>
                    )}
                    <StopsSection
                      stops={stops}
                      onChange={next => { setStops(next); markDirty(); }}
                      headerColor={headerColor}
                      onMapRoute={() => { setShowMapPanel(true); setShowPdfViewer(false); }}
                      onActivateRelay={!isBatch && !isReadOnly ? () => addHandoff() : undefined}
                      relayActive={isEdit && !isLegBuilder ? pendingSplitStopId != null : false}
                      relayRole={relayRole}
                      legIndex={viewedLegIdx}
                      legCount={isRelayContext ? relayLegViews.length : undefined}
                      legDriverNames={isRelayContext ? relayLegViews.map(v => v.driverName || undefined) : undefined}
                      // Leg-builder affordances: per-stop handoff toggle,
                      // leg rail + tags, and insert-between rows.
                      legBuilder={showLegBuilderUi && !isReadOnly}
                      onToggleHandoff={handleToggleStopHandoff}
                      onInsertHandoffAfter={handleInsertHandoffAfter}
                      eventStart={startDate && startTime ? `${startDate}T${startTime}` : undefined}
                      eventEnd={endDate && endTime ? `${endDate}T${endTime}` : undefined}
                      // Whole-haul miles (Σ every leg) in the header. RPM is
                      // load price / total miles, so showing only the leg's
                      // own miles makes the displayed RPM look wrong (e.g.
                      // "4 mi · $2.08/mi" on a tiny delivery leg of a
                      // 1200-mile haul). Every leg renders the same number;
                      // null until every sibling leg's miles are known.
                      loadedMiles={relayTotalMilesForHeader}
                      loadPrice={canViewPrice && typeof fieldValues['loadPrice'] === 'number' ? fieldValues['loadPrice'] : null}
                      ratePerMile={canViewPrice ? (() => {
                        // loadPrice is stored at the LOAD level (every leg
                        // shares the same value — see LOAD_LEVEL_KEYS in
                        // lib/loadFieldSplit.ts). Don't sum per-leg prices;
                        // the denominator is the whole-haul miles so every
                        // leg shows the same load-level RPM.
                        const thisPrice = typeof fieldValues['loadPrice'] === 'number' ? fieldValues['loadPrice'] : null;
                        const total = relayTotalMilesForHeader;
                        if (thisPrice == null || total == null || total === 0) return null;
                        return Math.round((thisPrice / total) * 100) / 100;
                      })() : null}
                    />
                  </div>
                </div>
              );
              let fields = getEnabledFieldsForSection(section, fieldSettings);
              // For non-revenue events, hide revenue-only financial fields (keep only driverPay)
              if (section === 'financial' && eventKind === 'non_revenue') {
                fields = fields.filter(f => f.id === 'driverPay');
              }
              // Strip driverPay from the field list for users without
              // loads.view_driver_pay (Dispatcher, Maintenance). The
              // per-leg pickup/delivery driver-pay inputs in the
              // relay block below are gated separately.
              if (section === 'financial' && !canViewDriverPay) {
                fields = fields.filter(f => f.id !== 'driverPay');
              }
              // Same treatment for loadPrice when the role can't see
              // dollar amounts (Maintenance).
              if (section === 'financial' && !canViewPrice) {
                fields = fields.filter(f => f.id !== 'loadPrice');
              }
              // In relay context the driverPay slot becomes a read-only
              // "Total Driver Pay" tile (rendered via override + noLabel).
              // The editable per-leg inputs live in a separate block below.
              if (fields.length === 0) return null;
              return (
                <div key={section} style={{ borderTop: '1px solid var(--gc-border-light)', paddingTop: 20 }}>
                  <div className="flex items-center justify-between mb-4">
                    <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
                      {SECTION_LABELS[section]}
                    </div>
                    {section === 'financial' && eventKind === 'revenue' && canViewPrice && (
                      <button type="button" onClick={addAccessorial}
                        className="flex items-center gap-1 text-xs font-semibold transition-opacity"
                        style={{ color: ACC_COLOR }}
                        onMouseEnter={e => (e.currentTarget.style.opacity = '0.7')}
                        onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
                        <Plus size={12} /> Accessorial
                      </button>
                    )}
                  </div>
                  <SectionFields
                    fields={fields}
                    fieldValues={fieldValues}
                    onChange={setField}
                    headerColor={headerColor}
                    overrides={dispatcherFieldOverride}
                    labelSuffixes={dispatcherLabelSuffixes}
                    noLabelFields={isRelayContext && section === 'financial' ? new Set(['driverPay']) : new Set()}
                  />
                  {/* Per-leg driver-pay inputs live in the Relay legs
                      editor (Locations section) — the financial grid
                      keeps only the read-only Total Driver Pay tile
                      next to Load Price via the override above. */}

                  {/* Non-relay finalized banner — visually aligned under
                      the Driver Pay column (right side of the 2-col
                      financial grid). An empty left cell + the banner
                      in the right cell mirrors the relay layout where
                      each side has its own banner under its pay field. */}
                  {section === 'financial' && !isRelayContext && canViewDriverPay && (() => {
                    const dpRaw = fieldValues['driverPay'];
                    const dpNum = typeof dpRaw === 'number'
                      ? dpRaw
                      : typeof dpRaw === 'string' && dpRaw.trim() !== ''
                        ? parseFloat(dpRaw)
                        : null;
                    return (
                      <div className="mt-1.5 grid grid-cols-2 gap-3">
                        <div />
                        <FinalizedPayBanner
                          driverName={driverName}
                          pickupIso={startDate}
                          driverPay={Number.isFinite(dpNum) ? (dpNum as number) : null}
                        />
                      </div>
                    );
                  })()}
                  {section === 'financial' && eventKind === 'revenue' && canViewPrice && accessorials.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {accessorials.map(acc => (
                        <div key={acc.id} className="flex items-center gap-2">
                          <select value={acc.category}
                            onChange={e => updateAccessorial(acc.id, { category: e.target.value as Accessorial['category'] })}
                            style={{ flexShrink: 0, height: 40, border: '1px solid var(--gc-border)', borderRadius: 8, padding: '0 10px', fontSize: 13, color: 'var(--gc-text-1)', background: 'var(--gc-surface)', outline: 'none', cursor: 'pointer', boxSizing: 'border-box' }}
                            onFocus={e => (e.currentTarget.style.borderColor = ACC_COLOR)}
                            onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}>
                            <option value="detention">Detention</option>
                            <option value="lumper">Lumper</option>
                            <option value="layover">Layover</option>
                            <option value="scale_ticket">Scale Ticket</option>
                            <option value="extra_stop">Extra Stop</option>
                            <option value="other">Other</option>
                          </select>
                          <input type="text" value={acc.description ?? ''}
                            onChange={e => updateAccessorial(acc.id, { description: e.target.value })}
                            placeholder="Description (optional)"
                            style={{ flex: 1, height: 40, border: '1px solid var(--gc-border)', borderRadius: 8, padding: '0 10px', fontSize: 13, color: 'var(--gc-text-1)', background: 'var(--gc-surface)', outline: 'none', boxSizing: 'border-box' }}
                            onFocus={e => (e.currentTarget.style.borderColor = ACC_COLOR)}
                            onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')} />
                          <div style={{ position: 'relative', flexShrink: 0 }}>
                            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: 'var(--gc-text-3)', pointerEvents: 'none' }}>$</span>
                            <input type="number" min={0} step={0.01} value={acc.amount || ''}
                              onChange={e => updateAccessorial(acc.id, { amount: parseFloat(e.target.value) || 0 })}
                              placeholder="0.00"
                              style={{ width: 96, height: 40, border: '1px solid var(--gc-border)', borderRadius: 8, padding: '0 10px 0 22px', fontSize: 13, color: 'var(--gc-text-1)', background: 'var(--gc-surface)', outline: 'none', boxSizing: 'border-box' }}
                              onFocus={e => (e.currentTarget.style.borderColor = ACC_COLOR)}
                              onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')} />
                          </div>
                          <select value={acc.status ?? ''}
                            onChange={e => updateAccessorial(acc.id, { status: (e.target.value || undefined) as Accessorial['status'] })}
                            style={{ flexShrink: 0, height: 40, border: '1px solid var(--gc-border)', borderRadius: 8, padding: '0 10px', fontSize: 13, color: acc.status ? 'var(--gc-text-1)' : 'var(--gc-text-3)', background: 'var(--gc-surface)', outline: 'none', cursor: 'pointer', boxSizing: 'border-box' }}
                            onFocus={e => (e.currentTarget.style.borderColor = ACC_COLOR)}
                            onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}>
                            <option value="">Status</option>
                            <option value="requested">Requested</option>
                            <option value="approved">Approved</option>
                            <option value="denied">Denied</option>
                          </select>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="text-xs font-medium" style={{ color: 'var(--gc-text-3)' }}>Billable</span>
                            <button type="button" onClick={() => updateAccessorial(acc.id, { billable: !acc.billable })}
                              className="relative flex items-center shrink-0 rounded-full"
                              style={{ width: 32, height: 18, background: acc.billable ? ACC_COLOR : '#dadce0', transition: 'background 150ms', cursor: 'pointer' }}>
                              <span className="absolute rounded-full bg-white"
                                style={{ width: 12, height: 12, left: 3, transform: acc.billable ? 'translateX(14px)' : 'translateX(0)', transition: 'transform 150ms', boxShadow: '0 1px 2px rgba(0,0,0,.2)' }} />
                            </button>
                          </div>
                          {(() => {
                            // Build the list of drivers that can receive this
                            // accessorial pay — the viewed leg's driver plus
                            // every other leg's (drafts included), leg order.
                            const payOpts: string[] = [];
                            if (driverName) payOpts.push(driverName);
                            for (const lv of relayLegViews) {
                              if (lv.driverName && !payOpts.includes(lv.driverName)) payOpts.push(lv.driverName);
                            }
                            return (
                              <>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <span className="text-xs font-medium" style={{ color: 'var(--gc-text-3)' }}>Pay Driver</span>
                                  <button type="button" onClick={() => {
                                    const next = !acc.payToDriver;
                                    updateAccessorial(acc.id, {
                                      payToDriver: next,
                                      // Auto-default to the load's own driver when turning on
                                      ...(next && payOpts.length > 0 && !acc.payDriverName ? { payDriverName: payOpts[0] } : {}),
                                      ...(!next ? { payDriverName: undefined } : {}),
                                    });
                                  }}
                                    className="relative flex items-center shrink-0 rounded-full"
                                    style={{ width: 32, height: 18, background: acc.payToDriver ? '#1e8e3e' : '#dadce0', transition: 'background 150ms', cursor: 'pointer' }}>
                                    <span className="absolute rounded-full bg-white"
                                      style={{ width: 12, height: 12, left: 3, transform: acc.payToDriver ? 'translateX(14px)' : 'translateX(0)', transition: 'transform 150ms', boxShadow: '0 1px 2px rgba(0,0,0,.2)' }} />
                                  </button>
                                </div>
                                {acc.payToDriver && payOpts.length > 0 && (
                                  <select
                                    value={acc.payDriverName ?? payOpts[0]}
                                    onChange={e => updateAccessorial(acc.id, { payDriverName: e.target.value })}
                                    style={{ flexShrink: 0, height: 40, border: '1px solid #1e8e3e', borderRadius: 8, padding: '0 10px', fontSize: 13, color: 'var(--gc-text-1)', background: 'var(--gc-surface)', outline: 'none', cursor: 'pointer', boxSizing: 'border-box' }}
                                    onFocus={e => (e.currentTarget.style.borderColor = '#1e8e3e')}
                                    onBlur={e => (e.currentTarget.style.borderColor = '#1e8e3e')}
                                  >
                                    {payOpts.map(name => (
                                      <option key={name} value={name}>{name}</option>
                                    ))}
                                  </select>
                                )}
                              </>
                            );
                          })()}
                          <button type="button" onClick={() => removeAccessorial(acc.id)}
                            className="p-1.5 rounded-full transition-colors shrink-0" style={{ color: 'var(--gc-text-3)' }}
                            onMouseEnter={e => { e.currentTarget.style.color = '#d93025'; e.currentTarget.style.background = 'rgba(217,48,37,.1)'; }}
                            onMouseLeave={e => { e.currentTarget.style.color = 'var(--gc-text-3)'; e.currentTarget.style.background = 'transparent'; }}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {section === 'financial' && eventKind === 'revenue' && accessorialsTotal > 0 && (() => {
                    const linehaul = parseFloat(String(fieldValues['loadPrice'] ?? 0)) || 0;
                    const grandTotal = linehaul + accessorialsTotal;
                    return (
                      <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium flex-wrap"
                        style={{ background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0' }}>
                        <span>
                          Total billable: <strong>${grandTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
                        </span>
                        <span>
                          (Linehaul ${linehaul.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} + Accessorials ${accessorialsTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})
                        </span>
                      </div>
                    );
                  })()}
                </div>
              );
            })}

          </div>

          {/* Check Calls — only when load row exists */}
          {isEdit && (() => {
            const ev = events.find(e => e.id === modalEventId);
            if (!ev?.loadId) return null;
            return (
              <CheckCallsSection
                loadId={ev.loadId}
                currentUserName={currentUserName}
                accentColor={LOAD_ACCENT}
              />
            );
          })()}

          {/* Audit history — edit mode only */}
          {isEdit && (() => {
            const ev = events.find(e => e.id === modalEventId);
            if (!ev) return null;
            const hasHistory = auditLog.length > 0;
            if (!ev.createdByName && !hasHistory) return null;
            // Both formatters render in the org timezone instead of
            // the browser's local clock. Without this, a dispatcher
            // in MT and a dispatcher in ET reviewing the same load
            // would see different timestamps on the same audit
            // entry — confusing on multi-region teams.
            //
            // changedAt is a full ISO with offset (set by
            // `new Date().toISOString()` at write time), so passing
            // timeZone to toLocaleString shifts the display correctly.
            const fmtDate = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: calendarTimezone });
            const assetName = (id: number) => assets.find(a => a.id === id)?.name ?? `Asset ${id}`;
            const fmt$ = (n?: number) => n != null ? `$${n.toLocaleString()}` : '—';
            // prevStart/newStart/prevEnd/newEnd are stored as NAIVE
            // ISO strings ("YYYY-MM-DDTHH:mm" with no offset) —
            // they already represent a wall-clock time in the org's
            // timezone. Parsing as UTC and then formatting with
            // timeZone:calendarTimezone would double-shift; instead
            // we parse manually and format the components directly.
            const fmtAuditTime = (iso?: string) => {
              if (!iso) return '—';
              const s = iso.includes(' ') ? iso.replace(' ', 'T') : iso;
              const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
              if (!m) return iso;
              const [, y, mo, d, hh, mm] = m;
              // Build a Date in UTC from the parts, then format with
              // the org TZ. Since the parts represent the wall-clock
              // time the dispatcher saw, this round-trip preserves
              // them exactly when timeZone:'UTC' is used for the
              // construction and the desired tz for display.
              const dt = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm));
              return dt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
            };
            return (
              <div style={{ borderTop: '1px solid var(--gc-border-light)', padding: '12px 32px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <Clock size={11} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />
                  {ev.createdByName && <>
                    <span style={{ color: 'var(--gc-text-3)' }}>Created by</span>
                    <span style={{ color: 'var(--gc-text-1)', fontWeight: 600 }}>{ev.createdByName}</span>
                    {ev.createdAt && <><span style={{ color: 'var(--gc-text-3)' }}>·</span><span style={{ color: 'var(--gc-text-3)' }}>{fmtDate(ev.createdAt)}</span></>}
                  </>}
                  {hasHistory && (
                    <button
                      type="button"
                      onClick={() => setHistoryExpanded(x => !x)}
                      style={{ marginLeft: 6, fontSize: 11, color: 'var(--gc-blue)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600 }}
                    >
                      {historyExpanded ? 'Hide history' : `View full history (${auditLog.length})`}
                    </button>
                  )}
                </div>
                {historyExpanded && hasHistory && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 10 }}>
                    {auditLog.map((entry, i) => {
                      const b = (txt: string) => <strong style={{ fontWeight: 700 }}>{txt}</strong>;
                      type Part = { key: string; node: React.ReactNode };
                      const parts: Part[] = [];
                      // Renamed Asset → Truck per user-facing convention
                      // (dispatch ops talk about trucks, not assets).
                      if (entry.prevAssetId !== undefined)
                        parts.push({ key: 'asset', node: <>{b('Truck')} changed from {b(assetName(entry.prevAssetId))} to {b(entry.newAssetId !== undefined ? assetName(entry.newAssetId) : '—')}</> });
                      if (entry.prevDriverName !== undefined || entry.newDriverName !== undefined)
                        parts.push({ key: 'driver', node: <>{b('Driver')} changed from {b(entry.prevDriverName || '—')} to {b(entry.newDriverName || '—')}</> });
                      if (entry.prevLoadPrice !== undefined)
                        parts.push({ key: 'lprice', node: <>{b('Load price')} changed from {b(fmt$(entry.prevLoadPrice))} to {b(fmt$(entry.newLoadPrice))}</> });
                      if (entry.prevDriverPay !== undefined)
                        parts.push({ key: 'dpay', node: <>{b('Driver pay')} changed from {b(fmt$(entry.prevDriverPay))} to {b(fmt$(entry.newDriverPay))}</> });
                      // Customer changes — prefer the named link when
                      // available; fall back to the free-text broker
                      // diff when only the text changed.
                      if (entry.prevCustomerId !== undefined || entry.newCustomerId !== undefined)
                        parts.push({ key: 'customer', node: <>{b('Customer')} changed from {b(entry.prevCustomerName || entry.prevBroker || '—')} to {b(entry.newCustomerName || entry.newBroker || '—')}</> });
                      else if (entry.prevBroker !== undefined || entry.newBroker !== undefined)
                        parts.push({ key: 'broker', node: <>{b('Customer')} changed from {b(entry.prevBroker || '—')} to {b(entry.newBroker || '—')}</> });
                      if (entry.prevDispatcher !== undefined || entry.newDispatcher !== undefined)
                        parts.push({ key: 'disp', node: <>{b('Dispatcher')} changed from {b(entry.prevDispatcher || '—')} to {b(entry.newDispatcher || '—')}</> });
                      if (entry.prevTrailerId !== undefined || entry.newTrailerId !== undefined)
                        parts.push({ key: 'trailer', node: <>{b('Trailer')} changed from {b(entry.prevTrailerNum || (entry.prevTrailerId ? `#${entry.prevTrailerId}` : '—'))} to {b(entry.newTrailerNum || (entry.newTrailerId ? `#${entry.newTrailerId}` : '—'))}</> });
                      if (entry.prevPriority !== undefined || entry.newPriority !== undefined)
                        parts.push({ key: 'priority', node: <>{b('Priority')} {entry.newPriority ? <>flagged {b('on')}</> : <>flag {b('removed')}</>}</> });
                      // Render the times in the org's TZ via the same
                      // formatter as the load chip strip. The stored
                      // string is naive ISO; pass it through to the
                      // existing fmtAuditTime helper.
                      if (entry.prevStart !== undefined || entry.newStart !== undefined)
                        parts.push({ key: 'start', node: <>{b('Start')} changed from {b(fmtAuditTime(entry.prevStart))} to {b(fmtAuditTime(entry.newStart))}</> });
                      if (entry.prevEnd !== undefined || entry.newEnd !== undefined)
                        parts.push({ key: 'end', node: <>{b('End')} changed from {b(fmtAuditTime(entry.prevEnd))} to {b(fmtAuditTime(entry.newEnd))}</> });
                      if (entry.stopsAdded)
                        parts.push({ key: 'sadd', node: <>{b(String(entry.stopsAdded))} stop{entry.stopsAdded > 1 ? 's' : ''} added</> });
                      if (entry.stopsRemoved)
                        parts.push({ key: 'srem', node: <>{b(String(entry.stopsRemoved))} stop{entry.stopsRemoved > 1 ? 's' : ''} removed</> });
                      if (entry.relayCreated)
                        parts.push({ key: 'rcreate', node: <>Load split as {b('relay')}</> });
                      if (entry.relayRemoved)
                        parts.push({ key: 'rremove', node: <>{b('Relay')} removed, load merged</> });
                      // Cancel entries carry mode in `loadCancelled`. Render
                      // a single plain-English line and suppress the
                      // generic status/deleted lines that would otherwise
                      // duplicate the same event. The "remove-event" mode
                      // used to render nothing at all — entry was saved,
                      // user just couldn't see it.
                      if (entry.loadCancelled) {
                        const mode = entry.loadCancelled.mode;
                        const label =
                          mode === 'status'       ? <>Load {b('cancelled')} (kept on calendar)</> :
                          mode === 'remove-event' ? <>Load {b('cancelled')} & removed from calendar</> :
                          mode === 'permanent'    ? <>Load {b('cancelled')} & permanently deleted</> :
                                                    <>Load {b('cancelled')}</>;
                        parts.push({ key: 'cancelled', node: label });
                      }
                      if (entry.loadDeleted && !entry.loadCancelled)
                        parts.push({ key: 'ldel', node: <>{b('Load')} deleted</> });
                      if (entry.loadRestored)
                        parts.push({ key: 'lrest', node: <>{b('Load')} reinstated</> });
                      if ((entry.prevStatus !== undefined || entry.newStatus !== undefined) && !entry.loadCancelled)
                        parts.push({ key: 'status', node: <>{b('Status')} changed from {b(entry.prevStatus ?? '—')} to {b(entry.newStatus ?? '—')}</> });
                      if (entry.prevBillingStatus !== undefined || entry.newBillingStatus !== undefined)
                        parts.push({ key: 'bstatus', node: <>{b('Billing')} status changed from {b(entry.prevBillingStatus ?? '—')} to {b(entry.newBillingStatus ?? '—')}</> });
                      if (entry.documentUploaded)
                        parts.push({ key: 'docup', node: <>{b(entry.documentUploaded.kind.toUpperCase())} document {b('uploaded')} ({entry.documentUploaded.fileName})</> });
                      if (entry.documentDeleted)
                        parts.push({ key: 'docdel', node: <>{b(entry.documentDeleted.kind.toUpperCase())} document {b('deleted')} ({entry.documentDeleted.fileName})</> });
                      if (entry.stopCheckedIn) {
                        const facility = entry.stopCheckedIn.stopFacility ?? 'stop';
                        const distLbl = entry.stopCheckedIn.distanceMi == null
                          ? null
                          : entry.stopCheckedIn.distanceMi < 0.1 ? 'on-site' : `${entry.stopCheckedIn.distanceMi.toFixed(1)} mi off`;
                        parts.push({ key: 'checkin', node: <>{b('Checked in')} at {b(facility)}{distLbl ? <> · {distLbl}</> : null}</> });
                      }
                      const fmtCat = (c: string) => c.replace('_', ' ');
                      const accLines = (entry.accessorialsChanged ?? []).map((ac, ai) => {
                        const label = b(ac.description ? `${fmtCat(ac.category)} (${ac.description})` : fmtCat(ac.category));
                        if (ac.action === 'added')
                          return <span key={`acc-${ai}`} style={{ color: 'var(--gc-text-1)' }}>{label} accessorial added{ac.amount != null ? <> — {b(`$${ac.amount.toLocaleString()}`)}</> : ''}</span>;
                        if (ac.action === 'removed')
                          return <span key={`acc-${ai}`} style={{ color: 'var(--gc-text-1)' }}>{label} accessorial removed</span>;
                        const amtPart = ac.prevAmount !== undefined ? <> amount {b(`$${ac.prevAmount?.toLocaleString()}`)} → {b(`$${ac.amount?.toLocaleString()}`)}</> : null;
                        const stPart  = ac.prevStatus ? <> status {b(ac.prevStatus)} → {b(ac.newStatus ?? '—')}</> : null;
                        return <span key={`acc-${ai}`} style={{ color: 'var(--gc-text-1)' }}>{label} accessorial updated{amtPart}{stPart}</span>;
                      });
                      return (
                        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {(parts.length > 0 || accLines.length === 0) && (
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12, flexWrap: 'wrap' }}>
                              <span style={{ color: 'var(--gc-text-1)' }}>
                                {parts.length > 0
                                  ? parts.flatMap((p, j) => j === 0
                                    ? [<span key={p.key}>{p.node}</span>]
                                    : [<span key={`sep-${p.key}`} style={{ color: 'var(--gc-text-3)', margin: '0 4px' }}>&amp;</span>, <span key={p.key}>{p.node}</span>])
                                  : null}
                              </span>
                              {parts.length > 0 && <span style={{ color: 'var(--gc-text-3)', whiteSpace: 'nowrap' }}>· by {entry.changedByName} · {fmtDate(entry.changedAt)}</span>}
                            </div>
                          )}
                          {accLines.map((line, ai) => (
                            <div key={ai} style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12, flexWrap: 'wrap' }}>
                              {line}
                              <span style={{ color: 'var(--gc-text-3)', whiteSpace: 'nowrap' }}>· by {entry.changedByName} · {fmtDate(entry.changedAt)}</span>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}

          </fieldset>

          {/* Footer — outside the read-only fieldset so Cancel/Close
              stays clickable for read-only roles even when every form
              control above is disabled. */}
          {isBatch ? (
            <div className="shrink-0 flex items-center justify-between px-8 py-5"
              style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
              <button type="button" onClick={handleBatchCancel}
                className="px-4 py-2.5 rounded-lg text-[13px] font-medium transition-all"
                style={confirmBatchCancel ? { background: '#d93025', color: 'white' } : { color: '#d93025', background: 'transparent' }}
                onMouseEnter={e => { if (!confirmBatchCancel) e.currentTarget.style.background = 'rgba(217,48,37,.1)'; }}
                onMouseLeave={e => { if (!confirmBatchCancel) e.currentTarget.style.background = 'transparent'; }}>
                {confirmBatchCancel ? 'Confirm cancel?' : 'Cancel Batch'}
              </button>
              <div className="flex gap-2">
                <button type="button" onClick={handleBatchSkip}
                  className="px-6 py-2.5 rounded-lg text-[13px] font-medium transition-all"
                  style={confirmSkip
                    ? { background: '#e37400', color: 'white', border: '1px solid #e37400' }
                    : { color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)', background: 'transparent' }}
                  onMouseEnter={e => { if (!confirmSkip) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                  onMouseLeave={e => { if (!confirmSkip) e.currentTarget.style.background = 'transparent'; }}>
                  {confirmSkip ? 'Confirm skip?' : 'Skip'}
                </button>
                <button type="button" onClick={() => handleBatchSave()} disabled={!title.trim() || !startDate || !endDate}
                  className="px-6 py-2.5 rounded-lg text-[13px] font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  style={{ background: 'var(--gc-blue)' }}
                  onMouseEnter={e => { if (title.trim()) e.currentTarget.style.background = 'var(--gc-blue-hover)'; }}
                  onMouseLeave={e => e.currentTarget.style.background = 'var(--gc-blue)'}>
                  {batchIndex >= batchItems.length - 1 ? 'Save & Finish' : 'Save & Next →'}
                </button>
              </div>
            </div>
          ) : (
            <div className="shrink-0 flex items-center justify-between px-8 py-5"
              style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
              <div className="flex items-center gap-1">
                {isEdit && (
                  <>
                    {eventKind === 'revenue' && isCancelled ? (
                      <>
                        <button type="button" onClick={() => void handleReinstate()}
                          className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-[13px] font-medium transition-all"
                          style={{ color: 'var(--gc-blue)', background: 'transparent' }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-light)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          <RefreshCw size={15} />
                          Reinstate
                        </button>
                        {canDeleteLoad && (
                          <button type="button" onClick={() => setRemoveDialogOpen(true)}
                            className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-[13px] font-medium transition-all"
                            style={{ color: '#d93025', background: 'transparent' }}
                            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(217,48,37,.1)')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                            <Trash2 size={15} />
                            Remove
                          </button>
                        )}
                      </>
                    ) : eventKind === 'revenue' ? (
                      canDeleteLoad && !cancelLocked ? (
                        <button type="button" onClick={() => setCancelDialogOpen(true)}
                          className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-[13px] font-medium transition-all"
                          style={{ color: '#d93025', background: 'transparent' }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(217,48,37,.1)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          <Trash2 size={15} />
                          Cancel load
                        </button>
                      ) : canDeleteLoad && cancelLocked ? (
                        <button type="button" disabled
                          className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-[13px] font-medium cursor-not-allowed"
                          style={{ color: 'var(--gc-text-3)', background: 'transparent', opacity: 0.6 }}
                          title="This load has been released for billing. Void the invoice first to cancel.">
                          <Trash2 size={15} />
                          Cancel load
                        </button>
                      ) : null
                    ) : (
                      <button type="button" onClick={handleDelete}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-[13px] font-medium transition-all"
                        style={confirmDel ? { background: '#d93025', color: 'white' } : { color: '#d93025', background: 'transparent' }}
                        onMouseEnter={e => { if (!confirmDel) e.currentTarget.style.background = 'rgba(217,48,37,.1)'; }}
                        onMouseLeave={e => { if (!confirmDel) e.currentTarget.style.background = 'transparent'; }}>
                        <Trash2 size={15} />
                        {confirmDel ? 'Confirm?' : 'Delete'}
                      </button>
                    )}
                    {!isExistingRelayLeg && (
                      <>
                        <button type="button" onClick={handleDuplicate}
                          className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-[13px] font-medium transition-all"
                          style={{ color: 'var(--gc-text-2)', background: 'transparent' }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          <Copy size={15} />
                          Duplicate
                        </button>
                        <button type="button" onClick={handlePlusOneWeek}
                          className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-[13px] font-medium transition-all"
                          style={{ color: 'var(--gc-text-2)', background: 'transparent' }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          +1 Week
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={attemptClose}
                  className="px-6 py-2.5 rounded-lg text-[13px] font-medium transition-colors"
                  style={{ color: 'var(--gc-blue)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-light)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  Cancel
                </button>
                {!isReadOnly && (
                  <button type="submit" disabled={saving || !title.trim() || !startDate || !endDate || modalConflict === 'deleted'}
                    className="px-6 py-2.5 rounded-lg text-[13px] font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    style={{ background: 'var(--gc-blue)', cursor: saving ? 'wait' : undefined }}
                    onMouseEnter={e => { if (title.trim() && !saving) e.currentTarget.style.background = 'var(--gc-blue-hover)'; }}
                    onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-blue)')}>
                    {saving
                      ? 'Saving…'
                      : isEdit ? 'Save changes' : draftLegs.length > 0 ? 'Create relay' : eventKind === 'non_revenue' ? 'Create event' : 'Create load'}
                  </button>
                )}
              </div>
            </div>
          )}
        </form>
        </div>{/* end form pane / drop zone */}

        {/* ── Driver summary pane (right) — copy-pasteable summary for
            driver group chats. Hidden by default; toggled via the
            "Driver Summary" button in the toolbar. */}
        {showDriverSummary && isEdit && (() => {
          const currentEv = modalEventId ? events.find(e => e.id === modalEventId) : undefined;
          const summaryEvent = {
            title,
            start: startDate && startTime ? `${startDate}T${startTime}` : undefined,
            end:   endDate && endTime   ? `${endDate}T${endTime}`     : undefined,
            loadNum: typeof fieldValues['loadNum'] === 'string' ? fieldValues['loadNum'] as string : undefined,
            refNums: Array.isArray(fieldValues['refNums']) ? fieldValues['refNums'] as RefNum[] : undefined,
            trailerType: typeof fieldValues['trailerType'] === 'string' ? fieldValues['trailerType'] as string : undefined,
            stops,
            notes: currentEv?.notes ?? (typeof fieldValues['notes'] === 'string' ? fieldValues['notes'] as string : undefined),
            specialInstructions: currentEv?.specialInstructions,
          };
          const summaryAsset   = assets.find(a => a.id === assetId);
          const summaryTrailer = linkedTrailerId != null ? trailers.find(t => t.id === linkedTrailerId) : undefined;
          return (
            <DriverSummaryPanel
              event={summaryEvent}
              asset={summaryAsset}
              trailer={summaryTrailer}
              driverName={driverName || undefined}
              onClose={() => setShowDriverSummary(false)}
            />
          );
        })()}
      </div>{/* end modal box */}
    </div>{/* end backdrop */}
    {showBrokerProfile && (() => {
      const brokerVal = String(fieldValues['broker'] ?? '');
      const linkedCustomer = customers.find(c => c.name === brokerVal);
      if (!linkedCustomer) return null;
      return (
        <BrokerProfileModal
          initialBrokerId={linkedCustomer.id}
          onClose={() => setShowBrokerProfile(false)}
        />
      );
    })()}

    {/* Cancel load dialog — three destructive paths plus exit.
        Layered at z-240 so it sits above EventModal main (z-200) and
        its inline confirm dialogs (z-220) but below the document
        delete dialog. */}
    {cancelDialogOpen && (
      <div className="fixed inset-0 flex items-center justify-center px-4"
        style={{ background: 'rgba(0,0,0,0.5)', zIndex: 240 }}
        onMouseDown={e => { if (e.target === e.currentTarget) setCancelDialogOpen(false); }}>
        <div className="rounded-2xl flex flex-col w-full"
          style={{
            maxWidth:   480,
            background: 'var(--gc-surface)',
            boxShadow:  '0 16px 48px rgba(0,0,0,0.25)',
            border:     '1px solid var(--gc-border)',
            overflow:   'hidden', // clip the footer's bg so it doesn't poke past rounded corners
          }}>
          {/* Header */}
          <div className="flex items-start gap-3 px-5 pt-5 pb-3">
            <div className="flex items-center justify-center flex-shrink-0 rounded-full"
              style={{ width: 36, height: 36, background: '#fce8e6', color: '#d93025' }}>
              <AlertTriangle size={18} />
            </div>
            <div className="flex-1">
              <div className="text-[16px] font-extrabold" style={{ color: 'var(--gc-text-1)' }}>
                Cancel this load?
              </div>
            </div>
          </div>

          {/* Three action rows. Icons sit in saturated brand-tint
              squares with white glyphs — same pattern the rest of the
              app uses for callout chips. Body text bumped to gc-text-2
              so it doesn't read as a muted afterthought. */}
          <div className="flex flex-col gap-2 px-5 pb-2">
            <button type="button" onClick={handleCancelMarkStatus}
              className="flex items-start gap-3 text-left px-4 py-3 rounded-lg transition-colors"
              style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-surface)')}>
              <div className="flex items-center justify-center flex-shrink-0 rounded-lg mt-0.5"
                style={{ width: 32, height: 32, background: 'var(--gc-blue)', color: '#fff' }}>
                <Calendar size={15} />
              </div>
              <div className="flex-1">
                <div className="text-[13px] font-extrabold" style={{ color: 'var(--gc-text-1)' }}>
                  Mark cancelled (keep on calendar)
                </div>
                <div className="text-[12px] mt-0.5" style={{ color: 'var(--gc-text-2)' }}>
                  Event stays greyed out. Rate, miles, and driver pay zero out — still shows in payroll so you can add TONU/layover pay.
                </div>
              </div>
            </button>

            <button type="button" onClick={handleCancelPermanent}
              className="flex items-start gap-3 text-left px-4 py-3 rounded-lg transition-colors"
              style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-surface)')}>
              <div className="flex items-center justify-center flex-shrink-0 rounded-lg mt-0.5"
                style={{ width: 32, height: 32, background: '#d93025', color: '#fff' }}>
                <AlertCircle size={15} />
              </div>
              <div className="flex-1">
                <div className="text-[13px] font-extrabold" style={{ color: 'var(--gc-text-1)' }}>
                  Move to Recently Deleted
                </div>
                <div className="text-[12px] mt-0.5" style={{ color: 'var(--gc-text-2)' }}>
                  Removes the event and the load record. Restorable from Trash for 30 days.
                </div>
              </div>
            </button>
          </div>

          {/* Footer — exit only */}
          <div className="flex items-center justify-end gap-2 px-5 py-4 mt-2"
            style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
            <button type="button" onClick={() => setCancelDialogOpen(false)}
              className="text-[13px] font-bold px-4 py-2 rounded-lg transition-colors"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-surface)')}>
              Never mind
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Remove confirm — shown when a cancelled load needs to come off
        the board. The "keep load record" path was removed (we now
        only support Mark Cancelled + Move to Recently Deleted), so
        this collapsed to a single confirm. */}
    {/* Drastic-change gate for the leg reconcile. Appears ONLY when a
        save would delete a leg that carries work (driver, pay, status
        past assigned, or documents) — routine removal of an untouched
        leg saves without interruption. Confirming is what sets
        `force: true` on the PUT. */}
    {legRemovalConfirm && (
      <ConfirmDialog
        title={legRemovalConfirm.surplus ? 'Clear extra legs from this load?' : 'Remove a leg from this load?'}
        message={legRemovalConfirm.message}
        confirmLabel={legRemovalConfirm.surplus ? 'Clear extra legs and save' : 'Remove leg and save'}
        cancelLabel={legRemovalConfirm.surplus ? "Leave them for now" : "Keep the leg"}
        destructive
        zIndex={240}
        onCancel={() => { setLegRemovalConfirm(null); legRemovalResolver.current?.(false); legRemovalResolver.current = null; }}
        onConfirm={() => { setLegRemovalConfirm(null); legRemovalResolver.current?.(true); legRemovalResolver.current = null; }}
      />
    )}

    {removeDialogOpen && (
      <ConfirmDialog
        title="Move to Recently Deleted?"
        message="Removes the event and the load record. Restorable from Trash for 30 days."
        confirmLabel="Move to Recently Deleted"
        cancelLabel="Never mind"
        destructive
        zIndex={240}
        onCancel={() => setRemoveDialogOpen(false)}
        onConfirm={() => { handleCancelPermanent(); setRemoveDialogOpen(false); }}
      />
    )}

    {/* Closeout review panel launched from the load modal. Resolves
        the relay pickup leg before launching since ReviewQueue's
        meta + relay-partner lookup assumes pickup leg. Stacked at
        z-250 — above EventModal main (z-200) and its confirm
        dialogs (z-220). On successful release/flag we refetch the
        load and merge into the calendar store so the modal's
        billing status pill reflects the new state without a full
        page refresh. */}
    {reviewQueueOpen && (() => {
      const currentEv = modalEventId ? events.find(e => e.id === modalEventId) : undefined;
      if (!currentEv) return null;
      // On any non-first leg, resolve to leg 0 (the pickup leg) —
      // ReviewQueue's meta + relay lookups assume it.
      const reviewLoad: CalendarEvent =
        currentEv.relayRole && currentEv.relayRole !== 'pickup' && currentEv.loadId
          ? (events.filter(e => e.loadId === currentEv.loadId).sort(byLegIndex)[0] ?? currentEv)
          : currentEv;
      return (
        <ReviewQueue
          loads={[reviewLoad]}
          zIndex={250}
          onClose={() => setReviewQueueOpen(false)}
          onLoadResolved={async (loadId) => {
            try {
              const { loads } = await import('@/lib/railway').then(m => m.railway.getLoad(loadId));
              mergeEvents(loads as CalendarEvent[]);
            } catch (err) {
              console.error('[EventModal] post-review refetch failed:', err);
            }
          }}
        />
      );
    })()}
    </>
  );
}
