/**
 * /v1/public/paystubs/:token — token-authed paystub read for drivers.
 *
 * Drivers don't have web accounts (Clerk is dispatch-only), so the
 * paystub link uses possession of the view_token as auth — same
 * pattern crm-public/unsubscribe uses for cold-email recipients.
 * Tokens are minted by POST /v1/payroll/records/:id/send with
 * ~110 bits of entropy and rotate on every re-finalize (a new record
 * row = a new token), so a leaked link goes stale as soon as the
 * dispatcher issues a correction.
 *
 * Mounted OUTSIDE the /v1 authed branch — must be before that route
 * or the Clerk middleware will 401 the driver's browser.
 *
 * Response is intentionally lean: what a paystub page needs to
 * render, nothing more. No driver phone, no other drivers' records,
 * no org-wide anything.
 */

import { Hono } from "hono";
import { supabase } from "../lib/supabase.js";

const paystubsPublic = new Hono();

interface RecRow {
  id:                 string;
  driver_name:        string;
  week_start:         string;
  total_pay:          number | string;
  finalized_at:       string;
  notes:              string | null;
  line_items:         unknown;
  finalized_by_name:  string | null;
  superseded_at:      string | null;
  sent_at:            string | null;
  viewed_at:          string | null;
  org_id:             string;
}

interface LineItem {
  kind:     "load" | "adjustment" | "accessorial";
  id?:      string;
  amount:   number;
  label?:   string;
  date?:    string;
  loadNum?: string;
  legLabel?: string;
  category?: string;
}

interface PublicPaystubResponse {
  paystub: {
    id:              string;
    driverName:      string;
    weekStart:       string;
    weekEndInclusive:string;
    totalPay:        number;
    finalizedAt:     string;
    finalizedByName: string | null;
    notes:           string | null;
    lineItems:       LineItem[];
    /** Human-friendly org label to render in the header. Kept as
     *  hardcoded "FleetCal" for now — later this can pull from
     *  org_settings.brand_name so a Curzon paystub says Curzon. */
    orgLabel:        string;
    supersededAt:    string | null;
  };
}

/** Same defensive parser the internal payroll route uses — accept an
 *  array of {amount:number, ...} rows, drop anything malformed. Missing
 *  line_items = we render the total only (legacy backfilled records). */
function parseLineItems(raw: unknown): LineItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is LineItem =>
      !!x && typeof x === "object" &&
      typeof (x as LineItem).amount === "number")
    .map((x) => ({
      kind:     x.kind,
      id:       x.id,
      amount:   x.amount,
      label:    x.label,
      date:     x.date,
      loadNum:  x.loadNum,
      legLabel: x.legLabel,
      category: x.category,
    }));
}

paystubsPublic.get("/:token", async (c) => {
  const token = c.req.param("token");
  // Cheap format guard so a URL scanner can't burn DB queries. Kept
  // permissive on the character class — the generator's alphabet has
  // shifted before, and the DB lookup is an exact-string match anyway
  // (110 bits of entropy makes a false positive on any random string
  // effectively impossible). Prior stricter regex excluded `i` and
  // `o` while the generator included them, so ~76% of real tokens
  // 404'd here as "expired." Length + alphanumeric-lowercase is
  // sufficient to reject nonsense URLs.
  if (!/^[a-z0-9]{16,32}$/i.test(token)) {
    return c.json({ error: "not_found" }, 404);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("payroll_records")
    .select("id, driver_name, week_start, total_pay, finalized_at, notes, line_items, finalized_by_name, superseded_at, sent_at, viewed_at, org_id")
    .eq("view_token", token)
    .maybeSingle();
  if (error) {
    console.error("[GET /v1/public/paystubs/:token] fetch failed:", error);
    return c.json({ error: "fetch_failed" }, 500);
  }
  if (!data) return c.json({ error: "not_found" }, 404);

  const row = data as RecRow;

  // Superseded records stay accessible (the driver may have bookmarked
  // the link before the correction landed) but the UI should show a
  // "superseded" state instead of the numbers. Kept accessible rather
  // than 404'd because a driver following an old link and seeing a
  // clear "this was replaced" message is a better experience than a
  // dead-end error page.

  // Best-effort viewed_at stamp — first open only. Silent failure OK,
  // this is telemetry not payload.
  if (!row.viewed_at) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void (supabase as any)
      .from("payroll_records")
      .update({ viewed_at: new Date().toISOString() })
      .eq("id", row.id)
      .is("viewed_at", null);
  }

  // Pull the org's display name from invoice_settings so the paystub
  // page + header say "Curzon Trucking LLC · Paystub" instead of a
  // generic "FleetCal." Falls back to "FleetCal" only when the org
  // hasn't set companyName in their invoice settings — matches the
  // convention every other driver/broker-facing surface uses.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: settingsRow } = await (supabase as any)
    .from("org_settings")
    .select("invoice_settings")
    .eq("org_id", row.org_id)
    .maybeSingle();
  const invoiceSettings = (settingsRow as { invoice_settings: { companyName?: string } | null } | null)?.invoice_settings;
  const orgLabel = invoiceSettings?.companyName?.trim() || "FleetCal";

  const start = new Date(`${row.week_start}T00:00:00Z`);
  const end   = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
  const weekEndInclusive = end.toISOString().slice(0, 10);

  const res: PublicPaystubResponse = {
    paystub: {
      id:              row.id,
      driverName:      row.driver_name,
      weekStart:       row.week_start,
      weekEndInclusive,
      totalPay:        Number(row.total_pay),
      finalizedAt:     row.finalized_at,
      finalizedByName: row.finalized_by_name,
      notes:           row.notes,
      lineItems:       parseLineItems(row.line_items),
      orgLabel,
      supersededAt:    row.superseded_at,
    },
  };
  return c.json(res);
});

export default paystubsPublic;
