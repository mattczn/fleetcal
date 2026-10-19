'use client';

/**
 * The rate card tab on /payroll/routes: what a leg pays when its route has
 * no standard, learned from the routes that do (apps/api/src/lib/rateCard.ts).
 * Local legs by region × kind × distance, OTR legs by lane and direction.
 * Every cell shows the routes it learned from, flags when they disagree,
 * and can be overridden.
 */

import { Fragment, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import type { RateCardCell, RateCardConfigPatch, RateCardResponse, RateGroup } from '@fleetcal/types';
import { railway } from '@/lib/railway';

const GROUPS: Array<{ id: RateGroup; label: string }> = [
  { id: 'pickup', label: 'Pickup → yard' },
  { id: 'delivery', label: 'Yard → delivery' },
  { id: 'whole', label: 'Whole load' },
  { id: 'transfer', label: 'Yard → yard' },
];
const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const bandLabel = (b: string) => (b.endsWith('+') ? `${b.slice(0, -1)}+ mi` : `${b.replace('-', '–')} mi`);

export default function RateCardView({ card, canEdit, onSaved }: { card: RateCardResponse; canEdit: boolean; onSaved: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const save = async (patch: RateCardConfigPatch) => {
    setErr(null);
    try { await railway.setRateConfig(patch); onSaved(); } catch (e) { setErr(e instanceof Error ? e.message : 'Save failed'); }
  };
  if (!card.available) {
    return <div className="p-4 rounded text-[13px]" style={{ background: '#fef7e0', color: '#b06000' }}>
      The rate card needs its settings table — run <b>rate-card-setup.sql</b> (Downloads) in Supabase, then reload.
    </div>;
  }
  const cellByKey = new Map(card.cells.map((c) => [c.key, c]));
  const lanes = card.cells.filter((c) => c.scope === 'lane').sort((a, b) => (a.lane ?? '').localeCompare(b.lane ?? ''));
  const bands = (() => {
    const out: string[] = [];
    let lo = 0;
    for (const hi of card.config.bands) { out.push(`${lo}-${hi}`); lo = hi; }
    out.push(`${lo}+`);
    return out;
  })();
  const openCell = open ? cellByKey.get(open) ?? null : null;

  return (
    <div className="space-y-5">
      <div className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
        Used for any leg whose route has no standard and no consistent settled pay. Learns from your standards (and settled pay that&apos;s
        been the same 60%+ of the time) — the most common amount among the routes in each cell. Click a cell to see those routes or
        override it. <AlertTriangle size={11} className="inline" style={{ color: '#b06000' }} /> = the routes in it don&apos;t all pay the same.
      </div>
      {err ? <div className="text-[12px]" style={{ color: '#c5221f' }}>{err}</div> : null}

      {card.config.regions.length === 0 ? (
        <div className="text-[13px]" style={{ color: 'var(--gc-text-3)' }}>No regions set up yet.</div>
      ) : card.config.regions.map((reg) => (
        <div key={reg.name}>
          <div className="text-[13px] font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>
            Local {reg.name} <span className="font-normal text-[11px]" style={{ color: 'var(--gc-text-3)' }}>every stop within {reg.radiusMi} mi</span>
          </div>
          <div className="rounded-lg overflow-x-auto" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider" style={{ color: 'var(--gc-text-3)', borderBottom: '1px solid var(--gc-border)' }}>
                  <th className="px-3 py-2 font-semibold">Leg miles</th>
                  {GROUPS.map((g) => <th key={g.id} className="px-3 py-2 font-semibold">{g.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {bands.map((b) => (
                  <tr key={b} style={{ borderBottom: '1px solid var(--gc-border)' }}>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--gc-text-2)' }}>{bandLabel(b)}</td>
                    {GROUPS.map((g) => {
                      const key = `local|${reg.name}|${g.id}|${b}`;
                      return <td key={g.id} className="px-3 py-1.5"><CellButton cell={cellByKey.get(key)} cellKey={key} active={open === key} onClick={() => setOpen(open === key ? null : key)} /></td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {openCell && openCell.region === reg.name ? <CellDetail cell={openCell} canEdit={canEdit} onClose={() => setOpen(null)} save={save} /> : null}
        </div>
      ))}

      <div className="text-[12px]" style={{ color: 'var(--gc-text-2)' }}>
        Each stop past two on a local leg adds <b>{money(card.extraStop.value)}</b>
        {card.extraStop.override != null ? <> (set; learned {card.extraStop.learned != null ? money(card.extraStop.learned) : '—'})</> : ' (learned from multi-stop routes)'}
        {canEdit ? <OverrideInput value={card.extraStop.override} onSave={(v) => save({ overrides: { extraStop: v } })} /> : null}
      </div>

      <div>
        <div className="text-[13px] font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>
          OTR lanes <span className="font-normal text-[11px]" style={{ color: 'var(--gc-text-3)' }}>by direction · lanes with no routes use {card.otrPerMile != null ? `$${card.otrPerMile}/mi` : 'a per-mile estimate'}</span>
        </div>
        <div className="rounded-lg overflow-x-auto" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider" style={{ color: 'var(--gc-text-3)', borderBottom: '1px solid var(--gc-border)' }}>
                <th className="px-3 py-2 font-semibold">Lane</th>
                <th className="px-3 py-2 font-semibold">Pay</th>
                <th className="px-3 py-2 font-semibold">Learned from</th>
              </tr>
            </thead>
            <tbody>
              {lanes.map((c) => (
                <Fragment key={c.key}>
                  <tr style={{ borderBottom: '1px solid var(--gc-border)' }}>
                    <td className="px-3 py-2 font-semibold" style={{ color: 'var(--gc-text-1)' }}>{c.lane}</td>
                    <td className="px-3 py-1.5"><CellButton cell={c} cellKey={c.key} active={open === c.key} onClick={() => setOpen(open === c.key ? null : c.key)} /></td>
                    <td className="px-3 py-2 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                      {c.refs.slice(0, 3).map((r) => `${r.name ?? r.label} ${money(r.pay)}`).join(' · ')}{c.refs.length > 3 ? ` +${c.refs.length - 3}` : ''}
                    </td>
                  </tr>
                  {open === c.key ? <tr><td colSpan={3}><CellDetail cell={c} canEdit={canEdit} onClose={() => setOpen(null)} save={save} /></td></tr> : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ExcludeNames names={card.config.excludeNames} canEdit={canEdit} save={save} excludedCount={card.excluded.length} />
    </div>
  );
}

function CellButton({ cell, cellKey, active, onClick }: { cell: RateCardCell | undefined; cellKey: string; active: boolean; onClick: () => void }) {
  const v = cell?.value ?? null;
  return (
    <button type="button" onClick={onClick} data-cell={cellKey}
      className="w-full text-left rounded px-2 py-1"
      style={{ background: active ? 'var(--gc-hover)' : 'transparent', border: '1px solid transparent' }}>
      <span className="font-semibold tabular-nums" style={{ color: v != null ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}>{v != null ? money(v) : '—'}</span>
      {cell?.varies ? <AlertTriangle size={11} className="inline ml-1" style={{ color: '#b06000' }} /> : null}
      <span className="ml-1.5 text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
        {cell?.override != null ? 'set' : cell?.refs.length ? `${cell.refs.length} route${cell.refs.length > 1 ? 's' : ''}` : ''}
      </span>
    </button>
  );
}

function CellDetail({ cell, canEdit, onClose, save }: {
  cell: RateCardCell; canEdit: boolean; onClose: () => void; save: (p: RateCardConfigPatch) => Promise<void>;
}) {
  return (
    <div className="mt-2 rounded-lg p-3" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-bg)' }}>
      <div className="flex items-center gap-2 mb-2">
        <span className="font-semibold text-[13px]" style={{ color: 'var(--gc-text-1)' }}>{cell.label}</span>
        <span className="text-[12px]" style={{ color: 'var(--gc-text-2)' }}>
          {cell.value != null ? money(cell.value) : '—'}
          {cell.override != null ? ` (set; learned ${cell.learned != null ? money(cell.learned) : '—'})` : cell.learned != null ? ' (learned)' : ''}
        </span>
        {canEdit ? <OverrideInput value={cell.override} onSave={(v) => save({ overrides: { [cell.key]: v } })} /> : null}
        <button type="button" onClick={onClose} className="ml-auto" style={{ color: 'var(--gc-text-3)' }}><X size={14} /></button>
      </div>
      {cell.varies ? (
        <div className="text-[12px] mb-2 flex items-center gap-1" style={{ color: '#b06000' }}>
          <AlertTriangle size={12} /> These routes don&apos;t all pay the same — the card uses the most common amount.
        </div>
      ) : null}
      {cell.refs.length ? (
        <table className="text-[12px] tabular-nums">
          <tbody>
            {cell.refs.map((r) => (
              <tr key={r.routeKey}>
                <td className="pr-3 font-semibold" style={{ color: 'var(--gc-text-1)' }}>{money(r.pay)}</td>
                <td className="pr-3" style={{ color: 'var(--gc-text-1)' }}>{r.name ?? r.label}</td>
                <td className="pr-3" style={{ color: 'var(--gc-text-3)' }}>{r.cities}</td>
                <td className="pr-3" style={{ color: 'var(--gc-text-3)' }}>{r.stops > 2 ? `${r.stops} stops · ` : ''}{r.legs} paid{r.standard ? ' · standard' : ' · settled usual'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>No routes in this cell yet — set an amount to cover it.</div>}
    </div>
  );
}

function OverrideInput({ value, onSave }: { value: number | null; onSave: (v: number | null) => void }) {
  const [raw, setRaw] = useState(value != null ? String(value) : '');
  const n = Number(raw);
  return (
    <span className="inline-flex items-center gap-1 ml-2">
      <span className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>Set $</span>
      <input value={raw} onChange={(e) => setRaw(e.target.value)} inputMode="decimal" className="rounded px-1.5 py-0.5 text-[12px] w-16"
        style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' }} />
      <button type="button" disabled={!(raw.trim() && Number.isFinite(n) && n >= 0)} onClick={() => onSave(n)}
        className="px-2 py-0.5 rounded text-[11px] font-semibold disabled:opacity-40" style={{ background: 'var(--gc-blue)', color: '#fff' }}>Save</button>
      {value != null ? <button type="button" onClick={() => onSave(null)} className="px-1 text-[11px]" style={{ color: '#c5221f' }}>Use learned</button> : null}
    </span>
  );
}

function ExcludeNames({ names, canEdit, save, excludedCount }: {
  names: string[]; canEdit: boolean; save: (p: RateCardConfigPatch) => Promise<void>; excludedCount: number;
}) {
  const [raw, setRaw] = useState('');
  return (
    <div className="text-[12px]" style={{ color: 'var(--gc-text-2)' }}>
      <b>Left out of training:</b> {excludedCount} routes — unticked on the Routes tab, single-place or out-and-back routes (bad stops), and
      any route whose name or customer contains:
      {names.map((n) => (
        <span key={n} className="inline-flex items-center gap-1 ml-1.5 px-1.5 py-0.5 rounded" style={{ background: 'var(--gc-surface-2)' }}>
          {n}
          {canEdit ? <button type="button" onClick={() => void save({ excludeNames: names.filter((x) => x !== n) })} style={{ color: 'var(--gc-text-3)' }}><X size={10} /></button> : null}
        </span>
      ))}
      {canEdit ? (
        <span className="inline-flex items-center gap-1 ml-2">
          <input value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="Add (e.g. DCL)" className="rounded px-1.5 py-0.5 text-[12px] w-32"
            style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' }} />
          <button type="button" disabled={!raw.trim()} onClick={() => { void save({ excludeNames: [...names, raw.trim()] }); setRaw(''); }}
            className="px-2 py-0.5 rounded text-[11px] font-semibold disabled:opacity-40" style={{ background: 'var(--gc-blue)', color: '#fff' }}>Add</button>
        </span>
      ) : null}
    </div>
  );
}
