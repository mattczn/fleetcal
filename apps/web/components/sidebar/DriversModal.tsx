'use client';

import { useState, useEffect, useRef } from 'react';
import { X, Check, Plus, Truck, Users, Phone, Clock, Trash2, DollarSign, Download, Loader2 } from 'lucide-react';
import { useOrganization } from '@clerk/nextjs';
import { useCalendarStore } from '@/store/useCalendarStore';
import { usePermissions } from '@/lib/usePermissions';
import { formatHardDeleteError } from '@/lib/hardDeleteError';
import {
  fetchPayrollRecordsForDriver, fetchPayrollAdjustments, fetchEventsInRange,
  type PayrollRecord,
} from '@/lib/db';
import { printPayroll, fmtDate } from '@/lib/payrollPdf';
import LoadHistorySection from './LoadHistorySection';
import LifecycleEditor from './LifecycleEditor';
import { isActiveOn, dateKeyOf } from '@/lib/lifecycle';
import type { Driver, CalendarEvent, Asset } from '@/lib/types';

const ACCENT = '#1a73e8';

const P_INPUT: React.CSSProperties = {
  border: '1px solid var(--gc-border)',
  borderRadius: 8,
  padding: '10px 12px',
  fontSize: 14,
  color: 'var(--gc-text-1)',
  outline: 'none',
  background: 'var(--gc-surface)',
  transition: 'border-color 150ms',
  width: '100%',
  boxSizing: 'border-box',
};

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  scheduled:  { label: 'Scheduled',  color: '#1a73e8', bg: '#e8f0fe' },
  assigned:   { label: 'Assigned',   color: '#5b21b6', bg: '#ede9fe' },
  dispatched: { label: 'Dispatched', color: '#1558d6', bg: '#e8f0fe' },
  en_route:   { label: 'En Route',   color: '#e37400', bg: '#fef3e2' },
  picked_up:  { label: 'Picked Up',  color: '#7b1fa2', bg: '#f3e5f5' },
  delivered:  { label: 'Delivered',  color: '#188038', bg: '#e6f4ea' },
  cancelled:  { label: 'Cancelled',  color: '#d93025', bg: '#fce8e6' },
};

// ── Address ↔ structured parts ──────────────────────────────────────────
// Mirrors the driver-app parse/join. Single text field on disk, four
// structured inputs in the UI.
function parseAddress(s: string | undefined): { street: string; city: string; state: string; zip: string } {
  const empty = { street: '', city: '', state: '', zip: '' };
  if (!s) return empty;
  const m = s.match(/^(.*?),\s*(.*?),\s*([A-Z]{2})(?:\s+(\d{5}(?:-\d{4})?))?$/);
  if (m) return { street: m[1].trim(), city: m[2].trim(), state: m[3], zip: m[4] ?? '' };
  return { street: s, city: '', state: '', zip: '' };
}

function joinAddress(p: { street: string; city: string; state: string; zip: string }): string | undefined {
  const parts: string[] = [];
  if (p.street.trim()) parts.push(p.street.trim());
  if (p.city.trim())   parts.push(p.city.trim());
  const tail = [p.state.trim().toUpperCase(), p.zip.trim()].filter(Boolean).join(' ');
  if (tail) parts.push(tail);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

// MM/DD/YYYY ⇄ YYYY-MM-DD
function isoToDisplay(iso?: string | null): string {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1]}`;
}
function displayToIso(display: string): string | null {
  const t = display.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return null;
}

function driverDisplayName(d: Driver): string {
  const full = `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim();
  return full || d.name;
}

function driverInitials(d: Driver): string {
  if (d.firstName && d.lastName) return `${d.firstName[0]}${d.lastName[0]}`.toUpperCase();
  if (d.firstName) return d.firstName[0].toUpperCase();
  if (d.lastName)  return d.lastName[0].toUpperCase();
  return d.name?.[0]?.toUpperCase() ?? '?';
}

/** Relative-time label for the driver app "last seen" line. Keeps the
 *  dispatcher's read fast — "2 min ago" / "3 h ago" / "yesterday" /
 *  "Mar 12" — same vocabulary used elsewhere in the app. */
function lastSeenLabel(iso: string | null | undefined): string {
  if (!iso) return 'never opened';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'never opened';
  const diffMs = Date.now() - t;
  if (diffMs < 0) return 'just now';
  const min = Math.floor(diffMs / 60_000);
  if (min < 1)    return 'just now';
  if (min < 60)   return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)    return `${hr} h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1)  return 'yesterday';
  if (day < 7)    return `${day} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Three-state color for the activity dot:
 *    green  — opened the app in the last 24h (currently active)
 *    amber  — opened in the last 14d (occasional user / token still works)
 *    grey   — never opened or hasn't in 14d+ (probably can't log in) */
function lastSeenDotColor(iso: string | null | undefined): string {
  if (!iso) return '#9ca3af';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '#9ca3af';
  const hours = (Date.now() - t) / 3_600_000;
  if (hours <= 24)        return '#22c55e';  // green-500
  if (hours <= 24 * 14)   return '#f59e0b';  // amber-500
  return '#9ca3af';                           // gray-400
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function DriversModal({ onClose, initialDriverId }: { onClose: () => void; initialDriverId?: number }) {
  const {
    assets, drivers: allDrivers, driverPrefs, driverPrefsSecondary,
    addDriver, removeDriver, hardDeleteDriver, updateDriver, setDriverPref, setDriverPrefSecondary,
    events, deletedEvents,
  } = useCalendarStore();

  // Sort retired drivers to the bottom of the directory list so the
  // panel leads with active staff. Retired entries stay visible (with
  // a 'Retired' pill on the row) so dispatch can review history and
  // restore.
  const today = dateKeyOf(new Date());
  const drivers = [
    ...allDrivers.filter(d =>  isActiveOn(d, today)),
    ...allDrivers.filter(d => !isActiveOn(d, today)),
  ];

  const [selected, setSelectedRaw] = useState<number | 'asset-prefs'>(
    initialDriverId ?? (drivers.length > 0 ? drivers[0].id : 'asset-prefs')
  );
  const [adding, setAdding] = useState(false);

  // Track the id of the row we created via "+ Add Driver" as a
  // placeholder. If the user navigates away (selection change, close,
  // unmount) without entering a real name, that row gets removed so
  // we don't leave "New driver" sitting in the directory.
  const draftIdRef = useRef<number | null>(null);

  const cleanupDraft = () => {
    const id = draftIdRef.current;
    if (id == null) return;
    draftIdRef.current = null;
    // Read fresh store state so we see any auto-saved edits the user
    // made (firstName / lastName / etc. update on blur). If the row
    // was already removed (explicit Delete button), .find returns
    // undefined and we skip.
    const fresh = useCalendarStore.getState().drivers.find(d => d.id === id);
    if (fresh && fresh.name === 'New driver' && !fresh.firstName && !fresh.lastName) {
      removeDriver(id);
    }
  };

  // Wrapper: clean up any pending draft when selection moves elsewhere.
  const setSelected = (next: number | 'asset-prefs') => {
    if (draftIdRef.current != null && next !== draftIdRef.current) cleanupDraft();
    setSelectedRaw(next);
  };

  // Modal close: drop the draft before unmounting.
  const handleClose = () => { cleanupDraft(); onClose(); };

  // Safety net for unexpected unmounts.
  useEffect(() => {
    return () => { cleanupDraft(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Click + Add Driver → create an empty driver server-side, then
  // select it so the existing DriverProfilePanel opens with blank
  // fields. The user fills everything in and the fields auto-save on
  // blur. If they navigate away without filling anything in, the
  // placeholder row is auto-removed (see cleanupDraft above).
  const handleAdd = async () => {
    if (adding) return;
    // If a previous draft is still pending, clean it before creating
    // another so we don't strand multiple "New driver" rows.
    cleanupDraft();
    setAdding(true);
    try {
      // API requires a non-empty name on create. Seed with "New driver"
      // so the call validates; the profile panel opens with the name
      // field focused so the dispatcher just types their real name
      // and the placeholder disappears.
      const newId = await addDriver({ name: 'New driver' });
      draftIdRef.current = newId;
      setSelectedRaw(newId);
    } catch (err) {
      console.error('add driver failed:', err);
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = (id: number) => {
    // Explicit delete — clear the draft tracking so the cleanup effect
    // doesn't try to double-remove a row that's already gone.
    if (draftIdRef.current === id) draftIdRef.current = null;
    const remaining = drivers.filter(d => d.id !== id);
    removeDriver(id);
    setSelectedRaw(remaining.length > 0 ? remaining[0].id : 'asset-prefs');
  };

  const selectedDriver = typeof selected === 'number'
    ? drivers.find(d => d.id === selected) ?? null
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.32)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className="flex flex-col"
        style={{
          background: 'var(--gc-surface)',
          width: '100%', maxWidth: 1020, height: '82vh',
          borderRadius: 14, boxShadow: 'var(--shadow-3)', overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-7 py-5"
          style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div className="flex items-center gap-2.5">
            <Users size={17} style={{ color: ACCENT }} />
            <span className="text-base font-semibold" style={{ color: 'var(--gc-text-1)' }}>
              Driver Directory
            </span>
          </div>
          <button onClick={handleClose} className="p-1.5 rounded-full transition-colors"
            style={{ color: 'var(--gc-text-2)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden flex min-h-0">

          {/* ── Left Sidebar ── */}
          <div className="flex flex-col shrink-0"
            style={{ width: 240, borderRight: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>

            {/* Section header — title on the left, + button inline on
                the right (matches AssetsModal). */}
            <div className="shrink-0 flex items-center justify-between px-4 pt-5 pb-1">
              <span className="text-[10px] font-bold uppercase tracking-widest"
                style={{ color: 'var(--gc-text-3)' }}>
                Drivers
              </span>
              <button
                onClick={() => void handleAdd()}
                disabled={adding}
                title="Add driver"
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold transition-colors disabled:opacity-50"
                style={{ color: ACCENT, background: 'transparent', border: 'none', cursor: adding ? 'default' : 'pointer' }}
                onMouseEnter={e => { if (!adding) e.currentTarget.style.background = 'var(--gc-blue-light)'; }}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <Plus size={12} />
                {adding ? 'Adding…' : 'Driver'}
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {drivers.length === 0 && (
                <p className="text-xs px-2 py-2" style={{ color: 'var(--gc-text-3)' }}>
                  No drivers yet.
                </p>
              )}

              {drivers.map(d => (
                <NavDriverRow
                  key={d.id}
                  driver={d}
                  selected={selected === d.id}
                  onSelect={() => setSelected(d.id)}
                />
              ))}
            </div>

            {/* Asset Preferences nav item */}
            <div style={{ borderTop: '1px solid var(--gc-border-light)' }}>
              <button
                onClick={() => setSelected('asset-prefs')}
                className="w-full flex items-center gap-2.5 px-4 py-3.5 text-sm font-medium transition-colors text-left"
                style={{
                  color: selected === 'asset-prefs' ? ACCENT : 'var(--gc-text-2)',
                  background: selected === 'asset-prefs' ? 'var(--gc-blue-light)' : 'transparent',
                }}
                onMouseEnter={e => { if (selected !== 'asset-prefs') e.currentTarget.style.background = 'var(--gc-hover)'; }}
                onMouseLeave={e => { if (selected !== 'asset-prefs') e.currentTarget.style.background = 'transparent'; }}>
                <Truck size={14} />
                Asset Preferences
              </button>
            </div>
          </div>

          {/* ── Right Panel ── */}
          <div className="flex-1 overflow-y-auto">
            {selected === 'asset-prefs' ? (
              <AssetPreferencesPanel
                assets={assets}
                drivers={drivers}
                driverPrefs={driverPrefs}
                driverPrefsSecondary={driverPrefsSecondary}
                setDriverPref={setDriverPref}
                setDriverPrefSecondary={setDriverPrefSecondary}
              />
            ) : selectedDriver ? (
              <DriverProfilePanel
                key={selectedDriver.id}
                driver={selectedDriver}
                events={events}
                deletedEvents={deletedEvents}
                assets={assets}
                updateDriver={updateDriver}
                onRemove={() => handleRemove(selectedDriver.id)}
                onHardDelete={async () => {
                  try {
                    await hardDeleteDriver(selectedDriver.id);
                  } catch (err) {
                    alert(formatHardDeleteError('driver', err));
                  }
                }}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-sm"
                style={{ color: 'var(--gc-text-3)' }}>
                Select a driver
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 flex justify-end px-7 py-4"
          style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
          <button onClick={handleClose}
            className="px-6 py-2.5 rounded-lg text-sm font-medium text-white transition-colors"
            style={{ background: ACCENT }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = ACCENT)}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Nav Driver Row ───────────────────────────────────────────────────────────

function NavDriverRow({ driver, selected, onSelect }: {
  driver: Driver;
  selected: boolean;
  onSelect: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  // Retirement check matches the AssetsModal pill — activeTo set and
  // already in the past. Future-dated retirement isn't flagged here.
  const retired = !isActiveOn(driver, dateKeyOf(new Date()));

  return (
    <div
      className="flex items-center gap-2.5 px-2 py-2 rounded-lg cursor-pointer select-none transition-colors"
      style={{
        background: selected
          ? 'var(--gc-blue-light)'
          : hovered ? 'var(--gc-hover)' : 'transparent',
      }}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-[11px] font-bold text-white"
        style={{ background: selected ? ACCENT : '#9aa0a6' }}
      >
        {driverInitials(driver)}
      </div>
      <span className="flex-1 text-sm font-medium truncate"
        style={{ color: selected ? ACCENT : 'var(--gc-text-1)' }}>
        {driverDisplayName(driver)}
      </span>
      {/* Driver-app activity dot — at-a-glance signal for which
          drivers are actually using the app. Title shows the exact
          relative time on hover. */}
      {!retired && (
        <span
          className="shrink-0 w-1.5 h-1.5 rounded-full"
          style={{ background: lastSeenDotColor(driver.lastSeenAt) }}
          title={`Driver app: ${lastSeenLabel(driver.lastSeenAt)}`}
        />
      )}
      {retired && (
        <span
          className="shrink-0 text-[9px] font-bold uppercase tracking-wider px-1.5 py-[1px] rounded"
          style={{ background: '#fee2e2', color: '#991b1b', letterSpacing: '0.5px' }}
          title={driver.activeTo ? `Retired ${driver.activeTo}` : 'Retired'}
        >
          Retired
        </span>
      )}
    </div>
  );
}

// ─── Driver Profile Panel ─────────────────────────────────────────────────────

function DriverProfilePanel({ driver, events, deletedEvents, assets, updateDriver, onRemove, onHardDelete }: {
  driver: Driver;
  events: CalendarEvent[];
  deletedEvents: CalendarEvent[];
  assets: Asset[];
  updateDriver: (id: number, updates: Partial<Omit<Driver, 'id'>>) => void;
  onRemove: () => void;
  onHardDelete: () => void;
}) {
  const { openEditModal, orgId } = useCalendarStore();
  const { organization } = useOrganization();
  const { can: canDo } = usePermissions();
  const canDelete       = canDo('drivers.delete');
  const canViewPayroll  = canDo('payroll.access');
  const canEdit         = canDo('drivers.edit');
  // Hard delete only safe when no loads reference this driver as the
  // primary. events.driver_id is ON DELETE RESTRICT; secondary_driver_id
  // is ON DELETE SET NULL, so a driver who only ever appeared as secondary
  // can still be hard-deleted (those slots silently clear). Count both
  // live + soft-deleted rows since the FK doesn't distinguish.
  const loadsAttached =
    events.filter(e => e.driverId === driver.id).length +
    deletedEvents.filter(e => e.driverId === driver.id).length;
  const [firstName, setFirstName] = useState(driver.firstName ?? '');
  const [lastName,  setLastName]  = useState(driver.lastName  ?? '');
  const [phone,     setPhone]     = useState(driver.phone     ?? '');
  const [notes,     setNotes]     = useState(driver.notes     ?? '');
  const [email,         setEmail]         = useState(driver.email         ?? '');
  const initialAddr = parseAddress(driver.address);
  const [addrStreet,    setAddrStreet]    = useState(initialAddr.street);
  const [addrCity,      setAddrCity]      = useState(initialAddr.city);
  const [addrState,     setAddrState]     = useState(initialAddr.state);
  const [addrZip,       setAddrZip]       = useState(initialAddr.zip);
  const [licenseNumber, setLicenseNumber] = useState(driver.licenseNumber ?? '');
  const [licenseState,  setLicenseState]  = useState(driver.licenseState  ?? '');
  const [licenseExp,    setLicenseExp]    = useState(driver.licenseExp    ?? '');
  const [medCardExp,    setMedCardExp]    = useState(driver.medicalCardExp ?? '');
  const [dob,           setDob]           = useState(driver.dob           ?? '');
  const [documents,     setDocuments]     = useState<import('@fleetcal/types').DriverDocument[]>([]);
  const [docsLoading,   setDocsLoading]   = useState(false);
  const [uploadingKind, setUploadingKind] = useState<import('@fleetcal/types').DriverDocumentKind | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [payHistory,    setPayHistory]    = useState<PayrollRecord[]>([]);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  useEffect(() => {
    // Skip when the role can't read /v1/payroll/records — the endpoint
    // would 403 the request anyway, and the Pay History section below
    // is hidden in that case.
    if (!orgId || !driver.name || !canViewPayroll) return;
    fetchPayrollRecordsForDriver(orgId, driver.name).then(setPayHistory);
  }, [orgId, driver.name, canViewPayroll]);

  async function handleHistoryPdf(rec: PayrollRecord) {
    if (!orgId || downloadingId) return;
    setDownloadingId(rec.id);
    try {
      const [y, m, d] = rec.weekStart.split('-').map(Number);
      const sat = new Date(y, m - 1, d);
      const fri = new Date(y, m - 1, d + 6);
      // Fetch the week's events for this driver + the adjustments in parallel
      const [rangeResult, allAdjs] = await Promise.all([
        fetchEventsInRange(orgId, sat.toISOString(), fri.toISOString()),
        fetchPayrollAdjustments(orgId, rec.weekStart),
      ]);
      const loads = rangeResult.events.filter(
        e => (e.driverName ?? '').toLowerCase() === (driver.name ?? '').toLowerCase()
      );
      const adjs = allAdjs.filter(
        a => a.driverName.toLowerCase() === (driver.name ?? '').toLowerCase()
      );
      const weekLabel = `${fmtDate(sat)} – ${fmtDate(fri)}`;
      printPayroll({
        orgName:    organization?.name    ?? 'My Organization',
        orgLogoUrl: organization?.imageUrl,
        weekLabel,
        sat,
        fri,
        drivers: [{ driverName: driver.name ?? '', loads, adjustments: adjs, record: rec }],
      });
    } finally {
      setDownloadingId(null);
    }
  }

  const saveNameField = (field: 'firstName' | 'lastName', value: string) => {
    const newFirst = field === 'firstName' ? value : firstName;
    const newLast  = field === 'lastName'  ? value : lastName;
    const computed = `${newFirst} ${newLast}`.trim();
    updateDriver(driver.id, { [field]: value || undefined, ...(computed ? { name: computed } : {}) });
  };

  // Loads attached to this driver. The LoadHistorySection handles the
  // sort/group/clip behavior so we pass the full unsliced list.
  const driverLoads = events.filter(ev => ev.driverName === driver.name);

  // ── Documents ──
  // Load once per driver (the component remounts via `key` on driver
  // switch, so we don't need to watch driver.id here).
  useEffect(() => {
    let alive = true;
    setDocsLoading(true);
    void (async () => {
      try {
        const { railway } = await import('@/lib/railway');
        const res = await railway.listDriverDocuments(driver.id);
        if (alive) setDocuments(res.documents);
      } catch (err) {
        console.warn('[DriversModal] load documents:', err);
      } finally {
        if (alive) setDocsLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function uploadDoc(kind: import('@fleetcal/types').DriverDocumentKind, file: File) {
    setUploadingKind(kind);
    try {
      const { railway } = await import('@/lib/railway');
      const form = new FormData();
      form.append('file', file);
      form.append('kind', kind);
      await railway.uploadDriverDocument(driver.id, form);
      const res = await railway.listDriverDocuments(driver.id);
      setDocuments(res.documents);
    } catch (err) {
      alert(`Upload failed: ${(err as Error).message}`);
    } finally {
      setUploadingKind(null);
    }
  }

  async function deleteDoc(docId: string) {
    if (!confirm('Delete this document?')) return;
    try {
      const { railway } = await import('@/lib/railway');
      await railway.deleteDriverDocument(docId);
      setDocuments(prev => prev.filter(d => d.id !== docId));
    } catch (err) {
      alert(`Delete failed: ${(err as Error).message}`);
    }
  }

  const DOC_KINDS: { key: import('@fleetcal/types').DriverDocumentKind; label: string }[] = [
    { key: 'license',      label: 'License' },
    { key: 'medical_card', label: 'Medical Card' },
    { key: 'mvr',          label: 'MVR' },
    { key: 'other',        label: 'Other' },
  ];

  function saveAddress(next: { street: string; city: string; state: string; zip: string }) {
    updateDriver(driver.id, { address: joinAddress(next) ?? undefined });
  }
  // value from <input type="date"> is already ISO YYYY-MM-DD or "".
  function saveDateIso(field: 'licenseExp' | 'medicalCardExp' | 'dob', iso: string) {
    updateDriver(driver.id, { [field]: iso.trim() || undefined });
  }

  return (
    <div className="px-8 py-7">

      {/* Avatar + name header */}
      <div className="flex items-center gap-5 mb-8">
        <div
          className="w-16 h-16 rounded-full shrink-0 flex items-center justify-center text-2xl font-bold text-white"
          style={{ background: ACCENT }}
        >
          {driverInitials(driver)}
        </div>
        <div>
          <div className="text-xl font-semibold" style={{ color: 'var(--gc-text-1)' }}>
            {driverDisplayName(driver)}
          </div>
          {driver.phone && (
            <div className="text-sm mt-1 flex items-center gap-1.5" style={{ color: 'var(--gc-text-3)' }}>
              <Phone size={12} />
              {driver.phone}
            </div>
          )}
          {/* Driver-app activity — confirms the driver successfully
              logged in and is the API's last_seen_at timestamp from
              their most recent authenticated request. "Never" means
              the driver has not yet opened the app on a device
              wired up with their phone / test-OTP. */}
          <div className="text-xs mt-1 flex items-center gap-1.5" style={{ color: 'var(--gc-text-3)' }}>
            <span
              className="inline-block w-2 h-2 rounded-full shrink-0"
              style={{ background: lastSeenDotColor(driver.lastSeenAt) }}
            />
            <span>Driver app: {lastSeenLabel(driver.lastSeenAt)}</span>
          </div>
        </div>
      </div>

      {/* Read-only notice for roles (e.g. maintenance) that have
          drivers.view but not drivers.edit. The fieldset below makes
          every input/select/textarea/button non-interactive. */}
      {!canEdit && (
        <div style={{
          padding: '10px 14px',
          marginBottom: 24,
          background: '#fef3c7',
          border: '1px solid #fde68a',
          borderRadius: 10,
          color: '#92400e',
          fontSize: 13,
          fontWeight: 600,
        }}>
          Read-only — your role can view this driver but can&apos;t make changes.
        </div>
      )}

      <fieldset disabled={!canEdit} style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }}>
      {/* Profile fields */}
      <div className="mb-8">
        <div className="text-[10px] font-bold uppercase tracking-widest mb-4"
          style={{ color: 'var(--gc-text-3)' }}>
          Profile
        </div>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <PField label="First Name">
            <input type="text" value={firstName} onChange={e => setFirstName(e.target.value)}
              placeholder="First" style={P_INPUT}
              onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
              onBlur={e => {
                const v = e.target.value.trim();
                setFirstName(v);
                saveNameField('firstName', v);
                e.currentTarget.style.borderColor = 'var(--gc-border)';
              }} />
          </PField>
          <PField label="Last Name">
            <input type="text" value={lastName} onChange={e => setLastName(e.target.value)}
              placeholder="Last" style={P_INPUT}
              onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
              onBlur={e => {
                const v = e.target.value.trim();
                setLastName(v);
                saveNameField('lastName', v);
                e.currentTarget.style.borderColor = 'var(--gc-border)';
              }} />
          </PField>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <PField label="Phone">
            <input type="tel" value={phone} onChange={e => setPhone(e.target.value)}
              placeholder="(555) 555-5555" style={P_INPUT}
              onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
              onBlur={e => {
                const v = e.target.value.trim();
                setPhone(v);
                updateDriver(driver.id, { phone: v || undefined });
                e.currentTarget.style.borderColor = 'var(--gc-border)';
              }} />
          </PField>
          <PField label="Email">
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="name@example.com" style={P_INPUT}
              onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
              onBlur={e => {
                const v = e.target.value.trim();
                setEmail(v);
                updateDriver(driver.id, { email: v || undefined });
                e.currentTarget.style.borderColor = 'var(--gc-border)';
              }} />
          </PField>
        </div>

        <div className="mt-4">
          <PField label="Notes">
            <textarea value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Add notes about this driver…" rows={3}
              style={{
                ...P_INPUT,
                resize: 'vertical',
                paddingTop: 10,
                paddingBottom: 10,
                lineHeight: '1.5',
                fontFamily: 'inherit',
              }}
              onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
              onBlur={e => {
                const v = e.target.value.trim();
                setNotes(v);
                updateDriver(driver.id, { notes: v || undefined });
                e.currentTarget.style.borderColor = 'var(--gc-border)';
              }} />
          </PField>
        </div>
      </div>

      {/* Address */}
      <div className="mb-8">
        <div className="text-[10px] font-bold uppercase tracking-widest mb-4" style={{ color: 'var(--gc-text-3)' }}>
          Address
        </div>
        <PField label="Street">
          <input type="text" value={addrStreet} onChange={e => setAddrStreet(e.target.value)}
            placeholder="123 Main St" style={P_INPUT}
            onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
            onBlur={e => {
              const v = e.target.value;
              setAddrStreet(v);
              saveAddress({ street: v, city: addrCity, state: addrState, zip: addrZip });
              e.currentTarget.style.borderColor = 'var(--gc-border)';
            }} />
        </PField>
        <div className="grid gap-4 mt-4" style={{ gridTemplateColumns: '1fr 100px 120px' }}>
          <PField label="City">
            <input type="text" value={addrCity} onChange={e => setAddrCity(e.target.value)}
              placeholder="Salt Lake City" style={P_INPUT}
              onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
              onBlur={e => {
                const v = e.target.value;
                setAddrCity(v);
                saveAddress({ street: addrStreet, city: v, state: addrState, zip: addrZip });
                e.currentTarget.style.borderColor = 'var(--gc-border)';
              }} />
          </PField>
          <PField label="State">
            <input type="text" value={addrState} onChange={e => setAddrState(e.target.value.toUpperCase().slice(0, 2))}
              placeholder="UT" maxLength={2} style={P_INPUT}
              onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
              onBlur={e => {
                const v = e.target.value.toUpperCase().slice(0, 2);
                setAddrState(v);
                saveAddress({ street: addrStreet, city: addrCity, state: v, zip: addrZip });
                e.currentTarget.style.borderColor = 'var(--gc-border)';
              }} />
          </PField>
          <PField label="Zip">
            <input type="text" value={addrZip} onChange={e => setAddrZip(e.target.value.replace(/[^\d-]/g, '').slice(0, 10))}
              placeholder="84101" style={P_INPUT}
              onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
              onBlur={e => {
                const v = e.target.value;
                setAddrZip(v);
                saveAddress({ street: addrStreet, city: addrCity, state: addrState, zip: v });
                e.currentTarget.style.borderColor = 'var(--gc-border)';
              }} />
          </PField>
        </div>
      </div>

      {/* License */}
      <div className="mb-8">
        <div className="text-[10px] font-bold uppercase tracking-widest mb-4" style={{ color: 'var(--gc-text-3)' }}>
          License
        </div>
        <div className="grid gap-4" style={{ gridTemplateColumns: '2fr 100px' }}>
          <PField label="License #">
            <input type="text" value={licenseNumber} onChange={e => setLicenseNumber(e.target.value.toUpperCase())}
              placeholder="D1234567" style={P_INPUT}
              onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
              onBlur={e => {
                const v = e.target.value.trim();
                setLicenseNumber(v);
                updateDriver(driver.id, { licenseNumber: v || undefined });
                e.currentTarget.style.borderColor = 'var(--gc-border)';
              }} />
          </PField>
          <PField label="State">
            <input type="text" value={licenseState} onChange={e => setLicenseState(e.target.value.toUpperCase().slice(0, 2))}
              placeholder="UT" maxLength={2} style={P_INPUT}
              onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
              onBlur={e => {
                const v = e.target.value.toUpperCase().slice(0, 2);
                setLicenseState(v);
                updateDriver(driver.id, { licenseState: v || undefined });
                e.currentTarget.style.borderColor = 'var(--gc-border)';
              }} />
          </PField>
        </div>
        <div className="mt-4">
          <PField label="Expiration">
            <input type="date" value={licenseExp} onChange={e => setLicenseExp(e.target.value)}
              style={P_INPUT}
              onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
              onBlur={e => {
                saveDateIso('licenseExp', e.target.value);
                e.currentTarget.style.borderColor = 'var(--gc-border)';
              }} />
          </PField>
        </div>
      </div>

      {/* Compliance */}
      <div className="mb-8">
        <div className="text-[10px] font-bold uppercase tracking-widest mb-4" style={{ color: 'var(--gc-text-3)' }}>
          Compliance
        </div>
        <div className="grid grid-cols-2 gap-4">
          <PField label="Medical Card Exp.">
            <input type="date" value={medCardExp} onChange={e => setMedCardExp(e.target.value)}
              style={P_INPUT}
              onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
              onBlur={e => {
                saveDateIso('medicalCardExp', e.target.value);
                e.currentTarget.style.borderColor = 'var(--gc-border)';
              }} />
          </PField>
          <PField label="Date of Birth">
            <input type="date" value={dob} onChange={e => setDob(e.target.value)}
              style={P_INPUT}
              onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
              onBlur={e => {
                saveDateIso('dob', e.target.value);
                e.currentTarget.style.borderColor = 'var(--gc-border)';
              }} />
          </PField>
        </div>
      </div>

      {/* Documents */}
      <div className="mb-8">
        <div className="text-[10px] font-bold uppercase tracking-widest mb-4" style={{ color: 'var(--gc-text-3)' }}>
          Documents
        </div>
        {docsLoading ? (
          <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--gc-text-3)' }}>
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-3">
            {DOC_KINDS.map((k, idx) => {
              const forKind = documents.filter(d => d.kind === k.key);
              return (
                <div key={k.key}
                  style={{ paddingTop: idx === 0 ? 0 : 12, borderTop: idx === 0 ? 'none' : '1px solid var(--gc-border-light)' }}>
                  <div className="flex items-center mb-2">
                    <span className="text-sm font-semibold flex-1" style={{ color: 'var(--gc-text-1)' }}>{k.label}</span>
                    <label
                      className="text-xs font-semibold px-2.5 py-1 rounded-lg cursor-pointer flex items-center gap-1"
                      style={{ background: '#e8f0fe', color: ACCENT, opacity: uploadingKind === k.key ? 0.6 : 1 }}>
                      {uploadingKind === k.key ? <Loader2 size={11} className="animate-spin" /> : '+'} Upload
                      <input type="file" hidden
                        accept="image/*,application/pdf"
                        onChange={async (e) => {
                          const f = e.target.files?.[0];
                          if (f) await uploadDoc(k.key, f);
                          (e.currentTarget as HTMLInputElement).value = '';
                        }} />
                    </label>
                  </div>
                  {forKind.length === 0 ? (
                    <div className="text-xs" style={{ color: 'var(--gc-text-3)' }}>None uploaded.</div>
                  ) : (
                    <div className="space-y-1.5">
                      {forKind.map(d => (
                        <div key={d.id}
                          className="flex items-center gap-2 px-3 py-2 rounded-lg"
                          style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)' }}>
                          <span className="text-xs truncate flex-1" style={{ color: 'var(--gc-text-1)' }}>{d.fileName}</span>
                          <span className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                            {new Date(d.uploadedAt).toLocaleDateString()}
                          </span>
                          {d.signedUrl && (
                            <a href={d.signedUrl} target="_blank" rel="noopener noreferrer"
                              className="text-xs font-medium" style={{ color: ACCENT }}>View</a>
                          )}
                          <button onClick={() => deleteDoc(d.id)}
                            className="text-xs font-medium" style={{ color: '#b91c1c' }}>Delete</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      </fieldset>

      {/* Recent loads — In Progress / Upcoming / Completed with search.
          Same structure as BrokerProfileModal's load history surface. */}
      <LoadHistorySection
        loads={driverLoads}
        assets={assets}
        onSelect={openEditModal}
        heading="Loads"
        emptyLabel="No loads found for this driver"
      />

      {/* Pay History — gated on payroll.access. Hidden entirely for
          roles (e.g. dispatcher) that can't read /v1/payroll/records;
          the fetch in the useEffect above is skipped in lockstep. */}
      {canViewPayroll && (
      <div className="mt-8">
        <div className="text-[10px] font-bold uppercase tracking-widest mb-3"
          style={{ color: 'var(--gc-text-3)' }}>
          Pay History
        </div>

        {payHistory.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 rounded-xl"
            style={{ border: '1px dashed var(--gc-border-light)' }}>
            <DollarSign size={22} style={{ color: 'var(--gc-text-3)', opacity: 0.45 }} />
            <span className="text-sm" style={{ color: 'var(--gc-text-3)' }}>No finalized pay records yet</span>
          </div>
        ) : (
          <div className="space-y-1.5">
            {payHistory.map(rec => {
              const [y, m, d] = rec.weekStart.split('-').map(Number);
              const sat = new Date(y, m - 1, d);
              const fri = new Date(y, m - 1, d + 6);
              const weekStr = `${sat.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${fri.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
              const finalDate = new Date(rec.finalizedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
              const isDownloading = downloadingId === rec.id;
              return (
                <div key={rec.id}
                  className="flex items-center gap-3 px-4 py-3 rounded-xl group"
                  style={{ border: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ background: '#1e8e3e' }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium" style={{ color: 'var(--gc-text-1)' }}>{weekStr}</div>
                    <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-3)' }}>Finalized {finalDate}</div>
                  </div>
                  <div className="text-sm font-semibold shrink-0" style={{ color: '#1e8e3e' }}>
                    {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(rec.totalPay)}
                  </div>
                  <button
                    onClick={() => handleHistoryPdf(rec)}
                    disabled={!!downloadingId}
                    title="Download pay stub PDF"
                    className="flex items-center justify-center rounded-full transition-colors opacity-0 group-hover:opacity-100"
                    style={{ width: 28, height: 28, border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-3)', flexShrink: 0 }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; e.currentTarget.style.color = 'var(--gc-text-1)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}
                  >
                    {isDownloading
                      ? <Loader2 size={12} className="animate-spin" style={{ color: ACCENT }} />
                      : <Download size={12} />}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}

      {/* Lifecycle editor — set/edit active_from + retire date. Backdate,
          schedule future retirement, or un-retire here. The big Retire
          button below remains the one-tap "retire today" shortcut. */}
      <LifecycleEditor
        activeFrom={driver.activeFrom}
        activeTo={driver.activeTo}
        accent="#1a73e8"
        canEdit={canEdit}
        onSave={(changes) => updateDriver(driver.id, changes)}
      />

      {/* Retire — gated on drivers.delete. API now stamps active_to
          rather than hard-deleting; historical loads keep the driver
          reference intact. Skipped when already retired (the lifecycle
          editor above already exposes the retire date input). */}
      {canDelete && !driver.activeTo && (
      <div className="mt-10 pt-6" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
        {confirmDelete ? (
          <div className="flex items-center gap-3">
            <span className="text-sm" style={{ color: 'var(--gc-text-2)' }}>
              Retire <strong>{driverDisplayName(driver)}</strong>? They'll drop out of new-load pickers starting today. Existing loads stay attached and visible in history.
            </span>
            <button
              onClick={onRemove}
              className="px-4 py-1.5 rounded-lg text-sm font-medium text-white"
              style={{ background: '#d93025' }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
              Retire
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
              style={{ color: 'var(--gc-text-2)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ color: '#d93025' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(217,48,37,0.08)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <Trash2 size={14} />
            Retire Driver
          </button>
        )}
      </div>
      )}

      {/* Permanent delete — always visible. API does a strict
          pre-flight on every related table, so nothing cascades.
          Local hint disables the button when we already know there
          are blockers; rare blockers we don't track locally (fuel
          reports, etc.) show up as a 409 alert from the API. */}
      {canDelete && (
        <PermanentDeleteBlock
          label={driverDisplayName(driver)}
          onConfirm={onHardDelete}
          localBlockerHint={loadsAttached > 0
            ? `${loadsAttached} load${loadsAttached === 1 ? '' : 's'} attached`
            : null}
        />
      )}
    </div>
  );
}

/** Two-step destructive confirm — same component as the one in
 *  AssetsModal. Type the entity's name, then click to fire. */
function PermanentDeleteBlock({ label, onConfirm, localBlockerHint }: {
  label: string;
  onConfirm: () => void | Promise<void>;
  localBlockerHint: string | null;
}) {
  const [armed, setArmed] = useState(false);
  const [typed, setTyped] = useState('');
  const ready    = armed && typed.trim() === label.trim();
  const blocked  = localBlockerHint != null;
  return (
    <div className="mt-6 pt-6" style={{ borderTop: '1px dashed var(--gc-border-light)' }}>
      <div className="text-[11px] font-semibold uppercase tracking-wider mb-2"
        style={{ color: 'var(--gc-text-3)' }}>
        Danger zone
      </div>
      {!armed ? (
        <div className="flex items-center gap-3">
          <button
            onClick={() => { if (!blocked) setArmed(true); }}
            disabled={blocked}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-40"
            style={{ color: '#7a1d18', border: '1px solid rgba(217,48,37,0.4)', cursor: blocked ? 'not-allowed' : 'pointer' }}
            onMouseEnter={e => { if (!blocked) e.currentTarget.style.background = 'rgba(217,48,37,0.08)'; }}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <Trash2 size={14} />
            Delete permanently
          </button>
          {blocked && (
            <span className="text-xs" style={{ color: 'var(--gc-text-3)' }}>
              {localBlockerHint} — retire instead to keep history.
            </span>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm" style={{ color: 'var(--gc-text-2)' }}>
            Permanently delete <strong>{label}</strong>. This can&apos;t be undone — the row is removed from the database.
            Type <code style={{ background: 'var(--gc-hover)', padding: '1px 4px', borderRadius: 3 }}>{label}</code> below to confirm.
          </p>
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={typed}
              onChange={e => setTyped(e.target.value)}
              placeholder={label}
              className="flex-1 text-sm rounded-lg px-3 py-1.5 outline-none"
              style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-bg)', color: 'var(--gc-text-1)' }}
            />
            <button
              onClick={() => { void onConfirm(); }}
              disabled={!ready}
              className="px-4 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-40"
              style={{ background: '#d93025' }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
              Delete permanently
            </button>
            <button
              onClick={() => { setArmed(false); setTyped(''); }}
              className="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
              style={{ color: 'var(--gc-text-2)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── PField ───────────────────────────────────────────────────────────────────

function PField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5"
        style={{ color: 'var(--gc-text-3)' }}>
        {label}
      </label>
      {children}
    </div>
  );
}

// ─── Asset Preferences Panel ──────────────────────────────────────────────────

function AssetPreferencesPanel({ assets, drivers, driverPrefs, driverPrefsSecondary, setDriverPref, setDriverPrefSecondary }: {
  assets: Asset[];
  drivers: Driver[];
  driverPrefs: Record<number, number>;
  driverPrefsSecondary: Record<number, number>;
  setDriverPref: (assetId: number, driverId: number | null) => void;
  setDriverPrefSecondary: (assetId: number, driverId: number | null) => void;
}) {
  const selectStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    border: '1px solid var(--gc-border)',
    borderRadius: 8,
    padding: '0 11px',
    height: 38,
    boxSizing: 'border-box',
    fontSize: 13,
    color: 'var(--gc-text-1)',
    outline: 'none',
    background: 'var(--gc-surface)',
    transition: 'border-color 150ms',
    cursor: 'pointer',
  };

  return (
    <div className="px-8 py-7">
      <div className="text-[10px] font-bold uppercase tracking-widest mb-1"
        style={{ color: 'var(--gc-text-3)' }}>
        Asset Preferences
      </div>
      <p className="text-sm mb-1" style={{ color: 'var(--gc-text-2)' }}>
        Assign drivers to each asset. The <strong>Primary</strong> driver auto-fills when the asset is picked on a load; picking either driver in the load modal auto-fills this asset.
      </p>
      <p className="text-xs mb-6" style={{ color: 'var(--gc-text-3)' }}>
        The <strong>Secondary</strong> slot is for drivers who don&apos;t have their own truck and share this one when they work.
      </p>

      <div className="space-y-3" style={{ maxWidth: 720 }}>
        {/* Column headers — only when at least one asset exists */}
        {assets.length > 0 && (
          <div className="flex items-center gap-3 px-1">
            <div className="shrink-0" style={{ width: 180 }} />
            <div className="flex-1 text-[10px] font-bold uppercase tracking-widest"
              style={{ color: 'var(--gc-text-3)' }}>
              Primary driver
            </div>
            <div className="flex-1 text-[10px] font-bold uppercase tracking-widest"
              style={{ color: 'var(--gc-text-3)' }}>
              Secondary driver
            </div>
          </div>
        )}

        {assets.length === 0 && (
          <p className="text-sm" style={{ color: 'var(--gc-text-3)' }}>No assets added yet.</p>
        )}

        {assets.map(asset => {
          const primaryId   = driverPrefs[asset.id];
          const secondaryId = driverPrefsSecondary[asset.id];
          return (
            <div key={asset.id} className="flex items-center gap-3">
              <div className="flex items-center gap-2 shrink-0" style={{ width: 180 }}>
                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: asset.color }} />
                <span className="text-sm truncate" style={{ color: 'var(--gc-text-1)' }}>
                  {asset.name}
                  {asset.unit
                    ? <span style={{ color: 'var(--gc-text-3)' }}> #{asset.unit}</span>
                    : null}
                </span>
              </div>

              {/* Primary */}
              <select
                value={primaryId ?? ''}
                onChange={e => setDriverPref(asset.id, e.target.value ? +e.target.value : null)}
                style={selectStyle}
                onFocus={e => (e.currentTarget.style.borderColor = asset.color)}
                onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
              >
                <option value="">— No default —</option>
                {drivers.map(d => (
                  <option key={d.id} value={d.id} disabled={d.id === secondaryId}>
                    {driverDisplayName(d)}{d.id === secondaryId ? ' (secondary)' : ''}
                  </option>
                ))}
              </select>

              {/* Secondary */}
              <select
                value={secondaryId ?? ''}
                onChange={e => setDriverPrefSecondary(asset.id, e.target.value ? +e.target.value : null)}
                style={selectStyle}
                onFocus={e => (e.currentTarget.style.borderColor = asset.color)}
                onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
              >
                <option value="">— None —</option>
                {drivers.map(d => (
                  <option key={d.id} value={d.id} disabled={d.id === primaryId}>
                    {driverDisplayName(d)}{d.id === primaryId ? ' (primary)' : ''}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}
