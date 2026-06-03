/**
 * One-shot backfill: heal loads.customer_id by reading loads.broker text
 * against the customer roster.
 *
 * Two passes:
 *
 *   Pass 1 — FILL: loads where customer_id IS NULL.
 *     Bind the FK to the customer whose name (or alias) exactly matches
 *     the broker text (case-insensitive). Ambiguous matches are
 *     skipped. This is the original case caused by legacy creates and
 *     the "auto-clear on weak match" sync bug fixed in 44cb999.
 *
 *   Pass 2 — REBIND: loads where customer_id IS set but points at the
 *     WRONG customer. Caused by the EventModal picker-onChange bug
 *     fixed in b205cb8 — picking customer B in the dropdown only
 *     updated the broker text, the FK stayed on whatever customer the
 *     earlier auto-sync wrote (often A from a prior broker text).
 *     We rebind ONLY when:
 *       (a) the broker text exactly matches some customer's name/alias
 *           (unambiguously — exactly one such match), AND
 *       (b) that match is NOT the currently-linked customer.
 *     If broker text matches the current FK's customer (name OR alias),
 *     leave alone — that's the correct state.
 *     If broker text doesn't match anyone, leave alone — the FK is the
 *     dispatcher's intent, broker text might just be a variant.
 *
 * Both runtime fixes (buildSnapshot 57ebbc8 + EventModal b205cb8) self-
 * heal on next interaction, but this script clears the backlog in one
 * shot.
 *
 * Run
 * ---
 *   cd apps/api
 *   npx tsx src/scripts/backfill-loads-customer-id.ts            # dry-run (default), both passes
 *   npx tsx src/scripts/backfill-loads-customer-id.ts --apply    # actually write
 *   npx tsx src/scripts/backfill-loads-customer-id.ts --org=ORG  # scope to one org
 *   npx tsx src/scripts/backfill-loads-customer-id.ts --pass=1   # only pass 1 (FILL)
 *   npx tsx src/scripts/backfill-loads-customer-id.ts --pass=2   # only pass 2 (REBIND)
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env (same as
 * the API server).
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const ORG_ARG = process.argv.find(a => a.startsWith("--org="))?.slice("--org=".length);
const PASS_ARG = process.argv.find(a => a.startsWith("--pass="))?.slice("--pass=".length);
const RUN_PASS_1 = !PASS_ARG || PASS_ARG === "1";
const RUN_PASS_2 = !PASS_ARG || PASS_ARG === "2";

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

const PAGE = 500;
const customerCache = new Map<string, CustomerRow[]>();

async function getCustomers(orgId: string): Promise<CustomerRow[] | null> {
  let customers = customerCache.get(orgId);
  if (customers) return customers;
  const { data, error } = await supabase
    .from("customers")
    .select("id,name,aliases")
    .eq("org_id", orgId);
  if (error) {
    console.error(`Customer fetch failed for org ${orgId}:`, error);
    return null;
  }
  customers = (data ?? []) as unknown as CustomerRow[];
  customerCache.set(orgId, customers);
  return customers;
}

function findExactMatches(broker: string, customers: CustomerRow[]): CustomerRow[] {
  const lower = broker.toLowerCase();
  return customers.filter(c =>
    c.name.toLowerCase() === lower ||
    (c.aliases ?? []).some(a => a.toLowerCase() === lower),
  );
}

// ── Pass 1: FILL nulls ──────────────────────────────────────────────────

const fillTally = { total: 0, linked: 0, noBroker: 0, noMatch: 0, ambiguous: 0, errors: 0 };
const fillUnresolved: Array<{ loadId: string; orgId: string; broker: string; reason: string }> = [];

async function runFillPass() {
  console.log("");
  console.log("══ PASS 1 — FILL (customer_id IS NULL) ═══════════════════════");
  console.log("");

  let offset = 0;
  while (true) {
    let q = supabase
      .from("loads")
      .select("id,org_id,broker,customer_id")
      .is("customer_id", null)
      .range(offset, offset + PAGE - 1);
    if (ORG_ARG) q = q.eq("org_id", ORG_ARG);
    const { data, error } = await q;
    if (error) {
      console.error("Page fetch failed:", error);
      process.exit(2);
    }
    const rows = (data ?? []) as unknown as LoadRow[];
    if (rows.length === 0) break;

    for (const load of rows) {
      fillTally.total++;
      const broker = load.broker?.trim() ?? "";
      if (!broker) {
        fillTally.noBroker++;
        fillUnresolved.push({ loadId: load.id, orgId: load.org_id, broker: "", reason: "empty broker text" });
        continue;
      }
      const customers = await getCustomers(load.org_id);
      if (!customers) { fillTally.errors++; continue; }

      const matches = findExactMatches(broker, customers);
      if (matches.length === 0) {
        fillTally.noMatch++;
        fillUnresolved.push({ loadId: load.id, orgId: load.org_id, broker, reason: "no customer matches" });
        continue;
      }
      if (matches.length > 1) {
        fillTally.ambiguous++;
        fillUnresolved.push({
          loadId: load.id, orgId: load.org_id, broker,
          reason: `ambiguous — matched: ${matches.map(m => m.name).join(" | ")}`,
        });
        continue;
      }

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
          fillTally.errors++;
          continue;
        }
      }
      fillTally.linked++;
      console.log(`  ${APPLY ? "✓" : "→"} ${load.id} :: "${broker}" → ${matched.name}`);
    }

    offset += rows.length;
    if (rows.length < PAGE) break;
  }
}

// ── Pass 2: REBIND wrong FKs ────────────────────────────────────────────

const rebindTally = {
  total: 0,        // every row with non-null customer_id scanned
  correct: 0,      // FK matches broker text
  rebound: 0,      // FK changed to the customer broker text identifies
  noMatch: 0,      // broker text matches nothing — left alone (FK is dispatcher's call)
  ambiguous: 0,    // broker text matches several customers — left alone
  emptyBroker: 0,  // no broker text — left alone
  orphan: 0,       // FK points at a customer that no longer exists — logged
  errors: 0,
};
const rebindReport: Array<{ loadId: string; orgId: string; broker: string; from: string; to: string }> = [];
const rebindUnresolved: Array<{ loadId: string; orgId: string; broker: string; reason: string }> = [];

async function runRebindPass() {
  console.log("");
  console.log("══ PASS 2 — REBIND (customer_id IS set but points at wrong customer) ══");
  console.log("");

  let offset = 0;
  while (true) {
    let q = supabase
      .from("loads")
      .select("id,org_id,broker,customer_id")
      .not("customer_id", "is", null)
      .range(offset, offset + PAGE - 1);
    if (ORG_ARG) q = q.eq("org_id", ORG_ARG);
    const { data, error } = await q;
    if (error) {
      console.error("Page fetch failed:", error);
      process.exit(2);
    }
    const rows = (data ?? []) as unknown as LoadRow[];
    if (rows.length === 0) break;

    for (const load of rows) {
      rebindTally.total++;
      const broker = load.broker?.trim() ?? "";
      if (!broker) {
        rebindTally.emptyBroker++;
        continue;
      }
      const customers = await getCustomers(load.org_id);
      if (!customers) { rebindTally.errors++; continue; }

      const currentCustomer = customers.find(c => c.id === load.customer_id);
      if (!currentCustomer) {
        // FK points at a customer that doesn't exist anymore — log
        // (we don't touch it; surgical decision for the dispatcher).
        rebindTally.orphan++;
        rebindUnresolved.push({
          loadId: load.id, orgId: load.org_id, broker,
          reason: `orphan FK — customer_id ${load.customer_id} doesn't exist in customers table`,
        });
        continue;
      }

      // Does broker text match the currently-linked customer?
      // (case-insensitive, name OR alias)
      const lower = broker.toLowerCase();
      const matchesCurrent =
        currentCustomer.name.toLowerCase() === lower ||
        (currentCustomer.aliases ?? []).some(a => a.toLowerCase() === lower);
      if (matchesCurrent) {
        rebindTally.correct++;
        continue;
      }

      // Broker text doesn't match the linked customer. Look for an
      // exact match elsewhere.
      const matches = findExactMatches(broker, customers);
      if (matches.length === 0) {
        // Broker text isn't a known customer at all — leave the FK
        // alone. Dispatcher may have intentionally bound a customer
        // whose name happens to differ from the rate-con's broker
        // text (subsidiary, abbreviation we haven't aliased, etc).
        rebindTally.noMatch++;
        continue;
      }
      if (matches.length > 1) {
        // Multiple customers match the broker text. Don't pick.
        rebindTally.ambiguous++;
        rebindUnresolved.push({
          loadId: load.id, orgId: load.org_id, broker,
          reason: `ambiguous rebind — broker text matches: ${matches.map(m => m.name).join(" | ")} (currently linked to ${currentCustomer.name})`,
        });
        continue;
      }

      const target = matches[0];
      if (target.id === currentCustomer.id) {
        // Shouldn't happen given matchesCurrent check above, but be safe.
        rebindTally.correct++;
        continue;
      }

      // Single unambiguous mismatch — rebind.
      if (APPLY) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: upErr } = await supabase
          .from("loads")
          .update({ customer_id: target.id } as any)
          .eq("id", load.id)
          .eq("org_id", load.org_id)
          .eq("customer_id", currentCustomer.id); // race guard
        if (upErr) {
          console.error(`  ✗ ${load.id} (${currentCustomer.name} → ${target.name}):`, upErr.message);
          rebindTally.errors++;
          continue;
        }
      }
      rebindTally.rebound++;
      rebindReport.push({ loadId: load.id, orgId: load.org_id, broker, from: currentCustomer.name, to: target.name });
      console.log(`  ${APPLY ? "✓" : "→"} ${load.id} :: "${broker}" was→${currentCustomer.name}  now→${target.name}`);
    }

    offset += rows.length;
    if (rows.length < PAGE) break;
  }
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log(APPLY ? "▶  apply mode: writing changes" : "🔍 dry-run mode: no writes");
  if (ORG_ARG) console.log(`   scoped to org: ${ORG_ARG}`);
  if (PASS_ARG) console.log(`   running pass: ${PASS_ARG} only`);

  if (RUN_PASS_1) await runFillPass();
  if (RUN_PASS_2) await runRebindPass();

  // ── Report ────────────────────────────────────────────────────────
  if (RUN_PASS_1) {
    console.log("");
    console.log("── Pass 1 Summary (FILL) ───────────────────────────────");
    console.log(`Total scanned:    ${fillTally.total}`);
    console.log(`${APPLY ? "Linked" : "Would link"}:  ${fillTally.linked}`);
    console.log(`No broker text:   ${fillTally.noBroker}`);
    console.log(`No customer:      ${fillTally.noMatch}`);
    console.log(`Ambiguous:        ${fillTally.ambiguous}`);
    console.log(`Errors:           ${fillTally.errors}`);
  }
  if (RUN_PASS_2) {
    console.log("");
    console.log("── Pass 2 Summary (REBIND) ─────────────────────────────");
    console.log(`Total scanned:    ${rebindTally.total}`);
    console.log(`Already correct:  ${rebindTally.correct}`);
    console.log(`${APPLY ? "Rebound" : "Would rebind"}: ${rebindTally.rebound}`);
    console.log(`No broker text:   ${rebindTally.emptyBroker} (left alone)`);
    console.log(`No name match:    ${rebindTally.noMatch} (left alone)`);
    console.log(`Ambiguous:        ${rebindTally.ambiguous} (left alone, logged)`);
    console.log(`Orphan FK:        ${rebindTally.orphan} (left alone, logged)`);
    console.log(`Errors:           ${rebindTally.errors}`);
  }

  const allUnresolved = [...fillUnresolved, ...rebindUnresolved];
  if (allUnresolved.length > 0) {
    console.log("");
    console.log("── Unresolved (need manual review) ─────────────────────");
    console.log("loadId,orgId,broker,reason");
    for (const u of allUnresolved) {
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
