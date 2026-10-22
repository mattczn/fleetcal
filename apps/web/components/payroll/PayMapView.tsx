'use client';

/**
 * The Map tab on /payroll/routes: draw areas, then set standard pay for the
 * lanes between them (from area → to area × kind of leg). Settled payroll
 * shows what each lane actually paid, so a lane can be priced in one click.
 * Suggestions use a lane after a route's own standard and before anything
 * inferred (apps/api/src/lib/payAreas.ts, lib/routePay.ts).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { LaneDirection, ObservedLane, PayArea, PayAreaPoint, PayLane, PayMapResponse, RateGroup } from '@fleetcal/types';
import { railway } from '@/lib/railway';
import { loadGoogleMaps, MAP_ID } from '@/lib/googleMaps';

const KIND_LABEL: Record<RateGroup, string> = {
  pickup: 'Pickup → yard', delivery: 'Yard → delivery', whole: 'Whole load (pickup → delivery)', transfer: 'Transfer only (yard → yard)',
};
const DIRECTION: Record<LaneDirection, { label: string; bg: string; fg: string; tip: string }> = {
  outbound: { label: 'Outbound', bg: '#fef7e0', fg: '#b06000', tip: 'Leaving a home base' },
  inbound: { label: 'Inbound', bg: '#e6f4ea', fg: '#1e8e3e', tip: 'Coming back to a home base' },
  local: { label: 'Local', bg: '#e8f0fe', fg: '#1a73e8', tip: 'Stays inside one area' },
  through: { label: 'Through', bg: 'var(--gc-surface-2)', fg: 'var(--gc-text-2)', tip: 'Neither end is a home base' },
};
const directionOf = (from: PayArea | undefined, to: PayArea | undefined): LaneDirection | null => {
  if (!from || !to) return null;
  if (from.id === to.id) return 'local';
  if (from.isHome && !to.isHome) return 'outbound';
  if (to.isHome && !from.isHome) return 'inbound';
  return 'through';
};
const COLORS = ['#1a73e8', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2', '#db2777', '#4b5563'];
const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const centroid = (poly: PayAreaPoint[]) => ({
  lat: poly.reduce((s, p) => s + p.lat, 0) / poly.length,
  lng: poly.reduce((s, p) => s + p.lng, 0) / poly.length,
});
const laneKey = (from: number, to: number, kind: RateGroup) => `${from}|${to}|${kind}`;

interface Row {
  key: string; fromAreaId: number; toAreaId: number; kind: RateGroup;
  lane: PayLane | null; observed: ObservedLane | null;
}

export default function PayMapView({ canEdit }: { canEdit: boolean }) {
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<{ tick: number; data?: PayMapResponse; error?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    railway.getPayMap()
      .then((data) => { if (!cancelled) setResult({ tick, data }); })
      .catch((e) => { if (!cancelled) setResult({ tick, error: e instanceof Error ? e.message : 'Failed to load' }); });
    return () => { cancelled = true; };
  }, [tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const data = result?.data ?? null;

  const [selectedArea, setSelectedArea] = useState<number | null>(null);
  const [focusLane, setFocusLane] = useState<string | null>(null);
  const [drawing, setDrawing] = useState<PayAreaPoint[] | null>(null);
  const [showStops, setShowStops] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const areaById = useMemo(() => new Map((data?.areas ?? []).map((a) => [a.id, a])), [data]);
  const rows = useMemo((): Row[] => {
    const m = new Map<string, Row>();
    for (const o of data?.observed ?? []) m.set(laneKey(o.fromAreaId, o.toAreaId, o.kind), { key: laneKey(o.fromAreaId, o.toAreaId, o.kind), fromAreaId: o.fromAreaId, toAreaId: o.toAreaId, kind: o.kind, lane: null, observed: o });
    for (const l of data?.lanes ?? []) {
      const k = laneKey(l.fromAreaId, l.toAreaId, l.kind);
      m.set(k, { ...(m.get(k) ?? { key: k, fromAreaId: l.fromAreaId, toAreaId: l.toAreaId, kind: l.kind, observed: null }), lane: l });
    }
    return [...m.values()].sort((a, b) => (b.observed?.legs ?? 0) - (a.observed?.legs ?? 0));
  }, [data]);
  const totalLegs = (data?.observed ?? []).reduce((s, o) => s + o.legs, 0) + (data?.legsOutsideAreas ?? 0);

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try { await fn(); reload(); } catch (e) { setErr(e instanceof Error ? e.message : 'Save failed'); }
  };

  if (result?.error) return <div className="p-4 rounded text-[13px]" style={{ background: '#fce8e6', color: '#c5221f' }}>{result.error}</div>;
  if (!data) return <div className="flex items-center gap-2 p-6 text-[13px]" style={{ color: 'var(--gc-text-3)' }}><Loader2 size={14} className="animate-spin" /> Loading map…</div>;
  if (!data.available) {
    return <div className="p-4 rounded text-[13px]" style={{ background: '#fef7e0', color: '#b06000' }}>
      The map needs its tables — run <b>pay-areas-setup.sql</b> (Downloads) in Supabase, then reload.
    </div>;
  }

  const focus = focusLane ? rows.find((r) => r.key === focusLane) ?? null : null;
  const selected = selectedArea != null ? areaById.get(selectedArea) ?? null : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap text-[12px]" style={{ color: 'var(--gc-text-2)' }}>
        {canEdit ? (
          drawing ? (
            <span className="inline-flex items-center gap-2 px-2 py-1 rounded" style={{ background: '#e8f0fe', color: '#1a73e8' }}>
              Click the map to add corners ({drawing.length})
            </span>
          ) : (
            <button type="button" onClick={() => { setSelectedArea(null); setDrawing([]); }}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded font-semibold" style={{ background: 'var(--gc-blue)', color: '#fff' }}>
              <Plus size={13} /> New area
            </button>
          )
        ) : null}
        <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={showStops} onChange={(e) => setShowStops(e.target.checked)} /> Show stops</label>
        <span style={{ color: 'var(--gc-text-3)' }}>
          {data.areas.length} areas · {data.lanes.length} lanes priced · {totalLegs ? Math.round((1 - data.legsOutsideAreas / totalLegs) * 100) : 0}% of settled paid legs run between your areas
          {data.legsOutsideAreas ? ` (${data.legsOutsideAreas} outside — draw areas around the stop dots to cover them)` : ''}
        </span>
        {err ? <span style={{ color: '#c5221f' }}>{err}</span> : null}
      </div>

      <div className="flex gap-3 flex-col xl:flex-row">
        <div className="xl:flex-1 min-w-0">
          <AreaMap data={data} showStops={showStops} selectedArea={selectedArea} onSelectArea={setSelectedArea}
            focus={focus} drawing={drawing} onDrawPoint={(p) => setDrawing((d) => (d ? [...d, p] : d))}
            onSaveShape={(id, polygon) => run(() => railway.updatePayArea(id, { polygon }))} canEdit={canEdit} />
          {drawing ? (
            <NewAreaForm points={drawing} onCancel={() => setDrawing(null)} onUndo={() => setDrawing((d) => (d ? d.slice(0, -1) : d))}
              onSave={(name, color, isHome) => run(async () => { await railway.createPayArea({ name, color, polygon: drawing, isHome }); setDrawing(null); })} />
          ) : null}
          {selected && !drawing ? (
            <AreaEditor key={selected.id} area={selected} canEdit={canEdit} onClose={() => setSelectedArea(null)}
              onSave={(patch) => run(() => railway.updatePayArea(selected.id, patch))}
              onDelete={() => { if (window.confirm(`Delete ${selected.name}? Its lanes go with it.`)) void run(async () => { await railway.deletePayArea(selected.id); setSelectedArea(null); }); }} />
          ) : null}
        </div>

        <div className="xl:w-[520px] shrink-0">
          <div className="text-[13px] font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>Lanes</div>
          <div className="text-[11px] mb-2" style={{ color: 'var(--gc-text-3)' }}>
            Pay for a leg from one area to another, by kind. Every lane your settled payroll ran is listed with what it actually paid — set the
            pay once and it&apos;s suggested for every load on it (a route&apos;s own standard still wins). Stops past two add the rate card&apos;s
            extra-stop amount.
          </div>
          <div className="rounded-lg overflow-y-auto" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', maxHeight: 640 }}>
            {rows.length === 0 ? (
              <div className="p-4 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>Draw areas to see the lanes between them.</div>
            ) : rows.map((r) => (
              <LaneRow key={r.key} row={r} areaById={areaById} canEdit={canEdit} focused={focusLane === r.key}
                onFocus={() => setFocusLane(focusLane === r.key ? null : r.key)}
                onSave={(amount, extraStop) => run(() => railway.setPayLane({ fromAreaId: r.fromAreaId, toAreaId: r.toAreaId, kind: r.kind, amount, extraStop }))} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── The map ─────────────────────────────────────────────────────────────

function AreaMap({ data, showStops, selectedArea, onSelectArea, focus, drawing, onDrawPoint, onSaveShape, canEdit }: {
  data: PayMapResponse; showStops: boolean; selectedArea: number | null; onSelectArea: (id: number | null) => void;
  focus: Row | null; drawing: PayAreaPoint[] | null; onDrawPoint: (p: PayAreaPoint) => void;
  onSaveShape: (id: number, polygon: PayAreaPoint[]) => void; canEdit: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const [ready, setReady] = useState(false);
  const polys = useRef(new Map<number, google.maps.Polygon>());
  const drawingRef = useRef(drawing);
  const onDrawRef = useRef(onDrawPoint);
  const onSelectRef = useRef(onSelectArea);
  useEffect(() => { drawingRef.current = drawing; onDrawRef.current = onDrawPoint; onSelectRef.current = onSelectArea; });

  // The map, once; fitted to the stops the first time.
  useEffect(() => {
    let cancelled = false;
    void loadGoogleMaps().then((g) => {
      if (cancelled || !box.current) return;
      const map = new g.maps.Map(box.current, { center: { lat: 39, lng: -113 }, zoom: 6, mapId: MAP_ID, clickableIcons: false, gestureHandling: 'greedy' });
      map.addListener('click', (e: google.maps.MapMouseEvent) => {
        if (drawingRef.current && e.latLng) onDrawRef.current({ lat: e.latLng.lat(), lng: e.latLng.lng() });
        else onSelectRef.current(null);
      });
      mapRef.current = map;
      setReady(true);
    });
    return () => { cancelled = true; };
  }, []);
  const fitted = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || fitted.current) return;
    const pts = [...data.places, ...data.areas.flatMap((a) => a.polygon)];
    if (!pts.length) return;
    const b = new google.maps.LatLngBounds();
    pts.forEach((p) => b.extend(p));
    map.fitBounds(b, 40);
    fitted.current = true;
  }, [ready, data]);

  // Areas (editable when selected), with name labels.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const made: Array<google.maps.Polygon | google.maps.marker.AdvancedMarkerElement> = [];
    polys.current.clear();
    for (const a of data.areas) {
      const isSel = a.id === selectedArea;
      const inFocus = focus && (focus.fromAreaId === a.id || focus.toAreaId === a.id);
      const poly = new google.maps.Polygon({
        map, paths: a.polygon, strokeColor: a.color, strokeWeight: isSel || inFocus ? 3 : 1.5, strokeOpacity: 0.9,
        fillColor: a.color, fillOpacity: inFocus ? 0.28 : isSel ? 0.22 : 0.12, editable: isSel && canEdit, zIndex: isSel ? 3 : 1,
        clickable: !drawing,
      });
      poly.addListener('click', () => onSelectRef.current(a.id));
      polys.current.set(a.id, poly);
      made.push(poly);
      const label = document.createElement('div');
      label.textContent = a.name;
      label.style.cssText = `font: 600 11px system-ui; color: ${a.color}; background: rgba(255,255,255,0.85); padding: 1px 5px; border-radius: 4px; pointer-events: none;`;
      made.push(new google.maps.marker.AdvancedMarkerElement({ map, position: centroid(a.polygon), content: label, zIndex: 2 }));
    }
    return () => made.forEach((o) => ('setMap' in o ? o.setMap(null) : (o.map = null)));
  }, [ready, data, selectedArea, focus, drawing, canEdit]);

  // Stop dots (sized by paid legs) and yard pins.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !showStops) return;
    const made = data.places.map((p) => {
      const el = document.createElement('div');
      const size = p.isYard ? 12 : Math.min(14, 4 + Math.log2(1 + p.legs) * 1.6);
      el.style.cssText = p.isYard
        ? 'width:12px;height:12px;background:#111827;border:2px solid #fff;transform:rotate(45deg);box-shadow:0 1px 3px rgba(0,0,0,.4);'
        : `width:${size}px;height:${size}px;border-radius:50%;background:rgba(220,38,38,.65);border:1px solid #fff;`;
      el.title = `${p.name}${p.isYard ? ' (yard)' : ''} — ${p.legs} paid legs`;
      return new google.maps.marker.AdvancedMarkerElement({ map, position: { lat: p.lat, lng: p.lng }, content: el, zIndex: p.isYard ? 4 : 0 });
    });
    return () => made.forEach((m) => { m.map = null; });
  }, [ready, data, showStops]);

  // The area being drawn.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !drawing?.length) return;
    const line = new google.maps.Polyline({ map, path: drawing.length > 2 ? [...drawing, drawing[0]] : drawing, strokeColor: '#1a73e8', strokeWeight: 2 });
    const dots = drawing.map((p) => new google.maps.Marker({
      map, position: p, clickable: false,
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 4, fillColor: '#1a73e8', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 1 },
    }));
    return () => { line.setMap(null); dots.forEach((d) => d.setMap(null)); };
  }, [ready, drawing]);

  // A focused lane: arrow between the two areas.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !focus || focus.fromAreaId === focus.toAreaId) return;
    const a = data.areas.find((x) => x.id === focus.fromAreaId);
    const b = data.areas.find((x) => x.id === focus.toAreaId);
    if (!a || !b) return;
    const line = new google.maps.Polyline({
      map, path: [centroid(a.polygon), centroid(b.polygon)], strokeColor: '#111827', strokeWeight: 3, strokeOpacity: 0.8, zIndex: 5,
      icons: [{ icon: { path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 3 }, offset: '100%' }],
    });
    return () => line.setMap(null);
  }, [ready, data, focus]);

  return (
    <div className="relative">
      <div ref={box} className="rounded-lg" style={{ height: 640, border: '1px solid var(--gc-border)' }} />
      {selectedArea != null && canEdit ? (
        <button type="button" className="absolute top-3 left-3 px-2.5 py-1 rounded text-[12px] font-semibold shadow"
          style={{ background: '#fff', color: '#1a73e8', border: '1px solid #d2e3fc' }}
          onClick={() => {
            const poly = polys.current.get(selectedArea);
            if (poly) onSaveShape(selectedArea, poly.getPath().getArray().map((ll) => ({ lat: ll.lat(), lng: ll.lng() })));
          }}>
          Save shape
        </button>
      ) : null}
    </div>
  );
}

// ── Panels ──────────────────────────────────────────────────────────────

function NewAreaForm({ points, onSave, onCancel, onUndo }: {
  points: PayAreaPoint[]; onSave: (name: string, color: string, isHome: boolean) => void; onCancel: () => void; onUndo: () => void;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [isHome, setIsHome] = useState(false);
  return (
    <div className="mt-2 rounded-lg p-3 flex items-center gap-2 flex-wrap text-[12px]" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
      <span style={{ color: 'var(--gc-text-2)' }}>New area — {points.length} corner{points.length === 1 ? '' : 's'}</span>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. SLC metro)" className="rounded px-2 py-1 text-[12px]"
        style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)', width: 200 }} />
      <Swatches value={color} onChange={setColor} />
      <label className="inline-flex items-center gap-1" title="Where trucks are based — lanes leaving it are outbound, coming back inbound">
        <input type="checkbox" checked={isHome} onChange={(e) => setIsHome(e.target.checked)} /> Home base
      </label>
      <button type="button" disabled={points.length < 3 || !name.trim()} onClick={() => onSave(name.trim(), color, isHome)}
        className="px-2.5 py-1 rounded font-semibold disabled:opacity-40" style={{ background: 'var(--gc-blue)', color: '#fff' }}>Save area</button>
      <button type="button" disabled={!points.length} onClick={onUndo} className="px-2 py-1 disabled:opacity-40" style={{ color: 'var(--gc-text-2)' }}>Undo corner</button>
      <button type="button" onClick={onCancel} className="px-2 py-1" style={{ color: 'var(--gc-text-3)' }}>Cancel</button>
    </div>
  );
}

function AreaEditor({ area, canEdit, onSave, onDelete, onClose }: {
  area: PayArea; canEdit: boolean; onSave: (patch: { name?: string; color?: string; isHome?: boolean }) => void; onDelete: () => void; onClose: () => void;
}) {
  const [name, setName] = useState(area.name);
  return (
    <div className="mt-2 rounded-lg p-3 flex items-center gap-2 flex-wrap text-[12px]" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
      <Pencil size={12} style={{ color: area.color }} />
      {canEdit ? (
        <>
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name.trim() !== area.name && onSave({ name: name.trim() })}
            className="rounded px-2 py-1 text-[12px] font-semibold" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)', width: 200 }} />
          <Swatches value={area.color} onChange={(c) => onSave({ color: c })} />
          <label className="inline-flex items-center gap-1" title="Where trucks are based — lanes leaving it are outbound, coming back inbound">
            <input type="checkbox" checked={area.isHome} onChange={(e) => onSave({ isHome: e.target.checked })} /> Home base
          </label>
          <span style={{ color: 'var(--gc-text-3)' }}>Drag the corners on the map, then Save shape.</span>
          <button type="button" onClick={onDelete} className="ml-auto inline-flex items-center gap-1 px-2 py-1" style={{ color: '#c5221f' }}><Trash2 size={12} /> Delete</button>
        </>
      ) : <span className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>{area.name}</span>}
      <button type="button" onClick={onClose} style={{ color: 'var(--gc-text-3)' }}><X size={14} /></button>
    </div>
  );
}

function Swatches({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <span className="inline-flex gap-1">
      {COLORS.map((c) => (
        <button key={c} type="button" onClick={() => onChange(c)} title={c}
          style={{ width: 16, height: 16, borderRadius: 4, background: c, outline: value === c ? '2px solid var(--gc-text-1)' : 'none', outlineOffset: 1 }} />
      ))}
    </span>
  );
}

function LaneRow({ row, areaById, canEdit, focused, onFocus, onSave }: {
  row: Row; areaById: Map<number, PayArea>; canEdit: boolean; focused: boolean; onFocus: () => void;
  onSave: (amount: number | null, extraStop: number | null) => void;
}) {
  const from = areaById.get(row.fromAreaId);
  const to = areaById.get(row.toAreaId);
  const o = row.observed;
  const suggested = row.lane?.amount ?? o?.standards[0]?.amount ?? o?.amounts[0]?.amount ?? null;
  const [raw, setRaw] = useState(suggested != null ? String(suggested) : '');
  const n = Number(raw);
  const valid = raw.trim() !== '' && Number.isFinite(n) && n >= 0;
  const [extraRaw, setExtraRaw] = useState(row.lane?.extraStop != null ? String(row.lane.extraStop) : '');
  const extra = extraRaw.trim() === '' ? null : Number(extraRaw);
  const extraValid = extra == null || (Number.isFinite(extra) && extra >= 0);
  const changed = n !== row.lane?.amount || extra !== (row.lane?.extraStop ?? null);
  const varies = (o?.amounts.length ?? 0) > 1;
  const dir = directionOf(from, to);
  return (
    <div style={{ borderBottom: '1px solid var(--gc-border)', background: focused ? 'var(--gc-bg)' : undefined }}>
      <div className="flex items-start gap-2 px-3 py-2">
        <button type="button" onClick={onFocus} className="mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
          {focused ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
            <span style={{ color: from?.color }}>{from?.name ?? '?'}</span> → <span style={{ color: to?.color }}>{to?.name ?? '?'}</span>
            <span className="ml-1.5 font-normal text-[11px]" style={{ color: 'var(--gc-text-3)' }}>{KIND_LABEL[row.kind]}</span>
            {dir ? (
              <span className="ml-1.5 px-1 rounded text-[10px] font-semibold" style={{ background: DIRECTION[dir].bg, color: DIRECTION[dir].fg }} title={DIRECTION[dir].tip}>
                {DIRECTION[dir].label}
              </span>
            ) : null}
          </div>
          <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
            {o ? <>{o.legs} paid legs · paid {o.amounts.slice(0, 3).map((a) => `${money(a.amount)}×${a.count}`).join(', ')}{o.amounts.length > 3 ? '…' : ''}</> : 'No settled pay yet'}
            {o?.standards.length ? <> · standards {o.standards.slice(0, 3).map((a) => `${money(a.amount)}×${a.routes}`).join(', ')}</> : null}
            {varies ? <span className="ml-1 inline-flex items-center gap-0.5" style={{ color: '#b06000' }}><AlertTriangle size={10} /> varies</span> : null}
          </div>
        </div>
        <div className="shrink-0 text-right">
          {row.lane ? (
            <div className="text-[13px] font-semibold" style={{ color: '#1e8e3e' }}>
              {money(row.lane.amount)}
              {row.lane.extraStop != null ? <span className="font-normal text-[11px]" style={{ color: 'var(--gc-text-3)' }}> +{money(row.lane.extraStop)}/stop</span> : null}
            </div>
          ) : null}
          {canEdit ? (
            <div className="inline-flex items-center gap-1 mt-0.5">
              <span className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>$</span>
              <input value={raw} onChange={(e) => setRaw(e.target.value)} inputMode="decimal" className="rounded px-1.5 py-0.5 text-[12px] w-16"
                style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' }} />
              <span className="text-[11px] ml-1" style={{ color: 'var(--gc-text-3)' }} title="Pay per stop past two on this lane (empty = the general extra-stop amount)">+$</span>
              <input value={extraRaw} onChange={(e) => setExtraRaw(e.target.value)} inputMode="decimal" placeholder="stop" className="rounded px-1.5 py-0.5 text-[12px] w-12"
                style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' }} />
              <button type="button" disabled={!valid || !extraValid || !changed} onClick={() => onSave(n, extra)}
                className="px-2 py-0.5 rounded text-[11px] font-semibold disabled:opacity-40" style={{ background: 'var(--gc-blue)', color: '#fff' }}>
                {row.lane ? 'Save' : 'Set'}
              </button>
              {row.lane ? <button type="button" onClick={() => onSave(null, null)} className="px-1 text-[11px]" style={{ color: '#c5221f' }}>Clear</button> : null}
            </div>
          ) : null}
        </div>
      </div>
      {focused && o ? (
        <div className="px-9 pb-2">
          <table className="text-[11px] tabular-nums w-full">
            <tbody>
              {o.refs.slice(0, 12).map((r) => (
                <tr key={r.routeKey}>
                  <td className="pr-2 font-semibold" style={{ color: 'var(--gc-text-1)' }}>{money(r.pay)}</td>
                  <td className="pr-2 truncate" style={{ maxWidth: 220, color: 'var(--gc-text-1)' }}>{r.name ?? r.label}</td>
                  <td className="pr-2 truncate" style={{ maxWidth: 150, color: 'var(--gc-text-3)' }}>{r.cities}</td>
                  <td style={{ color: 'var(--gc-text-3)' }}>{r.legs} paid{r.standard ? ' · std' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
