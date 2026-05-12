'use client';

import { useState, useEffect } from 'react';
import { X, Check, Plus, Truck, Users, Phone, Clock, Trash2, DollarSign, Download, Loader2 } from 'lucide-react';
import { useOrganization } from '@clerk/nextjs';
import { useCalendarStore } from '@/store/useCalendarStore';
import {
  fetchPayrollRecordsForDriver, fetchPayrollAdjustments, fetchEventsInRange,
  type PayrollRecord,
} from '@/lib/db';
import { printPayroll, fmtDate } from '@/lib/payrollPdf';
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

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function DriversModal({ onClose, initialDriverId }: { onClose: () => void; initialDriverId?: number }) {
  const {
    assets, drivers, driverPrefs,
    addDriver, removeDriver, updateDriver, setDriverPref,
    events,
  } = useCalendarStore();

  const [selected, setSelected] = useState<number | 'asset-prefs'>(
    initialDriverId ?? (drivers.length > 0 ? drivers[0].id : 'asset-prefs')
  );
  const [addName, setAddName] = useState('');
  const [showAdd, setShowAdd] = useState(false);

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const name = addName.trim();
    if (!name) return;
    const newId = Math.max(0, ...drivers.map(d => d.id)) + 1;
    addDriver(name);
    setSelected(newId);
    setAddName('');
    setShowAdd(false);
  };

  const handleRemove = (id: number) => {
    const remaining = drivers.filter(d => d.id !== id);
    removeDriver(id);
    setSelected(remaining.length > 0 ? remaining[0].id : 'asset-prefs');
  };

  const selectedDriver = typeof selected === 'number'
    ? drivers.find(d => d.id === selected) ?? null
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.32)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
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
          <button onClick={onClose} className="p-1.5 rounded-full transition-colors"
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

            <div className="shrink-0 px-4 pt-5 pb-1">
              <span className="text-[10px] font-bold uppercase tracking-widest"
                style={{ color: 'var(--gc-text-3)' }}>
                Drivers
              </span>
            </div>

            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {drivers.length === 0 && !showAdd && (
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

              {showAdd ? (
                <form onSubmit={handleAdd} className="flex items-center gap-1 mt-1 px-2 py-1">
                  <input
                    autoFocus
                    type="text"
                    value={addName}
                    onChange={e => setAddName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Escape') { setShowAdd(false); setAddName(''); } }}
                    placeholder="Full name…"
                    className="flex-1 text-sm outline-none rounded-md px-2 py-1.5"
                    style={{
                      border: `1px solid ${ACCENT}`,
                      color: 'var(--gc-text-1)',
                      background: 'var(--gc-surface)',
                      boxSizing: 'border-box',
                    }}
                  />
                  <button type="submit" disabled={!addName.trim()}
                    className="p-1.5 rounded-md disabled:opacity-40"
                    style={{ color: 'white', background: ACCENT }}>
                    <Check size={13} />
                  </button>
                  <button type="button" onClick={() => { setShowAdd(false); setAddName(''); }}
                    className="p-1.5 rounded-md transition-colors" style={{ color: 'var(--gc-text-3)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <X size={13} />
                  </button>
                </form>
              ) : (
                <button
                  onClick={() => setShowAdd(true)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold mt-1 transition-colors"
                  style={{ color: ACCENT }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-light)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <Plus size={13} />
                  Add Driver
                </button>
              )}
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
                setDriverPref={setDriverPref}
              />
            ) : selectedDriver ? (
              <DriverProfilePanel
                key={selectedDriver.id}
                driver={selectedDriver}
                events={events}
                assets={assets}
                updateDriver={updateDriver}
                onRemove={() => handleRemove(selectedDriver.id)}
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
          <button onClick={onClose}
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
    </div>
  );
}

// ─── Driver Profile Panel ─────────────────────────────────────────────────────

function DriverProfilePanel({ driver, events, assets, updateDriver, onRemove }: {
  driver: Driver;
  events: CalendarEvent[];
  assets: Asset[];
  updateDriver: (id: number, updates: Partial<Omit<Driver, 'id'>>) => void;
  onRemove: () => void;
}) {
  const { openEditModal, orgId } = useCalendarStore();
  const { organization } = useOrganization();
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
    if (!orgId || !driver.name) return;
    fetchPayrollRecordsForDriver(orgId, driver.name).then(setPayHistory);
  }, [orgId, driver.name]);

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

  const recentLoads = events
    .filter(ev => ev.driverName === driver.name)
    .sort((a, b) => b.start.localeCompare(a.start))
    .slice(0, 10);

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
        </div>
      </div>

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

      {/* Recent loads */}
      <div>
        <div className="text-[10px] font-bold uppercase tracking-widest mb-3"
          style={{ color: 'var(--gc-text-3)' }}>
          Recent Loads
        </div>

        {recentLoads.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 rounded-xl"
            style={{ border: '1px dashed var(--gc-border-light)' }}>
            <Clock size={22} style={{ color: 'var(--gc-text-3)', opacity: 0.45 }} />
            <span className="text-sm" style={{ color: 'var(--gc-text-3)' }}>No loads found for this driver</span>
          </div>
        ) : (
          <div className="space-y-1.5">
            {recentLoads.map(ev => {
              const asset = assets.find(a => a.id === ev.assetId);
              const [y, m, d] = ev.start.split('T')[0].split('-').map(Number);
              const dateStr = new Date(y, m - 1, d).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric',
              });
              const sm = STATUS_META[ev.status ?? 'scheduled'] ?? STATUS_META.scheduled;
              return (
                <div key={ev.id}
                  className="flex items-center gap-3 px-4 py-3 rounded-xl transition-colors"
                  style={{ border: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)', cursor: 'pointer' }}
                  onClick={() => openEditModal(ev.id)}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-bg)')}>
                  <div className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: asset?.color ?? '#9aa0a6' }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-bold truncate" style={{ color: 'var(--gc-text-1)' }}>
                      {ev.title}
                    </div>
                    <div className="text-xs mt-0.5 flex items-center gap-2"
                      style={{ color: 'var(--gc-text-3)' }}>
                      <span>{dateStr}</span>
                      {asset && <span>· {asset.name}</span>}
                      {ev.loadNum && <span>· #{ev.loadNum}</span>}
                    </div>
                  </div>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg shrink-0"
                    style={{ color: sm.color, background: sm.bg }}>
                    {sm.label}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pay History */}
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

      {/* Delete */}
      <div className="mt-10 pt-6" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
        {confirmDelete ? (
          <div className="flex items-center gap-3">
            <span className="text-sm" style={{ color: 'var(--gc-text-2)' }}>
              Remove <strong>{driverDisplayName(driver)}</strong>? This cannot be undone.
            </span>
            <button
              onClick={onRemove}
              className="px-4 py-1.5 rounded-lg text-sm font-medium text-white"
              style={{ background: '#d93025' }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
              Remove
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
            Delete Driver
          </button>
        )}
      </div>
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

function AssetPreferencesPanel({ assets, drivers, driverPrefs, setDriverPref }: {
  assets: Asset[];
  drivers: Driver[];
  driverPrefs: Record<number, number>;
  setDriverPref: (assetId: number, driverId: number | null) => void;
}) {
  return (
    <div className="px-8 py-7">
      <div className="text-[10px] font-bold uppercase tracking-widest mb-1"
        style={{ color: 'var(--gc-text-3)' }}>
        Asset Preferences
      </div>
      <p className="text-sm mb-6" style={{ color: 'var(--gc-text-2)' }}>
        Set a default driver for each asset. They&apos;ll be pre-filled when creating a new load.
      </p>

      <div className="space-y-2.5" style={{ maxWidth: 520 }}>
        {assets.length === 0 && (
          <p className="text-sm" style={{ color: 'var(--gc-text-3)' }}>No assets added yet.</p>
        )}
        {assets.map(asset => (
          <div key={asset.id} className="flex items-center gap-4">
            <div className="flex items-center gap-2 shrink-0" style={{ width: 180 }}>
              <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: asset.color }} />
              <span className="text-sm truncate" style={{ color: 'var(--gc-text-1)' }}>
                {asset.name}
                {asset.unit
                  ? <span style={{ color: 'var(--gc-text-3)' }}> #{asset.unit}</span>
                  : null}
              </span>
            </div>
            <select
              value={driverPrefs[asset.id] ?? ''}
              onChange={e => setDriverPref(asset.id, e.target.value ? +e.target.value : null)}
              style={{
                flex: 1,
                border: '1px solid var(--gc-border)',
                borderRadius: 8,
                padding: '0 11px',
                height: 42,
                boxSizing: 'border-box',
                fontSize: 14,
                color: 'var(--gc-text-1)',
                outline: 'none',
                background: 'var(--gc-surface)',
                transition: 'border-color 150ms',
                cursor: 'pointer',
              }}
              onFocus={e => (e.currentTarget.style.borderColor = asset.color)}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
            >
              <option value="">— No default —</option>
              {drivers.map(d => (
                <option key={d.id} value={d.id}>{driverDisplayName(d)}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}
