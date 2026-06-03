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
 *   • filter chip row (search + select + date-range) above the header
 *   • pagination footer with "showing X–Y of Z"
 *
 * Optional power-user features (closeout-tier surfaces):
 *   • Pinned columns (left/right) with horizontal scroll between them
 *   • Column-visibility picker + persistence to localStorage
 *   • Priority row pinning (`priorityKey` rows float to top after sort)
 *   • Selectable rows + bulk-action slot
 *   • Date-range filter chip
 *
 * Why a wrapper instead of using TanStack's components directly:
 *   TanStack ships *only* hooks and types — there's no opinionated
 *   markup. That's exactly what we want, so OpsTable becomes the
 *   one place that owns visual style. Any future table just declares
 *   columns + filters and inherits the look. When the design changes,
 *   we change it once here.
 *
 * Usage (basic):
 *
 *   const columns: OpsColumn<MyRow>[] = [
 *     { key: 'date',   header: 'Date',   render: r => <OpsDate iso={r.date} />, width: 110, sortable: true },
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
  useMemo, useState, useRef, useEffect, useCallback, type ReactNode,
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
import { ChevronDown, Search as SearchIcon, ArrowUp, ArrowDown, X, Columns as ColumnsIcon, Calendar as CalendarIcon, GripVertical } from 'lucide-react';
import DatePicker from '../calendar/DatePicker';

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
  align?: 'left' | 'right' | 'center';
  /** Optional hover tooltip surfaced on the column header. Use this
   *  to explain a metric's formula (e.g. "POD uploaded within 24h of
   *  delivery ÷ delivered loads") so the table is self-documenting
   *  without requiring a help icon next to every column. */
  headerTooltip?: string;
  sortable?: boolean;
  /** Comparator value when the cell renders something non-comparable. */
  sortValue?: (row: T) => string | number;
  /** Optional leading dot — color resolved per-row. Motive uses
   *  this for the per-truck status indicator (gray / amber / green). */
  leadingDot?: (row: T) => { color: string; tooltip?: string };
  /** Sticky pin direction. "left" sticks to the start, "right" to the
   *  end. Pinned columns stay visible during horizontal scroll —
   *  essential on wide tables where the row identifier (e.g. Load #)
   *  and per-row actions need to stay reachable while the user scrolls
   *  through middle columns. */
  pinned?: 'left' | 'right';
  /** When true, the column starts hidden — user can opt back in via
   *  the column visibility picker. Use for low-value-by-default
   *  columns (e.g. internal IDs) you still want available on demand. */
  defaultHidden?: boolean;
  /** When true, the column is omitted from the visibility picker —
   *  it can't be hidden by the user. Use for required columns
   *  (actions, identifier). */
  alwaysVisible?: boolean;
  /** Friendlier label in the column picker. Defaults to `header`. */
  pickerLabel?: string;
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
    }
  | {
      kind: 'date-range';
      /** Stable key — used as React key. Internally stores
       *  `${key}:from` and `${key}:to` in the filter state. */
      key: string;
      label: string;
      /** Returns the ISO date (YYYY-MM-DD or full timestamp) to
       *  compare against the range. Range is inclusive on both ends. */
      getDate: (row: T) => string | null | undefined;
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

  // ── Optional power-user features ────────────────────────────────────

  /** When provided, rows where the function returns true are pinned
   *  to the top of every page regardless of the active sort. Use for
   *  "starred"/"priority" semantics — items the user wants to keep
   *  visible. Within the pinned set the active sort still applies. */
  priorityKey?: (row: T) => boolean;
  /** Renders the column-visibility picker chip in the toolbar. */
  columnPicker?: boolean;
  /** localStorage key for persisting user UI state (visible columns,
   *  sort). Use a versioned key per consumer — bumping the version
   *  resets state when the column set changes incompatibly. */
  persistKey?: string;
  /** Adds a checkbox column at the start. Each row gets a select
   *  toggle; the header gets a "select all on this page" toggle. */
  selectable?: boolean;
  /** Slot rendered in the toolbar when one or more rows are selected.
   *  Receives the selected IDs + their rows + a clearSelection helper.
   *  Replace the right-side toolbar content while selection is active
   *  (e.g. "3 selected · Release · Flag · Clear"). */
  bulkActions?: (args: {
    selectedIds: string[];
    selectedRows: T[];
    clearSelection: () => void;
  }) => ReactNode;
  /** Called whenever the selected-id set changes. Caller may use this
   *  to react in real time (badges elsewhere on the page). */
  onSelectionChange?: (selectedIds: string[]) => void;
  /** Disables built-in pagination. Use when the caller paginates
   *  server-side and is feeding `data` for a single page. The page
   *  size + pager are still hidden but the footer still shows the
   *  caller's range via `footerSummary`. */
  paginated?: boolean;
  /** Override for the footer count text — used when the caller
   *  paginates server-side and the local `data.length` doesn't
   *  reflect the true total. */
  footerSummary?: ReactNode;
  /** When true, the table fills its parent's height and the row body
   *  scrolls internally on BOTH axes — vertical for long lists
   *  (paginated=false), horizontal for column sets wider than the
   *  viewport. The parent must be a flex column with a constrained
   *  height (e.g. `flex-1 min-h-0`). Default false to preserve the
   *  natural-height layout existing consumers rely on. */
  fillHeight?: boolean;
  /** Enables the column-order up/down controls inside the column
   *  picker dropdown. Persists order alongside visibility to the
   *  same `persistKey`. Only meaningful when `columnPicker` is true. */
  columnReorder?: boolean;
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
  priorityKey,
  columnPicker = false,
  persistKey,
  selectable = false,
  bulkActions,
  onSelectionChange,
  paginated = true,
  footerSummary,
  fillHeight = false,
  columnReorder = false,
}: OpsTableProps<T>) {
  // ── Filter state ───────────────────────────────────────────────────
  // Keyed by filter.key for select filters and '__search' for search.
  // Date-range filters use `${key}:from` and `${key}:to` keys.
  //
  // Persisted to sessionStorage when `persistKey` is set so a filter
  // the dispatcher set early in a billing pass (e.g. "Pickup: last
  // week") survives navigations within the same tab — including the
  // table-remount that bucket changes / action callbacks trigger via
  // the parent's `key=` prop. Closing the tab clears state (sessionStorage
  // semantics match the user-facing "until I close the page" rule).
  const filtersStorageKey = persistKey ? `${persistKey}:filters` : null;
  const [filterState, setFilterState] = useState<Record<string, string>>(() => {
    // First, hydrate from sessionStorage so a remount preserves what
    // the user already picked. Read happens once on mount — subsequent
    // updates flow through the setter + the useEffect below.
    if (typeof window !== 'undefined' && filtersStorageKey) {
      try {
        const raw = window.sessionStorage.getItem(filtersStorageKey);
        if (raw) {
          const parsed = JSON.parse(raw) as Record<string, string>;
          if (parsed && typeof parsed === 'object') return parsed;
        }
      } catch { /* corrupted entry — fall through to defaults */ }
    }
    const init: Record<string, string> = {};
    for (const f of filters) {
      if (f.kind === 'select' && f.defaultValue) init[f.key] = f.defaultValue;
    }
    return init;
  });
  // Persist on every change. We DROP empty-string entries before
  // writing so the round-trip back through "Clear filters" doesn't
  // leave dead keys behind — and the storage key disappears entirely
  // once everything is cleared, keeping sessionStorage tidy.
  useEffect(() => {
    if (typeof window === 'undefined' || !filtersStorageKey) return;
    try {
      const live = Object.fromEntries(Object.entries(filterState).filter(([, v]) => v));
      if (Object.keys(live).length === 0) {
        window.sessionStorage.removeItem(filtersStorageKey);
      } else {
        window.sessionStorage.setItem(filtersStorageKey, JSON.stringify(live));
      }
    } catch { /* quota / private mode — best-effort */ }
  }, [filterState, filtersStorageKey]);

  // ── Column visibility ─────────────────────────────────────────────
  // Persisted to localStorage when `persistKey` is set so the user's
  // hide/show choices survive across sessions.
  const visibilityStorageKey = persistKey ? `${persistKey}:hidden` : null;
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => {
    const init = new Set<string>();
    for (const c of columns) if (c.defaultHidden) init.add(c.key);
    if (typeof window !== 'undefined' && visibilityStorageKey) {
      try {
        const raw = window.localStorage.getItem(visibilityStorageKey);
        if (raw) {
          const parsed = JSON.parse(raw) as string[];
          if (Array.isArray(parsed)) return new Set(parsed);
        }
      } catch { /* ignore — fall back to defaults */ }
    }
    return init;
  });
  // Persist visibility changes. The dep on `persistKey` ensures
  // switching the table to a new storage key (e.g. tab change in
  // closeout) re-reads on next mount.
  useEffect(() => {
    if (typeof window === 'undefined' || !visibilityStorageKey) return;
    try {
      window.localStorage.setItem(visibilityStorageKey, JSON.stringify(Array.from(hiddenCols)));
    } catch { /* quota errors etc. — non-critical */ }
  }, [hiddenCols, visibilityStorageKey]);

  // Column order — user-controlled via the picker dropdown's
  // up/down buttons when `columnReorder` is enabled. Stored as an
  // ordered array of column keys; columns not present in the array
  // keep their declared position (new columns appended after a
  // future code change won't disappear from view).
  const orderStorageKey = persistKey ? `${persistKey}:order` : null;
  const [columnOrder, setColumnOrder] = useState<string[]>(() => {
    if (typeof window !== 'undefined' && orderStorageKey) {
      try {
        const raw = window.localStorage.getItem(orderStorageKey);
        if (raw) {
          const parsed = JSON.parse(raw) as string[];
          if (Array.isArray(parsed)) return parsed;
        }
      } catch { /* fall through */ }
    }
    return columns.map(c => c.key);
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !orderStorageKey) return;
    try { window.localStorage.setItem(orderStorageKey, JSON.stringify(columnOrder)); }
    catch { /* non-critical */ }
  }, [columnOrder, orderStorageKey]);

  // Apply the user-chosen order to the declared columns. Any column
  // not in `columnOrder` falls in at its declared position (so newly-
  // added columns don't vanish for users with a stale persisted
  // order). Pinned columns keep their pin direction regardless of
  // where the user moves them in the order — sticky positioning
  // would break otherwise.
  const orderedColumns = useMemo(() => {
    const byKey = new Map(columns.map(c => [c.key, c]));
    const seen  = new Set<string>();
    const out: OpsColumn<T>[] = [];
    for (const k of columnOrder) {
      const c = byKey.get(k);
      if (c) { out.push(c); seen.add(k); }
    }
    for (const c of columns) {
      if (!seen.has(c.key)) out.push(c);
    }
    return out;
  }, [columns, columnOrder]);

  // Visible columns = ordered columns minus user-hidden. We do NOT
  // strip alwaysVisible columns from this list even if they appear
  // in hiddenCols (defensive — they can't be hidden in the picker UI
  // either, but a stale persisted state shouldn't blank the actions).
  const visibleColumns = useMemo(
    () => orderedColumns.filter(c => c.alwaysVisible || !hiddenCols.has(c.key)),
    [orderedColumns, hiddenCols],
  );

  // ── Selection state ─────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Notify parent on any change. We dedupe at the Set level so this
  // only fires when the membership actually changed.
  useEffect(() => {
    if (!onSelectionChange) return;
    onSelectionChange(Array.from(selectedIds));
  }, [selectedIds, onSelectionChange]);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // ── Apply filters ──────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (filters.length === 0) return data;
    const q = (filterState.__search ?? '').trim().toLowerCase();
    return data.filter(row => {
      for (const f of filters) {
        if (f.kind === 'search') {
          if (q && !f.match(row, q)) return false;
        } else if (f.kind === 'select') {
          const v = filterState[f.key];
          if (v && !f.predicate(row, v)) return false;
        } else if (f.kind === 'date-range') {
          const from = filterState[`${f.key}:from`];
          const to   = filterState[`${f.key}:to`];
          if (!from && !to) continue;
          const raw = f.getDate(row);
          if (!raw) {
            // Caller chose "this row has no date" — don't match a
            // date-range filter against it. Closeout uses this for
            // released loads that haven't been delivered yet, etc.
            return false;
          }
          // Normalise to YYYY-MM-DD for inclusive day comparison.
          const ymd = raw.length >= 10 ? raw.slice(0, 10) : raw;
          if (from && ymd < from) return false;
          if (to   && ymd > to)   return false;
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
  const tanColumns = useMemo<TanColumnDef<T, any>[]>(() => visibleColumns.map(col => ({
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
  })), [visibleColumns]);

  // ── TanStack table instance ────────────────────────────────────────
  // Sort can be persisted too — bigger payoff than column visibility
  // since dispatchers re-open the page in the same mental state.
  const sortStorageKey = persistKey ? `${persistKey}:sort` : null;
  const [sorting, setSorting] = useState<SortingState>(() => {
    if (typeof window !== 'undefined' && sortStorageKey) {
      try {
        const raw = window.localStorage.getItem(sortStorageKey);
        if (raw) {
          const parsed = JSON.parse(raw) as SortingState;
          if (Array.isArray(parsed)) return parsed;
        }
      } catch { /* fall through */ }
    }
    return defaultSort ? [{ id: defaultSort.key, desc: defaultSort.dir === 'desc' }] : [];
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !sortStorageKey) return;
    try { window.localStorage.setItem(sortStorageKey, JSON.stringify(sorting)); }
    catch { /* non-critical */ }
  }, [sorting, sortStorageKey]);

  const table = useReactTable({
    data: filtered,
    columns: tanColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: paginated ? getPaginationRowModel() : undefined,
    initialState: { pagination: { pageSize: paginated ? pageSize : Number.MAX_SAFE_INTEGER } },
  });

  // Reset to page 0 whenever the filter set changes — otherwise the
  // dispatcher narrows a filter and lands on an empty page 4.
  useEffect(() => {
    if (paginated) table.setPageIndex(0);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [filterState, paginated]);

  // ── Priority row pinning ──────────────────────────────────────────
  // After TanStack has done sort + pagination we pull the resulting
  // page's rows and (if priorityKey is set) hoist any matching rows
  // to the top. This is a *display-only* reorder — pagination is
  // still over the full sorted list, so paging behaves as expected;
  // it's just that within a page, priority rows lead. For closeout
  // we additionally apply priority pinning across ALL filtered rows
  // (so a starred row on page 3 jumps to page 1) by sorting `filtered`
  // upstream of TanStack instead. Trade-off: post-page sort is local
  // and fast; full-filtered sort needs a useMemo. We do the latter
  // when priorityKey is set so the dispatcher's expectation matches.
  const pageRowsRaw = table.getRowModel().rows;
  const pageRows = useMemo(() => {
    if (!priorityKey) return pageRowsRaw;
    // Stable partition: priority rows first, then everything else.
    // Each subset keeps its TanStack sort order.
    const pri: typeof pageRowsRaw = [];
    const rest: typeof pageRowsRaw = [];
    for (const r of pageRowsRaw) {
      if (priorityKey(r.original)) pri.push(r);
      else rest.push(r);
    }
    return [...pri, ...rest];
  }, [pageRowsRaw, priorityKey]);

  const total    = filtered.length;
  const pageIdx  = table.getState().pagination.pageIndex;
  const pageCnt  = Math.max(1, table.getPageCount());
  const from     = total === 0 ? 0 : pageIdx * pageSize + 1;
  const to       = Math.min(total, (pageIdx + 1) * pageSize);

  // ── Grid template + sticky offsets ─────────────────────────────────
  // Selection column (when enabled) is implicitly pinned-left at
  // offset 0. Other pinned cols compute their offset from the
  // cumulative width of pinned cols to their side.
  const SELECT_COL_WIDTH = 44; // px, including padding
  const widthOfCol = useCallback((c: OpsColumn<T>): string => {
    if (c.width == null)             return 'minmax(120px, 1fr)';
    if (typeof c.width === 'number') return `${c.width}px`;
    return c.width;
  }, []);

  // Compute pixel offsets for sticky positioning. Pinned left cols
  // are ordered first-to-last, each offset by the sum of previous
  // pinned-left widths. Pinned right cols are ordered right-to-left.
  // Non-numeric widths (e.g. "1fr") can't be sticky so we fall back
  // to "0px" sticky and let CSS gracefully degrade.
  const { leftOffsets, rightOffsets } = useMemo(() => {
    const left  = new Map<string, number>();
    const right = new Map<string, number>();
    let leftAcc = selectable ? SELECT_COL_WIDTH : 0;
    for (const c of visibleColumns) {
      if (c.pinned === 'left') {
        left.set(c.key, leftAcc);
        const w = typeof c.width === 'number' ? c.width : parseInt(String(c.width), 10);
        if (Number.isFinite(w)) leftAcc += w;
      }
    }
    let rightAcc = 0;
    for (let i = visibleColumns.length - 1; i >= 0; i--) {
      const c = visibleColumns[i];
      if (c.pinned === 'right') {
        right.set(c.key, rightAcc);
        const w = typeof c.width === 'number' ? c.width : parseInt(String(c.width), 10);
        if (Number.isFinite(w)) rightAcc += w;
      }
    }
    return { leftOffsets: left, rightOffsets: right };
  }, [visibleColumns, selectable]);

  const gridTemplate = useMemo(() => {
    const cols = visibleColumns.map(widthOfCol).join(' ');
    return selectable ? `${SELECT_COL_WIDTH}px ${cols}` : cols;
  }, [visibleColumns, selectable, widthOfCol]);

  const rowHeightPx = density === 'compact' ? 36 : 52;

  // ── Selection helpers ─────────────────────────────────────────────
  const pageRowIds = useMemo(() => pageRows.map(r => rowKey(r.original)), [pageRows, rowKey]);
  const allPageSelected = pageRowIds.length > 0 && pageRowIds.every(id => selectedIds.has(id));
  const somePageSelected = !allPageSelected && pageRowIds.some(id => selectedIds.has(id));
  const togglePageSelection = useCallback(() => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (allPageSelected) {
        for (const id of pageRowIds) next.delete(id);
      } else {
        for (const id of pageRowIds) next.add(id);
      }
      return next;
    });
  }, [allPageSelected, pageRowIds]);
  const toggleRowSelection = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else              next.add(id);
      return next;
    });
  }, []);

  // selectedRows = rows in the current `data` whose key is selected.
  // We compute over `data` (not `pageRows`) so the bulk actions can
  // operate on rows that aren't currently visible (other pages).
  const selectedRows = useMemo(() => {
    if (selectedIds.size === 0) return [] as T[];
    return data.filter(r => selectedIds.has(rowKey(r)));
  }, [data, selectedIds, rowKey]);
  const selectionActive = selectedIds.size > 0;

  // Pickable columns for the visibility chip — excludes alwaysVisible.
  // Derived from orderedColumns (NOT raw columns) so the picker UI
  // reflects the user's reorder choices. Without this, the drag-drop
  // reorder updates columnOrder state and re-renders the table
  // correctly, but the picker keeps showing the original order.
  const pickerColumns = useMemo(
    () => orderedColumns.filter(c => !c.alwaysVisible),
    [orderedColumns],
  );

  // Drag-drop column reorder. The picker emits an absolute target
  // position within ITS visible list (which excludes alwaysVisible
  // columns); we translate that back into a slot in the full
  // columnOrder array. Splicing in two steps (remove then re-insert)
  // keeps the math simple regardless of which direction the move goes.
  // Pinned columns shouldn't reorder across the pinned/non-pinned
  // boundary, but the picker doesn't list them so it's naturally
  // enforced.
  const moveColumnTo = useCallback((key: string, targetPickerIdx: number) => {
    setColumnOrder(prev => {
      const next = [...prev];
      const from = next.indexOf(key);
      if (from === -1) return prev;
      // Walk the columnOrder picking up alwaysVisible slots so the
      // picker-index → columnOrder-index translation lands on the
      // correct global position (the picker hides those rows but the
      // underlying array still contains them).
      const colByKey = new Map(columns.map(c => [c.key, c] as const));
      const isPickable = (k: string) => !colByKey.get(k)?.alwaysVisible;
      // Build the pickable-only sequence to determine the target slot.
      const pickable = next.filter(isPickable);
      // Remove the source from the pickable list and insert it at the
      // requested index, then translate that ordering back to full
      // columnOrder by reinserting alwaysVisible slots in place.
      const pickedKey = pickable.splice(pickable.indexOf(key), 1)[0];
      const clamped = Math.max(0, Math.min(targetPickerIdx, pickable.length));
      pickable.splice(clamped, 0, pickedKey);
      // Re-zip: stream through `next`, replacing each pickable slot in
      // sequence with the new ordering, keeping alwaysVisible columns
      // exactly where they were.
      let p = 0;
      const result = next.map(k => (isPickable(k) ? (pickable[p++] ?? k) : k));
      return result;
    });
  }, [columns]);

  return (
    <div className={fillHeight ? 'w-full h-full flex flex-col min-h-0' : 'w-full'}>
      {/* ── Filter chip row ─────────────────────────────────────── */}
      {(filters.length > 0 || toolbarRight || columnPicker || selectionActive) && (
        <div className="flex items-center gap-2 flex-wrap mb-3">
          {!selectionActive && filters.map(f => {
            if (f.kind === 'search') {
              return (
                <SearchChip
                  key="__search"
                  value={filterState.__search ?? ''}
                  onChange={v => setFilterState(s => ({ ...s, __search: v }))}
                  placeholder={f.placeholder ?? 'Search…'}
                  width={f.width ?? 280}
                />
              );
            }
            if (f.kind === 'select') {
              return (
                <SelectChip
                  key={f.key}
                  label={f.label}
                  value={filterState[f.key] ?? ''}
                  onChange={v => setFilterState(s => ({ ...s, [f.key]: v }))}
                  options={f.options}
                />
              );
            }
            // date-range
            return (
              <DateRangeChip
                key={f.key}
                label={f.label}
                from={filterState[`${f.key}:from`] ?? ''}
                to={filterState[`${f.key}:to`] ?? ''}
                onChange={(from, to) => setFilterState(s => ({
                  ...s,
                  [`${f.key}:from`]: from,
                  [`${f.key}:to`]:   to,
                }))}
              />
            );
          })}
          {!selectionActive && Object.values(filterState).some(v => v) && (
            <button
              onClick={() => setFilterState({})}
              className="text-[12px] font-semibold ml-1 transition-colors"
              style={{ color: 'var(--gc-blue)' }}>
              Clear filters
            </button>
          )}
          <div className="flex-1" />
          {selectionActive && bulkActions && (
            <div className="flex items-center gap-2.5">
              <span className="text-[13px] font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
                {selectedIds.size} selected
              </span>
              {bulkActions({ selectedIds: Array.from(selectedIds), selectedRows, clearSelection })}
              <button
                type="button"
                onClick={clearSelection}
                className="text-[12px] font-semibold transition-colors"
                style={{ color: 'var(--gc-text-3)' }}>
                Clear
              </button>
            </div>
          )}
          {!selectionActive && columnPicker && pickerColumns.length > 0 && (
            <ColumnPickerChip
              columns={pickerColumns}
              hidden={hiddenCols}
              onChange={setHiddenCols}
              reorder={columnReorder}
              onMoveTo={moveColumnTo}
            />
          )}
          {!selectionActive && toolbarRight}
        </div>
      )}

      {/* ── Table card ──────────────────────────────────────────── */}
      {/* In fillHeight mode the card fills the parent's remaining
          height (flex-1 min-h-0) and scrolls BOTH axes internally —
          vertical for long lists (paginated=false), horizontal for
          column sets wider than the viewport. Pinned columns + the
          sticky header stay anchored within this scroll container.
          The non-fillHeight default keeps existing consumers' layout
          untouched: horizontal scroll only, natural row height. */}
      <div
        className={fillHeight ? 'rounded-lg flex-1 min-h-0' : 'rounded-lg'}
        style={{
          background: 'var(--gc-surface)',
          border: '1px solid var(--gc-border-light)',
          overflow: fillHeight ? 'auto' : undefined,
          overflowX: fillHeight ? undefined : 'auto',
        }}>
        {/* Header row */}
        <div
          className="grid items-center"
          style={{
            gridTemplateColumns: gridTemplate,
            background: 'var(--gc-surface)',
            borderBottom: '1px solid var(--gc-border-light)',
            minHeight: 44,
            position: 'sticky',
            top: 0,
            zIndex: 2,
          }}>
          {selectable && (
            <div
              className="flex items-center justify-center"
              style={{
                position: 'sticky',
                left: 0,
                background: 'var(--gc-surface)',
                zIndex: 3,
                height: '100%',
                paddingLeft: 16,
              }}>
              <CheckBox
                checked={allPageSelected}
                indeterminate={somePageSelected}
                onChange={togglePageSelection}
                aria-label="Select all on page"
              />
            </div>
          )}
          {visibleColumns.map((col, idx) => {
            const h     = table.getHeaderGroups()[0]?.headers[idx];
            const dir   = h?.column.getIsSorted();
            const canSort = h?.column.getCanSort() ?? false;
            const stickyStyle = stickyStyleFor(col, leftOffsets, rightOffsets);
            return (
              <div
                key={col.key}
                style={{
                  ...stickyStyle,
                  background: 'var(--gc-surface)',
                  zIndex: stickyStyle.position === 'sticky' ? 3 : 1,
                  paddingLeft: idx === 0 && !selectable ? 16 : 0,
                  paddingRight: idx === visibleColumns.length - 1 ? 16 : 12,
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                }}>
                <button
                  type="button"
                  disabled={!canSort}
                  onClick={canSort && h ? () => h.column.toggleSorting() : undefined}
                  title={col.headerTooltip}
                  className="flex items-center gap-1 select-none transition-colors"
                  style={{
                    textAlign:  col.align ?? 'left',
                    justifyContent:
                      col.align === 'right'  ? 'flex-end'    :
                      col.align === 'center' ? 'center'      :
                                               'flex-start',
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
                  {col.header}
                  {canSort && dir && (
                    dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />
                  )}
                </button>
              </div>
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
            const isSelected = selectedIds.has(id);
            const isPriority = priorityKey?.(original) ?? false;
            // Row background — priority > active > selected > default.
            // Sticky cells need a matching background so the scroll
            // doesn't reveal the row behind them.
            const rowBg = active   ? '#e8f0fe'
                        : isSelected ? '#f0f7ff'
                        : isPriority ? '#fffbeb'
                        :              'var(--gc-surface)';
            return (
              <div
                key={id}
                onClick={onRowClick ? (e) => {
                  // Don't trigger row-click when clicking inside an
                  // interactive child (button, link, input, etc.).
                  // The sticky checkbox cell would otherwise fire
                  // both a select-toggle and a row-open.
                  const target = e.target as HTMLElement;
                  if (target.closest('button, a, input, [data-row-click-ignore]')) return;
                  onRowClick(original);
                } : undefined}
                className="grid items-stretch transition-colors"
                style={{
                  gridTemplateColumns: gridTemplate,
                  minHeight: rowHeightPx,
                  borderTop: '1px solid #f1f3f4',
                  cursor: onRowClick ? 'pointer' : 'default',
                  background: rowBg,
                }}
                onMouseEnter={e => {
                  if (active || isSelected) return;
                  (e.currentTarget as HTMLElement).style.background = isPriority ? '#fef3c7' : '#f8f9fa';
                }}
                onMouseLeave={e => {
                  if (active || isSelected) return;
                  (e.currentTarget as HTMLElement).style.background = rowBg;
                }}>
                {selectable && (
                  <div
                    data-row-click-ignore
                    className="flex items-center justify-center"
                    style={{
                      position: 'sticky',
                      left: 0,
                      background: rowBg,
                      zIndex: 1,
                      paddingLeft: 16,
                    }}>
                    <CheckBox
                      checked={isSelected}
                      onChange={() => toggleRowSelection(id)}
                      aria-label={`Select row ${id}`}
                    />
                  </div>
                )}
                {r.getVisibleCells().map((cell, idx) => {
                  const col = visibleColumns[idx];
                  const stickyStyle = stickyStyleFor(col, leftOffsets, rightOffsets);
                  return (
                    <div
                      key={cell.id}
                      className="min-w-0 flex items-center"
                      style={{
                        ...stickyStyle,
                        background: stickyStyle.position === 'sticky' ? rowBg : 'transparent',
                        zIndex: stickyStyle.position === 'sticky' ? 1 : 0,
                        paddingLeft: idx === 0 && !selectable ? 16 : 0,
                        paddingRight: idx === visibleColumns.length - 1 ? 16 : 12,
                        // Horizontal alignment of the cell's content
                        // mirrors the header — without this the flex
                        // wrapper defaulted to flex-start (left), so
                        // a column marked `align: 'center'` would
                        // show a centered HEADER over LEFT-leaning
                        // values. textAlign alone doesn't help
                        // because the rendered cells are usually
                        // inline-block spans or divs that don't
                        // honor it through the flex layout.
                        justifyContent:
                          col.align === 'right'  ? 'flex-end'    :
                          col.align === 'center' ? 'center'      :
                                                   'flex-start',
                        textAlign: col.align ?? 'left',
                      }}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>

      {/* ── Footer ─────────────────────────────────────────────── */}
      {!loading && (total > 0 || footerSummary) && (
        <div className="flex items-center justify-between mt-3 text-[11px]"
          style={{ color: 'var(--gc-text-3)' }}>
          <span>
            {footerSummary ?? (
              // When pagination is disabled, all `total` rows render at
              // once — "Showing 1-25 of 40" would be a lie because the
              // pageSize prop default is 25 even though we show all 40.
              // Use a flat count instead.
              paginated
                ? `Showing ${from}–${to} of ${total} ${total === 1 ? countLabel : `${countLabel}s`}`
                : `Showing ${total} ${total === 1 ? countLabel : `${countLabel}s`}`
            )}
          </span>
          {paginated && pageCnt > 1 && (
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

// ── Internals ────────────────────────────────────────────────────────

/** Compute the inline style for a cell based on pinned direction. */
function stickyStyleFor<T>(
  col: OpsColumn<T> | undefined,
  leftOffsets: Map<string, number>,
  rightOffsets: Map<string, number>,
): React.CSSProperties {
  if (!col?.pinned) return {};
  if (col.pinned === 'left') {
    return { position: 'sticky', left: leftOffsets.get(col.key) ?? 0 };
  }
  return { position: 'sticky', right: rightOffsets.get(col.key) ?? 0 };
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

function DateRangeChip({
  label, from, to, onChange,
}: {
  label: string;
  from: string;
  to:   string;
  onChange: (from: string, to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [open]);

  const active = !!(from || to);
  const display = active
    ? `${label}: ${fmtShort(from) || '…'} → ${fmtShort(to) || '…'}`
    : label;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 rounded-md transition-colors"
        style={{
          background: active ? 'var(--gc-blue-light)' : 'var(--gc-surface)',
          border:     `1px solid ${active ? 'var(--gc-blue)' : 'var(--gc-border-light)'}`,
          color:      active ? 'var(--gc-blue-text)' : 'var(--gc-text-2)',
          padding:    '7px 10px',
          fontSize:   13,
          fontWeight: 500,
        }}
        onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.borderColor = 'var(--gc-text-3)'; }}
        onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.borderColor = 'var(--gc-border-light)'; }}>
        <CalendarIcon size={13} />
        {display}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div
          className="absolute mt-1 rounded-md p-3 z-20 flex flex-col gap-2"
          style={{
            background: 'var(--gc-surface)',
            border:     '1px solid var(--gc-border-light)',
            boxShadow:  '0 4px 12px rgba(0,0,0,0.08)',
            minWidth:   260,
          }}>
          {/* Use the shared DatePicker component for visual parity with
              the rest of the app (work-order modal, EventModal, etc.).
              DatePicker spawns its own portal'd calendar pop-up; the
              trigger button sits inline here. */}
          <label className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>From</label>
          <DatePicker
            value={from}
            onChange={(v) => onChange(v, to)}
            headerColor="#1a73e8"
            buttonClassName="text-[13px] rounded text-left"
            buttonStyle={{
              border: '1px solid var(--gc-border-light)',
              padding: '7px 10px',
              color: from ? 'var(--gc-text-1)' : 'var(--gc-text-3)',
              background: 'var(--gc-surface)',
              width: '100%',
            }}
            displayText={from ? undefined : 'Select date'}
          />
          <label className="text-[10px] font-bold uppercase tracking-wider mt-1" style={{ color: 'var(--gc-text-3)' }}>To</label>
          <DatePicker
            value={to}
            onChange={(v) => onChange(from, v)}
            headerColor="#1a73e8"
            buttonClassName="text-[13px] rounded text-left"
            buttonStyle={{
              border: '1px solid var(--gc-border-light)',
              padding: '7px 10px',
              color: to ? 'var(--gc-text-1)' : 'var(--gc-text-3)',
              background: 'var(--gc-surface)',
              width: '100%',
            }}
            displayText={to ? undefined : 'Select date'}
            min={from || undefined}
          />
          {active && (
            <button
              type="button"
              onClick={() => { onChange('', ''); setOpen(false); }}
              className="text-[12px] font-semibold mt-1 transition-colors text-left"
              style={{ color: 'var(--gc-blue)' }}>
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function fmtShort(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function ColumnPickerChip<T>({
  columns, hidden, onChange, reorder, onMoveTo,
}: {
  columns: OpsColumn<T>[];
  hidden: Set<string>;
  onChange: (next: Set<string>) => void;
  /** Show a drag handle on each row so the user can reorder columns. */
  reorder?: boolean;
  /** Move a column to an absolute index within the picker's visible list. */
  onMoveTo?: (key: string, targetIndex: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [open]);

  // ── Drag-drop reorder state ────────────────────────────────────────
  // `dragKey` is the key of the row currently being dragged.
  // `overIdx` is the index of the row hovered as drop target.
  // `placement` tells the dragover-onto-row math which half is closer
  // ("before" inserts above the hovered row, "after" below) so the
  // visual indicator + the resolved drop index match.
  const [dragKey,  setDragKey]  = useState<string | null>(null);
  const [overIdx,  setOverIdx]  = useState<number  | null>(null);
  const [placement, setPlacement] = useState<'before' | 'after'>('before');

  const hiddenCount = columns.filter(c => hidden.has(c.key)).length;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 rounded-md transition-colors"
        style={{
          background: 'var(--gc-surface)',
          border:     '1px solid var(--gc-border-light)',
          color:      'var(--gc-text-2)',
          padding:    '7px 10px',
          fontSize:   13,
          fontWeight: 500,
        }}
        onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--gc-text-3)')}
        onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--gc-border-light)')}>
        <ColumnsIcon size={13} />
        Columns{hiddenCount > 0 && (
          <span className="tabular-nums text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
            · {columns.length - hiddenCount}/{columns.length}
          </span>
        )}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div
          className="absolute right-0 mt-1 rounded-md overflow-hidden z-20"
          style={{
            background: 'var(--gc-surface)',
            border:     '1px solid var(--gc-border-light)',
            boxShadow:  '0 4px 12px rgba(0,0,0,0.08)',
            minWidth:   260,
            maxHeight:  360,
            overflowY:  'auto',
          }}>
          {columns.map((c, idx) => {
            const isHidden = hidden.has(c.key);
            const isDragging = dragKey === c.key;
            const dragEnabled = !!reorder && !!onMoveTo;
            // Drop-line indicator: only paint when ANOTHER row is being
            // dragged and the pointer is currently over this row. The
            // line sits on whichever half the pointer entered last.
            const showLineAbove = dragKey && dragKey !== c.key
              && overIdx === idx && placement === 'before';
            const showLineBelow = dragKey && dragKey !== c.key
              && overIdx === idx && placement === 'after';
            return (
              <div
                key={c.key}
                draggable={dragEnabled}
                onDragStart={(e) => {
                  if (!dragEnabled) return;
                  setDragKey(c.key);
                  // Required for Firefox to actually start the drag.
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', c.key);
                }}
                onDragOver={(e) => {
                  if (!dragEnabled || !dragKey || dragKey === c.key) return;
                  // Vertical midpoint of THIS row decides whether the
                  // drop lands above or below. Compare with bounding
                  // rect each move so reordered rows stay accurate.
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const midY = rect.top + rect.height / 2;
                  setOverIdx(idx);
                  setPlacement(e.clientY < midY ? 'before' : 'after');
                }}
                onDrop={(e) => {
                  if (!dragEnabled || !dragKey || !onMoveTo) return;
                  e.preventDefault();
                  if (dragKey === c.key) { setDragKey(null); setOverIdx(null); return; }
                  // Translate (target row + placement) to an absolute
                  // index in the moved-out list. We send the target the
                  // user pointed at; moveColumnTo splices into that slot.
                  // "after" means insert at idx+1; if the source sits
                  // above the target, removing it first shifts the
                  // target index down by 1, so we adjust.
                  const sourceIdx = columns.findIndex(col => col.key === dragKey);
                  let target = placement === 'before' ? idx : idx + 1;
                  if (sourceIdx !== -1 && sourceIdx < target) target -= 1;
                  onMoveTo(dragKey, target);
                  setDragKey(null);
                  setOverIdx(null);
                }}
                onDragEnd={() => {
                  // Catch-all so a drop outside any row clears state.
                  setDragKey(null);
                  setOverIdx(null);
                }}
                className="flex items-center gap-2 transition-colors"
                style={{
                  position:   'relative',
                  padding:    '6px 8px 6px 12px',
                  fontSize:   13,
                  color:      'var(--gc-text-1)',
                  background: 'transparent',
                  opacity:    isDragging ? 0.4 : 1,
                }}
                onMouseEnter={e => { if (!dragKey) (e.currentTarget as HTMLElement).style.background = '#f8f9fa'; }}
                onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = 'transparent')}>
                {/* Top / bottom drop-line indicators — sit absolutely
                    inside the row so they don't shift its height. */}
                {showLineAbove && (
                  <div aria-hidden style={{
                    position: 'absolute', top: -1, left: 8, right: 8, height: 2,
                    background: 'var(--gc-blue)', borderRadius: 1, pointerEvents: 'none',
                  }} />
                )}
                {showLineBelow && (
                  <div aria-hidden style={{
                    position: 'absolute', bottom: -1, left: 8, right: 8, height: 2,
                    background: 'var(--gc-blue)', borderRadius: 1, pointerEvents: 'none',
                  }} />
                )}
                {dragEnabled && (
                  <span
                    aria-label={`Drag to reorder ${c.pickerLabel ?? c.header}`}
                    title="Drag to reorder"
                    className="flex items-center justify-center shrink-0"
                    style={{
                      width: 16, height: 22, marginLeft: -4,
                      color: 'var(--gc-text-3)',
                      cursor: 'grab',
                    }}>
                    <GripVertical size={13} />
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const next = new Set(hidden);
                    if (isHidden) next.delete(c.key);
                    else          next.add(c.key);
                    onChange(next);
                  }}
                  className="flex items-center gap-2 flex-1 text-left"
                  style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}>
                  <CheckBox checked={!isHidden} onChange={() => { /* button handles */ }} aria-hidden />
                  <span className="flex-1">{c.pickerLabel ?? c.header}</span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CheckBox({
  checked, indeterminate, onChange, ...rest
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'checked' | 'onChange' | 'type'>) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      className="cursor-pointer"
      style={{ width: 14, height: 14, accentColor: 'var(--gc-blue)' }}
      {...rest}
    />
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
