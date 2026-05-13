/**
 * QueueTable — the standard table for /accounting and /closeout.
 *
 * One self-contained component that:
 *   - Fills its parent (flex-1 + min-h/min-w-0). The parent decides
 *     the outer padding. The table never overflows its container.
 *   - Scrolls internally in BOTH axes when content exceeds the
 *     viewport. Large screens → more visible. Small screens → scroll.
 *   - Sticky header rows (title + filter inputs) survive vertical
 *     scroll. They scroll horizontally with the body.
 *   - Click column title → toggle sort (asc → desc → off). Chevron
 *     indicates current direction.
 *   - Per-column filter inputs in their own header row. Text by
 *     default; pass `filter: { kind: 'multi', options }` for a
 *     multi-select.
 *   - Resizable column widths via drag handle on the right edge of
 *     each header cell.
 *   - Pagination footer pinned to the bottom of the container (not
 *     the viewport).
 *   - Right-edge "Columns" tab → popover for visibility + reorder.
 *
 * Rows are passed in pre-filtered, pre-sorted, pre-paginated. The
 * table just renders. Parent owns the state and the data
 * transformations (so the same hooks work for server-paginated
 * lists too).
 */
'use client';

import React, {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import {
  ArrowDown, ArrowUp, ArrowUpDown, Filter, X, Check, ChevronLeft, ChevronRight,
  Search, GripVertical, Eye, EyeOff,
} from 'lucide-react';

// ─── Types ──────────────────────────────────────────────────────────────

export type QueueSortDir = 'asc' | 'desc';
export interface QueueSortState {
  key: string | null;
  dir: QueueSortDir;
}

/** Filter value for a column. Text filters store a single string. Multi-
 *  select filters store the chosen option values. */
export type QueueFilterValue = string | string[];
export type QueueFilterState = Record<string, QueueFilterValue>;

export type QueueColumnFilter =
  | { kind: 'text' }
  | { kind: 'multi'; options: string[] };

export interface QueueColumn<R> {
  key: string;
  label: string;
  /** Initial width in px. Resizable from the header. */
  width: number;
  minWidth?: number;
  align?: 'left' | 'right' | 'center';
  sortable?: boolean;
  filter?: QueueColumnFilter;
  /** Body cell renderer. */
  render: (row: R) => React.ReactNode;
  /** Optional: custom value for sort comparison when render output
   *  isn't a plain string/number. */
  sortValue?: (row: R) => string | number | null | undefined;
  /** Optional: value used for matching when a text filter is typed.
   *  Defaults to whatever sortValue returns, else String(render). */
  filterValue?: (row: R) => string;
  /** When true, column is not togglable in the Columns panel. */
  pinned?: boolean;
  /** When true, the column is sticky-left during horizontal scroll.
   *  Multiple pinLeft columns stack from the left edge. Selection
   *  checkbox (when `selectable`) is implicitly pinned at the
   *  leftmost position. */
  pinLeft?: boolean;
  /** Whether to hide the column by default. User can re-enable via
   *  the Columns panel. */
  hiddenByDefault?: boolean;
  /** Optional className for body cells in this column. */
  cellClassName?: string;
}

export interface QueueTableProps<R> {
  rows: R[];
  columns: QueueColumn<R>[];

  /** Stable row id getter. */
  rowKey: (row: R) => string;

  /** Current sort state + setter. */
  sort: QueueSortState;
  onSortChange: (next: QueueSortState) => void;

  /** Per-column filter state + setter. */
  filters: QueueFilterState;
  onFiltersChange: (next: QueueFilterState) => void;

  /** Pagination. `total` is the total filtered row count (not just the
   *  current page). */
  page: number;
  pageSize: number;
  total: number;
  pageSizeOptions?: number[];
  onPageChange: (next: number) => void;
  onPageSizeChange?: (next: number) => void;

  /** Hidden column keys + setter. Persistence is the parent's job. */
  hiddenColumns?: Set<string>;
  onHiddenColumnsChange?: (next: Set<string>) => void;
  /** Column key order. Same shape — parent persists. */
  columnOrder?: string[];
  onColumnOrderChange?: (next: string[]) => void;
  /** Resized column widths. */
  columnWidths?: Record<string, number>;
  onColumnWidthsChange?: (next: Record<string, number>) => void;

  /** Row interactions. */
  onRowClick?: (row: R) => void;
  rowClassName?: (row: R) => string | undefined;

  /** Optional checkbox selection column. */
  selectable?: boolean;
  selected?: Set<string>;
  onSelectionChange?: (next: Set<string>) => void;

  /** UI state. */
  isLoading?: boolean;
  emptyMessage?: string;

  /** Total $ shown in the footer next to the pagination range. */
  footerExtra?: React.ReactNode;
}

// ─── Component ──────────────────────────────────────────────────────────

export function QueueTable<R>({
  rows, columns, rowKey,
  sort, onSortChange,
  filters, onFiltersChange,
  page, pageSize, total,
  pageSizeOptions = [25, 50, 100, 200],
  onPageChange, onPageSizeChange,
  hiddenColumns, onHiddenColumnsChange,
  columnOrder, onColumnOrderChange,
  columnWidths, onColumnWidthsChange,
  onRowClick, rowClassName,
  selectable, selected, onSelectionChange,
  isLoading, emptyMessage = 'No rows match.',
  footerExtra,
}: QueueTableProps<R>) {
  // Effective visible columns, in user-defined order. Pinned-left
  // columns are pulled to the front of the order (within their own
  // relative order) so sticky-left rendering layers cleanly without
  // gaps from non-pinned columns slotting in between.
  const visibleColumns = useMemo(() => {
    const colsByKey = new Map(columns.map(c => [c.key, c]));
    const ordered: QueueColumn<R>[] = [];
    const order = columnOrder ?? columns.map(c => c.key);
    for (const k of order) {
      const c = colsByKey.get(k);
      if (!c) continue;
      if (hiddenColumns?.has(k)) continue;
      ordered.push(c);
    }
    for (const c of columns) {
      if (!order.includes(c.key)) ordered.push(c);
    }
    // Stable partition: pinned-left first, then the rest.
    const pinned: QueueColumn<R>[] = [];
    const free: QueueColumn<R>[] = [];
    for (const c of ordered) (c.pinLeft ? pinned : free).push(c);
    return [...pinned, ...free];
  }, [columns, columnOrder, hiddenColumns]);

  // Click-to-sort cycler — asc → desc → off.
  const toggleSort = useCallback((key: string) => {
    if (sort.key !== key) {
      onSortChange({ key, dir: 'asc' });
      return;
    }
    if (sort.dir === 'asc') {
      onSortChange({ key, dir: 'desc' });
      return;
    }
    onSortChange({ key: null, dir: 'asc' });
  }, [sort, onSortChange]);

  // Column-resize via mousedown on the right edge of a header cell.
  const resizeRef = useRef<{ key: string; startX: number; startW: number } | null>(null);
  const beginResize = (e: React.MouseEvent, key: string, currentWidth: number) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { key, startX: e.clientX, startW: currentWidth };
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const { key: k, startX, startW } = resizeRef.current;
      const next = Math.max(60, startW + (ev.clientX - startX));
      onColumnWidthsChange?.({ ...(columnWidths ?? {}), [k]: next });
    };
    const onUp = () => {
      resizeRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const widthOf = (c: QueueColumn<R>) => columnWidths?.[c.key] ?? c.width;
  const totalWidth = visibleColumns.reduce((s, c) => s + widthOf(c), 0) + (selectable ? 40 : 0);

  // Pagination derived values.
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const startIdx = total === 0 ? 0 : safePage * pageSize + 1;
  const endIdx = Math.min(total, (safePage + 1) * pageSize);

  // Selection toggling.
  const allOnPageSelected = selected && rows.length > 0 && rows.every(r => selected.has(rowKey(r)));
  const toggleAllOnPage = () => {
    if (!onSelectionChange || !selected) return;
    const next = new Set(selected);
    if (allOnPageSelected) {
      for (const r of rows) next.delete(rowKey(r));
    } else {
      for (const r of rows) next.add(rowKey(r));
    }
    onSelectionChange(next);
  };
  const toggleOne = (id: string) => {
    if (!onSelectionChange || !selected) return;
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onSelectionChange(next);
  };

  // Compute cumulative left offsets for sticky-left columns. The
  // selection column (when present) is implicitly the leftmost
  // pinned column at offset 0.
  const stickyOffsets = useMemo(() => {
    const m = new Map<string, number>();
    let acc = selectable ? 40 : 0;
    for (const c of visibleColumns) {
      if (!c.pinLeft) continue;
      m.set(c.key, acc);
      acc += widthOf(c);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleColumns, selectable, columnWidths]);

  return (
    <div className="flex flex-col min-h-0 min-w-0 rounded-lg shadow-sm overflow-hidden h-full w-full"
      style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)' }}>

      {/* Scroll viewport — both axes scroll INSIDE this box. Header rows
          are position:sticky so they survive vertical scroll. */}
      <div className="flex-1 overflow-auto min-h-0 min-w-0 relative" style={{ background: 'var(--gc-surface)' }}>
        <table style={{
          tableLayout: 'fixed', borderCollapse: 'separate',
          borderSpacing: 0, width: totalWidth, minWidth: '100%',
        }}>
          <colgroup>
            {selectable ? <col style={{ width: 40 }} /> : null}
            {visibleColumns.map(c => <col key={c.key} style={{ width: widthOf(c) }} />)}
          </colgroup>

          {/* Sticky header — two rows: titles, filters */}
          <thead>
            {/* Title row */}
            <tr>
              {selectable ? (
                <th style={{
                  ...stHeaderCell,
                  position: 'sticky', top: 0, left: 0, zIndex: 30,
                  background: 'var(--gc-surface)',
                }}>
                  <input
                    type="checkbox"
                    checked={!!allOnPageSelected}
                    onChange={toggleAllOnPage}
                    style={{ cursor: 'pointer' }}
                  />
                </th>
              ) : null}
              {visibleColumns.map(c => {
                const w = widthOf(c);
                const active = sort.key === c.key;
                const Indicator = active ? (sort.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
                const pinnedLeft = c.pinLeft ? stickyOffsets.get(c.key) : undefined;
                return (
                  <th key={c.key}
                    onClick={() => c.sortable && toggleSort(c.key)}
                    style={{
                      ...stHeaderCell,
                      textAlign: c.align ?? 'left',
                      cursor: c.sortable ? 'pointer' : 'default',
                      position: 'sticky', top: 0,
                      left: pinnedLeft,
                      zIndex: pinnedLeft != null ? 30 : 20,
                      background: 'var(--gc-surface)',
                      boxShadow: pinnedLeft != null ? lastPinnedShadow(c, visibleColumns) : undefined,
                    }}
                    className="select-none">
                    <div className="flex items-center gap-1.5"
                      style={{ justifyContent: c.align === 'right' ? 'flex-end' : c.align === 'center' ? 'center' : 'flex-start' }}>
                      <span className="text-[11px] font-semibold uppercase tracking-wide truncate"
                        style={{ color: 'var(--gc-text-2)' }}>
                        {c.label}
                      </span>
                      {c.sortable ? (
                        <Indicator size={11} style={{
                          color: active ? 'var(--gc-text-1)' : 'var(--gc-text-3)',
                          flexShrink: 0,
                        }} />
                      ) : null}
                    </div>
                    {/* Resize handle */}
                    {onColumnWidthsChange ? (
                      <div
                        onMouseDown={e => beginResize(e, c.key, w)}
                        style={{
                          position: 'absolute', top: 0, right: 0, bottom: 0,
                          width: 5, cursor: 'col-resize',
                        }}
                      />
                    ) : null}
                  </th>
                );
              })}
            </tr>
            {/* Filter row — only if any column has a filter spec */}
            {visibleColumns.some(c => c.filter) || selectable ? (
              <tr>
                {selectable ? (
                  <th style={{
                    ...stFilterCell, position: 'sticky', top: 36, left: 0, zIndex: 29,
                    background: 'var(--gc-surface)',
                  }} />
                ) : null}
                {visibleColumns.map(c => {
                  const pinnedLeft = c.pinLeft ? stickyOffsets.get(c.key) : undefined;
                  return (
                    <th key={c.key}
                      style={{
                        ...stFilterCell,
                        position: 'sticky', top: 36,
                        left: pinnedLeft,
                        zIndex: pinnedLeft != null ? 29 : 19,
                        background: 'var(--gc-surface)',
                        boxShadow: pinnedLeft != null ? lastPinnedShadow(c, visibleColumns) : undefined,
                      }}>
                      {c.filter ? (
                        <FilterInput
                          column={c}
                          value={filters[c.key] ?? ''}
                          onChange={(next) => {
                            const merged = { ...filters };
                            if (Array.isArray(next) ? next.length === 0 : !next) delete merged[c.key];
                            else merged[c.key] = next;
                            onFiltersChange(merged);
                          }}
                        />
                      ) : null}
                    </th>
                  );
                })}
              </tr>
            ) : null}
          </thead>

          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={visibleColumns.length + (selectable ? 1 : 0)} style={{ padding: 48, textAlign: 'center' }}>
                  <span className="text-xs" style={{ color: 'var(--gc-text-3)' }}>Loading…</span>
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={visibleColumns.length + (selectable ? 1 : 0)} style={{ padding: 48, textAlign: 'center' }}>
                  <span className="text-xs" style={{ color: 'var(--gc-text-3)' }}>{emptyMessage}</span>
                </td>
              </tr>
            ) : (
              rows.map(r => {
                const id = rowKey(r);
                const rowBg = rowClassName?.(r) ? undefined : 'var(--gc-surface)';
                return (
                  <tr key={id}
                    onClick={onRowClick ? () => onRowClick(r) : undefined}
                    className={`group transition-colors ${rowClassName?.(r) ?? ''}`}
                    style={{
                      cursor: onRowClick ? 'pointer' : 'default',
                    }}>
                    {selectable ? (
                      <td style={{
                        ...stBodyCell,
                        position: 'sticky', left: 0, zIndex: 5,
                        background: 'inherit',
                      }} onClick={e => e.stopPropagation()}>
                        <input type="checkbox"
                          checked={!!selected?.has(id)}
                          onChange={() => toggleOne(id)}
                          style={{ cursor: 'pointer' }} />
                      </td>
                    ) : null}
                    {visibleColumns.map(c => {
                      const pinnedLeft = c.pinLeft ? stickyOffsets.get(c.key) : undefined;
                      return (
                        <td key={c.key}
                          className={c.cellClassName ?? ''}
                          style={{
                            ...stBodyCell,
                            textAlign: c.align ?? 'left',
                            position: pinnedLeft != null ? 'sticky' : undefined,
                            left: pinnedLeft,
                            zIndex: pinnedLeft != null ? 5 : undefined,
                            background: pinnedLeft != null ? (rowBg ?? 'inherit') : undefined,
                            boxShadow: pinnedLeft != null ? lastPinnedShadow(c, visibleColumns) : undefined,
                          }}>
                          {c.render(r)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div className="shrink-0 flex items-center gap-3 px-3 py-2"
        style={{ borderTop: '1px solid var(--gc-border)', background: 'var(--gc-bg)' }}>
        {footerExtra ? <div className="text-[12px]" style={{ color: 'var(--gc-text-2)' }}>{footerExtra}</div> : null}
        <div className="flex-1" />
        {onPageSizeChange ? (
          <>
            <span className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>Page Size:</span>
            <select value={pageSize} onChange={e => onPageSizeChange(Number(e.target.value))}
              className="text-[12px] px-2 py-1 rounded border outline-none"
              style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}>
              {pageSizeOptions.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </>
        ) : null}
        <span className="text-[11px] mx-2" style={{ color: 'var(--gc-text-3)' }}>
          {total === 0 ? '0 of 0' : `${startIdx} to ${endIdx} of ${total}`}
        </span>
        <PageNav page={safePage} pageCount={pageCount} onPageChange={onPageChange} />
      </div>
    </div>
  );
}

/** Drop a subtle shadow on the right edge of the last pinned column
 *  so the scrolling content visually slides under it. */
function lastPinnedShadow<R>(c: QueueColumn<R>, cols: QueueColumn<R>[]): string | undefined {
  if (!c.pinLeft) return undefined;
  const pinned = cols.filter(x => x.pinLeft);
  if (pinned[pinned.length - 1]?.key === c.key) {
    return '2px 0 4px -2px rgba(0,0,0,0.08)';
  }
  return undefined;
}

// ─── Header cell styles ─────────────────────────────────────────────────

const stHeaderCell: React.CSSProperties = {
  height: 36, padding: '0 10px',
  borderBottom: '1px solid var(--gc-border)',
  textAlign: 'left',
  position: 'relative',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
};

const stFilterCell: React.CSSProperties = {
  height: 32, padding: '4px 6px',
  borderBottom: '1px solid var(--gc-border-light)',
  background: 'var(--gc-surface)',
  overflow: 'visible',
};

const stBodyCell: React.CSSProperties = {
  height: 36, padding: '0 10px',
  borderBottom: '1px solid var(--gc-border-light)',
  fontSize: 12.5,
  color: 'var(--gc-text-1)',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
};

// ─── Filter cell ────────────────────────────────────────────────────────

function FilterInput<R>({ column, value, onChange }: {
  column: QueueColumn<R>;
  value: QueueFilterValue;
  onChange: (next: QueueFilterValue) => void;
}) {
  if (!column.filter) return null;
  if (column.filter.kind === 'multi') {
    return (
      <MultiFilter
        options={column.filter.options}
        selected={Array.isArray(value) ? value : []}
        onChange={onChange}
      />
    );
  }
  // Text filter — debounced lightly via React's batching.
  return (
    <div className="flex items-center gap-1 rounded h-full px-1.5"
      style={{ border: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
      <Search size={10} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />
      <input
        value={typeof value === 'string' ? value : ''}
        onChange={e => onChange(e.target.value)}
        placeholder=""
        className="w-full text-[11.5px] outline-none bg-transparent"
        style={{ color: 'var(--gc-text-1)' }}
      />
      {(typeof value === 'string' && value) ? (
        <button type="button" onClick={() => onChange('')}
          className="shrink-0" style={{ color: 'var(--gc-text-3)', cursor: 'pointer' }}>
          <X size={10} />
        </button>
      ) : null}
    </div>
  );
}

function MultiFilter({ options, selected, onChange }: {
  options: string[]; selected: string[]; onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const label = selected.length === 0 ? 'All'
    : selected.length === 1 ? selected[0]
    : `${selected.length} selected`;
  return (
    <div ref={rootRef} className="relative h-full">
      <button type="button" onClick={() => setOpen(v => !v)}
        className="w-full h-full flex items-center gap-1 rounded px-1.5 text-[11.5px]"
        style={{
          border: '1px solid var(--gc-border-light)',
          background: 'var(--gc-bg)',
          color: selected.length > 0 ? 'var(--gc-text-1)' : 'var(--gc-text-3)',
        }}>
        <Filter size={10} style={{ flexShrink: 0 }} />
        <span className="truncate flex-1 text-left">{label}</span>
      </button>
      {open ? (
        <div className="absolute top-full left-0 z-30 mt-1 min-w-[160px] max-h-[280px] overflow-auto rounded shadow-lg"
          style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)' }}>
          {selected.length > 0 ? (
            <button type="button" onClick={() => onChange([])}
              className="w-full text-left text-[11.5px] px-2 py-1.5 hover:bg-[var(--gc-hover)]"
              style={{ color: 'var(--gc-text-2)', borderBottom: '1px solid var(--gc-border-light)' }}>
              Clear all
            </button>
          ) : null}
          {options.map(opt => {
            const on = selected.includes(opt);
            return (
              <button key={opt} type="button"
                onClick={() => {
                  if (on) onChange(selected.filter(o => o !== opt));
                  else onChange([...selected, opt]);
                }}
                className="w-full flex items-center gap-2 text-left text-[11.5px] px-2 py-1.5 hover:bg-[var(--gc-hover)]"
                style={{ color: 'var(--gc-text-1)' }}>
                <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-sm"
                  style={{
                    border: `1px solid ${on ? '#1a73e8' : 'var(--gc-border)'}`,
                    background: on ? '#1a73e8' : 'transparent',
                  }}>
                  {on ? <Check size={9} style={{ color: '#fff' }} strokeWidth={3} /> : null}
                </span>
                <span className="truncate">{opt}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ─── Pagination ─────────────────────────────────────────────────────────

function PageNav({ page, pageCount, onPageChange }: {
  page: number; pageCount: number; onPageChange: (next: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[11px] mr-1" style={{ color: 'var(--gc-text-3)' }}>
        Page {page + 1} of {pageCount}
      </span>
      <NavBtn onClick={() => onPageChange(0)}             disabled={page === 0} title="First"   icon={<ChevronLeft size={12} style={{ marginRight: -3 }} />} extra={<ChevronLeft size={12} />} />
      <NavBtn onClick={() => onPageChange(page - 1)}      disabled={page === 0} title="Prev"    icon={<ChevronLeft size={12} />} />
      <NavBtn onClick={() => onPageChange(page + 1)}      disabled={page >= pageCount - 1} title="Next" icon={<ChevronRight size={12} />} />
      <NavBtn onClick={() => onPageChange(pageCount - 1)} disabled={page >= pageCount - 1} title="Last" icon={<ChevronRight size={12} style={{ marginRight: -3 }} />} extra={<ChevronRight size={12} />} />
    </div>
  );
}

function NavBtn({ onClick, disabled, title, icon, extra }: {
  onClick: () => void; disabled: boolean; title: string;
  icon: React.ReactNode; extra?: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      className="inline-flex items-center justify-center w-6 h-6 rounded"
      style={{
        color: disabled ? 'var(--gc-text-3)' : 'var(--gc-text-1)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        background: 'transparent',
      }}>
      {icon}{extra}
    </button>
  );
}

// ─── Columns dropdown button ────────────────────────────────────────────
// Standalone — render it in the parent toolbar (typically next to Refresh).

export function QueueColumnsButton<R>({
  columns, hiddenColumns, onHiddenColumnsChange,
  columnOrder, onColumnOrderChange,
}: {
  columns: QueueColumn<R>[];
  hiddenColumns: Set<string>;
  onHiddenColumnsChange: (next: Set<string>) => void;
  columnOrder: string[];
  onColumnOrderChange?: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const colsByKey = new Map(columns.map(c => [c.key, c]));
  const ordered = [
    ...columnOrder.filter(k => colsByKey.has(k)),
    ...columns.map(c => c.key).filter(k => !columnOrder.includes(k)),
  ].map(k => colsByKey.get(k)!).filter(Boolean);

  function toggle(k: string) {
    const next = new Set(hiddenColumns);
    if (next.has(k)) next.delete(k); else next.add(k);
    onHiddenColumnsChange(next);
  }

  function reorder(from: string, to: string) {
    if (!onColumnOrderChange || from === to) return;
    const cur = [...columnOrder];
    for (const c of columns) if (!cur.includes(c.key)) cur.push(c.key);
    const fromIdx = cur.indexOf(from);
    const toIdx = cur.indexOf(to);
    if (fromIdx < 0 || toIdx < 0) return;
    cur.splice(fromIdx, 1);
    cur.splice(toIdx, 0, from);
    onColumnOrderChange(cur);
  }

  const visibleCount = columns.length - hiddenColumns.size;

  return (
    <div ref={rootRef} className="relative">
      <button type="button" onClick={() => setOpen(v => !v)}
        className="text-[12px] font-medium px-3 py-1.5 rounded-lg transition-colors inline-flex items-center gap-1.5"
        style={{ border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)', background: open ? 'var(--gc-hover)' : 'var(--gc-surface)' }}>
        <Eye size={12} /> Columns ({visibleCount})
      </button>
      {open ? (
        <div className="absolute right-0 top-full mt-1 z-50 w-[240px] max-h-[420px] overflow-auto rounded-lg shadow-lg"
          style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)' }}>
          <div className="px-3 py-2 flex items-center justify-between"
            style={{ borderBottom: '1px solid var(--gc-border)' }}>
            <span className="text-[11px] font-bold uppercase tracking-wider"
              style={{ color: 'var(--gc-text-2)' }}>Columns</span>
            <span className="text-[10px]" style={{ color: 'var(--gc-text-3)' }}>
              Drag to reorder
            </span>
          </div>
          {ordered.map(c => {
            const visible = !hiddenColumns.has(c.key);
            return (
              <div key={c.key}
                draggable={!!onColumnOrderChange && !c.pinned}
                onDragStart={() => { dragKeyRef.current = c.key; }}
                onDragOver={e => { e.preventDefault(); }}
                onDrop={() => {
                  if (dragKeyRef.current && dragKeyRef.current !== c.key) reorder(dragKeyRef.current, c.key);
                  dragKeyRef.current = null;
                }}
                className="flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--gc-hover)]"
                style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                {onColumnOrderChange && !c.pinned ? (
                  <GripVertical size={11} style={{ color: 'var(--gc-text-3)', cursor: 'grab' }} />
                ) : <span style={{ width: 11 }} />}
                <button type="button"
                  onClick={() => !c.pinned && toggle(c.key)}
                  disabled={c.pinned}
                  className="flex-1 flex items-center gap-2 text-left">
                  {visible
                    ? <Eye size={11} style={{ color: 'var(--gc-text-2)' }} />
                    : <EyeOff size={11} style={{ color: 'var(--gc-text-3)' }} />}
                  <span className="text-[12px] truncate"
                    style={{
                      color: visible ? 'var(--gc-text-1)' : 'var(--gc-text-3)',
                      opacity: c.pinned ? 0.5 : 1,
                    }}>
                    {c.label || '(unlabeled)'}
                  </span>
                  {c.pinLeft ? (
                    <span className="text-[9px] uppercase tracking-wider px-1 py-0.5 rounded"
                      style={{ color: 'var(--gc-text-3)', background: 'var(--gc-bg)' }}
                      title="Pinned to left">PIN</span>
                  ) : null}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ─── Helpers for parents — apply sort/filter/page to rows ───────────────

export function applyQueueSort<R>(
  rows: R[], columns: QueueColumn<R>[], sort: QueueSortState,
): R[] {
  if (!sort.key) return rows;
  const col = columns.find(c => c.key === sort.key);
  if (!col) return rows;
  const getVal = col.sortValue ?? ((r: R) => {
    const rendered = col.render(r);
    if (typeof rendered === 'string' || typeof rendered === 'number') return rendered;
    return null;
  });
  const out = [...rows];
  out.sort((a, b) => {
    const va = getVal(a);
    const vb = getVal(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    let cmp = 0;
    if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
    else cmp = String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
    return sort.dir === 'asc' ? cmp : -cmp;
  });
  return out;
}

export function applyQueueFilters<R>(
  rows: R[], columns: QueueColumn<R>[], filters: QueueFilterState,
): R[] {
  const active = Object.entries(filters).filter(([, v]) =>
    Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim().length > 0,
  );
  if (active.length === 0) return rows;
  return rows.filter(r => {
    for (const [key, val] of active) {
      const col = columns.find(c => c.key === key);
      if (!col || !col.filter) continue;
      const cellVal = col.filterValue
        ? col.filterValue(r)
        : (() => {
            const sv = col.sortValue?.(r);
            if (sv != null) return String(sv);
            const rendered = col.render(r);
            if (typeof rendered === 'string' || typeof rendered === 'number') return String(rendered);
            return '';
          })();
      if (col.filter.kind === 'text') {
        if (!cellVal.toLowerCase().includes(String(val).toLowerCase())) return false;
      } else {
        // multi
        if (!(val as string[]).includes(cellVal)) return false;
      }
    }
    return true;
  });
}

// ─── Persisted column-prefs hooks ───────────────────────────────────────

export function usePersistedColumnPrefs(storageKey: string, defaultHidden: Set<string> = new Set()) {
  const [hidden, setHidden] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set(defaultHidden);
    try {
      const raw = window.localStorage.getItem(`${storageKey}.hidden`);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch { /* ignore */ }
    return new Set(defaultHidden);
  });
  const [order, setOrder] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = window.localStorage.getItem(`${storageKey}.order`);
      if (raw) return JSON.parse(raw) as string[];
    } catch { /* ignore */ }
    return [];
  });
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem(`${storageKey}.widths`);
      if (raw) return JSON.parse(raw) as Record<string, number>;
    } catch { /* ignore */ }
    return {};
  });
  // Persist on change.
  useLayoutEffect(() => {
    try { window.localStorage.setItem(`${storageKey}.hidden`, JSON.stringify([...hidden])); } catch { /* ignore */ }
  }, [hidden, storageKey]);
  useLayoutEffect(() => {
    try { window.localStorage.setItem(`${storageKey}.order`, JSON.stringify(order)); } catch { /* ignore */ }
  }, [order, storageKey]);
  useLayoutEffect(() => {
    try { window.localStorage.setItem(`${storageKey}.widths`, JSON.stringify(widths)); } catch { /* ignore */ }
  }, [widths, storageKey]);

  return { hidden, setHidden, order, setOrder, widths, setWidths };
}
