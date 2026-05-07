/**
 * One-time migration script — pulls data from the old Supabase DB, transforms
 * it, and seeds the new DB. This already ran during the original cutover; it's
 * kept here as historical reference and can be deleted in a cleanup pass.
 *
 * Usage from the workspace root:
 *   SEED_ORG_ID=org_xxxxxxxxxxxx npm run db:seed -w @fleetcal/database
 *
 *   SEED_ORG_ID — your Clerk org ID
 *                 Clerk Dashboard → Organizations → your org → copy the ID (starts with "org_")
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from
 * apps/web/.env.local (the canonical location for those credentials today).
 */

import { config } from 'dotenv';
import { resolve } from 'path';
// Walk up from packages/database/supabase/ to apps/web/.env.local
config({ path: resolve(__dirname, '../../../apps/web/.env.local') });

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// ── Config ────────────────────────────────────────────────────────────────────
const OLD_URL  = 'https://vgglyebsbbgooqmguzmi.supabase.co';
const OLD_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZnZ2x5ZWJzYmJnb29xbWd1em1pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MzY4NTYsImV4cCI6MjA4NzExMjg1Nn0.nGcwDJXjDSkjOr8Vgtrupj92Vx-vlrvWDdwa0LxP-xs';

const NEW_URL         = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const NEW_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ORG_ID          = process.env.SEED_ORG_ID!;

if (!NEW_URL || !NEW_SERVICE_KEY || !ORG_ID) {
  console.error('Missing required values. Make sure .env.local has NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  if (!ORG_ID) console.error('Also pass your Clerk org ID: SEED_ORG_ID=org_xxx npx tsx supabase/seed.ts');
  process.exit(1);
}

const oldDb = createClient(OLD_URL, OLD_ANON);
const newDb = createClient(NEW_URL, NEW_SERVICE_KEY);

// ── Old DB types ──────────────────────────────────────────────────────────────
interface OldAsset {
  id: string; rid: number; label: string; unit: string | null;
  color: string; type: string; active: boolean;
  year: string | null; make: string | null; model: string | null;
}
interface OldDriver {
  id: number; name: string; active: boolean;
}
interface OldAccessorial {
  type: string; price: number; paidBy: string; status?: string;
}
interface OldEvent {
  id: string; summary: string; load_num: string | null; ref_nums: string | null;
  start: string; end: string; rid: number; notes: string | null;
  status: string | null; driver_name: string | null; equipment: string | null;
  load_price: number | null; driver_pay: number | null;
  accessorials: OldAccessorial[] | null; broker: string | null;
  trailer_num: string | null; relay_group: string | null;
  pickup_address: string | null; delivery_address: string | null;
  deleted_at: string | null; leg_driver_pay: number | null; leg_miles: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function fetchAll<T>(table: string, client = oldDb): Promise<T[]> {
  const all: T[] = [];
  const PAGE = 500;
  let from = 0;
  while (true) {
    const { data, error } = await client.from(table).select('*').range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    all.push(...(data as T[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

const CATEGORY_MAP: Record<string, string> = {
  detention: 'detention', lumper: 'lumper', layover: 'layover',
  scale_ticket: 'scale_ticket', 'scale ticket': 'scale_ticket',
  extra_stop:  'extra_stop',  'extra stop':   'extra_stop',
  other: 'other',
};

function transformAccessorials(old: OldAccessorial[] | null) {
  if (!old?.length) return null;
  return old.map(a => ({
    id:       crypto.randomUUID(),
    category: CATEGORY_MAP[a.type?.toLowerCase()] ?? 'other',
    description: '',
    amount:   a.price ?? 0,
    billable: a.paidBy === 'broker',
    status:   a.status ?? undefined,
  }));
}

function normalizeStatus(s: string | null) {
  return (!s || !s.trim()) ? 'scheduled' : s;
}

function extractCity(addr: string | null): string | null {
  if (!addr) return null;
  const parts = addr.split(',').map(p => p.trim());
  if (parts.length >= 3) {
    const state = parts[parts.length - 1].trim().split(' ')[0];
    const city  = parts[parts.length - 2];
    return `${city}, ${state}`;
  }
  return addr.length > 80 ? null : addr;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log('=== Dispatch Next DB Migration ===\n');

  // ── 1. ASSETS ──────────────────────────────────────────────────────────────
  console.log('Step 1/3 — Assets');
  const oldAssets = await fetchAll<OldAsset>('assets');
  const truckAssets = oldAssets.filter(a => a.type === 'truck');
  console.log(`  Found ${truckAssets.length} truck assets`);

  // We insert with explicit id = old rid so event asset_id references just work
  const newAssets = truckAssets.map((a, i) => {
    const truckParts = [a.year, a.make, a.model].filter(Boolean);
    return {
      id:         a.rid,             // keep old integer rid as the PK
      org_id:     ORG_ID,
      name:       a.label,
      color:      a.color,
      type:       'Local',           // all seeded as Local — update per asset after import
      unit:       a.unit   ?? null,
      truck:      truckParts.length ? truckParts.join(' ') : null,
      hidden:     !a.active,
      sort_order: i,
    };
  });

  const { error: assetErr } = await newDb.from('assets').upsert(newAssets, { onConflict: 'id' });
  if (assetErr) throw new Error(`Assets insert: ${assetErr.message}`);
  console.log(`  ✓ ${newAssets.length} assets inserted\n`);

  // ── 2. DRIVERS ─────────────────────────────────────────────────────────────
  console.log('Step 2/3 — Drivers');
  const oldDrivers = await fetchAll<OldDriver>('drivers');
  console.log(`  Found ${oldDrivers.length} drivers`);

  const newDrivers = oldDrivers.map(d => ({
    id:     d.id,                    // keep old integer id as PK
    org_id: ORG_ID,
    name:   d.name,
  }));

  const { error: driverErr } = await newDb.from('drivers').upsert(newDrivers, { onConflict: 'id' });
  if (driverErr) throw new Error(`Drivers insert: ${driverErr.message}`);
  console.log(`  ✓ ${newDrivers.length} drivers inserted\n`);

  // ── 3. EVENTS ──────────────────────────────────────────────────────────────
  console.log('Step 3/3 — Events');
  const validRids = new Set(truckAssets.map(a => a.rid));
  const allEvents = await fetchAll<OldEvent>('events');
  console.log(`  Found ${allEvents.length} events`);

  // Derive relay roles from start-time order within each group
  const relayRoles = new Map<string, 'pickup' | 'delivery'>();
  const byGroup = new Map<string, OldEvent[]>();
  for (const ev of allEvents) {
    if (ev.relay_group) {
      const g = byGroup.get(ev.relay_group) ?? [];
      g.push(ev);
      byGroup.set(ev.relay_group, g);
    }
  }
  for (const legs of byGroup.values()) {
    legs.sort((a, b) => a.start.localeCompare(b.start));
    if (legs[0]) relayRoles.set(legs[0].id, 'pickup');
    if (legs[1]) relayRoles.set(legs[1].id, 'delivery');
  }

  let inserted = 0, skipped = 0;
  const BATCH = 250;

  for (let i = 0; i < allEvents.length; i += BATCH) {
    const rows = allEvents.slice(i, i + BATCH)
      .map(ev => {
        if (!validRids.has(ev.rid)) { skipped++; return null; }
        return {
          id:                   ev.id,
          org_id:               ORG_ID,
          asset_id:             ev.rid,        // matches assets.id = old rid
          title:                ev.summary,
          start:                ev.start,
          end:                  ev.end,
          driver_name:          ev.driver_name   ?? null,
          status:               normalizeStatus(ev.status),
          relay_group_id:       ev.relay_group   ?? null,
          relay_role:           relayRoles.get(ev.id) ?? (ev.relay_group ? 'pickup' : null),
          load_num:             ev.load_num       ?? null,
          ref_nums:             ev.ref_nums       ?? null,
          broker:               ev.broker         ?? null,
          load_price:           ev.load_price     ?? null,
          driver_pay:           ev.driver_pay ?? ev.leg_driver_pay ?? null,
          miles:                ev.leg_miles      ?? null,
          trailer_num:          ev.trailer_num    ?? null,
          trailer_type:         ev.equipment      ?? null,
          notes:                ev.notes          ?? null,
          pickup_city:          extractCity(ev.pickup_address),
          delivery_city:        extractCity(ev.delivery_address),
          accessorials:         transformAccessorials(ev.accessorials),
          deleted_at:           ev.deleted_at     ?? null,
        };
      })
      .filter(Boolean);

    const { error } = await newDb.from('events').upsert(rows as object[], { onConflict: 'id' });
    if (error) throw new Error(`Events batch ${i}: ${error.message}`);
    inserted += rows.length;
    process.stdout.write(`  ${inserted + skipped}/${allEvents.length} processed\r`);
  }

  console.log(`\n  ✓ ${inserted} events inserted, ${skipped} skipped (trailer/unknown asset)\n`);
  console.log('=== Migration complete! ===');
  console.log('\n⚠️  REQUIRED: Run these two lines in the Supabase SQL Editor to fix the ID sequences,');
  console.log('   otherwise adding new assets or drivers from the app will fail:\n');
  console.log("   SELECT setval('assets_id_seq',  (SELECT MAX(id) FROM assets));");
  console.log("   SELECT setval('drivers_id_seq', (SELECT MAX(id) FROM drivers));\n");
  console.log('Then:');
  console.log('  1. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to .env.local');
  console.log('  2. In Manage Assets, update each asset category (seeded as "Local" — change OTR trucks manually)');
}

run().catch(err => {
  console.error('\n✗ Migration failed:', err.message ?? err);
  process.exit(1);
});
