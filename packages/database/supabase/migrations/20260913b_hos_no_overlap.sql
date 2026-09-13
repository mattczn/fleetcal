-- 20260913b_hos_no_overlap.sql
--
-- Make overlapping shifts structurally impossible, and give dispatch a
-- reversible way to remove a shift that was recorded wrong.
--
-- WHY A DB CONSTRAINT rather than the application guard added in
-- 1287ced: overlapping shifts are not a cosmetic problem. The rolling
-- cycle sums each shift's overlap with the 8-day window, so a doubled
-- hour is counted twice and a driver's 70/8 total silently inflates —
-- wrong in the direction that lets dispatch send out someone who is
-- actually out of hours. A check that lives only in one code path is
-- one direct write away from being bypassed; this one holds no matter
-- what writes the row.
--
-- Real example this was built from: three shifts for the same driver
-- covering 9:52–12:12, 10:18–12:20 and 10:49–11:50 on the same morning,
-- produced by dragging start times backwards across shifts that already
-- existed. The board read 5.4 hours on duty for a 2.5 hour span.

-- ── 1. Soft delete ───────────────────────────────────────────────────
--
-- Shifts are NOT hard-deleted. For short-haul drivers these rows are
-- the employer time record required by 49 CFR 395.1(e)(1)(v), which
-- carries a 6-month retention duty (395.8(k)(1)) — so "delete" marks
-- the row invisible to every read path while leaving it recoverable.
alter table hos_shifts
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by text;

create index if not exists hos_shifts_live_idx
  on hos_shifts (org_id, started_at desc) where deleted_at is null;

-- ── 2. Clear existing overlaps ───────────────────────────────────────
--
-- The constraint below refuses to be created while any overlap exists,
-- so resolve them first. Keeps the earliest-created shift of each
-- overlapping set and soft-deletes the rest; loops because resolving
-- one pair can leave another (three mutually-overlapping shifts need
-- two passes).
--
-- Deliberately soft, not hard: if this picks wrong, the row is still
-- there to be restored.
do $$
declare
  removed int;
begin
  loop
    with dup as (
      select a.id
      from hos_shifts a
      join hos_shifts b
        on  a.driver_id = b.driver_id
        and a.id <> b.id
        and a.deleted_at is null
        and b.deleted_at is null
        and tstzrange(a.started_at, coalesce(a.ended_at, 'infinity'::timestamptz), '[)')
         && tstzrange(b.started_at, coalesce(b.ended_at, 'infinity'::timestamptz), '[)')
        -- Keep the one recorded first; drop whatever was layered on top.
        and (b.created_at, b.id) < (a.created_at, a.id)
      where a.deleted_at is null
      limit 1
    )
    update hos_shifts
       set deleted_at = now(),
           deleted_by = 'migration 20260913b: overlapping shift'
     where id in (select id from dup);
    get diagnostics removed = row_count;
    exit when removed = 0;
  end loop;
end $$;

-- ── 3. The constraint ────────────────────────────────────────────────
--
-- btree_gist lets a plain-equality column (driver_id) sit alongside a
-- range overlap operator in the same exclusion constraint.
create extension if not exists btree_gist;

-- '[)' bounds mean end-to-end adjacency is allowed: a shift ending at
-- 3:00 and the next starting at 3:00 do not overlap. That matters —
-- clocking straight back in after a clock-out is normal, and treating
-- it as a conflict would block a legitimate punch.
--
-- An open shift (ended_at null) extends to infinity, so nothing may be
-- recorded after an unclosed shift's start until it is closed. This
-- subsumes the old one-open-shift-per-driver rule.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'hos_shifts_no_overlap'
  ) then
    alter table hos_shifts
      add constraint hos_shifts_no_overlap
      exclude using gist (
        driver_id with =,
        tstzrange(started_at, coalesce(ended_at, 'infinity'::timestamptz), '[)') with &&
      ) where (deleted_at is null);
  end if;
end $$;

-- Soft-deleted shifts must not block a replacement, so the open-shift
-- index needs the same exclusion.
drop index if exists hos_shifts_one_open_per_driver;
create unique index if not exists hos_shifts_one_open_per_driver
  on hos_shifts (driver_id) where ended_at is null and deleted_at is null;
