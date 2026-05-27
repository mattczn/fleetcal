/**
 * OpsTable — the reusable Motive-style ops table.
 *
 * Wraps @tanstack/react-table (headless mode) so every screen that
 * shows a list of records uses the same chrome:
 *   • whiter surface than the page background
 *   • sticky 11px uppercase header
 *   • hairline row dividers
 *   • subtle gray hover
 *   • per-table density (compact ~36px or comfortable ~52px)
 *   • filter chip row (search + select dropdowns) above the header
 *   • sort selector pinned right
 *   • pagination footer with "showing X–Y of Z"
 *
 * Why a wrapper instead of using TanStack's components directly:
 *   TanStack ships *only* hooks and types — there's no opinionated
 *   markup. That's exactly what we want, so OpsTable becomes the
 *   one place that owns visual style. Any future table just declares
 *   columns + filters and inherits the look. When the design changes,
 *   we change it once here.
 *
 * Usage:
 *
 *   const columns: OpsColumn<MyRow>[] = [
 *     { key: 'date',   header: 'Date',   render: r => <DateCell iso={r.date} />, width: 110, sortable: true },
 *     { key: 'driver', header: 'Driver', render: r => r.driverName },
 *     { key: 'total',  header: 'Total',  render: r => `$${r.total.toFixed(2)}`, align: 'right' },
 *   ];
 *   const filters: OpsFilter<MyRow>[] = [
 *     { kind: 'search', placeholder: 'Search driver or location…',
 *       match: (r, q) => r.driverName.toLowerCase().includes(q) },
 *     { kind: 'select', key: 'status', label: 'Status',
 *       options: [{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }],
 *       predicate: (r, v) => r.status === v },
 *   ];
 *   <OpsTable
 *     columns={columns}
 *     filters={filters}
 *     data={rows}
 *     loading={loading}
 *     onRowClick={r => setOpen(r.id)}
 *     activeRowId={openId}
 *     rowKey={r => r.id}
 *     emptyLabel="No records match the current filters."
 *     defaultSort={{ key: 'date', dir: 'desc' }}
 *   />
 */

'use client';

import {
  useMemo, useState, useRef, useEffect, type ReactNode,
} from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  useReactTable,
  type ColumnDef as TanColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { ChevronDown, Search as SearchIcon, ArrowUp, ArrowDown, X } from 'lucide-react';

// ── Public types ──────────────────────────────────────────────────────

export type OpsColumn<T> = {
  /** Stable key — used as the sort key and React key. */
  key: string;
  header: string;
  /** Cell renderer. Defaults to (row as any)[key]. */
  render?: (row: T) => ReactNode;
  /** Tiny gray subline below the cell (Motive's "MMY" subtitle). */
  subRender?: (row: T) => ReactNode;
  /** Explicit width — number = px, string = CSS dimension or "1fr". */
  width?: number | string;
  align?: 'left' | 'right';
  sortable?: boolean;
  /** Comparator value when the cell renders something non-comparable. */
  sortValue?: (row: T) => string | number;
  /** Optional leading dot — color resolved per-row. Motive uses
   *  this for the per-truck status indicator (gray / amber / green). */
  leadingDot?: (row: T) => { color: string; tooltip?: string };
};

export type OpsFilter<T> =
  | {
      kind: 'search';
      placeholder?: string;
      /** Width in px. Defaults to 280. */
      width?: number;
      /** Called per row, lower-cased query. Caller is responsible
       *  for which fields it searches against. */
      match: (row: T, q: string) => boolean;
    }
  | {
      kind: 'select';
      /** Stable key — used as React key and the value-state map key. */
      key: string;
      label: string;
      options: ReadonlyArray<{ value: string; label: string; count?: number }>;
      predicate: (row: T, value: string) => boolean;
      /** Default selected value (defaults to '' = no filter). */
      defaultValue?: string;
    };

export type OpsTableDensity = 'compact' | 'comfortable';

export interface OpsTableProps<T> {
  columns: OpsColumn<T>[];
  data: T[];
  loading?: boolean;
  filters?: OpsFilter<T>[];
  /** Stable identity for each row — used as React key and to compare
   *  the active-row highlight. */
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Highlights the row whose rowKey === activeRowId. */
  activeRowId?: string | null;
  emptyLabel?: string;
  density?: OpsTableDensity;
  pageSize?: number;
  defaultSort?: { key: string; dir: 'asc' | 'desc' };
  /** Renders to the right of the filter chip row. Use for entity-
   *  specific buttons ("New report", "Export", etc.). */
  toolbarRight?: ReactNode;
  /** Singular noun for the count footer. "report" → "12 reports". */
  countLabel?: string;
}

// ── Component ─────────────────────────────────────────────────────────

export function OpsTable<T>({
  columns,
  data,
  loading = false,
  filters = [],
  rowKey,
  onRowClick,
  activeRowId,
  emptyLabel = 'No records match the current filters.',
  density = 'comfortable',
  pageSize = 25,
  defaultSort,
  toolbarRight,
  countLabel = 'record',
}: OpsTableProps<T>) {
  // ── Filter state ───────────────────────────────────────────────────
  // Keyed by filter.key for select filters and '__search' for search.
  const [filterState, setFilterState] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of filters) {
      if (f.kind === 'select' && f.defaultValue) init[f.key] = f.defaultValue;
    }
    return init;
  });

  // ── Apply filters ──────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (filters.length === 0) return data;
    const q = (filterState.__search ?? '').trim().toLowerCase();
    return data.filter(row => {
      for (const f of filters) {
        if (f.kind === 'search') {
          if (q && !f.match(row, q)) return false;
        } else {
          const v = filterState[f.key];
          if (v && !f.predicate(row, v)) return false;
        }
      }
      return true;
    });
  }, [data, filters, filterState]);

  // ── TanStack column adapter ────────────────────────────────────────
  // We map our friendly OpsColumn shape onto TanStack's ColumnDef.
  // accessorFn returns the sort value (sortValue() if provided, else
  // the rendered cell flattened to a string); cell() renders our JSX.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tanColumns = useMemo<TanColumnDef<T, any>[]>(() => columns.map(col => ({
    id: col.key,
    accessorFn: (row: T) => {
      if (col.sortValue) return col.sortValue(row);
      // Best-effort: if there's no explicit sort value, sort by the
      // string the renderer would output. Works for plain values,
      // gracefully degrades for JSX (returns "[object Object]" which
      // sorts but uselessly — caller should pass sortValue then).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = (row as any)[col.key];
      return v == null ? '' : v;
    },
    enableSorting: col.sortable ?? false,
    header: col.header,
    cell: ({ row }) => {
      const r = row.original;
      const content = col.render ? col.render(r) : (() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const v = (r as any)[col.key];
        return v == null ? '—' : String(v);
      })();
      const sub = col.subRender ? col.subRender(r) : null;
      return (
        <div className="flex items-center gap-2.5 min-w-0">
          {col.leadingDot && (() => {
            const dot = col.leadingDot(r);
            return (
              <span
                className="shrink-0 rounded-full"
                title={dot.tooltip}
                style={{ width: 8, height: 8, background: dot.color, boxShadow: '0 0 0 2px #fff' }}
              />
            );
          })()}
          <div className="min-w-0 flex-1" style={{ textAlign: col.align ?? 'left' }}>
            <div className="truncate" style={{ color: 'var(--gc-text-1)', fontSize: 13, lineHeight: '18px' }}>
              {content}
            </div>
            {sub != null && sub !== '' && (
              <div className="truncate" style={{ color: 'var(--gc-text-3)', fontSize: 11, lineHeight: '15px', marginTop: 1 }}>
                {sub}
              </div>
            )}
          </div>
        </div>
      );
    },
  })), [columns]);

  // ── TanStack table instance ────────────────────────────────────────
  const [sorting, setSorting] = useState<SortingState>(
    defaultSort ? [{ id: defaultSort.key, desc: defaultSort.dir === 'desc' }] : [],
  );

  const table = useReactTable({
    data: filtered,
    columns: tanColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  // Reset to page 0 whenever the filter set yields fewer rows than the
  // current page is showing. Otherwise the dispatcher narrows a filter
  // and lands on an empty page 4.
  useEffect(() => { table.setPageIndex(0); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filterState]);

  const pageRows = table.getRowModel().rows;
  const total    = filtered.length;
  const pageIdx  = table.getState().pagination.pageIndex;
  const pageCnt  = Math.max(1, table.getPageCount());
  const from     = total === 0 ? 0 : pageIdx * pageSize + 1;
  const to       = Math.min(total, (pageIdx + 1) * pageSize);

  // ── Grid template — compose explicit widths + min-content auto ──
  // Columns without an explicit width share what's left equally.
  const gridTemplate = useMemo(() => columns.map(c => {
    if (c.width == null)             return 'minmax(0, 1fr)';
    if (typeof c.width === 'number') return `${c.width}px`;
    return c.width;
  }).join(' '), [columns]);

  const rowHeightPx = density === 'compact' ? 36 : 52;

  return (
    <div className="w-full">
      {/* ── Filter chip row ─────────────────────────────────────── */}
      {(filters.length > 0 || toolbarRight) && (
        <div className="flex items-center gap-2 flex-wrap mb-3">
          {filters.map(f => f.kind === 'search'
            ? (
              <SearchChip
                key="__search"
                value={filterState.__search ?? ''}
                onChange={v => setFilterState(s => ({ ...s, __search: v }))}
                placeholder={f.placeholder ?? 'Search…'}
                width={f.width ?? 280}
              />
            )
            : (
              <SelectChip
                key={f.key}
                label={f.label}
                value={filterState[f.key] ?? ''}
                onChange={v => setFilterState(s => ({ ...s, [f.key]: v }))}
                options={f.options}
              />
            ),
          )}
          {Object.values(filterState).some(v => v) && (
            <button
              onClick={() => setFilterState({})}
              className="text-[12px] font-semibold ml-1 transition-colors"
              style={{ color: 'var(--gc-blue)' }}>
              Clear filters
            </button>
          )}
          <div className="flex-1" />
          {toolbarRight}
        </div>
      )}

      {/* ── Table card ──────────────────────────────────────────── */}
      <div
        className="rounded-lg"
        style={{
          background: 'var(--gc-surface)',
          border: '1px solid var(--gc-border-light)',
        }}>
        {/* Header row */}
        <div
          className="grid items-center"
          style={{
            gridTemplateColumns: gridTemplate,
            background: 'var(--gc-surface)',
            borderBottom: '1px solid var(--gc-border-light)',
            padding: '0 16px',
            minHeight: 44,
            position: 'sticky',
            top: 0,
            zIndex: 1,
          }}>
          {table.getHeaderGroups()[0]?.headers.map(h => {
            const col   = columns.find(c => c.key === h.column.id);
            const dir   = h.column.getIsSorted();
            const canSort = h.column.getCanSort();
            return (
              <button
                key={h.id}
                type="button"
                disabled={!canSort}
                onClick={canSort ? () => h.column.toggleSorting() : undefined}
                className="flex items-center gap-1 select-none transition-colors"
                style={{
                  textAlign:  col?.align ?? 'left',
                  justifyContent: col?.align === 'right' ? 'flex-end' : 'flex-start',
                  color:      'var(--gc-text-3)',
                  fontSize:   11,
                  fontWeight: 600,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  cursor:     canSort ? 'pointer' : 'default',
                  background: 'transparent',
                  border:     'none',
                  padding:    '12px 0',
                  width:      '100%',
                }}
                onMouseEnter={e => { if (canSort) (e.currentTarget as HTMLElement).style.color = 'var(--gc-text-1)'; }}
                onMouseLeave={e => { if (canSort) (e.currentTarget as HTMLElement).style.color = 'var(--gc-text-3)'; }}>
                {flexRender(h.column.columnDef.header, h.getContext())}
                {canSort && dir && (
                  dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />
                )}
              </button>
            );
          })}
        </div>

        {/* Body */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>Loading…</div>
          </div>
        ) : pageRows.length === 0 ? (
          <div className="text-center py-16 text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
            {emptyLabel}
          </div>
        ) : (
          pageRows.map(r => {
            const original = r.original;
            const id = rowKey(original);
            const active = id === activeRowId;
            return (
              <div
                key={id}
                onClick={onRowClick ? () => onRowClick(original) : undefined}
                className="grid items-center transition-colors"
                style={{
                  gridTemplateColumns: gridTemplate,
                  padding: '0 16px',
                  minHeight: rowHeightPx,
                  borderTop: '1px solid #f1f3f4',
                  cursor: onRowClick ? 'pointer' : 'default',
                  background: active ? '#f1f5fb' : 'transparent',
                }}
                onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = '#f8f9fa'; }}
                onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
                {r.getVisibleCells().map(cell => (
                  <div key={cell.id} className="min-w-0 pr-3">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>

      {/* ── Footer ─────────────────────────────────────────────── */}
      {!loading && total > 0 && (
        <div className="flex items-center justify-between mt-3 text-[11px]"
          style={{ color: 'var(--gc-text-3)' }}>
          <span>
            Showing {from}–{to} of {total} {total === 1 ? countLabel : `${countLabel}s`}
          </span>
          {pageCnt > 1 && (
            <div className="flex items-center gap-2">
              <PagerButton
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}>‹ Prev</PagerButton>
              <span className="px-1 tabular-nums">
                Page {pageIdx + 1} of {pageCnt}
              </span>
              <PagerButton
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}>Next ›</PagerButton>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Filter chips ──────────────────────────────────────────────────────

function SearchChip({
  value, onChange, placeholder, width,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  width: number;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-md transition-colors"
      style={{
        background: 'var(--gc-surface)',
        border:     '1px solid var(--gc-border-light)',
        padding:    '7px 10px',
        width,
      }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--gc-text-3)')}
      onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--gc-border-light)')}>
      <SearchIcon size={14} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="bg-transparent outline-none flex-1 text-[13px]"
        style={{ color: 'var(--gc-text-1)' }}
      />
      {value && (
        <button
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="flex items-center justify-center rounded-full transition-colors"
          style={{ width: 16, height: 16, color: 'var(--gc-text-3)' }}>
          <X size={12} />
        </button>
      )}
    </div>
  );
}

function SelectChip({
  label, value, onChange, options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string; count?: number }>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Click-outside dismiss.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [open]);

  const selected = options.find(o => o.value === value);
  const display  = selected ? `${label}: ${selected.label}` : label;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 rounded-md transition-colors"
        style={{
          background: value ? 'var(--gc-blue-light)' : 'var(--gc-surface)',
          border:     `1px solid ${value ? 'var(--gc-blue)' : 'var(--gc-border-light)'}`,
          color:      value ? 'var(--gc-blue-text)' : 'var(--gc-text-2)',
          padding:    '7px 10px',
          fontSize:   13,
          fontWeight: 500,
        }}
        onMouseEnter={e => { if (!value) (e.currentTarget as HTMLElement).style.borderColor = 'var(--gc-text-3)'; }}
        onMouseLeave={e => { if (!value) (e.currentTarget as HTMLElement).style.borderColor = 'var(--gc-border-light)'; }}>
        {display}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div
          className="absolute mt-1 rounded-md overflow-hidden z-20"
          style={{
            background: 'var(--gc-surface)',
            border:     '1px solid var(--gc-border-light)',
            boxShadow:  '0 4px 12px rgba(0,0,0,0.08)',
            minWidth:   220,
            maxHeight:  320,
            overflowY:  'auto',
          }}>
          <DropdownItem
            active={value === ''}
            onClick={() => { onChange(''); setOpen(false); }}>
            <span style={{ color: 'var(--gc-text-3)' }}>All {label.toLowerCase()}s</span>
          </DropdownItem>
          {options.map(opt => (
            <DropdownItem
              key={opt.value}
              active={opt.value === value}
              onClick={() => { onChange(opt.value); setOpen(false); }}>
              <span className="flex-1">{opt.label}</span>
              {opt.count != null && (
                <span className="tabular-nums text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                  {opt.count}
                </span>
              )}
            </DropdownItem>
          ))}
        </div>
      )}
    </div>
  );
}

function DropdownItem({
  active, onClick, children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 w-full text-left transition-colors"
      style={{
        padding:    '8px 12px',
        fontSize:   13,
        background: active ? 'var(--gc-blue-light)' : 'transparent',
        color:      active ? 'var(--gc-blue-text)' : 'var(--gc-text-1)',
        fontWeight: active ? 600 : 400,
      }}
      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = '#f8f9fa'; }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
      {children}
    </button>
  );
}

function PagerButton({
  onClick, disabled, children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md transition-colors"
      style={{
        background: disabled ? 'transparent' : 'var(--gc-surface)',
        border:     `1px solid ${disabled ? 'var(--gc-border-light)' : 'var(--gc-border-light)'}`,
        color:      disabled ? 'var(--gc-text-3)' : 'var(--gc-text-2)',
        cursor:     disabled ? 'default' : 'pointer',
        padding:    '4px 10px',
        fontSize:   12,
        fontWeight: 600,
        opacity:    disabled ? 0.5 : 1,
      }}
      onMouseEnter={e => { if (!disabled) (e.currentTarget as HTMLElement).style.background = '#f8f9fa'; }}
      onMouseLeave={e => { if (!disabled) (e.currentTarget as HTMLElement).style.background = 'var(--gc-surface)'; }}>
      {children}
    </button>
  );
}

// ── Cell primitives (consumers can compose) ──────────────────────────

/** Single-line date with full timestamp on hover. */
export function OpsDate({ iso }: { iso: string }) {
  const d = new Date(iso);
  return (
    <span className="tabular-nums" title={d.toLocaleString()}>
      {d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
    </span>
  );
}

/** Linkified primary cell — Motive's blue underlined Vehicle ID feel. */
export function OpsPrimary({ children }: { children: ReactNode }) {
  return (
    <span className="font-semibold" style={{ color: 'var(--gc-blue-text)' }}>
      {children}
    </span>
  );
}

/** Pill — used for statuses, badges, etc. */
export function OpsPill({
  children, color = 'gray',
}: {
  children: ReactNode;
  color?: 'gray' | 'green' | 'amber' | 'red' | 'blue' | 'purple';
}) {
  const palette: Record<string, { bg: string; fg: string }> = {
    gray:   { bg: '#f3f4f6', fg: '#4b5563' },
    green:  { bg: '#dcfce7', fg: '#166534' },
    amber:  { bg: '#fef3c7', fg: '#92400e' },
    red:    { bg: '#fee2e2', fg: '#991b1b' },
    blue:   { bg: '#dbeafe', fg: '#1d4ed8' },
    purple: { bg: '#ede9fe', fg: '#6d28d9' },
  };
  const p = palette[color] ?? palette.gray;
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider whitespace-nowrap"
      style={{ background: p.bg, color: p.fg }}>
      {children}
    </span>
  );
}

/** Faded "—" / placeholder for empty cells. */
export function OpsMuted({ children = '—' }: { children?: ReactNode }) {
  return <span style={{ color: 'var(--gc-text-3)' }}>{children}</span>;
}
