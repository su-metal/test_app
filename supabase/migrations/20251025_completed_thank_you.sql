-- Add completed_notified_at column on public.orders for thank-you dedupe
do $$ begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'orders'
      and column_name = 'completed_notified_at'
  ) then
    alter table public.orders
      add column completed_notified_at timestamptz null;
  end if;
end $$;

-- Helpful index for scanning pending notifications
create index if not exists idx_orders_completed_notify
  on public.orders (status, completed_notified_at)
  where completed_notified_at is null;

-- TODO(req v2): 規定の監査ログに合わせて通知ログテーブルへも記録する。

