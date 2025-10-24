-- Ensure unique constraint on line_users.line_user_id (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'line_users_line_user_id_key'
  ) THEN
    ALTER TABLE IF EXISTS public.line_users
      ADD CONSTRAINT line_users_line_user_id_key UNIQUE (line_user_id);
  END IF;
END
$$;

