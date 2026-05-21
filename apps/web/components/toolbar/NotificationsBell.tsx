'use client';

/**
 * Dispatcher notifications bell + dropdown.
 *
 * Sits in the calendar toolbar (top-right). Click the bell to open a
 * panel showing every load_notifications row from the last 48 hours
 * as a card with kind label, description, who/what sent it, and
 * relative time. Unacknowledged rows render slightly more prominent.
 *
 * Two purposes per the user spec:
 *   1. See what's pending — driver hasn't acted on a nudge yet.
 *   2. Verify scheduled pushes are firing — the log doubles as an
 *      audit trail when debugging "did the evening sweep run last
 *      night?" without diving into individual load detail screens.
 *
 * Polls every 30s while mounted. Closes on outside click + Escape.
 */
import { useEffect, useRef, useState } from 'react';
import { Bell, BellOff, Check } from 'lucide-react';
import { railway } from '@/lib/railway';
import type { LoadNotification, LoadNotificationKind } from '@fleetcal/types';
import { useCalendarStore } from '@/store/useCalendarStore';

const KIND_LABEL: Record<LoadNotificationKind, string> = {
  confirm:          'Confirm load',
  mark_pickup:      'Mark picked up',
  mark_delivery:    'Mark delivered',
  upload_pod:       'Upload POD',
  report_trailer:   'Report trailer',
  assigned:         'Load assigned',
  reassigned_away:  'Load reassigned',
  load_cancelled:   'Load cancelled',
};

const KIND_TINT: Record<LoadNotificationKind, { bg: string; fg: string }> = {
  confirm:          { bg: '#dbeafe', fg: '#1e3a8a' },
  mark_pickup:      { bg: '#fef3c7', fg: '#92400e' },
  mark_delivery:    { bg: '#dcfce7', fg: '#166534' },
  upload_pod:       { bg: '#ede9fe', fg: '#5b21b6' },
  report_trailer:   { bg: '#fee2e2', fg: '#991b1b' },
  assigned:         { bg: '#e0f2fe', fg: '#075985' },
  reassigned_away:  { bg: '#fef3c7', fg: '#92400e' },
  load_cancelled:   { bg: '#f3f4f6', fg: '#374151' },
};

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 30_000)      return 'just now';
  if (diff < 60_000)      return `${Math.round(diff / 1_000)}s ago`;
  if (diff < 3_600_000)   return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000)  return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<LoadNotification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const openEditModal = useCalendarStore((s) => s.openEditModal);
  const events = useCalendarStore((s) => s.events);

  // Fetch on mount + every 30s. Background polling keeps the badge
  // accurate without forcing the user to reopen the panel; the
  // re-fetch is cheap (server caps at 50 rows over 48h).
  useEffect(() => {
    let cancelled = false;
    const fetchOnce = () => {
      railway.listOrgNotifications()
        .then(({ notifications: rows }) => {
          if (cancelled) return;
          setNotifications(rows);
          setError(null);
        })
        .catch(err => {
          if (cancelled) return;
          console.warn('[NotificationsBell] fetch failed:', err);
          setError(err instanceof Error ? err.message : 'fetch failed');
        });
    };
    fetchOnce();
    const t = setInterval(fetchOnce, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!panelRef.current || !btnRef.current) return;
      const t = e.target as Node;
      if (panelRef.current.contains(t) || btnRef.current.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pendingCount = (notifications ?? []).filter(n => !n.acknowledgedAt).length;
  const recent = notifications ?? [];

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label="Notifications"
        title={`${pendingCount} pending notification${pendingCount === 1 ? '' : 's'}`}
        style={{
          position: 'relative',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 30, height: 30, borderRadius: 8,
          background: open ? 'var(--gc-hover)' : 'transparent',
          border: 'none', cursor: 'pointer',
          color: pendingCount > 0 ? 'var(--gc-text-1)' : 'var(--gc-text-3)',
        }}
        onMouseEnter={e => { if (!open) e.currentTarget.style.background = 'var(--gc-hover)'; }}
        onMouseLeave={e => { if (!open) e.currentTarget.style.background = 'transparent'; }}
      >
        <Bell size={16} />
        {pendingCount > 0 && (
          <span style={{
            position: 'absolute',
            top: 2, right: 2,
            minWidth: 14, height: 14, paddingInline: 3,
            borderRadius: 7,
            background: '#dc2626', color: '#fff',
            fontSize: 9, fontWeight: 800,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '1.5px solid var(--gc-surface)',
            fontVariantNumeric: 'tabular-nums',
          }}>
            {pendingCount > 99 ? '99+' : pendingCount}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 100,
            width: 380,
            maxHeight: 520,
            display: 'flex', flexDirection: 'column',
            background: 'var(--gc-surface)',
            border: '1px solid var(--gc-border)',
            borderRadius: 12,
            boxShadow: '0 16px 40px rgba(0,0,0,0.12)',
            overflow: 'hidden',
          }}
        >
          <div style={{
            padding: '12px 14px',
            borderBottom: '1px solid var(--gc-border-light)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--gc-text-1)' }}>Notifications</div>
              <div style={{ fontSize: 11, color: 'var(--gc-text-3)', marginTop: 1 }}>
                Last 48 hours
                {pendingCount > 0 && <> · <span style={{ color: '#dc2626', fontWeight: 600 }}>{pendingCount} pending</span></>}
              </div>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {notifications === null ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--gc-text-3)', fontSize: 12 }}>
                Loading…
              </div>
            ) : error ? (
              <div style={{ padding: 24, textAlign: 'center', color: '#b45309', fontSize: 12 }}>
                Couldn't load notifications. {error}
              </div>
            ) : recent.length === 0 ? (
              <div style={{ padding: '36px 16px', textAlign: 'center', color: 'var(--gc-text-3)' }}>
                <BellOff size={24} style={{ margin: '0 auto 8px', opacity: 0.5 }} />
                <div style={{ fontSize: 13, fontWeight: 600 }}>No notifications in the last 48 hours</div>
                <div style={{ fontSize: 11, marginTop: 2 }}>Driver nudges + scheduled pushes will appear here.</div>
              </div>
            ) : (
              recent.map(n => {
                const tint = KIND_TINT[n.kind] ?? { bg: '#f1f3f4', fg: '#3c4043' };
                const label = KIND_LABEL[n.kind] ?? n.kind;
                const acked = !!n.acknowledgedAt;
                // Match to a cached event so clicking the card can jump
                // to the load — eventId comes back from the API but the
                // store's events array is what the modal works with.
                const matchingEvent = events.find(e => e.id === n.eventId);
                const loadNum = matchingEvent?.loadNum ?? null;
                const title  = matchingEvent?.title ?? null;
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => {
                      if (matchingEvent) {
                        openEditModal(n.eventId);
                        setOpen(false);
                      }
                    }}
                    disabled={!matchingEvent}
                    style={{
                      width: '100%',
                      display: 'flex', flexDirection: 'column', gap: 4,
                      padding: '12px 14px',
                      borderBottom: '1px solid var(--gc-border-light)',
                      background: acked ? 'var(--gc-surface)' : 'var(--gc-bg)',
                      border: 'none', borderLeft: acked ? '3px solid transparent' : '3px solid #dc2626',
                      textAlign: 'left',
                      cursor: matchingEvent ? 'pointer' : 'default',
                      transition: 'background 100ms',
                    }}
                    onMouseEnter={e => { if (matchingEvent) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = acked ? 'var(--gc-surface)' : 'var(--gc-bg)'; }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{
                        fontSize: 10, fontWeight: 800, letterSpacing: '0.04em',
                        background: tint.bg, color: tint.fg,
                        padding: '2px 7px', borderRadius: 999,
                        textTransform: 'uppercase',
                      }}>
                        {label}
                      </span>
                      {acked && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, color: '#16a34a', fontWeight: 600 }}>
                          <Check size={10} /> Acknowledged
                        </span>
                      )}
                      <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--gc-text-3)', whiteSpace: 'nowrap' }}>
                        {relativeTime(n.sentAt)}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gc-text-1)' }}>
                      {loadNum ? `#${loadNum}` : ''}{loadNum && title ? ' · ' : ''}{title ?? (loadNum ? '' : 'Load')}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>
                      Sent by {n.sentByName || 'system'}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
