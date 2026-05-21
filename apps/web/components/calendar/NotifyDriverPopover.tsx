'use client';

/**
 * NotifyDriverPopover — single button under the Driver picker that
 * opens a popover with the five dispatcher nudge actions, the recent
 * history of pushes sent for this event, and inline soft-confirm for
 * repeat sends within a short window.
 *
 * Acks are server-driven. When the driver does the thing the nudge
 * asked for (confirm/check-in/POD/trailer/etc), the API stamps
 * acknowledged_at on matching pending rows — this UI just reflects
 * what comes back from listEventNotifications.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell, BellRing, CheckCircle2, ChevronDown, FileSignature,
  Loader2, MapPin, PackageCheck, Truck, X,
} from 'lucide-react';
import type { CalendarEvent, LoadNotification, LoadNotificationKind } from '@/lib/types';
import { railway } from '@/lib/railway';

interface Props {
  eventId:        string;
  event:          CalendarEvent | undefined;
  driverId:       number;
  currentUserName: string;
  /** Whether the load already meets each kind's ack criterion. Used to
   *  grey out the corresponding button (no point pushing a POD nudge
   *  on a load that already has POD uploaded). */
  ackState: Record<LoadNotificationKind, boolean>;
}

// Repeat-suppression window: if dispatcher tries to fire the same kind
// for the same event within this window, surface a soft confirm dialog
// instead of silently double-sending.
const REPEAT_WARN_WINDOW_MS = 10 * 60 * 1000;

interface ActionDef {
  kind:        LoadNotificationKind;
  label:       string;
  description: string;
  icon:        React.ComponentType<{ size?: number }>;
  /** Title + body of the push that goes out for this kind. */
  push: (load: CalendarEvent | undefined) => { title: string; body: string };
}

/** `[route]` per the notification copy spec — the event title field,
 *  formatted "broker: pickup–delivery" upstream. Single source of
 *  truth: don't synthesize a separate route string. */
function routeLabel(load: CalendarEvent | undefined): string {
  return load?.title?.trim() || 'your load';
}

/** `[time]` per the notification copy spec — "ddd M/D h:mm A"
 *  (e.g. "Wed 5/21 8:00 AM"). One format used across every push so
 *  the lock-screen experience is consistent. Input is the event's
 *  naive ISO start ("YYYY-MM-DDTHH:mm"). */
function fmtPushTime(naive: string | undefined): string {
  if (!naive) return '';
  const m = naive.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return naive;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  let hour = Number(m[4]);
  const minute = Number(m[5]);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  if (hour === 0) hour = 12;
  else if (hour > 12) hour -= 12;
  const wd = new Date(year, month - 1, day).toLocaleDateString('en-US', { weekday: 'short' });
  return `${wd} ${month}/${day} ${hour}:${String(minute).padStart(2, '0')} ${ampm}`;
}

const ACTIONS: ActionDef[] = [
  {
    kind: 'confirm', label: 'Confirm load',
    description: 'Ask driver to confirm they\'ve got the load.',
    icon: CheckCircle2,
    push: (load) => ({
      title: 'Confirm On Time Pickup',
      body:  `${routeLabel(load)} — confirm you've got it. Pickup ${fmtPushTime(load?.start)}.`,
    }),
  },
  {
    kind: 'mark_pickup', label: 'Mark picked up',
    description: 'Prompt driver to check in at pickup stops.',
    icon: PackageCheck,
    push: (load) => ({
      title: 'Check In At Pickup',
      body:  `${routeLabel(load)} — Check in once you're on site.`,
    }),
  },
  {
    kind: 'mark_delivery', label: 'Mark delivered',
    description: 'Prompt driver to check in at delivery + upload POD.',
    icon: MapPin,
    push: (load) => ({
      title: 'Check In At Delivery',
      body:  `${routeLabel(load)} — Check in once you're on site.`,
    }),
  },
  {
    kind: 'upload_pod', label: 'Upload POD',
    description: 'Prompt driver to upload the proof-of-delivery doc.',
    icon: FileSignature,
    push: (load) => ({
      title: 'Upload Paperwork',
      body:  `${routeLabel(load)} — Upload POD for each stop.`,
    }),
  },
  {
    kind: 'report_trailer', label: 'Report trailer',
    description: 'Prompt driver to set the trailer they\'re pulling.',
    icon: Truck,
    push: (load) => ({
      title: 'Which trailer?',
      body:  `${routeLabel(load)} — Tell us which trailer you\'re pulling.`,
    }),
  },
];

// ── Time helpers ──────────────────────────────────────────────────────

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000)        return 'just now';
  if (ms < 3_600_000)     return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000)    return `${Math.round(ms / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Component ─────────────────────────────────────────────────────────

export default function NotifyDriverPopover({
  eventId, event, driverId, currentUserName, ackState,
}: Props) {
  const [open,          setOpen]          = useState(false);
  const [notifs,        setNotifs]        = useState<LoadNotification[] | null>(null);
  const [loading,       setLoading]       = useState(false);
  const [sendingKind,   setSendingKind]   = useState<LoadNotificationKind | null>(null);
  const [repeatConfirm, setRepeatConfirm] = useState<LoadNotificationKind | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popRef    = useRef<HTMLDivElement>(null);

  // Pending count for the bell badge — pulled from notif list.
  const pendingCount = useMemo(
    () => (notifs ?? []).filter(n => !n.acknowledgedAt).length,
    [notifs],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { notifications } = await railway.listEventNotifications(eventId);
      setNotifs(notifications);
    } catch (err) {
      console.error('listEventNotifications:', err);
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  // Lazy-load on first open; refresh every time it opens after that.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const send = useCallback(async (kind: LoadNotificationKind, opts?: { skipRepeatCheck?: boolean }) => {
    if (!opts?.skipRepeatCheck) {
      const recent = (notifs ?? []).find(
        n => n.kind === kind && Date.now() - new Date(n.sentAt).getTime() < REPEAT_WARN_WINDOW_MS,
      );
      if (recent) {
        setRepeatConfirm(kind);
        return;
      }
    }
    setRepeatConfirm(null);
    setSendingKind(kind);
    try {
      const action = ACTIONS.find(a => a.kind === kind)!;
      const { title, body } = action.push(event);
      // 1) Record the row server-side (creates the timeline entry).
      await railway.sendEventNotification(eventId, { kind, sentByName: currentUserName });
      // 2) Fan the push out via the existing /api/driver-push surface.
      //    Best-effort — if this fails we still have the row recorded
      //    so dispatch can see they tried (and retry).
      void fetch('/api/driver-push', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          driverId,
          title,
          body,
          data: { type: kind, eventId, url: `/load/${eventId}` },
        }),
      }).catch(err => console.error('driver-push fan-out:', err));
      // 3) Refresh so the new row shows + pending count updates.
      await refresh();
    } catch (err) {
      console.error('sendEventNotification:', err);
    } finally {
      setSendingKind(null);
    }
  }, [eventId, event, currentUserName, driverId, notifs, refresh]);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        className="text-xs flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors"
        style={{
          color: open ? 'var(--gc-blue)' : 'var(--gc-text-3)',
          background: open ? 'var(--gc-blue-light)' : 'transparent',
          border: 'none', cursor: 'pointer', position: 'relative',
        }}
        onMouseEnter={e => { if (!open) e.currentTarget.style.background = 'var(--gc-hover)'; }}
        onMouseLeave={e => (e.currentTarget.style.background = open ? 'var(--gc-blue-light)' : 'transparent')}
        title="Send the driver a nudge"
      >
        {pendingCount > 0 ? <BellRing size={11} /> : <Bell size={11} />}
        <span>Notify driver</span>
        {pendingCount > 0 && (
          <span style={{
            background: '#d93025', color: 'white', fontSize: 9, fontWeight: 800,
            padding: '0 4px', borderRadius: 999, minWidth: 14, textAlign: 'center', lineHeight: 1.5,
          }}>
            {pendingCount}
          </span>
        )}
        <ChevronDown size={10} style={{ opacity: 0.6 }} />
      </button>

      {open && (
        <div
          ref={popRef}
          className="absolute mt-1 rounded-xl"
          style={{
            zIndex: 220,
            width: 340,
            background: 'var(--gc-surface)',
            border: '1px solid var(--gc-border)',
            boxShadow: '0 16px 40px rgba(0,0,0,0.18)',
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2"
            style={{ borderBottom: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
            <div className="text-[12px] font-extrabold" style={{ color: 'var(--gc-text-1)' }}>
              Notify driver
            </div>
            <button type="button" onClick={() => setOpen(false)}
              className="p-1 rounded transition-colors"
              style={{ color: 'var(--gc-text-3)', background: 'transparent', border: 'none', cursor: 'pointer' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <X size={13} />
            </button>
          </div>

          {/* Action grid */}
          <div className="flex flex-col py-1.5">
            {ACTIONS.map(action => {
              const ack = ackState[action.kind];
              const sending = sendingKind === action.kind;
              const isPending = (notifs ?? []).some(n => n.kind === action.kind && !n.acknowledgedAt);
              const Icon = action.icon;
              return (
                <button key={action.kind} type="button"
                  disabled={ack || sending}
                  onClick={() => void send(action.kind)}
                  className="flex items-start gap-3 text-left px-3 py-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ background: 'transparent', border: 'none', cursor: ack ? 'not-allowed' : 'pointer' }}
                  onMouseEnter={e => { if (!ack && !sending) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <div className="flex items-center justify-center rounded-lg shrink-0 mt-0.5"
                    style={{
                      width: 28, height: 28,
                      background: ack ? 'var(--gc-border-light)' : 'var(--gc-blue-light)',
                      color: ack ? 'var(--gc-text-3)' : 'var(--gc-blue)',
                    }}>
                    {sending ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[13px] font-extrabold" style={{ color: 'var(--gc-text-1)' }}>
                        {action.label}
                      </span>
                      {ack && (
                        <span className="text-[10px] font-extrabold" style={{ color: '#15803d' }}>
                          · done
                        </span>
                      )}
                      {!ack && isPending && (
                        <span className="text-[10px] font-extrabold" style={{ color: '#92400e' }}>
                          · pending
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] leading-tight mt-0.5" style={{ color: 'var(--gc-text-1)' }}>
                      {action.description}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Repeat-confirm strip */}
          {repeatConfirm && (
            <div className="px-3 py-2.5 flex items-center justify-between gap-2"
              style={{ background: '#fef3c7', borderTop: '1px solid #fde68a' }}>
              <div className="text-[11px] font-medium" style={{ color: '#92400e' }}>
                Same nudge sent in last 10 min. Send again?
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button type="button" onClick={() => setRepeatConfirm(null)}
                  className="text-[11px] font-bold px-2 py-1 rounded transition-colors"
                  style={{ color: '#92400e', background: 'transparent', border: '1px solid #fde68a', cursor: 'pointer' }}>
                  Cancel
                </button>
                <button type="button" onClick={() => void send(repeatConfirm, { skipRepeatCheck: true })}
                  className="text-[11px] font-bold px-2 py-1 rounded transition-colors text-white"
                  style={{ background: '#92400e', border: '1px solid #92400e', cursor: 'pointer' }}>
                  Send again
                </button>
              </div>
            </div>
          )}

          {/* History */}
          <div style={{ borderTop: '1px solid var(--gc-border-light)' }}>
            <div className="px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-wider"
              style={{ color: 'var(--gc-text-1)' }}>
              Recent nudges
            </div>
            {/* Sticky "driver confirmed at" line at the top of the
                history. Always visible when confirmedAt is set,
                independent of whether any notification was sent. */}
            {event?.confirmedAt && (
              <div className="flex items-center gap-2 px-3 py-1.5 mx-1 mb-1 rounded"
                style={{ background: '#dcfce7', border: '1px solid #86efac' }}>
                <CheckCircle2 size={12} style={{ color: '#15803d' }} />
                <span className="text-[11px]" style={{ color: '#15803d', fontWeight: 800 }}>
                  Driver confirmed at {new Date(event.confirmedAt).toLocaleString('en-US', {
                    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                  })}
                </span>
              </div>
            )}
            <div className="max-h-48 overflow-auto px-1 pb-2">
              {loading && !notifs ? (
                <div className="flex items-center justify-center py-3">
                  <Loader2 size={14} className="animate-spin" style={{ color: 'var(--gc-text-1)' }} />
                </div>
              ) : (notifs ?? []).length === 0 ? (
                <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--gc-text-1)' }}>
                  None sent yet.
                </div>
              ) : (
                (notifs ?? []).map(n => {
                  const action = ACTIONS.find(a => a.kind === n.kind);
                  const Icon = action?.icon ?? Bell;
                  return (
                    <div key={n.id} className="flex items-start gap-2 px-2 py-1.5 rounded"
                      style={{ fontSize: 11 }}>
                      <Icon size={12} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span style={{ fontWeight: 800, color: 'var(--gc-text-1)' }}>
                            {action?.label ?? n.kind}
                          </span>
                          {n.acknowledgedAt ? (
                            <span style={{ color: '#15803d', fontWeight: 800 }}>· acknowledged</span>
                          ) : (
                            <span style={{ color: '#92400e', fontWeight: 800 }}>· pending</span>
                          )}
                        </div>
                        <div style={{ color: 'var(--gc-text-1)' }}>
                          {relTime(n.sentAt)} · {n.sentByName}
                          {n.acknowledgedAt ? ` · acked ${relTime(n.acknowledgedAt)}` : ''}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
