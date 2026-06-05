# FleetCal MVP Feature Inventory

> Generated 2026-06-05 (~1 week before planned Friday 2026-06-12 launch).
> Source: structured Explore-agent pass over apps/web nav, pages, modals, toolbar.
> Purpose: decision-grade list to drive the MVP / cut / hide / defer decisions
> for a stripped-down launch targeting 1-14 truck carriers at 3 tiers
> ($149 / $299 / $499 monthly).

---

## How to use this doc

1. The **Hypothesis** column is the auditor's *initial guess* for each feature.
2. The **Final** column (right-most) is for the founder to fill in as he goes
   through dogfood sessions in a clean test org.
3. When the Final column overrides the Hypothesis, add a one-liner to the
   **Decision overrides** section below explaining why.
4. The **Notes for dogfood** column is the specific thing to test/observe
   when this feature is encountered in the new account.

The hypothesis vocabulary:

| Label | Meaning |
|---|---|
| **MVP** | Ship Friday. Core to "rate-con email → invoice paid" hero workflow. |
| **HIDE** | Code stays, feature-flag/module-flag default OFF for new orgs. |
| **CUT** | Remove from nav config. Code stays in the repo for future revival. |
| **DEFER** | Visible but ambiguous — let dogfood tell us keep / hide / cut. |

---

## Summary (actual counts)

| Hypothesis | Count |
|---|---|
| **MVP** | 28 |
| **HIDE** | 14 |
| **CUT** | 2 |
| **DEFER** | 21 |
| **Total** | 65 |

The auditor's spoken-summary at the end of the inventory mentioned MID-TIER and
ALREADY-GATED categories. Those labels are not used in the rows below — they
collapsed into HIDE (for code that stays but is module-gated off for new orgs)
and CUT (for nav-stripped features). Treat the four-label vocabulary above as
the source of truth.

---

## The inventory

| # | Feature | Surface (where it lives) | File path | What it does (1 line) | Hypothesis | Why | Notes for dogfood | Final |
|---|---|---|---|---|---|---|---|---|
| 1 | Calendar (Load Grid) | Main page after auth | apps/web/app/calendar/page.tsx | Multi-truck weekly/daily view of scheduled loads with drag-to-reschedule, status/POD/billing overlays | MVP | Core to hero — dispatcher spends 80% of time here | Verify day/week toggle works, search finds loads, filters reset on page reload | |
| 2 | New Load (Create Modal) | Sidebar button | apps/web/components/calendar/EventModal.tsx | Modal for creating/editing loads with 20+ fields | MVP | Core hero — dispatcher creates/edits loads from rate con before scheduling | Test creating load with minimum fields, uploading PDF rate con, assigning driver | |
| 3 | Batch Import (Rate Con Parser) | Sidebar split button | apps/web/components/sidebar/AssetSidebar.tsx | Upload multiple PDFs, AI-parse shipper/route/rate, preview before commit | MVP | Core to "without typing the same info twice" | Test parsing real Curzon PDF, verify extracted fields match doc, test batch cancel at 50% | |
| 4 | Search Loads | Toolbar search icon | apps/web/components/toolbar/CalendarToolbar.tsx | Real-time search across load title, loadNum, refNums, driver, notes; DB-backed history | MVP | Essential dispatcher workflow | Test searching by load #, driver name, shipper initials; verify deleted loads show with status badge | |
| 5 | Trash / Recently Deleted | Toolbar trash icon | apps/web/components/toolbar/CalendarToolbar.tsx | View 10 most recently deleted loads with restore/purge actions, 30-day archive | HIDE | Auditor: not needed at launch. **Founder pushback: undoing accidental deletes is table-stakes UX. Promote to MVP?** | Verify deleted loads auto-purge after 30 days, restore button re-adds to calendar | |
| 6 | Layers (Overlay Toggle) | Toolbar eye icon | apps/web/components/toolbar/CalendarToolbar.tsx | Show/hide status pill, driver confirmed, POD, billing on calendar cards | DEFER | Nice-to-have visual polish | Verify toggles persist on page reload, try hiding POD layer then re-opening | |
| 7 | Truck Fleet Panel | Toolbar truck icon | apps/web/components/calendar/TruckFleetPanel.tsx | Side panel showing all assets with search, hide/show toggle, drill-down | MVP | Core to scheduling | Test hiding a truck, verify it disappears from calendar, search by truck name/unit | |
| 8 | Trailer Fleet Map | Toolbar container icon | apps/web/components/calendar/TrailerFleetMapPanel.tsx | Map view of all trailers with location pin + staleness indicator | DEFER | Useful for advanced ops; auto-hides when no trailers exist | Verify map loads, test refresh, confirm staleness color changes with age | |
| 9 | Screen Adjustments (Sliders) | Toolbar sliders icon | apps/web/components/toolbar/CalendarToolbar.tsx | Resize calendar columns + row height | HIDE | Useful but not essential | Try manual column resize, verify locked state persists | |
| 10 | View Toggle (Day/Week) | Toolbar pill buttons | apps/web/components/toolbar/CalendarToolbar.tsx | Switch between single-day and week view | MVP | Essential navigation | Verify week view shows Mon-Sun, day view shows full truck names, toggle persists | |
| 11 | Today Button | Toolbar pill | apps/web/components/toolbar/CalendarToolbar.tsx | Jump calendar to today's date | MVP | Standard calendar UX | Verify highlight appears only on today | |
| 12 | Prev/Next Navigation | Toolbar chevrons | apps/web/components/toolbar/CalendarToolbar.tsx | Move forward/backward by day or week | MVP | Essential navigation | Verify week nav moves exactly 7 days, day nav moves 1 day | |
| 13 | Date Picker | Toolbar date label | apps/web/components/calendar/DatePicker.tsx | Click to open month calendar and jump to specific date | MVP | Convenience for jumping far ahead/behind | Test jumping from Jan 1 to Dec 31, verify month header updates | |
| 14 | Batch Progress Indicator | Toolbar right side | apps/web/components/toolbar/CalendarToolbar.tsx | "Parsing 3 of 10…" with cancel; "4 loads ready" + Review when done | MVP | Essential feedback during AI parsing | Test cancel mid-parse, verify counter increments, confirm Ready state shows correct count | |
| 15 | Learning Center | Toolbar question mark icon | apps/web/components/onboarding/LearningCenter.tsx | Help/tutorial popover with contextual tips | DEFER | Onboarding aid; may suppress until v2 | Verify popover opens/closes, check link destinations don't 404 | |
| 16 | Notifications Bell | Toolbar right side | apps/web/components/toolbar/NotificationsBell.tsx | Badge showing driver push notifications + scheduled-push log (48h) | DEFER | Driver communication — code stays but consider hiding without driver-app | Test badge count, verify old notifications drop off after 48h | |
| 17 | Asset Detail Modal | Calendar header asset click | apps/web/components/calendar/AssetDetailModal.tsx | Click truck to see live Motive location, "X min ago" timestamp, movement history | HIDE | ELD/Motive feature — gate behind Motive integration, default OFF | Verify location updates on refresh, confirm old age turns gray | |
| 18 | Calendar Header (Assets) | Calendar sticky header | apps/web/components/calendar/CalendarHeader.tsx | Visible trucks by date range with color dot, name, unit#, Motive location | MVP | Essential for quick visual asset status | Test header updates when filtering assets, verify location badge shows/hides based on Motive setup | |
| 19 | Movements Toggle (Motive) | Calendar header corner | apps/web/components/calendar/CalendarHeader.tsx | Switch from Loads mode to Movements mode | HIDE | Advanced feature for Motive users only | Test toggle, verify retry button works on failure | |
| 20 | Dashboard | Left nav link | apps/web/app/dashboard/page.tsx | Summary KPIs (revenue this week, avg cost/load, utilization %) with mini-charts | MVP | Basic metrics for fleet health at a glance | Check revenue calc excludes cancelled loads, verify utilization % makes sense | |
| 21 | Command Center / Board | Left nav link | apps/web/app/board/page.tsx | Real-time dispatch view showing active loads, drivers, quick-action buttons | DEFER | Nice control surface — hide from MVP nav, code stays | Verify "notify driver" button opens pre-filled modal, check arrived/confirmed update load status | |
| 22 | Closeout | Left nav link | apps/web/app/closeout/page.tsx | Four tabs (Pending, Flagged, All, Released) for POD verification + release-to-accounting | MVP | Core billing workflow | Test flagging a load, verify it moves to Flagged tab, test follow-up modal | |
| 23 | Accounting | Left nav link | apps/web/app/accounting/page.tsx | Five buckets (Released, Queued, Invoiced, Paid, All); batch generate/send | MVP | Core to "invoice paid" hero workflow | Test batch generate, "send all" queued, mark invoice paid, check payment method recorded | |
| 24 | Equipment | Left nav link | apps/web/app/equipment/page.tsx | Three tabs (Maintenance, Inspections, Fuel) | CUT | Out of MVP scope per founder definition; hide nav, code stays | If kept later, test maintenance report photo lightbox, verify fuel transaction date | |
| 25 | Drivers | Left nav link | apps/web/app/drivers/page.tsx | Per-driver scorecards over period (default This Week) | DEFER | Performance metrics; hide from MVP nav, keep code | Test period selector, verify POD % excludes cancelled loads, check "no activity" drivers don't show | |
| 26 | Performance (Assets & Drivers) | Left nav link | apps/web/app/performance/page.tsx | Dual tabs showing assets and drivers metrics | DEFER | Comparable to /drivers but with asset metrics | Verify asset revenue doesn't double-count relay loads | |
| 27 | Timeline (Asset History) | Drilled from AssetDetailModal | apps/web/app/assets/[id]/timeline/page.tsx | Per-truck activity chronology with date range picker | DEFER | Detailed asset history for forensics; drill-down only | Verify timeline loads only when asset ID valid, check filter by document type | |
| 28 | Payroll | Left nav link | apps/web/app/payroll/page.tsx | Pay period selector, driver payout table, edit/lock per driver, export | DEFER | **In MVP definition but auditor flagged implementation may not be ready — needs verification** | Test pay period selection, verify detention charges compute correctly, check export format | |
| 29 | Settings (Appearance) | Settings sidebar | apps/web/app/settings/page.tsx | Theme toggle (light/dark), text size scale | HIDE | Visual preference; default to system or light | Verify dark theme applies to calendar, modals, all pages | |
| 30 | Settings (Timezone) | Settings sidebar | apps/web/app/settings/page.tsx | Org-wide timezone picker | MVP | Essential for cross-tz orgs — all timestamps must be consistent | Test changing timezone, verify calendar dates shift and load times re-interpret | |
| 31 | Settings (Assets) | Settings sidebar | apps/web/app/settings/page.tsx | CRUD trucks: name, unit#, type, color, lifecycle, Motive integration toggle | MVP | Core asset management | Test creating truck, assigning Motive ID, archiving a truck, verify calendar updates | |
| 32 | Settings (Trailers) | Settings sidebar | apps/web/app/settings/page.tsx | CRUD trailers | HIDE | Not core to MVP hero job; feature flag OFF | If trailer support needed, test attaching trailer to load | |
| 33 | Settings (Load Fields) | Settings sidebar | apps/web/app/settings/page.tsx | Toggle which 20+ fields appear in EventModal; drag to reorder | MVP | Essential to avoid bloated modal for each org | Test toggling off shipper field, verify it disappears from EventModal, test drag reorder | |
| 34 | Settings (Card Layout) | Settings sidebar | apps/web/app/settings/page.tsx | Choose which fields display on calendar event cards vs only in modal | DEFER | Calendar card density optimization | Test hiding fields from cards, verify they still appear in modal | |
| 35 | Settings (Rate-Con AI) | Settings sidebar | apps/web/app/settings/page.tsx | Custom extraction instructions, prompt variables, enable/disable fields for parsing | MVP | Core to batch import — must tune AI parsing per carrier | Test adding custom variable and verify it appears in parsed results | |
| 36 | Settings (Saved Locations) | Settings sidebar | apps/web/app/settings/page.tsx | CRUD pickup/delivery favorites for autocomplete in EventModal stops | DEFER | Efficiency feature for repeated lanes | Test creating saved location, verify autocomplete works in EventModal | |
| 37 | Settings (Dispatchers) | Settings sidebar | apps/web/app/settings/page.tsx | List of users with dispatcher role; toggle active/inactive; edit | MVP | Access control for who can dispatch | Test adding dispatcher, verify they can log in and see loads | |
| 38 | Settings (Customers) | Settings sidebar | apps/web/app/settings/page.tsx | CRUD customers with aliases and parse hints; default invoice method/email | MVP | Critical for batch import + billing contact info | Test creating customer with alias, verify batch parser matches on alias, test invoice send goes to recorded email | |
| 39 | Settings (Members) | Settings sidebar | apps/web/app/settings/page.tsx | Invite/remove org members, assign role | MVP | First workflow in onboarding | Test inviting new member, verify invitation email sent | |
| 40 | Settings (Role Permissions) | Settings sidebar | apps/web/app/settings/page.tsx | Matrix view of capabilities per role; toggle read/write | HIDE | Advanced RBAC; default to sensible role definitions | Test setting "Dispatcher can generate invoices = true" | |
| 41 | Settings (Modules) | Settings sidebar | apps/web/app/settings/page.tsx | Feature flags for closeout/accounting/maintenance/payroll/driver-app/performance | HIDE | Module gating for tier-locking; default closeout/accounting ON, others OFF | Verify disabling closeout hides Closeout nav link | |
| 42 | Settings (Integrations) | Settings sidebar | apps/web/app/settings/page.tsx | Motive API credentials, webhook config, third-party SaaS connections | HIDE | Integration setup is not MVP-critical | If Motive setup required, test OAuth flow | |
| 43 | Settings (Documents) | Settings sidebar | apps/web/app/settings/page.tsx | Define custom document types (POD, DVIR, BOL, insurance) and which are required | HIDE | Document workflow customization | Test toggling POD as "required", verify driver can't complete load without upload | |
| 44 | Settings (Invoicing) | Settings sidebar | apps/web/app/settings/page.tsx | Invoice template customization: logo, footer, terms, tax ID, numbering | DEFER | Template nice-to-have; default should be acceptable | Test custom template persists across invoice sends, verify logo appears in PDF | |
| 45 | Settings (Driver App) | Settings sidebar | apps/web/app/settings/page.tsx | Driver mobile app config: branding, required docs, contact phone, notifications | CUT | Out of scope per founder; apps/driver is separate Expo project | Do not test; skip entirely | |
| 46 | Flag Modal | Within Closeout tab | apps/web/components/closeout/FlagModal.tsx | Flag a load for follow-up with reason + optional internal notes | MVP | Essential QA workflow | Test each flag reason, verify notes persist in load record | |
| 47 | Internal Notes Modal | Within Closeout/Accounting | apps/web/components/closeout/InternalNotesModal.tsx | Add/edit internal notes that don't appear on invoice; history of changes | MVP | Team coordination | Test editing notes, verify edit timestamp + author, check notes don't appear on invoice PDF | |
| 48 | Follow-Up Modal | Within Closeout flagged loads | apps/web/components/closeout/FollowUpModal.tsx | Schedule follow-up task on flagged load with due date + assignee | DEFER | Nice follow-up workflow but not essential | If kept, test assigning follow-up, verify notification sends | |
| 49 | Invoice Detail Modal | Accounting buckets | apps/web/components/invoicing/InvoiceDetailModal.tsx | View generated invoice with line items; edit method/terms before send; preview PDF | MVP | Essential for reviewing invoices before sending | Test editing invoice accessorials, verify total updates, test PDF preview renders correctly | |
| 50 | Broker Profile Modal | Calendar/Closeout load rows | apps/web/components/brokers/BrokerProfileModal.tsx | Click shipper to see org info (address, phone, MC#, FMCSA complaints) | DEFER | Reference data enrichment; useful for compliance | Test modal opens from load detail, verify complaint count pulls from API, check timeout handling | |
| 51 | New Broker Review Modal | EventModal when shipper unmatched | apps/web/components/calendar/NewBrokerReviewModal.tsx | When batch parser finds unknown shipper, create customer or merge with existing | MVP | Essential for batch import — must add unknowns on-the-fly | Test creating new customer from modal, verify it becomes available in future loads | |
| 52 | Driver Summary Panel | EventModal driver field | apps/web/components/calendar/DriverSummaryPanel.tsx | Click driver assignment to see scorecard: loads this week, miles, POD %, etc. | DEFER | Driver info drill-down | Test opening panel, verify load count matches /drivers page metric | |
| 53 | Stops Section | EventModal body | apps/web/components/calendar/StopsSection.tsx | Add/edit pickup/delivery stops with address, time, instructions; relay leg support | MVP | Core load data capture | Test adding third stop, verify map updates, test relay leg toggle splits load into two events | |
| 54 | Route Map | EventModal or standalone | apps/web/components/calendar/RouteMapPanel.tsx | Interactive map showing all stops with routing info, driving time, miles | DEFER | Visual route planning | Test map renders all stops, verify distance/time estimates | |
| 55 | Check Calls Section | EventModal body | apps/web/components/calendar/CheckCallsSection.tsx | Dispatch check-call log: pre-dispatch, pickup, delivery confirmation | DEFER | Compliance logging (DOT HOS) | If kept, test logging call time, verify auto-populate with current time | |
| 56 | Relay Handoff Photos | EventModal body | apps/web/components/calendar/RelayHandoffPhotos.tsx | Photo upload for relay leg handoff documentation | DEFER | Relay-specific QA | Test uploading photos for relay load, verify they don't appear on invoice | |
| 57 | Notify Driver Popover | EventModal buttons | apps/web/components/calendar/NotifyDriverPopover.tsx | Quick action: send push notification to assigned driver with load details + pickup time | MVP | Essential dispatch workflow (delivers via SMS even without driver app) | Test sending notification, verify driver receives alert with correct load details | |
| 58 | Linked Work Orders | EventModal body | apps/web/components/calendar/LinkedWorkOrdersSection.tsx | Link maintenance/DVIR work orders to a load; show linked count | HIDE | Equipment workflow; hide from modal | If enabled, test linking maintenance report to load | |
| 59 | Mini Calendar | Sidebar left side | apps/web/components/sidebar/MiniCalendar.tsx | Month calendar showing load counts per day; click to jump to date | HIDE | Auditor: useful but not essential. **Founder pushback: quiet dispatcher favorite — promote to MVP?** | Verify load counts update when creating loads, test date jump | |
| 60 | Category Filters | Sidebar below mini calendar | apps/web/components/sidebar/AssetSidebar.tsx | Chip buttons to filter calendar by asset type; "All" to reset | DEFER | Useful for multi-type fleets but maybe noise at 1-4 trucks | Test filtering to one category, verify calendar columns narrow to matching assets | |
| 61 | Manage Assets Button | Sidebar bottom | apps/web/components/sidebar/AssetSidebar.tsx | Opens AssetsModal — same as Settings → Assets but faster from calendar | MVP | Quick access to add/edit trucks without leaving dispatch tab | Test creating truck from modal, verify it appears in calendar immediately | |
| 62 | Manage Drivers Button | Sidebar bottom | apps/web/components/sidebar/AssetSidebar.tsx | Opens DriversModal — same as Settings → Members but faster from calendar | MVP | Quick access to add drivers without leaving dispatch tab | Test creating driver, verify email filled in, check Motive ID optional field | |
| 63 | Assets Modal | Modal dialog | apps/web/components/sidebar/AssetsModal.tsx | Full CRUD for trucks with inline editing | MVP | Primary place to manage fleet | Test bulk editing (select 2 trucks, hide together), verify sort by name/type | |
| 64 | Drivers Modal | Modal dialog | apps/web/components/sidebar/DriversModal.tsx | Full CRUD for drivers with inline editing | MVP | Primary place to manage driver roster | Test creating driver with email, verify Motive ID optional, test license expiry validation | |
| 65 | EventModal (Load Detail) | Calendar event click or new | apps/web/components/calendar/EventModal.tsx | 20+-field form for load capture (parent container of rows 53-58) | MVP | Single source of truth for all load data | Test all field types; test save with Enter key; test cancel discards changes | |

---

## Decision overrides (founder, fill as you go)

Format: `Row N — [Hypothesis → Final] — reason`

- _Row 5 (Trash / Recently Deleted) — HIDE → ? — undoing accidental deletes is table-stakes UX; revisit_
- _Row 28 (Payroll) — DEFER → ? — depends on whether implementation is actually ready; verify before committing_
- _Row 59 (Mini Calendar) — HIDE → ? — dispatcher convenience, consider promoting to MVP_
- _Add your overrides below as you click through dogfood sessions_

---

## Open questions for triage (auditor flagged)

1. **Payroll readiness.** Row 28. Auditor wasn't sure the page is shippable. Founder action: spend 10 min in `apps/web/app/payroll/page.tsx` and confirm or demote.
2. **Trash UX.** Row 5. Auditor said hide, but dispatchers WILL accidentally delete a load on day 1. Founder call.
3. **Mini Calendar.** Row 59. Hidden vs MVP — needs the dogfood-session "do I miss this?" test.
4. **Layers / Overlays.** Row 6. Status/POD/billing pills on calendar cards — keep visible or hide for "clean MVP"?
5. **Trailer Map.** Row 8. Auto-hides when no trailers; safe to keep code, decide post-launch.
6. **Drivers / Performance / Timeline.** Rows 25, 26, 27. Three overlapping analytics surfaces — pick at most one for MVP.

---

## What was definitely excluded (CUT — final)

| Feature | Why |
|---|---|
| Equipment tab (Maintenance / Inspections / Fuel) | Out of MVP scope; module flags already exist |
| Settings → Driver App config | Driver mobile app is a separate Expo project, not in MVP |

---

## Risks flagged during inventory

1. **Payroll may not be MVP-ready.** Verify before Tuesday's day-by-day work begins.
2. **Mini calendar + trash hides** may hurt first-impression usability more than they help cleanliness. Test with a real dispatcher before locking.
3. **Many DEFERs cluster in EventModal body** (Check Calls, Relay Handoff, Route Map, Driver Summary, Linked WOs, Broker Profile). If left visible, EventModal feels overwhelming to new users. Recommend hiding most by default in Settings → Load Fields, then enabling via toggle for power users.
4. **Motive surfaces leak across multiple features** (AssetDetailModal, Movements toggle, TrailerFleetMap, Truck Fleet Panel location data, NotificationsBell). Verify the Motive feature-flag gates all of them or some bleed through for non-Motive orgs.

---

## Handoff: continuing in another Claude session

This doc is meant to be edited iteratively. When opening in a fresh session,
the most useful context to give the next Claude is:

- This file's path: `docs/mvp-feature-inventory.md`
- Companion docs that should exist after this one is reviewed:
  - `docs/mvp-dogfood-session-plan.md` (not yet written)
  - `docs/mvp-feature-line.md` (the customer-facing "what we will and won't say yes to" doc, not yet written)
- The founder's MVP definition (from his own words):
  > "AI parser, asset scheduling, drivers, stops + load information, paperwork
  > upload, billing closeout, accounting (send invoice / mark paid), basic
  > dashboard, basic payroll. No ELD integration. No driver app. No dispatch
  > mobile app. No equipment workflows."
- The job sentence:
  > "FleetCal helps a 1–14 truck carrier go from rate-con email to invoice paid,
  > without leaving the app and without typing the same info twice."
- The pricing tiers: Starter $149 (1-4 trucks), Growth $299 (5-9), Fleet $499 (10-14).
- Target launch: Friday 2026-06-12.

Suggested next deliverables:
1. Verify Payroll readiness (Row 28). 10 min.
2. Generate `docs/mvp-dogfood-session-plan.md` — three structured 60-90 min
   sessions with specific test scenarios per session, mapped to the rows in
   this inventory.
3. Generate `docs/mvp-observation-template.md` — markdown capture form to
   fill during sessions; one section per scenario.
4. Generate `docs/mvp-feature-line.md` — public-facing roadmap with "Today /
   Next 90 days / Considering" columns, and internal "if a customer asks for
   X, here's the response" scripts for the top 10 likely asks.

When edits land in this file, version control will show what shifted —
useful for tracking how the cut-line evolved from initial hypothesis to
actual launch decision.
