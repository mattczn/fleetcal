-- 20260728_payroll_records_snapshot.sql
--
-- Make "Finalize Pay" actually freeze a week.
--
-- WHY
-- ---
-- payroll_records stored ONE number — total_pay — for a (org, driver,
-- week). Nothing else about the week was recorded, so "finalized" was a
-- label, not a fact:
--
--   * The payroll page never read total_pay for the number it displayed.
--     It re-summed events.driver_pay + adjustments live on every render,
--     so editing a load after finalizing silently changed the finalized
--     week's headline total while the footer five lines below still
--     printed the recorded number. Two contradictory totals on one card.
--   * The printable pay stub used the same live values, so reprinting a
--     stub for a week already paid produced a DIFFERENT document than the
--     one that was issued to the driver. For a pay record that is the
--     whole point of the artifact, that is a correctness failure, not a
--     cosmetic one.
--   * Week membership was recomputed from events.start, so moving a load
--     across the Saturday boundary removed it from a week that had
--     already been paid — with no trace that it was ever in it.
--   * The dashboard honoured the recorded total while payroll didn't, so
--     the two surfaces permanently disagreed after any such edit.
--
-- A total alone can never fix this: to reprint what was issued you need
-- the LINES, not the sum. Hence line_items.
--
-- line_items — the frozen detail
-- ------------------------------
-- jsonb array of every line that made up total_pay at finalize time. One
-- item per paid thing, each self-contained enough to reprint the stub
-- with zero live lookups:
--
--   { "kind":      "load" | "adjustment" | "accessorial",
--     "id":        stable source id (event id / adjustment id /
--                  "acc-<loadId>-<accessorialId>"),
--     "amount":    number (dollars, signed — deductions are negative),
--     "label":     display text (event title / adjustment description),
--     "date":      "YYYY-MM-DD" (loads: pickup date),
--     "eventId":   events.id            (loads only)
--     "loadId":    loads.id             (loads only)
--     "loadNum":   broker load #        (loads only)
--     "legLabel":  "Leg 2 · Transfer"   (loads only, relay legs)
--     "legIndex":  0-based leg position (loads only, relay legs)
--     "legCount":  legs in the relay    (loads only, relay legs)
--     "category":  adjustment/accessorial category (non-load items) }
--
-- Nullable on purpose: rows finalized before this migration (and the
-- historical rows written by scripts/backfill-payroll-records.ts, which
-- only ever knew weekly totals) have no detail to record. Clients must
-- treat a null/empty line_items as "legacy record — total_pay is still
-- authoritative for the number, but there is no frozen detail to
-- reprint" rather than as "zero pay".
--
-- Amounts are stored redundantly (each line + total_pay). That is
-- deliberate: total_pay stays the single number every other surface
-- already reads (dashboard KPI, driver pay history), and re-deriving it
-- from jsonb on read would make the dashboard's arithmetic depend on
-- correctly parsing a document. The two agree at write time and nothing
-- is allowed to mutate either afterwards.
--
-- finalized_by / superseded_* — history instead of destruction
-- ------------------------------------------------------------
-- Reopen used to be a hard DELETE: the amount a human signed off on, and
-- the fact that anyone had signed off at all, were both destroyed with
-- no record. There was no finalized_by column, so even before the delete
-- we could not say WHO paid a driver.
--
-- Records now become append-only. Finalizing INSERTs a row. Reopening
-- (or re-finalizing after a correction) stamps superseded_at /
-- superseded_by / superseded_reason on the row that was active and
-- leaves it in place forever. A week's full history — every amount that
-- was ever finalized for it, who did it, who undid it, when — is a
-- select away.
--
--   superseded_reason: 'reopen'     — a human unlocked the week
--                      'refinalize' — replaced by a fresh snapshot after
--                                     the underlying numbers changed
--
-- finalized_by / superseded_by hold the Clerk user id from the request
-- JWT (authoritative). The *_by_name columns are a display convenience
-- captured from the client at write time so the UI can render "Finalized
-- by Matt" without a Clerk round-trip; they are labels, never identity.
--
-- Uniqueness
-- ----------
-- The old `unique (org_id, driver_name, week_start)` cannot survive
-- append-only history — a reopened week plus a re-finalized week are two
-- rows on the same key. It is replaced by a PARTIAL unique index over
-- live rows only, which keeps the real invariant: at most ONE active
-- finalized record per driver-week. Superseded rows are unconstrained.
--
-- Consequence for callers: PostgREST `.upsert(..., { onConflict:
-- "org_id,driver_name,week_start" })` no longer resolves (Postgres will
-- not infer a partial index without a matching predicate). POST
-- /v1/payroll/records was rewritten to supersede-then-insert.
-- apps/api/src/scripts/backfill-payroll-records.ts still uses the old
-- upsert; it is a one-shot historical import that has already run, and
-- it must be converted to supersede-then-insert before it is run again.
--
-- Every read path that sums records (dashboard Total Payroll, driver pay
-- history, the payroll page's own lookup) MUST filter
-- `superseded_at is null` or it will double-count re-finalized weeks.
-- The API applies that filter by default.

alter table payroll_records
  add column if not exists line_items         jsonb,
  add column if not exists finalized_by       text,
  add column if not exists finalized_by_name  text,
  add column if not exists superseded_at      timestamptz,
  add column if not exists superseded_by      text,
  add column if not exists superseded_by_name text,
  add column if not exists superseded_reason  text;

-- Only the two values the app writes. Historical rows are all NULL
-- (never superseded), which the constraint allows.
alter table payroll_records
  drop constraint if exists payroll_records_superseded_reason_check;
alter table payroll_records
  add constraint payroll_records_superseded_reason_check
  check (superseded_reason is null or superseded_reason in ('reopen', 'refinalize'));

-- A superseded row must carry its timestamp, and a live row must not
-- carry a reason. Keeps "is this record still in force?" answerable by
-- the single `superseded_at is null` predicate every read uses.
alter table payroll_records
  drop constraint if exists payroll_records_superseded_consistency_check;
alter table payroll_records
  add constraint payroll_records_superseded_consistency_check
  check (
    (superseded_at is null     and superseded_reason is null) or
    (superseded_at is not null and superseded_reason is not null)
  );

-- Drop the old total-uniqueness. The constraint was declared inline in
-- 20260425_payroll_records.sql so Postgres named it; the DO block finds
-- it by shape rather than trusting the generated name, in case any
-- environment has it under a different one.
do $$
declare
  con_name text;
begin
  for con_name in
    select c.conname
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
     where t.relname = 'payroll_records'
       and c.contype = 'u'
       and (
         select array_agg(a.attname::text order by a.attname)
           from unnest(c.conkey) k
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
       ) = array['driver_name', 'org_id', 'week_start']
  loop
    execute format('alter table payroll_records drop constraint %I', con_name);
  end loop;
end $$;

-- The real invariant: at most one ACTIVE finalized record per
-- driver-week. Any number of superseded ones may sit behind it.
create unique index if not exists payroll_records_active_uniq
  on payroll_records (org_id, driver_name, week_start)
  where superseded_at is null;

-- The dashboard's Total Payroll KPI ranges over (org_id, week_start)
-- and only ever wants live rows; keep that scan off the history.
create index if not exists payroll_records_org_week_active
  on payroll_records (org_id, week_start)
  where superseded_at is null;
