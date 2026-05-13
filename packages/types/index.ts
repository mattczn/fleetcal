/**
 * @fleetcal/types — single source of truth for shared types.
 *
 * Three layers:
 *   1. `Database` — generated from the live Supabase schema. Per-table
 *      Row/Insert/Update aliases are exported below.
 *   2. App-domain types — camelCase shapes used by frontend code (Load,
 *      Driver, Asset, etc.). Live in ./domain.
 *   3. Domain enums + Org (Clerk) + API and Realtime stubs.
 *
 * Converters between layers 1 and 2 live in ./converters.
 */

// ── Generated DB schema ─────────────────────────────────────────────────

export type { Database, Json } from "./database";
import type { Database } from "./database";

type T = Database["public"]["Tables"];

// Row / Insert / Update aliases for the entities the apps actually use.
// Naming matches the table verbatim (snake_case Row shape).

export type LoadRow            = T["loads"]["Row"];
export type LoadInsert         = T["loads"]["Insert"];
export type LoadUpdate         = T["loads"]["Update"];

export type EventRow           = T["events"]["Row"];
export type EventInsert        = T["events"]["Insert"];
export type EventUpdate        = T["events"]["Update"];

export type DriverRow          = T["drivers"]["Row"];
export type DriverInsert       = T["drivers"]["Insert"];
export type DriverUpdate       = T["drivers"]["Update"];

export type AssetRow           = T["assets"]["Row"];
export type AssetInsert        = T["assets"]["Insert"];
export type AssetUpdate        = T["assets"]["Update"];

export type TrailerRow         = T["trailers"]["Row"];
export type TrailerInsert      = T["trailers"]["Insert"];
export type TrailerUpdate      = T["trailers"]["Update"];

export type StopRow            = T["stops"]["Row"];
export type StopInsert         = T["stops"]["Insert"];
export type StopUpdate         = T["stops"]["Update"];

export type DriverAssetPrefRow    = T["driver_asset_prefs"]["Row"];
export type DriverAssetPrefInsert = T["driver_asset_prefs"]["Insert"];
export type DriverAssetPrefUpdate = T["driver_asset_prefs"]["Update"];

export type DocumentRow        = T["load_documents"]["Row"];
export type DocumentInsert     = T["load_documents"]["Insert"];
export type DocumentUpdate     = T["load_documents"]["Update"];

export type OrgSettingsRow     = T["org_settings"]["Row"];
export type OrgSettingsInsert  = T["org_settings"]["Insert"];
export type OrgSettingsUpdate  = T["org_settings"]["Update"];

export type InvoiceRow         = T["invoices"]["Row"];
export type InvoiceInsert      = T["invoices"]["Insert"];
export type InvoiceUpdate      = T["invoices"]["Update"];

// ── Org — Clerk-derived (no Supabase row) ───────────────────────────────
//
// Clerk's Organization is the multi-tenancy boundary. This is the minimal
// shape FleetCal apps share; expand as more fields become load-bearing.

export interface Org {
  id: string;
  name: string;
  slug: string;
  imageUrl?: string;
  hasImage?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

// ── App-domain types ────────────────────────────────────────────────────

export * from "./domain";

// ── Domain enums ────────────────────────────────────────────────────────

export * from "./enums";

// ── Converters ──────────────────────────────────────────────────────────

export {
  joinEventLoadToApp,
  appLoadToEventInsert,
  appLoadToLoadInsert,
  parseRefNums,
} from "./converters";

// ── API contracts (Railway endpoints) and Realtime payloads ─────────────

export * from "./api";
export * from "./realtime";

// ── Org roles + capability model ────────────────────────────────────────

export * from "./permissions";
