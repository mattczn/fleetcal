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
import { createPortal } from 'react-dom';
import {
  Check, ArrowUp, ArrowDown, ChevronLeft, ChevronRight, X, MessageSquare, Columns3, Users, GripVertical,
  User as UserIcon, Truck as TruckIcon,
  type LucideIcon,
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
      style={{
        textAlign: align,
        color: 'var(--gc-text-1)',
        // table-layout: fixed lets columns be narrower than content;
        // clip cleanly so cells don't bleed into each other.
        overflow: 'hidden',
      }}
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
  const countSuffix = count && count > 1 ? ` (×${count})` : '';
  return (
    <FastTooltip text={`${label} — Present${countSuffix}`}>
      <span className="px-2 py-0.5 rounded-lg text-[10px] font-extrabold tabular-nums"
        style={{ background: bg, color: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.08)' }}>
        {label}{count && count > 1 ? ` ×${count}` : ''}
      </span>
    </FastTooltip>
  );
}

/**
 * Required-doc slot — always renders, even when the doc is missing.
 *
 * Present  → opaque tint + white text (visually identical to DocBadge).
 * Missing  → transparent background, dashed red border + red text. The
 *            slot reads as "expected but not uploaded yet" without
 *            adding a separate FlagChip line.
 *
 * Used for RC (every row) and POD (every non-TONU row) in the
 * Paperwork + Billing loads tables.
 */
export function RequiredDocBadge({
  label, present, count, presentTint, missingTitle: _ignoredMissingTitle,
}: {
  label:        string;
  present:      boolean;
  count?:       number;
  /** Background colour when the doc is present. Defaults to the tint
   *  registered in DOC_BADGE_TINT for `label`, falling back to Other. */
  presentTint?: string;
  /** @deprecated Hover text is now uniformly "{label} — Present/Missing".
   *  Prop kept on the signature so existing call sites don't break, but
   *  the value is no longer surfaced anywhere. */
  missingTitle?: string;
}) {
  if (present) {
    const bg = presentTint ?? DOC_BADGE_TINT[label] ?? DOC_BADGE_TINT.Other;
    const countSuffix = count && count > 1 ? ` (×${count})` : '';
    return (
      <FastTooltip text={`${label} — Present${countSuffix}`}>
        <span className="px-2 py-0.5 rounded-lg text-[10px] font-extrabold tabular-nums"
          style={{ background: bg, color: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.08)' }}>
          {label}{count && count > 1 ? ` ×${count}` : ''}
        </span>
      </FastTooltip>
    );
  }
  return (
    <FastTooltip text={`${label} — Missing`}>
      <span className="rounded-lg text-[10px] font-extrabold tabular-nums"
        style={{
          background: 'transparent',
          color:      '#991b1b',
          border:     '1px dashed #991b1b',
          // Subtract the 1px border so the missing chip lines up at the
          // same height as the opaque present chips (which have no
          // border but do have the same vertical padding).
          padding:    '1px 7px',
        }}>
        {label}
      </span>
    </FastTooltip>
  );
}

// ─── Fast tooltip ───────────────────────────────────────────────────────

/**
 * Small zero-dependency tooltip with a configurable hover delay.
 *
 * Why this exists: the native `title=` attribute waits ~1-2 s before
 * surfacing, which makes the doc-badge present/missing hint feel
 * broken on first hover. FastTooltip shows after `delay` ms (default
 * 80) and disappears immediately on leave.
 *
 * Positioning is `position: fixed` with coords derived from the
 * trigger's bounding rect. The tooltip body is rendered through a
 * portal into document.body so it joins the topmost stacking context
 * — without the portal, sticky table headers (zIndex: 2-3 inside
 * their own stacking context) would clip the tooltip even though
 * z-[1000] would normally beat them.
 */
export function FastTooltip({
  text, children, delay = 80,
}: {
  text:     string;
  children: React.ReactNode;
  /** ms to wait after mouseenter before showing. Default 80 ms. */
  delay?:   number;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const timerRef = useRef<number | null>(null);

  // Wait for client-side mount before reaching for document.body —
  // SSR would crash on `createPortal(_, document.body)` during the
  // first render pass.
  useEffect(() => { setMounted(true); }, []);

  const show = () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      setPos({ top: r.top - 4, left: r.left + r.width / 2 });
    }, delay);
  };
  const hide = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPos(null);
  };

  const tooltipNode = pos && (
    <div
      className="fixed px-2 py-1 rounded-md pointer-events-none whitespace-nowrap"
      style={{
        top:        pos.top,
        left:       pos.left,
        transform:  'translate(-50%, -100%)',
        background: 'rgba(32, 33, 36, 0.94)',
        color:      '#fff',
        fontSize:   11,
        fontWeight: 600,
        boxShadow:  '0 4px 12px rgba(0,0,0,0.18)',
        // Inline zIndex so the portal target body's stacking context
        // doesn't pin us behind any z-[1000] modal that happens to be
        // open. 10000 sits above ConfirmDialog (z-260) and well above
        // the OpsTable sticky chrome.
        zIndex:     10_000,
      }}
    >
      {text}
    </div>
  );

  return (
    <>
      <span ref={triggerRef} onMouseEnter={show} onMouseLeave={hide} className="inline-flex">
        {children}
      </span>
      {mounted && tooltipNode && createPortal(tooltipNode, document.body)}
    </>
  );
}

// ─── Accessorials cell ──────────────────────────────────────────────────

/** Display labels for accessorial categories. Mirrors the ones used in
 *  FollowUpModal + ReviewQueue so the popover reads the same as the
 *  rest of the system. Unknown categories fall back to the raw string. */
export const ACCESSORIAL_LABEL: Record<string, string> = {
  detention:    'Detention',
  lumper:       'Lumper',
  layover:      'Layover',
  scale_ticket: 'Scale',
  extra_stop:   'Extra stop',
  other:        'Accessorial',
};

type AccessorialItem = {
  id?:          string;
  category:     string;
  amount?:      number | null;
  description?: string | null;
  status?:      'requested' | 'approved' | 'denied';
};

/**
 * Right-aligned cell for the Accessorials column.
 *
 * Collapsed view shows the sum + item count ("$468 / 5 items"). On
 * hover, a fixed-position popover anchored to the cell's bottom-right
 * lists every line — category, optional description, status pill, and
 * amount — with a Total footer. Position is computed from
 * getBoundingClientRect so the popover escapes table overflow without
 * needing a portal.
 *
 * Renders "—" when there are no accessorials.
 */
export function AccessorialsCell({ items }: { items?: AccessorialItem[] }) {
  const list = items ?? [];
  const count = list.length;
  const sum = list.reduce((s, a) => s + (a.amount ?? 0), 0);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [popPos, setPopPos] = useState<{ top: number; right: number } | null>(null);

  if (count === 0) return <span style={{ color: 'var(--gc-text-3)' }}>—</span>;

  const openPopover = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    setPopPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
  };

  return (
    <>
      <span
        ref={triggerRef}
        className="inline-block cursor-default"
        onMouseEnter={openPopover}
        onMouseLeave={() => setPopPos(null)}
      >
        <div className="tabular-nums">{moneyFmt.format(sum)}</div>
        <div className="text-[10px]" style={{ color: 'var(--gc-text-3)' }}>
          {count} item{count !== 1 ? 's' : ''}
        </div>
      </span>
      {popPos && (
        <div
          className="fixed z-[100] min-w-[260px] rounded-lg p-2.5 text-left pointer-events-none"
          style={{
            top:        popPos.top,
            right:      popPos.right,
            background: 'var(--gc-surface)',
            border:     '1px solid var(--gc-border)',
            boxShadow:  '0 8px 24px rgba(0,0,0,0.12)',
          }}
        >
          <ul className="space-y-1">
            {list.map((a, i) => {
              const status = a.status ?? 'requested';
              const statusTint =
                status === 'approved' ? { fg: '#15803d', label: 'Approved' } :
                status === 'denied'   ? { fg: '#991b1b', label: 'Denied'   } :
                                        { fg: '#92400e', label: 'Pending'  };
              return (
                <li key={a.id ?? i} className="flex items-start justify-between gap-3 text-[12px]">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                        {ACCESSORIAL_LABEL[a.category] ?? a.category}
                      </span>
                      <span
                        className="text-[9.5px] font-bold uppercase tracking-wider"
                        style={{ color: statusTint.fg }}
                      >
                        {statusTint.label}
                      </span>
                    </div>
                    {a.description && (
                      <div className="text-[11px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                        {a.description}
                      </div>
                    )}
                  </div>
                  <span className="tabular-nums font-semibold shrink-0" style={{ color: 'var(--gc-text-1)' }}>
                    {a.amount != null ? moneyFmt.format(a.amount) : '—'}
                  </span>
                </li>
              );
            })}
          </ul>
          <div
            className="mt-2 pt-2 flex justify-between text-[11.5px] font-bold"
            style={{ borderTop: '1px solid var(--gc-border-light)', color: 'var(--gc-text-1)' }}
          >
            <span>Total</span>
            <span className="tabular-nums">{moneyFmt.format(sum)}</span>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Copy-to-clipboard cells ────────────────────────────────────────────

export function CopyableLoadNum({ value }: { value: string }) {
  return <CopyableCell value={value} displayValue={`#${value}`} title="Copy load #" />;
}

/** Click-to-copy text cell with a 1.5s "Copied!" green flip. Used for
 *  load # and internal load id (which doubles as the invoice number).
 *  The displayed text swaps to "Copied!" on click so the confirmation
 *  is unmissable — a small check icon next to the original value is
 *  too easy to overlook. */
export function CopyableCell({
  value, displayValue, title,
}: {
  value:        string;
  displayValue: string;
  title:        string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <FastTooltip text={copied ? 'Copied!' : title}>
      <button type="button"
        onClick={async e => {
          e.stopPropagation();
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch { /* clipboard blocked — silent */ }
        }}
        className="font-semibold inline-flex items-center gap-1 text-[13px] rounded px-1.5 py-0.5 transition-colors tabular-nums w-full"
        style={{
          color:      copied ? '#15803d' : 'var(--gc-text-1)',
          background: copied ? '#dcfce7' : 'transparent',
          justifyContent: 'flex-start',
        }}
        onMouseEnter={e => { if (!copied) e.currentTarget.style.background = 'var(--gc-hover)'; }}
        onMouseLeave={e => { if (!copied) e.currentTarget.style.background = 'transparent'; }}>
        {copied ? (
          <>
            <Check size={12} style={{ color: '#15803d' }} />
            Copied!
          </>
        ) : displayValue}
      </button>
    </FastTooltip>
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
  col, label, align, sort, selectedCount, setHeaderRef, onClick, width, onResizeStart,
}: {
  col:           string;
  label:         string;
  align:         'left' | 'right';
  sort:          QueueSortState;
  /** How many filter values are currently selected for this column. */
  selectedCount: number;
  setHeaderRef:  (el: HTMLTableCellElement | null) => void;
  onClick:       () => void;
  /** Column width in px. With table-layout:fixed on the parent table
   *  this is enforced strictly — columns can be made narrower than
   *  their content, which is the whole point of letting users resize. */
  width?:        number;
  /** Resize-handle mousedown handler from useColumnWidths.getResizeProps. */
  onResizeStart?: (e: React.MouseEvent) => void;
}) {
  const sortActive   = sort.key === col;
  const filterActive = selectedCount > 0;
  const anyActive    = sortActive || filterActive;
  return (
    <th
      ref={setHeaderRef}
      className="px-2.5 py-2 select-none whitespace-nowrap"
      style={{
        color:      anyActive ? 'var(--gc-text-1)' : 'var(--gc-text-2)',
        textAlign:  align,
        background: anyActive ? 'rgba(26,115,232,0.06)' : undefined,
        position:   'relative',
        width:      width != null ? `${width}px` : undefined,
      }}>
      {/* Sort/filter trigger is a button that fills the th's content
          area. The label takes flex: 1 and truncates with "…" when
          the column is too narrow to fit it. */}
      <button
        type="button"
        onClick={onClick}
        className="font-extrabold text-[10.5px] uppercase tracking-wider hover:text-[var(--gc-blue)] transition-colors"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          width: '100%',
          color:  'inherit',
          cursor: 'pointer',
          background: 'transparent',
          border: 'none',
          padding: 0,
          flexDirection: align === 'right' ? 'row-reverse' : 'row',
          textAlign: align,
        }}
        title="Click for sort + filter">
        <span style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          textAlign: align,
        }}>
          {label}
        </span>
        {sortActive ? (
          sort.dir === 'asc'
            ? <ArrowUp   size={11} style={{ color: 'var(--gc-blue)', flexShrink: 0 }} />
            : <ArrowDown size={11} style={{ color: 'var(--gc-blue)', flexShrink: 0 }} />
        ) : null}
        {filterActive && (
          <span title={`${selectedCount} selected`}
            className="text-[9px] font-bold tabular-nums px-1 rounded-lg"
            style={{ background: 'var(--gc-blue)', color: '#fff', minWidth: 14, textAlign: 'center', lineHeight: '14px', flexShrink: 0 }}>
            {selectedCount}
          </span>
        )}
      </button>
      {onResizeStart && (
        <ColumnResizeHandle onMouseDown={onResizeStart} />
      )}
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
      className="rounded-full p-1.5 transition-colors relative"
      title={has ? `${count} internal note${count !== 1 ? 's' : ''}` : 'Add internal note'}
      style={{
        background: has ? '#dbeafe' : 'transparent',
        border:     `1px solid ${has ? '#1a73e8' : 'var(--gc-border)'}`,
        color:      has ? '#1a73e8' : 'var(--gc-text-3)',
        overflow:   'visible',
      }}>
      <MessageSquare size={12} fill={has ? '#1a73e8' : 'none'} stroke={has ? '#1a73e8' : 'currentColor'} />
      {has && (
        <span
          className="absolute text-[9.5px] font-bold rounded-full tabular-nums flex items-center justify-center"
          style={{
            // Anchor INSIDE the button's top-right corner so the badge
            // can never clip the row's vertical bounds. Earlier
            // negative offsets popped the badge 3-5px above the
            // button — fine in isolation, but the first row of the
            // OpsTable sits at the top of the body's overflow:auto
            // viewport, which would clip anything spilling above.
            // The button's p-1.5 padding leaves enough room for the
            // 14px badge to overlap the icon's top-right corner
            // without losing legibility, and the white ring keeps
            // the badge distinct from the button background.
            top:        0,
            right:      0,
            minWidth:   14,
            height:     14,
            padding:    '0 3px',
            background: '#1a73e8',
            color:      '#fff',
            boxShadow:  '0 0 0 1.5px var(--gc-surface)',
            lineHeight: 1,
          }}>
          {count > 9 ? '9+' : count}
        </span>
      )}
    </button>
  );
}

// ─── MultiSelectFilter ──────────────────────────────────────────────────
//
// Generic toolbar multi-select with a configurable label + icon. Used
// by CustomerFilterDropdown, DriverFilterDropdown, AssetFilterDropdown
// (presets below). The accounting + closeout pages render the customer
// preset; /fuel renders driver + asset.

export function MultiSelectFilter({
  label, icon: Icon, searchPlaceholder, options, selected, onChange,
}: {
  label:             string;
  icon:              LucideIcon;
  /** Placeholder for the in-popover search input. Defaults to
   *  "Search {label.toLowerCase()}…". */
  searchPlaceholder?: string;
  options:           string[];
  selected:          string[];
  onChange:          (next: string[]) => void;
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
        <Icon size={12} /> {label}
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
              {label}
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
              placeholder={searchPlaceholder ?? `Search ${label.toLowerCase()}…`}
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

// Common presets — Customer / Driver / Asset. Each is a thin wrapper
// around MultiSelectFilter with the right icon + label. The accounting
// + closeout pages render <CustomerFilterDropdown>; /fuel renders
// <DriverFilterDropdown> + <AssetFilterDropdown>. New filter kinds get
// added by composing MultiSelectFilter directly.

export function CustomerFilterDropdown(props: { options: string[]; selected: string[]; onChange: (next: string[]) => void }) {
  return <MultiSelectFilter label="Customer" icon={Users} {...props} />;
}

export function DriverFilterDropdown(props: { options: string[]; selected: string[]; onChange: (next: string[]) => void }) {
  return <MultiSelectFilter label="Driver" icon={UserIcon} {...props} />;
}

export function AssetFilterDropdown(props: { options: string[]; selected: string[]; onChange: (next: string[]) => void }) {
  return <MultiSelectFilter label="Truck" icon={TruckIcon} {...props} />;
}

// ─── useColumnOrder ─────────────────────────────────────────────────────
//
// State + persistence for the user-controlled column order. Reordering
// happens inside the Columns dropdown (drag rows there), NOT by dragging
// the <th> elements themselves — header drag-to-reorder felt fragile
// next to drag-to-resize, so we moved it into the menu where it's a
// dedicated affordance.
//
// Usage:
//   const { order, setOrder, move } =
//     useColumnOrder<ColKey>('closeout-cols-order-v1', defaultOrder);
//
// Persistence notes:
// - Unknown keys in the stored order are dropped on load (defensive
//   against renamed columns).
// - Newly-added keys (in defaultOrder but not yet stored) append to the
//   end so code changes don't wipe user preferences.

export function useColumnOrder<K extends string>(
  storageKey: string,
  defaultOrder: readonly K[],
): {
  order: K[];
  setOrder: (next: K[]) => void;
  /** Move column `from` to the position currently held by column `to`. */
  move: (from: K, to: K) => void;
  /** Move by index — useful when the caller already knows positions
   *  (e.g. a list with explicit indices). */
  moveIndex: (fromIdx: number, toIdx: number) => void;
} {
  const valid = new Set(defaultOrder);
  const [order, setOrderState] = useState<K[]>(() => {
    if (typeof window === 'undefined') return [...defaultOrder];
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return [...defaultOrder];
      const parsed = JSON.parse(raw) as K[];
      if (!Array.isArray(parsed)) return [...defaultOrder];
      const filtered = parsed.filter(k => valid.has(k));
      const missing  = defaultOrder.filter(k => !filtered.includes(k));
      return [...filtered, ...missing];
    } catch { return [...defaultOrder]; }
  });

  const persist = (next: K[]) => {
    try { window.localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* quota / private mode */ }
  };

  const setOrder = (next: K[]) => { setOrderState(next); persist(next); };

  const move = (from: K, to: K) => {
    if (from === to) return;
    setOrderState(prev => {
      const i = prev.indexOf(from);
      const j = prev.indexOf(to);
      if (i < 0 || j < 0) return prev;
      const next = [...prev];
      next.splice(i, 1);
      next.splice(j, 0, from);
      persist(next);
      return next;
    });
  };

  const moveIndex = (fromIdx: number, toIdx: number) => {
    setOrderState(prev => {
      if (fromIdx < 0 || fromIdx >= prev.length || toIdx < 0 || toIdx >= prev.length || fromIdx === toIdx) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      persist(next);
      return next;
    });
  };

  return { order, setOrder, move, moveIndex };
}

// ─── useColumnWidths ────────────────────────────────────────────────────
//
// State + persistence for user-resized column widths. Drag the right
// edge of a column header to set; the value persists per-user via
// localStorage.
//
// Usage:
//   const { widths, getResizeProps } =
//     useColumnWidths<ColKey>('closeout-cols-widths-v1');
//   ...
//   <MenuTh
//     col={c}
//     width={widths[c]}
//     onResizeStart={getResizeProps(c)}
//     ...
//   />
//
// The hook returns the mousedown handler — the actual resize loop runs
// on window-level mousemove/mouseup listeners (mounted on drag start
// and torn down on drag end). This is how Excel/Sheets do it; tracking
// state on the th itself is brittle because the cursor leaves the th
// during fast drags.

export function useColumnWidths<K extends string>(
  storageKey: string,
): {
  widths: Partial<Record<K, number>>;
  setWidth:   (col: K, w: number) => void;
  resetWidth: (col: K) => void;
  getResizeProps: (col: K) => (e: React.MouseEvent) => void;
} {
  const [widths, setWidthsState] = useState<Partial<Record<K, number>>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return {};
      return JSON.parse(raw) as Partial<Record<K, number>>;
    } catch { return {}; }
  });

  const persist = (next: Partial<Record<K, number>>) => {
    try { window.localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* */ }
  };

  // Minimum column width. Below this the column becomes unreadable.
  const MIN_WIDTH = 50;

  const setWidth = (col: K, w: number) => {
    setWidthsState(prev => {
      const next = { ...prev, [col]: Math.max(MIN_WIDTH, Math.round(w)) } as Partial<Record<K, number>>;
      persist(next);
      return next;
    });
  };

  const resetWidth = (col: K) => {
    setWidthsState(prev => {
      const next = { ...prev };
      delete next[col];
      persist(next);
      return next;
    });
  };

  const getResizeProps = (col: K) => (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const th = (e.currentTarget as HTMLElement).closest('th') as HTMLElement | null;
    if (!th) return;
    const startX = e.clientX;
    const startW = th.getBoundingClientRect().width;
    let liveW = startW;

    const onMove = (ev: MouseEvent) => {
      liveW = Math.max(MIN_WIDTH, startW + (ev.clientX - startX));
      // Update DOM directly during the drag — calling setState on every
      // mousemove would queue dozens of re-renders. We commit to state
      // once on mouseup. With table-layout: fixed on the parent table,
      // setting th.style.width is enough to resize the column live.
      th.style.width = `${liveW}px`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor     = '';
      setWidth(col, liveW);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor     = 'col-resize';
  };

  return { widths, setWidth, resetWidth, getResizeProps };
}

// ─── ColumnResizeHandle ─────────────────────────────────────────────────
//
// 6px-wide drag target absolutely positioned at the right edge of a
// <th>. The handle is invisible by default; on hover the cursor changes
// to col-resize and a thin blue accent line appears so the drag target
// is discoverable.

export function ColumnResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <span
      onMouseDown={onMouseDown}
      onClick={e => e.stopPropagation()}
      className="group/resize"
      style={{
        position:  'absolute',
        top:       0,
        right:     -5,
        bottom:    0,
        width:     10,
        cursor:    'col-resize',
        zIndex:    2,
        userSelect: 'none',
      }}>
      <span
        className="opacity-0 group-hover/resize:opacity-100 transition-opacity"
        style={{
          position:  'absolute',
          top:       4,
          left:      4,
          bottom:    4,
          width:     2,
          background: 'var(--gc-blue)',
          borderRadius: 1,
          pointerEvents: 'none',
        }} />
    </span>
  );
}

// ─── ReorderableColumnsMenu ─────────────────────────────────────────────
//
// Drop-in replacement for ColumnsMenu that adds drag-to-reorder. Each
// row has a grip handle (left) + checkbox + label. Drag the row by the
// handle to move it within the list; the order callback fires with
// new (from, to) indices.

export function ReorderableColumnsMenu({
  columns, visible, onToggle, onReorder,
}: {
  /** Columns in their current order. Drag a row to move it; the order
   *  reflects this list order. */
  columns:   Array<{ key: string; label: string }>;
  visible:   Record<string, boolean>;
  onToggle:  (key: string) => void;
  /** Called with column keys (not indices) so the parent can translate
   *  to whatever ordering scheme it uses — works even when the menu is
   *  showing a filtered subset of the full column order. */
  onReorder: (fromKey: string, toKey: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);

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
          style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', minWidth: 240, maxHeight: 420, overflowY: 'auto' }}>
          <div className="px-3 pt-1 pb-1.5 text-[10px] uppercase tracking-wider font-semibold"
            style={{ color: 'var(--gc-text-3)' }}>
            Show / reorder
          </div>
          {columns.map(c => (
            <div key={c.key}
              draggable
              onDragStart={e => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', c.key);
                setDraggingKey(c.key);
              }}
              onDragOver={e => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (draggingKey && draggingKey !== c.key) {
                  onReorder(draggingKey, c.key);
                }
              }}
              onDragEnd={() => setDraggingKey(null)}
              onDrop={e => { e.preventDefault(); setDraggingKey(null); }}
              className="flex items-center gap-2 px-2.5 py-1.5 text-[12px] cursor-grab hover:bg-[var(--gc-hover)]"
              style={{
                color:      'var(--gc-text-1)',
                background: draggingKey === c.key ? 'rgba(26,115,232,0.08)' : undefined,
              }}>
              <GripVertical size={12} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />
              <input type="checkbox" checked={!!visible[c.key]} onChange={() => onToggle(c.key)}
                onClick={e => e.stopPropagation()}
                style={{ accentColor: '#1a73e8' }} />
              <span className="flex-1 truncate">{c.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
