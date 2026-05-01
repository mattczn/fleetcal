/**
 * Supabase Realtime channel naming and payload shapes.
 *
 * Channel naming convention (per audit recommendation):
 *
 *   org:{org_id}:events           UPDATE/INSERT/DELETE on events filtered by org_id
 *   org:{org_id}:stops            INSERT/UPDATE/DELETE on stops filtered by org_id
 *   org:{org_id}:assets           changes to fleet assets
 *   org:{org_id}:drivers          changes to drivers roster
 *   event:{event_id}              UPDATE on a single event (load detail screens)
 *   event:{event_id}:documents    INSERT/DELETE on load_documents for a single event
 *
 * Empty for now. Payload shapes will fill in as subscriptions get
 * standardized across apps (Phase 4).
 */

export {};
