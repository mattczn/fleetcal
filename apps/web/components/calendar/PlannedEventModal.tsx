'use client';

import { useEffect, useMemo, useState } from 'react';
import { X, Search, Clock, MoveRight, Link2, Plus, Trash2, CalendarRange } from 'lucide-react';
import {
  PLANNED_PURPOSES, PLANNED_PURPOSE_LABEL,
  type PlannedEvent, type PlannedPurpose,
} from '@fleetcal/types';
import { useCalendarStore } from '@/store/useCalendarStore';
import { usePlannedStore, type PlannedModalState } from '@/store/usePlannedStore';
import { useModules } from '@/lib/useModules';
import { usePermissions } from '@/lib/usePermissions';
import DatePicker from './DatePicker';
import TimePicker from './TimePicker';

const ACCENT = '#475569';

const PURPOSE_ICON: Record<PlannedPurpose, typeof Search> = {
  find_load:     Search,
  expected_load: Clock,
  reposition:    MoveRight,
};

const TITLE_PLACEHOLDER: Record<PlannedPurpose, string> = {
  find_load:     'SLC → Vegas',
  expected_load: 'ITS National · Spanish Fork → SLC',
  reposition:    'Empty to Vegas for Monday pickup',
};

/** How far around the plan's window the attach picker looks for loads
 *  on the same truck. Wide on purpose — a load often books a little
 *  earlier or later than the plan guessed. */
const ATTACH_WINDOW_DAYS = 3;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const labelCls = 'text-[11px] font-semibold uppercase tracking-wider mb-1.5';
const inputStyle: React.CSSProperties = {
  border: '1px solid var(--gc-border)', padding: '7px 10px',
  color: 'var(--gc-text-1)', background: 'var(--gc-surface)', fontFamily: 'inherit',
};

/**
 * Create / edit a planned placeholder (module: planning). Mounted once
 * on the calendar page; also owns loading the plan list, so plans only
 * fetch where they can be shown.
 */
export default function PlannedEventModal() {
  const { enabled: moduleOn } = useModules();
  const { can } = usePermissions();
  const allowed = moduleOn('planning') && can('planning.access');

  const modal      = usePlannedStore((s) => s.modal);
  const items      = usePlannedStore((s) => s.items);
  const loadPlans  = usePlannedStore((s) => s.load);

  // Load plans on mount, then refresh on focus and every 2 minutes so a
  // plan another dispatcher added shows up without a page reload. Plans
  // have no realtime channel (deliberately — see usePlannedStore).
  useEffect(() => {
    if (!allowed) return;
    void loadPlans();
    const onFocus = () => { void loadPlans(); };
    window.addEventListener('focus', onFocus);
    const t = setInterval(() => { void loadPlans(); }, 120_000);
    return () => { window.removeEventListener('focus', onFocus); clearInterval(t); };
  }, [allowed, loadPlans]);

  if (!allowed || !modal) return null;
  const editing = modal.mode === 'edit' ? items.find((p) => p.id === modal.id) ?? null : null;
  if (modal.mode === 'edit' && !editing) return null;

  // Keyed so each plan / clicked slot mounts a fresh form whose state
  // is seeded once from props — no reset-in-effect.
  const formKey = `${modal.mode}:${modal.id ?? ''}:${JSON.stringify(modal.defaults ?? {})}`;
  return <PlanForm key={formKey} defaults={modal.defaults} editing={editing} />;
}

function PlanForm({ defaults, editing }: { defaults?: PlannedModalState['defaults']; editing: PlannedEvent | null }) {
  const closeModal = usePlannedStore((s) => s.closeModal);
  const createPlan = usePlannedStore((s) => s.create);
  const updatePlan = usePlannedStore((s) => s.update);
  const removePlan = usePlannedStore((s) => s.remove);
  const attachPlan = usePlannedStore((s) => s.attach);
  const setPendingAttach = usePlannedStore((s) => s.setPendingAttach);

  const assets          = useCalendarStore((s) => s.assets);
  const drivers         = useCalendarStore((s) => s.drivers);
  const driverPrefs     = useCalendarStore((s) => s.driverPrefs);
  const events          = useCalendarStore((s) => s.events);
  const openCreateModal = useCalendarStore((s) => s.openCreateModal);

  const src = editing ?? defaults ?? {};
  const seedStart = src.start ?? '', seedEnd = src.end ?? '';
  const [purpose,   setPurpose]   = useState<PlannedPurpose>(src.purpose ?? 'find_load');
  const [title,     setTitle]     = useState(src.title ?? '');
  const [assetId,   setAssetId]   = useState<number | null>(src.assetId ?? null);
  // New plan: default the driver to the truck's usual driver.
  const [driverId,  setDriverId]  = useState<number | null>(() => editing
    ? editing.driverId ?? null
    : src.driverId ?? (src.assetId != null ? driverPrefs[src.assetId] ?? null : null));
  const [startDate, setStartDate] = useState(seedStart.slice(0, 10));
  const [startTime, setStartTime] = useState(seedStart.slice(11, 16) || '08:00');
  const [endDate,   setEndDate]   = useState(seedEnd.slice(0, 10) || seedStart.slice(0, 10));
  const [endTime,   setEndTime]   = useState(seedEnd.slice(11, 16) || '17:00');
  const [notes,     setNotes]     = useState(editing?.notes ?? '');
  const [busy,      setBusy]      = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [showAttach, setShowAttach] = useState(false);

  const truckOptions = useMemo(
    () => assets.filter((a) => !a.hidden && a.type !== 'Unassigned' && a.name !== 'Unassigned'),
    [assets],
  );

  // Loads on the same truck around the plan's window, newest-relevant
  // first, for the attach picker. Revenue events with a load only.
  const attachCandidates = useMemo(() => {
    if (!editing) return [];
    const lo = addDays(editing.start.slice(0, 10), -ATTACH_WINDOW_DAYS);
    const hi = addDays(editing.end.slice(0, 10), ATTACH_WINDOW_DAYS);
    const seen = new Set<string>();
    return events
      .filter((e) => e.assetId === editing.assetId && e.loadId && !e.deletedAt && e.eventKind !== 'non_revenue'
        && e.start.slice(0, 10) <= hi && e.end.slice(0, 10) >= lo)
      .filter((e) => { if (seen.has(e.loadId!)) return false; seen.add(e.loadId!); return true; })
      .sort((a, b) => Math.abs(Date.parse(a.start) - Date.parse(editing.start)) - Math.abs(Date.parse(b.start) - Date.parse(editing.start)));
  }, [editing, events]);

  const start = startDate ? `${startDate}T${startTime || '00:00'}` : '';
  const end   = endDate   ? `${endDate}T${endTime || '00:00'}`     : '';

  function validate(): string | null {
    if (!title.trim()) return 'Give the plan a title — what you’re looking for, e.g. “SLC → Vegas”.';
    if (assetId == null) return 'Pick a truck.';
    if (!start || !end) return 'Set a start and end.';
    if (end <= start) return 'End has to be after start.';
    return null;
  }

  async function save() {
    const v = validate();
    if (v) { setError(v); return; }
    setBusy(true);
    const body = {
      assetId: assetId!, driverId, purpose, title: title.trim(),
      notes: notes.trim() || null, start, end,
    };
    const ok = editing ? await updatePlan(editing.id, body) : await createPlan(body);
    setBusy(false);
    if (ok) closeModal();
  }

  async function remove() {
    if (!editing) return;
    if (!window.confirm('Delete this plan?')) return;
    setBusy(true);
    const ok = await removePlan(editing.id);
    setBusy(false);
    if (ok) closeModal();
  }

  async function attach(loadId: string) {
    if (!editing) return;
    setBusy(true);
    const ok = await attachPlan(editing.id, loadId);
    setBusy(false);
    if (ok) closeModal();
  }

  /** Opens the normal new-load modal pre-filled from this plan. The
   *  plan is armed so the load that gets saved from that modal is
   *  attached automatically (see usePlannedStore.pendingAttachId). */
  function createLoadFromPlan() {
    if (!editing) return;
    const driver = drivers.find((d) => d.id === editing.driverId);
    setPendingAttach(editing.id);
    closeModal();
    openCreateModal({
      assetId: editing.assetId,
      start: editing.start,
      end: editing.end,
      ...(driver ? { driverName: driver.name, driverId: driver.id } : {}),
    });
  }

  const close = () => { if (!busy) closeModal(); };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="rounded-2xl flex flex-col"
        style={{
          background: 'var(--gc-surface)', boxShadow: 'var(--shadow-3)',
          width: 520, maxWidth: '100%', maxHeight: '90vh',
          border: '1px solid var(--gc-border-light)', overflow: 'hidden',
        }}>
        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-5 pb-4"
          style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div className="flex items-start gap-3">
            <div style={{
              borderRadius: 10, padding: 8, flexShrink: 0, border: `1.5px dashed ${ACCENT}`,
              backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 5px, rgba(71,85,105,0.14) 5px 7px)',
            }}>
              <CalendarRange size={18} style={{ color: ACCENT }} />
            </div>
            <div>
              <div className="text-base font-semibold mb-0.5" style={{ color: 'var(--gc-text-1)' }}>
                {editing ? 'Edit plan' : 'New plan'}
              </div>
              <div className="text-xs" style={{ color: 'var(--gc-text-2)' }}>
                {editing?.expired
                  ? 'Expired — more than 24 hours past its end with no load attached.'
                  : 'A placeholder for work that isn’t booked yet. Drivers don’t see plans.'}
              </div>
            </div>
          </div>
          <button onClick={close} aria-label="Close"
            className="p-1 rounded-full transition-colors"
            style={{ color: 'var(--gc-text-3)' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-4">
          <div>
            <div className={labelCls} style={{ color: 'var(--gc-text-3)' }}>Purpose</div>
            <div className="flex flex-wrap gap-1.5">
              {PLANNED_PURPOSES.map((p) => {
                const Icon = PURPOSE_ICON[p];
                const active = purpose === p;
                return (
                  <button key={p} type="button" onClick={() => setPurpose(p)}
                    className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium"
                    style={{
                      background: active ? ACCENT : 'var(--gc-hover)',
                      color: active ? '#fff' : 'var(--gc-text-2)',
                    }}>
                    <Icon size={13} /> {PLANNED_PURPOSE_LABEL[p]}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label htmlFor="plan-title" className={`${labelCls} block`} style={{ color: 'var(--gc-text-3)' }}>Title</label>
            <input id="plan-title" value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder={TITLE_PLACEHOLDER[purpose]} autoFocus={!editing}
              className="w-full rounded-lg outline-none text-sm" style={inputStyle} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="plan-truck" className={`${labelCls} block`} style={{ color: 'var(--gc-text-3)' }}>Truck</label>
              <select id="plan-truck" value={assetId ?? ''}
                onChange={(e) => {
                  const id = e.target.value ? Number(e.target.value) : null;
                  setAssetId(id);
                  if (!editing && id != null && driverPrefs[id] != null) setDriverId(driverPrefs[id]);
                }}
                className="w-full rounded-lg outline-none text-sm" style={inputStyle}>
                <option value="">Select truck</option>
                {truckOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="plan-driver" className={`${labelCls} block`} style={{ color: 'var(--gc-text-3)' }}>Driver (optional)</label>
              <select id="plan-driver" value={driverId ?? ''}
                onChange={(e) => setDriverId(e.target.value ? Number(e.target.value) : null)}
                className="w-full rounded-lg outline-none text-sm" style={inputStyle}>
                <option value="">No driver</option>
                {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className={labelCls} style={{ color: 'var(--gc-text-3)' }}>Start</div>
              <div className="flex items-center gap-1.5">
                <DatePicker value={startDate} headerColor={ACCENT}
                  onChange={(v) => { setStartDate(v); if (!endDate || endDate < v) setEndDate(v); }} />
                <TimePicker value={startTime} onChange={setStartTime} headerColor={ACCENT} />
              </div>
            </div>
            <div>
              <div className={labelCls} style={{ color: 'var(--gc-text-3)' }}>End</div>
              <div className="flex items-center gap-1.5">
                <DatePicker value={endDate} onChange={setEndDate} headerColor={ACCENT} min={startDate || undefined} />
                <TimePicker value={endTime} onChange={setEndTime} headerColor={ACCENT} />
              </div>
            </div>
          </div>

          <div>
            <label htmlFor="plan-notes" className={`${labelCls} block`} style={{ color: 'var(--gc-text-3)' }}>Notes</label>
            <textarea id="plan-notes" value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="Min $600 · Julio can pre-load Friday · Kevin prefers morning pickup"
              rows={3} className="w-full rounded-lg outline-none text-sm"
              style={{ ...inputStyle, resize: 'vertical', lineHeight: '1.5' }} />
          </div>

          {editing && (
            <div className="rounded-xl p-3 flex flex-col gap-2" style={{ border: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
              <div className="text-xs font-semibold" style={{ color: 'var(--gc-text-2)' }}>Turn this plan into a load</div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setShowAttach((v) => !v)} disabled={busy}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium"
                  style={{ border: `1px solid ${ACCENT}`, color: ACCENT, background: 'var(--gc-surface)' }}>
                  <Link2 size={13} /> Attach existing load
                </button>
                <button type="button" onClick={createLoadFromPlan} disabled={busy}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium"
                  style={{ border: `1px solid ${ACCENT}`, color: ACCENT, background: 'var(--gc-surface)' }}>
                  <Plus size={13} /> Create load from plan
                </button>
              </div>
              {showAttach && (
                attachCandidates.length === 0 ? (
                  <div className="text-xs" style={{ color: 'var(--gc-text-3)' }}>
                    No loads on this truck within {ATTACH_WINDOW_DAYS} days of the plan.
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {attachCandidates.map((e) => (
                      <button key={e.loadId} type="button" onClick={() => attach(e.loadId!)} disabled={busy}
                        className="text-left rounded-lg px-3 py-2 text-xs transition-colors"
                        style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' }}
                        onMouseEnter={(ev) => (ev.currentTarget.style.background = 'var(--gc-hover)')}
                        onMouseLeave={(ev) => (ev.currentTarget.style.background = 'var(--gc-surface)')}>
                        <div className="font-semibold truncate">{e.title}</div>
                        <div style={{ color: 'var(--gc-text-3)' }}>
                          {e.start.replace('T', ' ')} → {e.end.replace('T', ' ')}{e.loadNum ? ` · #${e.loadNum}` : ''}
                        </div>
                      </button>
                    ))}
                  </div>
                )
              )}
            </div>
          )}

          {editing?.createdByName && (
            <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
              Planned by {editing.createdByName}
            </div>
          )}
          {error && <div className="text-xs" style={{ color: 'var(--gc-red)' }}>{error}</div>}
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center gap-2 px-6 py-3"
          style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
          {editing && (
            <button onClick={remove} disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium"
              style={{ color: 'var(--gc-red)' }}>
              <Trash2 size={14} /> Delete
            </button>
          )}
          <div className="flex-1" />
          <button onClick={close} disabled={busy}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ color: 'var(--gc-text-2)', background: 'transparent' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
            Cancel
          </button>
          <button onClick={save} disabled={busy}
            className="px-5 py-2 rounded-lg text-sm font-semibold"
            style={{ background: ACCENT, color: '#fff', opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Saving…' : editing ? 'Save plan' : 'Add plan'}
          </button>
        </div>
      </div>
    </div>
  );
}
