'use client';

/**
 * TrailerDetailPanel — everything known about one trailer, beside the map.
 *
 * Opens on the LEFT of the trailer map when a trailer is selected, so
 * the detail and the pin are on screen together; the roster stays on
 * the right, which is how you move between trailers without losing
 * your place.
 *
 * WHERE THE FACTS COME FROM, and why:
 *
 *   Status / position   Motive, live.
 *   Parked for          our own stored fix history (trailer_location_samples).
 *   Last truck/driver   OUR LOADS, not Motive's gateway pairing.
 *                       Motive reports the tractor its gateway last
 *                       saw power from, which is a decent guess;
 *                       events.assetId is what dispatch actually
 *                       assigned, which is the answer to "who had
 *                       it". Where they disagree, dispatch is right
 *                       about intent and Motive is right about
 *                       hardware, and intent is what this panel is
 *                       for.
 *   Places been         the fix history, segmented into stops + runs.
 *   Recent loads        events carrying this trailerId.
 *
 * The Details block is editable in place, which is the other half of
 * "edit trailer fields directly in this page": a single Edit toggle
 * rather than per-field inline editors, so a half-finished edit is
 * always obvious and always cancellable.
 *
 * The parent keys this component by trailer id, so selecting a
 * different trailer remounts it and the edit form resets by
 * construction — no effect watching for the prop to change, and no
 * window where one trailer's half-typed VIN sits under another's
 * name.
 */
import { useState } from 'react';
import { X, Truck, User, MapPin, Clock, Pencil, Container, Route, Copy, Check } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { formatStill, formatAge, formatDwell } from '@/lib/trailerStillness';
import type { TrailerSegment } from '@/lib/trailerHistory';
import type { Trailer, TrailerCategory, CalendarEvent, Asset } from '@/lib/types';
import type { LinkSource } from '@/lib/trailerUsage';

export interface TrailerDetailData {
  trailer:     Trailer;
  /** 'in_use' covers both a running load and one that left the
   *  trailer behind a tractor — see lib/trailerUsage.ts. */
  status:      'in_use' | 'idle';
  /** Live position label and fix age. */
  address?:    string;
  yardName?:   string;
  fixAgeHours: number | null;
  /** Hours parked where it is now, from stored history. */
  stillHours:  number | null;
  stillTruncated: boolean;
  /** Most recent load that carried this trailer, and the one running now. */
  currentLoad?: CalendarEvent;
  /**
   * Who has it RIGHT NOW, and on what evidence. A different question
   * from `lastTruck` below, which is the dispatch history: loads get
   * swapped mid-route and nobody retypes the record, so the truck
   * that HAS a trailer is usually not the one its load names. See
   * lib/trailerUsage.ts for how the sources are ranked.
   */
  heldBy?: {
    asset?:        Asset;
    source:        LinkSource;
    /** The tractor the load was dispatched to, when it is a different
     *  one. Present exactly when a swap happened. */
    dispatchedTo?: Asset;
    /** When a manual assignment was made, so a stale one is visible. */
    setAt?:        string | null;
  };
  lastTruck?:   { asset: Asset; at: string };
  lastDriver?:  { name: string; at: string };
  recentLoads:  CalendarEvent[];
}

interface Props {
  data:        TrailerDetailData;
  segments:    TrailerSegment[] | null;
  historyDays: number;
  loadingHistory: boolean;
  /** "Now", ticked by the parent. Passed in rather than read here:
   *  Date.now() during render is impure, and the panel would also
   *  disagree with the fix ages the parent already computed. */
  nowMs:       number;
  onClose:     () => void;
}

/** Status pill colours. Kept in step with STATUS_PIN_COLOR in
 *  TrailerFleetMapPanel: the pill and the map pin describe the same
 *  trailer, so they must not disagree. */
const STATUS_STYLE: Record<'in_use' | 'idle', { label: string; fg: string; bg: string }> = {
  in_use: { label: 'In use', fg: '#d93025', bg: 'rgba(217,48,37,0.12)' },
  idle:   { label: 'Idle',   fg: '#1e8e3e', bg: 'rgba(30,142,62,0.12)' },
};

function fmtDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1">
      <div className="text-[10px] uppercase tracking-wider shrink-0" style={{ width: 104, color: 'var(--gc-text-3)', paddingTop: 2 }}>
        {label}
      </div>
      <div className="text-[12px] min-w-0 flex-1" style={{ color: 'var(--gc-text-1)' }}>{children}</div>
    </div>
  );
}

/**
 * Where the "hooked to" answer came from.
 *
 * Shown always, not just when it is surprising. The three sources are
 * not equally strong — a human who looked at the yard beats a
 * proximity reading beats a dispatch record nobody updated after the
 * swap — and a dispatcher deciding whether to trust the line needs to
 * know which one they are reading.
 */
const SOURCE_BADGE: Record<LinkSource, { label: string; fg: string; bg: string; title: string }> = {
  manual:   { label: 'Set by hand', fg: '#8430ce', bg: 'rgba(132,48,206,0.12)',
              title: 'Somebody assigned this truck. Holds until it is changed or cleared.' },
  gps:      { label: 'GPS',         fg: '#1e8e3e', bg: 'rgba(30,142,62,0.12)',
              title: 'This truck is the only one standing with the trailer.' },
  dispatch: { label: 'From the load', fg: '#b06000', bg: 'rgba(176,96,0,0.12)',
              title: 'No usable GPS on the trailer, so this is the truck the load named — it may have been swapped.' },
};

function SourceBadge({ source }: { source: LinkSource }) {
  const s = SOURCE_BADGE[source];
  return (
    <span
      title={s.title}
      className="text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5"
      style={{ color: s.fg, background: s.bg }}
    >
      {s.label}
    </span>
  );
}

/** A day heading like "Mon 24 Nov", and a bare clock time. */
function fmtDay(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * The whole stored history, by time.
 *
 * The inline section shows the last day because that is what a
 * dispatcher is usually asking ("where has this been since
 * yesterday"), and because a working trailer fills a week with
 * segments faster than a side panel can hold them. Everything older
 * lives here, grouped by day with times down the left so the shape of
 * a day — sat, ran, sat — is readable at a glance.
 */
function HistoryPanel({
  segments, days, onClose,
}: { segments: TrailerSegment[]; days: number; onClose: () => void }) {
  const byDay: Array<{ day: string; rows: TrailerSegment[] }> = [];
  for (const seg of segments) {
    const day = fmtDay(seg.from);
    const last = byDay[byDay.length - 1];
    if (last && last.day === day) last.rows.push(seg);
    else byDay.push({ day, rows: [seg] });
  }

  return (
    <div
      className="absolute inset-0 z-20 flex flex-col"
      style={{ background: 'var(--gc-bg-1)' }}
    >
      <div
        className="flex items-center justify-between px-4 py-3 shrink-0"
        style={{ borderBottom: '1px solid var(--gc-border)' }}
      >
        <div className="text-[13px] font-bold" style={{ color: 'var(--gc-text-1)' }}>
          Movement history · last {days} days
        </div>
        <button type="button" onClick={onClose} aria-label="Close history"
          style={{ color: 'var(--gc-text-3)' }}>
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {segments.length === 0 ? (
          <div className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
            No stored history yet.
          </div>
        ) : byDay.map(({ day, rows }) => (
          <div key={day} className="mb-4">
            <div
              className="text-[11px] font-bold uppercase tracking-wider pb-1.5 mb-1.5"
              style={{ color: 'var(--gc-text-2)', borderBottom: '1px solid var(--gc-border)' }}
            >
              {day}
            </div>
            <div className="space-y-2">
              {rows.map((seg, i) => (
                <div key={i} className="flex gap-3">
                  <div
                    className="text-[10px] tabular-nums shrink-0 text-right"
                    style={{ width: 64, color: 'var(--gc-text-3)', paddingTop: 2 }}
                  >
                    {fmtTime(seg.from)}
                    <div>{fmtTime(seg.to)}</div>
                  </div>
                  {seg.kind === 'stopped' ? (
                    <div className="min-w-0 flex gap-2">
                      <MapPin size={11} style={{ color: 'var(--gc-text-3)', marginTop: 3, flex: '0 0 auto' }} />
                      <div className="min-w-0">
                        <div className="text-[12px]" style={{ color: 'var(--gc-text-1)' }}>
                          {seg.address || `${seg.lat.toFixed(3)}, ${seg.lon.toFixed(3)}`}
                        </div>
                        <div className="text-[10px]" style={{ color: 'var(--gc-text-3)' }}>
                          Sat {formatStill(seg.hours)}
                          {/* A stop built from one check-in is a gateway
                              that reported once and went quiet, not an
                              observed dwell. */}
                          {seg.fixes === 1 && ' · single check-in'}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2 items-start">
                      <Route size={11} style={{ color: '#1a73e8', marginTop: 3, flex: '0 0 auto' }} />
                      <div className="text-[12px]" style={{ color: 'var(--gc-text-2)' }}>
                        Moved {seg.miles != null ? `${Math.round(seg.miles)} mi ` : ''}
                        in {formatStill(seg.hours)}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-bold uppercase tracking-wider px-4 pt-4 pb-2" style={{ color: 'var(--gc-text-2)' }}>
      {children}
    </div>
  );
}

export default function TrailerDetailPanel({ data, segments, historyDays, loadingHistory, nowMs, onClose }: Props) {
  const { trailer } = data;
  const updateTrailer    = useCalendarStore(s => s.updateTrailer);
  const trailerCategories = useCalendarStore(s => s.trailerCategories);

  const [editing, setEditing] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [form, setForm] = useState(() => formFrom(trailer));
  const [historyOpen, setHistoryOpen] = useState(false);
  const [hookOpen, setHookOpen] = useState(false);
  const [hookSaving, setHookSaving] = useState(false);

  // Only real tractors can be hand-assigned: a retired truck isn't
  // holding anything today, and Unassigned is a column on the board,
  // not a vehicle.
  const assets = useCalendarStore(s => s.assets);
  const today  = new Date().toISOString().slice(0, 10);
  const assignable = assets
    .filter(a => a.type !== 'Unassigned' && (!a.activeTo || a.activeTo >= today))
    .sort((a, b) => a.name.localeCompare(b.name));

  async function setHook(assetId: number | null) {
    setHookSaving(true);
    try {
      await updateTrailer(trailer.id, { manualAssetId: assetId });
      setHookOpen(false);
    } finally {
      setHookSaving(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await updateTrailer(trailer.id, {
        name:              form.name.trim() || trailer.name,
        trailerNumber:     form.trailerNumber.trim() || undefined,
        category:          form.category,
        make:              form.make.trim() || undefined,
        model:             form.model.trim() || undefined,
        vin:               form.vin.trim() || undefined,
        licensePlate:      form.licensePlate.trim() || undefined,
        licenseState:      form.licenseState.trim().toUpperCase() || undefined,
        licenseExpiration: form.licenseExpiration || null,
        motiveVehicleId:   form.motiveVehicleId.trim() || undefined,
        notes:             form.notes.trim() || undefined,
      });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  const allSegments = segments ?? [];
  const stops = allSegments.filter(s => s.kind === 'stopped');

  // The inline list is the last day only. A working trailer produces
  // a segment every few hours, so a week of them turns this panel
  // into a scroll — and "where has it been since yesterday" is the
  // question being asked here. Everything older is one click away in
  // HistoryPanel, with times.
  //
  // Kept by the END of the segment: a trailer that has sat in the
  // same place since Friday has one stop whose `from` is days old,
  // and dropping it would leave today's section empty while the
  // trailer is plainly somewhere.
  const dayAgo = nowMs - 24 * 3_600_000;
  const recentSegments = allSegments.filter(seg => {
    const ended = new Date(seg.to).getTime();
    return Number.isFinite(ended) && ended >= dayAgo;
  });

  return (
    <div
      className="flex flex-col min-h-0 relative"
      style={{ width: 340, flexShrink: 0, borderRight: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}
    >
      {/* Covers the panel rather than opening beside it: at 340px
          there is no room for two columns, and the history is a
          thing you go and read, then come back from. */}
      {historyOpen && (
        <HistoryPanel
          segments={allSegments}
          days={historyDays}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {/* Header */}
      <div className="flex items-start gap-2 px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--gc-border)' }}>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
            {trailer.trailerNumber ? `#${trailer.trailerNumber}` : trailer.name}
          </div>
          <div className="text-[11px] truncate" style={{ color: 'var(--gc-text-3)' }}>
            {[trailer.category, trailer.trailerNumber ? trailer.name : null].filter(Boolean).join(' · ')}
          </div>
        </div>
        <button
          onClick={onClose}
          title="Close"
          className="p-1.5 rounded-full shrink-0"
          style={{ color: 'var(--gc-text-3)', border: 'none', background: 'transparent', cursor: 'pointer' }}
        >
          <X size={15} />
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {/* ── Status ─────────────────────────────────────────────── */}
        <div className="px-4 pt-3">
          <div className="flex items-center gap-2">
            <span
              className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded"
              style={{
                color:      STATUS_STYLE[data.status].fg,
                background: STATUS_STYLE[data.status].bg,
              }}
            >
              {STATUS_STYLE[data.status].label}
            </span>
            {data.stillHours != null && (
              <span className="text-[12px]" style={{ color: 'var(--gc-text-2)' }}>
                Stationary {formatDwell(data.stillHours, data.stillTruncated)}
              </span>
            )}
          </div>
          {data.yardName ? (
            <div className="mt-1.5 text-[12px] flex items-center gap-1.5" style={{ color: '#1a73e8', fontWeight: 600 }}>
              <Container size={12} /> At {data.yardName}
            </div>
          ) : data.address ? (
            <div className="mt-1.5 text-[12px] flex items-start gap-1.5" style={{ color: 'var(--gc-text-1)' }}>
              <MapPin size={12} style={{ color: 'var(--gc-text-3)', marginTop: 2 }} /> {data.address}
            </div>
          ) : null}
          <div className="mt-1 text-[11px] flex items-center gap-1.5" style={{ color: 'var(--gc-text-3)' }}>
            <Clock size={10} />
            {data.fixAgeHours == null
              ? 'No GPS fix on record'
              : `Last fix ${formatAge(data.fixAgeHours)}`}
          </div>
        </div>

        {/* ── Who has it now ─────────────────────────────────────── */}
        <SectionTitle>Hooked to</SectionTitle>
        <div className="px-4 pb-1">
          {data.heldBy?.asset ? (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  style={{
                    width: 9, height: 9, borderRadius: '50%', flex: '0 0 auto',
                    background: data.heldBy.asset.color, boxShadow: '0 0 0 1px rgba(0,0,0,0.15)',
                  }}
                />
                <span className="text-[13px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                  {data.heldBy.asset.name}
                </span>
                <SourceBadge source={data.heldBy.source} />
              </div>
              {/* The swap, stated. Seeing "dispatched to CT-2020" under
                  "hooked to P-C412863" is the whole point: both facts
                  are true and the difference is the thing that
                  happened. */}
              {data.heldBy.dispatchedTo && (
                <div className="mt-1 text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                  Load was dispatched to {data.heldBy.dispatchedTo.name}
                </div>
              )}
              {data.heldBy.source === 'manual' && data.heldBy.setAt && (
                <div className="mt-1 text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                  Set by hand {fmtDate(data.heldBy.setAt)}
                </div>
              )}
            </>
          ) : (
            <div className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
              {data.status === 'in_use'
                ? 'On a load, but no truck is with it right now'
                : 'No truck has it'}
            </div>
          )}

          {hookOpen ? (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <select
                className="text-[12px] rounded px-2 py-1"
                style={{ background: 'var(--gc-bg-2)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
                defaultValue={trailer.manualAssetId != null ? String(trailer.manualAssetId) : ''}
                disabled={hookSaving}
                onChange={e => { void setHook(e.target.value ? Number(e.target.value) : null); }}
              >
                <option value="">Select a truck…</option>
                {assignable.map(a => (
                  <option key={a.id} value={a.id}>{a.name}{a.unit ? ` · #${a.unit}` : ''}</option>
                ))}
              </select>
              <button
                type="button" disabled={hookSaving} onClick={() => setHookOpen(false)}
                className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button" onClick={() => setHookOpen(true)}
                className="text-[11px] font-semibold" style={{ color: 'var(--gc-blue)' }}
              >
                {trailer.manualAssetId != null ? 'Change truck' : 'Set the truck by hand'}
              </button>
              {trailer.manualAssetId != null && (
                <button
                  type="button" disabled={hookSaving} onClick={() => { void setHook(null); }}
                  className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}
                >
                  Clear
                </button>
              )}
            </div>
          )}
        </div>

        {/* ── Last truck / driver ────────────────────────────────── */}
        <SectionTitle>Last connected</SectionTitle>
        <div className="px-4 pb-1">
          <Row label="Vehicle">
            {data.lastTruck ? (
              <div className="flex items-center gap-2">
                <span
                  style={{
                    width: 9, height: 9, borderRadius: '50%', flex: '0 0 auto',
                    background: data.lastTruck.asset.color, boxShadow: '0 0 0 1px rgba(0,0,0,0.15)',
                  }}
                />
                <span className="font-semibold">{data.lastTruck.asset.name}</span>
                <span style={{ color: 'var(--gc-text-3)' }}>{fmtDate(data.lastTruck.at)}</span>
              </div>
            ) : (
              <span style={{ color: 'var(--gc-text-3)' }}>No load has carried this trailer yet</span>
            )}
          </Row>
          <Row label="Driver">
            {data.lastDriver ? (
              <div className="flex items-center gap-2">
                <User size={11} style={{ color: 'var(--gc-text-3)' }} />
                <span className="font-semibold">{data.lastDriver.name}</span>
                <span style={{ color: 'var(--gc-text-3)' }}>{fmtDate(data.lastDriver.at)}</span>
              </div>
            ) : (
              <span style={{ color: 'var(--gc-text-3)' }}>—</span>
            )}
          </Row>
        </div>

        {/* ── Where it's been ────────────────────────────────────── */}
        <SectionTitle>Where it&apos;s been · last 24 hours</SectionTitle>
        <div className="px-4 pb-1">
          {loadingHistory ? (
            <div className="text-[12px] py-1" style={{ color: 'var(--gc-text-3)' }}>Loading…</div>
          ) : stops.length === 0 ? (
            <div className="text-[12px] py-1 leading-snug" style={{ color: 'var(--gc-text-3)' }}>
              No stored history yet. Positions are recorded every 2 minutes from now on, so this fills in as the trailer moves.
            </div>
          ) : recentSegments.length === 0 ? (
            <div className="text-[12px] py-1" style={{ color: 'var(--gc-text-3)' }}>
              Nothing recorded in the last 24 hours.
            </div>
          ) : (
            <div className="space-y-2 pb-1">
              {recentSegments.map((s, i) => (
                s.kind === 'stopped' ? (
                  <div key={i} className="flex gap-2">
                    <MapPin size={11} style={{ color: 'var(--gc-text-3)', marginTop: 3, flex: '0 0 auto' }} />
                    <div className="min-w-0">
                      <div className="text-[12px] truncate" style={{ color: 'var(--gc-text-1)' }}>
                        {s.address || `${s.lat.toFixed(3)}, ${s.lon.toFixed(3)}`}
                      </div>
                      <div className="text-[10px]" style={{ color: 'var(--gc-text-3)' }}>
                        {fmtDate(s.from)} → {fmtDate(s.to)} · {formatStill(s.hours)}
                        {s.fixes === 1 && ' · single check-in'}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div key={i} className="flex gap-2 items-center" style={{ paddingLeft: 2 }}>
                    <Route size={11} style={{ color: '#1a73e8', flex: '0 0 auto' }} />
                    <div className="text-[10px]" style={{ color: 'var(--gc-text-2)' }}>
                      Moved {s.miles != null ? `${Math.round(s.miles)} mi` : ''} in {formatStill(s.hours)}
                    </div>
                  </div>
                )
              ))}
            </div>
          )}
          {!loadingHistory && allSegments.length > 0 && (
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              className="mt-2 mb-1 text-[11px] font-semibold flex items-center gap-1"
              style={{ color: 'var(--gc-blue)' }}
            >
              <Clock size={11} />
              Full history by time
              <span style={{ color: 'var(--gc-text-3)', fontWeight: 400 }}>
                · {allSegments.length} {allSegments.length === 1 ? 'entry' : 'entries'}, {historyDays}d
              </span>
            </button>
          )}
        </div>

        {/* ── Recent loads ───────────────────────────────────────── */}
        <SectionTitle>Recent loads</SectionTitle>
        <div className="px-4 pb-1">
          {data.recentLoads.length === 0 ? (
            <div className="text-[12px] py-1" style={{ color: 'var(--gc-text-3)' }}>None on record.</div>
          ) : (
            <div className="space-y-1.5 pb-1">
              {data.recentLoads.map(load => {
                // Lead with the number, because the point of this list
                // is to give you something to look the load up by. The
                // broker's load # is what paperwork and phone calls
                // use, so it goes first; the internal id trails it
                // muted, since that's what /loads/{id} and the search
                // results key on.
                // The broker's load # is what paperwork and phone
                // calls use, so it leads and it is what the copy
                // button puts on the clipboard. The internal id
                // trails it muted, since that's what the search
                // results and /loads/{id} key on.
                const broker   = load.loadNum ?? null;
                const internal = load.internalLoadId != null ? String(load.internalLoadId) : null;
                const copyable = broker ?? internal;
                return (
                  <div key={load.id} className="flex gap-2">
                    <Truck size={11} style={{ color: 'var(--gc-text-3)', marginTop: 3, flex: '0 0 auto' }} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1 min-w-0">
                        <span className="text-[12px] font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
                          {copyable ? `#${copyable}` : load.title}
                          {broker && internal && (
                            <span className="ml-1.5 font-normal" style={{ color: 'var(--gc-text-3)' }}>{internal}</span>
                          )}
                        </span>
                        {copyable && <CopyButton value={copyable} />}
                      </div>
                      <div className="text-[10px] truncate" style={{ color: 'var(--gc-text-3)' }}>
                        {[
                          copyable ? load.title : null,
                          load.start?.slice(0, 10),
                        ].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Details (editable) ─────────────────────────────────── */}
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-2)' }}>
            Details
          </span>
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              className="text-[11px] font-semibold inline-flex items-center gap-1"
              style={{ color: 'var(--gc-blue)', border: 'none', background: 'transparent', cursor: 'pointer' }}
            >
              <Pencil size={10} /> Edit
            </button>
          )}
        </div>

        <div className="px-4 pb-5">
          {!editing ? (
            <>
              <Row label="Name">{trailer.name}</Row>
              <Row label="Trailer #">{trailer.trailerNumber || '—'}</Row>
              <Row label="Category">{trailer.category}</Row>
              <Row label="Make / model">{[trailer.make, trailer.model].filter(Boolean).join(' / ') || '—'}</Row>
              <Row label="VIN">{trailer.vin || '—'}</Row>
              <Row label="Plate">
                {[trailer.licensePlate, trailer.licenseState].filter(Boolean).join(' · ') || '—'}
                {trailer.licenseExpiration && (
                  <span style={{ color: 'var(--gc-text-3)' }}> · exp {trailer.licenseExpiration}</span>
                )}
              </Row>
              <Row label="Motive ID">{trailer.motiveVehicleId || '—'}</Row>
              {trailer.notes && <Row label="Notes">{trailer.notes}</Row>}
            </>
          ) : (
            <div className="space-y-2">
              <Field label="Name"      value={form.name}          onChange={v => setForm({ ...form, name: v })} />
              <Field label="Trailer #" value={form.trailerNumber} onChange={v => setForm({ ...form, trailerNumber: v })} />
              <div>
                <FieldLabel>Category</FieldLabel>
                <select
                  value={form.category}
                  onChange={e => setForm({ ...form, category: e.target.value as TrailerCategory })}
                  style={inputStyle}
                >
                  {Array.from(new Set([form.category, ...trailerCategories])).map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <Field label="Make"  value={form.make}  onChange={v => setForm({ ...form, make: v })} />
              <Field label="Model" value={form.model} onChange={v => setForm({ ...form, model: v })} />
              <Field label="VIN"   value={form.vin}   onChange={v => setForm({ ...form, vin: v })} />
              <div className="flex gap-2">
                <div className="flex-1"><Field label="Plate" value={form.licensePlate} onChange={v => setForm({ ...form, licensePlate: v })} /></div>
                <div style={{ width: 64 }}><Field label="State" value={form.licenseState} onChange={v => setForm({ ...form, licenseState: v })} /></div>
              </div>
              <div>
                <FieldLabel>Plate expires</FieldLabel>
                <input type="date" value={form.licenseExpiration} onChange={e => setForm({ ...form, licenseExpiration: e.target.value })} style={inputStyle} />
              </div>
              <Field label="Motive ID" value={form.motiveVehicleId} onChange={v => setForm({ ...form, motiveVehicleId: v })} />
              <div>
                <FieldLabel>Notes</FieldLabel>
                <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
              </div>

              {error && <div className="text-[11px]" style={{ color: '#d93025' }}>{error}</div>}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => void save()}
                  disabled={saving}
                  className="text-[12px] font-semibold"
                  style={{
                    padding: '6px 14px', borderRadius: 7, border: 'none',
                    background: 'var(--gc-blue)', color: '#fff',
                    cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1,
                  }}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={() => { setForm(formFrom(trailer)); setEditing(false); setError(null); }}
                  className="text-[12px] font-semibold"
                  style={{
                    padding: '6px 14px', borderRadius: 7,
                    border: '1px solid var(--gc-border)', background: 'transparent',
                    color: 'var(--gc-text-2)', cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 9px',
  border: '1px solid var(--gc-border)',
  borderRadius: 7,
  background: 'var(--gc-surface)',
  color: 'var(--gc-text-1)',
  fontSize: 12,
  outline: 'none',
};

/**
 * Copy one value to the clipboard, with a tick to say it worked.
 *
 * The tick matters more than it looks: a copy button that silently
 * does nothing is indistinguishable from one that worked, and
 * clipboard writes genuinely fail — an insecure origin, or a browser
 * that withholds permission. A failure leaves the icon alone rather
 * than flashing a tick it hasn't earned.
 */
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Left deliberately silent: there is nothing the dispatcher can
      // do about it, and the number is right there to read.
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={copied ? 'Copied' : `Copy ${value}`}
      aria-label={copied ? 'Copied' : `Copy load number ${value}`}
      className="shrink-0 inline-flex items-center justify-center"
      style={{
        width: 18, height: 18, borderRadius: 4, border: 'none',
        background: 'transparent', cursor: 'pointer', padding: 0,
        color: copied ? '#1e8e3e' : 'var(--gc-text-3)',
      }}
      onMouseEnter={e => { if (!copied) e.currentTarget.style.background = 'var(--gc-hover)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
      {children}
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <input value={value} onChange={e => onChange(e.target.value)} style={inputStyle} />
    </div>
  );
}

function formFrom(t: Trailer) {
  return {
    name:              t.name ?? '',
    trailerNumber:     t.trailerNumber ?? '',
    category:          t.category,
    make:              t.make ?? '',
    model:             t.model ?? '',
    vin:               t.vin ?? '',
    licensePlate:      t.licensePlate ?? '',
    licenseState:      t.licenseState ?? '',
    licenseExpiration: t.licenseExpiration ?? '',
    motiveVehicleId:   t.motiveVehicleId ?? '',
    notes:             t.notes ?? '',
  };
}
