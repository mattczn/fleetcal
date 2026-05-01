alter table events
  add column if not exists event_kind       text not null default 'revenue',
  add column if not exists non_revenue_type text;
