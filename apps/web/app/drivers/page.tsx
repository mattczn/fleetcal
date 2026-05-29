'use client';

/**
 * /drivers — driver performance scorecards.
 *
 * Per-driver activity metrics over a chosen period (default: This Week).
 * Click a driver row → side panel with per-load drill-down.
 *
 * Metric definitions:
 *   - Loads:        Count of legs this driver was assigned in the period
 *                   (pickup-leg starts ∈ window). Each leg of a relay
 *                   counts independently.
 *   - Loaded Miles: Sum of leg.loadedMiles for THIS driver's legs.
 *                   Deadhead miles are NOT included; relay loads only
 *                   credit each driver for their own leg's loaded miles.
 *   - Inspections:  Count of DVIRs submitted in the period (with
 *                   sub-line for inspections that flagged defects).
 *   - Insp %:       Days an inspection was submitted ÷ days the driver
 *                   had a non-cancelled load SCHEDULED in the period.
 *   - POD %:        Delivered loads where the POD doc was uploaded
 *                   within 24h of deliveryAt ÷ delivered loads in the
 *                   period. Cancelled + TONU loads excluded.
 *   - Stops %:      Stops on this driver's legs where arrivedAt was
 *                   populated (driver checked in) ÷ all of their stops.
 *   - Trailer %:    Driver's legs where trailerId was set ÷ all legs.
 *                   Reports how often the driver self-reported their
 *                   trailer.
 *   - Fuel:         Count of fuel reports submitted in the period.
 *   - Maint:        Count of maintenance reports submitted in the period.
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
