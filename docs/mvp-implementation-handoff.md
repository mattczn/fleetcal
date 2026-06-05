# FleetCal MVP Implementation Handoff

> Updated 2026-06-05 (v2.1) — Row 57 placeholder pattern + Modules settings simplification + MiniCalendar promoted to MVP (Q1 resolved).
> Target launch: **Friday, 2026-06-12** (7 days out).
> Source decisions: **47 MVP / 18 Later / 0 Cut**.
> Architecture: feature-flagged modules via Supabase `org_settings.modules` JSONB, multi-tenant Supabase.

---

## What changed since v1

- **Row 57 (Notify Driver popover) restored to MVP as a placeholder.** UI ships; the actual send action is gated by an `sms_enabled` integration config flag (not a module flag), defaulting to `false`. While off, the popover shows a friendly "SMS provisioning in progress — text your driver manually for now" state. Flip the flag to `true` when Twilio A2P 10DLC approval lands; no code change required.
- **Row 41 (Modules settings) implementation simplified.** Barebones toggle screen for whatever handful of flags actually warrant user control (likely none in MVP). All tier-gated flags are server-controlled.
- **Q1 (Row 57 demotion) removed from open questions** — resolved.
- **Q4 (MVP scope) softened** — 46 rows decompose to four workflows (calendar / load detail / closeout / accounting), so the count is fine. Verification protocol still applies.

---

## Validation corrections (2026-06-05, before Day 1 starts)

The v2 plan above made several assumptions about existing infrastructure. They were verified against the codebase. Use **this section** as ground truth for implementation; the sections below are useful for planning but defer to the corrections here when they conflict.

### Storage location

**Correction:** Module flags live in **Supabase `org_settings.modules` JSONB**, NOT Clerk `publicMetadata`. The migration is `20260515_org_modules.sql`. Read into the calendar Zustand store as `orgModules` and accessed via the `useModules()` hook in `apps/web/lib/useModules.ts`. The Day 1 task "add flags to Clerk metadata model" should target `packages/types/modules.ts` and the signup-side defaults instead.

### Existing module taxonomy

**Correction:** Today's `OrgModule` union has 5 entries, not 6. Two flags the v2 plan said were "existing" — `driver_app` and `performance` — **do not exist yet**:

```ts
// Pre-corrections actual
type OrgModule = "closeout" | "accounting" | "fuel" | "payroll" | "maintenance"
```

So the launch needs **7 new flags added** (not 6): `driver_app`, `performance`, `motive_integration`, `trailers`, `dispatch_board`, `custom_documents`, `relay_advanced`. (Originally I added an 8th, `mini_calendar`, but it was removed in v2.1 after founder pushback — date pickers don't warrant tier toggles. See Q1 resolution in Section 5.) As of commit follow-up to `42b3203`, all 7 live in `packages/types/modules.ts` with labels and blurbs. Storage-side and signup-side wiring remain Day 1 / Day 2 tasks.

### Default-when-absent behavior

**Correction:** `isModuleEnabled` treats an **absent key as ENABLED**, not disabled. Quote from `packages/types/modules.ts`:

> An absent key in the flags map is treated as ENABLED — this matters when a new module is added in code before the DB column ships its default, and avoids accidentally locking everyone out during a deploy.

This is the inverse of what the v2 plan assumed. Implication for Day 1:

- **Existing orgs (just Curzon today):** all 8 new flags are automatically ON because the keys are absent from the existing JSONB. No migration or manual update needed for Curzon to keep working as today.
- **New orgs at launch:** to ship them OFF, the signup flow must **explicitly write `false`** to the org_settings row at org creation. Not by inverting the default in `isModuleEnabled` — that would break existing orgs.

### No integration-config pattern exists

**Correction:** There is **no existing `useIntegrationConfig` hook, integration_config table, sms_enabled flag, or Twilio code** anywhere in the repo. The Row 57 placeholder pattern requires inventing this. Recommended shape:

- `process.env.SMS_ENABLED === 'true'`, server-side read in the notify-driver send endpoint.
- Endpoint returns `503 SMS_UNAVAILABLE` when the env var is unset/false.
- Client `NotifyDriverPopover` catches the 503 and renders the placeholder state. The popover UI ships unconditionally — only the send action is gated.
- No new DB table, no UI exposure, no per-org override. Single Vercel env var. ~30 min to wire end-to-end.

Resist building a full integration-config layer for one flag.

### Payroll is substantially built — watchlist concern downgraded

**Correction:** `apps/web/components/payroll/PayrollView.tsx` is **1,675 lines** with real `updateEvent({driverPay})`, `fetchPayrollAdjustments`, week-start handling, driver alias matching. This isn't a stub. The Row 28 watchlist item is **still valid as a "verify the math on real data" dogfood task**, but downgraded from the original "verify it's even shippable" concern.

### File paths to correct in v2 references

- AppSidebar lives at `apps/web/components/nav/AppSidebar.tsx`, not `apps/web/components/AppSidebar.tsx`. It already uses `useModules()` and gates nav entries on `module` props correctly. The new flags will gate their respective nav items automatically once nav items declare `module: 'performance'`, `module: 'driver_app'`, etc.
- There is no standalone `ModulesPanel.tsx` file — the Modules toggle UI lives inline in `apps/web/app/settings/page.tsx`.

### Done in Sunday Jun 7 work

- ✅ Added 7 new flags to `packages/types/modules.ts`: `motive_integration`, `trailers`, `performance`, `driver_app`, `dispatch_board`, `custom_documents`, `relay_advanced`. Each has a label and blurb suitable for the Modules settings UI. (commit `42b3203` introduced 8 incl. `mini_calendar`; the follow-up commit removed `mini_calendar` after founder review.)
- ✅ Typecheck passes; existing behavior unchanged (all 7 default to ON for existing orgs).
- ✅ Validation corrections added to this doc above.
- ✅ Q1 resolved: MiniCalendar promoted to MVP (Section 1, Sidebar group).

### Remaining for Day 1 (Mon Jun 8)

- Wire the signup flow to write the 7 new flags as `false` on the new org_settings row.
- Curzon's existing row already has them implicitly true (absent key = enabled). No action needed unless you want to be explicit for clarity.
- Define `SMS_ENABLED` env var on Vercel (don't ship Row 57 placeholder yet without it).
- Skim Payroll for ~10 min to confirm dogfood-readiness.

---

## How to use this doc

1. Section 1 is the **launch-blocking work**: every row here must be visible, wired, and shipping by Friday.
2. Section 2 is the **hide-but-keep work**: code stays, module flag gates UI, default OFF for new orgs, ON for Curzon.
3. Section 3 is the **module flag schema + integration config flags** — add the new flags to your Clerk org metadata model and feature-flag util.
4. Section 4 is the **shippability watchlist** — MVP rows that were promoted from DEFER/HIDE and need verification this week.
5. Section 5 is the **open questions / deltas** — choices that deviate from the audit hypothesis enough to flag for re-review.

---

## Summary deltas vs. auditor hypothesis

| Change | Rows | Why this matters |
|---|---|---|
| **DEFER/HIDE → MVP** (promoted, 14 rows) | 5, 6, 9, 15, 28, 29, 34, 36, 40, 44, 50, 54, 55, 60 | These need to actually ship, not just be visible. Check section 4 for which carry real risk. |
| **CUT → Later** (kept, 2 rows) | 24 (Equipment), 45 (Driver app settings) | Both still hidden, but code path stays warm. Will flip ON at Growth/Fleet tier or for Curzon. |

**Cut from nav: 0.** This is intentional — nothing gets stripped, everything is gated. Means cleaner upgrade story (every tier flips features on, nothing is dead weight in the repo).

---

## 1. MVP feature list (must ship Friday)

Grouped by surface. File paths from the audit; verify they still match after Claude Code's recent refactor.

### Calendar core (6)
| Row | Feature | Path |
|---|---|---|
| 1 | Calendar grid | `apps/web/app/calendar/page.tsx` |
| 2 | New Load modal | `apps/web/components/calendar/EventModal.tsx` |
| 18 | Calendar header (assets) | `apps/web/components/calendar/CalendarHeader.tsx` |
| 53 | Stops section (incl. relay leg toggle) | `apps/web/components/calendar/StopsSection.tsx` |
| 65 | EventModal parent container | `apps/web/components/calendar/EventModal.tsx` |

> **Note on row 53:** Relay leg toggle stays visible in MVP (Curzon uses it; not gating). For new orgs that don't use relays, the toggle is a small UI element that doesn't add cognitive overhead the way a separate panel would.

### Calendar toolbar (10)
| Row | Feature | Path |
|---|---|---|
| 4 | Search loads | `apps/web/components/toolbar/CalendarToolbar.tsx` |
| 5 | Trash / Recently Deleted | `apps/web/components/toolbar/CalendarToolbar.tsx` |
| 6 | Layers (overlay toggle) | `apps/web/components/toolbar/CalendarToolbar.tsx` |
| 9 | Screen adjustments (sliders) | `apps/web/components/toolbar/CalendarToolbar.tsx` |
| 10 | View toggle (day/week) | `apps/web/components/toolbar/CalendarToolbar.tsx` |
| 11 | Today button | `apps/web/components/toolbar/CalendarToolbar.tsx` |
| 12 | Prev/Next navigation | `apps/web/components/toolbar/CalendarToolbar.tsx` |
| 13 | Date picker | `apps/web/components/calendar/DatePicker.tsx` |
| 14 | Batch progress indicator | `apps/web/components/toolbar/CalendarToolbar.tsx` |
| 15 | Learning center | `apps/web/components/onboarding/LearningCenter.tsx` |

### Fleet panels (1)
| Row | Feature | Path |
|---|---|---|
| 7 | Truck fleet panel | `apps/web/components/calendar/TruckFleetPanel.tsx` |

### Main nav pages (5)
| Row | Feature | Path |
|---|---|---|
| 3 | Batch import (rate-con parser) | `apps/web/components/sidebar/AssetSidebar.tsx` |
| 20 | Dashboard | `apps/web/app/dashboard/page.tsx` |
| 22 | Closeout | `apps/web/app/closeout/page.tsx` |
| 23 | Accounting | `apps/web/app/accounting/page.tsx` |
| 28 | Payroll | `apps/web/app/payroll/page.tsx` |

### Settings (12)
| Row | Feature | Path |
|---|---|---|
| 29 | Appearance | `apps/web/app/settings/page.tsx` |
| 30 | Timezone | `apps/web/app/settings/page.tsx` |
| 31 | Assets | `apps/web/app/settings/page.tsx` |
| 33 | Load fields | `apps/web/app/settings/page.tsx` |
| 34 | Card layout | `apps/web/app/settings/page.tsx` |
| 35 | Rate-Con AI | `apps/web/app/settings/page.tsx` |
| 36 | Saved locations | `apps/web/app/settings/page.tsx` |
| 37 | Dispatchers | `apps/web/app/settings/page.tsx` |
| 38 | Customers | `apps/web/app/settings/page.tsx` |
| 39 | Members | `apps/web/app/settings/page.tsx` |
| 40 | Role permissions | `apps/web/app/settings/page.tsx` |
| 44 | Invoicing template | `apps/web/app/settings/page.tsx` |

### Modals & workflows (5)
| Row | Feature | Path |
|---|---|---|
| 46 | Flag modal | `apps/web/components/closeout/FlagModal.tsx` |
| 47 | Internal notes modal | `apps/web/components/closeout/InternalNotesModal.tsx` |
| 49 | Invoice detail modal | `apps/web/components/invoicing/InvoiceDetailModal.tsx` |
| 50 | Broker profile modal | `apps/web/components/brokers/BrokerProfileModal.tsx` |
| 51 | New broker review modal | `apps/web/components/calendar/NewBrokerReviewModal.tsx` |

### EventModal sub-panels (3)
| Row | Feature | Path |
|---|---|---|
| 54 | Route map | `apps/web/components/calendar/RouteMapPanel.tsx` |
| 55 | Check calls section | `apps/web/components/calendar/CheckCallsSection.tsx` |
| 57 | Notify Driver popover (placeholder, see below) | `apps/web/components/calendar/NotifyDriverPopover.tsx` |

> **Row 57 placeholder pattern.** UI ships as designed but the send action is gated by an `sms_enabled` integration config flag (see Section 3, integration config flags). When the flag is `false` (default until Twilio A2P 10DLC approval lands), tapping the send button shows a state like *"SMS provisioning in progress — text your driver manually for now"* instead of attempting a send or showing fake success. Implementation should:
> 1. Render the popover UI unconditionally
> 2. Read `sms_enabled` from server config (env var or a single org-agnostic config row, not per-org)
> 3. If `false`, replace the send CTA with the placeholder state; keep load context visible so the dispatcher can copy/paste into their phone if needed
> 4. If `true`, fire the SMS via the existing send path
> No code change needed when approval lands — just flip the config.

### Sidebar (6)
| Row | Feature | Path |
|---|---|---|
| 59 | Mini calendar (sidebar date picker) | `apps/web/components/sidebar/MiniCalendar.tsx` |
| 60 | Category filters | `apps/web/components/sidebar/AssetSidebar.tsx` |
| 61 | Manage assets button | `apps/web/components/sidebar/AssetSidebar.tsx` |
| 62 | Manage drivers button | `apps/web/components/sidebar/AssetSidebar.tsx` |
| 63 | Assets modal | `apps/web/components/sidebar/AssetsModal.tsx` |
| 64 | Drivers modal | `apps/web/components/sidebar/DriversModal.tsx` |

> **Note on row 59 (added 2026-06-05):** MiniCalendar is the month-view date picker in the calendar sidebar — prev/next month arrows + day cells that jump `currentDate`. It's plumbing, not a billable feature. Module-flagging it failed the "does this earn a tier toggle?" sanity check, so it was demoted out of the flag schema and promoted to MVP-always-on. See Q1 in Section 5 for the original question.

---

## 2. Later / hidden features (module-flagged OFF for new orgs)

Code stays in repo. Each feature checks its module flag before rendering. Default OFF for new orgs (set in Clerk org metadata at signup). Curzon org has all flags ON.

Grouped by suggested module flag:

### `motive_integration` (gates Motive ELD surfaces)
| Row | Feature | Path |
|---|---|---|
| 17 | Asset detail modal (Motive location/history) | `apps/web/components/calendar/AssetDetailModal.tsx` |
| 19 | Movements toggle | `apps/web/components/calendar/CalendarHeader.tsx` |
| 42 | Integrations settings | `apps/web/app/settings/page.tsx` |

> **Bleed-through warning:** The audit flagged that Motive surfaces leak across multiple components. When `motive_integration: false`, verify these *all* hide cleanly: AssetDetailModal, Movements toggle, TrailerFleetMap (row 8), Truck Fleet Panel location data (row 7), NotificationsBell location features (row 16). A single component that doesn't check the flag will show empty/broken UI to non-Motive orgs.

### `trailers` (gates trailer features — independent of Motive)
| Row | Feature | Path |
|---|---|---|
| 8 | Trailer fleet map | `apps/web/components/calendar/TrailerFleetMapPanel.tsx` |
| 32 | Trailers settings | `apps/web/app/settings/page.tsx` |

### `performance` (existing flag — gates analytics)
| Row | Feature | Path |
|---|---|---|
| 25 | Drivers scorecards page | `apps/web/app/drivers/page.tsx` |
| 26 | Performance page | `apps/web/app/performance/page.tsx` |
| 27 | Timeline (asset history) | `apps/web/app/assets/[id]/timeline/page.tsx` |
| 52 | Driver summary panel (in EventModal) | `apps/web/components/calendar/DriverSummaryPanel.tsx` |

### `maintenance` (existing flag — gates equipment workflows)
| Row | Feature | Path |
|---|---|---|
| 24 | Equipment page (Maint/Insp/Fuel) | `apps/web/app/equipment/page.tsx` |
| 58 | Linked work orders (in EventModal) | `apps/web/components/calendar/LinkedWorkOrdersSection.tsx` |

### `driver_app` (existing flag — gates driver mobile features)
| Row | Feature | Path |
|---|---|---|
| 16 | Notifications bell (push log) | `apps/web/components/toolbar/NotificationsBell.tsx` |
| 45 | Driver app settings | `apps/web/app/settings/page.tsx` |

### `dispatch_board` (new flag — gates real-time dispatch UI)
| Row | Feature | Path |
|---|---|---|
| 21 | Command Center / Board | `apps/web/app/board/page.tsx` |
| 48 | Follow-up modal | `apps/web/components/closeout/FollowUpModal.tsx` |

### `custom_documents` (new flag — gates document type customization)
| Row | Feature | Path |
|---|---|---|
| 43 | Documents settings | `apps/web/app/settings/page.tsx` |

### `relay_advanced` (new flag — gates relay handoff documentation)
| Row | Feature | Path |
|---|---|---|
| 56 | Relay handoff photos | `apps/web/components/calendar/RelayHandoffPhotos.tsx` |

> **Note:** Basic relay leg support (row 53, in Stops section) stays in MVP. Only the photo handoff documentation is gated. This matches the earlier decision: keep relay logic visible since Curzon validates it; gate the gold-plating.

### `admin_only` (NOT a module flag — role-based hide)
| Row | Feature | Path |
|---|---|---|
| 41 | Modules settings page | `apps/web/app/settings/page.tsx` |

> **Row 41 (Modules settings) — keep it simple.** Module flags are subscription-tier controlled, not user-toggleable. Implementation: barebones toggle screen visible only to org owners (role check), surfacing whatever handful of flags warrant user control (likely none in MVP — keep it server-side). Don't engineer for flexibility you don't need yet; you can expand the screen later if a tier comes along where users genuinely need to toggle their own modules.

---

## 3. Module flag schema + integration config

### Module flags (per-org, in Clerk metadata)

Existing flags (assumed, from audit description of row 41):
- `closeout` — default ON (MVP)
- `accounting` — default ON (MVP)
- `payroll` — default ON (MVP, but see watchlist)
- `maintenance` — default OFF
- `driver_app` — default OFF
- `performance` — default OFF

New flags to add:
- `motive_integration` — default OFF
- `trailers` — default OFF
- `performance` — default OFF (corrected: not previously existing)
- `driver_app` — default OFF (corrected: not previously existing)
- `dispatch_board` — default OFF
- `custom_documents` — default OFF
- `relay_advanced` — default OFF

(`mini_calendar` was originally listed as a new flag but was removed 2026-06-05 — see Q1 resolution in Section 5.)

### Integration config flags (system-wide, not per-org)

These are different from module flags — they gate *integrations* based on external state (approvals, credentials, etc.), not subscription tier.

- `sms_enabled` — default `false`. Flips to `true` when Twilio A2P 10DLC approval is received. Lives in env or a single config table row, not in per-org metadata. Gates the send action on Row 57 (Notify Driver popover). UI still renders so dispatchers can copy load context to text drivers manually until approval lands.

Add a parallel `useIntegrationConfig('sms_enabled')` hook (or whatever pattern matches your existing config layer) — distinct from `useModuleFlag` so the two concepts don't get conflated in component code.

### Where module flags live
Clerk org `publicMetadata.modules` — boolean map. Read via a single hook `useModuleFlag('motive_integration')` that returns the boolean. Components that gate UI must wrap their render in a check; routes that gate pages must redirect to `/dashboard` if the flag is OFF.

### Curzon override
Curzon's org gets all module flags set to `true` directly in Clerk metadata. This is how Curzon stays the proof-of-concept running the full system while new $149 orgs see only the MVP surface. The `sms_enabled` integration config remains `false` until Twilio approval lands — applies to all orgs uniformly.

---

## 4. Shippability watchlist (verify before Friday)

These are the rows that carry real launch risk. Each should be exercised in a clean test org before locking.

### Highest risk

**Row 28 — Payroll** (`apps/web/app/payroll/page.tsx`)
The auditor explicitly flagged this as "implementation may not be ready." Verify:
- Pay period selection works end-to-end
- Driver payouts calculate correctly with percentage rules
- Detention/accessorial charges compute right
- Export format (CSV or PDF) lands in something usable
- Edit/lock per-driver works without state desync

If any of this is half-baked, payroll is the strongest candidate for a launch-week delay. Bad payroll math = lost trust on day one.

### Medium risk (promoted from DEFER, real wiring needed)

**Row 57 — Notify Driver popover placeholder** (`apps/web/components/calendar/NotifyDriverPopover.tsx`)
Verify the placeholder state actually renders when `sms_enabled: false`. Specifically:
- No silent fail when send is tapped — placeholder copy shows instead
- Load context (truck, pickup time, address) remains visible so dispatcher can manually text
- No fake success toast, no error toast — the placeholder is the response
- When `sms_enabled` is flipped to true in dev, popover sends real SMS via existing path

**Row 50 — Broker profile modal** (`apps/web/components/brokers/BrokerProfileModal.tsx`)
FMCSA complaints API call. Verify graceful timeout handling so a slow API doesn't block load detail rendering. Also verify the modal opens from both calendar and closeout entry points.

**Row 54 — Route map** (`apps/web/components/calendar/RouteMapPanel.tsx`)
Verify the map renders for all stop counts (2-stop, 3-stop, relay). Distance/time estimates should be close enough to not embarrass — if they're wildly off, hide them rather than show wrong numbers.

**Row 55 — Check calls section** (`apps/web/components/calendar/CheckCallsSection.tsx`)
Verify call times persist and the panel doesn't make the already-large EventModal feel unusable. Consider whether this should be collapsed by default.

**Row 51 — New broker review modal** (`apps/web/components/calendar/NewBrokerReviewModal.tsx`)
Critical to batch import flow. Verify edge cases: parser finds unknown shipper, parser finds fuzzy match to existing customer, parser finds two possible matches. Create vs merge logic must be unambiguous to the user.

**Row 35 — Rate-Con AI settings** (`apps/web/app/settings/page.tsx`)
Custom extraction instructions and prompt variables. Verify that adding a custom variable actually flows through to the parser output. This is a marketed differentiator — must work cleanly or remove from MVP.

### Lower risk (mostly UI polish, but verify)

- **Row 5 (Trash):** Verify 30-day auto-purge works, restore button re-adds to calendar without state issues
- **Row 6 (Layers):** Verify toggle states persist on page reload
- **Row 15 (Learning center):** Verify links don't 404, popover opens/closes cleanly
- **Row 29 (Appearance):** Verify dark theme actually applies across calendar, modals, all pages — partial dark mode looks worse than none
- **Row 34 (Card layout):** Verify hiding fields from cards doesn't break field display in EventModal
- **Row 36 (Saved locations):** Verify autocomplete works in EventModal stops
- **Row 40 (Role permissions):** Verify role changes propagate (e.g., demoting dispatcher to viewer hides write actions)
- **Row 44 (Invoicing template):** Verify logo upload, footer text, custom numbering all persist to PDF output

### Verification protocol
For each row above, do one round-trip in a clean test org (not Curzon's data). Document the result in a `docs/mvp-watchlist-verification.md` companion doc. Anything red gets cut to Later before Friday.

---

## 5. Open questions / deltas to revisit

### Q1 — Row 59 (Mini calendar) ✅ RESOLVED 2026-06-05
**Decision: promote to MVP, remove from module-flag schema.** Founder pushback during v2.1 review: MiniCalendar is just the sidebar month-view date picker, not a feature that warrants a billing-tier toggle. Module flags exist for things that cost money to run (Motive), need external infra (driver app), customize the product fundamentally (custom documents), or map to a competitive tier (performance analytics). A date picker is plumbing. Demoted from Section 2 to Section 1 (Sidebar group, Row 59) and removed from the `OrgModule` union.

### Q2 — Row 41 (Modules settings) in Later, role-gated
The settled approach: visible only to org owners, with a minimal toggle UI (or empty for now), all tier-controlled flags managed server-side. Verify Claude Code implements the role check correctly so you can still toggle module flags for yourself when needed — and that the page doesn't accidentally surface tier-locked flags to end users.

### Q3 — MVP scope (46 rows)
The 46 rows decompose to four cohesive workflows: calendar → load detail → closeout → accounting. Not 46 features, four workflows expressed as many components. Count is fine. The verification protocol in Section 4 still applies — if a promoted row fails clean-org testing, demote it to Later before Wednesday rather than ship something half-working.

---

## 6. Suggested implementation order

### Day 1 (Mon) — verification + flag schema
- Add the six new module flags to Clerk metadata model and feature-flag util
- Add the `sms_enabled` integration config flag (env var or single config row); confirm `useIntegrationConfig` hook pattern
- Set Curzon org to all module flags `true`; new test org to MVP-only `true`
- Verify Modules settings page (row 41) is role-gated to org owner
- Run shippability watchlist (Section 4) — flag anything that doesn't pass

### Day 2 (Tue) — gate the Later features
- Wrap all 19 Later-tier components in module-flag checks
- Implement Row 57 placeholder behavior: popover UI renders, send action gated by `sms_enabled`, placeholder copy when off
- Verify Motive bleed-through: turn `motive_integration: false` in test org, sweep calendar/header/sidebar for any leaking Motive UI
- Strip nothing from nav — features just disappear when flagged off

### Day 3 (Wed) — open question resolutions + demotion calls
- Resolve Q1 (Mini calendar): confirm intentional or promote
- Verify Q2 (Modules settings role gating) works as intended
- Make demotion calls from watchlist failures (Q3) — anything red in section 4 goes to Later

### Day 4 (Thu) — clean-org dogfood + marketing copy
- Create fresh test org, walk the full "rate con → invoice paid" hero loop
- Note any UI that feels half-shipped → demote or polish
- Write the Starter tier feature list for marketing, derived from this doc's Section 1
- Confirm Row 57 placeholder copy reads well to a dispatcher who's never heard of A2P 10DLC

### Day 5 (Fri) — launch
- Last sweep
- Marketing site copy matches Section 1 exactly (no over-promising)
- First customer onboarding

---

## Appendix: feature ID lookup

If Claude Code references "row 28" or similar, this is the inventory row ID from `docs/mvp-feature-inventory.md`. Maintain this numbering across all docs in this series for cross-referencing.
