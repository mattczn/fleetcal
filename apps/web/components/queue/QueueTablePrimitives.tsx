'use client';

/**
 * Shared visual primitives for the closeout + accounting queue tables.
 *
 * Both pages render data-dense tables of loads / invoices with the same
 * cell padding, color tokens, and chip styling. This module is the one
 * source of truth so they stay in lockstep — if the doc-badge palette
 * or hover behaviour ever changes, it changes in one place.
 *
 * Anything page-specific (column choices, action buttons per row,
 * empty-state copy, filter logic) stays in the page file.
 */

import { useEffect, useRef, useState, forwardRef } from 'react';
import {
  Check, Copy, ArrowUp, ArrowDown, ChevronLeft, ChevronRight, X, MessageSquare, Columns3, Users, GripVertical,
} from 'lucide-react';

// ─── Constants ──────────────────────────────────────────────────────────

/** Currency formatter shared by both queue pages. Whole dollars only —
 *  cents add noise to scannable rate columns. */
export const moneyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
});

/** Short date format: "Jan 5" — used in tables where the year is
 *  implied. Full-year formats live in the detail surfaces. */
export function fmtShortDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Days between `iso` (e.g. a delivery end, an invoice issue date)
 *  and now. Negative values clamp to 0. Invalid dates return 0. */
export function daysSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/** Color band for "age" indicators. Green=fresh, red=stale. The
 *  bucket boundaries deliberately bias short on the early end so a
 *  3-day-old load already looks "yellow"-ish — accounting cares about
 *  speed-to-bill, this isn't merchandise aging on a shelf. */
export function ageColor(days: number): { bg: string; fg: string } {
  if (days <= 1) return { bg: '#dcfce7', fg: '#15803d' };
  if (days <= 3) return { bg: '#fef3c7', fg: '#92400e' };
  if (days <= 7) return { bg: '#fed7aa', fg: '#9a3412' };
  return { bg: '#fee2e2', fg: '#991b1b' };
}

// ─── Th / Td ────────────────────────────────────────────────────────────

export function Th({ children, align = 'left' }: { children?: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th className="px-2.5 py-2 font-extrabold text-[10.5px] uppercase tracking-wider whitespace-nowrap"
      style={{ color: 'var(--gc-text-2)', textAlign: align }}>
      {children}
    </th>
  );
}

export function Td({
  children, align = 'left', className, onClick,
}: {
  children:   React.ReactNode;
  align?:     'left' | 'right';
  className?: string;
  onClick?:   (e: React.MouseEvent) => void;
}) {
  return (
    <td className={`px-2.5 py-2 font-medium ${className ?? ''}`}
      style={{ textAlign: align, color: 'var(--gc-text-1)' }}
      onClick={onClick}>
      {children}
    </td>
  );
}

/**
 * Sortable column header. Click to toggle asc → desc → off. Same
 * visual chrome as the static Th so columns line up. `key` is opaque
 * to the primitive — the caller decides what to sort by.
 */
export function SortTh<K extends string>({
  colKey, label, align = 'left', sort, onSort,
}: {
  colKey: K;
  label:  string;
  align?: 'left' | 'right';
  sort:   { key: K | null; dir: 'asc' | 'desc' };
  onSort: (next: { key: K | null; dir: 'asc' | 'desc' }) => void;
}) {
  const active = sort.key === colKey;
  return (
    <th className="px-3 py-2.5"
      style={{ textAlign: align, cursor: 'pointer', userSelect: 'none' }}
      onClick={() => {
        if (!active) onSort({ key: colKey, dir: 'asc' });
        else if (sort.dir === 'asc') onSort({ key: colKey, dir: 'desc' });
        else onSort({ key: null, dir: 'asc' });
      }}>
      <span className={`inline-flex items-center gap-1 font-extrabold text-[11px] uppercase tracking-wider transition-colors`}
        style={{ color: active ? 'var(--gc-text-1)' : 'var(--gc-text-2)' }}>
        {label}
        {active && (
          sort.dir === 'asc'
            ? <ArrowUp   size={11} />
            : <ArrowDown size={11} />
        )}
      </span>
    </th>
  );
}

// ─── DocBadge ───────────────────────────────────────────────────────────

const DOC_BADGE_TINT: Record<string, string> = {
  RC:       '#5b21b6', // Rate Con — Indigo
  POD:      '#188038', // Green
  BOL:      '#1a73e8', // Blue
  Scale:    '#e37400', // Orange
  Lumper:   '#a16207', // Amber
  Receipt:  '#c2185b', // Pink
  Driver:   '#00838f', // Teal
  Invoice:  '#7b1fa2', // Purple
  Other:    '#5f6368', // Gray
};

export function DocBadge({ label, count }: { label: string; count?: number }) {
  const bg = DOC_BADGE_TINT[label] ?? DOC_BADGE_TINT.Other;
  return (
    <span className="px-2 py-0.5 rounded-lg text-[10px] font-extrabold tabular-nums"
      title={`${count ?? ''} ${label}`.trim()}
      style={{ background: bg, color: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.08)' }}>
      {label}{count && count > 1 ? ` ×${count}` : ''}
    </span>
  );
}

// ─── Copy-to-clipboard cells ────────────────────────────────────────────

export function CopyableLoadNum({ value }: { value: string }) {
  return <CopyableCell value={value} displayValue={`#${value}`} title="Copy load #" />;
}

/** Click-to-copy text cell with a 1.5s "Copied!" green flip. Used for
 *  load # and internal load id (which doubles as the invoice number). */
export function CopyableCell({
  value, displayValue, title,
}: {
  value:        string;
  displayValue: string;
  title:        string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button"
      onClick={async e => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard blocked — silent */ }
      }}
      className="font-semibold inline-flex items-center gap-1 text-[13px] rounded px-1.5 py-0.5 transition-colors tabular-nums"
      style={{
        color:      copied ? '#15803d' : 'var(--gc-text-1)',
        background: copied ? '#dcfce7' : 'transparent',
      }}
      title={copied ? 'Copied!' : title}
      onMouseEnter={e => { if (!copied) e.currentTarget.style.background = 'var(--gc-hover)'; }}
      onMouseLeave={e => { if (!copied) e.currentTarget.style.background = 'transparent'; }}>
      {displayValue}
      {copied
        ? <Check size={11} style={{ color: '#15803d' }} />
        : <Copy  size={11} style={{ color: 'var(--gc-text-3)' }} />}
    </button>
  );
}

// ─── PaginationFooter ───────────────────────────────────────────────────

export function PaginationFooter({
  page, pageSize, total, onPrev, onNext,
}: {
  page:     number;
  pageSize: number;
  total:    number;
  onPrev:   () => void;
  onNext:   () => void;
}) {
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end   = Math.min((page + 1) * pageSize, total);
  const atStart = page === 0;
  const atEnd   = end >= total;
  return (
    <div className="flex items-center justify-between px-4 py-3"
      style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
      <div className="text-[12px] tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
        Showing <span style={{ color: 'var(--gc-text-1)', fontWeight: 600 }}>{start.toLocaleString()}–{end.toLocaleString()}</span>
        {' '}of <span style={{ color: 'var(--gc-text-1)', fontWeight: 600 }}>{total.toLocaleString()}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={onPrev} disabled={atStart}
          className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-lg transition-colors"
          style={{
            border:     '1px solid var(--gc-border)',
            background: 'var(--gc-surface)',
            color:      atStart ? 'var(--gc-text-3)' : 'var(--gc-text-1)',
            opacity:    atStart ? 0.5 : 1,
            cursor:     atStart ? 'not-allowed' : 'pointer',
          }}>
          <ChevronLeft size={13} /> Prev
        </button>
        <button type="button" onClick={onNext} disabled={atEnd}
          className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-lg transition-colors"
          style={{
            border:     '1px solid var(--gc-border)',
            background: 'var(--gc-surface)',
            color:      atEnd ? 'var(--gc-text-3)' : 'var(--gc-text-1)',
            opacity:    atEnd ? 0.5 : 1,
            cursor:     atEnd ? 'not-allowed' : 'pointer',
          }}>
          Next <ChevronRight size={13} />
        </button>
      </div>
    </div>
  );
}

// ─── Sort + filter state shapes ─────────────────────────────────────────
//
// The column system is generic over a string column-key type. Each
// page defines its own union of column keys and threads it through
// the sort + filter state.

export interface QueueSortState {
  key: string | null;
  dir: 'asc' | 'desc';
}
export type QueueFilterState = Record<string, string[]>;

// ─── MenuTh — sortable + filter-aware column header ─────────────────────

export function MenuTh({
  col, label, align, sort, selectedCount, setHeaderRef, onClick, dragProps, isDragging,
}: {
  col:           string;
  label:         string;
  align:         'left' | 'right';
  sort:          QueueSortState;
  /** How many filter values are currently selected for this column. */
  selectedCount: number;
  setHeaderRef:  (el: HTMLTableCellElement | null) => void;
  onClick:       () => void;
  /** Spread onto the <th> to enable drag-to-reorder via
   *  useColumnOrder.getHeaderProps. Optional — pages that don't want
   *  reordering can omit it. */
  dragProps?: React.HTMLAttributes<HTMLTableCellElement> & { draggable?: boolean; 'data-dragcol'?: string };
  isDragging?: boolean;
}) {
  const sortActive   = sort.key === col;
  const filterActive = selectedCount > 0;
  const anyActive    = sortActive || filterActive;
  return (
    <th
      ref={setHeaderRef}
      onClick={onClick}
      {...(dragProps ?? {})}
      className="px-2.5 py-2 font-extrabold text-[10.5px] uppercase tracking-wider select-none cursor-pointer hover:bg-[var(--gc-hover)] transition-colors whitespace-nowrap"
      style={{
        color:      anyActive ? 'var(--gc-text-1)' : 'var(--gc-text-2)',
        textAlign:  align,
        background: anyActive ? 'rgba(26,115,232,0.06)' : isDragging ? 'rgba(26,115,232,0.18)' : undefined,
        opacity:    isDragging ? 0.6 : 1,
      }}
      title={dragProps ? 'Click for sort + filter — drag to reorder' : 'Click for sort + filter'}>
      <span className="inline-flex items-center gap-1" style={{ flexDirection: align === 'right' ? 'row-reverse' : 'row' }}>
        {label}
        {sortActive ? (
          sort.dir === 'asc'
            ? <ArrowUp   size={11} style={{ color: 'var(--gc-blue)' }} />
            : <ArrowDown size={11} style={{ color: 'var(--gc-blue)' }} />
        ) : null}
        {filterActive && (
          <span title={`${selectedCount} selected`}
            className="text-[9px] font-bold tabular-nums px-1 rounded-lg"
            style={{ background: 'var(--gc-blue)', color: '#fff', minWidth: 14, textAlign: 'center', lineHeight: '14px' }}>
            {selectedCount}
          </span>
        )}
      </span>
    </th>
  );
}

// ─── HeaderMenu — popover with sort + multi-select filter ───────────────

export const HeaderMenu = forwardRef<HTMLDivElement, {
  col:           string;
  anchorEl:      HTMLElement | null;
  sort:          QueueSortState;
  filterable:    boolean;
  selected:      string[];
  options:       string[];
  onSort:        (dir: 'asc' | 'desc' | null) => void;
  onToggleValue: (val: string) => void;
  onClearFilter: () => void;
  onSelectAll:   () => void;
  onClose:       () => void;
}>(function HeaderMenu({
  col, anchorEl, sort, filterable, selected, options,
  onSort, onToggleValue, onClearFilter, onSelectAll, onClose,
}, ref) {
  const [pos, setPos]   = useState<{ left: number; top: number } | null>(null);
  const [search, setSearch] = useState('');
  useEffect(() => {
    if (!anchorEl) { setPos(null); return; }
    const update = () => {
      const r = anchorEl.getBoundingClientRect();
      setPos({ left: r.left, top: r.bottom });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorEl]);
  if (!pos) return null;

  const filteredOptions = search.trim() === ''
    ? options
    : options.filter(o => o.toLowerCase().includes(search.toLowerCase()));
  const selectedSet = new Set(selected);
  const allSelected = options.length > 0 && options.every(o => selectedSet.has(o));

  return (
    <div ref={ref} className="rounded-xl py-1.5"
      style={{
        position: 'fixed', left: pos.left, top: pos.top + 4, zIndex: 50,
        background: 'var(--gc-surface)', border: '1px solid var(--gc-border)',
        boxShadow: '0 12px 32px rgba(0,0,0,0.15)', minWidth: 240, maxWidth: 340,
      }}>
      {/* Sort group */}
      <div className="px-3 pt-1 pb-1.5 text-[10px] uppercase tracking-wider font-semibold"
        style={{ color: 'var(--gc-text-3)' }}>Sort</div>
      <MenuRow active={sort.key === col && sort.dir === 'asc'}
        icon={<ArrowUp size={12} />} label="Ascending"
        onClick={() => onSort('asc')} />
      <MenuRow active={sort.key === col && sort.dir === 'desc'}
        icon={<ArrowDown size={12} />} label="Descending"
        onClick={() => onSort('desc')} />
      {sort.key === col && (
        <MenuRow icon={<X size={12} />} label="Clear sort" onClick={() => onSort(null)} muted />
      )}

      {/* Filter — only when this column carries discrete values */}
      {filterable && (
        <>
          <div className="my-1" style={{ borderTop: '1px solid var(--gc-border-light)' }} />
          <div className="px-3 pt-1 pb-1.5 text-[10px] uppercase tracking-wider font-semibold flex items-center justify-between"
            style={{ color: 'var(--gc-text-3)' }}>
            <span>Filter {selected.length > 0 && (
              <span className="ml-1 text-[10px] font-semibold normal-case tracking-normal" style={{ color: 'var(--gc-text-2)' }}>({selected.length})</span>
            )}</span>
            <span className="flex items-center gap-2">
              <button onClick={() => { allSelected ? onClearFilter() : onSelectAll(); }}
                className="text-[10px] font-semibold normal-case tracking-normal"
                style={{ color: 'var(--gc-blue)' }}>
                {allSelected ? 'Deselect all' : 'Select all'}
              </button>
              {selected.length > 0 && !allSelected && (
                <button onClick={onClearFilter}
                  className="text-[10px] font-semibold normal-case tracking-normal"
                  style={{ color: 'var(--gc-text-2)' }}>Clear</button>
              )}
            </span>
          </div>
          {options.length > 8 && (
            <div className="px-2 pb-1.5">
              <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search…"
                className="w-full text-[11px] px-2 py-1 rounded-md outline-none"
                style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)', color: 'var(--gc-text-1)' }} />
            </div>
          )}
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-2 text-[12px] italic" style={{ color: 'var(--gc-text-3)' }}>No options</div>
            ) : (
              filteredOptions.map(opt => (
                <CheckboxMenuRow key={opt}
                  checked={selectedSet.has(opt)}
                  label={opt}
                  onToggle={() => onToggleValue(opt)} />
              ))
            )}
          </div>
          <div className="px-2 pt-1.5 pb-1" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
            <button onClick={onClose}
              className="w-full text-[12px] font-semibold py-1.5 rounded-lg transition-colors"
              style={{ background: '#1a73e8', color: '#fff' }}>
              Done
            </button>
          </div>
        </>
      )}
    </div>
  );
});

function MenuRow({
  icon, label, onClick, active, muted,
}: {
  icon?: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  muted?:  boolean;
}) {
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left transition-colors hover:bg-[var(--gc-hover)]"
      style={{
        background: active ? 'rgba(26,115,232,0.10)' : 'transparent',
        color:      muted ? 'var(--gc-text-3)' : active ? 'var(--gc-blue)' : 'var(--gc-text-1)',
        fontWeight: active ? 600 : 400,
      }}>
      {icon && <span className="flex-none">{icon}</span>}
      <span className="flex-1">{label}</span>
      {active && <Check size={12} className="flex-none" />}
    </button>
  );
}

function CheckboxMenuRow({
  checked, label, onToggle,
}: {
  checked: boolean;
  label:   string;
  onToggle: () => void;
}) {
  return (
    <label className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left cursor-pointer transition-colors hover:bg-[var(--gc-hover)]"
      style={{ color: 'var(--gc-text-1)' }}>
      <input type="checkbox" checked={checked} onChange={onToggle}
        className="flex-none" style={{ accentColor: '#1a73e8' }} />
      <span className="truncate flex-1">{label}</span>
    </label>
  );
}

// ─── ColumnsMenu — show/hide column toggle ──────────────────────────────

export function ColumnsMenu({
  columns, visible, onToggle,
}: {
  columns:  Array<{ key: string; label: string }>;
  visible:  Record<string, boolean>;
  onToggle: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
        style={{ border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)', background: 'var(--gc-surface)' }}>
        <Columns3 size={12} /> Columns
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 rounded-xl py-1.5"
          style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', minWidth: 200, maxHeight: 380, overflowY: 'auto' }}>
          {columns.map(c => (
            <label key={c.key}
              className="flex items-center gap-2 px-3 py-1.5 text-[12px] cursor-pointer hover:bg-[var(--gc-hover)]"
              style={{ color: 'var(--gc-text-1)' }}>
              <input type="checkbox" checked={!!visible[c.key]} onChange={() => onToggle(c.key)}
                style={{ accentColor: '#1a73e8' }} />
              {c.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── NotesButton — internal notes indicator + opener ────────────────────

export function NotesButton({
  count, onOpen,
}: {
  count:  number;
  onOpen: () => void;
}) {
  const has = count > 0;
  return (
    <button onClick={e => { e.stopPropagation(); onOpen(); }}
      className="rounded-full p-1 transition-colors relative"
      title={has ? `${count} internal note${count !== 1 ? 's' : ''}` : 'Add internal note'}
      style={{
        background: has ? '#dbeafe' : 'transparent',
        border:     `1px solid ${has ? '#1a73e8' : 'var(--gc-border)'}`,
        color:      has ? '#1a73e8' : 'var(--gc-text-3)',
      }}>
      <MessageSquare size={11} fill={has ? '#1a73e8' : 'none'} stroke={has ? '#1a73e8' : 'currentColor'} />
      {has && count > 1 && (
        <span className="absolute -top-1 -right-1 text-[8px] font-bold rounded-lg px-1 leading-3 tabular-nums"
          style={{ background: '#1a73e8', color: '#fff', minWidth: 12, textAlign: 'center' }}>
          {count}
        </span>
      )}
    </button>
  );
}

// ─── CustomerFilterDropdown ─────────────────────────────────────────────
//
// Toolbar-level multi-select for filtering by customer. Drives whatever
// `filters.customer` state the caller passes in. The accounting and
// closeout pages both render this in their toolbar so the surface for
// selecting brokers is consistent across queues.

export function CustomerFilterDropdown({
  options, selected, onChange,
}: {
  options:  string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen]     = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const filtered = search.trim() === ''
    ? options
    : options.filter(o => o.toLowerCase().includes(search.toLowerCase()));
  const selectedSet = new Set(selected);
  const allSelected = options.length > 0 && options.every(o => selectedSet.has(o));

  function toggle(val: string) {
    const next = new Set(selected);
    if (next.has(val)) next.delete(val); else next.add(val);
    onChange(Array.from(next));
  }

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
        style={{
          border:     `1px solid ${selected.length > 0 ? 'var(--gc-blue)' : 'var(--gc-border)'}`,
          color:      selected.length > 0 ? 'var(--gc-blue)' : 'var(--gc-text-2)',
          background: selected.length > 0 ? 'rgba(26,115,232,0.06)' : 'var(--gc-surface)',
        }}>
        <Users size={12} /> Customer
        {selected.length > 0 && (
          <span className="text-[10px] font-bold tabular-nums px-1.5 rounded-full"
            style={{ background: 'var(--gc-blue)', color: '#fff', minWidth: 16, textAlign: 'center', lineHeight: '14px' }}>
            {selected.length}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute z-50 mt-1 rounded-xl py-1.5"
          style={{
            top: '100%', left: 0,
            background: 'var(--gc-surface)', border: '1px solid var(--gc-border)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.15)',
            minWidth: 280, maxWidth: 340,
          }}>
          <div className="px-3 pt-1 pb-1.5 text-[10px] uppercase tracking-wider font-semibold flex items-center justify-between"
            style={{ color: 'var(--gc-text-3)' }}>
            <span>
              Customer
              {selected.length > 0 && (
                <span className="ml-1 normal-case tracking-normal text-[10px] font-semibold" style={{ color: 'var(--gc-text-2)' }}>
                  ({selected.length})
                </span>
              )}
            </span>
            <span className="flex items-center gap-2">
              <button onClick={() => onChange(allSelected ? [] : [...options])}
                className="text-[10px] font-semibold normal-case tracking-normal"
                style={{ color: 'var(--gc-blue)' }}>
                {allSelected ? 'Deselect all' : 'Select all'}
              </button>
              {selected.length > 0 && !allSelected && (
                <button onClick={() => onChange([])}
                  className="text-[10px] font-semibold normal-case tracking-normal"
                  style={{ color: 'var(--gc-text-2)' }}>
                  Clear
                </button>
              )}
            </span>
          </div>
          <div className="px-2 pb-1.5">
            <input type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search customers…"
              className="w-full text-[11px] px-2 py-1 rounded-md outline-none"
              style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)', color: 'var(--gc-text-1)' }} />
          </div>
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[12px] italic" style={{ color: 'var(--gc-text-3)' }}>
                No matches
              </div>
            ) : (
              filtered.map(o => (
                <label key={o}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] cursor-pointer hover:bg-[var(--gc-hover)]"
                  style={{ color: 'var(--gc-text-1)' }}>
                  <input type="checkbox" checked={selectedSet.has(o)} onChange={() => toggle(o)}
                    style={{ accentColor: '#1a73e8' }} />
                  <span className="truncate flex-1">{o}</span>
                </label>
              ))
            )}
          </div>
          <div className="px-2 pt-1.5 pb-1" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
            <button onClick={() => setOpen(false)}
              className="w-full text-[12px] font-semibold py-1.5 rounded-lg transition-colors"
              style={{ background: '#1a73e8', color: '#fff' }}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── useColumnOrder ─────────────────────────────────────────────────────
//
// Drag-to-reorder column hook for queue tables. Persists order under the
// supplied storage key. Returns the current order, a setter, and the
// HTML-DnD handlers ready to spread onto each draggable <th>.
//
// Usage:
//   const { order, setOrder, getRootProps, getHeaderProps } =
//     useColumnOrder<ColKey>('closeout-cols-order-v2', defaultOrder);
//   ... render header cells with {...getHeaderProps(col)}
//
// Implementation notes:
// - HTML5 native DnD (no library) — handlers attached to each <th>.
// - dragOver moves the row of dragged column header to the position
//   under the cursor IMMEDIATELY (so the user sees the reflow live).
// - drop just commits — the move already happened on dragOver.
// - We tolerate unknown keys in the stored order (drops them on load)
//   and append any newly-added columns to the end (so renaming/adding
//   columns in code doesn't blow away user preferences).

export function useColumnOrder<K extends string>(
  storageKey: string,
  defaultOrder: readonly K[],
): {
  order: K[];
  setOrder: (next: K[]) => void;
  getHeaderProps: (col: K) => {
    draggable: true;
    onDragStart: (e: React.DragEvent) => void;
    onDragOver:  (e: React.DragEvent) => void;
    onDragEnd:   (e: React.DragEvent) => void;
    onDrop:      (e: React.DragEvent) => void;
    'data-dragcol': K;
  };
  draggingCol: K | null;
} {
  const valid = new Set(defaultOrder);
  const [order, setOrderState] = useState<K[]>(() => {
    if (typeof window === 'undefined') return [...defaultOrder];
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return [...defaultOrder];
      const parsed = JSON.parse(raw) as K[];
      if (!Array.isArray(parsed)) return [...defaultOrder];
      // Drop unknown keys; append newly-added keys to the end so code
      // changes don't wipe user preferences.
      const filtered = parsed.filter(k => valid.has(k));
      const missing  = defaultOrder.filter(k => !filtered.includes(k));
      return [...filtered, ...missing];
    } catch { return [...defaultOrder]; }
  });

  const setOrder = (next: K[]) => {
    setOrderState(next);
    try { window.localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* quota / private mode */ }
  };

  const [draggingCol, setDraggingCol] = useState<K | null>(null);

  function move(from: K, to: K) {
    if (from === to) return;
    setOrderState(prev => {
      const i = prev.indexOf(from);
      const j = prev.indexOf(to);
      if (i < 0 || j < 0) return prev;
      const next = [...prev];
      next.splice(i, 1);
      next.splice(j, 0, from);
      try { window.localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* */ }
      return next;
    });
  }

  function getHeaderProps(col: K) {
    return {
      draggable: true as const,
      'data-dragcol': col,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', col);
        setDraggingCol(col);
      },
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        // Live reorder — find the nearest header under the pointer and
        // move the dragged column to that position. Reading the data
        // attribute keeps us from depending on DOM closure.
        const overEl = (e.currentTarget as HTMLElement).closest('[data-dragcol]') as HTMLElement | null;
        const overCol = overEl?.dataset.dragcol as K | undefined;
        if (draggingCol && overCol && overCol !== draggingCol) {
          move(draggingCol, overCol);
        }
      },
      onDragEnd: () => setDraggingCol(null),
      onDrop:    (e: React.DragEvent) => { e.preventDefault(); setDraggingCol(null); },
    };
  }

  return { order, setOrder, getHeaderProps, draggingCol };
}

// ─── DragHandle ─────────────────────────────────────────────────────────
//
// Tiny visual cue that a header cell is reorderable. Renders just the
// grip icon — the actual DnD lives on the parent <th> via
// useColumnOrder's getHeaderProps.

export function DragHandle() {
  return (
    <GripVertical size={11}
      className="opacity-0 group-hover:opacity-100 transition-opacity cursor-grab"
      style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />
  );
}
