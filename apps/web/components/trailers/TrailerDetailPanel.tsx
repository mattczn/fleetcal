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
import { X, Truck, User, MapPin, Clock, Pencil, Container, Route } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { formatStill } from '@/lib/trailerStillness';
import type { TrailerSegment } from '@/lib/trailerHistory';
import type { Trailer, TrailerCategory, CalendarEvent, Asset } from '@/lib/types';

export interface TrailerDetailData {
  trailer:     Trailer;
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
  lastTruck?:   { asset: Asset; at: string };
  lastDriver?:  { name: string; at: string };
  recentLoads:  CalendarEvent[];
}

interface Props {
  data:        TrailerDetailData;
  segments:    TrailerSegment[] | null;
  historyDays: number;
  loadingHistory: boolean;
  onClose:     () => void;
}

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

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-bold uppercase tracking-wider px-4 pt-4 pb-2" style={{ color: 'var(--gc-text-2)' }}>
      {children}
    </div>
  );
}

export default function TrailerDetailPanel({ data, segments, historyDays, loadingHistory, onClose }: Props) {
  const { trailer } = data;
  const updateTrailer    = useCalendarStore(s => s.updateTrailer);
  const trailerCategories = useCalendarStore(s => s.trailerCategories);

  const [editing, setEditing] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [form, setForm] = useState(() => formFrom(trailer));

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

  const stops = (segments ?? []).filter(s => s.kind === 'stopped');

  return (
    <div
      className="flex flex-col min-h-0"
      style={{ width: 340, flexShrink: 0, borderRight: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}
    >
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
                color: data.status === 'in_use' ? '#d93025' : '#1e8e3e',
                background: data.status === 'in_use' ? 'rgba(217,48,37,0.12)' : 'rgba(30,142,62,0.12)',
              }}
            >
              {data.status === 'in_use' ? 'In use' : 'Idle'}
            </span>
            {data.stillHours != null && (
              <span className="text-[12px]" style={{ color: 'var(--gc-text-2)' }}>
                Stationary {data.stillTruncated ? '≥' : ''}{formatStill(data.stillHours)}
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
              : `Last fix ${formatStill(data.fixAgeHours)} ago`}
          </div>
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
        <SectionTitle>Where it&apos;s been · last {historyDays} days</SectionTitle>
        <div className="px-4 pb-1">
          {loadingHistory ? (
            <div className="text-[12px] py-1" style={{ color: 'var(--gc-text-3)' }}>Loading…</div>
          ) : stops.length === 0 ? (
            <div className="text-[12px] py-1 leading-snug" style={{ color: 'var(--gc-text-3)' }}>
              No stored history yet. Positions are recorded every 2 minutes from now on, so this fills in as the trailer moves.
            </div>
          ) : (
            <div className="space-y-2 pb-1">
              {(segments ?? []).map((s, i) => (
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
        </div>

        {/* ── Recent loads ───────────────────────────────────────── */}
        <SectionTitle>Recent loads</SectionTitle>
        <div className="px-4 pb-1">
          {data.recentLoads.length === 0 ? (
            <div className="text-[12px] py-1" style={{ color: 'var(--gc-text-3)' }}>None on record.</div>
          ) : (
            <div className="space-y-1.5 pb-1">
              {data.recentLoads.map(load => (
                <div key={load.id} className="flex gap-2">
                  <Truck size={11} style={{ color: 'var(--gc-text-3)', marginTop: 3, flex: '0 0 auto' }} />
                  <div className="min-w-0">
                    <div className="text-[12px] truncate" style={{ color: 'var(--gc-text-1)' }}>{load.title}</div>
                    <div className="text-[10px]" style={{ color: 'var(--gc-text-3)' }}>
                      {[load.start?.slice(0, 10), load.status?.replace('_', ' ')].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </div>
              ))}
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
