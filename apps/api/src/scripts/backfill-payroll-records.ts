/**
 * Backfill FleetCal payroll_records from my-calendar's finalized pay
 * periods.
 *
 * Context: FleetCal's dashboard payroll tile sums payroll_records by
 * week_start within the period. For weeks without a record, it falls
 * back to estimating from loadSummaries.totalDriverPay. The estimate
 * underreports because:
 *   - 758 historical FleetCal loads still sit on the Unassigned asset
 *     with no driver_pay set
 *   - ~200 my-calendar events have no alvys_load_id and therefore
 *     never entered FleetCal at all
 *   - per-week adjustments (layovers, bonuses, deductions, scales)
 *     live in my-calendar's payroll_adjustments table, not on events
 *
 * Truth is in my-calendar. This script copies the true weekly totals
 * over so the dashboard KPI snaps to the right number for historical
 * weeks.
 *
 * Approach per finalized week:
 *   1. Per driver: sum(events.driver_pay + leg_driver_pay) grouped by
 *      events.driver_name → row in payroll_records using the matched
 *      FleetCal driver name (with the bridge alias map applied)
 *   2. One catch-all "Payroll Adjustments" row per week summing
 *      payroll_adjustments.amount for that period_start. We don't try
 *      to attribute these per-driver because my-calendar's
 *      adjustment.driver_id field uses a mix of truck-rid (1-14),
 *      drivers extras id (15+), and `1000+drivers.id` encodings,
 *      none of which are reliably reversible. The per-week total is
 *      correct and matches what was actually paid.
 *
 * Idempotent: upserts on (org_id, driver_name, week_start), so re-running
 * picks up new finalized weeks and refreshes existing ones.
 *
 * Run
 * ---
 *   cd apps/api
 *   npx tsx src/scripts/backfill-payroll-records.ts \
 *     --org=org_3Cgzom31hVxbq6WR3FjVTbL6K3t
 *   ... add --apply to write ...
 */

import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const ORG   = process.argv.find(a => a.startsWith("--org="))?.slice("--org=".length);
if (!ORG) { console.error("Missing --org=ORG_ID"); process.exit(1); }

const FC_URL = process.env.SUPABASE_URL ?? "";
const FC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const MC_URL = process.env.MYCAL_SUPABASE_URL ?? "https://vgglyebsbbgooqmguzmi.supabase.co";
const MC_KEY = process.env.MYCAL_SUPABASE_SERVICE_KEY ?? "";
if (!FC_URL || !FC_KEY || !MC_KEY) {
  console.error("Missing FC SUPABASE_URL/SERVICE_ROLE_KEY or MYCAL_SUPABASE_SERVICE_KEY");
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fc: SupabaseClient<any> = createClient(FC_URL, FC_KEY, { auth: { persistSession: false } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mc: SupabaseClient<any> = createClient(MC_URL, MC_KEY, { auth: { persistSession: false } });

function log(...xs: unknown[]): void { console.log(...xs); }

// ── Name aliases (same as bridge script) ────────────────────────────
// my-calendar text → FleetCal `drivers.name`
const NAME_ALIASES: Record<string, string> = {
  "blade":       "Blessing Munguri",
  "dilson":      "Adilson Peroza",
  "lenny":       "Lennin Ramirez",
  "jean carlos": "Jean Carlos Polo",
};
const NAME_SKIPS = new Set<string>(["extra", "unassigned", "—", "-"]);

interface FleetcalDriver { name: string | null; first_name: string | null; last_name: string | null }

function resolveFleetcalName(raw: string, byFirst: Map<string, FleetcalDriver>, byFull: Map<string, FleetcalDriver>): string {
  const lower = raw.trim().toLowerCase();
  if (!raw || NAME_SKIPS.has(lower) || /^\d+$/.test(raw)) return raw.trim() || "Unknown";
  const aliasTarget = NAME_ALIASES[lower];
  const matched =
    (aliasTarget && byFull.get(aliasTarget.toLowerCase())) ??
    byFull.get(lower) ??
    byFirst.get(raw.trim().split(/\s+/)[0].toLowerCase());
  if (matched) return matched.name ?? `${matched.first_name ?? ""} ${matched.last_name ?? ""}`.trim();
  return raw.trim(); // fall back to my-calendar's text so the row still lands
}

// ── Saturday + Friday math ──────────────────────────────────────────
function fridayOf(saturdayKey: string): string {
  // saturdayKey is YYYY-MM-DD. Friday = +6 days. Date math via noon
  // anchor to dodge DST edges.
  const d = new Date(`${saturdayKey}T12:00:00`);
  d.setDate(d.getDate() + 6);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function main(): Promise<void> {
  log(APPLY ? "▶  apply mode" : "🔍 dry-run mode");
  log(`   org=${ORG}`);
  log("");

  // ── Roster ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: drivers } = await (fc as any).from("drivers").select("name, first_name, last_name").eq("org_id", ORG);
  const byFirst = new Map<string, FleetcalDriver>();
  const byFull  = new Map<string, FleetcalDriver>();
  for (const d of (drivers ?? []) as FleetcalDriver[]) {
    const first = (d.first_name ?? d.name?.split(" ")[0] ?? "").trim().toLowerCase();
    const full  = (d.name ?? `${d.first_name ?? ""} ${d.last_name ?? ""}`).trim().toLowerCase();
    if (first) byFirst.set(first, d);
    if (full)  byFull.set(full, d);
  }
  log(`FleetCal roster: ${byFull.size} drivers`);

  // ── Finalized weeks from my-calendar ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: periods, error: pErr } = await (mc as any)
    .from("pay_periods")
    .select("period_start, finalized, finalized_at")
    .eq("finalized", true)
    .order("period_start", { ascending: true });
  if (pErr) { log(`pay_periods fetch failed: ${pErr.message}`); process.exit(2); }
  const finalizedWeeks = (periods ?? []) as Array<{ period_start: string; finalized_at: string }>;
  log(`Finalized weeks: ${finalizedWeeks.length}`);
  log("");

  let totalRowsWritten = 0;
  let totalAcrossAllWeeks = 0;

  for (const wk of finalizedWeeks) {
    const sat = wk.period_start;
    const fri = fridayOf(sat);

    // ── Driver pay from my-calendar events ──
    // Aggregate by raw driver_name (plaintext). Use leg_driver_pay
    // when set (relay legs); otherwise driver_pay. Both can be
    // present in pathological cases — sum both to be safe.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: evs, error: evErr } = await (mc as any)
      .from("events")
      .select("driver_name, driver_pay, leg_driver_pay")
      .gte("start", sat)
      .lte("start", `${fri}T23:59`)
      .is("deleted_at", null);
    if (evErr) { log(`  events fetch failed for ${sat}: ${evErr.message}`); continue; }

    const driverPayByName = new Map<string, number>();
    for (const e of (evs ?? []) as Array<{ driver_name: string | null; driver_pay: number | null; leg_driver_pay: number | null }>) {
      const raw = (e.driver_name ?? "").trim();
      if (!raw) continue;
      const lower = raw.toLowerCase();
      if (NAME_SKIPS.has(lower) || /^\d+$/.test(raw)) continue;
      const pay = (e.driver_pay ?? 0) + (e.leg_driver_pay ?? 0);
      if (pay === 0) continue;
      const fcName = resolveFleetcalName(raw, byFirst, byFull);
      driverPayByName.set(fcName, (driverPayByName.get(fcName) ?? 0) + pay);
    }

    // ── Adjustments — lump into a single catch-all row ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: adj } = await (mc as any)
      .from("payroll_adjustments")
      .select("amount")
      .eq("period_start", sat);
    const adjTotal = ((adj ?? []) as Array<{ amount: number }>).reduce((s, a) => s + (a.amount ?? 0), 0);

    const weekTotal = [...driverPayByName.values()].reduce((s, v) => s + v, 0) + adjTotal;
    totalAcrossAllWeeks += weekTotal;

    log(`── Week ${sat} → ${fri}  (${driverPayByName.size} drivers, adj=$${adjTotal.toFixed(2)})`);
    log(`   week total: $${weekTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);

    if (!APPLY) continue;

    // ── Upsert per-driver rows ──
    const rows = [...driverPayByName.entries()].map(([name, total]) => ({
      org_id:       ORG,
      driver_name:  name,
      week_start:   sat,
      total_pay:    total,
      finalized_at: wk.finalized_at,
      notes:        "Backfilled from my-calendar",
    }));
    if (adjTotal !== 0) {
      rows.push({
        org_id:       ORG,
        driver_name:  "Payroll Adjustments",
        week_start:   sat,
        total_pay:    adjTotal,
        finalized_at: wk.finalized_at,
        notes:        "Backfilled — lumped from my-calendar payroll_adjustments",
      });
    }
    if (rows.length === 0) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upErr } = await (fc as any)
      .from("payroll_records")
      .upsert(rows, { onConflict: "org_id,driver_name,week_start" });
    if (upErr) {
      log(`   ✗ upsert failed: ${upErr.message}`);
      continue;
    }
    totalRowsWritten += rows.length;
    log(`   ✓ wrote ${rows.length} rows`);
  }

  log("");
  log("── Summary ──");
  log(`Finalized weeks processed:  ${finalizedWeeks.length}`);
  log(`Total payroll across weeks: $${totalAcrossAllWeeks.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  if (APPLY) log(`Rows upserted:              ${totalRowsWritten}`);
  else log("(dry-run — re-run with --apply to write)");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(2);
});
