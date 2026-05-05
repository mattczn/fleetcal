'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { Search, ChevronDown, X, Download, FileSpreadsheet, Loader2, Settings, Filter } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { railway } from '@/lib/railway';
import type { CalendarEvent } from '@/lib/types';

// ── Column catalog ────────────────────────────────────────────────────────────

interface ColumnDef {
  id:    string;
  label: string;
  /** Render cell from a load. Returns string | number for export. */
  get:   (load: CalendarEvent, ctx: ColumnCtx) => string | number;
  align?: 'right';
}

interface ColumnCtx {
  customers: { id: string; name: string }[];
  drivers:   { name: string }[];
  assets:    { id: number; name: string; unit?: string }[];
}

const STATUS_LABEL: Record<string, string> = {
  scheduled: 'Scheduled', assigned: 'Assigned', dispatched: 'Dispatched', en_route: 'En Route',
  picked_up: 'Picked Up', delivered: 'Delivered', cancelled: 'Cancelled', tonu: 'TONU', problem: 'Problem',
};

function fmtDate(iso: string | undefined): string {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function billableAccessorials(load: CalendarEvent): number {
  return (load.accessorials ?? []).reduce((sum, a) => sum + (a.billable ? (a.amount ?? 0) : 0), 0);
}

function refStr(load: CalendarEvent): string {
  return (load.refNums ?? []).map(r => r.label ? `${r.label}: ${r.value}` : r.value).join(' | ');
}

function firstStop(load: CalendarEvent, type: 'pickup' | 'delivery'): string {
  const stops = load.stops ?? [];
  const stop = type === 'pickup'
    ? (stops.find(s => s.type === 'pickup') ?? stops[0])
    : ([...stops].reverse().find(s => s.type === 'delivery' || s.type === 'drop' || s.type === 'drop_hook') ?? stops[stops.length - 1]);
  if (!stop) return '';
  return stop.facilityName ?? stop.city ?? stop.address ?? '';
}

const COLUMNS: ColumnDef[] = [
  { id: 'pickupDate',   label: 'Pickup Date', get: (l) => fmtDate(l.start) },
  { id: 'loadNum',      label: 'Load #',      get: (l) => l.loadNum ?? '' },
  { id: 'internalId',   label: 'Internal ID', get: (l) => l.internalLoadId ?? '' },
  { id: 'customer',     label: 'Customer',    get: (l, ctx) => ctx.customers.find(c => c.id === l.customerId)?.name ?? l.broker ?? '' },
  { id: 'broker',       label: 'Broker',      get: (l) => l.broker ?? '' },
  { id: 'title',        label: 'Title',       get: (l) => l.title ?? '' },
  { id: 'driver',       label: 'Driver',      get: (l) => l.driverName ?? '' },
  { id: 'asset',        label: 'Asset',       get: (l, ctx) => {
    const a = ctx.assets.find(x => x.id === l.assetId);
    return a ? (a.unit ? `${a.name} #${a.unit}` : a.name) : '';
  }},
  { id: 'trailerType',  label: 'Trailer Type', get: (l) => l.trailerType ?? '' },
  { id: 'status',       label: 'Status',      get: (l) => STATUS_LABEL[l.status ?? 'scheduled'] ?? l.status ?? '' },
  { id: 'priority',     label: 'Priority',    get: (l) => l.priority ? 'Yes' : '' },
  { id: 'pickup',       label: 'Pickup',      get: (l) => firstStop(l, 'pickup') },
  { id: 'delivery',     label: 'Delivery',    get: (l) => firstStop(l, 'delivery') },
  { id: 'commodity',    label: 'Commodity',   get: (l) => l.commodity ?? '' },
  { id: 'weight',       label: 'Weight (lbs)', align: 'right', get: (l) => l.weight ?? '' },
  { id: 'loadPrice',    label: 'Load Price', align: 'right',   get: (l) => l.loadPrice ?? '' },
  { id: 'driverPay',    label: 'Driver Pay', align: 'right',   get: (l) => l.driverPay ?? '' },
  { id: 'accessorials', label: 'Accessorials', align: 'right', get: (l) => billableAccessorials(l) || '' },
  { id: 'refNums',      label: 'References',  get: (l) => refStr(l) },
  { id: 'dispatcher',   label: 'Dispatcher',  get: (l) => l.dispatcher ?? '' },
  { id: 'notes',        label: 'Notes',       get: (l) => l.notes ?? '' },
];

const DEFAULT_VISIBLE = ['pickupDate', 'loadNum', 'customer', 'driver', 'asset', 'status', 'loadPrice', 'driverPay'];

// ── Multi-select dropdown ─────────────────────────────────────────────────────

interface MultiSelectProps<T> {
  label:    string;
  options:  T[];
  optionId: (o: T) => string;
  optionLabel: (o: T) => string;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  width?:   number;
}

function MultiSelect<T>({ label, options, optionId, optionLabel, selected, onChange, width = 200 }: MultiSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const filtered = search
    ? options.filter(o => optionLabel(o).toLowerCase().includes(search.toLowerCase()))
    : options;

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next);
  };

  const summary = selected.size === 0
    ? `All ${label.toLowerCase()}`
    : selected.size === 1
      ? optionLabel(options.find(o => optionId(o) === [...selected][0])!) ?? '1 selected'
      : `${selected.size} selected`;

  return (
    <div ref={ref} style={{ position: 'relative', width }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
          fontSize: 13, padding: '7px 10px', borderRadius: 8,
          border: '1px solid var(--gc-border)', background: 'var(--gc-surface)',
          color: 'var(--gc-text-1)', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selected.size === 0 ? 'var(--gc-text-3)' : 'var(--gc-text-1)' }}>
          {summary}
        </span>
        <ChevronDown size={13} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 20,
          background: 'var(--gc-surface)', border: '1px solid var(--gc-border)',
          borderRadius: 8, boxShadow: 'var(--shadow-3)', maxHeight: 320, display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ padding: 8, borderBottom: '1px solid var(--gc-border-light)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', background: 'var(--gc-bg)', borderRadius: 6 }}>
              <Search size={12} style={{ color: 'var(--gc-text-3)' }} />
              <input
                autoFocus
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={`Search ${label.toLowerCase()}…`}
                style={{ flex: 1, fontSize: 12, border: 'none', background: 'transparent', outline: 'none', color: 'var(--gc-text-1)' }}
              />
            </div>
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {filtered.length === 0 ? (
              <div style={{ padding: 12, fontSize: 12, color: 'var(--gc-text-3)', textAlign: 'center' }}>
                No matches
              </div>
            ) : filtered.map(o => {
              const id = optionId(o);
              const checked = selected.has(id);
              return (
                <label key={id} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
                  fontSize: 13, cursor: 'pointer',
                  background: checked ? 'var(--gc-blue-light)' : 'transparent',
                  color: 'var(--gc-text-1)',
                }}
                onMouseEnter={e => { if (!checked) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                onMouseLeave={e => { if (!checked) e.currentTarget.style.background = 'transparent'; }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(id)}
                    style={{ cursor: 'pointer' }}
                  />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {optionLabel(o)}
                  </span>
                </label>
              );
            })}
          </div>
          {selected.size > 0 && (
            <button
              type="button"
              onClick={() => { onChange(new Set()); }}
              style={{
                padding: '8px 12px', fontSize: 11, fontWeight: 600, color: 'var(--gc-text-3)',
                background: 'var(--gc-bg)', border: 'none', borderTop: '1px solid var(--gc-border-light)',
                cursor: 'pointer', textAlign: 'left',
              }}>
              Clear selection
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main report component ─────────────────────────────────────────────────────

export default function LoadsReport() {
  const { customers, drivers, assets } = useCalendarStore();

  // Date range — default last 30 days
  const today = new Date();
  const monthAgo = new Date(today); monthAgo.setDate(today.getDate() - 30);
  const fmtDateInput = (d: Date) => d.toISOString().slice(0, 10);
  const [from, setFrom] = useState(fmtDateInput(monthAgo));
  const [to,   setTo]   = useState(fmtDateInput(today));

  // Multi-select filters (all = empty set)
  const [selectedCustomers, setSelectedCustomers] = useState<Set<string>>(new Set());
  const [selectedDrivers,   setSelectedDrivers]   = useState<Set<string>>(new Set());
  const [selectedAssets,    setSelectedAssets]    = useState<Set<string>>(new Set());

  // Results
  const [loads,     setLoads]     = useState<CalendarEvent[] | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  // Column visibility
  const [visible, setVisible] = useState<Set<string>>(() => new Set(DEFAULT_VISIBLE));
  const [showColumnPicker, setShowColumnPicker] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = localStorage.getItem('loadsReport.columns');
      if (stored) setVisible(new Set(JSON.parse(stored)));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('loadsReport.columns', JSON.stringify([...visible]));
  }, [visible]);

  // Distinct driver names from the loaded events as the picker options.
  // (Drivers table ids don't always match driverName text, so name-based
  // multi-select is the most reliable and matches what users actually see.)
  const driverOptions = useMemo(() => {
    const names = new Set<string>();
    drivers.forEach(d => { if (d.name) names.add(d.name); });
    return [...names].sort().map(name => ({ name }));
  }, [drivers]);

  const ctx = useMemo<ColumnCtx>(() => ({ customers, drivers: driverOptions, assets }), [customers, driverOptions, assets]);

  const run = async () => {
    if (!from || !to || from > to) {
      setError('Pick a valid date range');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const { loads: fetched } = await railway.listLoads({
        from: `${from}T00:00`,
        to:   `${to}T23:59`,
      });
      setLoads(fetched);
    } catch (err) {
      console.error('LoadsReport.run:', err);
      setError(err instanceof Error ? err.message : 'Failed to load report');
      setLoads([]);
    } finally {
      setLoading(false);
    }
  };

  // Apply client-side multi-select filters
  const rows = useMemo(() => {
    if (!loads) return [];
    return loads.filter(load => {
      if (selectedCustomers.size > 0 && !selectedCustomers.has(load.customerId ?? '')) return false;
      if (selectedDrivers.size   > 0 && !selectedDrivers.has(load.driverName ?? '')) return false;
      if (selectedAssets.size    > 0 && !selectedAssets.has(String(load.assetId))) return false;
      return true;
    });
  }, [loads, selectedCustomers, selectedDrivers, selectedAssets]);

  const visibleColumns = COLUMNS.filter(c => visible.has(c.id));

  // Totals (numeric columns only)
  const totals = useMemo(() => {
    const sums: Record<string, number> = {};
    for (const col of visibleColumns) {
      if (col.id === 'loadPrice' || col.id === 'driverPay' || col.id === 'accessorials' || col.id === 'weight') {
        sums[col.id] = rows.reduce((acc, r) => acc + (Number(col.get(r, ctx)) || 0), 0);
      }
    }
    return sums;
  }, [rows, visibleColumns, ctx]);

  // ── Export helpers ──────────────────────────────────────────────────────────

  const dateStamp = `${from}_to_${to}`;

  const exportData = (format: 'csv' | 'xls') => {
    const headers = visibleColumns.map(c => c.label);
    const data = rows.map(r => visibleColumns.map(c => c.get(r, ctx)));

    if (format === 'csv') {
      const esc = (v: string | number) => {
        const s = String(v);
        return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const content = [headers, ...data].map(row => row.map(esc).join(',')).join('\r\n');
      trigger(new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8;' }), `loads-report-${dateStamp}.csv`);
    } else {
      import('xlsx').then(XLSX => {
        const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
        ws['!freeze'] = { xSplit: 0, ySplit: 1 };
        ws['!cols'] = headers.map((h, ci) => {
          const maxLen = Math.max(h.length, ...data.map(r => String(r[ci] ?? '').length));
          return { wch: Math.min(maxLen + 2, 42) };
        });
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Loads');
        XLSX.writeFile(wb, `loads-report-${dateStamp}.xlsx`);
      });
    }
  };

  const trigger = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  const fmt$ = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ marginTop: 24, background: 'var(--gc-surface)', borderRadius: 12, border: '1px solid var(--gc-border)', overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--gc-border-light)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Filter size={14} style={{ color: 'var(--gc-text-3)' }} />
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--gc-text-1)' }}>Loads Report</span>
          <span style={{ fontSize: 12, color: 'var(--gc-text-3)' }}>
            Pick filters → run → export
          </span>
        </div>
      </div>

      {/* Filter row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '14px 20px', alignItems: 'flex-end', background: 'var(--gc-bg)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--gc-text-3)' }}>From</label>
          <input
            type="date"
            value={from}
            onChange={e => setFrom(e.target.value)}
            style={{ fontSize: 13, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' }}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--gc-text-3)' }}>To</label>
          <input
            type="date"
            value={to}
            onChange={e => setTo(e.target.value)}
            style={{ fontSize: 13, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' }}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--gc-text-3)' }}>Customer</label>
          <MultiSelect
            label="customers"
            options={customers}
            optionId={c => c.id}
            optionLabel={c => c.name}
            selected={selectedCustomers}
            onChange={setSelectedCustomers}
            width={220}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--gc-text-3)' }}>Driver</label>
          <MultiSelect
            label="drivers"
            options={driverOptions}
            optionId={d => d.name}
            optionLabel={d => d.name}
            selected={selectedDrivers}
            onChange={setSelectedDrivers}
            width={200}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--gc-text-3)' }}>Asset</label>
          <MultiSelect
            label="assets"
            options={assets.filter(a => !a.hidden)}
            optionId={a => String(a.id)}
            optionLabel={a => a.unit ? `${a.name} #${a.unit}` : a.name}
            selected={selectedAssets}
            onChange={setSelectedAssets}
            width={200}
          />
        </div>
        <button
          type="button"
          onClick={run}
          disabled={loading}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 13, fontWeight: 700, padding: '8px 16px', borderRadius: 8,
            border: 'none', background: '#1a73e8', color: '#fff', cursor: loading ? 'default' : 'pointer',
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <Filter size={13} />}
          Run Report
        </button>
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: '10px 20px', fontSize: 12, color: '#b91c1c', background: '#fef2f2', borderTop: '1px solid #fecaca' }}>
          {error}
        </div>
      )}

      {/* Results */}
      {loads !== null && !loading && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px', borderTop: '1px solid var(--gc-border-light)' }}>
            <div style={{ fontSize: 12, color: 'var(--gc-text-2)' }}>
              <strong style={{ color: 'var(--gc-text-1)' }}>{rows.length}</strong>
              {' load'}{rows.length === 1 ? '' : 's'}
              {totals.loadPrice ? <> · Revenue <strong style={{ color: 'var(--gc-text-1)' }}>{fmt$(totals.loadPrice)}</strong></> : null}
              {totals.driverPay ? <> · Driver Pay <strong style={{ color: 'var(--gc-text-1)' }}>{fmt$(totals.driverPay)}</strong></> : null}
              {totals.accessorials ? <> · Accessorials <strong style={{ color: 'var(--gc-text-1)' }}>{fmt$(totals.accessorials)}</strong></> : null}
            </div>
            <div style={{ display: 'flex', gap: 6, position: 'relative' }}>
              <button
                type="button"
                onClick={() => setShowColumnPicker(p => !p)}
                style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-2)', cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <Settings size={12} />
                Columns ({visible.size})
              </button>
              <button
                type="button"
                onClick={() => exportData('csv')}
                disabled={rows.length === 0}
                style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-2)', cursor: rows.length === 0 ? 'default' : 'pointer', opacity: rows.length === 0 ? 0.4 : 1 }}
                onMouseEnter={e => { if (rows.length) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <Download size={12} />
                CSV
              </button>
              <button
                type="button"
                onClick={() => exportData('xls')}
                disabled={rows.length === 0}
                style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-2)', cursor: rows.length === 0 ? 'default' : 'pointer', opacity: rows.length === 0 ? 0.4 : 1 }}
                onMouseEnter={e => { if (rows.length) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <FileSpreadsheet size={12} />
                Excel
              </button>

              {showColumnPicker && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 30,
                  background: 'var(--gc-surface)', border: '1px solid var(--gc-border)',
                  borderRadius: 8, boxShadow: 'var(--shadow-3)', width: 240, maxHeight: 360, overflowY: 'auto',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--gc-border-light)' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--gc-text-3)' }}>Columns</span>
                    <button
                      type="button"
                      onClick={() => setShowColumnPicker(false)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--gc-text-3)' }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                  {COLUMNS.map(col => (
                    <label key={col.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 13, cursor: 'pointer', color: 'var(--gc-text-1)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <input
                        type="checkbox"
                        checked={visible.has(col.id)}
                        onChange={() => {
                          const next = new Set(visible);
                          if (next.has(col.id)) next.delete(col.id); else next.add(col.id);
                          setVisible(next);
                        }}
                      />
                      {col.label}
                    </label>
                  ))}
                  <div style={{ display: 'flex', gap: 6, padding: 8, borderTop: '1px solid var(--gc-border-light)' }}>
                    <button
                      type="button"
                      onClick={() => setVisible(new Set(COLUMNS.map(c => c.id)))}
                      style={{ flex: 1, fontSize: 11, padding: '5px 8px', borderRadius: 5, border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-2)', cursor: 'pointer' }}>
                      All
                    </button>
                    <button
                      type="button"
                      onClick={() => setVisible(new Set(DEFAULT_VISIBLE))}
                      style={{ flex: 1, fontSize: 11, padding: '5px 8px', borderRadius: 5, border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-2)', cursor: 'pointer' }}>
                      Defaults
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Table */}
          {rows.length === 0 ? (
            <div style={{ padding: '40px 20px', textAlign: 'center', fontSize: 13, color: 'var(--gc-text-3)' }}>
              No loads match these filters.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--gc-bg)' }}>
                    {visibleColumns.map(col => (
                      <th
                        key={col.id}
                        style={{
                          textAlign: col.align === 'right' ? 'right' : 'left',
                          padding: '10px 12px', fontWeight: 700, fontSize: 10,
                          textTransform: 'uppercase', letterSpacing: '0.04em',
                          color: 'var(--gc-text-3)', borderBottom: '1px solid var(--gc-border-light)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(load => (
                    <tr key={load.id} style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                      {visibleColumns.map(col => {
                        const v = col.get(load, ctx);
                        const isMoney = col.id === 'loadPrice' || col.id === 'driverPay' || col.id === 'accessorials';
                        const display = (typeof v === 'number' && isMoney && v > 0)
                          ? fmt$(v)
                          : (typeof v === 'number' ? v.toLocaleString() : v);
                        return (
                          <td
                            key={col.id}
                            style={{
                              padding: '10px 12px',
                              textAlign: col.align === 'right' ? 'right' : 'left',
                              color: 'var(--gc-text-1)',
                              maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}
                            title={String(v)}
                          >
                            {display || <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Initial empty hint */}
      {loads === null && !loading && !error && (
        <div style={{ padding: '40px 20px', textAlign: 'center', fontSize: 13, color: 'var(--gc-text-3)' }}>
          Choose filters above and click <strong style={{ color: 'var(--gc-text-2)' }}>Run Report</strong> to load matching loads.
        </div>
      )}
    </div>
  );
}
