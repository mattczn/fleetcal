-- Per-truck "exclude from reports" toggle.
--
-- Mirrors drivers.exclude_from_reports (owner-op drivers). When true, the
-- truck is dispatched normally but withheld from every report rollup —
-- the dashboard KPIs (revenue, loads, miles, RPM/CPM), the per-truck
-- charts, and the loads report — regardless of which driver ran it.
--
-- Use case: an owner-operator's truck (or a personal/non-fleet truck) that
-- shouldn't inflate the carrier's numbers even when the owner occasionally
-- runs a load on it. Distinct from `hidden` (archived / removed from
-- pickers): a truck can be visible-and-active but still excluded here.
--
-- Consumed server-side by lib/reportExclusions.ts (loadExcludedAssetIds),
-- applied in /v1/reports/loads, and OR'd into the derived
-- Asset.excludeFromReports the dashboard already reads.

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS exclude_from_reports boolean NOT NULL DEFAULT false;
