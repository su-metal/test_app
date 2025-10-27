-- 注文テーブルの不足カラムを補完（冪等）
-- TODO(req v2): Supabase CLI の正規チェーンに組み込む

ALTER TABLE IF EXISTS public.orders
  ADD COLUMN IF NOT EXISTS subtotal numeric NULL;

ALTER TABLE IF EXISTS public.orders
  ADD COLUMN IF NOT EXISTS pickup_label text NULL;

ALTER TABLE IF EXISTS public.orders
  ADD COLUMN IF NOT EXISTS pickup_presets_snapshot jsonb NULL;

