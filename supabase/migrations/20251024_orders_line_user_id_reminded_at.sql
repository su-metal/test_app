-- Idempotent migration: add columns and indexes for LINE reminders
-- TODO(req v2): move into formal migration chain if using Supabase CLI

-- Add columns if not exist
ALTER TABLE IF EXISTS public.orders
  ADD COLUMN IF NOT EXISTS line_user_id text NULL;

ALTER TABLE IF EXISTS public.orders
  ADD COLUMN IF NOT EXISTS reminded_at timestamptz NULL;

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_orders_pickup_start_status
  ON public.orders (pickup_start, status);

CREATE INDEX IF NOT EXISTS idx_orders_line_user_id
  ON public.orders (line_user_id);

