# Movement → load linking

How FleetCal ties a truck's GPS (Motive driving periods, mirrored into
`movements`) to the calendar, and how the result feeds cost and
profitability calculations.

Status: phase 2 — results are saved (movement_links + leg_actuals) by a job
that re-links every truck's last 10 days every 6 hours
(`jobs/movementLinkSweep.ts` → `lib/movementLinkJob.ts`), once migration
`20261016_leg_actuals.sql` has been run.

## Ground rules (Matt, 2026-10-16)

- **The calendar is the source of truth.** Every paid driver movement is on
  it, so the truck on an event is right ~99% of the time and the time of day
  is approximately right. Linking never searches other trucks: it lines up
  ONE truck's GPS against THAT truck's calendar, in order. A disagreement is
  a flag for a person, not an automatic correction.
- **Never cut at midnight.** Loads run through the night and OTR trips span
  days. The engine aligns a truck's whole window as one continuous sequence;
  "days" only appear in reporting.
- **Return to the yard belongs to the last load** before the truck parks.
- **Rest on the road belongs to the leg in progress** (between legs: to the
  leg being driven to).
- **Idle at a yard belongs to no load** — it's unused capacity / overhead.
- **Non-revenue calendar entries are all "non-revenue moves"**, whatever
  their type says (most "Maintenance" entries are trailer moves, OOS, or
  failed attempts).
- **Rules first, AI for the judgment cases.** Code applies these rules where
  the answer is unambiguous; the AI gets only what's left, with coordinates,
  and its answers pass the same checks.

## Inputs

| Input | Source |
|---|---|
| GPS drives | `movements` (source `motive`) for the truck: start/end, miles, start/end coordinates |
| Calendar | the truck's `events` (revenue legs + non-revenue) with each leg's own stops (`stopsForLeg`) |
| Known places | `saved_locations` (SLC Yard, Springville Yard, relay points, HQ) — treated as home bases |

Times: event `start`/`end` and stop appointments are naive wall-clock strings
(org timezone; a stop's own `timezone` when set). GPS is UTC. Everything is
converted to UTC instants before comparing.

## Step 1 — visits

Between two consecutive GPS drives the truck sat somewhere: that's a *stay*,
located at the first drive's end point. Consecutive stays within 0.5 mi of
each other, joined only by sub-mile drives (dock moves, yard shuffles), merge
into one **visit** with an arrival and departure time. A visit within 0.75 mi
of a saved location is a **home visit** (yards, relay points, and drivers'
parking spots such as "Kevin's Parking (Pleasant Grove)"). Between two loads
the longest home visit is the overnight park that splits return from
deadhead.

**GPS gaps:** when a drive starts more than 2 mi from where the previous one
ended, the ELD was off in between (e.g. CT-2025, Aug 7–20: last seen in Eden
ID, reappeared at the SLC Yard 3,567 odometer miles later). That stretch
can't anchor stops (`gps_gap`) and its miles come from the odometer.

## Step 2 — anchor the calendar stops

The truck's calendar stops are put in calendar order: entries by start, each
entry's own stops by sequence. Expected time = appointment (handoff drop /
pickup time for relay boundaries), else interpolated across the event's
start→end.

**Loads carried together** (e.g. several pickups consolidated into one DHL
delivery): entries that overlap by more than an hour and have an appointment
on every stop are candidates. If calendar order leaves one of their stops
unmatched, the engine retries with that group interleaved by appointment and
keeps the retry only if more stops match. (Interleaving every overlap made
things worse — long OTR entries "overlap" the next leg on paper.) While two
loads are aboard, their shared miles are split evenly.

An ordered alignment (dynamic programming) assigns each stop to a visit or
leaves it unmatched:

- order is preserved; two stops may share one visit (same facility);
- a stop can only match a visit within **3 mi** and **36 h** of its expected time;
- cost grows with distance beyond **1 mi** and time beyond **±3 h**, and a
  very short visit (< 5 min) is penalized;
- leaving a stop unmatched costs more than any reasonable match, so the
  engine matches when it can and skips when it can't.

## Step 3 — label everything between anchors

| GPS activity | Role | Charged to |
|---|---|---|
| Drives between consecutive stops of the same leg | `loaded` | that leg |
| Time and dock moves inside a visit that hosts a stop | `dwell` | that stop |
| Delivery of leg A → pickup of leg B (no yard in between) | `deadhead` | leg B |
| Last delivery → the overnight park (yard or home parking) | `return` | that (last) leg |
| Overnight park → next pickup (incl. a quick yard stop for a trailer) | `deadhead` | that leg |
| Long stay (≥ 2 h) away from stops and yards | `rest` | leg in progress; between legs, the next leg |
| Visit at a yard with no stop | `idle` | nothing (overhead) |
| Drives inside a non-revenue entry | `non_revenue` | that entry |
| Drives the calendar can't explain | `unexplained` | flagged |

Stops left unmatched make the drives around them **uncertain** — those go to
the AI step (phase 3) or the review list.

## Step 4 — checks

- every GPS mile gets exactly one role, so per-truck totals reconcile to
  Motive's miles;
- stops anchored in calendar order;
- per leg, GPS loaded miles ÷ route (`loaded_miles`) within 0.8–1.25 (or
  within 15 mi on short legs);
- confidence per leg: **high** = every stop anchored within 1 mi and ±3 h and
  miles check passes; **medium** = anchored but looser; **low** = a stop
  unmatched.

Anything not high lands on the exceptions list with its reason:
`stop_no_coords`, `stop_not_found` (truck never within 3 mi in the window),
`stop_out_of_order` (it was, but not in calendar order), `miles_mismatch`,
`detour` (empty miles > 1.5 × the straight shot + 20 — an errand or home stop
the calendar doesn't show), `gps_gap`, `no_stops` (a revenue leg saved with
no stops — always a data problem), `unexplained_drive`, `no_gps`.

For a stop its own truck never reached, `otherTrucksAt` lists the other trucks
parked within 1 mi / ±3 h of it. Exactly one usually means the load changed
trucks and the calendar wasn't updated — flagged for a person (it affects
pay), never auto-corrected.

## First results (Aug 1 – Oct 12, 2,177 legs on GPS trucks)

High 51% · medium 29% · low 20%. 91.7% of stops matched; median 0.06 mi
from the pin and 0.6 h from the calendar time. GPS loaded ÷ route miles
median 1.02 (84.5% within 0.8–1.25). Of the 432 unmatched stops, 104 had
exactly one other truck there. GPS miles: loaded 55%, deadhead 18%, return
4%, non-revenue 1%, unexplained 2%, uncertain 19%. Driven per loaded mile:
local 1.80, OTR 1.21. Runs in ~15 s for the whole fleet.

## Data layers

1. **Raw** — Motive GPS (`motive_driving_periods` → `movements`), calendar.
2. **Links** — `movement_links`: every drive's role + event/stop + source
   (`rule_v1` / `ai_v2` / `manual`) + confidence + reason; append-only with
   supersede history; manual links are never overwritten. Needs a migration
   adding roles `idle` and `non_revenue` (`deadhead`/`return` map onto
   `transition` with to/from refs) and a `stop_visits` table for arrival /
   departure per stop.
3. **Leg actuals** — one row per calendar leg: truck, driver, arrival and
   departure per stop, GPS loaded miles and hours, dwell, deadhead and return
   charged to it, rest, peak vs off-peak hours, confidence.
4. **Truck-day summary** — miles and hours by role per truck per day;
   utilization.
5. **Model rates** — over a window: deadhead ratio (local/OTR, customer,
   pickup area, lane), dwell by facility, hours per load by lane, loaded miles
   per truck-day, fuel per mile by truck (Mudflap gallons ÷ GPS miles),
   maintenance per mile (spend ÷ ALL GPS miles), overhead per truck-hour
   (peak-weighted).

A load's cost = driver pay (calendar) + fuel & maintenance × (loaded +
charged deadhead + return) + hours × overhead rate. The rate-check tool uses
layer-5 averages to price a load before it happens.

## How results are stored

Links use the vocabulary the truck timeline, fleet performance and per-day
P&L already read, source `rule_v1`:

| Engine role | movement_links |
|---|---|
| loaded (and non-revenue) | `loaded`, loaded_event_id (non-revenue entries aren't revenue events, so readers leave those miles out of revenue math) |
| deadhead | `transition`, from_event_id = previous leg, to_event_id = this leg |
| return | `transition`, from_event_id = last leg, no to |
| dwell | `dwell`, loaded_event_id + dwell_stop_id |
| rest / idle | `rest` |
| unexplained | `unrelated` |
| uncertain / outside window / GPS gap | no link (an earlier `rule_v1` guess is withdrawn) |

Only changed links are written; a `manual` link is never touched; old facts
are superseded, not deleted (bulk supersedes leave `superseded_by` null).
Drives that ended < 6 h ago wait for the next run. Loads carried together
are linked to the first load aboard; the even split lives in leg_actuals.

`leg_actuals` holds one row per leg (miles, hours, truck start/end, stop
arrivals with issues and other-truck hints). Rows for legs later deleted or
cancelled in the calendar are not removed — join `events` and filter
`deleted_at` / `status`.

Backfill or re-run any range:
`railway run --service @fleetcal/api npx tsx apps/api/scripts/movement-link-backfill.ts <orgId> <from> <to> [--dry-run]`

## Reviewing

- **Timeline** (`/timeline?assetId=…&date=…&event=…`): clicking a load shows
  its **GPS check** — each stop's GPS arrival/departure vs the calendar,
  issues, other trucks that were there, miles charged — with **Looks right
  / Something's wrong** (reason + note) and **Ask AI**. Flagged loads get a
  dot on the day view. Fixing a single link = click the trip and change it
  (a `manual` link; the linker never overwrites it). "Re-link day / week"
  (and the fleet page's bulk re-link) run this engine via
  `POST /v1/timeline/assets/:id/auto-link` — the old Claude-by-city-name
  linker is gone.
- **GPS Review list** (`/timeline/review`): flagged loads across the fleet,
  filterable by confidence / issue / truck / not-yet-reviewed; each row
  opens the timeline at that load.
- **Verdicts** are append-only rows in `link_reviews` (migration
  `20261016b_link_reviews.sql`) with a snapshot of the leg as reviewed —
  the training set for tuning the rules. **Ask AI** (`lib/linkExplain.ts`,
  Claude Opus 5.5, structured output, server-side refusal fallback) reads
  the stops, the truck's GPS ±12 h, the loads around it and the reviewer's
  recent "wrong" notes, and returns summary / likely cause / fix; it changes
  nothing. Calls take ~20 s and are stored as `kind = 'ai'` rows.

Known blind spot: Motive merges a drive with a very short stop (a quick
trailer swap) into one driving period, so a stop of a few minutes can be
invisible — the AI flagged one such Las Vegas relay swap in testing.

## Phases

1. Rules engine + read-only accuracy report, August → now. **(this)**
2. Persist: migration, nightly job (re-aligns the last 10 days; writes only
   movements older than a few hours), backfill.
3. AI for uncertain spans (coordinates in the prompt, validated output).
4. Exceptions review list with one-click fixes.
5. Leg actuals → truck-day → model rates → weekly target + rate check.

Code: `apps/api/src/lib/movementLinker.ts` (pure engine),
`apps/api/src/lib/movementLinkerData.ts` (loader),
`apps/api/scripts/movement-link-report.ts` (report).
