'use client';

import { useEffect, useRef, useState } from 'react';
import { X, Trash2, Calendar, ArrowLeftRight, FileText, Loader2, CheckCircle2, AlertCircle, AlertTriangle, Copy, Eye, Paperclip, Download, Plus, Phone, MapPin, RefreshCw, Star, Clock, ExternalLink, Pin, Play } from 'lucide-react';
import ReviewQueue from '@/components/closeout/ReviewQueue';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { useUser } from '@clerk/nextjs';
import { usePermissions } from '@/lib/usePermissions';
import { useCalendarStore } from '@/store/useCalendarStore';
import Tooltip from '@/components/ui/Tooltip';
import { localDateStr, parseTimeInput } from '@/lib/time-utils';
import type { CalendarEvent, Driver, EventStatus, Accessorial, Stop, RefNum, LoadAuditEntry, AccessorialChange, CustomerMatchResult } from '@/lib/types';
import { NON_REVENUE_TYPES } from '@/lib/types';
import { matchCustomer, buildBrokerRules } from '@/lib/customerMatch';
import { cleanBrokerName } from '@/lib/brokerName';
import { NewBrokerReviewModal } from './NewBrokerReviewModal';
import { LOAD_ACCENT, LOAD_ACCENT_BG, LOAD_ACCENT_BG_HOVER, LOAD_ACCENT_BORDER, LOAD_ACCENT_HOVER } from '@/lib/loadAccent';
import { generateLoadTitle } from '@/lib/generateTitle';
import { ALL_FIELDS, FieldDef, getEnabledFieldsForSection, SECTION_LABELS } from '@/lib/fields';
import DatePicker from './DatePicker';
import StopsSection from './StopsSection';
import RouteMapPanel from './RouteMapPanel';
import DriverSummaryPanel from './DriverSummaryPanel';
import NotifyDriverPopover from './NotifyDriverPopover';
import { uploadRateCon } from '@/lib/storage';
import BrokerProfileModal from '@/components/brokers/BrokerProfileModal';
import CheckCallsSection from '@/components/calendar/CheckCallsSection';
import { HandoffPhotosButton } from '@/components/calendar/RelayHandoffPhotos';

const RELAY_COLOR = '#7c3aed';

function fmtRelayTime(iso: string): string {
  const m = iso.match(/T(\d{2}):(\d{2})$/);
  if (!m) return iso;
  const h = parseInt(m[1]), min = m[2];
  return `${h % 12 || 12}:${min} ${h >= 12 ? 'PM' : 'AM'}`;
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

function SmartTimeInput({ value, onChange, placeholder = '8am, 1:30pm', headerColor }: {
  value: string; onChange: (v: string) => void; placeholder?: string; headerColor: string;
}) {
  const [raw, setRaw] = useState(value);
  useEffect(() => { setRaw(value); }, [value]);
  const commit = () => {
    const parsed = parseTimeInput(raw);
    if (parsed) { setRaw(parsed); onChange(parsed); }
    else setRaw(value);
  };
  return (
    <input type="text" value={raw} onChange={e => setRaw(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
      placeholder={placeholder}
      style={{ width: 120, minWidth: 120, border: '1px solid var(--gc-border)', borderRadius: 8, padding: '10px 12px', fontSize: 15, color: 'var(--gc-text-1)', outline: 'none', cursor: 'text', transition: 'border-color 150ms', background: 'var(--gc-surface)' }}
      onFocus={e => { const el = e.currentTarget; requestAnimationFrame(() => el.select()); el.style.borderColor = headerColor; }}
      onBlur={e => { commit(); e.currentTarget.style.borderColor = 'var(--gc-border)'; }}
    />
  );
}

function inputStyle(): React.CSSProperties {
  return { border: '1px solid var(--gc-border)', borderRadius: 8, padding: '10px 12px', fontSize: 15, color: 'var(--gc-text-1)', outline: 'none', background: 'var(--gc-surface)', width: '100%', transition: 'border-color 150ms', cursor: 'auto' };
}

function CopyLabelBtn({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button"
      onClick={() => { navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
      style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4, cursor: 'pointer', border: '1px solid var(--gc-border)', background: 'var(--gc-bg)', color: copied ? '#15803d' : 'var(--gc-text-3)', transition: 'color 120ms' }}>
      {copied ? '✓ Copied' : 'Copy'}
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

const PRESET_REF_LABELS = ['Pickup #', 'Delivery #', 'BOL', 'PO #', 'PRO #', 'Order #'];

function RefNumsField({ value, onChange, headerColor }: { value: RefNum[]; onChange: (v: RefNum[]) => void; headerColor: string }) {
  const [draftLabel, setDraftLabel] = useState('');
  const [draftValue, setDraftValue] = useState('');
  const [copiedIdx, setCopiedIdx]   = useState<number | null>(null);
  const [confirmIdx, setConfirmIdx] = useState<number | null>(null);
  const [lastRemoved, setLastRemoved] = useState<{ ref: RefNum; idx: number } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valueRef = useRef<HTMLInputElement>(null);

  const commit = () => {
    const v = draftValue.trim();
    if (!v) return;
    onChange([...value, { label: draftLabel.trim(), value: v }]);
    setDraftLabel(''); setDraftValue('');
  };

  const remove = (i: number) => {
    setLastRemoved({ ref: value[i], idx: i });
    onChange(value.filter((_, idx) => idx !== i));
    setConfirmIdx(null);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setLastRemoved(null), 5000);
  };

  const undo = () => {
    if (!lastRemoved) return;
    const next = [...value];
    next.splice(lastRemoved.idx, 0, lastRemoved.ref);
    onChange(next);
    setLastRemoved(null);
    if (undoTimer.current) clearTimeout(undoTimer.current);
  };

  const copy = (ref: RefNum, i: number) => {
    // Copy the value only — the label is just a UI hint and pasting it
    // into another system (broker portal, BOL, etc.) is rarely useful.
    navigator.clipboard.writeText(ref.value).then(() => {
      setCopiedIdx(i);
      setTimeout(() => setCopiedIdx(null), 1500);
    });
  };

  const inp: React.CSSProperties = {
    border: '1px solid var(--gc-border)', borderRadius: 6,
    padding: '5px 8px', fontSize: 13, outline: 'none',
    color: 'var(--gc-text-1)', background: 'var(--gc-surface)',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Existing ref badges */}
      {value.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {value.map((ref, i) => (
            confirmIdx === i ? (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 8, background: '#fee2e2', border: '1px solid #fca5a5', fontSize: 12 }}>
                <span style={{ color: '#991b1b', fontWeight: 600, whiteSpace: 'nowrap' }}>Remove?</span>
                <button type="button" onClick={() => remove(i)}
                  style={{ background: '#d93025', border: 'none', borderRadius: 4, cursor: 'pointer', padding: '1px 7px', fontSize: 11, fontWeight: 700, color: '#fff' }}>
                  Yes
                </button>
                <button type="button" onClick={() => setConfirmIdx(null)}
                  style={{ background: 'none', border: '1px solid #fca5a5', borderRadius: 4, cursor: 'pointer', padding: '1px 7px', fontSize: 11, fontWeight: 600, color: '#991b1b' }}>
                  No
                </button>
              </div>
            ) : (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px 3px 6px', borderRadius: 8, background: LOAD_ACCENT_BG, border: `1px solid ${LOAD_ACCENT_BORDER}`, fontSize: 12 }}>
                <button type="button" onClick={() => setConfirmIdx(i)} title="Remove"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', display: 'flex', alignItems: 'center', color: 'var(--gc-text-3)', transition: 'color 120ms' }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#d93025')}
                  onMouseLeave={e => (e.currentTarget.style.color = 'var(--gc-text-3)')}>
                  <X size={10} />
                </button>
                <span style={{ fontWeight: 600, color: 'var(--gc-text-1)', whiteSpace: 'nowrap' }}>
                  {ref.label ? <><span style={{ color: 'var(--gc-text-3)' }}>{ref.label}</span>{' '}{ref.value}</> : ref.value}
                </span>
                <button type="button" onClick={() => copy(ref, i)} title="Copy"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', display: 'flex', alignItems: 'center', color: copiedIdx === i ? '#15803d' : 'var(--gc-text-3)', transition: 'color 120ms' }}>
                  <Copy size={10} />
                </button>
              </div>
            )
          ))}
        </div>
      )}
      {/* Undo row */}
      {lastRemoved && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>
            Removed {lastRemoved.ref.label ? `${lastRemoved.ref.label} ${lastRemoved.ref.value}` : lastRemoved.ref.value}
          </span>
          <button type="button" onClick={undo}
            style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, border: '1px solid var(--gc-border)', background: 'var(--gc-bg)', color: 'var(--gc-text-2)', cursor: 'pointer' }}>
            ↩ Undo
          </button>
        </div>
      )}

      {/* Add row: [label] [number] [Add] */}
      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
        <input
          type="text" value={draftLabel} onChange={e => setDraftLabel(e.target.value)}
          placeholder="Type (e.g. BOL)"
          style={{ ...inp, width: 120, flexShrink: 0 }}
          onFocus={e => (e.currentTarget.style.borderColor = headerColor)}
          onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); valueRef.current?.focus(); } }}
        />
        <input
          ref={valueRef} type="text" value={draftValue} onChange={e => setDraftValue(e.target.value)}
          placeholder="Number"
          style={{ ...inp, flex: 1 }}
          onFocus={e => (e.currentTarget.style.borderColor = headerColor)}
          onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
        />
        <button type="button" onClick={commit} disabled={!draftValue.trim()}
          style={{ flexShrink: 0, padding: '5px 10px', borderRadius: 6, border: 'none', background: draftValue.trim() ? headerColor : 'var(--gc-hover)', color: draftValue.trim() ? '#fff' : 'var(--gc-text-3)', fontSize: 12, fontWeight: 600, cursor: draftValue.trim() ? 'pointer' : 'default', transition: 'background 150ms' }}>
          Add
        </button>
      </div>

      {/* Preset chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {PRESET_REF_LABELS.map(label => (
          <button key={label} type="button"
            onClick={() => { setDraftLabel(label); valueRef.current?.focus(); }}
            style={{ fontSize: 10, padding: '2px 8px', borderRadius: 8, border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-3)', cursor: 'pointer', transition: 'border-color 150ms, color 150ms' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = headerColor; e.currentTarget.style.color = headerColor; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--gc-border)'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}
          >{label}</button>
        ))}
      </div>
    </div>
  );
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

/** Number input prefixed with $. Empty string = unset (omitted on save). */
function NumberInputWithDollar({ value, onChange, headerColor }: {
  value: number | '';
  onChange: (v: number | '') => void;
  headerColor: string;
}) {
  return (
    <div style={{ position: 'relative' }}>
      <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--gc-text-3)', fontSize: 13, pointerEvents: 'none' }}>$</span>
      <input
        type="number"
        inputMode="decimal"
        step="0.01"
        value={value}
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
        style={{ border: '1px solid var(--gc-border)', padding: '8px 10px 8px 22px', color: 'var(--gc-text-1)', background: 'var(--gc-surface)' }}
        onFocus={e => (e.currentTarget.style.borderColor = headerColor)}
        onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
      />
    </div>
  );
}

const PDF_ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];

// Renders a PDF data URL to canvas elements via PDF.js with zoom controls.
function UploadedDocsPanel({
  docs, invoices, selectedId, onSelect, signedUrl, headerColor, loadId, onChange,
}: {
  docs: import('@/lib/db').LoadDocument[];
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
}) {
  const addFileRef = useRef<HTMLInputElement>(null);
  // Two-stage upload: pick file → choose kind → commit. Pending file
  // stays in state so the user can change kind without re-picking.
  const [pendingFile,   setPendingFile]   = useState<File | null>(null);
  const [uploading,     setUploading]     = useState(false);
  const [uploadError,   setUploadError]   = useState<string | null>(null);
  const [deletingId,    setDeletingId]    = useState<string | null>(null);

  const KIND_UPLOAD_OPTIONS: ReadonlyArray<{ kind: import('@fleetcal/types').DocumentKind; label: string }> = [
    { kind: 'pod',           label: 'POD' },
    { kind: 'rate_con',      label: 'Rate Con' },
    { kind: 'bol',           label: 'BOL' },
    { kind: 'lumper',        label: 'Lumper' },
    { kind: 'scale',         label: 'Scale' },
    { kind: 'receipt',       label: 'Receipt' },
    { kind: 'driver_sheet',  label: 'Driver Sheet' },
    { kind: 'invoice',       label: 'Invoice' },
    { kind: 'relay_handoff', label: 'Relay Handoff' },
    { kind: 'other',         label: 'Other' },
  ];

  const uploadAs = async (kind: import('@fleetcal/types').DocumentKind) => {
    if (!pendingFile || !loadId || uploading) return;
    setUploading(true);
    setUploadError(null);
    try {
      const { railway } = await import('@/lib/railway');
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
    return (
      <div className="flex-1 flex flex-col" style={{ background: 'var(--gc-bg)' }}>
        {uploadHeader}
        <div className="flex-1 flex items-center justify-center text-sm" style={{ color: 'var(--gc-text-3)' }}>
          No documents uploaded for this load yet.
        </div>
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
            <button key={d.id} type="button" onClick={() => onSelect(d.id)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors"
              style={{ borderBottom: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-surface)')}>
              <div className="flex items-center justify-center" style={{ width: 36, height: 36, borderRadius: 8, background: tint.bg, flexShrink: 0, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
                <FileText size={16} style={{ color: tint.fg }} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2" style={{ marginBottom: 2 }}>
                  <span className="text-[10px] font-extrabold uppercase tracking-wider" style={{ color: tint.fg, background: tint.bg, padding: '2px 7px', borderRadius: 999 }}>
                    {KIND_LABEL[d.kind] ?? d.kind}
                  </span>
                </div>
                <div className="text-sm font-bold truncate" style={{ color: 'var(--gc-text-1)' }}>{d.fileName}</div>
                <div className="text-xs font-medium" style={{ color: 'var(--gc-text-3)' }}>{fmt(d.uploadedAt)}</div>
              </div>
            </button>
          );
        })}
        </div>
      </div>
    );
  }

  // Viewer — when a doc is selected
  return (
    <div className="flex-1 flex flex-col" style={{ background: 'var(--gc-bg)' }}>
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
          <a href={signedUrl} target="_blank" rel="noopener noreferrer" download={selected.fileName}
            className="text-xs font-medium px-2 py-1 rounded transition-colors"
            style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border-light)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <Download size={11} style={{ display: 'inline', marginRight: 4 }} /> Download
          </a>
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
      <div className="flex-1 overflow-auto flex items-center justify-center" style={{ background: '#1a1a1a' }}>
        {!signedUrl ? (
          <Loader2 size={20} className="animate-spin" style={{ color: '#ffffff' }} />
        ) : isImage(selected.mimeType, selected.fileName) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={signedUrl} alt={selected.fileName} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        ) : (
          <iframe src={signedUrl} title={selected.fileName} style={{ width: '100%', height: '100%', border: 'none', background: '#ffffff' }} />
        )}
      </div>
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

function StyledSelect({ value, onChange, onFocus, onBlur, style, children }: {
  value: string | number;
  onChange: React.ChangeEventHandler<HTMLSelectElement>;
  onFocus?: React.FocusEventHandler<HTMLSelectElement>;
  onBlur?: React.FocusEventHandler<HTMLSelectElement>;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <div style={{ position: 'relative' }}>
      <select value={value} onChange={onChange} onFocus={onFocus} onBlur={onBlur}
        style={{ ...style, appearance: 'none', WebkitAppearance: 'none', paddingRight: 36 } as React.CSSProperties}>
        {children}
      </select>
      <div style={{ position: 'absolute', right: 11, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--gc-text-3)', display: 'flex' }}>
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          <path d="M1.5 3.5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
    </div>
  );
}

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
function CustomerCombobox({ value, onChange, customers, inputRef, accentColor, onCreateNew }: {
  value: string;
  onChange: (val: string) => void;
  customers: import('@/lib/types').Customer[];
  inputRef?: React.RefObject<HTMLInputElement | null>;
  accentColor?: string;
  onCreateNew?: (name: string) => Promise<void> | void;
}) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const style = inputStyle();

  // Sync external value changes (e.g. from rate con parse)
  useEffect(() => { setQuery(value); }, [value]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const filtered = query.trim()
    ? customers.filter(c =>
        c.name.toLowerCase().includes(query.toLowerCase()) ||
        c.aliases.some(a => a.toLowerCase().includes(query.toLowerCase()))
      )
    : customers;

  const isLinked = customers.some(c => c.name === value);

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <div style={{ position: 'relative' }}>
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type="text"
          value={query}
          placeholder="Search customers…"
          style={{ ...style, paddingRight: 28 }}
          onFocus={e => { setOpen(true); if (accentColor) e.currentTarget.style.borderColor = accentColor; }}
          onChange={e => {
            setQuery(e.target.value);
            onChange(e.target.value);
            setOpen(true);
          }}
          onBlur={blurColor}
        />
        {isLinked ? (
          <CheckCircle2 size={13} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', color: '#16a34a', pointerEvents: 'none' }} />
        ) : value.trim() ? (
          <AlertCircle size={13} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', color: '#f59e0b', pointerEvents: 'none' }} />
        ) : null}
      </div>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
          background: '#1e2433', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 10, marginTop: 4, maxHeight: 200, overflowY: 'auto',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        }}>
          {filtered.map(c => (
            <button
              key={c.id}
              type="button"
              onMouseDown={e => {
                e.preventDefault();
                setQuery(c.name);
                onChange(c.name);
                setOpen(false);
              }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '9px 12px', background: 'none', border: 'none',
                cursor: 'pointer', color: 'rgba(255,255,255,0.85)', fontSize: 13,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            >
              {c.name}
              {c.aliases.length > 0 && (
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginLeft: 6 }}>
                  aka {c.aliases.slice(0, 2).join(', ')}
                </span>
              )}
            </button>
          ))}
          {onCreateNew && query.trim() && !customers.some(c => c.name.toLowerCase() === query.trim().toLowerCase()) && (
            <button
              type="button"
              onMouseDown={async e => {
                e.preventDefault();
                setOpen(false);
                await onCreateNew(query.trim());
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
                padding: '9px 12px', background: 'none', border: 'none',
                borderTop: filtered.length > 0 ? '1px solid rgba(255,255,255,0.08)' : 'none',
                cursor: 'pointer', color: '#60a5fa', fontSize: 13, fontWeight: 700,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            >
              <Plus size={13} /> Add &ldquo;{query.trim()}&rdquo;
            </button>
          )}
        </div>
      )}
    </div>
  );
}

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
    assets, events, drivers, driverPrefs, currentDate,
    modalOpen, modalMode, modalEventId, modalDefaults, modalShowMap, modalConflict, clearModalConflict,
    addEvent, updateEvent, removeEvent, cancelEventKeepLoad, closeModal,
    openEditModal, openCreateModal,
    createRelayPair, splitToRelay, saveRelayBoth, removeRelay,
    fieldSettings, sectionOrder, promptInstructions, promptVariables,
    batchItems, batchIndex, batchNext, clearBatch,
    orgId, dispatchers, customers, addCustomer, addCustomerAlias, addCustomerContact, updateCustomer,
    trailers,
    driverPayPct,
    eldLocations,
    mergeEvents,
  } = useCalendarStore();

  const { user } = useUser();
  const currentUserName = user?.fullName ?? user?.firstName ?? 'Unknown';
  // Driver-pay visibility — Dispatcher and Maintenance roles don't
  // get to see what we're paying drivers. The input is removed from
  // the financial section's field list (and from the relay per-leg
  // pay block) when this is false.
  const { can: canDo } = usePermissions();
  const canViewDriverPay = canDo('loads.view_driver_pay');

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

  // Core fields (always visible)
  const [title,      setTitle]      = useState('');
  const [assetId,    setAssetId]    = useState(assets[0]?.id ?? 1);
  const [driverName, setDriverName] = useState('');
  const [startDate,  setStartDate]  = useState('');
  const [startTime,  setStartTime]  = useState('08:00');
  const [endDate,    setEndDate]    = useState('');
  const [endTime,    setEndTime]    = useState('17:00');
  const [status,     setStatus]     = useState<EventStatus>('scheduled');
  const [priority,   setPriority]   = useState(false);
  const [eventKind,  setEventKind]  = useState<'revenue' | 'non_revenue'>('revenue');
  const [nonRevenueType, setNonRevenueType] = useState<string>('Maintenance');
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
  const totalBillable = accessorials.filter(a => a.billable).reduce((sum, a) => sum + (a.amount || 0), 0);

  // Dirty tracking
  const [isDirty,        setIsDirty]        = useState(false);
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [savePromptAfterNav, setSavePromptAfterNav] = useState<string | null>(null); // relay partner id to open after save
  const [dupLoadNum,     setDupLoadNum]     = useState<string | null>(null); // load# that triggered duplicate warning
  const [pendingSave,    setPendingSave]    = useState<'single' | 'batch' | null>(null);
  const [geocodeBlock,   setGeocodeBlock]   = useState<'single' | 'batch' | null>(null); // save target when ungeocoded stops detected
  const markDirty = () => setIsDirty(true);

  // Shift stop appointment times when the start date changes (duplicate/+1 Week flow).
  // Only manipulates the date portion — time portion is preserved as-is to avoid
  // UTC↔local conversion errors (new Date(localIso).toISOString() shifts by TZ offset).
  useEffect(() => {
    const prev = prevStartDateRef.current;
    if (!prev || !startDate || prev === startDate) { prevStartDateRef.current = startDate; return; }
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
  const [partnerLoadedMiles, setPartnerLoadedMiles] = useState<number | null>(null);
  const [parseError, setParseError] = useState('');
  const [brokerMatch, setBrokerMatch] = useState<CustomerMatchResult>({ status: 'none' });
  const [brokerSaveBlocked, setBrokerSaveBlocked] = useState(false);
  // Pass-1 broker profile from the rate-con parser. Used to pre-fill MC#,
  // contact info, and invoice instructions when the broker isn't yet a
  // customer and the user clicks "Save as customer."
  const [parsedBrokerProfile, setParsedBrokerProfile] = useState<import('@/lib/prompt').BrokerProfile | undefined>(undefined);
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
      const [docs, invRes] = await Promise.all([
        fetchLoadDocuments(ev.loadId!, orgId),
        railway.listInvoices({ loadId: ev.loadId! }).catch(() => ({ invoices: [] })),
      ]);
      if (cancelled) return;
      setLoadDocuments(docs);
      setLoadInvoices(invRes.invoices);
    })();
    return () => { cancelled = true; };
  }, [showPdfViewer, modalEventId, orgId, loadDocuments.length, loadInvoices.length, events]);

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


  // Relay state
  const [relayGroupId,       setRelayGroupId]       = useState<string | undefined>(undefined);
  const [relayRole,          setRelayRole]          = useState<'pickup' | 'delivery' | undefined>(undefined);
  const [relayActive,        setRelayActive]        = useState(false);
  const [confirmRelayRemove, setConfirmRelayRemove] = useState(false);
  const [relayPartner,       setRelayPartner]       = useState<CalendarEvent | null>(null);

  const [relayDelivAssetId,       setRelayDelivAssetId]       = useState(assets[0]?.id ?? 1);
  const [relayDelivDriverName,    setRelayDelivDriverName]    = useState('');
  // Per-leg driver pay for relay loads. The single fieldValues['driverPay']
  // is hidden when in relay context; these two drive both UI and save.
  const [pickupDriverPay,   setPickupDriverPay]   = useState<number | ''>('');
  const [deliveryDriverPay, setDeliveryDriverPay] = useState<number | ''>('');

  const isPickupLeg   = isEdit && relayRole === 'pickup';
  const isDeliveryLeg = isEdit && relayRole === 'delivery';
  const isRelayContext = relayActive || isPickupLeg || isDeliveryLeg;

  // Compute loaded mileage from geocoded stops via Mapbox Directions.
  // For relay legs, only count stops up to (pickup) or from (delivery) the relay handoff.
  // Skipped when status is 'tonu' or 'cancelled' (load didn't move → 0 miles).
  useEffect(() => {
    if (status === 'tonu' || status === 'cancelled') {
      setLoadedMiles(0);
      return;
    }
    const relayIdx = stops.findIndex(s => s.type === 'relay');
    let legStops: typeof stops;
    if (relayIdx === -1) {
      legStops = stops;
    } else if (relayRole === 'pickup') {
      legStops = stops.slice(0, relayIdx + 1);
    } else if (relayRole === 'delivery') {
      legStops = stops.slice(relayIdx);
    } else {
      legStops = stops.filter(s => s.type !== 'relay');
    }
    const geocoded = legStops
      .filter(s => s.lat != null && s.lng != null)
      .map(s => ({ lat: s.lat!, lng: s.lng! }));
    if (geocoded.length < 2) { setLoadedMiles(null); return; }
    let cancelled = false;
    import('@/lib/directions').then(({ calcRoadMiles }) =>
      calcRoadMiles(geocoded).then(miles => { if (!cancelled) setLoadedMiles(miles); })
    );
    return () => { cancelled = true; };
  }, [stops, relayRole, status]);

  // Partner leg miles — for relay loads only, to compute total rate/mile correctly
  useEffect(() => {
    if (!relayPartner?.stops?.length || !relayRole) { setPartnerLoadedMiles(null); return; }
    const ps = relayPartner.stops;
    const relayIdx = ps.findIndex(s => s.type === 'relay');
    const legStops = relayRole === 'pickup'
      ? (relayIdx === -1 ? ps : ps.slice(relayIdx))         // partner is delivery: from relay onward
      : (relayIdx === -1 ? ps : ps.slice(0, relayIdx + 1)); // partner is pickup: up to relay
    const geocoded = legStops.filter(s => s.lat != null && s.lng != null).map(s => ({ lat: s.lat!, lng: s.lng! }));
    if (geocoded.length < 2) { setPartnerLoadedMiles(null); return; }
    let cancelled = false;
    import('@/lib/directions').then(({ calcRoadMiles }) =>
      calcRoadMiles(geocoded).then(m => { if (!cancelled) setPartnerLoadedMiles(m); })
    );
    return () => { cancelled = true; };
  }, [relayPartner, relayRole]);

  // ── Lazy cache: persist routed loadedMiles back to events.loaded_miles
  // so reports / dashboards can pull from the column instead of re-running
  // Google Directions. Fires once per modal-open when the computed value
  // differs from what's stored (rounded to 0.1 mi to avoid noisy writes).
  useEffect(() => {
    if (!isEdit || !modalEventId || loadedMiles == null) return;
    const ev = events.find(e => e.id === modalEventId);
    if (!ev) return;
    const stored = ev.loadedMiles ?? null;
    const next   = Math.round(loadedMiles * 10) / 10;
    if (stored != null && Math.abs(stored - next) < 0.1) return;
    void updateEvent(modalEventId, { loadedMiles: next });
  }, [loadedMiles, isEdit, modalEventId, events, updateEvent]);

  useEffect(() => {
    if (!relayPartner || partnerLoadedMiles == null) return;
    const stored = relayPartner.loadedMiles ?? null;
    const next   = Math.round(partnerLoadedMiles * 10) / 10;
    if (stored != null && Math.abs(stored - next) < 0.1) return;
    void updateEvent(relayPartner.id, { loadedMiles: next });
  }, [partnerLoadedMiles, relayPartner, updateEvent]);

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
    setFieldValues(vals);
    setRateConPdf(ev.rateConPdf ?? undefined);
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
    if (!modalOpen) { setConfirmDel(false); setConfirmRelayRemove(false); setConfirmRemoveRateCon(false); setConfirmSkip(false); setConfirmBatchCancel(false); setParseState('idle'); setParseError(''); setRateConPdf(undefined); setShowPdfViewer(false); setShowMapPanel(false); setIsDirty(false); setShowSavePrompt(false); setAccessorials([]); setStops([]); setBrokerMatch({ status: 'none' }); setBrokerSaveBlocked(false); setShowBrokerProfile(false); setDupLoadNum(null); setPendingSave(null); setGeocodeBlock(null); setLoadedMiles(null); setPartnerLoadedMiles(null); setShowDriverSummary(false); setLinkedTrailerId(undefined); setPriority(false); setEventKind('revenue'); setNonRevenueType('Maintenance'); setDocsTab('rateCon'); setLoadDocuments([]); setLoadInvoices([]); setSelectedDocUrl(null); setSelectedDocId(null); setAuditLog([]); setInternalNotes([]); setOriginalInternalNotes([]); setNoteComposer(''); setNoteComposerOpen(false); setParsedBrokerProfile(undefined); setPendingNewBroker(null); setPickupDriverPay(''); setDeliveryDriverPay(''); return; }
    setParseState('idle'); setParseError('');
    setRateConPdf(undefined); setShowPdfViewer(false); setShowMapPanel(modalShowMap);
    setIsDirty(false); setShowSavePrompt(false);
    setRelayGroupId(undefined); setRelayRole(undefined);
    setRelayActive(false); setRelayPartner(null);
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
        const localPartner = events.find(e =>
          e.id !== ev.id && (
            (ev.loadId && e.loadId === ev.loadId) ||
            (ev.relayGroupId && e.relayGroupId === ev.relayGroupId)
          ),
        ) ?? null;
        setRelayPartner(localPartner);
        if (ev.relayRole === 'pickup' && localPartner) {
          setRelayDelivAssetId(localPartner.assetId);
          setRelayDelivDriverName(localPartner.driverName ?? '');
        }
        // Seed both per-leg pays from whichever leg is which.
        if (ev.relayRole === 'pickup') {
          setPickupDriverPay(ev.driverPay ?? '');
          setDeliveryDriverPay(localPartner?.driverPay ?? '');
        } else if (ev.relayRole === 'delivery') {
          setDeliveryDriverPay(ev.driverPay ?? '');
          setPickupDriverPay(localPartner?.driverPay ?? '');
        }
        // Fallback: partner not in the loaded events window → fetch the load.
        if (!localPartner && ev.loadId) {
          import('@/lib/railway').then(({ railway }) => railway.getLoad(ev.loadId!))
            .then(({ loads }) => {
              const partner = loads.find(l => l.id !== ev.id) as CalendarEvent | undefined;
              if (!partner) return;
              setRelayPartner(partner);
              if (ev.relayRole === 'pickup') {
                setRelayDelivAssetId(partner.assetId);
                setRelayDelivDriverName(partner.driverName ?? '');
                setDeliveryDriverPay(partner.driverPay ?? '');
              } else if (ev.relayRole === 'delivery') {
                setPickupDriverPay(partner.driverPay ?? '');
              }
            })
            .catch(err => console.error('relay-partner fetch:', err));
        }
      }
    } else if (isBatch) {
      const batchItem = batchItems[batchIndex];
      if (batchItem) {
        const p = batchItem.parsed;
        // Stash the pass-1 broker harvest so the new-customer review modal
        // pre-fills MC#/contacts/invoice routing — same as the single-parse
        // path. Without this, batch-parsed loads always opened a blank
        // review form even when the AI extracted broker info.
        if (p.brokerProfile) setParsedBrokerProfile(p.brokerProfile as import('@/lib/prompt').BrokerProfile);
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
        setRelayDelivAssetId(assets[1]?.id ?? assets[0]?.id ?? 1);
        const vals: Record<string, string | number | boolean | string[] | RefNum[]> = {};
        ALL_FIELDS.forEach(f => {
          const v = p[f.id];
          if (v !== undefined) vals[f.id] = v as string | number | boolean;
        });
        setRateConPdf(batchItem.rateConPdf);
        setShowPdfViewer(true);
        if (Array.isArray(p.stops) && p.stops.length > 0) {
          setStops((p.stops as Stop[]).map((s, i) => ({ ...s, id: crypto.randomUUID(), eventId: '', sequence: i + 1 })));
        }
        // Run broker matching same as single-parse flow
        if (p.broker) {
          const match = matchCustomer(String(p.broker), customers);
          if (match.status === 'auto') {
            vals['broker'] = match.customer.name;
            if (String(p.broker).trim() !== match.customer.name) {
              void addCustomerAlias(match.customer.id, String(p.broker).trim());
            }
            // Same auto-append-contact behavior as the single-parse path.
            const bp = (p as Record<string, unknown>).brokerProfile as { contactName?: string; contactEmail?: string; contactPhone?: string } | undefined;
            if (bp && (bp.contactName || bp.contactEmail || bp.contactPhone)) {
              void addCustomerContact(match.customer.id, {
                name:  bp.contactName,
                email: bp.contactEmail,
                phone: bp.contactPhone,
              });
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
        if (defaultDispatcher && !vals['dispatcher']) vals['dispatcher'] = defaultDispatcher.name;
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
      setRelayDelivAssetId(assets[1]?.id ?? assets[0]?.id ?? 1);

      // Seed optional fields from defaults; auto-fill default dispatcher
      const vals: Record<string, string | number | boolean | string[] | RefNum[]> = {};
      ALL_FIELDS.forEach(f => {
        const v = (d as Record<string, unknown>)[f.id];
        if (v !== undefined) vals[f.id] = v as string | number | boolean;
      });
      const defaultDispatcher = dispatchers.find(d => d.isDefault);
      if (defaultDispatcher && !vals['dispatcher']) vals['dispatcher'] = defaultDispatcher.name;
      setFieldValues(vals);
      if (Array.isArray(d.stops) && d.stops.length > 0) {
        setStops((d.stops as Stop[]).map((s, i) => ({ ...s, id: crypto.randomUUID(), eventId: '', sequence: i + 1 })));
      }
    }
    setConfirmDel(false);
    setConfirmRelayRemove(false);
    setConfirmSkip(false);
    setConfirmBatchCancel(false);
  }, [modalOpen, modalEventId, batchIndex]); // eslint-disable-line react-hooks/exhaustive-deps

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
    return out;
  };

  function diffAccessorials(prev: Accessorial[] = [], next: Accessorial[] = []): AccessorialChange[] {
    const changes: AccessorialChange[] = [];
    const prevMap = new Map(prev.map(a => [a.id, a]));
    const nextMap = new Map(next.map(a => [a.id, a]));
    for (const [id, a] of nextMap) {
      if (!prevMap.has(id)) {
        changes.push({ action: 'added', category: a.category, description: a.description, amount: a.amount });
      } else {
        const p = prevMap.get(id)!;
        const amountChanged = (p.amount ?? 0) !== (a.amount ?? 0);
        const statusChanged = (p.status ?? '') !== (a.status ?? '');
        if (amountChanged || statusChanged) {
          changes.push({
            action: 'updated', category: a.category, description: a.description,
            ...(amountChanged ? { prevAmount: p.amount, amount: a.amount } : {}),
            ...(statusChanged ? { prevStatus: p.status, newStatus: a.status } : {}),
          });
        }
      }
    }
    for (const [id, a] of prevMap) {
      if (!nextMap.has(id)) {
        changes.push({ action: 'removed', category: a.category, description: a.description, amount: a.amount });
      }
    }
    return changes;
  }

  function buildAuditEntry(
    existing: CalendarEvent,
    next: { assetId: number; driverName?: string; newLoadPrice?: number; newDriverPay?: number; newStopCount: number; newAccessorials?: Accessorial[]; relayCreated?: boolean },
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
    const hasChanges = driverChanged || assetChanged || loadPriceChanged || driverPayChanged || stopsAdded > 0 || stopsRemoved > 0 || next.relayCreated || accessorialsChanged.length > 0;
    if (!hasChanges) return null;
    return {
      changedAt: new Date().toISOString(),
      changedByName: byName,
      ...(driverChanged          ? { prevDriverName: existing.driverName,  newDriverName: next.driverName }   : {}),
      ...(assetChanged           ? { prevAssetId:    existing.assetId,     newAssetId:    next.assetId }       : {}),
      ...(loadPriceChanged       ? { prevLoadPrice:  existing.loadPrice,   newLoadPrice:  next.newLoadPrice }  : {}),
      ...(driverPayChanged       ? { prevDriverPay:  existing.driverPay,   newDriverPay:  next.newDriverPay }  : {}),
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

  const doSave = async (opts?: { skipGeocodeCheck?: boolean }) => {
    if (!title.trim() || !startDate || !endDate) return;

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

    // Upload PDF to storage; drop it if upload fails to prevent oversized row
    let storedPdf: string | undefined = rateConPdf?.startsWith('data:') ? undefined : rateConPdf;
    if (rateConPdf?.startsWith('data:') && orgId) {
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
    // rate-con.
    const rateConField = storedPdf ?? null;
    const shared = { title: title.trim(), ...optionals, priority, trailerId: linkedTrailerId, rateConPdf: rateConField, accessorials: accessorials.length > 0 ? accessorials : undefined, stops, eventKind, nonRevenueType: eventKind === 'non_revenue' ? nonRevenueType : undefined, ...internalNoteFields };

    // Resolve the typed driverId FROM the current driverName string
    // so every save persists the FK as well as the legacy name. Without
    // this, loads written from this modal kept driver_id NULL and
    // downstream features (payroll grouping, the driver-link button on
    // reports, etc.) had to limp along matching by name — which breaks
    // the moment a driver is renamed. Same logic for the relay's
    // delivery leg.
    const driverId          = findDriverByName(driverName)?.id          ?? undefined;
    const relayDelivDriverId = findDriverByName(relayDelivDriverName)?.id ?? undefined;

    const relayStop = stops.find(s => s.type === 'relay');
    const pickupLegEnd      = relayStop?.apptStart ?? `${endDate}T${endTime}`;
    const deliveryLegStart  = relayStop?.apptEnd   ?? pickupLegEnd;

    // Per-leg driver pay derived from the dual inputs. Empty input ⇒
    // undefined so the API treats it as "no value" instead of zero.
    const pickupPay   = pickupDriverPay   === '' ? undefined : pickupDriverPay;
    const deliveryPay = deliveryDriverPay === '' ? undefined : deliveryDriverPay;

    if (isPickupLeg && relayPartner && relayGroupId) {
      const pickupUpdates: Partial<Omit<CalendarEvent, 'id'>> = {
        ...shared, assetId, driverName: driverName || undefined, driverId,
        start: `${startDate}T${startTime}`, end: pickupLegEnd,
        driverPay: pickupPay,
        status, relayGroupId, relayRole: 'pickup',
      };
      const deliveryUpdates: Partial<Omit<CalendarEvent, 'id'>> = {
        ...shared,
        assetId: relayDelivAssetId, driverName: relayDelivDriverName || undefined, driverId: relayDelivDriverId,
        start: deliveryLegStart,
        end: relayPartner.end,
        driverPay: deliveryPay,
        status: relayPartner.status ?? 'scheduled',
        relayGroupId, relayRole: 'delivery',
      };
      saveRelayBoth(modalEventId!, pickupUpdates, relayPartner.id, deliveryUpdates);

    } else if (isDeliveryLeg && relayPartner && relayGroupId) {
      const deliveryUpdates: Partial<Omit<CalendarEvent, 'id'>> = {
        ...shared, assetId, driverName: driverName || undefined, driverId,
        start: `${startDate}T${startTime}`, end: `${endDate}T${endTime}`,
        driverPay: deliveryPay,
        status, relayGroupId, relayRole: 'delivery',
      };
      const pickupUpdates: Partial<Omit<CalendarEvent, 'id'>> = {
        ...shared,
        assetId: relayPartner.assetId, driverName: relayPartner.driverName, driverId: relayPartner.driverId,
        start: relayPartner.start, end: pickupLegEnd,
        driverPay: pickupPay,
        status: relayPartner.status ?? 'scheduled',
        relayGroupId, relayRole: 'pickup',
      };
      saveRelayBoth(relayPartner.id, pickupUpdates, modalEventId!, deliveryUpdates);

    } else if (relayActive) {
      if (!relayStop?.apptStart) return;
      const rgId = crypto.randomUUID();
      const delivEndDate = deliveryLegStart.split('T')[0] > endDate ? deliveryLegStart.split('T')[0] : endDate;
      const existingEv = isEdit && modalEventId ? events.find(e => e.id === modalEventId) : undefined;
      const relayAuditLog = isEdit && existingEv ? appendAuditEntry(auditLog, buildAuditEntry(existingEv, { assetId, driverName: driverName || undefined, newLoadPrice: parseFloat(String(fieldValues['loadPrice'] ?? '')) || undefined, newDriverPay: parseFloat(String(fieldValues['driverPay'] ?? '')) || undefined, newStopCount: stops.length, newAccessorials: accessorials, relayCreated: true }, currentUserName)) : undefined;
      const pickupData: Omit<CalendarEvent, 'id'> = {
        ...shared, assetId, driverName: driverName || undefined, driverId,
        start: `${startDate}T${startTime}`, end: pickupLegEnd,
        driverPay: pickupPay,
        status, relayGroupId: rgId, relayRole: 'pickup',
        createdByName: isEdit ? (existingEv?.createdByName ?? currentUserName) : currentUserName,
        ...(isEdit ? { auditLog: relayAuditLog } : {}),
      };
      const deliveryData: Omit<CalendarEvent, 'id'> = {
        ...shared,
        assetId: relayDelivAssetId, driverName: relayDelivDriverName || undefined, driverId: relayDelivDriverId,
        start: deliveryLegStart, end: `${delivEndDate}T${endTime}`,
        driverPay: deliveryPay,
        status: 'scheduled', relayGroupId: rgId, relayRole: 'delivery',
        createdByName: currentUserName,
      };
      if (isEdit && modalEventId) {
        // Convert existing single load → relay. Both legs end up on the same
        // load (server-side via /v1/loads/:id/split-relay).
        splitToRelay(modalEventId, pickupData, deliveryData, delivId);
      } else {
        createRelayPair(pickupData, deliveryData, pickupId, delivId);
      }

    } else {
      const newDriverName = driverName || undefined;
      const existingEv = isEdit && modalEventId ? events.find(e => e.id === modalEventId) : undefined;
      const nextAuditLog = isEdit && existingEv
        ? appendAuditEntry(auditLog, buildAuditEntry(existingEv, { assetId, driverName: newDriverName, newLoadPrice: parseFloat(String(fieldValues['loadPrice'] ?? '')) || undefined, newDriverPay: parseFloat(String(fieldValues['driverPay'] ?? '')) || undefined, newStopCount: stops.length, newAccessorials: accessorials }, currentUserName))
        : undefined;

      const payload: Omit<CalendarEvent, 'id'> = {
        ...shared, assetId, driverName: newDriverName, driverId,
        start: `${startDate}T${startTime}`, end: `${endDate}T${endTime}`,
        status,
        createdByName: isEdit ? (existingEv?.createdByName ?? currentUserName) : currentUserName,
        ...(isEdit ? { auditLog: nextAuditLog } : {}),
      };
      isEdit && modalEventId ? updateEvent(modalEventId, payload) : addEvent(payload, newEventId);
    }
    closeModal();
  };

  const handleSave = (e: React.FormEvent) => { e.preventDefault(); void doSave(); };

  const handleBackdropClick = () => {
    if (isBatch) return;
    if (isDirty) setShowSavePrompt(true);
    else closeModal();
  };

  // Used by the explicit close affordances (X button, Cancel button).
  // Unlike the backdrop, these still work in batch mode.
  const attemptClose = () => {
    if (isDirty) setShowSavePrompt(true);
    else closeModal();
  };

  const handleDelete = () => {
    if (!confirmDel) { setConfirmDel(true); return; }
    if (modalEventId) {
      if (relayGroupId && relayPartner) {
        updateEvent(relayPartner.id, { ...relayPartner, relayGroupId: undefined, relayRole: undefined });
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
    if (relayGroupId && relayPartner) {
      updateEvent(relayPartner.id, {
        status: 'cancelled',
        loadPrice: 0,
        loadedMiles: 0,
        driverPay: 0,
        auditLog: appendAuditEntry(relayPartner.auditLog ?? [], entry),
      });
    }
    setCancelDialogOpen(false);
    closeModal();
  };
  const handleCancelRemoveEvent = () => {
    if (!modalEventId) return;
    if (relayGroupId && relayPartner) {
      // Drop the relay link on the partner first so it doesn't end up
      // half-orphaned, and zero its financials — the whole load is
      // being removed.
      updateEvent(relayPartner.id, {
        ...relayPartner,
        relayGroupId: undefined,
        relayRole: undefined,
        loadPrice: 0,
        loadedMiles: 0,
        driverPay: 0,
      });
    } else {
      // Single-leg load: zero rate on the load record before the
      // event row is deleted so the preserved load reads as cancelled.
      const evNow = events.find(e => e.id === modalEventId);
      if (evNow?.loadId) {
        const loadId = evNow.loadId;
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
    if (relayGroupId && relayPartner) {
      updateEvent(relayPartner.id, { ...relayPartner, relayGroupId: undefined, relayRole: undefined });
    }
    removeEvent(modalEventId, buildCancelAuditEntry('permanent'));
    setCancelDialogOpen(false);
    closeModal();
  };

  // ── Reinstate ───────────────────────────────────────────────────────
  // Flip a cancelled load back to its previous status. Pulls prev rate
  // + miles from the most recent loadCancelled audit entry so a misclick
  // is fully recoverable.
  const handleReinstate = () => {
    if (!modalEventId) return;
    const lastCancel = [...(auditLog ?? [])].reverse().find(e => e.loadCancelled?.mode === 'status');
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
    if (relayGroupId && relayPartner) {
      const partnerEntry: LoadAuditEntry = {
        changedAt: new Date().toISOString(),
        changedByName: currentUserName,
        loadReinstated: true,
        prevStatus: 'cancelled' as EventStatus,
        newStatus: prevStatus,
      };
      updateEvent(relayPartner.id, {
        status: prevStatus,
        ...(prevLP != null ? { loadPrice: prevLP } : {}),
        ...(prevLM != null ? { loadedMiles: prevLM } : {}),
        ...(prevDP != null ? { driverPay: prevDP } : {}),
        auditLog: appendAuditEntry(relayPartner.auditLog ?? [], partnerEntry),
      });
    }
    closeModal();
  };

  const handleRelayRemove = () => {
    if (!confirmRelayRemove) { setConfirmRelayRemove(true); return; }
    if (modalEventId) {
      const existingEv = events.find(e => e.id === modalEventId);
      const entry: LoadAuditEntry = { changedAt: new Date().toISOString(), changedByName: currentUserName, relayRemoved: true };
      const nextAuditLog = existingEv ? appendAuditEntry(auditLog, entry) : [entry];
      removeRelay(modalEventId, nextAuditLog);
    }
    closeModal();
  };

  const activateRelay = () => {
    setRelayActive(true);
    const delivAsset = assets.find(a => a.id !== assetId)?.id ?? assetId;
    setRelayDelivAssetId(delivAsset);
    setRelayDelivDriverName(preferredDriverName(delivAsset));

    // Insert a relay stop between the last leg-1 stop and first delivery stop
    // Default: Driver 2 pickup = 1hr before event end, Driver 1 drop = 1hr before that
    // Both are clamped to [eventStart, eventEnd] so short loads stay valid
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    const startDt = new Date(`${startDate}T${startTime}`);
    const endDt   = new Date(`${endDate || startDate}T${endTime || startTime}`);
    const spanMs  = endDt.getTime() - startDt.getTime();
    // For short loads, split the span into thirds instead of fixed 1-hr offsets
    const unit        = Math.min(60 * 60 * 1000, Math.floor(spanMs / 3));
    const driver2Pickup = new Date(Math.max(startDt.getTime(), endDt.getTime() - unit));
    const driver1Drop   = new Date(Math.max(startDt.getTime(), endDt.getTime() - 2 * unit));
    const relayStop: Stop = {
      id: crypto.randomUUID(),
      eventId: '',
      sequence: 0,
      type: 'relay',
      geocodeStatus: 'pending',
      apptStart: fmt(driver1Drop),
      apptEnd:   fmt(driver2Pickup),
    };
    let insertIdx = stops.length;
    for (let i = stops.length - 1; i >= 0; i--) {
      if (stops[i].type !== 'delivery' && stops[i].type !== 'drop_hook' && stops[i].type !== 'drop') { insertIdx = i + 1; break; }
      insertIdx = i;
    }
    const next = [...stops.slice(0, insertIdx), relayStop, ...stops.slice(insertIdx)];
    setStops(next.map((s, i) => ({ ...s, sequence: i + 1 })));
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
      ...s,
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
    openCreateModal({
      title: title || undefined, assetId, driverName: driverName || undefined,
      start: `${startDate}T${startTime}`, end: `${endDate}T${endTime}`,
      ...rest,
      accessorials: accessorials.length > 0 ? accessorials : undefined,
      stops: stops.length > 0 ? stops : undefined,
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
            // Send the full roster so pass 1 can pick the matching rule.
            // Server filters down to the one match before pass 2.
            customers: customers.map(c => ({
              name: c.name, aliases: c.aliases ?? [], parseHints: c.parseHints,
            })),
          }),
        });
        const parsed = await res.json();
        if (parsed.error) throw new Error(parsed.error);

        // Stash the broker profile from pass 1 so the new-customer CTAs
        // can pre-fill MC#, contact info, and invoice instructions.
        if (parsed.brokerProfile) setParsedBrokerProfile(parsed.brokerProfile);

        let resolvedBroker: string | undefined;
        if (parsed.loadNum) setField('loadNum', parsed.loadNum);
        if (parsed.refNums) setFieldValues(prev => ({ ...prev, refNums: parseAiRefNums(parsed.refNums) }));
        if (parsed.start) {
          const [sd, st = '08:00'] = parsed.start.split('T');
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
            if (String(parsed.broker).trim() !== match.customer.name) {
              void addCustomerAlias(match.customer.id, String(parsed.broker).trim());
            }
            // AI-extracted rep info from the rate con — append to the
            // matched customer's contacts[] if we don't already have a
            // contact with the same email/phone. Helps build out the
            // contact list passively over time.
            const bp = parsed.brokerProfile as { contactName?: string; contactEmail?: string; contactPhone?: string } | undefined;
            if (bp && (bp.contactName || bp.contactEmail || bp.contactPhone)) {
              void addCustomerContact(match.customer.id, {
                name:  bp.contactName,
                email: bp.contactEmail,
                phone: bp.contactPhone,
              });
            }
          } else {
            resolvedBroker = String(parsed.broker);
            setField('broker', parsed.broker);
          }
          setBrokerMatch(match);
        }
        if (parsed.trailerType) setField('trailerType', parsed.trailerType);
        if (parsed.specialInstructions) setField('specialInstructions', parsed.specialInstructions);
        const parsedStops: Stop[] = Array.isArray(parsed.stops) && parsed.stops.length > 0
          ? (parsed.stops as Stop[]).map((s, i) => ({ ...s, id: crypto.randomUUID(), eventId: '', sequence: i + 1 }))
          : [];
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
   * Skips pass 1 (broker harvest) since the customer is already resolved
   * on the load — server still injects that customer's parseHints into
   * pass 2 via the knownBrokerName lookup. ~half the latency of a fresh
   * parse and zero pass-1 token cost.
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
      const knownBrokerName = typeof fieldValues['broker'] === 'string' ? (fieldValues['broker'] as string) : undefined;
      const res = await fetch('/api/parse-ratecon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: base64,
          enabledFields: Object.keys(fieldSettings).filter(k => fieldSettings[k]),
          customInstructions: promptInstructions,
          promptVariables,
          customers: customers.map(c => ({
            name: c.name, aliases: c.aliases ?? [], parseHints: c.parseHints,
          })),
          knownBrokerName,
          skipBrokerHarvest: true,
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
      if (parsed.weight != null) setField('weight', parsed.weight);
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
        setStartDate(sd); setStartTime(st.slice(0, 5));
      }
      if (parsed.end) {
        const [ed, et = '17:00'] = parsed.end.split('T');
        setEndDate(ed); setEndTime(et.slice(0, 5));
      }
      if (Array.isArray(parsed.stops) && parsed.stops.length > 0) {
        setStops((parsed.stops as Stop[]).map((s, i) => ({ ...s, id: crypto.randomUUID(), eventId: '', sequence: i + 1 })));
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
  const rStyle        = inputStyle();
  const focusH        = focusColor(headerColor);
  const focusR        = focusColor(RELAY_COLOR);

  const endLabel   = isPickupLeg ? 'Drop at Yard' : 'End';
  const startLabel = isDeliveryLeg ? 'Pickup from Yard' : 'Start';

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

  // ── Relay totals — used to swap the regular Driver Pay slot for a
  // read-only "Total Driver Pay" tile when the modal is in relay context.
  const relayLp = typeof fieldValues['loadPrice'] === 'number'
    ? fieldValues['loadPrice']
    : parseFloat(String(fieldValues['loadPrice'] ?? '')) || 0;
  const relayPickupNum   = pickupDriverPay   === '' ? 0 : pickupDriverPay;
  const relayDeliveryNum = deliveryDriverPay === '' ? 0 : deliveryDriverPay;
  const relayTotalPay    = relayPickupNum + relayDeliveryNum;
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

  const dispatcherFieldOverride: Record<string, React.ReactNode> = {
    ...(isRelayContext ? { driverPay: relayTotalDisplay } : {}),
    refNums: (
      <RefNumsField
        value={Array.isArray(fieldValues['refNums']) ? fieldValues['refNums'] as RefNum[] : []}
        onChange={v => { markDirty(); setFieldValues(prev => ({ ...prev, refNums: v })); }}
        headerColor={headerColor}
      />
    ),
    trailer: (
      <StyledSelect
        value={String(linkedTrailerId ?? '')}
        onChange={e => { markDirty(); setLinkedTrailerId(e.target.value ? Number(e.target.value) : undefined); }}
        style={{ ...iStyle, cursor: 'pointer' }}
        onFocus={focusH} onBlur={blurColor}>
        <option value="">— None —</option>
        {trailers.map(t => (
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
        {dispatchers.map(d => (
          <option key={d.id} value={d.name}>{d.name}{d.isDefault ? ' ★' : ''}</option>
        ))}
      </StyledSelect>
    ),
    broker: (
      <div className="space-y-2">
        <CustomerCombobox
          value={String(fieldValues['broker'] ?? '')}
          onChange={val => { markDirty(); setField('broker', val); setBrokerSaveBlocked(false); setBrokerMatch({ status: 'none' }); }}
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
          const brokerVal = String(fieldValues['broker'] ?? '').trim();
          const linkedCustomer = brokerVal ? customers.find(c => c.name === brokerVal) : undefined;
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

  const relayPartnerAsset = relayPartner ? assets.find(a => a.id === relayPartner.assetId) : null;
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
              onClick={() => { setPendingNewBroker(brokerMatch.extracted); }}
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
        profile={parsedBrokerProfile}
        onCancel={() => setPendingNewBroker(null)}
        onConfirm={confirmCreateBroker}
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
              Cancel — keep editing
            </button>
          </div>
        </div>
      </div>
    )}
    {/* z-[200] keeps the load detail modal above the closeout review
        queue (z-180) so the user can pop it open without losing their
        review-queue position. Sub-dialogs below stack at +10/+20. */}
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.36)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) handleBackdropClick(); }}>
      <div className="flex"
        style={{
          width: (showPdfViewer || showMapPanel || showDriverSummary) ? '96vw' : '100%',
          maxWidth: (showPdfViewer || showMapPanel)
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
        {showPdfViewer && (
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
                  Uploaded ({loadDocuments.length + loadInvoices.length})
                </button>
              </div>
              <div className="flex items-center gap-1 flex-nowrap shrink-0">
                {docsTab === 'rateCon' && (<>
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
                    <a href={pdfObjectUrl} download="rate-con.pdf"
                      className="flex items-center justify-center w-7 h-7 rounded-lg transition-colors"
                      style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border-light)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <Download size={12} />
                    </a>
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
                : <div className="flex-1 flex items-center justify-center text-sm" style={{ color: 'var(--gc-text-3)' }}>No rate con uploaded</div>
            ) : (
              <UploadedDocsPanel
                docs={loadDocuments}
                invoices={loadInvoices}
                selectedId={selectedDocId}
                onSelect={setSelectedDocId}
                signedUrl={selectedDocUrl}
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
              />
            )}
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
                  const ev = useCalendarStore.getState().events.find(e => e.id === modalEventId);
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
                  );
                })()}
                {(isPickupLeg || isDeliveryLeg) && (
                  <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-lg"
                    style={{ background: RELAY_COLOR, color: 'white' }}>
                    ⇄ {isPickupLeg ? 'Pickup Leg' : 'Delivery Leg'}
                  </span>
                )}
                {/* Confirmation visibility lives in the driver row
                    (next to the phone-copy / Driver Summary buttons),
                    not in this header, so we don't double up. */}
              </div>
              <div className="flex items-center gap-2 flex-wrap text-[13px]" style={{ color: 'var(--gc-text-2)' }}>
                <span>
                  {selectedAsset?.name ?? 'Select asset'}
                  {selectedAsset?.unit ? ` · #${selectedAsset.unit}` : ''}
                  {selectedAsset?.truck ? ` · ${selectedAsset.truck}` : ''}
                </span>
                {truckLoc && (
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
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                style={{ color: headerColor, border: `1px solid ${headerColor}50`, background: showMapPanel ? `${headerColor}22` : `${headerColor}12` }}
                onMouseEnter={e => (e.currentTarget.style.background = `${headerColor}22`)}
                onMouseLeave={e => (e.currentTarget.style.background = showMapPanel ? `${headerColor}22` : `${headerColor}12`)}>
                <MapPin size={13} /> {showMapPanel ? 'Hide Map' : 'View Map'}
              </button>
            )}
            {eventKind === 'revenue' && (rateConPdf ? (
              <button type="button" onClick={() => { setShowPdfViewer(v => !v); setShowMapPanel(false); setDocsTab('rateCon'); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                style={{ color: headerColor, border: `1px solid ${headerColor}50`, background: showPdfViewer ? `${headerColor}22` : `${headerColor}12` }}
                onMouseEnter={e => (e.currentTarget.style.background = `${headerColor}22`)}
                onMouseLeave={e => (e.currentTarget.style.background = showPdfViewer ? `${headerColor}22` : `${headerColor}12`)}>
                <Eye size={13} /> {showPdfViewer ? 'Hide Docs' : 'View Docs'}
              </button>
            ) : (
              <button type="button" onClick={() => attachFileInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                style={{ color: 'var(--gc-text-3)', border: '1px solid var(--gc-border-light)' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; e.currentTarget.style.color = 'var(--gc-text-2)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}>
                <Paperclip size={13} /> Attach Rate Con
              </button>
            ))}
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
                {(['revenue', 'non_revenue'] as const).map(kind => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => { if (!isEdit) setEventKind(kind); }}
                    disabled={isEdit}
                    className="text-xs px-3 py-1.5 rounded-lg font-medium"
                    style={{
                      background: eventKind === kind ? (kind === 'revenue' ? 'var(--gc-blue)' : '#7c3aed') : 'var(--gc-hover)',
                      color: eventKind === kind ? '#fff' : 'var(--gc-text-2)',
                      cursor: isEdit ? 'default' : 'pointer',
                      opacity: isEdit && eventKind !== kind ? 0.35 : 1,
                      transition: isEdit ? 'none' : 'colors 150ms',
                    }}
                  >
                    {kind === 'revenue' ? 'Revenue' : 'Non-Revenue'}
                  </button>
                ))}
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
                      {rateConPdf && (
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
                  <div className="flex items-center justify-between px-4 py-3 rounded-xl" style={{ background: '#fef2f2', border: '1px solid #fecaca' }}>
                    <div className="flex items-center gap-2.5 min-w-0">
                      <AlertCircle size={17} style={{ color: '#dc2626', flexShrink: 0 }} />
                      <span className="text-sm font-medium truncate" style={{ color: '#dc2626' }}>{parseError || 'Parse failed'}</span>
                    </div>
                    <button type="button" onClick={() => fileInputRef.current?.click()}
                      className="text-xs font-medium ml-3 shrink-0"
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

            <div className="grid grid-cols-2 gap-4">
              <Field label={startLabel}>
                <div className="flex gap-2">
                  <DatePicker value={startDate}
                    onChange={v => {
                      markDirty();
                      if (startDate && endDate) {
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

            <div className="grid grid-cols-2 gap-4">
              <Field label="Asset *">
                <StyledSelect value={assetId}
                  onChange={e => { markDirty(); const aid = +e.target.value; setAssetId(aid); setDriverName(preferredDriverName(aid)); }}
                  style={{ ...iStyle, cursor: 'pointer' }} onFocus={focusH} onBlur={blurColor}>
                  {assets.map(a => <option key={a.id} value={a.id}>{assetLabel(a)}</option>)}
                </StyledSelect>
              </Field>
              <Field label="Driver">
                <StyledSelect value={driverName} onChange={e => { markDirty(); setDriverName(e.target.value); }}
                  style={{ ...iStyle, cursor: 'pointer' }} onFocus={focusH} onBlur={blurColor}>
                  <option value="">— No driver —</option>
                  {drivers.map(d => {
                    const display = canonicalDriverName(d);
                    return <option key={d.id} value={display}>{display}</option>;
                  })}
                </StyledSelect>
                {(() => {
                  const sel = findDriverByName(driverName) ?? null;
                  const showSummaryBtn = eventKind === 'revenue' && isEdit;
                  const currentEv = modalEventId ? events.find(e => e.id === modalEventId) : undefined;
                  const showNotify = eventKind === 'revenue' && isEdit && !!sel?.id && !!modalEventId;
                  if (!sel?.phone && !showSummaryBtn && !showNotify) return null;
                  // Per-kind ack state — drives which buttons in the
                  // popover are greyed out. The server is authoritative
                  // (it stamps acknowledged_at on rows), but we also
                  // disable buttons whose ack condition is already met
                  // so dispatch doesn't bother sending a redundant nudge.
                  const ackState = currentEv ? {
                    confirm:        !!currentEv.confirmedAt || ['dispatched','en_route','picked_up','delivered'].includes(currentEv.status ?? ''),
                    mark_pickup:    ['picked_up','delivered'].includes(currentEv.status ?? ''),
                    mark_delivery:  currentEv.status === 'delivered',
                    upload_pod:     loadDocuments.some(d => d.kind === 'pod'),
                    report_trailer: currentEv.trailerId != null,
                  } : { confirm:false, mark_pickup:false, mark_delivery:false, upload_pod:false, report_trailer:false };
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
                  {/* Relay block */}
                  {(isDeliveryLeg || isPickupLeg || relayActive) && (
                    <div style={{ borderTop: '1px solid var(--gc-border-light)', paddingTop: 20 }}>
                      {isDeliveryLeg && (() => {
                        const relayStop = stops.find(s => s.type === 'relay');
                        const pickupAssetName = assetLabel(relayPartnerAsset);
                        const delivAssetName  = assetLabel(assets.find(a => a.id === assetId));
                        return (
                          <div className="rounded-xl p-6 space-y-5" style={{ background: '#f5f3ff', border: '1px solid #ddd6fe' }}>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2 flex-wrap">
                                <ArrowLeftRight size={15} style={{ color: RELAY_COLOR }} />
                                <span className="text-sm font-semibold" style={{ color: RELAY_COLOR }}>Delivery Leg</span>
                                {relayPartner && (
                                  <button type="button" onClick={() => { if (isDirty) { setSavePromptAfterNav(relayPartner.id); setShowSavePrompt(true); } else { openEditModal(relayPartner.id); } }}
                                    className="text-xs font-medium underline-offset-2"
                                    style={{ color: RELAY_COLOR, textDecoration: 'underline' }}>
                                    Open pickup leg →
                                  </button>
                                )}
                              </div>
                              <button type="button" onClick={handleRelayRemove}
                                className="text-xs px-3 py-1.5 rounded-lg font-medium transition-colors shrink-0"
                                style={confirmRelayRemove ? { background: '#d93025', color: 'white' } : { color: '#d93025' }}
                                onMouseEnter={e => { if (!confirmRelayRemove) e.currentTarget.style.background = 'rgba(217,48,37,.1)'; }}
                                onMouseLeave={e => { if (!confirmRelayRemove) e.currentTarget.style.background = 'transparent'; }}>
                                {confirmRelayRemove ? 'Confirm remove?' : 'Remove split'}
                              </button>
                            </div>
                            <div style={{ background: '#ede9fe', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#5b21b6', display: 'flex', alignItems: 'center', gap: 8 }}>
                              <ArrowLeftRight size={14} style={{ flexShrink: 0 }} />
                              <span style={{ flex: 1 }}>
                                {relayStop?.address
                                  ? <>Relay point: <strong>{relayStop.address}</strong>{relayStop.apptStart ? ` · Drop ${fmtRelayTime(relayStop.apptStart)}` : ''}{relayStop.apptEnd ? ` → Pickup ${fmtRelayTime(relayStop.apptEnd)}` : ''}</>
                                  : 'No relay point set on the pickup leg.'
                                }
                              </span>
                              {(() => {
                                const currentEv = events.find(e => e.id === modalEventId);
                                if (!currentEv?.loadId) return null;
                                const handoffPhotos = loadDocuments
                                  .filter(d => d.kind === 'relay_handoff')
                                  .map(d => ({ id: d.id, uploadedAt: d.uploadedAt }));
                                return (
                                  <HandoffPhotosButton
                                    loadId={currentEv.loadId}
                                    photos={handoffPhotos}
                                    onSelectInPanel={(docId) => {
                                      setShowPdfViewer(true);
                                      setShowMapPanel(false);
                                      setDocsTab('uploaded');
                                      setSelectedDocId(docId);
                                    }}
                                    onUploaded={async () => {
                                      if (!currentEv.loadId || !orgId) return;
                                      const { fetchLoadDocuments } = await import('@/lib/db');
                                      const fresh = await fetchLoadDocuments(currentEv.loadId, orgId);
                                      setLoadDocuments(fresh);
                                    }}
                                  />
                                );
                              })()}
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                              <div>
                                <div style={{ fontSize: 11, fontWeight: 700, color: '#7c3aed', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Pickup Asset</div>
                                <div style={{ fontSize: 13, fontWeight: 600, color: '#5b21b6', background: '#ede9fe', borderRadius: 6, padding: '6px 10px' }}>{pickupAssetName}{relayPartner?.driverName ? ` · ${relayPartner.driverName}` : ''}</div>
                              </div>
                              <div>
                                <div style={{ fontSize: 11, fontWeight: 700, color: '#7c3aed', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Delivery Asset</div>
                                <div style={{ fontSize: 13, fontWeight: 600, color: '#5b21b6', background: '#ede9fe', borderRadius: 6, padding: '6px 10px' }}>{delivAssetName}</div>
                              </div>
                            </div>
                          </div>
                        );
                      })()}
                      {(isPickupLeg || relayActive) && (
                        <div className="rounded-xl p-6 space-y-5" style={{ background: '#f5f3ff', border: '1px solid #ddd6fe' }}>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 flex-wrap">
                              <ArrowLeftRight size={15} style={{ color: RELAY_COLOR }} />
                              <span className="text-sm font-semibold" style={{ color: RELAY_COLOR }}>
                                {isPickupLeg ? 'Pickup Leg' : 'Split Load'} — Delivery Details
                              </span>
                              {isPickupLeg && relayPartner && (
                                <button type="button" onClick={() => { if (isDirty) { setSavePromptAfterNav(relayPartner.id); setShowSavePrompt(true); } else { openEditModal(relayPartner.id); } }}
                                  className="text-xs font-medium underline-offset-2"
                                  style={{ color: RELAY_COLOR, textDecoration: 'underline' }}>
                                  Open delivery leg →
                                </button>
                              )}
                            </div>
                            <button type="button"
                              onClick={isPickupLeg
                                ? handleRelayRemove
                                : confirmRelayRemove
                                  ? () => { setRelayActive(false); setConfirmRelayRemove(false); setStops(prev => prev.filter(s => s.type !== 'relay')); }
                                  : () => setConfirmRelayRemove(true)
                              }
                              className="text-xs px-3 py-1.5 rounded-lg font-medium transition-colors"
                              style={confirmRelayRemove ? { background: '#d93025', color: 'white' } : { color: '#d93025' }}
                              onMouseEnter={e => { if (!confirmRelayRemove) e.currentTarget.style.background = 'rgba(217,48,37,.1)'; }}
                              onMouseLeave={e => { if (!confirmRelayRemove) e.currentTarget.style.background = 'transparent'; }}>
                              {confirmRelayRemove ? 'Confirm cancel?' : isPickupLeg ? 'Remove split' : 'Cancel split'}
                            </button>
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                            <Field label="Delivery Asset *">
                              <StyledSelect value={relayDelivAssetId}
                                onChange={e => { const aid = +e.target.value; setRelayDelivAssetId(aid); setRelayDelivDriverName(preferredDriverName(aid)); }}
                                style={{ ...rStyle, cursor: 'pointer' }} onFocus={focusR} onBlur={blurColor}>
                                {assets.map(a => <option key={a.id} value={a.id}>{assetLabel(a)}</option>)}
                              </StyledSelect>
                            </Field>
                            <Field label="Delivery Driver">
                              <StyledSelect value={relayDelivDriverName} onChange={e => setRelayDelivDriverName(e.target.value)}
                                style={{ ...rStyle, cursor: 'pointer' }} onFocus={focusR} onBlur={blurColor}>
                                <option value="">— No driver —</option>
                                {drivers.map(d => {
                                  const display = canonicalDriverName(d);
                                  return <option key={d.id} value={display}>{display}</option>;
                                })}
                              </StyledSelect>
                            </Field>
                          </div>
                          {(() => {
                            const relayStop = stops.find(s => s.type === 'relay');
                            const currentEv = events.find(e => e.id === modalEventId);
                            const handoffPhotos = currentEv?.loadId
                              ? loadDocuments
                                  .filter(d => d.kind === 'relay_handoff')
                                  .map(d => ({ id: d.id, uploadedAt: d.uploadedAt }))
                              : [];
                            return (
                              <div style={{ background: '#ede9fe', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#5b21b6', display: 'flex', alignItems: 'center', gap: 8 }}>
                                <ArrowLeftRight size={14} style={{ flexShrink: 0 }} />
                                <span style={{ flex: 1 }}>
                                  {relayStop?.address
                                    ? <>Relay point: <strong>{relayStop.address}</strong>{relayStop.apptStart ? ` · Drop ${fmtRelayTime(relayStop.apptStart)}` : ''}{relayStop.apptEnd ? ` → Pickup ${fmtRelayTime(relayStop.apptEnd)}` : ''}</>
                                    : <>Set the relay point and drop/pickup times in the <strong>Locations</strong> section below.</>
                                  }
                                </span>
                                {currentEv?.loadId && (
                                  <HandoffPhotosButton
                                    loadId={currentEv.loadId}
                                    photos={handoffPhotos}
                                    onSelectInPanel={(docId) => {
                                      setShowPdfViewer(true);
                                      setShowMapPanel(false);
                                      setDocsTab('uploaded');
                                      setSelectedDocId(docId);
                                    }}
                                    onUploaded={async () => {
                                      if (!currentEv.loadId || !orgId) return;
                                      const { fetchLoadDocuments } = await import('@/lib/db');
                                      const fresh = await fetchLoadDocuments(currentEv.loadId, orgId);
                                      setLoadDocuments(fresh);
                                    }}
                                  />
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  )}
                  {/* Stops section */}
                  <div style={{ borderTop: '1px solid var(--gc-border-light)', paddingTop: 20 }}>
                    <StopsSection
                      stops={stops}
                      onChange={next => { setStops(next); markDirty(); }}
                      headerColor={headerColor}
                      onMapRoute={() => { setShowMapPanel(true); setShowPdfViewer(false); }}
                      onActivateRelay={!isPickupLeg && !isDeliveryLeg && !isBatch ? activateRelay : undefined}
                      relayActive={relayActive}
                      relayRole={relayRole}
                      eventStart={startDate && startTime ? `${startDate}T${startTime}` : undefined}
                      eventEnd={endDate && endTime ? `${endDate}T${endTime}` : undefined}
                      loadedMiles={loadedMiles}
                      loadPrice={typeof fieldValues['loadPrice'] === 'number' ? fieldValues['loadPrice'] : null}
                      ratePerMile={(() => {
                        const thisPrice = typeof fieldValues['loadPrice'] === 'number' ? fieldValues['loadPrice'] : null;
                        if (thisPrice == null || loadedMiles == null || loadedMiles === 0) return null;
                        if ((isPickupLeg || isDeliveryLeg) && relayPartner) {
                          const partnerPrice = relayPartner.loadPrice ?? 0;
                          const totalMiles = (partnerLoadedMiles ?? 0) + loadedMiles;
                          if (totalMiles === 0) return null;
                          return Math.round(((thisPrice + partnerPrice) / totalMiles) * 100) / 100;
                        }
                        return Math.round((thisPrice / loadedMiles) * 100) / 100;
                      })()}
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
                    {section === 'financial' && eventKind === 'revenue' && (
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
                  {/* Dual driver-pay inputs for relay loads — Total + chip
                      lives next to Load Price via the override above.
                      Gated on loads.view_driver_pay so Dispatcher /
                      Maintenance never see what either leg's driver
                      was paid. */}
                  {section === 'financial' && isRelayContext && canViewDriverPay && (() => {
                    const pctOf = (n: number) => (relayLp > 0 && n > 0 ? Math.round((n / relayLp) * 1000) / 10 : null);
                    const pickupPct   = pctOf(relayPickupNum);
                    const deliveryPct = pctOf(relayDeliveryNum);
                    const fmtPct = (p: number) => `${p % 1 === 0 ? p.toFixed(0) : p.toFixed(1)}%`;
                    const pctChip = (p: number | null) => p === null ? null : (
                      <span className="px-1.5 py-0.5 rounded-lg normal-case tracking-normal font-semibold"
                        style={{ fontSize: 10, background: '#f1f3f4', color: 'var(--gc-text-3)', border: '1px solid var(--gc-border-light)' }}>
                        {fmtPct(p)}
                      </span>
                    );
                    return (
                      <div className="mt-3 grid grid-cols-2 gap-3">
                        <Field label="Pickup Driver Pay" labelSuffix={pctChip(pickupPct)}>
                          <NumberInputWithDollar value={pickupDriverPay} onChange={v => { setPickupDriverPay(v); markDirty(); }} headerColor={headerColor} />
                        </Field>
                        <Field label="Delivery Driver Pay" labelSuffix={pctChip(deliveryPct)}>
                          <NumberInputWithDollar value={deliveryDriverPay} onChange={v => { setDeliveryDriverPay(v); markDirty(); }} headerColor={headerColor} />
                        </Field>
                      </div>
                    );
                  })()}
                  {section === 'financial' && eventKind === 'revenue' && accessorials.length > 0 && (
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
                            // Build the list of drivers that can receive this accessorial pay
                            const payOpts: string[] = [];
                            if (driverName) payOpts.push(driverName);
                            if (relayGroupId) {
                              if (relayDelivDriverName && !payOpts.includes(relayDelivDriverName)) payOpts.push(relayDelivDriverName);
                              if (relayPartner?.driverName && !payOpts.includes(relayPartner.driverName)) payOpts.push(relayPartner.driverName);
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
                  {section === 'financial' && eventKind === 'revenue' && totalBillable > 0 && (() => {
                    const loadPrice = parseFloat(String(fieldValues['loadPrice'] ?? 0)) || 0;
                    const grandTotal = loadPrice + totalBillable;
                    return (
                      <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium flex-wrap"
                        style={{ background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0' }}>
                        <span>
                          Total billable to broker: <strong>${grandTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
                        </span>
                        <span>
                          (${loadPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} load + ${totalBillable.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} accessorials)
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
            const fmtDate = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
            const assetName = (id: number) => assets.find(a => a.id === id)?.name ?? `Asset ${id}`;
            const fmt$ = (n?: number) => n != null ? `$${n.toLocaleString()}` : '—';
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
                      if (entry.prevAssetId !== undefined)
                        parts.push({ key: 'asset', node: <>{b('Asset')} changed from {b(assetName(entry.prevAssetId))} to {b(entry.newAssetId !== undefined ? assetName(entry.newAssetId) : '—')}</> });
                      if (entry.prevDriverName !== undefined || entry.newDriverName !== undefined)
                        parts.push({ key: 'driver', node: <>{b('Driver')} changed from {b(entry.prevDriverName || '—')} to {b(entry.newDriverName || '—')}</> });
                      if (entry.prevLoadPrice !== undefined)
                        parts.push({ key: 'lprice', node: <>{b('Load price')} changed from {b(fmt$(entry.prevLoadPrice))} to {b(fmt$(entry.newLoadPrice))}</> });
                      if (entry.prevDriverPay !== undefined)
                        parts.push({ key: 'dpay', node: <>{b('Driver pay')} changed from {b(fmt$(entry.prevDriverPay))} to {b(fmt$(entry.newDriverPay))}</> });
                      if (entry.stopsAdded)
                        parts.push({ key: 'sadd', node: <>{b(String(entry.stopsAdded))} stop{entry.stopsAdded > 1 ? 's' : ''} added</> });
                      if (entry.stopsRemoved)
                        parts.push({ key: 'srem', node: <>{b(String(entry.stopsRemoved))} stop{entry.stopsRemoved > 1 ? 's' : ''} removed</> });
                      if (entry.relayCreated)
                        parts.push({ key: 'rcreate', node: <>Load split as {b('relay')}</> });
                      if (entry.relayRemoved)
                        parts.push({ key: 'rremove', node: <>{b('Relay')} removed, load merged</> });
                      if (entry.loadDeleted)
                        parts.push({ key: 'ldel', node: <>{b('Load')} deleted</> });
                      if (entry.loadRestored)
                        parts.push({ key: 'lrest', node: <>{b('Load')} reinstated</> });
                      if (entry.prevStatus !== undefined || entry.newStatus !== undefined)
                        parts.push({ key: 'status', node: <>{b('Status')} changed from {b(entry.prevStatus ?? '—')} to {b(entry.newStatus ?? '—')}</> });
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

          {/* Footer */}
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
                    {eventKind === 'revenue' && status === 'cancelled' ? (
                      <>
                        <button type="button" onClick={handleReinstate}
                          className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-[13px] font-medium transition-all"
                          style={{ color: 'var(--gc-blue)', background: 'transparent' }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-light)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          <RefreshCw size={15} />
                          Reinstate
                        </button>
                        <button type="button" onClick={() => setRemoveDialogOpen(true)}
                          className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-[13px] font-medium transition-all"
                          style={{ color: '#d93025', background: 'transparent' }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(217,48,37,.1)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          <Trash2 size={15} />
                          Remove
                        </button>
                      </>
                    ) : eventKind === 'revenue' ? (
                      <button type="button" onClick={() => setCancelDialogOpen(true)}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-[13px] font-medium transition-all"
                        style={{ color: '#d93025', background: 'transparent' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(217,48,37,.1)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                        <Trash2 size={15} />
                        Cancel load
                      </button>
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
                    {!isPickupLeg && !isDeliveryLeg && (
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
                <button type="submit" disabled={!title.trim() || !startDate || !endDate || modalConflict === 'deleted'}
                  className="px-6 py-2.5 rounded-lg text-[13px] font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  style={{ background: 'var(--gc-blue)' }}
                  onMouseEnter={e => { if (title.trim()) e.currentTarget.style.background = 'var(--gc-blue-hover)'; }}
                  onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-blue)')}>
                  {isEdit ? 'Save changes' : relayActive ? 'Create relay' : eventKind === 'non_revenue' ? 'Create event' : 'Create load'}
                </button>
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
              <div className="text-[13px] font-medium mt-1" style={{ color: 'var(--gc-text-2)' }}>
                Pick how to handle it. You can always look it up later by load #.
              </div>
            </div>
          </div>

          {/* Three action rows */}
          <div className="flex flex-col gap-2 px-5 pb-2">
            <button type="button" onClick={handleCancelMarkStatus}
              className="flex items-start gap-3 text-left px-4 py-3 rounded-lg transition-colors"
              style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-surface)')}>
              <div className="flex items-center justify-center flex-shrink-0 rounded-full mt-0.5"
                style={{ width: 28, height: 28, background: 'var(--gc-border-light)', color: 'var(--gc-text-2)' }}>
                <Calendar size={14} />
              </div>
              <div className="flex-1">
                <div className="text-[13px] font-bold" style={{ color: 'var(--gc-text-1)' }}>
                  Mark cancelled (keep on calendar)
                </div>
                <div className="text-[12px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                  Event stays greyed out. Rate, miles, and driver pay zero out — still shows in payroll so you can add TONU/layover pay.
                </div>
              </div>
            </button>

            <button type="button" onClick={handleCancelRemoveEvent}
              className="flex items-start gap-3 text-left px-4 py-3 rounded-lg transition-colors"
              style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-surface)')}>
              <div className="flex items-center justify-center flex-shrink-0 rounded-full mt-0.5"
                style={{ width: 28, height: 28, background: '#fef3c7', color: '#92400e' }}>
                <Trash2 size={14} />
              </div>
              <div className="flex-1">
                <div className="text-[13px] font-bold" style={{ color: 'var(--gc-text-1)' }}>
                  Remove from calendar (keep load record)
                </div>
                <div className="text-[12px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                  Event disappears, but the load stays searchable in accounting / history.
                </div>
              </div>
            </button>

            <button type="button" onClick={handleCancelPermanent}
              className="flex items-start gap-3 text-left px-4 py-3 rounded-lg transition-colors"
              style={{ border: '1px solid #f4c7c3', background: '#fdecea' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#fadcd9')}
              onMouseLeave={e => (e.currentTarget.style.background = '#fdecea')}>
              <div className="flex items-center justify-center flex-shrink-0 rounded-full mt-0.5"
                style={{ width: 28, height: 28, background: '#fce8e6', color: '#d93025' }}>
                <AlertCircle size={14} />
              </div>
              <div className="flex-1">
                <div className="text-[13px] font-bold" style={{ color: '#b1271b' }}>
                  Move to Recently Deleted
                </div>
                <div className="text-[12px] mt-0.5" style={{ color: '#b1271b', opacity: 0.85 }}>
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

    {/* Remove dialog — shown when a cancelled load needs to come off
        the board. Two paths: keep the load record (event-only delete)
        or send the whole thing to the Trash bin. */}
    {removeDialogOpen && (
      <div className="fixed inset-0 flex items-center justify-center px-4"
        style={{ background: 'rgba(0,0,0,0.5)', zIndex: 240 }}
        onMouseDown={e => { if (e.target === e.currentTarget) setRemoveDialogOpen(false); }}>
        <div className="rounded-2xl flex flex-col w-full"
          style={{
            maxWidth:   480,
            background: 'var(--gc-surface)',
            boxShadow:  '0 16px 48px rgba(0,0,0,0.25)',
            border:     '1px solid var(--gc-border)',
            overflow:   'hidden',
          }}>
          {/* Header */}
          <div className="flex items-start gap-3 px-5 pt-5 pb-3">
            <div className="flex items-center justify-center flex-shrink-0 rounded-full"
              style={{ width: 36, height: 36, background: '#fce8e6', color: '#d93025' }}>
              <Trash2 size={18} />
            </div>
            <div className="flex-1">
              <div className="text-[16px] font-extrabold" style={{ color: 'var(--gc-text-1)' }}>
                Remove this load?
              </div>
              <div className="text-[13px] font-medium mt-1" style={{ color: 'var(--gc-text-2)' }}>
                Already cancelled — pick how to clear it off the calendar.
              </div>
            </div>
          </div>

          {/* Two action rows */}
          <div className="flex flex-col gap-2 px-5 pb-2">
            <button type="button" onClick={() => { handleCancelRemoveEvent(); setRemoveDialogOpen(false); }}
              className="flex items-start gap-3 text-left px-4 py-3 rounded-lg transition-colors"
              style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-surface)')}>
              <div className="flex items-center justify-center flex-shrink-0 rounded-full mt-0.5"
                style={{ width: 28, height: 28, background: '#fef3c7', color: '#92400e' }}>
                <Trash2 size={14} />
              </div>
              <div className="flex-1">
                <div className="text-[13px] font-bold" style={{ color: 'var(--gc-text-1)' }}>
                  Remove from calendar (keep load record)
                </div>
                <div className="text-[12px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                  Event disappears, but the load stays searchable in accounting / history.
                </div>
              </div>
            </button>

            <button type="button" onClick={() => { handleCancelPermanent(); setRemoveDialogOpen(false); }}
              className="flex items-start gap-3 text-left px-4 py-3 rounded-lg transition-colors"
              style={{ border: '1px solid #f4c7c3', background: '#fdecea' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#fadcd9')}
              onMouseLeave={e => (e.currentTarget.style.background = '#fdecea')}>
              <div className="flex items-center justify-center flex-shrink-0 rounded-full mt-0.5"
                style={{ width: 28, height: 28, background: '#fce8e6', color: '#d93025' }}>
                <AlertCircle size={14} />
              </div>
              <div className="flex-1">
                <div className="text-[13px] font-bold" style={{ color: '#b1271b' }}>
                  Move to Recently Deleted
                </div>
                <div className="text-[12px] mt-0.5" style={{ color: '#b1271b', opacity: 0.85 }}>
                  Removes the event and the load record. Restorable from Trash for 30 days.
                </div>
              </div>
            </button>
          </div>

          {/* Footer — exit only */}
          <div className="flex items-center justify-end gap-2 px-5 py-4 mt-2"
            style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
            <button type="button" onClick={() => setRemoveDialogOpen(false)}
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
      const reviewLoad: CalendarEvent =
        currentEv.relayRole === 'delivery' && currentEv.relayGroupId
          ? (events.find(e =>
              e.id !== currentEv.id &&
              e.relayRole === 'pickup' &&
              ((currentEv.loadId && e.loadId === currentEv.loadId) ||
               (currentEv.relayGroupId && e.relayGroupId === currentEv.relayGroupId)),
            ) ?? currentEv)
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
