-- 20260914_asset_driver_day.sql
--
-- Per-day "who is actually in this truck" override.
--
-- WHY THIS EXISTS: which driver is in a truck is currently derived by a
-- waterfall — the load whose window contains now, else the most recent
-- load, else driver_asset_prefs. That resolves correctly most of the
-- time and wrongly some of the time: a truck with no load assigned yet,
-- a swap that hasn't been entered, a relay where two legs overlap.
--
-- The calendar header now shows that driver AND their HOS hours, so a
-- wrong answer isn't cosmetic — it shows a dispatcher the wrong
-- person's remaining hours and invites a dispatch decision based on
-- them.
--
-- WHY PER DAY rather than reusing driver_asset_prefs: those are
-- standing assignments (the truck's owner, plus someone who shares it).
-- "Luis is in 0809 today" is a fact about today. Writing it to the
-- standing pref would still be asserting it next week, and the whole
-- point of the override is that the automatic answer drifts.
create table if not exists asset_driver_day (
  org_id     text   not null,
  asset_id   bigint not null references assets(id) on delete cascade,
  -- Calendar date in the ORG's timezone, matching how HOS decides which
  -- day a shift belongs to. Not a timestamp: the claim is about a day.
  duty_date  date   not null,
  driver_id  bigint not null references drivers(id) on delete cascade,

  set_by     text,
  set_at     timestamptz not null default now(),

  primary key (org_id, asset_id, duty_date)
);

-- The calendar reads a whole day across every truck at once.
create index if not exists asset_driver_day_org_date_idx
  on asset_driver_day (org_id, duty_date);

-- "Which trucks was this driver in recently" — powers the ordering in
-- the driver picker, which puts drivers who actually use this truck at
-- the top rather than listing the fleet alphabetically.
create index if not exists asset_driver_day_driver_idx
  on asset_driver_day (org_id, driver_id, duty_date desc);
