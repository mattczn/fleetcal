'use client';

/**
 * FinalizedPayBanner — small green pill that surfaces next to a load's
 * driver pay field once that driver's payroll for the load's week has
 * been finalized (i.e. a payroll_records row exists). Two surfaces use
 * it: the load detail page and the calendar EventModal.
 *
 * The amount shown is the LOAD's contribution (its driverPay value) —
 * not the week's full payroll total — so dispatchers see "this load's
 * pay was already cut" without having to think about the larger week.
 * Hover surfaces the actual finalized timestamp and the week label.
 */

import { Lock } from 'lucide-react';
import Tooltip from '@/components/ui/Tooltip';
import { useLoadPayFinalized } from '@/lib/useLoadPayFinalized';
import { payrollWeekLabel } from '@/lib/payrollWeek';

interface Props {
  driverName: string | null | undefined;
  pickupIso:  string | null | undefined;
  driverPay:  number | null | undefined;
}

export default function FinalizedPayBanner({ driverName, pickupIso, driverPay }: Props) {
  const state = useLoadPayFinalized(driverName, pickupIso);
  if (!state.finalized) return null;

  const fmtMoney = (n: number) =>
    `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const amount = typeof driverPay === 'number' ? fmtMoney(driverPay) : '—';
  const weekLabel = state.weekStart ? payrollWeekLabel(state.weekStart) : null;
  const finalizedAtLabel = state.finalizedAt
    ? new Date(state.finalizedAt).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      })
    : null;

  return (
    <Tooltip
      content={
        <>
          Driver pay for this load was rolled into a <strong>finalized payroll record</strong>
          {weekLabel ? <> for week of <strong>{weekLabel}</strong></> : null}
          {finalizedAtLabel ? <> on <strong>{finalizedAtLabel}</strong></> : null}
          .{state.totalForWeek != null && (
            <> Total paid out that week: <strong>{fmtMoney(state.totalForWeek)}</strong>.</>
          )}
        </>
      }>
      <span
        className="inline-flex items-center gap-1.5 rounded-md font-semibold tabular-nums"
        style={{
          fontSize: 11.5,
          padding: '3px 8px',
          background: '#dcfce7',
          color: '#15803d',
          border: '1px solid #86efac',
          cursor: 'help',
        }}>
        <Lock size={10} />
        Finalized: {amount}
      </span>
    </Tooltip>
  );
}
