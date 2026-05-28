'use client';

/**
 * LinkedWorkOrdersSection — non-revenue maintenance event ↔ work order
 * linking surface, rendered inside EventModal at the top of the
 * non-revenue body.
 *
 * Two modes driven by `eventId`:
 *   - EDIT (eventId is set): toggles flip work order links immediately
 *     via PATCH /v1/maintenance-action-items/:id { eventId }.
 *   - CREATE (eventId is null): toggles update the parent's
 *     pendingLinkIds prop. After the event lands, the parent iterates
 *     those IDs and patches each work order's eventId in one pass.
 *
 * Asset-scoped: we only ever show work orders whose asset_id matches
 * the currently selected asset. No asset → empty-state nudge. Status
 * filter = 'open' (we don't surface in_progress / done — those are
 * closed-ish and don't make sense to attach to a fresh maintenance
 * block).
 *
 * The "available" list excludes anything already linked to a DIFFERENT
 * event so the UI doesn't tempt the dispatcher into accidentally
 * stealing a work order from another scheduled block. If they really
 * want to move it, they can unlink on the source event first.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Wrench, AlertTriangle, Link2, Loader2, Plus, Check } from 'lucide-react';
import { railway } from '@/lib/railway';
import type { MaintenanceActionItem, MaintenancePriority } from '@fleetcal/types';

interface Props {
  /** Calendar event being edited. null = create mode. */
  eventId:           string | null;
  /** Currently-selected asset on the event form. null = section
   *  shows a "pick a truck" placeholder. */
  assetId:           number | null;
  /** Create-mode buffer: work order IDs the user has checked but
   *  not saved yet (because the event doesn't exist to link to).
   *  Owned by the parent EventModal so it can apply on save. */
  pendingLinkIds:    string[];
  onPendingLinkIdsChange: (ids: string[]) => void;
}

const PRIORITY_TINT: Record<MaintenancePriority, { bg: string; fg: string }> = {
  low:    { bg: '#f1f3f4', fg: '#5f6368' },
  normal: { bg: '#e8f0fe', fg: '#1558d6' },
  high:   { bg: '#fef3c7', fg: '#92400e' },
  urgent: { bg: '#fce8e6', fg: '#b91c1c' },
};

function priorityChip(p: MaintenancePriority) {
  const t = PRIORITY_TINT[p];
  return (
    <span
      className="text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
      style={{ background: t.bg, color: t.fg }}>
      {p}
    </span>
  );
}

export default function LinkedWorkOrdersSection({
  eventId, assetId, pendingLinkIds, onPendingLinkIdsChange,
}: Props) {
  const [linked,    setLinked]    = useState<MaintenanceActionItem[]>([]);
  const [available, setAvailable] = useState<MaintenanceActionItem[]>([]);
  const [loading,   setLoading]   = useState(false);
  const [savingId,  setSavingId]  = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const isCreateMode = !eventId;

  // Combined fetch: linked-to-this-event + open-on-this-asset. We do
  // both in parallel and reconcile so the "available" list never
  // re-includes a row we've already linked here.
  useEffect(() => {
    if (!assetId) {
      setLinked([]);
      setAvailable([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const linkedQ = eventId
      ? railway.listMaintenanceActionItems({ eventId, limit: 100 })
          .then(r => r.actionItems)
          .catch(() => [])
      : Promise.resolve([]);
    const availQ = railway.listMaintenanceActionItems({ assetId, status: 'open', limit: 100 })
      .then(r => r.actionItems)
      .catch(() => []);
    Promise.all([linkedQ, availQ]).then(([linkedRows, allOpen]) => {
      if (cancelled) return;
      // "Available" = open WOs on this asset that aren't already linked
      // somewhere else. Anything linked to THIS event lives in `linked`,
      // not here. Anything linked to a DIFFERENT event is hidden until
      // the dispatcher unlinks it on the source — avoids accidental
      // theft.
      const linkedIds = new Set(linkedRows.map(r => r.id));
      const avail = allOpen.filter(
        wo => !linkedIds.has(wo.id) && (!wo.eventId || wo.eventId === eventId)
      );
      setLinked(linkedRows);
      setAvailable(avail);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [assetId, eventId, reloadKey]);

  // EDIT MODE: persist a link/unlink immediately. Optimistically move
  // the row between the two arrays so the UI feels instant; rollback
  // on error.
  const linkNow = useCallback(async (woId: string) => {
    if (!eventId) return;
    setSavingId(woId);
    const target = available.find(w => w.id === woId);
    if (target) {
      setAvailable(a => a.filter(w => w.id !== woId));
      setLinked(l => [...l, { ...target, eventId }]);
    }
    try {
      await railway.updateMaintenanceActionItem(woId, { eventId });
    } catch (err) {
      console.error('[LinkedWorkOrders] link failed:', err);
      // Force a clean re-fetch instead of trying to thread rollback.
      setReloadKey(k => k + 1);
    } finally {
      setSavingId(null);
    }
  }, [eventId, available]);

  const unlinkNow = useCallback(async (woId: string) => {
    if (!eventId) return;
    setSavingId(woId);
    const target = linked.find(w => w.id === woId);
    if (target) {
      setLinked(l => l.filter(w => w.id !== woId));
      setAvailable(a => [...a, { ...target, eventId: undefined }]);
    }
    try {
      await railway.updateMaintenanceActionItem(woId, { eventId: null });
    } catch (err) {
      console.error('[LinkedWorkOrders] unlink failed:', err);
      setReloadKey(k => k + 1);
    } finally {
      setSavingId(null);
    }
  }, [eventId, linked]);

  // CREATE MODE: just toggle the pending set on the parent. The
  // parent applies these once the event is created.
  const togglePending = useCallback((woId: string) => {
    onPendingLinkIdsChange(
      pendingLinkIds.includes(woId)
        ? pendingLinkIds.filter(id => id !== woId)
        : [...pendingLinkIds, woId]
    );
  }, [pendingLinkIds, onPendingLinkIdsChange]);

  // For the banner copy at the top — counts only the asset's open
  // backlog, which is what the dispatcher cares about when deciding
  // whether to engage with the section.
  const openCount = available.length + linked.length + pendingLinkIds.filter(id =>
    available.some(w => w.id === id) || linked.some(w => w.id === id)
  ).length;

  const headerBgTint = openCount > 0 ? '#f5f3ff' : 'var(--gc-bg)';
  const headerBorder = openCount > 0 ? '#e9d5ff' : 'var(--gc-border-light)';

  return (
    <div
      className="rounded-xl"
      style={{ background: headerBgTint, border: `1px solid ${headerBorder}` }}>
      <div className="flex items-center gap-2 px-4 py-2.5">
        <Wrench size={14} style={{ color: '#7c3aed' }} />
        <div className="text-[11px] font-bold uppercase tracking-wider flex-1" style={{ color: '#6b21a8' }}>
          Linked work orders
        </div>
        {linked.length > 0 && (
          <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: '#7c3aed', color: '#fff' }}>
            {linked.length} linked
          </span>
        )}
        {loading && <Loader2 size={12} className="animate-spin" style={{ color: '#7c3aed' }} />}
      </div>

      {!assetId ? (
        <div className="px-4 pb-3 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
          Pick a truck below to see open work orders for it.
        </div>
      ) : (
        <div className="px-3 pb-3 space-y-1">
          {/* Linked rows — edit mode only (create mode has nothing
              "linked" yet, those entries live in the available list
              flagged via pendingLinkIds). */}
          {linked.map(wo => (
            <WorkOrderRow
              key={wo.id}
              wo={wo}
              checked
              saving={savingId === wo.id}
              onToggle={() => unlinkNow(wo.id)}
            />
          ))}

          {/* Available rows */}
          {available.length === 0 && linked.length === 0 ? (
            <div className="px-2 py-3 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
              No open work orders for this truck.{' '}
              <span style={{ opacity: 0.7 }}>(Create one from Equipment → Maintenance.)</span>
            </div>
          ) : (
            available.map(wo => {
              const isPending = isCreateMode && pendingLinkIds.includes(wo.id);
              return (
                <WorkOrderRow
                  key={wo.id}
                  wo={wo}
                  checked={isPending}
                  saving={savingId === wo.id}
                  onToggle={() => isCreateMode ? togglePending(wo.id) : linkNow(wo.id)}
                  showLinkOnHover={!isCreateMode}
                />
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/** One row — checkbox + title + priority chip + scheduled-date hint
 *  + optional out-of-service tag. Kept dumb so the parent can drive
 *  both modes through the same UI. */
function WorkOrderRow({
  wo, checked, saving, onToggle, showLinkOnHover,
}: {
  wo:       MaintenanceActionItem;
  checked:  boolean;
  saving:   boolean;
  onToggle: () => void;
  /** Edit-mode only: show a faint "Link" affordance on hover so it's
   *  obvious the row is interactive. Unchecked create-mode rows already
   *  read as "select me" via the empty checkbox. */
  showLinkOnHover?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={saving}
      className="group w-full flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors disabled:opacity-60 text-left"
      style={{ background: checked ? 'rgba(124,58,237,0.10)' : 'transparent' }}
      onMouseEnter={e => { if (!checked) e.currentTarget.style.background = 'var(--gc-hover)'; }}
      onMouseLeave={e => { if (!checked) e.currentTarget.style.background = 'transparent'; }}>
      {/* Checkbox visual. We use a custom box so its checked state can
          stay in sync with both edit-mode (server) and create-mode
          (parent state) without juggling controlled-input
          semantics. */}
      <div
        className="flex items-center justify-center rounded shrink-0"
        style={{
          width: 16, height: 16,
          background: checked ? '#7c3aed' : 'transparent',
          border: checked ? '1px solid #7c3aed' : '1px solid var(--gc-border)',
        }}>
        {saving
          ? <Loader2 size={10} color="#fff" className="animate-spin" />
          : checked
            ? <Check size={11} color="#fff" strokeWidth={3} />
            : null}
      </div>
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
          {wo.title}
        </span>
        {priorityChip(wo.priority)}
        {wo.outOfService && (
          <span
            title="Out of service — truck cannot run loads"
            className="inline-flex items-center gap-0.5 text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
            style={{ background: '#fce8e6', color: '#b91c1c' }}>
            <AlertTriangle size={9} /> OOS
          </span>
        )}
        {wo.scheduledDate && (
          <span className="text-[11px] tabular-nums shrink-0" style={{ color: 'var(--gc-text-3)' }}>
            {new Date(wo.scheduledDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>
        )}
      </div>
      {showLinkOnHover && !checked && (
        <span className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-[11px] font-semibold shrink-0" style={{ color: '#7c3aed' }}>
          <Plus size={11} /> Link
        </span>
      )}
      {checked && !saving && (
        <Link2 size={11} className="shrink-0" style={{ color: '#7c3aed' }} />
      )}
    </button>
  );
}
