'use client';

/**
 * /drivers — driver performance scorecards.
 *
 * Per-driver activity metrics over a chosen period: loads delivered,
 * miles driven, inspection submission compliance, POD-on-time rate,
 * stop check-in rate, trailer-reporting rate, plus counts of fuel
 * and maintenance reports submitted. Click a driver row → side panel
 * with per-load drill-down.
 *
 * Phase 1 is client-side aggregation: hit each of the four list
 * endpoints (loads, inspections, fuels, maintenance reports) once
 * for the period, then group by driver_id in memory. Scales fine
 * for any reasonable fleet × period. If aggregate compute becomes
 * a hotspot later, swap in a server-side /v1/drivers/scorecard
 * endpoint without changing the page shape.
 *
 * Driver-list semantics: rows only show for drivers with ANY
 * activity in the period — zero-activity rows would clutter the
 * roster and the "missing driver" signal is better surfaced from
 * the Calendar (assignments) than from a scorecard.
 */

import DriversView from '@/components/drivers/DriversView';
import RequireCap from '@/components/auth/RequireCap';

export default function DriversPage() {
  return (
    <RequireCap cap="drivers.view">
      <DriversView />
    </RequireCap>
  );
}
