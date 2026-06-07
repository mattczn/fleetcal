'use client';

/**
 * RecentlyDeletedDetailModal — read-only viewer for a deleted load.
 *
 * Why a dedicated component (vs reusing EventModal): EventModal's
 * mount path runs a dozen useEffects that fetch documents, rate-cons,
 * audit logs, etc. and assume an active load row. Pointing it at a
 * deleted event triggered crashes deep in those effects. This panel
 * skips all of that — it just reads the fields already on the
 * DeletedEvent in the store and shows them. One button: Reinstate.
 * Close = leaves the load in Recently Deleted.
 */

import { X, RefreshCw, Trash2, AlertTriangle } from 'lucide-react';
import type { CalendarEvent } from '@/lib/types';
import { useCalendarStore } from '@/store/useCalendarStore';

interface Props {
  event: CalendarEvent;
  onClose: () => void;
}

/** "2026-06-04T08:00" → "Jun 4, 2026 · 8:00 AM" */
function fmtDateTime(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

export default function RecentlyDeletedDetailModal({ event, onClose }: Props) {
  const restoreEvent = useCalendarStore((s) => s.restoreEvent);
  const openEditModal = useCalendarStore((s) => s.openEditModal);
  const assets = useCalendarStore((s) => s.assets);
  const drivers = useCalendarStore((s) => s.drivers);
  const asset = assets.find((a) => a.id === event.assetId);
  const driver = event.driverName ?? drivers.find((d) => d.id === event.driverId)?.name ?? null;

  const handleReinstate = () => {
    restoreEvent(event.id, {
      changedAt: new Date().toISOString(),
      changedByName: 'Dispatcher',
      loadRestored: true,
    });
    // Close this read-only viewer, then open the regular load modal for the
    // just-restored event. restoreEvent moves the row into state.events
    // synchronously, so by the time openEditModal runs EventModal can find it.
    onClose();
    openEditModal(event.id);
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center px-4"
      style={{ background: 'rgba(0,0,0,0.5)', zIndex: 200 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rounded-2xl flex flex-col w-full"
        style={{
          maxWidth: 520,
          background: 'var(--gc-surface)',
          boxShadow: '0 16px 48px rgba(0,0,0,0.25)',
          border: '1px solid var(--gc-border)',
          overflow: 'hidden',
        }}>
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center justify-center flex-shrink-0 rounded-full"
              style={{ width: 36, height: 36, background: '#fce8e6', color: '#d93025' }}>
              <AlertTriangle size={18} />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] font-bold uppercase tracking-wider"
                style={{ color: '#d93025' }}>
                Recently Deleted
              </div>
              <div className="text-[16px] font-extrabold truncate"
                style={{ color: 'var(--gc-text-1)' }}
                title={event.title}>
                {event.title}
              </div>
            </div>
          </div>
          <button onClick={onClose}
            className="p-1.5 rounded-full transition-colors flex-shrink-0"
            title="Close"
            style={{ color: 'var(--gc-text-3)' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
            <X size={18} />
          </button>
        </div>

        {/* Body — key facts, read-only */}
        <div className="px-5 pb-4 space-y-3 text-[13px]" style={{ color: 'var(--gc-text-2)' }}>
          {event.loadNum && (
            <Row label="Load #" value={`#${event.loadNum}`} />
          )}
          {event.broker && (
            <Row label="Customer" value={event.broker} />
          )}
          {event.loadPrice != null && (
            <Row label="Rate" value={`$${event.loadPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}`} />
          )}
          <Row label="Pickup"   value={fmtDateTime(event.start)} />
          <Row label="Delivery" value={fmtDateTime(event.end)} />
          {asset && (
            <Row label="Truck" value={`${asset.name}${asset.unit ? ` · #${asset.unit}` : ''}`} />
          )}
          {driver && (
            <Row label="Driver" value={driver} />
          )}
          {(event as { deletedAt?: string }).deletedAt && (
            <Row label="Deleted" value={fmtDateTime((event as { deletedAt?: string }).deletedAt)} />
          )}
        </div>

        {/* Footer — Reinstate (primary) / Close */}
        <div className="flex items-center justify-end gap-2 px-5 py-4"
          style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
          <button type="button" onClick={onClose}
            className="text-[13px] font-bold px-4 py-2 rounded-lg transition-colors"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--gc-surface)')}>
            <Trash2 size={13} style={{ display: 'inline', marginRight: 4, color: 'var(--gc-text-3)' }} />
            Keep in Trash
          </button>
          <button type="button" onClick={handleReinstate}
            className="flex items-center gap-1.5 text-[13px] font-extrabold px-4 py-2 rounded-lg transition-colors text-white"
            style={{ background: 'var(--gc-blue)' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--gc-blue-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--gc-blue)')}>
            <RefreshCw size={13} />
            Reinstate
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11px] font-bold uppercase tracking-wider"
        style={{ color: 'var(--gc-text-3)' }}>
        {label}
      </span>
      <span className="font-semibold text-right truncate"
        style={{ color: 'var(--gc-text-1)' }}
        title={value}>
        {value}
      </span>
    </div>
  );
}
