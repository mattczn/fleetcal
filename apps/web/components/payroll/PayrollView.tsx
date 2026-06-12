'use client';

import { useMemo, useState, useEffect, useRef, useCallback, Fragment } from 'react';
import Link from 'next/link';
import { useOrganization } from '@clerk/nextjs';
import { Users, ChevronDown, Loader2, AlertCircle, Check, Pencil, Plus, X, Trash2, CornerDownRight, Lock, Unlock, Download, RotateCcw, Info } from 'lucide-react';
import Tooltip from '@/components/ui/Tooltip';
import CopyChip from '@/components/ui/CopyChip';
import DriversModal from '@/components/sidebar/DriversModal';
import {
  fetchPayrollAdjustments, addPayrollAdjustment, deletePayrollAdjustment,
  fetchPayrollRecord, finalizeDriverPay, unfinalizeDriverPay,
  type PayrollAdjustment, type PayrollRecord,
} from '@/lib/db';
import { parseDate, fmtDate, fmtDateFull, fmtMoney, printPayroll, type PrintDriver } from '@/lib/payrollPdf';
import { useCalendarStore } from '@/store/useCalendarStore';
import { railway } from '@/lib/railway';
import type { LoadSummary } from '@fleetcal/types';
import DataLoader from '@/components/DataLoader';
import AppShell from '@/components/nav/AppShell';
import type { CalendarEvent } from '@/lib/types';

// ─── Week helpers ─────────────────────────────────────────────────────────────

/** Returns the Saturday that starts the week containing `date`. */
function weekSaturdayOf(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dow = d.getDay(); // 0=Sun … 6=Sat
  d.setDate(d.getDate() - ((dow + 1) % 7));
  return d;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

const FUTURE_WEEKS = 4; // how many weeks ahead to include

/** Build the list of week options — 4 future + current + 11 past (16 total). */
function buildWeekOptions(): { label: string; sat: Date; fri: Date }[] {
  const today = new Date();
  const thisSat = weekSaturdayOf(today);
  return Array.from({ length: FUTURE_WEEKS + 1 + 11 }, (_, i) => {
    const offset = FUTURE_WEEKS - i; // positive = future, 0 = this week, negative = past
    const sat = addDays(thisSat, offset * 7);
    const fri = addDays(sat, 6);
    const label =
      offset === 0 ? `This Week  (${fmtDate(sat)} – ${fmtDate(fri)})` :
      offset === 1 ? `Next Week  (${fmtDate(sat)} – ${fmtDate(fri)})` :
      offset >  1 ? `In ${offset} Weeks  (${fmtDate(sat)} – ${fmtDate(fri)})` :
      `${fmtDate(sat)} – ${fmtDate(fri)}`;
    return { label, sat, fri };
  });
}

// ─── Relay leg badge ─────────────────────────────────────────────────────────

function LegBadge({ role }: { role: CalendarEvent['relayRole'] }) {
  const cfg = role === 'pickup'
    ? { label: 'Pickup',   bg: '#1a73e81a', color: '#1a73e8',
        tip: <>This driver ran the <strong>pickup leg</strong> of a relay load. They picked up from the shipper and handed off to the delivery driver. Pay is split: this driver gets their leg&rsquo;s share of revenue and their own driverPay.</> }
    : role === 'delivery'
    ? { label: 'Delivery', bg: '#1e8e3e1a', color: '#1e8e3e',
        tip: <>This driver ran the <strong>delivery leg</strong> of a relay load. They took the freight from the pickup driver to the consignee. Pay is split: this driver gets their leg&rsquo;s share of revenue and their own driverPay.</> }
    : { label: 'Both',     bg: 'var(--gc-hover)', color: 'var(--gc-text-2)',
        tip: <>Non-relay load — one driver ran the <strong>full load from pickup to delivery</strong>. Full loadPrice and full driverPay belong to this driver.</> };
  return (
    <Tooltip content={cfg.tip}>
      <span
        className="px-2 py-0.5 rounded-lg text-[11px] font-semibold whitespace-nowrap"
        style={{ background: cfg.bg, color: cfg.color, cursor: 'help' }}
      >
        {cfg.label}
      </span>
    </Tooltip>
  );
}

// ─── Inline-editable driver pay cell ─────────────────────────────────────────

function PayCell({ load }: { load: CalendarEvent }) {
  const updateEvent = useCalendarStore(s => s.updateEvent);
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // The wrapper span (below) carries data-pay-cell-id and stays
  // mounted across the editing↔display toggle. Earlier version put
  // the data attribute on the inner button — but the button unmounts
  // while we're editing, so when commit() ran, querySelectorAll
  // couldn't find this cell and findIndex returned -1 → "next" was
  // resolved to cells[0] (the very first cell on the page). Anchoring
  // the marker on a stable wrapper fixes that.
  const cellRef = useRef<HTMLSpanElement>(null);

  function startEdit() {
    setRaw(String(load.driverPay ?? ''));
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }

  async function commit({ advance }: { advance?: boolean } = {}) {
    const val = parseFloat(raw);
    if (!isNaN(val) && val !== load.driverPay) {
      setSaving(true);
      await updateEvent(load.id, { driverPay: val });
      setSaving(false);
    }
    setEditing(false);
    if (advance) {
      // Capture our wrapper's identity NOW (before the timeout) so
      // even if React re-renders we still know which cell was "this
      // one." Then in the next tick (after editing→display swap),
      // find the next sibling cell in document order and click its
      // button to open it for edit.
      const here = cellRef.current;
      setTimeout(() => {
        if (typeof document === 'undefined' || !here) return;
        const cells = Array.from(document.querySelectorAll<HTMLSpanElement>('[data-pay-cell-id]'));
        const idx = cells.findIndex(el => el === here);
        // idx === -1 should be impossible now (here is the same node
        // that has the data attribute), but defensive guard anyway.
        if (idx < 0) return;
        const next = cells[idx + 1];
        next?.querySelector('button')?.click();
      }, 0);
    }
  }

  return (
    <span ref={cellRef} data-pay-cell-id={load.id} className="inline-flex">
      {editing ? (
        <div className="flex items-center gap-1">
          <span style={{ color: 'var(--gc-text-3)' }} className="text-sm">$</span>
          <input
            ref={inputRef}
            type="number"
            step="0.01"
            value={raw}
            onChange={e => setRaw(e.target.value)}
            onBlur={() => commit()}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); void commit({ advance: true }); }
              if (e.key === 'Escape') setEditing(false);
            }}
            className="w-24 px-2 py-0.5 rounded text-sm font-semibold text-right"
            style={{
              background: 'var(--gc-bg)',
              border: '1px solid var(--gc-blue)',
              color: 'var(--gc-text-1)',
              outline: 'none',
            }}
            autoFocus
          />
        </div>
      ) : (
        <button
          onClick={startEdit}
          className="group flex items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors"
          style={{ background: 'transparent' }}
          onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
          onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
          title="Click to edit driver pay (Enter saves + jumps to next)"
        >
          {saving ? (
            <Loader2 size={12} className="animate-spin" style={{ color: 'var(--gc-blue)' }} />
          ) : (
            <span className="text-[13px] font-semibold" style={{ color: load.driverPay != null ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}>
              {load.driverPay != null ? fmtMoney(load.driverPay) : '—'}
            </span>
          )}
          <Pencil size={11} className="opacity-0 group-hover:opacity-60 transition-opacity shrink-0" style={{ color: 'var(--gc-text-3)' }} />
        </button>
      )}
    </span>
  );
}

// ─── Accessorial category display labels ─────────────────────────────────────

const ACC_CAT_LABELS: Record<string, string> = {
  detention:    'Detention',
  lumper:       'Lumper',
  layover:      'Layover',
  scale_ticket: 'Scale Ticket',
  extra_stop:   'Extra Stop',
  other:        'Other',
};

// ─── Adjustment categories ────────────────────────────────────────────────────

const ADJ_CATEGORIES = [
  'Bonus', 'Deduction', 'Fuel Advance', 'Layover', 'Detention', 'Reimbursement', 'Other',
] as const;

const INPUT_STYLE: React.CSSProperties = {
  height: 34, border: '1px solid var(--gc-border)', background: 'var(--gc-bg)',
  color: 'var(--gc-text-1)', outline: 'none', borderRadius: 8, padding: '0 8px', fontSize: 14,
};

// ─── Adjustments section ─────────────────────────────────────────────────────

function AdjustmentsSection({
  orgId, driverName, driverAliases, weekStart, sat, onTotalChange, onListChange, refreshTick,
}: {
  orgId: string;
  /** Canonical display name — used when writing new adjustments
   *  so future saves go under one consistent name. */
  driverName: string;
  /** Every historical name the driver has been known by. Includes
   *  `driverName`. Used to PULL existing adjustments that were saved
   *  under any of those names, so a renamed driver still sees their
   *  old deferred-pay / per-diem / etc. lines. */
  driverAliases: string[];
  weekStart: string;
  sat: Date;
  onTotalChange: (total: number) => void;
  onListChange: (list: PayrollAdjustment[]) => void;
  refreshTick?: number;
}) {
  const [adjustments, setAdjustments] = useState<PayrollAdjustment[]>([]);
  const [mode,     setMode]     = useState<'idle' | 'add' | 'defer'>('idle');
  const [saving,   setSaving]   = useState(false);
  const [category, setCategory] = useState<string>(ADJ_CATEGORIES[0]);
  const [desc,     setDesc]     = useState('');
  const [amount,   setAmount]   = useState('');
  // Defer-specific — compute next 4 weeks forward from sat (independent of weekOptions)
  const futureWeeks = useMemo(() => Array.from({ length: 4 }, (_, i) => {
    const s = addDays(sat, (i + 1) * 7);
    const f = addDays(s, 6);
    return { sat: s, fri: f };
  }), [sat]);
  const [deferToIdx,      setDeferToIdx]      = useState(0);
  const [deferAmt,        setDeferAmt]        = useState('');
  const [adjDeferConfirm, setAdjDeferConfirm] = useState(false);
  const [undoingId,       setUndoingId]       = useState<string | null>(null);

  function sync(list: PayrollAdjustment[]) {
    setAdjustments(list);
    onTotalChange(list.reduce((s, a) => s + a.amount, 0));
    onListChange(list);
  }

  // Match adjustments against any alias the driver has been known
  // by (case-insensitive). Without this, a rename — which leaves
  // old adjustments tagged to the old name in the DB — would orphan
  // them under a duplicate row.
  const aliasMatch = useMemo(() => {
    const set = new Set(driverAliases.map(a => a.trim().toLowerCase()).filter(Boolean));
    return (n?: string) => !!n && set.has(n.trim().toLowerCase());
  }, [driverAliases]);

  useEffect(() => {
    if (!orgId || !weekStart) return;
    fetchPayrollAdjustments(orgId, weekStart).then(all => sync(all.filter(a => aliasMatch(a.driverName))));
  }, [orgId, driverName, weekStart, refreshTick, aliasMatch]); // eslint-disable-line

  function openAdd() { setCategory(ADJ_CATEGORIES[0]); setDesc(''); setAmount(''); setMode('add'); }
  function openDefer() { setDeferToIdx(0); setDeferAmt(''); setMode('defer'); }

  async function handleSaveAdj() {
    const val = parseFloat(amount);
    if (isNaN(val) || !category) return;
    setSaving(true);
    const saved = await addPayrollAdjustment({ orgId, driverName, weekStart, category, description: desc.trim() || undefined, amount: val });
    if (saved) sync([...adjustments, saved]);
    setSaving(false); setMode('idle');
  }

  async function handleDefer() {
    const val = parseFloat(deferAmt);
    if (isNaN(val) || val <= 0 || futureWeeks.length === 0) return;
    const target = futureWeeks[deferToIdx];
    const targetWeekStart = target.sat.toISOString().split('T')[0];
    const targetLabel = fmtDate(target.sat);
    const fromLabel   = fmtDate(sat);
    setSaving(true);
    // Negative in current week
    const neg = await addPayrollAdjustment({ orgId, driverName, weekStart, category: 'Deferred', description: `Deferred to ${targetLabel}`, amount: -val });
    // Positive in target week
    await addPayrollAdjustment({ orgId, driverName, weekStart: targetWeekStart, category: 'Deferred', description: `Deferred from ${fromLabel}`, amount: val });
    if (neg) sync([...adjustments, neg]);
    setSaving(false); setMode('idle'); setAdjDeferConfirm(false);
  }

  async function handleDelete(id: string) {
    await deletePayrollAdjustment(id);
    sync(adjustments.filter(a => a.id !== id));
  }

  // Undo a deferred payment: delete the positive adj here AND hunt for the paired negative in past weeks
  async function handleUndoDefer(adj: PayrollAdjustment) {
    setUndoingId(adj.id);
    // Search up to 6 weeks back for the matching negative (same driver, category, negated amount)
    for (let i = 1; i <= 6; i++) {
      const srcSat = addDays(sat, -i * 7);
      const srcWeekStart = srcSat.toISOString().split('T')[0];
      const srcAdjs = await fetchPayrollAdjustments(orgId, srcWeekStart);
      const neg = srcAdjs.find(a =>
        a.driverName === driverName &&
        a.category === 'Deferred' &&
        Math.abs(a.amount) === adj.amount
      );
      if (neg) { await deletePayrollAdjustment(neg.id); break; }
    }
    await deletePayrollAdjustment(adj.id);
    sync(adjustments.filter(a => a.id !== adj.id));
    setUndoingId(null);
  }

  return (
    <div style={{ borderTop: '1px solid var(--gc-border-light)', padding: '12px 20px 16px' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>Adjustments</span>
        {mode === 'idle' && (
          <div className="flex items-center gap-1">
            <Tooltip
              content={
                <>
                  Add a manual line to this week&rsquo;s pay — bonus, deduction, reimbursement, per-diem, fuel advance, etc. Adds to <strong>Driver Pay</strong> immediately; persists across reloads.
                </>
              }>
              <button onClick={openAdd}
                className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg transition-colors"
                style={{ color: 'var(--gc-blue)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-light)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <Plus size={12} /> Add
              </button>
            </Tooltip>
            {futureWeeks.length > 0 && (
              <Tooltip
                content={
                  <>
                    Push a dollar amount out of this week&rsquo;s pay into a future week. Writes a matched pair of adjustments: <strong>negative</strong> here, <strong>positive</strong> in the target week. Use for over-the-road runs that span the Sat–Fri cutoff.
                  </>
                }>
                <button onClick={openDefer}
                  className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg transition-colors"
                  style={{ color: 'var(--gc-text-2)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <CornerDownRight size={12} /> Defer
                </button>
              </Tooltip>
            )}
          </div>
        )}
      </div>

      {/* Existing adjustments — deferred items shown as grouped summary */}
      {adjustments.length > 0 && (() => {
        const regularAdjs  = adjustments.filter(a => !(a.category === 'Deferred' && a.amount < 0));
        const deferredAdjs = adjustments.filter(a => a.category === 'Deferred' && a.amount < 0);
        // Group deferred by target week label (parsed from "… Deferred to May 3")
        const deferGroups = new Map<string, { adjs: typeof deferredAdjs; total: number }>();
        for (const adj of deferredAdjs) {
          const m = adj.description?.match(/Deferred to (.+)$/);
          const key = m ? m[1] : 'following week';
          const g = deferGroups.get(key) ?? { adjs: [], total: 0 };
          deferGroups.set(key, { adjs: [...g.adjs, adj], total: g.total + adj.amount });
        }
        return (
          <div className="mb-3 space-y-1.5">
            {regularAdjs.map(adj => {
              const isDeferred    = adj.category === 'Deferred';
              const isDeferredIn  = isDeferred && adj.amount > 0; // positive = carry-in from another week
              const isUndoing     = undoingId === adj.id;
              // Strip embedded [loadId] prefix from description if present
              const displayDesc = adj.description?.replace(/^\[[a-f0-9-]+\]\s*/, '') ?? undefined;
              return (
                <div key={adj.id} className="flex items-center gap-3 text-sm group">
                  <span className="px-2 py-0.5 rounded-lg text-[11px] font-semibold whitespace-nowrap"
                    style={{
                      background: isDeferred ? '#6941c61a' : adj.amount >= 0 ? '#1e8e3e1a' : '#d9302514',
                      color: isDeferred ? '#6941c6' : adj.amount >= 0 ? '#1e8e3e' : '#d93025',
                    }}>
                    {adj.category}
                  </span>
                  <span className="flex-1 truncate" style={{ color: 'var(--gc-text-2)' }}>
                    {displayDesc ?? <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                  </span>
                  <span className="font-semibold whitespace-nowrap" style={{ color: isDeferred ? '#6941c6' : adj.amount >= 0 ? '#1e8e3e' : '#d93025' }}>
                    {adj.amount >= 0 ? '+' : ''}{fmtMoney(adj.amount)}
                  </span>
                  {isDeferredIn ? (
                    <button
                      onClick={() => handleUndoDefer(adj)}
                      disabled={isUndoing}
                      className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-lg"
                      style={{ color: '#6941c6', background: '#6941c61a', flexShrink: 0, whiteSpace: 'nowrap' }}
                      title="Undo this deferral (removes pay from this week and restores it to the source week)"
                    >
                      {isUndoing ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                      Undo
                    </button>
                  ) : (
                    <button onClick={() => handleDelete(adj.id)}
                      className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity p-0.5 rounded"
                      style={{ color: 'var(--gc-text-3)' }} title="Remove">
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              );
            })}
            {[...deferGroups.entries()].map(([targetLabel, { adjs, total }]) => (
              <div key={targetLabel} className="flex items-center gap-3 text-sm">
                <span className="px-2 py-0.5 rounded-lg text-[11px] font-semibold whitespace-nowrap"
                  style={{ background: '#6941c61a', color: '#6941c6' }}>
                  Deferred
                </span>
                <span className="flex-1" style={{ color: 'var(--gc-text-2)' }}>
                  {adjs.length} load{adjs.length !== 1 ? 's' : ''} deferred to {targetLabel}
                </span>
                <span className="font-semibold whitespace-nowrap" style={{ color: '#6941c6' }}>
                  {fmtMoney(total)}
                </span>
              </div>
            ))}
          </div>
        );
      })()}
      {adjustments.length === 0 && mode === 'idle' && (
        <p className="text-xs" style={{ color: 'var(--gc-text-3)' }}>No adjustments this week.</p>
      )}

      {/* Add adjustment form */}
      {mode === 'add' && (
        <div className="flex items-end gap-2 mt-2 flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>Category</label>
            <select value={category} onChange={e => setCategory(e.target.value)} style={{ ...INPUT_STYLE, width: 150 }}>
              {ADJ_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1 flex-1" style={{ minWidth: 140 }}>
            <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>Description</label>
            <input type="text" value={desc} onChange={e => setDesc(e.target.value)} placeholder="Optional note…" style={INPUT_STYLE} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>Amount</label>
            <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="−50.00" autoFocus
              onKeyDown={e => { if (e.key === 'Enter') handleSaveAdj(); if (e.key === 'Escape') setMode('idle'); }}
              style={{ ...INPUT_STYLE, width: 110, textAlign: 'right', borderColor: 'var(--gc-blue)' }} />
          </div>
          <button onClick={handleSaveAdj} disabled={saving || !amount}
            className="flex items-center gap-1 text-sm font-semibold px-3 rounded-lg transition-colors"
            style={{ background: 'var(--gc-blue)', color: '#fff', height: 34, opacity: saving || !amount ? 0.6 : 1 }}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save
          </button>
          <button onClick={() => setMode('idle')} style={{ height: 34, width: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, color: 'var(--gc-text-3)', background: 'transparent', border: 'none', cursor: 'pointer' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <X size={15} />
          </button>
        </div>
      )}

      {/* Defer payment form */}
      {mode === 'defer' && !adjDeferConfirm && (
        <div className="flex items-end gap-2 mt-2 flex-wrap">
          <div className="flex flex-col gap-1 flex-1" style={{ minWidth: 180 }}>
            <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>Defer to Week</label>
            <select value={deferToIdx} onChange={e => setDeferToIdx(+e.target.value)} style={{ ...INPUT_STYLE, width: '100%' }}>
              {futureWeeks.map((w, i) => (
                <option key={i} value={i}>{fmtDate(w.sat)} – {fmtDate(w.fri)}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>Amount</label>
            <input type="number" step="0.01" value={deferAmt} onChange={e => setDeferAmt(e.target.value)} placeholder="0.00" autoFocus
              onKeyDown={e => { if (e.key === 'Enter' && deferAmt) setAdjDeferConfirm(true); if (e.key === 'Escape') setMode('idle'); }}
              style={{ ...INPUT_STYLE, width: 110, textAlign: 'right', borderColor: 'var(--gc-blue)' }} />
          </div>
          <button onClick={() => { if (deferAmt) setAdjDeferConfirm(true); }} disabled={!deferAmt}
            className="flex items-center gap-1 text-sm font-semibold px-3 rounded-lg"
            style={{ background: 'var(--gc-blue)', color: '#fff', height: 34, opacity: !deferAmt ? 0.6 : 1, cursor: 'pointer' }}>
            <CornerDownRight size={13} /> Defer
          </button>
          <button onClick={() => setMode('idle')} style={{ height: 34, width: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, color: 'var(--gc-text-3)', background: 'transparent', border: 'none', cursor: 'pointer' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <X size={15} />
          </button>
        </div>
      )}
      {/* Defer confirmation */}
      {mode === 'defer' && adjDeferConfirm && (
        <div className="flex items-center gap-3 mt-2 flex-wrap">
          <span className="text-sm flex-1" style={{ color: 'var(--gc-text-2)' }}>
            Defer <strong>{fmtMoney(parseFloat(deferAmt))}</strong> to week of <strong>{fmtDate(futureWeeks[deferToIdx].sat)}</strong>?
          </span>
          <button onClick={handleDefer} disabled={saving}
            className="flex items-center gap-1.5 text-sm font-semibold px-3 rounded-lg"
            style={{ background: 'var(--gc-blue)', color: '#fff', height: 34, opacity: saving ? 0.7 : 1, cursor: 'pointer' }}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Confirm
          </button>
          <button onClick={() => setAdjDeferConfirm(false)}
            className="text-sm px-3 rounded-lg transition-colors"
            style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)', height: 34, cursor: 'pointer' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            Back
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Driver payroll card ──────────────────────────────────────────────────────

interface DriverRow {
  /** Canonical display name — current name from the driver record
   *  if we matched by id, else the stored driverName from the load. */
  driverName: string;
  /** Every historical name string we've seen this driver under,
   *  including the canonical one. Used to fold in adjustments /
   *  records that were saved before a rename. */
  aliases: string[];
  /** Driver record id when this row is anchored to one. Loads that
   *  carry only a legacy `driverName` (no driverId) stand alone. */
  driverId?: number;
  loads: CalendarEvent[];
}

function DriverCard({ row, assets, drivers, orgId, weekStart, orgName, orgLogoUrl, weekLabel, sat, fri }: {
  row: DriverRow;
  assets: ReturnType<typeof useCalendarStore.getState>['assets'];
  drivers: ReturnType<typeof useCalendarStore.getState>['drivers'];
  orgId: string;
  weekStart: string;
  orgName: string;
  orgLogoUrl?: string;
  weekLabel: string;
  sat: Date;
  fri: Date;
}) {
  const openEditModal = useCalendarStore(s => s.openEditModal);
  const updateEvent   = useCalendarStore(s => s.updateEvent);
  const allEvents     = useCalendarStore(s => s.events);
  const [adjTotal,      setAdjTotal]      = useState(0);
  const [adjList,       setAdjList]       = useState<PayrollAdjustment[]>([]);
  const [record,        setRecord]        = useState<PayrollRecord | null>(null);
  const [finalizing,    setFinalizing]    = useState(false);
  const [confirmFin,    setConfirmFin]    = useState(false);
  const [showProfile,   setShowProfile]   = useState(false);
  const [printing,      setPrinting]      = useState(false);
  const [trashConfirm,  setTrashConfirm]  = useState<string | null>(null); // adj.id pending confirm
  // Per-load defer state
  const [deferLoadId,    setDeferLoadId]    = useState<string | null>(null);
  const [deferToWeekIdx, setDeferToWeekIdx] = useState(0);
  const [deferring,      setDeferring]      = useState(false);
  const [deferConfirm,   setDeferConfirm]   = useState(false);
  const [undoDeferLoadId, setUndoDeferLoadId] = useState<string | null>(null); // undo confirm

  // Accessorials marked "Pay Driver" on this driver's loads
  const payToDriverAccs = useMemo<PayrollAdjustment[]>(() => {
    const items: PayrollAdjustment[] = [];
    for (const load of row.loads) {
      for (const acc of (load.accessorials ?? [])) {
        if (!acc.payToDriver) continue;
        const target = acc.payDriverName?.trim() || load.driverName || '';
        if (target.toLowerCase() !== row.driverName.toLowerCase()) continue;
        items.push({
          id: `acc-${load.id}-${acc.id}`,
          driverName: row.driverName,
          weekStart,
          category: ACC_CAT_LABELS[acc.category] ?? acc.category,
          description: acc.description || load.title || '',
          amount: acc.amount,
          createdAt: '',
        });
      }
    }
    return items;
  }, [row.loads, row.driverName, orgId, weekStart]);

  // Next 4 weeks forward from current sat (for per-load defer target)
  const deferWeeks = useMemo(() => Array.from({ length: 4 }, (_, i) => {
    const s = addDays(sat, (i + 1) * 7);
    const f = addDays(s, 6);
    return { sat: s, fri: f };
  }), [sat]);

  // Relay pickup legs where the delivery partner falls after fri (spanning weekend)
  const spanningRelayLoadIds = useMemo(() => {
    const ids = new Set<string>();
    for (const load of row.loads) {
      if (load.relayRole !== 'pickup' || !load.relayGroupId) continue;
      const partner = allEvents.find(e =>
        e.relayGroupId === load.relayGroupId &&
        e.relayRole === 'delivery' &&
        e.id !== load.id
      );
      if (partner && parseDate(partner.start) > fri) ids.add(load.id);
    }
    return ids;
  }, [row.loads, allEvents, fri]);

  const driverRecord = drivers.find(d =>
    d.name?.toLowerCase() === row.driverName.toLowerCase() ||
    `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim().toLowerCase() === row.driverName.toLowerCase()
  );

  // Revenue per LEG for relay loads — pro-rated by routed leg miles
  // so a 500-mile pickup paired with a 200-mile delivery on a
  // $1,400 load credits the pickup driver $1,000 and the delivery
  // driver $400. When any leg is missing loadedMiles, fall back
  // to an even 1/N split across the legs. Non-relay loads return
  // their stored loadPrice unchanged.
  //
  // The authoritative load price is the MAX across legs — handles
  // both the common case (loadPrice duplicated on every leg) and
  // the case where it was set on only one leg.
  const legRevenue = useCallback((l: CalendarEvent): number => {
    if (!l.relayGroupId) return l.loadPrice ?? 0;
    const legs = allEvents.filter(e => e.relayGroupId === l.relayGroupId);
    if (legs.length <= 1) return l.loadPrice ?? 0;
    const totalPrice = Math.max(...legs.map(e => e.loadPrice ?? 0));
    if (totalPrice <= 0) return 0;
    const everyLegHasMiles = legs.every(e => e.loadedMiles != null && e.loadedMiles > 0);
    if (everyLegHasMiles) {
      const totalMiles = legs.reduce((s, e) => s + (e.loadedMiles ?? 0), 0);
      return totalPrice * ((l.loadedMiles ?? 0) / totalMiles);
    }
    return totalPrice / legs.length;
  }, [allEvents]);

  const loadPay  = row.loads.reduce((s, l) => s + (l.driverPay ?? 0), 0);
  const accTotal = payToDriverAccs.reduce((s, a) => s + a.amount, 0);
  const totalPay = loadPay + adjTotal + accTotal;
  const totalRev = row.loads.reduce((s, l) => s + legRevenue(l), 0);
  const isFinalized = record !== null;

  // Remove a payToDriver accessorial by setting payToDriver: false on the source event
  async function removeAccAdj(adjId: string) {
    // id format: "acc-{loadId}-{accId}"
    const parts = adjId.split('-');
    // loadId is a UUID (contains dashes), accId is the last UUID segment group
    // Format: "acc" + "-" + <loadId (uuid with dashes)> + "-" + <accId (uuid with dashes)>
    // Safer: strip leading "acc-" then split on the known accId
    const withoutPrefix = adjId.replace(/^acc-/, '');
    // Find which load this belongs to
    const load = row.loads.find(l => withoutPrefix.startsWith(l.id + '-'));
    if (!load) return;
    const accId = withoutPrefix.slice(load.id.length + 1); // everything after "{loadId}-"
    const updated = (load.accessorials ?? []).map(a =>
      a.id === accId ? { ...a, payToDriver: false, payDriverName: undefined } : a
    );
    await updateEvent(load.id, { accessorials: updated });
    setTrashConfirm(null);
  }

  function openDeferForLoad(load: CalendarEvent) {
    setDeferLoadId(load.id);
    setDeferToWeekIdx(0);
    setDeferConfirm(false);
  }

  async function handleDeferLoad(load: CalendarEvent) {
    if (deferWeeks.length === 0) return;
    const targetWeekStart = deferWeeks[deferToWeekIdx].sat.toISOString().split('T')[0];
    setDeferring(true);
    await updateEvent(load.id, { deferredToWeek: targetWeekStart });
    setDeferring(false);
    setDeferLoadId(null);
    setDeferConfirm(false);
  }

  async function handleUndoDeferLoad(load: CalendarEvent) {
    setDeferring(true);
    // null (not undefined) — undefined gets stripped by JSON.stringify so
    // the body would arrive as {} and the API would 400 "no allowed
    // fields supplied". null serializes through and the handler maps it
    // to SQL NULL via `body.deferredToWeek ?? null`.
    await updateEvent(load.id, { deferredToWeek: null });
    setDeferring(false);
    setUndoDeferLoadId(null);
  }

  async function handleDriverPrint() {
    if (printing) return;
    setPrinting(true);
    try {
      printPayroll({
        orgName,
        orgLogoUrl,
        weekLabel,
        sat,
        fri,
        drivers: [{
          driverName: row.driverName,
          loads: row.loads,
          adjustments: [...adjList, ...payToDriverAccs],
          record,
        }],
      });
    } finally {
      setPrinting(false);
    }
  }

  useEffect(() => {
    if (!orgId || !weekStart) return;
    // Try the canonical name first, then any historical alias. A
    // finalized record from before a driver rename is stored under
    // the old name in the DB — without this fallback it would
    // disappear from the queue and the driver could be finalized
    // twice for the same week.
    let cancelled = false;
    (async () => {
      const tried = new Set<string>();
      for (const name of [row.driverName, ...row.aliases]) {
        const key = name.trim();
        if (!key || tried.has(key.toLowerCase())) continue;
        tried.add(key.toLowerCase());
        const found = await fetchPayrollRecord(orgId, key, weekStart);
        if (cancelled) return;
        if (found) { setRecord(found); return; }
      }
      if (!cancelled) setRecord(null);
    })();
    return () => { cancelled = true; };
  }, [orgId, row.driverName, row.aliases, weekStart]);

  async function handleFinalize() {
    setFinalizing(true);
    const rec = await finalizeDriverPay(orgId, row.driverName, weekStart, totalPay);
    if (rec) setRecord(rec);
    setFinalizing(false); setConfirmFin(false);
  }

  async function handleReopen() {
    if (!record) return;
    await unfinalizeDriverPay(record.id);
    setRecord(null);
  }

  return (
    <div style={{
      background: 'var(--gc-surface)',
      border: isFinalized ? '1px solid #1e8e3e44' : '1px solid var(--gc-border)',
      borderRadius: 12, overflow: 'hidden',
    }}>
      {/* Driver header */}
      <div className="flex items-center justify-between px-5 py-3.5"
        style={{ borderBottom: '1px solid var(--gc-border-light)', background: isFinalized ? '#1e8e3e08' : undefined }}>
        <button
          onClick={() => setShowProfile(true)}
          className="flex items-center gap-3 rounded-lg px-2 py-1 -ml-2 transition-colors"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          title="View driver profile"
        >
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold shrink-0"
            style={{ background: '#1a73e81a', color: 'var(--gc-blue)' }}>
            {row.driverName.charAt(0).toUpperCase()}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-[15px]" style={{ color: 'var(--gc-blue)', textDecoration: 'underline', textUnderlineOffset: 2, textDecorationColor: 'rgba(26,115,232,0.35)' }}>{row.driverName}</span>
              {isFinalized && (
                <span className="flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-lg"
                  style={{ background: '#1e8e3e1a', color: '#1e8e3e' }}>
                  <Lock size={10} /> Paid
                </span>
              )}
            </div>
            <div className="text-xs" style={{ color: 'var(--gc-text-3)' }}>
              {row.loads.length} load{row.loads.length !== 1 ? 's' : ''}
              {isFinalized && ` · Finalized ${new Date(record!.finalizedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
            </div>
          </div>
        </button>

        {showProfile && (
          <DriversModal
            onClose={() => setShowProfile(false)}
            initialDriverId={driverRecord?.id}
          />
        )}
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-[11px] font-semibold uppercase tracking-wide mb-0.5 inline-flex items-center gap-1" style={{ color: 'var(--gc-text-3)' }}>
              Driver Pay
              <Tooltip
                placement="bottom"
                content={
                  <>
                    Per-load <strong>driver pay</strong> for every leg this driver delivered this week
                    {' '}+ payroll <strong>adjustments</strong> (bonuses, deductions, deferred amounts)
                    {' '}+ pay-to-driver <strong>accessorials</strong> matched to this driver by name.
                  </>
                }>
                <Info size={11} style={{ color: 'var(--gc-text-3)', opacity: 0.6, cursor: 'help' }} />
              </Tooltip>
            </div>
            <div className="text-[18px] font-semibold" style={{ color: isFinalized ? '#1e8e3e' : 'var(--gc-text-1)' }}>{fmtMoney(totalPay)}</div>
          </div>
          <div className="text-right">
            <div className="text-[11px] font-semibold uppercase tracking-wide mb-0.5 inline-flex items-center gap-1" style={{ color: 'var(--gc-text-3)' }}>
              Load Revenue
              <Tooltip
                placement="bottom"
                content={
                  <>
                    Sum of <strong>per-leg revenue</strong> across this driver&rsquo;s loads this week. Non-relay legs use full loadPrice; relay legs are prorated by loaded miles (each leg gets its mileage share of the load&rsquo;s total).
                  </>
                }>
                <Info size={11} style={{ color: 'var(--gc-text-3)', opacity: 0.6, cursor: 'help' }} />
              </Tooltip>
            </div>
            <div className="text-[18px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>{fmtMoney(totalRev)}</div>
          </div>
          <button
            onClick={handleDriverPrint}
            disabled={printing}
            title="Download pay stub PDF"
            className="flex items-center justify-center rounded-full transition-colors"
            style={{ width: 34, height: 34, border: '1px solid var(--gc-border)', background: 'var(--gc-bg)', color: 'var(--gc-text-2)', flexShrink: 0 }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; e.currentTarget.style.color = 'var(--gc-text-1)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--gc-bg)'; e.currentTarget.style.color = 'var(--gc-text-2)'; }}
          >
            {printing
              ? <Loader2 size={14} className="animate-spin" style={{ color: 'var(--gc-blue)' }} />
              : <Download size={14} />}
          </button>
        </div>
      </div>

      {/* Auto-suggest banner for spanning relay loads */}
      {spanningRelayLoadIds.size > 0 && (
        <div
          className="flex items-center gap-2 px-5 py-2.5 text-xs font-medium print:hidden"
          style={{ background: '#f59e0b0e', borderTop: '1px solid var(--gc-border-light)', color: '#d97706' }}
        >
          <AlertCircle size={13} />
          {spanningRelayLoadIds.size === 1
            ? `1 load’s delivery falls in the following week`
            : `${spanningRelayLoadIds.size} loads’ deliveries fall in the following week`}
          {' '}— click <CornerDownRight size={11} style={{ display: 'inline', verticalAlign: 'middle', margin: '0 2px' }} /> on the row to defer pay.
        </div>
      )}

      {/* Loads table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
              {['Date', 'Leg', 'Event Title', 'Load #', 'Miles', 'Load Value', 'Driver Pay'].map(h => (
                <th key={h} className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>{h}</th>
              ))}
              <th className="px-2 py-2.5 print:hidden" style={{ width: 44 }} />
            </tr>
          </thead>
          <tbody>
            {row.loads.map(load => {
              const pickupDate    = parseDate(load.start);
              const isSpanning    = spanningRelayLoadIds.has(load.id);
              const isDeferOpen   = deferLoadId === load.id;
              const isDeferredIn  = load.deferredToWeek === weekStart; // came from another week
              const isUndoOpen    = undoDeferLoadId === load.id;
              return (
                <Fragment key={load.id}>
                  <tr
                    style={{
                      borderBottom: isDeferOpen ? 'none' : '1px solid var(--gc-border-light)',
                      background: isSpanning && !isDeferOpen ? '#f59e0b0a' : undefined,
                    }}
                    onMouseOver={e => { if (!isDeferOpen) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                    onMouseOut={e => { e.currentTarget.style.background = isSpanning && !isDeferOpen ? '#f59e0b0a' : 'transparent'; }}
                  >
                    <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--gc-text-2)' }}>
                      <div className="flex items-center gap-1.5">
                        {pickupDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                        {isSpanning && !isDeferOpen && (
                          <span
                            title="Delivery is in the following week — consider deferring pay"
                            className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full text-[9px] font-bold shrink-0"
                            style={{ background: '#f59e0b28', color: '#d97706' }}
                          >!</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3"><LegBadge role={load.relayRole} /></td>
                    <td className="px-4 py-3 max-w-[240px]">
                      {/* TONU + cancelled get a colored pill before the
                          title so it's obvious at a glance that this
                          isn't a normal load — payroll legitimately pays
                          for TONUs and sometimes for cancelled-mid-route
                          loads, but the user needs to spot them when
                          reviewing the week. Status read from load.status
                          mirrors CalendarEvent.tsx's prefix logic. */}
                      <button onClick={() => openEditModal(load.id)}
                        className="inline-flex items-center gap-1.5 max-w-full text-left font-medium hover:underline"
                        style={{ color: 'var(--gc-blue)' }} title={load.title}>
                        {load.status === 'tonu' && (
                          <span
                            className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide shrink-0"
                            style={{ background: '#fde68a', color: '#854d0e' }}>
                            TONU
                          </span>
                        )}
                        {load.status === 'cancelled' && (
                          <span
                            className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide shrink-0"
                            style={{ background: '#fee2e2', color: '#b91c1c' }}>
                            Cancelled
                          </span>
                        )}
                        <span className="truncate min-w-0">
                          {load.title ?? '(no title)'}
                        </span>
                      </button>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {load.loadNum
                        ? <CopyChip value={load.loadNum} style={{ fontSize: 12, fontWeight: 600, color: 'var(--gc-text-2)' }} />
                        : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap tabular-nums" style={{ color: load.loadedMiles != null && load.eventKind !== 'non_revenue' ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}>
                      {/* Maintenance / non-revenue events don't have a
                          "loaded miles" concept — they're not loads.
                          A stale value on the column (left over from
                          when the event briefly had coordinates) shouldn't
                          render here. Display em-dash for any non-revenue
                          event regardless of what the column says. */}
                      {load.loadedMiles != null && load.eventKind !== 'non_revenue'
                        ? `${Math.round(load.loadedMiles).toLocaleString()} mi`
                        : '—'}
                    </td>
                    <td className="px-4 py-3 font-semibold whitespace-nowrap" style={{ color: 'var(--gc-text-1)' }}>
                      {(() => {
                        const rev = legRevenue(load);
                        if (load.loadPrice == null) return '—';
                        // Tag prorated relay legs so the dispatcher
                        // sees this is a SHARE of the full rate, not
                        // the whole thing.
                        if (load.relayGroupId) {
                          return (
                            <span
                              title={`Pro-rated share of $${(load.loadPrice ?? 0).toLocaleString()} total load value`}
                              style={{ borderBottom: '1px dotted var(--gc-text-3)' }}>
                              {fmtMoney(rev)}
                            </span>
                          );
                        }
                        return fmtMoney(rev);
                      })()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <PayCell load={load} />
                        {(() => {
                          const rev = legRevenue(load);
                          if (load.driverPay == null || rev <= 0) return null;
                          return (
                            <span
                              className="print:hidden shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-lg whitespace-nowrap"
                              style={{ background: 'var(--gc-hover)', color: 'var(--gc-text-3)' }}
                            >
                              {Math.round((load.driverPay / rev) * 100)}%
                            </span>
                          );
                        })()}
                      </div>
                    </td>
                    {/* Defer / Undo icon */}
                    <td className="px-2 py-3 print:hidden">
                      {isDeferredIn ? (
                        /* Deferred-in load: show undo button */
                        <Tooltip content={<>Undo defer — move this load&rsquo;s pay back to its <strong>original week</strong>. Removes the matched +/&minus; deferred adjustment pair.</>}>
                          <button
                            onClick={() => setUndoDeferLoadId(isUndoOpen ? null : load.id)}
                            className="flex items-center justify-center w-7 h-7 rounded-full transition-colors"
                            style={{ color: '#6941c6', background: isUndoOpen ? '#6941c61a' : 'transparent' }}
                            onMouseEnter={e => { e.currentTarget.style.background = '#6941c61a'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = isUndoOpen ? '#6941c61a' : 'transparent'; }}
                          >
                            <RotateCcw size={13} />
                          </button>
                        </Tooltip>
                      ) : (
                        /* Normal load: show defer button */
                        <Tooltip
                          content={
                            isDeferOpen
                              ? <>Cancel</>
                              : isSpanning
                                ? <><strong>Delivery falls in next week.</strong> Defer this load&rsquo;s pay so the driver gets paid the week the freight actually delivers, not the week it picked up.</>
                                : <>Defer this load&rsquo;s driver pay to a <strong>future week</strong>. Writes a matched pair of adjustments and removes the load&rsquo;s pay contribution here.</>
                          }>
                          <button
                            onClick={() => { if (isDeferOpen) { setDeferLoadId(null); setDeferConfirm(false); } else { openDeferForLoad(load); } }}
                            className="flex items-center justify-center w-7 h-7 rounded-full transition-colors"
                            style={{
                              color: isSpanning ? '#d97706' : isDeferOpen ? 'var(--gc-blue)' : 'var(--gc-text-3)',
                              background: isDeferOpen ? 'var(--gc-hover)' : 'transparent',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = isDeferOpen ? 'var(--gc-hover)' : 'transparent'; }}
                          >
                            <CornerDownRight size={13} />
                          </button>
                        </Tooltip>
                      )}
                    </td>
                  </tr>

                  {/* Undo defer confirm */}
                  {isUndoOpen && (
                    <tr style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                      <td colSpan={8} style={{ padding: '10px 16px 12px', background: 'var(--gc-surface)' }}>
                        <div className="flex items-center gap-3 flex-wrap">
                          <span className="text-sm flex-1" style={{ color: 'var(--gc-text-2)' }}>
                            Move <strong>{load.title ?? 'this load'}</strong> back to its original week?
                          </span>
                          <button
                            onClick={() => handleUndoDeferLoad(load)}
                            disabled={deferring}
                            className="flex items-center gap-1.5 text-sm font-semibold px-3 rounded-lg"
                            style={{ background: '#6941c6', color: '#fff', height: 34, opacity: deferring ? 0.7 : 1, cursor: 'pointer' }}
                          >
                            {deferring ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Undo Defer
                          </button>
                          <button
                            onClick={() => setUndoDeferLoadId(null)}
                            className="text-sm px-3 rounded-lg transition-colors"
                            style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)', height: 34, cursor: 'pointer' }}
                            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                          >
                            Cancel
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}

                  {/* Inline defer form */}
                  {isDeferOpen && (
                    <tr style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                      <td colSpan={8} style={{ padding: '10px 16px 12px', background: 'var(--gc-surface)' }}>
                        {!deferConfirm ? (
                          /* ── Form: just pick the target week ── */
                          <div className="flex items-end gap-3 flex-wrap">
                            {isSpanning && (
                              <div className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg w-full mb-1"
                                style={{ background: '#f59e0b12', color: '#d97706', border: '1px solid #f59e0b2a' }}>
                                <AlertCircle size={12} />
                                Delivery falls in the following week — defer the load to match.
                              </div>
                            )}
                            <div className="flex flex-col gap-1" style={{ minWidth: 180, flex: 1 }}>
                              <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>
                                Defer Load to Week
                              </label>
                              <select
                                value={deferToWeekIdx}
                                onChange={e => setDeferToWeekIdx(+e.target.value)}
                                style={{ ...INPUT_STYLE, width: '100%' }}
                                autoFocus
                              >
                                {deferWeeks.map((w, i) => (
                                  <option key={i} value={i}>{fmtDate(w.sat)} – {fmtDate(w.fri)}</option>
                                ))}
                              </select>
                            </div>
                            <button
                              onClick={() => setDeferConfirm(true)}
                              className="flex items-center gap-1.5 text-sm font-semibold px-3 rounded-lg"
                              style={{ background: 'var(--gc-blue)', color: '#fff', height: 34, cursor: 'pointer' }}
                            >
                              <CornerDownRight size={13} /> Defer
                            </button>
                            <button
                              onClick={() => { setDeferLoadId(null); setDeferConfirm(false); }}
                              style={{ height: 34, width: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, color: 'var(--gc-text-3)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                            >
                              <X size={15} />
                            </button>
                          </div>
                        ) : (
                          /* ── Confirm ── */
                          <div className="flex items-center gap-3 flex-wrap">
                            <span className="text-sm flex-1" style={{ color: 'var(--gc-text-2)' }}>
                              Defer <strong>{load.title ?? 'this load'}</strong> to week of{' '}
                              <strong>{fmtDate(deferWeeks[deferToWeekIdx].sat)}</strong>?
                            </span>
                            <button
                              onClick={() => handleDeferLoad(load)}
                              disabled={deferring}
                              className="flex items-center gap-1.5 text-sm font-semibold px-3 rounded-lg"
                              style={{ background: 'var(--gc-blue)', color: '#fff', height: 34, opacity: deferring ? 0.7 : 1, cursor: 'pointer' }}
                            >
                              {deferring ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Confirm
                            </button>
                            <button
                              onClick={() => setDeferConfirm(false)}
                              className="text-sm px-3 rounded-lg transition-colors"
                              style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)', height: 34, cursor: 'pointer' }}
                              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                            >
                              Back
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Accessorial adjustments (payToDriver items from load events) */}
      {payToDriverAccs.length > 0 && (
        <div style={{ borderTop: '1px solid var(--gc-border-light)', padding: '12px 20px 14px' }}>
          <div className="text-[11px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--gc-text-3)' }}>
            Accessorials
          </div>
          <div className="space-y-1.5">
            {payToDriverAccs.map(adj => (
              <div key={adj.id} className="flex items-center gap-3 text-sm group">
                {trashConfirm === adj.id ? (
                  <>
                    <span className="text-xs font-medium flex-1" style={{ color: 'var(--gc-text-2)' }}>
                      Remove this accessorial from payroll?
                    </span>
                    <button
                      onClick={() => removeAccAdj(adj.id)}
                      className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-lg"
                      style={{ background: '#d93025', color: '#fff' }}>
                      <Check size={11} /> Remove
                    </button>
                    <button
                      onClick={() => setTrashConfirm(null)}
                      className="text-xs px-2.5 py-1 rounded-lg transition-colors"
                      style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <span className="px-2 py-0.5 rounded-lg text-[11px] font-semibold whitespace-nowrap"
                      style={{ background: '#1a73e81a', color: '#1a73e8' }}>
                      {adj.category}
                    </span>
                    <span className="flex-1 truncate" style={{ color: 'var(--gc-text-2)' }}>
                      {adj.description || <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                    </span>
                    <span className="font-semibold whitespace-nowrap" style={{ color: adj.amount >= 0 ? '#1e8e3e' : '#d93025' }}>
                      {adj.amount >= 0 ? '+' : ''}{fmtMoney(adj.amount)}
                    </span>
                    <button
                      onClick={() => setTrashConfirm(adj.id)}
                      className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity p-0.5 rounded"
                      style={{ color: 'var(--gc-text-3)', flexShrink: 0 }}
                      title="Remove from payroll">
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <AdjustmentsSection
        orgId={orgId} driverName={row.driverName} driverAliases={row.aliases}
        weekStart={weekStart}
        sat={sat} onTotalChange={setAdjTotal}
        onListChange={setAdjList}
      />

      {/* Finalize footer */}
      <div className="flex items-center justify-between px-5 py-3"
        style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
        <div className="text-sm" style={{ color: 'var(--gc-text-3)' }}>
          {isFinalized
            ? `Recorded ${fmtMoney(record!.totalPay)} on ${new Date(record!.finalizedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
            : 'Review loads and adjustments before finalizing.'}
        </div>
        <div className="flex items-center gap-2">
          {isFinalized ? (
            <Tooltip
              content={
                <>
                  <strong>Reopen</strong> this driver&rsquo;s pay for the week. Removes the payroll record so loads + adjustments can be edited again. Use sparingly once a pay stub has been issued.
                </>
              }>
              <button onClick={handleReopen}
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                style={{ color: 'var(--gc-text-3)', border: '1px solid var(--gc-border)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <Unlock size={11} /> Reopen
              </button>
            </Tooltip>
          ) : confirmFin ? (
            <>
              <span className="text-sm font-medium" style={{ color: 'var(--gc-text-2)' }}>
                Record {fmtMoney(totalPay)} for {row.driverName}?
              </span>
              <button onClick={handleFinalize} disabled={finalizing}
                className="flex items-center gap-1.5 text-sm font-semibold px-4 py-1.5 rounded-lg"
                style={{ background: '#1e8e3e', color: '#fff', opacity: finalizing ? 0.7 : 1 }}>
                {finalizing ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                Confirm
              </button>
              <button onClick={() => setConfirmFin(false)}
                className="text-sm px-3 py-1.5 rounded-lg transition-colors"
                style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                Cancel
              </button>
            </>
          ) : (
            <Tooltip
              placement="top"
              content={
                <>
                  <strong>Lock</strong> this driver&rsquo;s pay for the week. Writes a payroll record with the current Driver Pay total so it&rsquo;s preserved even if loads or adjustments change later. Use <em>Reopen</em> to unlock.
                </>
              }>
              <button onClick={() => setConfirmFin(true)}
                className="flex items-center gap-1.5 text-sm font-semibold px-4 py-1.5 rounded-lg transition-colors"
                style={{ background: 'var(--gc-blue)', color: '#fff' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#1558d6')}
                onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-blue)')}>
                <Lock size={13} /> Finalize Pay
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Week selector dropdown ───────────────────────────────────────────────────

function WeekSelector({
  options,
  selectedIdx,
  onChange,
}: {
  options: ReturnType<typeof buildWeekOptions>;
  selectedIdx: number;
  onChange: (i: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium"
        style={{
          background: 'var(--gc-surface)',
          border: '1px solid var(--gc-border)',
          color: 'var(--gc-text-1)',
          boxShadow: 'var(--shadow-1)',
        }}
      >
        {options[selectedIdx].label}
        <ChevronDown size={14} style={{ color: 'var(--gc-text-3)' }} />
      </button>

      {open && (
        <div
          className="absolute right-0 mt-1 z-50 py-1 rounded-xl overflow-hidden"
          style={{
            background: 'var(--gc-surface)',
            border: '1px solid var(--gc-border)',
            boxShadow: 'var(--shadow-3)',
            minWidth: 260,
          }}
        >
          {options.map((opt, i) => (
            <button
              key={i}
              onClick={() => { onChange(i); setOpen(false); }}
              className="w-full text-left px-4 py-2.5 text-[13px] flex items-center gap-2"
              style={{
                background: i === selectedIdx ? 'var(--gc-hover)' : 'transparent',
                color: 'var(--gc-text-1)',
              }}
              onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseOut={e => (e.currentTarget.style.background = i === selectedIdx ? 'var(--gc-hover)' : 'transparent')}
            >
              {i === selectedIdx && <Check size={13} style={{ color: 'var(--gc-blue)', flexShrink: 0 }} />}
              {i !== selectedIdx && <span style={{ width: 13 }} />}
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function PayrollView() {
  const {
    events,
    assets,
    drivers,
    loadedStart,
    loadedEnd,
    dbReady,
    extendLoadedRange,
    unassignedAssetId,
    orgId,
  } = useCalendarStore();

  const { organization } = useOrganization();

  const weekOptions = useMemo(() => buildWeekOptions(), []);
  const [weekIdx, setWeekIdx] = useState(FUTURE_WEEKS); // default to current week
  const [fetching, setFetching] = useState(false);
  // Driver names that have adjustments this week (even with no loads — e.g. deferred carry-ins)
  const [adjDriverNames, setAdjDriverNames] = useState<string[]>([]);

  const { sat, fri } = weekOptions[weekIdx];
  const weekStart = sat.toISOString().split('T')[0];

  // Extend loaded window if selected week isn't cached
  useEffect(() => {
    if (!dbReady) return;
    const startIso = sat.toISOString();
    const endIso   = fri.toISOString();
    if (loadedStart && loadedEnd && startIso >= loadedStart && endIso <= loadedEnd) return;
    setFetching(true);
    extendLoadedRange(startIso, endIso).finally(() => setFetching(false));
  }, [weekIdx, dbReady, sat, fri, loadedStart, loadedEnd, extendLoadedRange]);

  // Fetch adjustments for the selected week so drivers with only deferred pay still appear
  useEffect(() => {
    if (!orgId || !weekStart) return;
    fetchPayrollAdjustments(orgId, weekStart).then(adjs => {
      const names = [...new Set(adjs.map(a => a.driverName).filter(Boolean))];
      setAdjDriverNames(names);
    });
  }, [orgId, weekStart]); // eslint-disable-line

  // Pull the canonical week load set from the same server endpoint the
  // Dashboard uses (/v1/reports/loads via listLoadSummaries). That's
  // our source of truth for "how much revenue did we book this week
  // and how many loads is it" — driven by the loads table directly,
  // with the same pickupAt window the rest of the reporting surfaces
  // already use. Using this instead of the events-store keeps Payroll
  // and Dashboard agreeing by construction; previously each side
  // computed its own filter over its own data source and they kept
  // disagreeing on boundary loads (Unassigned-asset rules, parseDate
  // timezone quirks, zombie events, etc.).
  //
  // Falls back to null while in-flight; the KPI tile shows the local
  // events-store estimate until the canonical value arrives.
  const [weekLoadSummaries, setWeekLoadSummaries] = useState<LoadSummary[] | null>(null);
  useEffect(() => {
    if (!dbReady) return;
    let cancelled = false;
    (async () => {
      try {
        // /v1/reports/loads string-compares pickupFrom/To against
        // pickupAt, which is stored as a NAIVE org-local string
        // ("2026-05-30T01:00:00", no Z). For the lex compare to be
        // meaningful both sides must share TZ semantics — so we send
        // naive cutoffs here too. Sending pStart.toISOString() (Z-
        // suffixed UTC) was the wrong shape and caused dashboard ↔
        // payroll disagreement after the dashboard's TZ fix landed.
        const pad = (n: number) => String(n).padStart(2, '0');
        const fromKey = `${sat.getFullYear()}-${pad(sat.getMonth() + 1)}-${pad(sat.getDate())}`;
        const toKey   = `${fri.getFullYear()}-${pad(fri.getMonth() + 1)}-${pad(fri.getDate())}`;
        const { loads } = await railway.listLoadSummaries({
          pickupFrom: `${fromKey}T00:00:00.000`,
          pickupTo:   `${toKey}T23:59:59.999`,
        });
        if (!cancelled) setWeekLoadSummaries(loads);
      } catch (err) {
        console.error('[PayrollView] listLoadSummaries failed:', err);
        if (!cancelled) setWeekLoadSummaries([]);
      }
    })();
    return () => { cancelled = true; };
  }, [dbReady, sat, fri]);

  // Filter events to the selected week.
  //
  // Asset filtering: a load sitting on the "Unassigned" truck
  // placeholder STILL counts toward payroll AS LONG AS a driver is
  // assigned — dispatchers will often pin the driver before they've
  // decided which truck runs the load, and that driver still earns
  // pay credit. Only a load with NEITHER a real truck NOR a driver
  // is genuinely floating; that's the one we drop.
  //
  // Deferred loads: excluded from their original week, included in
  // their target week.
  const weekEvents = useMemo(() => events.filter(e => {
    // Determine whether this event is sitting on the Unassigned
    // placeholder asset. Two paths: explicit unassignedAssetId
    // sentinel (set on hydrate) OR the asset row's name/type field
    // being literally "Unassigned" (legacy / imported orgs).
    const onUnassignedAsset =
      (unassignedAssetId !== null && e.assetId === unassignedAssetId) ||
      (() => {
        const a = assets.find(x => x.id === e.assetId);
        return a?.type === 'Unassigned' || a?.name === 'Unassigned';
      })();
    const hasDriver = !!e.driverId || !!(e.driverName && e.driverName.trim());
    if (onUnassignedAsset && !hasDriver) return false;
    // If deferred to a different week, hide from original week
    if (e.deferredToWeek && e.deferredToWeek !== weekStart) return false;
    const d = parseDate(e.start);
    // Show if start falls in this week, OR if explicitly deferred to this week
    return (d >= sat && d <= fri) || e.deferredToWeek === weekStart;
  }), [events, assets, sat, fri, weekStart, unassignedAssetId]);

  // Group by driver — IDENTITY-based, not name-based. Loads carrying
  // a driverId fold into one row keyed by that id, with the canonical
  // current name from the driver record shown as the label. This
  // prevents a renamed driver from spawning duplicate payroll rows
  // (one under the old name, one under the new) the way pure name-
  // based grouping did. Each row tracks every name alias we've seen
  // for that driver so historical adjustments saved under the old
  // name still flow into the right group.
  const driverGroups = useMemo((): DriverRow[] => {
    const NO_DRIVER = '(No Driver Assigned)';
    // Map key: "id:<id>" for id-anchored groups, "name:<lowercased>"
    // for legacy-only groups. Keeps the two namespaces separate so a
    // driverName that happens to match the canonical name of an
    // un-related id-anchored row doesn't accidentally merge.
    const groups = new Map<string, { row: DriverRow; aliasSet: Set<string> }>();

    const canonicalName = (d: typeof drivers[number]) =>
      `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim() || d.name || '';

    const addEvent = (key: string, row: Omit<DriverRow, 'loads'>, ev: CalendarEvent | null) => {
      const existing = groups.get(key);
      if (existing) {
        if (ev) existing.row.loads.push(ev);
        // Track any name variant that landed in this group.
        const nm = ev?.driverName?.trim();
        if (nm) existing.aliasSet.add(nm);
        return;
      }
      const aliasSet = new Set<string>(row.aliases);
      const nm = ev?.driverName?.trim();
      if (nm) aliasSet.add(nm);
      const newRow: DriverRow = {
        ...row,
        loads: ev ? [ev] : [],
        aliases: [...aliasSet],
      };
      groups.set(key, { row: newRow, aliasSet });
    };

    for (const e of weekEvents) {
      // Prefer id-based match: rename-resistant.
      const driverRec = e.driverId != null
        ? drivers.find(d => d.id === e.driverId)
        : undefined;
      if (driverRec) {
        const display = canonicalName(driverRec);
        const aliases = new Set<string>();
        if (display) aliases.add(display);
        if (driverRec.name) aliases.add(driverRec.name);
        addEvent(`id:${driverRec.id}`, {
          driverName: display || (e.driverName?.trim() ?? NO_DRIVER),
          aliases: [...aliases],
          driverId: driverRec.id,
        }, e);
        continue;
      }
      // No id (or no matching record) — fall back to the load's
      // stored driverName. Legacy rows with the same name still
      // collapse together here.
      const name = e.driverName?.trim() || '';
      if (!name) {
        addEvent(`name:${NO_DRIVER}`, { driverName: NO_DRIVER, aliases: [NO_DRIVER] }, e);
      } else {
        addEvent(`name:${name.toLowerCase()}`, { driverName: name, aliases: [name] }, e);
      }
    }

    // Pull in any driver records that have adjustments this week
    // but no loads — keeps deferred carry-ins from disappearing.
    // Match by any alias the record's canonical or legacy name
    // would generate.
    for (const adjName of adjDriverNames) {
      if (!adjName) continue;
      const lower = adjName.toLowerCase();
      // Already represented by some group's alias set?
      let matched = false;
      for (const g of groups.values()) {
        if (g.aliasSet.has(adjName) ||
            [...g.aliasSet].some(a => a.toLowerCase() === lower)) {
          g.aliasSet.add(adjName);
          g.row.aliases = [...g.aliasSet];
          matched = true;
          break;
        }
      }
      if (matched) continue;
      // Try to attach to a driver record by name (handles the case
      // where loads weren't run this week but the driver exists).
      const rec = drivers.find(d => {
        const can = canonicalName(d).toLowerCase();
        return can === lower || (d.name ?? '').toLowerCase() === lower;
      });
      if (rec) {
        const display = canonicalName(rec);
        addEvent(`id:${rec.id}`, {
          driverName: display || adjName,
          aliases: [display || adjName, rec.name ?? '', adjName].filter(Boolean) as string[],
          driverId: rec.id,
        }, null);
      } else {
        addEvent(`name:${lower}`, { driverName: adjName, aliases: [adjName] }, null);
      }
    }

    const rows: DriverRow[] = [...groups.values()].map(g => ({
      ...g.row,
      loads: [...g.row.loads].sort((a, b) => a.start.localeCompare(b.start)),
    }));

    rows.sort((a, b) => {
      const aNo = a.driverName === NO_DRIVER;
      const bNo = b.driverName === NO_DRIVER;
      if (aNo && !bNo) return 1;
      if (!aNo && bNo) return -1;
      return a.driverName.localeCompare(b.driverName);
    });
    return rows;
  }, [weekEvents, adjDriverNames, drivers]);

  // Total driver pay across every leg — each driver gets paid for
  // their leg, so summing every event's driverPay is the correct
  // "what did we pay drivers this week" answer.
  const totalPay = driverGroups.reduce((s, g) => s + g.loads.reduce((ss, l) => ss + (l.driverPay ?? 0), 0), 0);
  // Total LOADS and Total REVENUE — both come from the canonical
  // /v1/reports/loads server endpoint (weekLoadSummaries) so this
  // tile agrees with the Dashboard's Total Revenue card exactly. One
  // server, one filter, one sum.
  //
  // Revenue = rate-con price + billable accessorials. Same shape as
  // LoadsReport's "Total" column footer — accessorials that the
  // dispatcher flagged as billable to the broker are part of the
  // revenue we booked. Non-billable accessorials (lumper reimbursements,
  // driver per-diem) are excluded by design.
  //
  // While the request is in flight we fall back to the events-store
  // estimate so the tile doesn't render blank on the first paint —
  // same pattern Dashboard's KPI useMemo uses.
  const totalLoads = useMemo(() => {
    if (weekLoadSummaries) return weekLoadSummaries.length;
    const seen = new Set<string>();
    for (const ev of weekEvents) seen.add(ev.loadId ?? ev.id);
    return seen.size;
  }, [weekLoadSummaries, weekEvents]);
  const totalRevenue = useMemo(() => {
    if (weekLoadSummaries) {
      // Total billable (linehaul + billable accessorials), maintained
      // by the loads_compute_total_billable trigger. Falls back to
      // inline math for any legacy row.
      return weekLoadSummaries.reduce((s, l) => {
        if (l.totalBillable != null) return s + l.totalBillable;
        const accessorials = (l.accessorials ?? [])
          .reduce((acc, a) => acc + (a.billable ? (a.amount ?? 0) : 0), 0);
        return s + (l.loadPrice ?? 0) + accessorials;
      }, 0);
    }
    // Fallback: events-store, dedupe by loadId, take max loadPrice.
    // Skip accessorials in fallback — events store doesn't carry the
    // billable flag uniformly; the tile only flashes this value for
    // a fraction of a second before snapping to the canonical
    // weekLoadSummaries number above.
    const byLoad = new Map<string, number>();
    for (const ev of weekEvents) {
      const key = ev.loadId ?? ev.id;
      const cur = byLoad.get(key) ?? 0;
      byLoad.set(key, Math.max(cur, ev.loadPrice ?? 0));
    }
    let total = 0;
    for (const v of byLoad.values()) total += v;
    return total;
  }, [weekLoadSummaries, weekEvents]);
  // Payroll as % of revenue — the headline labor-cost ratio. Null
  // when revenue is zero (we'd be dividing by 0) so the UI can render
  // an em-dash instead of "Infinity%".
  const payrollPctOfRevenue = totalRevenue > 0
    ? (totalPay / totalRevenue) * 100
    : null;

  const orgName    = organization?.name    ?? 'My Organization';
  const orgLogoUrl = organization?.imageUrl;
  const weekLabel  = weekOptions[weekIdx].label;

  return (
    <AppShell title="Payroll" icon={Users}>
      <DataLoader />

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto p-6 relative">
        {fetching && (
          <div className="absolute inset-0 z-10 flex items-start justify-end p-4 pointer-events-none">
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', boxShadow: 'var(--shadow-1)', color: 'var(--gc-text-2)' }}
            >
              <Loader2 size={13} className="animate-spin" style={{ color: 'var(--gc-blue)' }} />
              Loading data…
            </div>
          </div>
        )}

        <div className="w-full space-y-5">

          {/* Title row */}
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-[32px] font-semibold" style={{ color: 'var(--gc-text-1)', letterSpacing: '-0.5px' }}>
                Payroll
              </h2>
              <p className="text-sm mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                {fmtDateFull(sat)} – {fmtDateFull(fri)}
              </p>
            </div>
            <WeekSelector options={weekOptions} selectedIdx={weekIdx} onChange={setWeekIdx} />
          </div>

          {/* Summary strip */}
          {driverGroups.length > 0 && (
            <div
              className="flex items-center gap-8 px-5 py-4 rounded-xl"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)' }}
            >
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: 'var(--gc-text-3)' }}>
                  Total Driver Pay
                </div>
                <div className="text-[22px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                  {fmtMoney(totalPay)}
                </div>
              </div>
              <div style={{ width: 1, height: 40, background: 'var(--gc-border)' }} />
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: 'var(--gc-text-3)' }}>
                  Total Revenue
                </div>
                <div className="text-[22px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                  {fmtMoney(totalRevenue)}
                </div>
              </div>
              <div style={{ width: 1, height: 40, background: 'var(--gc-border)' }} />
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: 'var(--gc-text-3)' }}>
                  Payroll % of Revenue
                </div>
                <div
                  className="text-[22px] font-semibold"
                  // Color tints the headline figure when the ratio
                  // crosses notable bands so the dispatcher gets an
                  // at-a-glance read: green under 30% (healthy), neutral
                  // 30–40%, amber 40–50%, red above 50% (loss-leader
                  // territory). Numbers are conservative — tighten the
                  // thresholds for your fleet if needed.
                  style={{
                    color:
                      payrollPctOfRevenue == null   ? 'var(--gc-text-3)' :
                      payrollPctOfRevenue < 30       ? '#1e8e3e' :
                      payrollPctOfRevenue < 40       ? 'var(--gc-text-1)' :
                      payrollPctOfRevenue < 50       ? '#b85c00' :
                                                       '#d93025',
                  }}
                >
                  {payrollPctOfRevenue == null
                    ? '—'
                    : `${payrollPctOfRevenue.toFixed(1)}%`}
                </div>
              </div>
              <div style={{ width: 1, height: 40, background: 'var(--gc-border)' }} />
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: 'var(--gc-text-3)' }}>
                  Drivers
                </div>
                <div className="text-[22px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                  {driverGroups.filter(g => g.driverName !== '(No Driver Assigned)').length}
                </div>
              </div>
              <div style={{ width: 1, height: 40, background: 'var(--gc-border)' }} />
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: 'var(--gc-text-3)' }}>
                  Loads
                </div>
                <div className="text-[22px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                  {totalLoads}
                </div>
              </div>
            </div>
          )}

          {/* Driver cards */}
          {driverGroups.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <AlertCircle size={44} style={{ color: 'var(--gc-border)', marginBottom: 16 }} />
              <p className="text-base font-medium" style={{ color: 'var(--gc-text-2)' }}>
                No loads for this week
              </p>
              <p className="text-sm mt-1" style={{ color: 'var(--gc-text-3)' }}>
                Try selecting a different week, or add loads in the calendar.
              </p>
              <Link
                href="/calendar"
                className="mt-5 px-5 py-2 rounded-lg text-sm font-medium"
                style={{ background: 'var(--gc-blue)', color: 'white' }}
              >
                Go to Calendar
              </Link>
            </div>
          ) : (
            driverGroups.map(row => (
              <DriverCard
                key={row.driverName}
                row={row}
                assets={assets}
                drivers={drivers}
                orgId={orgId ?? ''}
                weekStart={sat.toISOString().split('T')[0]}
                orgName={orgName}
                orgLogoUrl={orgLogoUrl}
                weekLabel={weekLabel}
                sat={sat}
                fri={fri}
              />
            ))
          )}

        </div>
      </div>
    </AppShell>
  );
}
