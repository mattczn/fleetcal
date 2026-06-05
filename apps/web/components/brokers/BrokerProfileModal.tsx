'use client';

import { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from 'react';
import {
  X, Building2, Phone, Mail, User, FileText, Hash,
  TrendingUp, Package, Clock, CheckCircle2, Search,
  ChevronUp, ChevronDown, ChevronsUpDown, ArrowLeft,
  Truck, Calendar, DollarSign, ExternalLink, Plus, Trash2,
  Sparkles, Loader2, AlertCircle,
} from 'lucide-react';
import { railway } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';
import { fetchBrokerLoads } from '@/lib/db';
import { parseNaiveIsoInTz } from '@/lib/time-utils';
import type { Customer, CalendarEvent, CustomerContact } from '@/lib/types';

const ACCENT = '#1a73e8';

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  scheduled:  { label: 'Scheduled',  color: '#1a73e8', bg: '#e8f0fe' },
  assigned:   { label: 'Assigned',   color: '#5b21b6', bg: '#ede9fe' },
  dispatched: { label: 'Dispatched', color: '#1558d6', bg: '#e8f0fe' },
  en_route:   { label: 'En Route',   color: '#e37400', bg: '#fef3e2' },
  picked_up:  { label: 'Picked Up',  color: '#7b1fa2', bg: '#f3e5f5' },
  delivered:  { label: 'Delivered',  color: '#188038', bg: '#e6f4ea' },
  cancelled:  { label: 'Cancelled',  color: '#d93025', bg: '#fce8e6' },
};

const STATUS_ORDER: Record<string, number> = {
  en_route: 0, picked_up: 1, assigned: 2, dispatched: 2, scheduled: 3, delivered: 4, cancelled: 5,
};

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

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

type SortField = 'date' | 'loadNum' | 'status';

// Status checks interpret the naive ISO start/end in the org's
// dispatch tz; otherwise `new Date(naive)` parses as browser-local and
// mis-buckets loads whenever the dispatcher's browser tz differs.
function isInProgress(ev: CalendarEvent, tz: string | undefined): boolean {
  const now = Date.now();
  return parseNaiveIsoInTz(ev.start, tz) <= now && now <= parseNaiveIsoInTz(ev.end, tz);
}
function isUpcoming(ev: CalendarEvent, tz: string | undefined): boolean  {
  return parseNaiveIsoInTz(ev.start, tz) > Date.now();
}
function isCompleted(ev: CalendarEvent, tz: string | undefined): boolean {
  return parseNaiveIsoInTz(ev.end, tz) < Date.now();
}

function sortLoads(list: CalendarEvent[], field: SortField, dir: 'asc' | 'desc'): CalendarEvent[] {
  return [...list].sort((a, b) => {
    let cmp = 0;
    if (field === 'date') {
      cmp = a.start.localeCompare(b.start);
    } else if (field === 'loadNum') {
      cmp = (a.loadNum ?? '').localeCompare(b.loadNum ?? '', undefined, { numeric: true });
    } else {
      cmp = (STATUS_ORDER[a.status ?? 'scheduled'] ?? 99) - (STATUS_ORDER[b.status ?? 'scheduled'] ?? 99);
    }
    return dir === 'asc' ? cmp : -cmp;
  });
}

function brokerInitials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function fmtDate(start: string): string {
  const [y, m, d] = start.split('T')[0].split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(dt: string): string {
  const [datePart, timePart] = dt.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const dateStr = new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (!timePart || timePart === '00:00') return dateStr;
  const [h, min] = timePart.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${dateStr} · ${hour}:${String(min).padStart(2, '0')} ${ampm}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function BrokerProfileModal({
  initialBrokerId,
  onClose,
}: {
  initialBrokerId?: string;
  onClose: () => void;
}) {
  const { customers, orgId, openEditModal, assets, modalOpen } = useCalendarStore();
  const tz = useCalendarStore(s => s.calendarTimezone);
  const sorted = [...customers].sort((a, b) => a.name.localeCompare(b.name));

  const [selectedId, setSelectedId]         = useState<string>(initialBrokerId ?? sorted[0]?.id ?? '');
  const [selectedLoadId, setSelectedLoadId] = useState<string | null>(null);
  const [loads, setLoads]                   = useState<CalendarEvent[]>([]);
  const [loadingLoads, setLoadingLoads]     = useState(true);
  const pendingRefreshId                    = useRef<string | null>(null);

  const selected = customers.find(c => c.id === selectedId) ?? null;
  const selectedLoad = loads.find(l => l.id === selectedLoadId) ?? null;

  // Fetch loads for the selected broker; cancels in-flight request if broker changes
  useEffect(() => {
    if (!selected || !orgId) return;
    let cancelled = false;
    setLoadingLoads(true);
    setSelectedLoadId(null);
    const names = [selected.name, ...selected.aliases].filter(Boolean);
    fetchBrokerLoads(orgId, names).then(results => {
      if (!cancelled) { setLoads(results); setLoadingLoads(false); }
    });
    return () => { cancelled = true; };
  }, [selectedId, orgId]);

  // When EventModal closes, refresh whichever load was open in the editor
  useEffect(() => {
    if (modalOpen) return; // modal just opened — nothing to do
    const loadId = pendingRefreshId.current;
    if (!loadId || !orgId) return;
    pendingRefreshId.current = null;
    const ev = loads.find(l => l.id === loadId);
    if (!ev) return;
    const day = ev.start.split('T')[0];
    import('@/lib/db').then(({ fetchEventsInRange }) =>
      fetchEventsInRange(orgId, `${day}T00:00`, `${day}T23:59`).then(({ events: fresh }) => {
        const updated = fresh.find(e => e.id === loadId);
        if (updated) setLoads(prev => prev.map(l => l.id === loadId ? updated : l));
      })
    );
  }, [modalOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleOpenEditor = useCallback((loadId: string) => {
    pendingRefreshId.current = loadId;
    openEditModal(loadId);
  }, [openEditModal]);

  // ── Unsaved changes guard ─────────────────────────────────────────────────
  const detailRef                           = useRef<BrokerDetailHandle>(null);
  const [showUnsaved, setShowUnsaved]       = useState(false);
  const [panelDirty, setPanelDirty]         = useState(false);
  const [saving, setSaving]                 = useState(false);
  const [saveError, setSaveError]           = useState<string | null>(null);
  const pendingCloseFn                      = useRef<(() => void) | null>(null);

  const tryClose = (closeFn: () => void) => {
    if (detailRef.current?.isDirty()) {
      pendingCloseFn.current = closeFn;
      setShowUnsaved(true);
    } else {
      closeFn();
    }
  };

  /** Wraps the imperative save handle with await + UI feedback.
   *  Previously the footer just fired-and-forgot the promise from
   *  detailRef.current?.save(), so the user got zero indication
   *  anything was happening — and gave up before the store finished
   *  round-tripping the update. This shows a "Saving…" state on the
   *  button, surfaces failures inline, and only treats the save as
   *  done after the store actually patches in the new values (which
   *  is what flips `dirty` back to false). */
  const handleSaveChanges = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await detailRef.current?.save();
    } catch (err) {
      setSaveError((err as Error)?.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleSelectBroker = (id: string) => {
    tryClose(() => { setSelectedId(id); setSelectedLoadId(null); });
  };

  return (
    <div
      // z-[230] so it stacks above the EventModal (z-[200]) when
      // opened from the broker link inside a load — EventModal stays
      // mounted in the background, broker profile takes the focus.
      // Below the inline confirm dialogs (z-240+) so any prompts the
      // broker UI fires can still appear on top.
      className="fixed inset-0 z-[230] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.32)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) tryClose(onClose); }}
    >
      <div
        className="flex flex-col"
        style={{
          background: 'var(--gc-surface)',
          width: '100%', maxWidth: selectedLoad ? 1520 : 1100, height: '88vh',
          borderRadius: 14, boxShadow: 'var(--shadow-3)', overflow: 'hidden',
          transition: 'max-width 250ms ease',
        }}
      >
        {/* Unsaved changes dialog */}
        {showUnsaved && (
          <div className="absolute inset-0 z-10 flex items-center justify-center"
            style={{ background: 'rgba(0,0,0,0.25)', borderRadius: 14 }}>
            <div className="rounded-2xl p-6 shadow-xl" style={{
              background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)',
              width: 360,
            }}>
              <div className="text-sm font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>
                Unsaved changes
              </div>
              <div className="text-sm mb-5" style={{ color: 'var(--gc-text-2)' }}>
                You have unsaved changes to this broker's details. What would you like to do?
              </div>
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => {
                    detailRef.current?.save();
                    setShowUnsaved(false);
                    pendingCloseFn.current?.();
                    pendingCloseFn.current = null;
                  }}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold text-white transition-opacity"
                  style={{ background: ACCENT }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = '0.88')}
                  onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
                  Save changes
                </button>
                <button
                  onClick={() => {
                    detailRef.current?.discard();
                    setShowUnsaved(false);
                    pendingCloseFn.current?.();
                    pendingCloseFn.current = null;
                  }}
                  className="w-full py-2.5 rounded-xl text-sm font-medium transition-colors"
                  style={{ color: '#d93025', background: 'transparent' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(217,48,37,0.07)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  Discard changes
                </button>
                <button
                  onClick={() => { setShowUnsaved(false); pendingCloseFn.current = null; }}
                  className="w-full py-2.5 rounded-xl text-sm font-medium transition-colors"
                  style={{ color: 'var(--gc-text-2)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  Keep editing
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-7 py-5"
          style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div className="flex items-center gap-2.5">
            <Building2 size={17} style={{ color: ACCENT }} />
            <span className="text-base font-semibold" style={{ color: 'var(--gc-text-1)' }}>
              Customer Directory
            </span>
          </div>
          <button onClick={() => tryClose(onClose)} className="p-1.5 rounded-full transition-colors"
            style={{ color: 'var(--gc-text-2)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden flex min-h-0">

          {/* Sidebar */}
          <div className="flex flex-col shrink-0"
            style={{ width: 220, borderRight: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
            <div className="shrink-0 px-4 pt-5 pb-1">
              <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--gc-text-3)' }}>
                Customers
              </span>
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {sorted.length === 0 ? (
                <p className="text-xs px-2 py-2" style={{ color: 'var(--gc-text-3)' }}>No customers yet.</p>
              ) : sorted.map(c => (
                <BrokerNavRow key={c.id} broker={c} selected={selectedId === c.id} onSelect={() => handleSelectBroker(c.id)} />
              ))}
            </div>
          </div>

          {/* Broker detail */}
          <div
            className="flex-1 overflow-y-auto"
            style={{
              borderRight: selectedLoad ? '1px solid var(--gc-border-light)' : 'none',
              minWidth: 0,
              maxWidth: selectedLoad ? 460 : undefined,
            }}
          >
            {selected ? (
              <BrokerDetailPanel
                ref={detailRef}
                broker={selected}
                loads={loads}
                loading={loadingLoads}
                selectedLoadId={selectedLoadId}
                onSelectLoad={setSelectedLoadId}
                onDirtyChange={setPanelDirty}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-sm" style={{ color: 'var(--gc-text-3)' }}>
                Select a broker
              </div>
            )}
          </div>

          {/* Load detail pane */}
          {selectedLoad && (
            <div className="flex-1 overflow-y-auto" style={{ minWidth: 0 }}>
              <LoadDetailPanel
                load={selectedLoad}
                assets={assets}
                onClose={() => setSelectedLoadId(null)}
                onOpenEditor={() => handleOpenEditor(selectedLoad.id)}
              />
            </div>
          )}
        </div>

        {/* Footer — only renders when there are unsaved edits */}
        {panelDirty && (
          <div className="shrink-0 flex items-center justify-end gap-2 px-7 py-3"
            style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
            {saveError ? (
              <span className="text-xs mr-2" style={{ color: '#d93025' }}>{saveError}</span>
            ) : (
              <span className="text-xs mr-2" style={{ color: 'var(--gc-text-3)' }}>
                {saving ? 'Saving…' : 'Unsaved changes'}
              </span>
            )}
            <button onClick={() => detailRef.current?.discard()}
              disabled={saving}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              style={{ color: '#d93025', background: 'transparent' }}
              onMouseEnter={e => { if (!saving) (e.currentTarget.style.background = 'rgba(217,48,37,0.07)'); }}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              Discard
            </button>
            <button onClick={() => void handleSaveChanges()}
              disabled={saving}
              className="px-5 py-2 rounded-lg text-sm font-semibold text-white transition-opacity disabled:opacity-60"
              style={{ background: ACCENT }}
              onMouseEnter={e => { if (!saving) (e.currentTarget.style.background = 'var(--gc-blue-hover)'); }}
              onMouseLeave={e => (e.currentTarget.style.background = ACCENT)}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Broker Nav Row ───────────────────────────────────────────────────────────

function BrokerNavRow({ broker, selected, onSelect }: {
  broker: Customer; selected: boolean; onSelect: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      className="flex items-center gap-2.5 px-2 py-2 rounded-lg cursor-pointer select-none transition-colors"
      style={{ background: selected ? 'var(--gc-blue-light)' : hovered ? 'var(--gc-hover)' : 'transparent' }}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold text-white"
        style={{ background: selected ? ACCENT : '#9aa0a6' }}>
        {brokerInitials(broker.name)}
      </div>
      <span className="flex-1 text-sm font-medium truncate"
        style={{ color: selected ? ACCENT : 'var(--gc-text-1)' }}>
        {broker.name}
      </span>
    </div>
  );
}

// ─── Broker Detail Panel ──────────────────────────────────────────────────────

export type BrokerDetailHandle = {
  isDirty: () => boolean;
  save: () => void;
  discard: () => void;
};

const BrokerDetailPanel = forwardRef<BrokerDetailHandle, {
  broker: Customer;
  loads: CalendarEvent[];
  loading: boolean;
  selectedLoadId: string | null;
  onSelectLoad: (id: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}>(function BrokerDetailPanel({ broker, loads, loading, selectedLoadId, onSelectLoad, onDirtyChange }, ref) {
  const { updateCustomer } = useCalendarStore();
  const tz = useCalendarStore(s => s.calendarTimezone);

  // Long name = the canonical company name shown in the modal header
  // and used by the customer-matching code throughout the app.
  // Editable here because brokers occasionally change branding (typo
  // fixes, mergers, "LLC" suffix cleanups) and the only path to fix
  // them used to be a DB write.
  const [name,                setName]                = useState(broker.name                ?? '');
  const [shortName,           setShortName]           = useState(broker.shortName           ?? '');
  const [mcNum,               setMcNum]               = useState(broker.mcNum               ?? '');
  // Contacts — list of named reps with phone + email. Falls back to
  // legacy single-contact fields when the array is empty (older rows
  // not yet touched by the migration's backfill).
  const seedContacts = (b: Customer): CustomerContact[] => {
    if (b.contacts && b.contacts.length > 0) return b.contacts;
    if (b.contactName || b.contactEmail || b.contactPhone) {
      return [{
        id: crypto.randomUUID(),
        name:  b.contactName  ?? undefined,
        email: b.contactEmail ?? undefined,
        phone: b.contactPhone ?? undefined,
      }];
    }
    return [];
  };
  const [contacts, setContacts] = useState<CustomerContact[]>(() => seedContacts(broker));
  // Two-tap confirmation for delete: first click on a contact's trash
  // sets the id here and morphs the button into a red "Confirm?". Auto
  // resets after 3s of inactivity (and on contact-list changes).
  const [confirmDeleteContactId, setConfirmDeleteContactId] = useState<string | null>(null);
  useEffect(() => {
    if (!confirmDeleteContactId) return;
    const t = setTimeout(() => setConfirmDeleteContactId(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDeleteContactId]);
  const [notes,               setNotes]               = useState(broker.notes               ?? '');
  const [parseHints,          setParseHints]          = useState(broker.parseHints          ?? '');
  const [invoiceMethod,       setInvoiceMethod]       = useState<'' | 'email' | 'portal'>(broker.invoiceMethod ?? '');
  const [invoiceEmail,        setInvoiceEmail]        = useState(broker.invoiceEmail        ?? '');
  const [invoicePortal,       setInvoicePortal]       = useState(broker.invoicePortal       ?? '');
  const [invoiceInstructions, setInvoiceInstructions] = useState(broker.invoiceInstructions ?? '');
  // "Refresh from latest rate con" button — kicks off a server-side
  // re-parse of this customer's most recent rate confirmation and
  // pre-fills the four invoicing fields. Doesn't auto-save; user
  // reviews then hits the modal's normal Save.
  const [refreshing,        setRefreshing]        = useState(false);
  const [refreshError,      setRefreshError]      = useState<string | null>(null);
  const [refreshedFromLoad, setRefreshedFromLoad] = useState<{ id: string; loadNum?: string } | null>(null);

  const [search,           setSearch]           = useState('');
  const [sortField,        setSortField]        = useState<SortField>('date');
  const [sortDir,          setSortDir]          = useState<'asc' | 'desc'>('asc');
  const [showAllCompleted, setShowAllCompleted] = useState(false);
  const [showAllUpcoming,  setShowAllUpcoming]  = useState(false);

  useEffect(() => {
    setName(broker.name ?? '');
    setShortName(broker.shortName ?? '');
    setMcNum(broker.mcNum ?? '');
    setContacts(seedContacts(broker));
    setNotes(broker.notes ?? '');
    setParseHints(broker.parseHints ?? '');
    setInvoiceMethod(broker.invoiceMethod ?? '');
    setInvoiceEmail(broker.invoiceEmail ?? '');
    setInvoicePortal(broker.invoicePortal ?? '');
    setInvoiceInstructions(broker.invoiceInstructions ?? '');
    setRefreshError(null);
    setRefreshedFromLoad(null);
    setSearch('');
    setShowAllCompleted(false);
    setShowAllUpcoming(false);
  }, [broker.id]);

  // Cheap structural compare for contacts — trims strings and drops
  // empty fields before serializing so cosmetic whitespace doesn't
  // mark the form dirty.
  const normalizeContacts = (cs: CustomerContact[]) =>
    JSON.stringify(cs.map(c => ({
      name:  (c.name  ?? '').trim() || undefined,
      email: (c.email ?? '').trim() || undefined,
      phone: (c.phone ?? '').trim() || undefined,
    })));
  const dirty =
    // Long name dirty-check uses trim() but ignores the empty case —
    // a blank name is invalid and we surface that as a save-blocker
    // separately, not as "clean state".
    name.trim()                !== (broker.name                ?? '').trim() ||
    shortName.trim()           !== (broker.shortName           ?? '') ||
    mcNum.trim()               !== (broker.mcNum               ?? '') ||
    normalizeContacts(contacts) !== normalizeContacts(seedContacts(broker)) ||
    notes.trim()               !== (broker.notes               ?? '') ||
    parseHints.trim()          !== (broker.parseHints          ?? '') ||
    invoiceMethod              !== (broker.invoiceMethod       ?? '') ||
    invoiceEmail.trim()        !== (broker.invoiceEmail        ?? '') ||
    invoicePortal.trim()       !== (broker.invoicePortal       ?? '') ||
    invoiceInstructions.trim() !== (broker.invoiceInstructions ?? '');

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  /** Pre-fill the four invoicing form fields from the server-side
   *  re-parse of this customer's most recent rate confirmation. We
   *  intentionally don't auto-commit — the user reviews the values
   *  and the modal's existing Save (PATCH /v1/customers/:id) writes
   *  them. An empty parsed field leaves the existing form value alone
   *  so users don't accidentally lose what's already saved. */
  const handleRefreshFromRateCon = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    setRefreshedFromLoad(null);
    try {
      const res = await railway.refreshCustomerInvoicingFromRateCon(broker.id);
      const p = res.parsed;
      if (p.invoiceMethod === 'email' || p.invoiceMethod === 'portal') {
        setInvoiceMethod(p.invoiceMethod);
      }
      if (p.invoiceEmail)        setInvoiceEmail(p.invoiceEmail);
      if (p.invoicePortal)       setInvoicePortal(p.invoicePortal);
      if (p.invoiceInstructions) setInvoiceInstructions(p.invoiceInstructions);
      setRefreshedFromLoad({ id: res.sourceLoadId, loadNum: res.sourceLoadNum });
    } catch (err) {
      const msg = (err as Error)?.message ?? '';
      if (/no_rate_con/i.test(msg)) {
        setRefreshError('No rate con on file for this customer yet.');
      } else if (/rate_con_unreadable/i.test(msg)) {
        setRefreshError("Couldn't read the latest rate con — it may be a legacy format. Re-upload it.");
      } else {
        setRefreshError(`Refresh failed: ${msg || 'unknown'}`);
      }
    } finally {
      setRefreshing(false);
    }
  }, [broker.id, refreshing]);

  useImperativeHandle(ref, () => ({
    isDirty: () => dirty,
    save: () => updateCustomer(broker.id, {
      // Drop a blank name into the API — server validates name is
      // required and rejects empties, but guard here too so a typo
      // can't accidentally blank the canonical record (the field is
      // saved by the modal's autosave on close + an invalid empty
      // would surface as a confusing 500 to the user).
      name:                name.trim() || broker.name,
      shortName:           shortName.trim()           || undefined,
      mcNum:               mcNum.trim()               || undefined,
      // Strip empty contacts (all three fields blank) and trim each
      // remaining field so persisted data isn't littered with
      // half-finished entries.
      contacts: contacts
        .map(c => ({
          id:    c.id,
          name:  c.name?.trim()  || undefined,
          email: c.email?.trim() || undefined,
          phone: c.phone?.trim() || undefined,
        }))
        .filter(c => c.name || c.email || c.phone),
      notes:               notes.trim()               || undefined,
      parseHints:          parseHints.trim()          || undefined,
      invoiceMethod:       invoiceMethod || undefined,
      // Only persist the field that matches the chosen method; clears stale
      // values left over from a previous selection.
      invoiceEmail:        invoiceMethod === 'email'  ? (invoiceEmail.trim()  || undefined) : undefined,
      invoicePortal:       invoiceMethod === 'portal' ? (invoicePortal.trim() || undefined) : undefined,
      invoiceInstructions: invoiceInstructions.trim() || undefined,
    }),
    discard: () => {
      setName(broker.name ?? '');
      setShortName(broker.shortName ?? '');
      setMcNum(broker.mcNum ?? '');
      setContacts(seedContacts(broker));
      setNotes(broker.notes ?? '');
      setParseHints(broker.parseHints ?? '');
      setInvoiceMethod(broker.invoiceMethod ?? '');
      setInvoiceEmail(broker.invoiceEmail ?? '');
      setInvoicePortal(broker.invoicePortal ?? '');
      setInvoiceInstructions(broker.invoiceInstructions ?? '');
    },
  }), [name, shortName, mcNum, contacts, notes, parseHints, invoiceMethod, invoiceEmail, invoicePortal, invoiceInstructions, broker]);

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  };

  // Total revenue uses total_billable (linehaul + billable accessorials,
  // trigger-maintained). Falls back to loadPrice for legacy rows.
  const totalRevenue = loads.reduce((s, e) => s + (e.totalBillable ?? e.loadPrice ?? 0), 0);
  const avgRevenue   = loads.length > 0 ? totalRevenue / loads.length : 0;
  const lastLoadStart = loads.reduce<string | null>((latest, e) => {
    if (!e.start) return latest;
    return latest && latest >= e.start ? latest : e.start;
  }, null);
  const lastLoadLabel = lastLoadStart
    ? new Date(lastLoadStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';

  const query = search.trim().toLowerCase();

  const searchResults: CalendarEvent[] | null = query
    ? sortLoads(loads.filter(e => (e.loadNum ?? '').toLowerCase().includes(query)), sortField, sortDir)
    : null;

  const inProgress   = sortLoads(loads.filter(e => isInProgress(e, tz)),  sortField, sortDir);
  const allUpcoming  = sortLoads(loads.filter(e => isUpcoming(e, tz)),    sortField, sortDir === 'asc' ? 'asc' : 'desc');
  const allCompleted = sortLoads(loads.filter(e => isCompleted(e, tz)),   sortField, sortDir === 'desc' ? 'desc' : 'asc');

  const upcomingVisible  = showAllUpcoming  ? allUpcoming  : allUpcoming.slice(0, 10);
  const completedVisible = showAllCompleted ? allCompleted : allCompleted.slice(0, 10);

  return (
    <div className="px-7 py-6">

      {/* Avatar + name. Heading reflects the local `name` state so
          the edit field below mirrors live as the user types — the
          customer record header doesn't drift while the form is
          dirty. */}
      <div className="flex items-center gap-4 mb-6">
        <div className="w-14 h-14 rounded-full shrink-0 flex items-center justify-center text-lg font-bold text-white"
          style={{ background: ACCENT }}>
          {brokerInitials(name || broker.name)}
        </div>
        <div className="min-w-0">
          <div className="text-lg font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
            {name.trim() || broker.name}
          </div>
          {broker.mcNum && (
            <div className="text-xs mt-0.5 flex items-center gap-1" style={{ color: 'var(--gc-text-3)' }}>
              <Hash size={10} /> MC {broker.mcNum}
            </div>
          )}
          {broker.aliases.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {broker.aliases.map(a => (
                <span key={a} className="px-2 py-0.5 rounded-lg text-[10px] font-medium"
                  style={{ background: 'var(--gc-border-light)', color: 'var(--gc-text-3)' }}>
                  {a}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Details form */}
      <div className="mb-6">
        <SectionLabel>Details</SectionLabel>
        {/* Full Name spans the row above Short Name + MC Number so
            it reads as the primary identifier (which it is — every
            customer-matching path in the app keys off this string). */}
        <div className="mb-3">
          <PField label="Full Name" icon={<Building2 size={11} />}>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="Full company name" style={P_INPUT}
              onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
              onBlur={e => e.currentTarget.style.borderColor = 'var(--gc-border)'} />
          </PField>
          {!name.trim() && (
            <div className="text-[11px] mt-1" style={{ color: '#d93025' }}>
              Full name can't be blank.
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <PField label="Short Name" icon={<Hash size={11} />}>
            <input type="text" value={shortName} onChange={e => setShortName(e.target.value)}
              placeholder="e.g. Echo, Coyote…" style={P_INPUT}
              onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
              onBlur={e => e.currentTarget.style.borderColor = 'var(--gc-border)'} />
          </PField>
          <PField label="MC Number" icon={<Hash size={11} />}>
            <input type="text" value={mcNum} onChange={e => setMcNum(e.target.value)}
              placeholder="MC#…" style={P_INPUT}
              onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
              onBlur={e => e.currentTarget.style.borderColor = 'var(--gc-border)'} />
          </PField>
        </div>

        {/* Contacts — grow / edit / remove per-rep. Renders a card per
            entry so a broker with five reps reads as five obvious blocks
            instead of a wall of repeated form fields. */}
        <div className="mt-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-extrabold uppercase tracking-wider"
              style={{ color: 'var(--gc-text-1)' }}>
              Contacts
            </span>
            <button type="button"
              onClick={() => setContacts(cs => [...cs, { id: crypto.randomUUID() }])}
              className="text-[11px] font-bold flex items-center gap-1 px-2 py-1 rounded-md transition-colors"
              style={{ color: ACCENT, background: 'transparent', border: `1px solid ${ACCENT}40`, cursor: 'pointer' }}
              onMouseEnter={e => (e.currentTarget.style.background = `${ACCENT}10`)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <Plus size={11} /> Add contact
            </button>
          </div>
          {contacts.length === 0 ? (
            <div className="text-[12px] px-3 py-3 rounded-md" style={{
              color: 'var(--gc-text-3)',
              background: 'var(--gc-bg)',
              border: '1px dashed var(--gc-border)',
            }}>
              No contacts yet. Click <strong>Add contact</strong> to log a rep.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {contacts.map((c, idx) => (
                <div key={c.id} className="rounded-md p-2.5"
                  style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border)' }}>
                  <div className="grid grid-cols-3 gap-2">
                    <PField label="Name" icon={<User size={11} />}>
                      <input type="text" value={c.name ?? ''} placeholder="Full name…" style={P_INPUT}
                        onChange={e => setContacts(cs => cs.map((x, i) => i === idx ? { ...x, name: e.target.value } : x))}
                        onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
                        onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')} />
                    </PField>
                    <PField label="Email" icon={<Mail size={11} />}>
                      <input type="email" value={c.email ?? ''} placeholder="email@customer.com" style={P_INPUT}
                        onChange={e => setContacts(cs => cs.map((x, i) => i === idx ? { ...x, email: e.target.value } : x))}
                        onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
                        onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')} />
                    </PField>
                    <PField label="Phone" icon={<Phone size={11} />}>
                      <div className="flex items-center gap-1">
                        <input type="tel" value={c.phone ?? ''} placeholder="(555) 555-5555" style={P_INPUT}
                          onChange={e => setContacts(cs => cs.map((x, i) => i === idx ? { ...x, phone: e.target.value } : x))}
                          onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
                          onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')} />
                        {(() => {
                          const confirming = confirmDeleteContactId === c.id;
                          return (
                            <button type="button"
                              title={confirming ? 'Click again to confirm' : 'Remove contact'}
                              onClick={() => {
                                if (confirming) {
                                  setContacts(cs => cs.filter((_, i) => i !== idx));
                                  setConfirmDeleteContactId(null);
                                } else {
                                  setConfirmDeleteContactId(c.id);
                                }
                              }}
                              className="flex items-center justify-center rounded-md transition-colors px-2"
                              style={{
                                minWidth: 28, height: 28,
                                color: confirming ? '#fff' : 'var(--gc-text-3)',
                                background: confirming ? '#b91c1c' : 'transparent',
                                border: `1px solid ${confirming ? '#b91c1c' : 'var(--gc-border)'}`,
                                cursor: 'pointer', flexShrink: 0,
                                fontSize: 11, fontWeight: 800,
                                whiteSpace: 'nowrap',
                              }}
                              onMouseEnter={e => {
                                if (confirming) return;
                                e.currentTarget.style.background = '#fee2e2';
                                e.currentTarget.style.color = '#b91c1c';
                                e.currentTarget.style.borderColor = '#fecaca';
                              }}
                              onMouseLeave={e => {
                                if (confirming) return;
                                e.currentTarget.style.background = 'transparent';
                                e.currentTarget.style.color = 'var(--gc-text-3)';
                                e.currentTarget.style.borderColor = 'var(--gc-border)';
                              }}>
                              {confirming ? 'Confirm?' : <Trash2 size={13} />}
                            </button>
                          );
                        })()}
                      </div>
                    </PField>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="mt-3">
          <PField label="Notes" icon={<FileText size={11} />}>
            <textarea value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Add notes…" rows={2}
              style={{ ...P_INPUT, resize: 'vertical', lineHeight: '1.5', fontFamily: 'inherit' }}
              onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
              onBlur={e => e.currentTarget.style.borderColor = 'var(--gc-border)'} />
          </PField>
        </div>
        <div className="mt-3">
          <PField label="Rate-con parse hints" icon={<FileText size={11} />}>
            <textarea value={parseHints} onChange={e => setParseHints(e.target.value)}
              placeholder={'Customer-specific guidance for the AI parser. e.g.\n• Load # always follows "Order:"\n• Pickup # is in the BOL field on page 2'}
              rows={3}
              style={{ ...P_INPUT, resize: 'vertical', lineHeight: '1.5', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
              onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
              onBlur={e => e.currentTarget.style.borderColor = 'var(--gc-border)'} />
          </PField>
        </div>
        <div className="mt-3">
          <div className="flex items-center justify-between mb-1.5 gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider flex items-center gap-1.5" style={{ color: 'var(--gc-text-3)' }}>
              <FileText size={11} /> Invoice routing
            </div>
            {/* Re-runs the rate-con broker-harvest pass on the customer's
                most recent rate con and pre-fills the four invoicing
                fields. Doesn't auto-save — user reviews + hits the
                modal's normal Save. */}
            <button type="button"
              onClick={() => void handleRefreshFromRateCon()}
              disabled={refreshing}
              className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md transition-colors disabled:opacity-60"
              style={{
                color:      ACCENT,
                background: `${ACCENT}0d`,
                border:     `1px solid ${ACCENT}40`,
                cursor:     refreshing ? 'wait' : 'pointer',
              }}
              title="Re-parse this customer's most recent rate con for invoicing instructions">
              {refreshing
                ? <Loader2 size={10} className="animate-spin" />
                : <Sparkles size={10} />}
              {refreshing ? 'Parsing…' : 'Refresh from rate con'}
            </button>
          </div>
          {refreshError && (
            <div className="flex items-start gap-1.5 mb-2 px-2 py-1.5 rounded-md text-[11px]"
              style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
              <AlertCircle size={11} style={{ marginTop: 1, flexShrink: 0 }} />
              {refreshError}
            </div>
          )}
          {refreshedFromLoad && !refreshError && (
            <div className="flex items-center gap-1.5 mb-2 px-2 py-1.5 rounded-md text-[11px]"
              style={{ background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0' }}>
              <CheckCircle2 size={11} style={{ flexShrink: 0 }} />
              Pre-filled from load
              {refreshedFromLoad.loadNum ? ` #${refreshedFromLoad.loadNum}` : ''}.
              Review and click Save to apply.
            </div>
          )}
          {/* Method picker */}
          <div className="flex gap-1.5 mb-2">
            {(['email', 'portal'] as const).map(m => {
              const active = invoiceMethod === m;
              return (
                <button key={m} type="button"
                  onClick={() => setInvoiceMethod(active ? '' : m)}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                  style={{
                    border: `1px solid ${active ? ACCENT : 'var(--gc-border)'}`,
                    background: active ? `${ACCENT}10` : 'transparent',
                    color: active ? ACCENT : 'var(--gc-text-2)',
                    cursor: 'pointer',
                  }}>
                  {m === 'email' ? 'Email' : 'Online portal'}
                </button>
              );
            })}
          </div>
          {/* Conditional field */}
          {invoiceMethod === 'email' ? (
            <PField label="Billing email" icon={<Mail size={11} />}>
              <input type="email" value={invoiceEmail} onChange={e => setInvoiceEmail(e.target.value)}
                placeholder="ap@customer.com" style={P_INPUT}
                onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
                onBlur={e => e.currentTarget.style.borderColor = 'var(--gc-border)'} />
            </PField>
          ) : invoiceMethod === 'portal' ? (
            <PField label="Portal" icon={<FileText size={11} />}>
              <input type="text" value={invoicePortal} onChange={e => setInvoicePortal(e.target.value)}
                placeholder="TriumphPay (https://app.triumphpay.com)" style={P_INPUT}
                onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
                onBlur={e => e.currentTarget.style.borderColor = 'var(--gc-border)'} />
            </PField>
          ) : null}
          <div className="mt-2">
            <PField label="Other billing notes" icon={<FileText size={11} />}>
              <textarea value={invoiceInstructions} onChange={e => setInvoiceInstructions(e.target.value)}
                rows={3}
                style={{ ...P_INPUT, resize: 'vertical', lineHeight: '1.5', fontFamily: 'inherit' }}
                onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
                onBlur={e => e.currentTarget.style.borderColor = 'var(--gc-border)'} />
            </PField>
          </div>
        </div>
      </div>

      {/* Stats — between billing notes and load history */}
      {!loading && (
        <div className="grid grid-cols-2 gap-3 mb-6">
          <StatCard icon={<Package size={13} />}      label="Total Loads"   value={String(loads.length)} />
          <StatCard icon={<Clock size={13} />}        label="Last Load"     value={lastLoadLabel} />
          <StatCard icon={<TrendingUp size={13} />}   label="Total Revenue" value={moneyFmt.format(totalRevenue)} />
          <StatCard icon={<TrendingUp size={13} />}   label="Avg per Load"  value={loads.length > 0 ? moneyFmt.format(avgRevenue) : '—'} />
        </div>
      )}

      {/* Loads */}
      <div>
        <div className="flex items-center gap-3 mb-4">
          <SectionLabel>
            Loads
            {!loading && loads.length > 0 && (
              <span className="ml-2 text-[10px] font-semibold px-2 py-0.5 rounded-lg"
                style={{ background: 'var(--gc-border-light)', color: 'var(--gc-text-3)' }}>
                {loads.length}
              </span>
            )}
          </SectionLabel>
          {!loading && loads.length > 0 && (
            <div className="flex-1 relative" style={{ maxWidth: 200 }}>
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                style={{ color: 'var(--gc-text-3)' }} />
              <input
                type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search load #…"
                style={{
                  width: '100%', paddingLeft: 28, paddingRight: 8,
                  height: 30, borderRadius: 8, fontSize: 12,
                  border: '1px solid var(--gc-border)',
                  background: 'var(--gc-surface)',
                  color: 'var(--gc-text-1)', outline: 'none', boxSizing: 'border-box',
                }}
                onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
                onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
              />
            </div>
          )}
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-8 justify-center" style={{ color: 'var(--gc-text-3)' }}>
            <Clock size={15} className="animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : loads.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 rounded-xl"
            style={{ border: '1px dashed var(--gc-border-light)' }}>
            <Package size={20} style={{ color: 'var(--gc-text-3)', opacity: 0.45 }} />
            <span className="text-sm" style={{ color: 'var(--gc-text-3)' }}>No loads found</span>
          </div>
        ) : searchResults !== null ? (
          <LoadTable rows={searchResults} sortField={sortField} sortDir={sortDir}
            onSort={handleSort} selectedLoadId={selectedLoadId} onSelectLoad={onSelectLoad}
            emptyLabel={`No loads matching "${search}"`} />
        ) : (
          <div>
            {inProgress.length > 0 && (
              <div className="mb-4">
                <GroupLabel color="#e37400" bg="#fef3e2">In Progress · {inProgress.length}</GroupLabel>
                <LoadTable rows={inProgress} sortField={sortField} sortDir={sortDir}
                  onSort={handleSort} selectedLoadId={selectedLoadId} onSelectLoad={onSelectLoad} />
              </div>
            )}
            {allUpcoming.length > 0 && (
              <div className="mb-4">
                <GroupLabel color={ACCENT} bg="#e8f0fe">
                  Upcoming · {showAllUpcoming ? allUpcoming.length : `next ${upcomingVisible.length} of ${allUpcoming.length}`}
                </GroupLabel>
                <LoadTable rows={upcomingVisible} sortField={sortField} sortDir={sortDir}
                  onSort={handleSort} selectedLoadId={selectedLoadId} onSelectLoad={onSelectLoad} />
                {allUpcoming.length > 10 && (
                  <ExpandButton expanded={showAllUpcoming} count={allUpcoming.length}
                    label="upcoming" onClick={() => setShowAllUpcoming(v => !v)} />
                )}
              </div>
            )}
            {allCompleted.length > 0 && (
              <div>
                <GroupLabel color="#188038" bg="#e6f4ea">
                  Completed · {showAllCompleted ? allCompleted.length : `last ${completedVisible.length} of ${allCompleted.length}`}
                </GroupLabel>
                <LoadTable rows={completedVisible} sortField={sortField} sortDir={sortDir}
                  onSort={handleSort} selectedLoadId={selectedLoadId} onSelectLoad={onSelectLoad} />
                {allCompleted.length > 10 && (
                  <ExpandButton expanded={showAllCompleted} count={allCompleted.length}
                    label="completed" onClick={() => setShowAllCompleted(v => !v)} />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

// ─── Load Table ───────────────────────────────────────────────────────────────

function LoadTable({ rows, sortField, sortDir, onSort, selectedLoadId, onSelectLoad, emptyLabel }: {
  rows: CalendarEvent[];
  sortField: SortField;
  sortDir: 'asc' | 'desc';
  onSort: (f: SortField) => void;
  selectedLoadId: string | null;
  onSelectLoad: (id: string) => void;
  emptyLabel?: string;
}) {
  if (rows.length === 0) {
    return <div className="text-sm py-3 px-1" style={{ color: 'var(--gc-text-3)' }}>{emptyLabel ?? 'None'}</div>;
  }

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ChevronsUpDown size={10} style={{ opacity: 0.4 }} />;
    return sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />;
  };

  const thBase: React.CSSProperties = {
    padding: '7px 10px', textAlign: 'left',
    fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.06em', color: 'var(--gc-text-3)',
    whiteSpace: 'nowrap', userSelect: 'none',
  };

  return (
    <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid var(--gc-border-light)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
            <th style={{ ...thBase, cursor: 'pointer' }} onClick={() => onSort('loadNum')}>
              <div className="flex items-center gap-1">Load # <SortIcon field="loadNum" /></div>
            </th>
            <th style={{ ...thBase, cursor: 'pointer' }} onClick={() => onSort('date')}>
              <div className="flex items-center gap-1">Date <SortIcon field="date" /></div>
            </th>
            <th style={thBase}>Route</th>
            <th style={{ ...thBase, cursor: 'pointer' }} onClick={() => onSort('status')}>
              <div className="flex items-center gap-1">Status <SortIcon field="status" /></div>
            </th>
            <th style={thBase}>Revenue</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(ev => {
            const sm = STATUS_META[ev.status ?? 'scheduled'] ?? STATUS_META.scheduled;
            const isSelected = ev.id === selectedLoadId;
            return (
              <tr key={ev.id}
                style={{
                  borderBottom: '1px solid var(--gc-border-light)',
                  cursor: 'pointer',
                  background: isSelected ? 'var(--gc-blue-light)' : 'transparent',
                }}
                onClick={() => onSelectLoad(ev.id)}
                onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}>
                <td style={{ padding: '9px 10px', color: isSelected ? ACCENT : 'var(--gc-text-2)', fontWeight: 700 }}>
                  {ev.loadNum ? `#${ev.loadNum}` : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                </td>
                <td style={{ padding: '9px 10px', color: 'var(--gc-text-2)', whiteSpace: 'nowrap' }}>
                  {fmtDate(ev.start)}
                </td>
                <td style={{ padding: '9px 10px', color: 'var(--gc-text-1)', maxWidth: 160 }}>
                  <span className="truncate block font-bold" title={ev.title}>{ev.title}</span>
                </td>
                <td style={{ padding: '9px 10px' }}>
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-lg whitespace-nowrap"
                    style={{ color: sm.color, background: sm.bg }}>
                    {sm.label}
                  </span>
                </td>
                <td style={{ padding: '9px 10px', fontWeight: 700, color: 'var(--gc-text-1)', whiteSpace: 'nowrap' }}>
                  {ev.loadPrice != null ? moneyFmt.format(ev.loadPrice) : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Load Detail Panel ────────────────────────────────────────────────────────

function LoadDetailPanel({ load, assets, onClose, onOpenEditor }: {
  load: CalendarEvent;
  assets: { id: number; name: string; color: string; unit?: string }[];
  onClose: () => void;
  onOpenEditor: () => void;
}) {
  const asset = assets.find(a => a.id === load.assetId);
  const sm = STATUS_META[load.status ?? 'scheduled'] ?? STATUS_META.scheduled;

  // Margin is "what we keep after paying the driver" — denominator is
  // total billable (linehaul + accessorials, what the broker pays),
  // numerator is total billable minus driver pay. Falls back to
  // linehaul when total_billable is missing.
  const marginBase = load.totalBillable ?? load.loadPrice;
  const margin = (marginBase && load.driverPay)
    ? ((marginBase - load.driverPay) / marginBase * 100).toFixed(1)
    : null;

  const accessorialTotal = (load.accessorials ?? [])
    .filter(a => a.billable)
    .reduce((s, a) => s + a.amount, 0);

  const stops = load.stops ?? [];
  const pickup   = stops.find(s => s.type === 'pickup');
  const delivery = stops.find(s => s.type === 'delivery');

  return (
    <div className="flex flex-col h-full">
      {/* Load detail header */}
      <div className="shrink-0 flex items-center justify-between px-6 py-4"
        style={{ borderBottom: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg transition-colors"
            style={{ color: 'var(--gc-text-2)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <ArrowLeft size={13} />
            Back
          </button>
          <div style={{ width: 1, height: 16, background: 'var(--gc-border-light)' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--gc-text-1)' }}>
            {load.loadNum ? `Load #${load.loadNum}` : 'Load Detail'}
          </span>
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg"
            style={{ color: sm.color, background: sm.bg }}>
            {sm.label}
          </span>
        </div>
        <button
          onClick={onOpenEditor}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
          style={{ color: ACCENT }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-light)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          <ExternalLink size={12} />
          Open editor
        </button>
      </div>

      {/* Load detail body */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

        {/* Route */}
        <div>
          <DetailSectionLabel>Route</DetailSectionLabel>
          <div className="text-sm font-bold" style={{ color: 'var(--gc-text-1)' }}>{load.title}</div>
          {(pickup || delivery) && (
            <div className="mt-3 space-y-2">
              {pickup && (
                <StopRow label="Pickup" address={pickup.address ?? pickup.facilityName} time={pickup.apptStart} />
              )}
              {delivery && (
                <StopRow label="Delivery" address={delivery.address ?? delivery.facilityName} time={delivery.apptStart} />
              )}
            </div>
          )}
        </div>

        {/* Dispatch */}
        <div>
          <DetailSectionLabel>Dispatch</DetailSectionLabel>
          <div className="space-y-2">
            {asset && (
              <DetailRow icon={<Truck size={13} />} label="Truck">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: asset.color }} />
                  <span>{asset.name}{asset.unit ? ` #${asset.unit}` : ''}</span>
                </div>
              </DetailRow>
            )}
            {load.driverName && (
              <DetailRow icon={<User size={13} />} label="Driver">{load.driverName}</DetailRow>
            )}
            <DetailRow icon={<Calendar size={13} />} label="Start">{fmtDateTime(load.start)}</DetailRow>
            <DetailRow icon={<Calendar size={13} />} label="End">{fmtDateTime(load.end)}</DetailRow>
            {load.refNums && load.refNums.length > 0 && (
              <DetailRow icon={<Hash size={13} />} label="Ref #">{load.refNums.map(r => r.label ? `${r.label} ${r.value}` : r.value).join(' · ')}</DetailRow>
            )}
            {load.dispatcher && (
              <DetailRow icon={<User size={13} />} label="Dispatcher">{load.dispatcher}</DetailRow>
            )}
            {load.trailerType && (
              <DetailRow icon={<Truck size={13} />} label="Trailer">{load.trailerType}</DetailRow>
            )}
          </div>
        </div>

        {/* Financials */}
        <div>
          <DetailSectionLabel>Financials</DetailSectionLabel>
          <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--gc-border-light)' }}>
            {load.loadPrice != null && (
              <FinRow label="Linehaul" value={moneyFmt.format(load.loadPrice)} accent />
            )}
            {/* Total billable — only surfaces when accessorials make it
                differ from linehaul. The whole line is hidden when
                linehaul == total to keep the panel uncluttered for the
                common no-accessorial case. */}
            {load.totalBillable != null && load.loadPrice != null && load.totalBillable !== load.loadPrice && (
              <FinRow label="Total billable" value={moneyFmt.format(load.totalBillable)} accent />
            )}
            {load.driverPay != null && (
              <FinRow label="Driver Pay" value={moneyFmt.format(load.driverPay)} />
            )}
            {accessorialTotal > 0 && (
              <FinRow label="Accessorials" value={moneyFmt.format(accessorialTotal)} />
            )}
            {margin !== null && (
              <FinRow label="Margin" value={`${margin}%`} />
            )}
          </div>
          {(load.accessorials?.length ?? 0) > 0 && (
            <div className="mt-2 space-y-1">
              {load.accessorials!.map(a => (
                <div key={a.id} className="flex justify-between text-xs px-1" style={{ color: 'var(--gc-text-3)' }}>
                  <span className="capitalize">{a.category.replace('_', ' ')}{a.description ? ` — ${a.description}` : ''}</span>
                  <span>{moneyFmt.format(a.amount)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Special Instructions — load.notes is canonical; specialInstructions is legacy */}
        {(load.notes || load.specialInstructions) && (
          <div>
            <DetailSectionLabel>Special Instructions</DetailSectionLabel>
            <NoteBlock label="Special Instructions" text={load.notes ?? load.specialInstructions ?? ''} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Load detail sub-components ───────────────────────────────────────────────

function StopRow({ label, address, time }: { label: string; address?: string; time?: string }) {
  return (
    <div className="flex gap-2.5">
      <div className="flex flex-col items-center shrink-0 pt-0.5" style={{ width: 14 }}>
        <div className="w-2.5 h-2.5 rounded-full border-2 shrink-0"
          style={{ borderColor: label === 'Pickup' ? '#1a73e8' : '#188038', background: 'var(--gc-surface)' }} />
        {label === 'Pickup' && <div className="flex-1 w-px mt-1" style={{ background: 'var(--gc-border-light)' }} />}
      </div>
      <div className="pb-3">
        <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>{label}</div>
        {address && <div className="text-sm mt-0.5" style={{ color: 'var(--gc-text-1)' }}>{address}</div>}
        {time && <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-3)' }}>{fmtDateTime(time)}</div>}
      </div>
    </div>
  );
}

function DetailRow({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="shrink-0 mt-0.5" style={{ color: 'var(--gc-text-3)' }}>{icon}</div>
      <span className="shrink-0 text-xs font-medium" style={{ color: 'var(--gc-text-3)', width: 72 }}>{label}</span>
      <span className="text-sm" style={{ color: 'var(--gc-text-1)' }}>{children}</span>
    </div>
  );
}

function FinRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex justify-between items-center px-4 py-2.5"
      style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
      <span className="text-sm" style={{ color: 'var(--gc-text-2)' }}>{label}</span>
      <span className="text-sm font-semibold" style={{ color: accent ? ACCENT : 'var(--gc-text-1)' }}>{value}</span>
    </div>
  );
}

function NoteBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--gc-border-light)' }}>
      <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider"
        style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border-light)', color: 'var(--gc-text-3)' }}>
        {label}
      </div>
      <div className="px-3 py-2.5 text-sm" style={{ color: 'var(--gc-text-2)', lineHeight: 1.6 }}>
        {text.split('\n').map((line, i) => (
          <span key={i}>{line}{i < text.split('\n').length - 1 && <br />}</span>
        ))}
      </div>
    </div>
  );
}

function DetailSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--gc-text-3)' }}>
      {children}
    </div>
  );
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function GroupLabel({ color, bg, children }: { color: string; bg: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-lg"
        style={{ color, background: bg }}>
        {children}
      </span>
      <div className="flex-1 h-px" style={{ background: 'var(--gc-border-light)' }} />
    </div>
  );
}

function ExpandButton({ expanded, count, label, onClick }: {
  expanded: boolean; count: number; label: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      className="mt-2 flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
      style={{ color: ACCENT }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-light)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      {expanded ? <><ChevronUp size={12} /> Show less</> : <><ChevronDown size={12} /> Show all {count} {label}</>}
    </button>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl p-3.5 flex flex-col gap-1"
      style={{ border: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
      <div className="flex items-center gap-1.5" style={{ color: 'var(--gc-text-3)' }}>
        {icon}
        <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-base font-bold" style={{ color: 'var(--gc-text-1)' }}>{value}</div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center text-[10px] font-extrabold uppercase tracking-widest mb-1.5"
      style={{ color: 'var(--gc-text-1)' }}>
      {children}
    </div>
  );
}

function PField({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider mb-1.5"
        style={{ color: 'var(--gc-text-1)' }}>
        {icon}{label}
      </label>
      {children}
    </div>
  );
}
