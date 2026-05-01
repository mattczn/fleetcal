// ─── Shared payroll PDF utilities ─────────────────────────────────────────────
// Used by both PayrollView (current week) and DriversModal (pay history).

import type { CalendarEvent } from './types';
import type { PayrollAdjustment, PayrollRecord } from './db';

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
  record: PayrollRecord | null;
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
  const totalPay = drivers.reduce((s, d) => {
    const lp = d.loads.reduce((ss, l) => ss + (l.driverPay ?? 0), 0);
    const ap = d.adjustments.reduce((ss, a) => ss + a.amount, 0);
    return s + lp + ap;
  }, 0);

  const driverRows = drivers.map(d => {
    const loadPay = d.loads.reduce((s, l) => s + (l.driverPay ?? 0), 0);
    const adjPay  = d.adjustments.reduce((s, a) => s + a.amount, 0);
    const total   = loadPay + adjPay;
    const loadRows = d.loads.map(l => {
      const date = parseDate(l.start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const leg  = l.relayRole === 'pickup' ? 'Pickup' : l.relayRole === 'delivery' ? 'Delivery' : 'Both';
      return `<tr>
        <td>${date}</td>
        <td>${leg}</td>
        <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.title ?? ''}</td>
        <td>${l.loadNum ? `#${l.loadNum}` : '—'}</td>
        <td class="num">${l.driverPay != null ? fmtMoney(l.driverPay) : '—'}</td>
      </tr>`;
    }).join('');
    const adjRows = d.adjustments.map(a => `
      <tr class="adj-row">
        <td colspan="3" style="padding-left:16px;color:#444">${a.category}${a.description ? ` — ${a.description}` : ''}</td>
        <td></td>
        <td class="num" style="color:${a.amount >= 0 ? '#1e8e3e' : '#d93025'}">${a.amount >= 0 ? '+' : ''}${fmtMoney(a.amount)}</td>
      </tr>`).join('');
    const finBadge = d.record ? `<span class="paid-badge">✓ Paid</span>` : '';
    return `
      <div class="driver-block">
        <div class="driver-header">
          <div class="driver-avatar">${d.driverName.charAt(0).toUpperCase()}</div>
          <div>
            <div class="driver-name">${d.driverName} ${finBadge}</div>
            <div class="driver-sub">${d.loads.length} load${d.loads.length !== 1 ? 's' : ''}${d.record ? ` · Finalized ${new Date(d.record.finalizedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}</div>
          </div>
          <div style="margin-left:auto;text-align:right">
            <div class="stat-label">Driver Pay</div>
            <div class="stat-value">${fmtMoney(total)}</div>
          </div>
        </div>
        <table>
          <thead><tr><th>Date</th><th>Leg</th><th>Event Title</th><th>Load #</th><th class="num">Driver Pay</th></tr></thead>
          <tbody>${loadRows}${adjRows}</tbody>
        </table>
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
    <div><div class="stat-label">Loads</div><div class="stat-value">${drivers.reduce((s, d) => s + d.loads.length, 0)}</div></div>
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
