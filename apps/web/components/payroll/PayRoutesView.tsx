'use client';

/**
 * /payroll/routes — every route loads run, what settled payroll paid on
 * it, and the standard pay set for it. The standard (or, without one, the
 * usual amount) is what the payroll page and the load form suggest.
 * See apps/api/src/lib/routePay.ts.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ChevronDown, ChevronRight, Loader2, Route as RouteIcon } from 'lucide-react';
import type { PayRoute, PayRoutesResponse, RouteLegKind } from '@fleetcal/types';
import AppShell from '@/components/nav/AppShell';
import { railway } from '@/lib/railway';
import { usePermissions } from '@/lib/usePermissions';
import { useCalendarStore } from '@/store/useCalendarStore';
import type { CalendarEvent } from '@/lib/types';
import { KIND_LABEL } from './SuggestedPay';

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const shortDate = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export default function PayRoutesView() {
  const { can } = usePermissions();
  const canEdit = can('payroll.adjust');
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<{ tick: number; data?: PayRoutesResponse; error?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    railway.getPayRoutes()
      .then((data) => { if (!cancelled) setResult({ tick, data }); })
      .catch((e) => { if (!cancelled) setResult({ tick, error: e instanceof Error ? e.message : 'Failed to load' }); });
    return () => { cancelled = true; };
  }, [tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const data = result?.data ?? null;
  const error = result?.error ?? null;

  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<RouteLegKind | ''>('');
  const [minLegs, setMinLegs] = useState(3);
  const [open, setOpen] = useState<string | null>(null);

  // Open a paid leg's load in the load modal on this page. Older loads
  // aren't in the calendar's window, so fetch the load into the store first.
  const mergeEvents = useCalendarStore((st) => st.mergeEvents);
  const openEditModal = useCalendarStore((st) => st.openEditModal);
  const [opening, setOpening] = useState<string | null>(null);
  const openLoad = async (loadId: string, eventId: string) => {
    setOpening(eventId);
    try {
      const { loads } = await railway.getLoad(loadId);
      mergeEvents(loads as CalendarEvent[]);
      openEditModal(eventId);
    } catch (e) {
      console.error('[routes] open load failed:', e);
    } finally {
      setOpening(null);
    }
  };

  const placeById = useMemo(() => new Map((data?.places ?? []).map((p) => [p.id, p])), [data]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.routes ?? []).filter((r) =>
      (r.legs >= minLegs || r.standard)
      && (!kind || r.kind === kind)
      && (!q || [r.name ?? '', r.label, r.cities, ...r.customers].some((t) => t.toLowerCase().includes(q))));
  }, [data, search, kind, minLegs]);

  const field = { border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' } as const;

  return (
    <AppShell>
      <div className="max-w-[1400px] mx-auto px-6 py-4">
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <Link href="/payroll" className="w-8 h-8 rounded-full flex items-center justify-center"
            style={{ background: 'var(--gc-surface-2)', color: 'var(--gc-text-2)' }} title="Back to payroll">
            <ArrowLeft size={16} />
          </Link>
          <RouteIcon size={20} style={{ color: 'var(--gc-text-1)' }} />
          <h1 className="text-[20px] font-semibold" style={{ color: 'var(--gc-text-1)', letterSpacing: '-0.3px' }}>Routes &amp; standard pay</h1>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, place, city or customer"
            className="rounded px-2 py-1 text-[12px] ml-2" style={{ ...field, width: 220 }} />
          <select value={kind} onChange={(e) => setKind(e.target.value as RouteLegKind | '')} className="rounded px-2 py-1 text-[12px]" style={field}>
            <option value="">Every kind of leg</option>
            {(Object.keys(KIND_LABEL) as RouteLegKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          <select value={minLegs} onChange={(e) => setMinLegs(Number(e.target.value))} className="rounded px-2 py-1 text-[12px]" style={field}>
            <option value={3}>3+ paid legs</option>
            <option value={10}>10+ paid legs</option>
            <option value={1}>Any paid leg</option>
          </select>
        </div>

        {data ? (
          <div className="mb-3 text-[12px] space-y-1" style={{ color: 'var(--gc-text-3)' }}>
            <div>
              From settled payroll through the week of {data.settledThrough ? shortDate(data.settledThrough) : '—'} (weeks finalized
              a week or more ago). The suggestion on a leg is its route&apos;s standard, else the usual amount on the route (3+ paid
              legs), else the usual between the same areas, else the rule for its kind:
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5">
              {(Object.keys(KIND_LABEL) as RouteLegKind[]).map((k) => {
                const r = data.kindRules[k];
                if (!r || !r.legs) return null;
                return <span key={k}><b style={{ color: 'var(--gc-text-2)' }}>{KIND_LABEL[k]}</b> {r.perMile > 0 ? `${money(r.base)} + $${r.perMile.toFixed(2)}/mi` : `${money(r.base)} flat`} <span>({r.legs})</span></span>;
              })}
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="p-4 rounded text-[13px]" style={{ background: '#fce8e6', color: '#c5221f' }}>{error}</div>
        ) : !data ? (
          <div className="flex items-center gap-2 p-6 text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
            <Loader2 size={14} className="animate-spin" /> Loading routes…
          </div>
        ) : (
          <div className="rounded-lg overflow-x-auto" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
            <table className="w-full text-[13px]" style={{ minWidth: 980 }}>
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider" style={{ color: 'var(--gc-text-3)', borderBottom: '1px solid var(--gc-border)' }}>
                  <th className="px-3 py-2 font-semibold w-6" />
                  <th className="px-3 py-2 font-semibold">Route</th>
                  <th className="px-3 py-2 font-semibold text-right">Paid legs</th>
                  <th className="px-3 py-2 font-semibold text-right">Usual</th>
                  <th className="px-3 py-2 font-semibold text-right">Range</th>
                  <th className="px-3 py-2 font-semibold">Last paid</th>
                  <th className="px-3 py-2 font-semibold">Standard</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.key}>
                    <tr style={{ borderBottom: '1px solid var(--gc-border)' }}>
                      <td className="px-3 py-2 align-top">
                        <button type="button" onClick={() => setOpen(open === r.key ? null : r.key)} style={{ color: 'var(--gc-text-3)' }}>
                          {open === r.key ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <RouteTitle route={r} canEdit={canEdit} onSaved={reload} />
                        <div style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>
                          {r.kind ? KIND_LABEL[r.kind] : 'No paid legs yet'}{r.miles != null ? ` · ${r.miles} mi` : ''}
                          {r.customers.length ? ` · ${r.customers.join(', ')}` : ''}
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top text-right tabular-nums">{r.legs || '—'}</td>
                      <td className="px-3 py-2 align-top text-right tabular-nums">
                        {r.usual != null ? <>
                          <div style={{ fontWeight: 600, color: 'var(--gc-text-1)' }}>{money(r.usual)}</div>
                          <div style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>{r.usualShare != null ? `${Math.round(r.usualShare * 100)}% exactly` : ''}</div>
                        </> : '—'}
                      </td>
                      <td className="px-3 py-2 align-top text-right tabular-nums" style={{ color: 'var(--gc-text-2)' }}>
                        {r.legs ? (r.min === r.max ? money(r.min) : `${money(r.min)}–${money(r.max)}`) : '—'}
                      </td>
                      <td className="px-3 py-2 align-top whitespace-nowrap" style={{ color: 'var(--gc-text-2)' }}>{r.lastPaid ? shortDate(r.lastPaid) : '—'}</td>
                      <td className="px-3 py-2 align-top">
                        <StandardEditor route={r} canEdit={canEdit} onSaved={reload} />
                      </td>
                    </tr>
                    {open === r.key ? (
                      <tr style={{ borderBottom: '1px solid var(--gc-border)', background: 'var(--gc-bg)' }}>
                        <td />
                        <td colSpan={6} className="px-3 py-3">
                          <div className="flex flex-wrap gap-8">
                            <div>
                              <div className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>Recent paid legs</div>
                              {r.examples.length ? (
                                <table className="text-[12px] tabular-nums">
                                  <tbody>
                                    {r.examples.map((e) => (
                                      <tr key={e.eventId}>
                                        <td className="pr-3" style={{ color: 'var(--gc-text-3)' }}>{shortDate(e.date)}</td>
                                        <td className="pr-3 whitespace-nowrap">
                                          {e.loadId ? (
                                            <button type="button" onClick={() => void openLoad(e.loadId!, e.eventId)} disabled={opening === e.eventId}
                                              className="font-semibold" style={{ color: 'var(--gc-blue)' }} title="Open the load">
                                              {opening === e.eventId ? <Loader2 size={11} className="animate-spin inline" /> : null} #{e.loadNum ?? '—'}
                                            </button>
                                          ) : `#${e.loadNum ?? '—'}`}
                                        </td>
                                        <td className="pr-3 truncate" style={{ color: 'var(--gc-text-1)', maxWidth: 360 }} title={e.title ?? undefined}>{e.title ?? '—'}</td>
                                        <td className="pr-3" style={{ color: 'var(--gc-text-2)' }}>{e.driver}</td>
                                        <td className="text-right font-semibold" style={{ color: 'var(--gc-text-1)' }}>{money(e.amount)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              ) : <div className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>None settled yet.</div>}
                            </div>
                            <div>
                              <div className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>Places</div>
                              {r.places.map((id, i) => {
                                const p = placeById.get(id);
                                return p ? <PlaceName key={`${id}-${i}`} placeId={id} name={p.name} sub={p.isYard ? 'yard / relay point' : [p.city, p.state].filter(Boolean).join(', ')} canEdit={canEdit} onSaved={reload} /> : null;
                              })}
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
                {!rows.length ? (
                  <tr><td colSpan={7} className="px-3 py-6 text-center text-[13px]" style={{ color: 'var(--gc-text-3)' }}>No routes match.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}

/** The route's name (if given) over its place-to-place title, with the
 *  first and last stop's cities beside it; click Name to set one. */
function RouteTitle({ route, canEdit, onSaved }: { route: PayRoute; canEdit: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    const next = raw.trim();
    if (next === (route.name ?? '')) { setEditing(false); return; }
    try {
      await railway.setRouteName(route.key, next || null);
      setEditing(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    }
  };
  const cities = <span style={{ fontSize: 11, color: 'var(--gc-text-2)', fontWeight: 500 }}>{route.cities}</span>;
  if (editing) {
    return (
      <div className="mb-0.5">
        <input autoFocus value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="Name this route"
          onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setEditing(false); }}
          onBlur={() => void save()}
          className="rounded px-2 py-0.5 text-[13px]" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)', width: 320 }} />
        {err ? <div className="text-[11px]" style={{ color: '#c5221f' }}>{err}</div> : null}
        <div style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>{route.label} · {cities}</div>
      </div>
    );
  }
  const nameBtn = canEdit ? (
    <button type="button" onClick={() => { setRaw(route.name ?? ''); setErr(null); setEditing(true); }}
      className="ml-2 text-[11px] font-normal" style={{ color: 'var(--gc-blue)' }}>
      {route.name ? 'Rename' : 'Name'}
    </button>
  ) : null;
  return route.name ? (
    <div className="mb-0.5">
      <div style={{ color: 'var(--gc-text-1)', fontWeight: 600 }}>{route.name}{nameBtn}</div>
      <div style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>{route.label} · {cities}</div>
    </div>
  ) : (
    <div className="mb-0.5" style={{ color: 'var(--gc-text-1)', fontWeight: 600 }}>
      {route.label} <span className="ml-1">{cities}</span>{nameBtn}
    </div>
  );
}

function StandardEditor({ route, canEdit, onSaved }: { route: PayRoute; canEdit: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const s = route.standard;
  const save = async (amount: number | null) => {
    setSaving(true); setErr(null);
    try {
      await railway.setRouteStandard(route.key, amount, note);
      setEditing(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };
  if (!editing) {
    return (
      <div className="flex items-start gap-2">
        {s ? (
          <div>
            <div style={{ fontWeight: 600, color: '#1e8e3e' }}>{money(s.amount)}</div>
            <div style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>{s.setByName ?? '—'} · {shortDate(s.setAt)}{s.note ? ` · ${s.note}` : ''}</div>
          </div>
        ) : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
        {canEdit ? (
          <button type="button" className="text-[12px]" style={{ color: 'var(--gc-blue)' }}
            onClick={() => { setRaw(String(s?.amount ?? route.usual ?? '')); setNote(s?.note ?? ''); setEditing(true); }}>
            {s ? 'Edit' : 'Set'}
          </button>
        ) : null}
      </div>
    );
  }
  const amount = Number(raw);
  const valid = raw.trim() !== '' && Number.isFinite(amount) && amount >= 0;
  return (
    <div className="flex flex-col gap-1" style={{ minWidth: 220 }}>
      <div className="flex items-center gap-1">
        <span style={{ color: 'var(--gc-text-3)' }}>$</span>
        <input autoFocus value={raw} onChange={(e) => setRaw(e.target.value)} inputMode="decimal"
          className="rounded px-2 py-1 text-[13px] w-24" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' }} />
        <button type="button" disabled={!valid || saving} onClick={() => save(amount)}
          className="px-2 py-1 rounded text-[12px] font-semibold disabled:opacity-40" style={{ background: 'var(--gc-blue)', color: '#fff' }}>
          {saving ? '…' : 'Save'}
        </button>
        {s ? (
          <button type="button" disabled={saving} onClick={() => save(null)} className="px-2 py-1 rounded text-[12px]" style={{ color: '#c5221f' }}>Clear</button>
        ) : null}
        <button type="button" onClick={() => setEditing(false)} className="px-1 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>Cancel</button>
      </div>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)"
        className="rounded px-2 py-1 text-[12px]" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' }} />
      {err ? <div className="text-[11px]" style={{ color: '#c5221f' }}>{err}</div> : null}
    </div>
  );
}

function PlaceName({ placeId, name, sub, canEdit, onSaved }: {
  placeId: number; name: string; sub: string; canEdit: boolean; onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState(name);
  const save = async () => {
    if (!raw.trim() || raw.trim() === name) { setEditing(false); return; }
    try { await railway.renameRoutePlace(placeId, raw.trim()); onSaved(); } finally { setEditing(false); }
  };
  return (
    <div className="text-[12px] mb-1">
      {editing ? (
        <input autoFocus value={raw} onChange={(e) => setRaw(e.target.value)} onBlur={save}
          onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setEditing(false); }}
          className="rounded px-2 py-0.5 text-[12px]" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)', width: 240 }} />
      ) : (
        <span style={{ color: 'var(--gc-text-1)', fontWeight: 600 }}>
          {name}
          {canEdit ? <button type="button" onClick={() => { setRaw(name); setEditing(true); }} className="ml-2 font-normal" style={{ color: 'var(--gc-blue)' }}>Rename</button> : null}
        </span>
      )}
      <span className="ml-2" style={{ color: 'var(--gc-text-3)' }}>{sub}</span>
    </div>
  );
}
