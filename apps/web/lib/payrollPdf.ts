// ─── Shared payroll PDF utilities ─────────────────────────────────────────────
// Used by both PayrollView (current week) and DriversModal (pay history).

import type { PayrollLineItem } from '@fleetcal/types';
import type { CalendarEvent } from './types';
import type { PayrollAdjustment, PayrollRecord } from './db';
import { legLabelForEvent } from './payrollSnapshot';

// ─── Formatting helpers ───────────────────────────────────────────────────────

export function parseDate(iso: string): Date {
  const [y, m, day] = iso.split('T')[0].split('-').map(Number);
  return new Date(y, m - 1, day);
}

export function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function fmtDateFull(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtMoney(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(n);
}

// ─── Print data shape ─────────────────────────────────────────────────────────

export interface PrintDriver {
  driverName: string;
  loads: CalendarEvent[];
  adjustments: PayrollAdjustment[];
  /** When this record carries `lineItems`, the stub is rendered FROM THE
   *  SNAPSHOT and `loads`/`adjustments` are ignored — reprinting a
   *  finalized week has to produce the document that was issued, not a
   *  fresh computation over data that may have moved since. */
  record: PayrollRecord | null;
  /** Sibling relay legs, for resolving leg labels on live (unfinalized)
   *  stubs. Snapshot stubs carry their labels already. */
  allEvents?: readonly CalendarEvent[];
}

// ─── Row model ────────────────────────────────────────────────────────────────
// Both the frozen and the live path collapse to this, so the table markup
// below has exactly one shape to render.

interface StubRow {
  kind: 'load' | 'adjustment' | 'accessorial';
  date: string;
  leg: string;
  title: string;
  loadNum: string;
  amount: number | null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => (
    ch === '&' ? '&amp;' :
    ch === '<' ? '&lt;'  :
    ch === '>' ? '&gt;'  :
    ch === '"' ? '&quot;' : '&#39;'
  ));
}

/** Rows straight from the frozen snapshot — no live lookups at all. */
function rowsFromSnapshot(items: readonly PayrollLineItem[]): StubRow[] {
  return items.map(li => ({
    kind:    li.kind,
    date:    li.date ? parseDate(li.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '',
    leg:     li.legLabel ?? '',
    title:   li.label || (li.category ?? ''),
    loadNum: li.loadNum ? `#${li.loadNum}` : '—',
    amount:  li.amount,
  }));
}

/** Rows computed from current data — the only correct source for a week
 *  that hasn't been finalized yet. */
function rowsFromLive(d: PrintDriver): StubRow[] {
  const loadRows: StubRow[] = d.loads.map(l => ({
    kind:    'load',
    date:    parseDate(l.start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
    leg:     legLabelForEvent(l, d.allEvents),
    title:   l.title ?? '',
    loadNum: l.loadNum ? `#${l.loadNum}` : '—',
    amount:  l.driverPay ?? null,
  }));
  const adjRows: StubRow[] = d.adjustments.map(a => ({
    kind:    'adjustment',
    date:    '',
    leg:     '',
    title:   `${a.category}${a.description ? ` — ${a.description}` : ''}`,
    loadNum: '',
    amount:  a.amount,
  }));
  return [...loadRows, ...adjRows];
}

// ─── PDF generator ────────────────────────────────────────────────────────────

export function printPayroll(opts: {
  orgName: string;
  orgLogoUrl?: string;
  weekLabel: string;
  sat: Date;
  fri: Date;
  drivers: PrintDriver[];
}) {
  const { orgName, orgLogoUrl, weekLabel, sat, fri, drivers } = opts;

  // Resolve each driver ONCE: a finalized record with frozen lines wins
  // over live data, everywhere — header total, row list, load count.
  // Reprinting a paid week must reproduce the issued document; before
  // this, the stub was recomputed from live values every time, so an
  // edit made after payday silently rewrote history.
  const resolved = drivers.map(d => {
    const snapshot = d.record?.lineItems?.length ? d.record.lineItems : null;
    const rows  = snapshot ? rowsFromSnapshot(snapshot) : rowsFromLive(d);
    const total = snapshot
      ? d.record!.totalPay
      : rows.reduce((s, r) => s + (r.amount ?? 0), 0);
    return { driver: d, rows, total, frozen: !!snapshot };
  });

  const totalPay = resolved.reduce((s, r) => s + r.total, 0);

  const driverRows = resolved.map(({ driver: d, rows, total, frozen }) => {
    const loadCount = rows.filter(r => r.kind === 'load').length;
    // Miles column intentionally omitted from the printable PDF — the
    // driver-facing stub hides the dispatcher's loaded-miles metric so
    // drivers can't reverse-engineer rate-per-mile or load profitability.
    // The on-screen PayrollView keeps the miles column for dispatchers.
    const bodyRows = rows.map(r => {
      if (r.kind === 'load') {
        return `<tr>
        <td>${escapeHtml(r.date)}</td>
        <td>${escapeHtml(r.leg)}</td>
        <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.title)}</td>
        <td>${escapeHtml(r.loadNum)}</td>
        <td class="num">${r.amount != null ? fmtMoney(r.amount) : '—'}</td>
      </tr>`;
      }
      // 5 columns total (Date, Leg, Event, Load #, Driver Pay).
      // Adjustments + accessorials span the first 4 for their
      // description; the last column is the amount.
      const amt = r.amount ?? 0;
      return `
      <tr class="adj-row">
        <td colspan="4" style="padding-left:16px;color:#444">${escapeHtml(r.title)}</td>
        <td class="num" style="color:${amt >= 0 ? '#1e8e3e' : '#d93025'}">${amt >= 0 ? '+' : ''}${fmtMoney(amt)}</td>
      </tr>`;
    }).join('');
    const finBadge = d.record ? `<span class="paid-badge">✓ Paid</span>` : '';
    const finalizedBy = d.record?.finalizedByName
      ? ` by ${escapeHtml(d.record.finalizedByName)}`
      : '';
    return `
      <div class="driver-block">
        <div class="driver-header">
          <div class="driver-avatar">${escapeHtml(d.driverName.charAt(0).toUpperCase())}</div>
          <div>
            <div class="driver-name">${escapeHtml(d.driverName)} ${finBadge}</div>
            <div class="driver-sub">${loadCount} load${loadCount !== 1 ? 's' : ''}${d.record ? ` · Finalized ${new Date(d.record.finalizedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}${finalizedBy}` : ''}</div>
          </div>
          <div style="margin-left:auto;text-align:right">
            <div class="stat-label">Driver Pay</div>
            <div class="stat-value">${fmtMoney(total)}</div>
          </div>
        </div>
        <table>
          <thead><tr><th>Date</th><th>Leg</th><th>Event Title</th><th>Load #</th><th class="num">Driver Pay</th></tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
        ${frozen
          ? `<div class="frozen-note">Figures as finalized — this stub reproduces the record issued on ${new Date(d.record!.finalizedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.</div>`
          : ''}
      </div>`;
  }).join('');

  const logoHtml = orgLogoUrl
    ? `<img src="${orgLogoUrl}" class="org-logo" />`
    : `<div class="org-avatar">${orgName.charAt(0).toUpperCase()}</div>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8" />
  <title>Payroll — ${weekLabel}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 12px; color: #111; background: #fff; padding: 32px; }
    .header { display: flex; align-items: center; gap: 14px; margin-bottom: 24px; padding-bottom: 18px; border-bottom: 2px solid #1a73e8; }
    .org-logo { width: 40px; height: 40px; border-radius: 8px; object-fit: cover; }
    .org-avatar { width: 40px; height: 40px; border-radius: 8px; background: #1a73e8; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 700; }
    .org-name { font-size: 20px; font-weight: 700; color: #111; }
    .week-label { font-size: 13px; color: #444; margin-top: 2px; }
    .summary { display: flex; gap: 32px; margin-bottom: 24px; padding: 14px 18px; background: #eef2f6; border-radius: 8px; border: 1px solid #ccc; }
    .stat-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #444; margin-bottom: 2px; }
    .stat-value { font-size: 18px; font-weight: 700; color: #111; }
    .driver-block { margin-bottom: 24px; border: 1px solid #ccc; border-radius: 8px; overflow: hidden; page-break-inside: avoid; }
    .driver-header { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: #f0f4f8; border-bottom: 1px solid #ccc; }
    .driver-avatar { width: 32px; height: 32px; border-radius: 50%; background: #1a73e81a; color: #1a73e8; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; flex-shrink: 0; }
    .driver-name { font-size: 14px; font-weight: 700; color: #111; }
    .driver-sub { font-size: 11px; color: #444; margin-top: 1px; }
    .paid-badge { display: inline-block; font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 99px; background: #1e8e3e1a; color: #1e8e3e; margin-left: 6px; }
    table { width: 100%; border-collapse: collapse; }
    th { padding: 7px 12px; text-align: left; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: #333; border-bottom: 2px solid #ccc; background: #f7f7f7; }
    td { padding: 8px 12px; border-bottom: 1px solid #e8e8e8; color: #222; }
    .num { text-align: right; font-weight: 600; }
    .adj-row td { background: #f5f5f5; font-size: 11px; color: #333; }
    .frozen-note { padding: 7px 16px; font-size: 10px; color: #555; background: #fafafa; border-top: 1px solid #e8e8e8; }
    .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #ccc; font-size: 11px; color: #555; text-align: center; }
    @media print { body { padding: 16px; } .driver-block { page-break-inside: avoid; } }
  </style></head><body>
  <div class="header">
    ${logoHtml}
    <div>
      <div class="org-name">${orgName}</div>
      <div class="week-label">Payroll · ${fmtDateFull(sat)} – ${fmtDateFull(fri)}</div>
    </div>
  </div>
  <div class="summary">
    <div><div class="stat-label">Total Driver Pay</div><div class="stat-value">${fmtMoney(totalPay)}</div></div>
    ${drivers.length > 1 ? `<div><div class="stat-label">Drivers</div><div class="stat-value">${drivers.length}</div></div>` : ''}
    <div><div class="stat-label">Loads</div><div class="stat-value">${resolved.reduce((s, r) => s + r.rows.filter(x => x.kind === 'load').length, 0)}</div></div>
  </div>
  ${driverRows}
  <div class="footer">Generated ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} · ${orgName} Payroll</div>
  <script>window.onload = () => { window.print(); }<\/script>
  </body></html>`;

  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(html);
  win.document.close();
}
