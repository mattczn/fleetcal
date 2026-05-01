create table if not exists payroll_adjustments (
  id          uuid primary key default gen_random_uuid(),
  org_id      text not null,
  driver_name text not null,
  week_start  date not null,
  category    text not null,
  description text,
  amount      numeric not null,
  created_at  timestamptz not null default now()
);

create index if not exists payroll_adjustments_org_week
  on payroll_adjustments (org_id, week_start);
