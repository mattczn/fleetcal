-- 20260913_hos_duty_tracking.sql
--
-- HOS (Hours of Service) duty tracking — phase 1.
--
-- WHAT THIS IS: a dispatch planning + log-enforcement layer, NOT a
-- compliance system of record. Motive remains the ELD/RODS record for
-- drivers running one. For short-haul (150 air-mile) drivers who are
-- ELD-exempt, the clock in/out records here ARE the employer time
-- record required by 49 CFR 395.1(e)(1)(v) — start time, end time,
-- total on-duty hours. That has two consequences baked into the design
-- below:
--   1. 6-month retention minimum (395.8(k)(1)) — never hard-delete.
--   2. Corrections must be auditable — see the void/supersede trail on
--      hos_duty_events.
--
-- WHAT'S DELIBERATELY NOT HERE:
--   * Drive time. We track ON-DUTY only. The 11-hour driving limit and
--     the 30-minute break are driving-time triggers and cannot be
--     computed from this data; for ELD drivers those come from Motive
--     (phase 3). On-duty is a safe upper bound for driving, so
--     on-duty-based warnings fire early, never late.
--   * A daily rollup table. Cycle math is computed from shift intervals
--     with clipping (see lib/hos.ts) because a 34-hour restart can land
--     mid-day and a per-day sum would over-count the restart's start
--     day. At fleet scale here it's ~10 rows per driver per window.
--   * Air-mile classification. Phase 1 classification is declared
--     (driver default / dispatch override). The columns are shaped so
--     auto-classification from stop geocodes can fill them later with
--     no migration.

-- ── 1. Duty events — append-only clock in / clock out ────────────────
--
-- The source of truth. Shifts (below) are derived from this.
-- Rows are never updated except to stamp the void columns; occurred_at
-- and status are immutable once written.
create table if not exists hos_duty_events (
  id          uuid primary key default gen_random_uuid(),
  org_id      text   not null,
  driver_id   bigint not null references drivers(id) on delete cascade,
  status      text   not null check (status in ('on_duty', 'off_duty')),
  occurred_at timestamptz not null,

  -- Where the event came from. 'auto_close' is the 14-hour safety net
  -- that closes a runaway shift so it can't poison the cycle math.
  source text not null default 'driver_app'
    check (source in ('driver_app', 'dispatch_edit', 'auto_close', 'motive')),

  -- Captured best-effort at clock in/out. NULL is expected and fine —
  -- a driver in a dead zone still gets to start their shift.
  location_lat double precision,
  location_lon double precision,

  note text,

  -- ── Correction trail ──
  -- A correction NEVER edits an event. It inserts a new row (with
  -- corrects_event_id pointing back) and stamps voided_at +
  -- voided_by_event_id on the row it supersedes. All rollups read
  -- `where voided_at is null`; the original stays queryable forever so
  -- "what did the driver originally report vs what did dispatch
  -- change it to" is always answerable.
  voided_at          timestamptz,
  voided_by_event_id uuid references hos_duty_events(id),
  corrects_event_id  uuid references hos_duty_events(id),

  created_by_driver_id bigint references drivers(id),
  created_by_user_id   text,   -- clerk user id, set on dispatch edits
  created_by_name      text,
  created_at           timestamptz not null default now()
);

create index if not exists hos_duty_events_driver_time_idx
  on hos_duty_events (driver_id, occurred_at desc) where voided_at is null;
create index if not exists hos_duty_events_org_time_idx
  on hos_duty_events (org_id, occurred_at desc) where voided_at is null;

-- ── 2. Shifts — derived rollup, one row per clock-in/clock-out pair ──
create table if not exists hos_shifts (
  id         uuid primary key default gen_random_uuid(),
  org_id     text   not null,
  driver_id  bigint not null references drivers(id) on delete cascade,

  started_at timestamptz not null,
  ended_at   timestamptz,            -- NULL = driver is on duty right now
  start_event_id uuid not null references hos_duty_events(id),
  end_event_id   uuid references hos_duty_events(id),
  on_duty_seconds int,               -- denormalized at close for reporting

  -- ── Log-enforcement loop ──
  -- classification drives WHICH rules apply (a short-haul day is exempt
  -- from the 30-min break and from keeping a RODS). log_method +
  -- log_verified_* are the accountability trail: when a shift flags OTR,
  -- someone on dispatch has to affirmatively record how that driver is
  -- logging, and their name lands here.
  classification text not null default 'local'
    check (classification in ('local', 'otr')),
  classification_source text not null default 'default'
    check (classification_source in ('default', 'driver', 'dispatch', 'computed')),
  log_method text not null default 'none'
    check (log_method in ('none', 'motive', 'paper')),
  log_verified_by text,
  log_verified_at timestamptz,

  -- Set by the 14-hour safety net. The shift still counts, but the
  -- end time is an estimate until someone corrects it.
  auto_closed boolean not null default false,

  -- Drives the dispatch correction worklist.
  needs_review  boolean not null default false,
  review_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A driver can only have one open shift. This is the constraint that
-- makes double clock-in impossible rather than merely unlikely.
create unique index if not exists hos_shifts_one_open_per_driver
  on hos_shifts (driver_id) where ended_at is null;

create index if not exists hos_shifts_driver_start_idx
  on hos_shifts (driver_id, started_at desc);
create index if not exists hos_shifts_org_start_idx
  on hos_shifts (org_id, started_at desc);
-- Powers the dispatch worklist without scanning history.
create index if not exists hos_shifts_review_idx
  on hos_shifts (org_id, started_at desc) where needs_review;
-- Powers "which OTR shifts still need a log verified".
create index if not exists hos_shifts_unverified_otr_idx
  on hos_shifts (org_id, started_at desc)
  where classification = 'otr' and log_verified_at is null;

-- ── 3. Driver-level config ───────────────────────────────────────────
-- HOS applies to every trucking operation, not just this tenant, so
-- these are real columns rather than a JSONB blob.
alter table drivers
  add column if not exists hos_enabled boolean not null default true;

alter table drivers
  add column if not exists hos_default_classification text not null default 'local';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'drivers_hos_default_classification_check'
  ) then
    alter table drivers
      add constraint drivers_hos_default_classification_check
      check (hos_default_classification in ('local', 'otr'));
  end if;
end $$;

-- ── 4. Org-level config ──────────────────────────────────────────────
-- Matches the existing invoice_settings JSONB pattern on this table.
--   cycle              '70_8' (carrier operates every day) | '60_7'
--   homeTerminalLat/Lon  centre of the 150 air-mile short-haul radius,
--                        used by phase-2 auto-classification
-- Timezone is NOT duplicated here — org_settings.timezone already
-- exists and is the authority for which calendar day a shift lands on.
alter table org_settings
  add column if not exists hos_settings jsonb not null default '{"cycle":"70_8"}'::jsonb;
