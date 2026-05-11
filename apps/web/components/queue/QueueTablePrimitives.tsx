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

import { useState } from 'react';
import {
  Check, Copy, ArrowUp, ArrowDown, ChevronLeft, ChevronRight,
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
    <th className="px-3 py-2.5 font-extrabold text-[11px] uppercase tracking-wider"
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
    <td className={`px-3 py-2.5 font-medium ${className ?? ''}`}
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
