'use client';

/**
 * SafetyEventsBell — top-right bell in AppTopBar showing new Motive
 * driver-performance events (hard accel / brake / cornering + v2
 * dashcam events).
 *
 * States:
 *   • polled every 60s while the tab is visible
 *   • badge = count of dispatch_status='new' events
 *   • click → popover list of the newest 20 events
 *   • click a row → drawer with detail, suggested driver, notify + dismiss
 *
 * Gating:
 *   • usePermissions().can('safety.access')
 *   • useModules().enabled('motive_integration')
 * If either is false the bell doesn't render. The server enforces the
 * same gates independently — this is UX so a non-Motive org doesn't
 * see a bell that would 404 on click.
 *
 * We deliberately DON'T do supabase realtime yet — a 60s poll is fine
 * for a 5-min upstream sync and avoids a per-user Supabase channel
 * subscription plus the RLS work that would need to land alongside it.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Bell, X } from 'lucide-react';
import { usePermissions } from '@/lib/usePermissions';
import { useModules } from '@/lib/useModules';
import { railway } from '@/lib/railway';
import type { PerformanceEventRow, MotivePerfRaw } from '@fleetcal/types';
import SafetyPanel from './SafetyPanel';
import DashcamVideo from './SafetyDashcamVideo';

const POLL_MS = 60_000;

interface Driver { id: number; name: string }

export default function SafetyEventsBell() {
  const { can } = usePermissions();
  const { enabled } = useModules();

  const gated = !can('safety.access') || !enabled('motive_integration');

  const [newCount, setNewCount] = useState(0);
  const [events,   setEvents]   = useState<PerformanceEventRow[]>([]);
  const [open,     setOpen]     = useState(false);
  const [openId,   setOpenId]   = useState<number | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  const load = useMemo(() => async () => {
    if (gated) return;
    try {
      const r = await railway.listPerformanceEvents('new', 20);
      setEvents(r.events);
      setNewCount(r.newCount);
    } catch (err) {
      // Non-fatal — the API 404s for orgs without the gate, we've
      // already blocked those via `gated`. Log and move on.
      console.warn('[SafetyEventsBell] load failed:', err);
    }
  }, [gated]);

  useEffect(() => {
    if (gated) return;
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [gated, load]);

  if (gated) return null;

  return (
    <>
      <button
        type="button"
        aria-label={newCount > 0 ? `${newCount} new safety alerts` : 'Safety alerts'}
        onClick={() => setOpen(v => !v)}
        className="relative shrink-0 flex items-center justify-center"
        style={{
          width: 32, height: 32,
          borderRadius: 6,
          border: '1px solid var(--gc-border-light)',
          background: 'var(--gc-surface)',
          color: newCount > 0 ? 'var(--gc-red, #dc2626)' : 'var(--gc-text-2)',
          cursor: 'pointer',
          transition: 'background 120ms, border-color 120ms',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-bg)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'var(--gc-surface)'; }}
      >
        <Bell size={16} />
        {newCount > 0 && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: -4, right: -4,
              minWidth: 16, height: 16,
              padding: '0 4px',
              borderRadius: 999,
              background: '#dc2626',
              color: '#fff',
              fontSize: 10,
              fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 0 0 2px var(--gc-surface)',
            }}
          >
            {newCount > 99 ? '99+' : newCount}
          </span>
        )}
      </button>

      {open && (
        <BellPopover
          events={events}
          onClose={() => setOpen(false)}
          onOpenEvent={(id) => { setOpen(false); setOpenId(id); }}
          onSeeAll={() => { setOpen(false); setPanelOpen(true); }}
          onRefresh={load}
        />
      )}

      {openId != null && (
        <EventDetailDrawer
          eventId={openId}
          onClose={() => { setOpenId(null); void load(); }}
        />
      )}

      {panelOpen && (
        <SafetyPanel onClose={() => { setPanelOpen(false); void load(); }} />
      )}
    </>
  );
}

// ── Popover ────────────────────────────────────────────────────────────

function BellPopover({
  events, onClose, onOpenEvent, onSeeAll, onRefresh,
}: {
  events:      PerformanceEventRow[];
  onClose:     () => void;
  onOpenEvent: (id: number) => void;
  onSeeAll:    () => void;
  onRefresh:   () => Promise<void>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown',   onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown',   onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Safety alerts"
      style={{
        position: 'absolute',
        top: 52, right: 16,
        width: 360,
        maxHeight: 520,
        background: 'var(--gc-surface)',
        border: '1px solid var(--gc-border-light)',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '10px 12px',
          borderBottom: '1px solid var(--gc-border-light)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--gc-text-1)' }}>
          Safety alerts
        </span>
        <button
          type="button"
          onClick={() => void onRefresh()}
          style={{
            fontSize: 11,
            color: 'var(--gc-text-3)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          Refresh
        </button>
      </div>

      <div style={{ overflowY: 'auto', flex: 1 }}>
        {events.length === 0 ? (
          <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--gc-text-3)', fontSize: 12 }}>
            No new safety events.
          </div>
        ) : (
          events.map(e => (
            <button
              key={e.id}
              type="button"
              onClick={() => onOpenEvent(e.id)}
              style={{
                display: 'flex',
                width: '100%',
                gap: 10,
                padding: '10px 12px 10px 9px',
                borderBottom: '1px solid var(--gc-border-light)',
                // Asset color as a 3px left accent bar. Falls back to a
                // neutral gray when the asset was deleted/unlinked so
                // the row layout stays consistent.
                borderLeft: `3px solid ${e.asset_color ?? 'var(--gc-border-light)'}`,
                background: 'transparent',
                textAlign: 'left',
                cursor: 'pointer',
              }}
              onMouseEnter={ev => { ev.currentTarget.style.background = 'var(--gc-bg)'; }}
              onMouseLeave={ev => { ev.currentTarget.style.background = 'transparent'; }}
            >
              <AlertTriangle
                size={16}
                style={{
                  color: severityColor(e.intensity),
                  flexShrink: 0,
                  marginTop: 2,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--gc-text-1)' }}>
                  {eventTypeLabel(e.event_type)}
                  {e.intensity ? ` — ${e.intensity}` : ''}
                </div>
                {/* Primary secondary line: truck (fleetcal name) + calendar-resolved
                    driver. Falls back to Motive's vehicle number only when the
                    truck hasn't been linked in Equipment yet. */}
                <div style={{ fontSize: 11.5, color: 'var(--gc-text-2)', marginTop: 2 }}>
                  {e.asset_name ?? `Truck ${e.vehicle_number ?? e.vehicle_id}`}
                  {e.resolved_driver_name ? ` · ${e.resolved_driver_name}` : ' · unassigned'}
                </div>
                {/* Load + relative time. Load rendered only when the
                    resolver found a covering calendar event. */}
                <div style={{ fontSize: 11, color: 'var(--gc-text-3)', marginTop: 2 }}>
                  {e.resolved_load_num ? `Load ${e.resolved_load_num} · ` : ''}
                  {relTime(e.event_time)}
                </div>
                {e.resolved_load_title && (
                  <div style={{ fontSize: 11, color: 'var(--gc-text-3)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {e.resolved_load_title}
                  </div>
                )}
              </div>
            </button>
          ))
        )}
      </div>

      {/* Footer link → full Safety Panel. Triage-heavy days need a
          bigger surface than a 360×520 popover, so this is the escape
          hatch. */}
      <button
        type="button"
        onClick={onSeeAll}
        style={{
          padding: '10px 12px',
          borderTop: '1px solid var(--gc-border-light)',
          background: 'var(--gc-bg)',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--gc-blue, #1a73e8)',
          border: 'none',
          borderBottomLeftRadius: 8,
          borderBottomRightRadius: 8,
          cursor: 'pointer',
          textAlign: 'center',
        }}
      >
        See all safety alerts (24h) →
      </button>
    </div>
  );
}

// ── Detail drawer ──────────────────────────────────────────────────────

interface SuggestedDriver {
  fleetcalDriverId: number | null;
  displayName:      string | null;
  source:           'calendar_active' | 'calendar_recent' | 'asset_default' | null;
  loadNum:          string | null;
}

function EventDetailDrawer({ eventId, onClose }: { eventId: number; onClose: () => void }) {
  const [event,   setEvent]   = useState<(PerformanceEventRow & { raw?: MotivePerfRaw }) | null>(null);
  const [suggested, setSuggested] = useState<SuggestedDriver | null>(null);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [driverId, setDriverId] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [detail, driverList] = await Promise.all([
          railway.getPerformanceEvent(eventId),
          railway.listDrivers(),
        ]);
        if (cancelled) return;
        setEvent(detail.event);
        setSuggested(detail.suggestedDriver
          ? {
              fleetcalDriverId: detail.suggestedDriver.fleetcalDriverId,
              displayName:      detail.suggestedDriver.displayName,
              source:           detail.suggestedDriver.source,
              loadNum:          detail.suggestedDriver.loadNum,
            }
          : null);
        setDrivers(driverList.drivers.map(d => ({ id: d.id, name: d.name })));
        setDriverId(detail.suggestedDriver?.fleetcalDriverId ?? null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message ?? 'Failed to load event');
      }
    })();
    return () => { cancelled = true; };
  }, [eventId]);

  async function handleNotify() {
    if (!event || !driverId) return;
    setBusy(true); setError(null);
    try {
      await railway.notifyPerformanceEventDriver(event.id, {
        driverId,
        message: message.trim() || undefined,
      });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  async function handleDismiss() {
    if (!event) return;
    setBusy(true); setError(null);
    try {
      await railway.updatePerformanceEvent(event.id, { dispatch_status: 'dismissed' });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-label="Safety event detail"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.35)',
        zIndex: 200,
        display: 'flex',
        justifyContent: 'flex-end',
      }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 420,
          maxWidth: '100%',
          height: '100%',
          background: 'var(--gc-surface)',
          borderLeft: '1px solid var(--gc-border-light)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 16px',
            borderBottom: '1px solid var(--gc-border-light)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--gc-text-1)' }}>Safety alert</div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              width: 28, height: 28,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--gc-text-2)',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {!event ? (
          <div style={{ padding: 20, color: 'var(--gc-text-3)', fontSize: 12 }}>
            {error ?? 'Loading…'}
          </div>
        ) : (
          <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--gc-text-3)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Event</div>
              <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--gc-text-1)', marginTop: 2 }}>
                {eventTypeLabel(event.event_type)}
                {event.intensity ? ` — ${event.intensity}` : ''}
              </div>
              <div style={{ fontSize: 12, color: 'var(--gc-text-2)', marginTop: 4 }}>
                {new Date(event.event_time).toLocaleString()}
                {event.duration ? ` · ${event.duration.toFixed(1)}s` : ''}
              </div>
            </div>

            <div>
              <div style={{ fontSize: 12, color: 'var(--gc-text-3)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Truck</div>
              <div style={{ fontSize: 13, color: 'var(--gc-text-1)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
                {event.asset_color && (
                  <span
                    aria-hidden
                    style={{
                      display: 'inline-block',
                      width: 10,
                      height: 10,
                      borderRadius: 2,
                      background: event.asset_color,
                      flexShrink: 0,
                    }}
                  />
                )}
                {event.asset_name ?? event.vehicle_number ?? `Vehicle ${event.vehicle_id}`}
                {event.asset_unit && (
                  <span style={{ fontSize: 11.5, color: 'var(--gc-text-3)' }}>#{event.asset_unit}</span>
                )}
                {event.resolved_load_num && (
                  <span style={{ fontSize: 12, color: 'var(--gc-text-2)' }}>· Load {event.resolved_load_num}</span>
                )}
                {event.resolved_load_title && (
                  <span style={{ fontSize: 12, color: 'var(--gc-text-3)' }}>· {event.resolved_load_title}</span>
                )}
              </div>
              {event.location_label && (
                <div style={{ fontSize: 12, color: 'var(--gc-text-2)', marginTop: 2 }}>{event.location_label}</div>
              )}
              {event.lat != null && event.lon != null && (
                <a
                  href={`https://www.google.com/maps?q=${event.lat},${event.lon}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: 11, color: 'var(--gc-blue)', marginTop: 4, display: 'inline-block' }}
                >
                  Open in Maps ↗
                </a>
              )}
            </div>

            {/* Dashcam video — renders nothing when the truck has no
                AI dashcam. Offers a "Load video" button when URLs are
                missing (older events pre media_required=true, or
                expired signed URLs). */}
            <DashcamVideo
              eventId={event.id}
              raw={event.raw}
              onRefreshed={r => setEvent(prev => prev ? { ...prev, raw: r } : prev)}
            />

            <div>
              <div style={{ fontSize: 12, color: 'var(--gc-text-3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
                Confirm driver
              </div>
              {suggested?.displayName && (
                <div style={{ fontSize: 11.5, color: 'var(--gc-text-2)', marginBottom: 6 }}>
                  Autofilled from {suggestedSourceLabel(suggested)}: <b>{suggested.displayName}</b>
                  {suggested.loadNum ? ` (load ${suggested.loadNum})` : ''}.
                </div>
              )}
              {!suggested && (
                <div style={{ fontSize: 11.5, color: 'var(--gc-text-2)', marginBottom: 6 }}>
                  No calendar event or default driver for this truck around the alert time — pick manually.
                </div>
              )}
              {motiveNameString(event) && motiveDisagrees(event, suggested) && (
                <div style={{ fontSize: 11.5, color: '#b45309', marginBottom: 6 }}>
                  Heads up: Motive attributed this to <b>{motiveNameString(event)}</b>. Trust the calendar unless you know otherwise.
                </div>
              )}
              <select
                value={driverId ?? ''}
                onChange={e => setDriverId(e.target.value ? Number(e.target.value) : null)}
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  fontSize: 13,
                  borderRadius: 6,
                  border: '1px solid var(--gc-border-light)',
                  background: 'var(--gc-bg)',
                  color: 'var(--gc-text-1)',
                }}
              >
                <option value="">Select a driver…</option>
                {drivers.map(d => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>

            <div>
              <div style={{ fontSize: 12, color: 'var(--gc-text-3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
                Message (optional)
              </div>
              <textarea
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder="Custom note for the driver. Leave blank to send the default safety alert."
                rows={3}
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  fontSize: 12.5,
                  borderRadius: 6,
                  border: '1px solid var(--gc-border-light)',
                  background: 'var(--gc-bg)',
                  color: 'var(--gc-text-1)',
                  resize: 'vertical',
                }}
              />
            </div>

            {error && (
              <div style={{ fontSize: 12, color: '#dc2626' }}>{error}</div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 'auto', paddingTop: 12 }}>
              <button
                type="button"
                onClick={handleDismiss}
                disabled={busy}
                style={{
                  flex: 1,
                  padding: '10px 12px',
                  borderRadius: 6,
                  border: '1px solid var(--gc-border-light)',
                  background: 'var(--gc-surface)',
                  color: 'var(--gc-text-1)',
                  fontSize: 13,
                  cursor: busy ? 'wait' : 'pointer',
                }}
              >
                Dismiss
              </button>
              <button
                type="button"
                onClick={handleNotify}
                disabled={busy || !driverId}
                style={{
                  flex: 1,
                  padding: '10px 12px',
                  borderRadius: 6,
                  border: '1px solid #dc2626',
                  background: '#dc2626',
                  color: '#fff',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: busy || !driverId ? 'not-allowed' : 'pointer',
                  opacity: busy || !driverId ? 0.6 : 1,
                }}
              >
                {busy ? 'Sending…' : 'Notify driver'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

function suggestedSourceLabel(s: SuggestedDriver): string {
  switch (s.source) {
    case 'calendar_active': return 'the calendar event';
    case 'calendar_recent': return 'the last scheduled load';
    case 'asset_default':   return 'this truck’s default driver';
    default:                return 'the calendar';
  }
}

function motiveNameString(e: PerformanceEventRow): string | null {
  const n = [e.driver_first_name, e.driver_last_name].filter(Boolean).join(' ').trim();
  return n || null;
}

/** Motive-vs-calendar disagreement — only fire the warning when Motive
 *  named someone and the calendar autofill is a different person. */
function motiveDisagrees(e: PerformanceEventRow, s: SuggestedDriver | null): boolean {
  const motive = motiveNameString(e);
  if (!motive) return false;
  const suggested = s?.displayName?.trim();
  if (!suggested) return true;
  return motive.toLowerCase() !== suggested.toLowerCase();
}

function eventTypeLabel(t: string): string {
  switch (t) {
    case 'hard_accel':   return 'Hard acceleration';
    case 'hard_brake':   return 'Hard brake';
    case 'hard_corner':  return 'Hard cornering';
    case 'tailgating':   return 'Tailgating';
    case 'cell_phone':   return 'Phone use';
    case 'distraction':  return 'Distraction';
    case 'drowsiness':   return 'Drowsiness';
    case 'seatbelt':     return 'Seatbelt violation';
    default:             return t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
}

function severityColor(intensity: string | null): string {
  const s = (intensity ?? '').toLowerCase();
  if (s.includes('severe')) return '#dc2626';
  if (s.includes('moderate')) return '#f59e0b';
  return 'var(--gc-text-2)';
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return iso;
  const diffSec = (Date.now() - t) / 1000;
  if (diffSec < 60)   return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return 'Something went wrong.';
}
