-- RLS policies for store-facing tables
-- TODO(req v2): 運用中の差分があれば本ポリシーを微調整すること

-- stores テーブル
alter table if exists public.stores enable row level security;

drop policy if exists stores_select_self on public.stores;
create policy stores_select_self on public.stores
  for select using (
    auth.uid() is not null
    and (
      auth.uid() = auth_user_id
      or exists (
        select 1 from public.store_members sm
        where sm.store_id = id and sm.auth_user_id = auth.uid() and sm.role in ('owner','admin','staff')
      )
    )
  );

drop policy if exists stores_update_self on public.stores;
create policy stores_update_self on public.stores
  for update using (
    auth.uid() is not null
    and (
      auth.uid() = auth_user_id
      or exists (
        select 1 from public.store_members sm
        where sm.store_id = id and sm.auth_user_id = auth.uid() and sm.role in ('owner','admin','staff')
      )
    )
  );

drop policy if exists stores_delete_self on public.stores;
create policy stores_delete_self on public.stores
  for delete using (
    auth.uid() is not null
    and (
      auth.uid() = auth_user_id
      or exists (
        select 1 from public.store_members sm
        where sm.store_id = id and sm.auth_user_id = auth.uid() and sm.role in ('owner','admin','staff')
      )
    )
  );

-- store_pickup_presets テーブル
alter table if exists public.store_pickup_presets enable row level security;

drop policy if exists spp_select_self on public.store_pickup_presets;
create policy spp_select_self on public.store_pickup_presets
  for select using (
    auth.uid() is not null
    and (
      exists (
        select 1 from public.stores s where s.id = store_id and s.auth_user_id = auth.uid()
      )
      or exists (
        select 1 from public.store_members sm where sm.store_id = store_id and sm.auth_user_id = auth.uid() and sm.role in ('owner','admin','staff')
      )
    )
  );

drop policy if exists spp_modify_self on public.store_pickup_presets;
create policy spp_modify_self on public.store_pickup_presets
  for all using (
    auth.uid() is not null
    and (
      exists (
        select 1 from public.stores s where s.id = store_id and s.auth_user_id = auth.uid()
      )
      or exists (
        select 1 from public.store_members sm where sm.store_id = store_id and sm.auth_user_id = auth.uid() and sm.role in ('owner','admin','staff')
      )
    )
  ) with check (
    auth.uid() is not null
    and (
      exists (
        select 1 from public.stores s where s.id = store_id and s.auth_user_id = auth.uid()
      )
      or exists (
        select 1 from public.store_members sm where sm.store_id = store_id and sm.auth_user_id = auth.uid() and sm.role in ('owner','admin','staff')
      )
    )
  );

-- store_members テーブル
alter table if exists public.store_members enable row level security;

drop policy if exists sm_select_self on public.store_members;
create policy sm_select_self on public.store_members
  for select using (
    auth.uid() is not null
    and (
      exists (
        select 1 from public.stores s where s.id = store_id and s.auth_user_id = auth.uid()
      )
      or exists (
        select 1 from public.store_members sm2 where sm2.store_id = store_id and sm2.auth_user_id = auth.uid() and sm2.role in ('owner','admin','staff')
      )
    )
  );

drop policy if exists sm_modify_owner_admin on public.store_members;
create policy sm_modify_owner_admin on public.store_members
  for all using (
    auth.uid() is not null
    and (
      exists (
        select 1 from public.stores s where s.id = store_id and s.auth_user_id = auth.uid()
      )
      or exists (
        select 1 from public.store_members sm2 where sm2.store_id = store_id and sm2.auth_user_id = auth.uid() and sm2.role in ('owner','admin')
      )
    )
  ) with check (
    auth.uid() is not null
    and (
      exists (
        select 1 from public.stores s where s.id = store_id and s.auth_user_id = auth.uid()
      )
      or exists (
        select 1 from public.store_members sm2 where sm2.store_id = store_id and sm2.auth_user_id = auth.uid() and sm2.role in ('owner','admin')
      )
    )
  );

