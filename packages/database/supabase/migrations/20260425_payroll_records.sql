create table if not exists payroll_records (
  id           uuid primary key default gen_random_uuid(),
  org_id       text not null,
  driver_name  text not null,
  week_start   date not null,
  total_pay    numeric not null,
  finalized_at timestamptz not null default now(),
  notes        text,
  unique (org_id, driver_name, week_start)
);

create index if not exists payroll_records_org_week
  on payroll_records (org_id, week_start);
