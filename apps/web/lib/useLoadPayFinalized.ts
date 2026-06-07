'use client';

/**
 * useLoadPayFinalized — has this load's driver pay already been paid out?
 *
 * Looks up the PayrollRecord for (driverName, weekStart) where weekStart
 * is the Saturday on-or-before the load's pickup date. If a record exists,
 * the driver has been finalized for that week — meaning this load's
 * driverPay was rolled into the totalPay on the record.
 *
 * Surfaces:
 *   - apps/web/app/loads/[internalLoadId]/page.tsx — banner next to driver
 *     pay (per-leg on relays)
 *   - apps/web/components/calendar/EventModal.tsx — banner near driver pay
 *
 * In-flight dedup: simultaneous calls for the same (driver, week) share
 * one fetch promise so opening 5 loads in a row from the same driver
 * doesn't fire 5 lookups.
 */

import { useEffect, useState } from 'react';
import { fetchPayrollRecord } from '@/lib/db';
import { payrollWeekStartFor } from '@/lib/payrollWeek';
import type { PayrollRecord } from '@fleetcal/types';

const inflight = new Map<string, Promise<PayrollRecord | null>>();

function cacheKey(driverName: string, weekStart: string): string {
  return `${driverName.trim().toLowerCase()}::${weekStart}`;
}

export interface LoadPayFinalizedState {
  /** True iff a payroll record was found for the load's (driver, week). */
  finalized: boolean;
  /** ISO timestamp the payroll record was created (when Finalize Pay fired). */
  finalizedAt: string | null;
  /** YYYY-MM-DD Saturday that anchors the payroll week. */
  weekStart: string | null;
  /** Sum of driver pay for that whole week (this load is a contributor). */
  totalForWeek: number | null;
  loading: boolean;
}

const EMPTY: LoadPayFinalizedState = {
  finalized: false, finalizedAt: null, weekStart: null, totalForWeek: null, loading: false,
};

export function useLoadPayFinalized(
  driverName: string | null | undefined,
  pickupIso: string | null | undefined,
): LoadPayFinalizedState {
  const weekStart = payrollWeekStartFor(pickupIso ?? undefined);
  const ready = !!driverName && !!weekStart;
  const [state, setState] = useState<LoadPayFinalizedState>(EMPTY);

  useEffect(() => {
    if (!ready || !driverName || !weekStart) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;
    setState({ ...EMPTY, weekStart, loading: true });

    const key = cacheKey(driverName, weekStart);
    let p = inflight.get(key);
    if (!p) {
      // fetchPayrollRecord ignores its orgId arg — the auth header
      // carries it. Pass empty string to satisfy the signature.
      p = fetchPayrollRecord('', driverName, weekStart);
      inflight.set(key, p);
      // Clear after settle so callers see fresh server state on re-mount.
      p.finally(() => { inflight.delete(key); });
    }
    p.then(rec => {
      if (cancelled) return;
      if (rec) {
        setState({
          finalized: true,
          finalizedAt: rec.finalizedAt ?? null,
          weekStart,
          totalForWeek: typeof rec.totalPay === 'number' ? rec.totalPay : null,
          loading: false,
        });
      } else {
        setState({ ...EMPTY, weekStart, finalized: false, loading: false });
      }
    });
    return () => { cancelled = true; };
  }, [driverName, weekStart, ready]);

  return state;
}
