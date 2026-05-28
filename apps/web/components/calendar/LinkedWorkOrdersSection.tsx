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
 * filter = 'open' OR 'in_progress' (multi-link only makes sense while
 * the WO is still active — done items don't get attached to new
 * blocks).
 *
 * Multi-link: a single open/in-progress work order can be linked to
 * multiple events ("scheduled into Tuesday's shop day, deferred,
 * finally finished Friday" → both Tuesday and Friday blocks carry the
 * link). The available list shows ALL active WOs on the asset; the
 * linked list shows those already attached to THIS event. Link/unlink
 * actions edit just this event's slice of the WO's eventIds set so
 * other events' links survive.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Wrench, AlertTriangle, Link2, Loader2, Plus, Check, ExternalLink } from 'lucide-react';
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
    // Pull BOTH open and in-progress — multi-link is useful for
    // anything still being worked. Done is excluded (settled).
    const availOpenQ = railway.listMaintenanceActionItems({ assetId, status: 'open', limit: 100 })
      .then(r => r.actionItems)
      .catch(() => []);
    const availActiveQ = railway.listMaintenanceActionItems({ assetId, status: 'in_progress', limit: 100 })
      .then(r => r.actionItems)
      .catch(() => []);
    Promise.all([linkedQ, availOpenQ, availActiveQ]).then(([linkedRows, allOpen, allActive]) => {
      if (cancelled) return;
      // "Available" = every active WO on this asset that ISN'T already
      // linked to THIS specific event. Under multi-link, we no longer
      // hide WOs attached to other events — the dispatcher can attach
      // them here too, and the other event's link survives independently.
      const linkedIds = new Set(linkedRows.map(r => r.id));
      const merged = [...allOpen, ...allActive];
      const dedup  = Array.from(new Map(merged.map(w => [w.id, w])).values());
      const avail  = dedup.filter(wo => !linkedIds.has(wo.id));
      setLinked(linkedRows);
      setAvailable(avail);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [assetId, eventId, reloadKey]);

  // EDIT MODE: persist a link/unlink immediately. Optimistically move
  // the row between the two arrays so the UI feels instant; rollback
  // on error.
  //
  // Under multi-link, link/unlink edits ONLY this event's slice of the
  // WO's eventIds set so other events' links survive. We compute the
  // desired set from the WO's current eventIds (or fall back to the
  // legacy single eventId hint when the API hasn't surfaced the array
  // yet — pre-migration).
  const currentEventIdsOf = (wo: MaintenanceActionItem): string[] => {
    if (Array.isArray(wo.eventIds)) return wo.eventIds;
    return wo.eventId ? [wo.eventId] : [];
  };
  const linkNow = useCallback(async (woId: string) => {
    if (!eventId) return;
    setSavingId(woId);
    const target = available.find(w => w.id === woId);
    const desiredIds = target
      ? Array.from(new Set([...currentEventIdsOf(target), eventId]))
      : [eventId];
    if (target) {
      setAvailable(a => a.filter(w => w.id !== woId));
      setLinked(l => [...l, { ...target, eventId, eventIds: desiredIds }]);
    }
    try {
      await railway.updateMaintenanceActionItem(woId, { eventIds: desiredIds });
      // Force a clean re-fetch from the server so the linked/
      // available split reflects the canonical state. Cheap (two
      // small list queries) and removes any chance of optimistic
      // drift if the server's link write reshaped things (e.g.
      // dedup, validation tweak).
      setReloadKey(k => k + 1);
    } catch (err) {
      console.error('[LinkedWorkOrders] link failed:', err);
      // Same re-fetch on error to roll the optimistic toggle back.
      setReloadKey(k => k + 1);
    } finally {
      setSavingId(null);
    }
  }, [eventId, available]);

  const unlinkNow = useCallback(async (woId: string) => {
    if (!eventId) return;
    setSavingId(woId);
    const target = linked.find(w => w.id === woId);
    const desiredIds = target
      ? currentEventIdsOf(target).filter(id => id !== eventId)
      : [];
    if (target) {
      setLinked(l => l.filter(w => w.id !== woId));
      setAvailable(a => [...a, { ...target, eventId: undefined, eventIds: desiredIds }]);
    }
    try {
      await railway.updateMaintenanceActionItem(woId, { eventIds: desiredIds });
      setReloadKey(k => k + 1);
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
              showView
            />
          ))}

          {/* Available rows */}
          {available.length === 0 && linked.length === 0 ? (
            <div className="px-2 py-3 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
              No open work orders for this truck.{' '}
              <a
                href="/equipment?tab=maintenance"
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold underline underline-offset-2"
                style={{ color: '#7c3aed' }}>
                Create one
              </a>{' '}
              <span style={{ opacity: 0.7 }}>(opens Equipment → Maintenance in a new tab).</span>
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
 *  + optional out-of-service tag + optional "View" jump on linked
 *  rows. Kept dumb so the parent can drive both modes through the
 *  same UI. */
function WorkOrderRow({
  wo, checked, saving, onToggle, showLinkOnHover, showView,
}: {
  wo:       MaintenanceActionItem;
  checked:  boolean;
  saving:   boolean;
  onToggle: () => void;
  /** Edit-mode only: show a faint "Link" affordance on hover so it's
   *  obvious the row is interactive. Unchecked create-mode rows already
   *  read as "select me" via the empty checkbox. */
  showLinkOnHover?: boolean;
  /** When true, render a "View" button that opens the work-order
   *  modal in a new tab (Equipment → Maintenance, with this work
   *  order's id in the URL — the equipment page picks it up and
   *  opens the WorkOrderModal in edit mode). Only useful for
   *  already-linked rows, where the work order is a settled record
   *  the dispatcher might want to inspect. */
  showView?: boolean;
}) {
  return (
    <div
      className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors"
      style={{ background: checked ? 'rgba(124,58,237,0.10)' : 'transparent' }}
      onMouseEnter={e => { if (!checked) e.currentTarget.style.background = 'var(--gc-hover)'; }}
      onMouseLeave={e => { if (!checked) e.currentTarget.style.background = 'transparent'; }}>
      {/* The checkbox + label sit inside an inner button so the
          OUTER row (which also contains the View link) can still
          show hover affordances + handle layout without making the
          whole thing a single clickable area — clicking View
          shouldn't toggle the link. */}
      <button
        type="button"
        onClick={onToggle}
        disabled={saving}
        className="flex items-center gap-2.5 flex-1 min-w-0 text-left disabled:opacity-60">
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
      </button>
      {showLinkOnHover && !checked && !showView && (
        <span className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-[11px] font-semibold shrink-0" style={{ color: '#7c3aed' }}>
          <Plus size={11} /> Link
        </span>
      )}
      {showView && (
        <a
          href={`/equipment?tab=maintenance&workOrder=${encodeURIComponent(wo.id)}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded shrink-0"
          style={{ color: '#7c3aed', background: 'rgba(124,58,237,0.08)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(124,58,237,0.18)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'rgba(124,58,237,0.08)')}
          title="Open work order in a new tab">
          <ExternalLink size={11} /> View
        </a>
      )}
      {checked && !saving && !showView && (
        <Link2 size={11} className="shrink-0" style={{ color: '#7c3aed' }} />
      )}
    </div>
  );
}
