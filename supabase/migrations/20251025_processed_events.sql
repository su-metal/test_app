-- 冪等用イベント記録テーブル
-- TODO(req v2): Supabase CLI の正式チェーンに統合

create table if not exists public.processed_events (
  event_id text primary key,
  type text null,
  order_id uuid null,
  created_at timestamptz not null default now()
);

create index if not exists idx_processed_events_created_at on public.processed_events(created_at desc);
create index if not exists idx_processed_events_order_id on public.processed_events(order_id);

