/**
 * One-shot backfill: resolve loads.customer_id by matching the freeform
 * loads.broker text against the customer roster (name + aliases).
 *
 * Background
 * ----------
 * For a long stretch, loads created via paths that didn't write
 * customer_id (legacy rows, AI parse imports, edits that hit the
 * "auto-clear customerId on weak match" bug we fixed in 44cb999) ended
 * up with customer_id=NULL even though the broker text-field had a
 * clean match in the org's customer table.
 *
 * The runtime fix in buildSnapshot (57ebbc8) self-heals these on the
 * next invoice generation — but only one load at a time, and only when
 * the dispatcher actually invoices it. This script walks the backlog so
 * every affected load is healed in one pass.
 *
 * What it does (per load)
 * ----------------------
 *   1. Skip if customer_id is already set.
 *   2. Trim load.broker. If empty → log + skip (nothing to match).
 *   3. Lookup the load's org's customer roster (cached per org so
 *      cost is one fetch per distinct org_id in the batch).
 *   4. Case-insensitive exact match on customer.name OR any alias.
 *      - 0 matches → log + skip (manual review needed).
 *      - 1 match → write loads.customer_id = matched.id.
 *      - >1 matches → log + skip (ambiguous; manual review needed).
 *   5. Report all four buckets at the end + a CSV of unresolved.
 *
 * Run
 * ---
 *   cd apps/api
 *   npx tsx src/scripts/backfill-loads-customer-id.ts            # dry-run (default)
 *   npx tsx src/scripts/backfill-loads-customer-id.ts --apply    # actually write
 *   npx tsx src/scripts/backfill-loads-customer-id.ts --org=ORG  # scope to one org
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env (same as
 * the API server).
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const ORG_ARG = process.argv.find(a => a.startsWith("--org="))?.slice("--org=".length);

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

interface LoadRow {
  id: string;
  org_id: string;
  broker: string | null;
  customer_id: string | null;
}

interface CustomerRow {
  id: string;
  name: string;
  aliases: string[] | null;
}

const tally = {
  total:     0,
  linked:    0,
  noBroker:  0,
  noMatch:   0,
  ambiguous: 0,
  errors:    0,
};
const unresolved: Array<{ loadId: string; orgId: string; broker: string; reason: string }> = [];

async function main() {
  console.log(APPLY ? "▶  apply mode: writing changes" : "🔍 dry-run mode: no writes");
  if (ORG_ARG) console.log(`   scoped to org: ${ORG_ARG}`);
  console.log("");

  // Page through loads with customer_id IS NULL. Supabase caps at 1000
  // per request; loop with offset until empty.
  const customerCache = new Map<string, CustomerRow[]>();
  const PAGE = 500;
  let offset = 0;

  while (true) {
    let q = supabase
      .from("loads")
      .select("id,org_id,broker,customer_id")
      .is("customer_id", null)
      .range(offset, offset + PAGE - 1);
    if (ORG_ARG) q = q.eq("org_id", ORG_ARG);
    const { data: page, error: pageErr } = await q;
    if (pageErr) {
      console.error("Page fetch failed:", pageErr);
      process.exit(2);
    }
    const rows = (page ?? []) as unknown as LoadRow[];
    if (rows.length === 0) break;

    for (const load of rows) {
      tally.total++;
      const broker = load.broker?.trim() ?? "";
      if (!broker) {
        tally.noBroker++;
        unresolved.push({ loadId: load.id, orgId: load.org_id, broker: "", reason: "empty broker text" });
        continue;
      }

      // Lazy-load + cache the org's customer roster.
      let customers = customerCache.get(load.org_id);
      if (!customers) {
        const { data: custRows, error: custErr } = await supabase
          .from("customers")
          .select("id,name,aliases")
          .eq("org_id", load.org_id);
        if (custErr) {
          console.error(`Customer fetch failed for org ${load.org_id}:`, custErr);
          tally.errors++;
          continue;
        }
        customers = (custRows ?? []) as unknown as CustomerRow[];
        customerCache.set(load.org_id, customers);
      }

      const lower = broker.toLowerCase();
      const matches = customers.filter(c =>
        c.name.toLowerCase() === lower ||
        (c.aliases ?? []).some(a => a.toLowerCase() === lower),
      );

      if (matches.length === 0) {
        tally.noMatch++;
        unresolved.push({ loadId: load.id, orgId: load.org_id, broker, reason: "no customer matches" });
        continue;
      }
      if (matches.length > 1) {
        tally.ambiguous++;
        const names = matches.map(m => m.name).join(" | ");
        unresolved.push({ loadId: load.id, orgId: load.org_id, broker, reason: `ambiguous — matched: ${names}` });
        continue;
      }

      // Single unambiguous match — apply.
      const matched = matches[0];
      if (APPLY) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: upErr } = await supabase
          .from("loads")
          .update({ customer_id: matched.id } as any)
          .eq("id", load.id)
          .eq("org_id", load.org_id)
          .is("customer_id", null); // race guard
        if (upErr) {
          console.error(`  ✗ ${load.id} (${broker} → ${matched.name}):`, upErr.message);
          tally.errors++;
          continue;
        }
      }
      tally.linked++;
      console.log(`  ${APPLY ? "✓" : "→"} ${load.id} :: "${broker}" → ${matched.name}`);
    }

    offset += rows.length;
    if (rows.length < PAGE) break;
  }

  // ── Report ────────────────────────────────────────────────────────
  console.log("");
  console.log("── Summary ─────────────────────────────────────────────");
  console.log(`Total scanned:    ${tally.total}`);
  console.log(`${APPLY ? "Linked" : "Would link"}:  ${tally.linked}`);
  console.log(`No broker text:   ${tally.noBroker}`);
  console.log(`No customer:      ${tally.noMatch}`);
  console.log(`Ambiguous:        ${tally.ambiguous}`);
  console.log(`Errors:           ${tally.errors}`);
  console.log("");
  if (unresolved.length > 0) {
    console.log("── Unresolved (need manual review) ─────────────────────");
    console.log("loadId,orgId,broker,reason");
    for (const u of unresolved) {
      // Wrap broker / reason in quotes; escape any embedded quotes.
      const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
      console.log(`${u.loadId},${u.orgId},${esc(u.broker)},${esc(u.reason)}`);
    }
  }
  console.log("");
  if (!APPLY) {
    console.log("(dry-run — re-run with --apply to actually write)");
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(3);
});
