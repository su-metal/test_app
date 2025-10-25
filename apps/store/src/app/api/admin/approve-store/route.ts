import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

const ADMIN_SECRET = process.env.ADMIN_DASHBOARD_SECRET;

export async function POST(req: Request) {
  const supabaseAdmin = getSupabaseAdmin();
  if (ADMIN_SECRET) {
    const header = new Headers(req.headers).get("x-admin-secret");
    if (header !== ADMIN_SECRET) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  const { application_id, temp_password } = await req.json().catch(() => ({}));
  if (!application_id || !temp_password) {
    return NextResponse.json({ error: "missing params" }, { status: 400 });
  }

  const { data: app, error: aerr } = await supabaseAdmin
    .from("store_applications")
    .select("id, store_name, owner_name, email, phone, status")
    .eq("id", application_id)
    .single();
  if (aerr || !app)
    return NextResponse.json(
      { error: "application not found" },
      { status: 404 }
    );
  if (app.status !== "pending") {
    return NextResponse.json(
      { error: `already ${app.status}` },
      { status: 409 }
    );
  }

  const { data: created, error: cerr } =
    await supabaseAdmin.auth.admin.createUser({
      email: app.email,
      password: temp_password,
      email_confirm: true,
    });
  if (cerr || !created?.user?.id) {
    return NextResponse.json(
      { error: cerr?.message ?? "create user failed" },
      { status: 500 }
    );
  }

  const { data: storeIns, error: serr } = await supabaseAdmin
    .from("stores")
    .insert({
      name: app.store_name,
      email: app.email,
      auth_user_id: created.user.id,
    })
    .select("id")
    .single();
  if (serr || !storeIns?.id) {
    await supabaseAdmin.auth.admin.deleteUser(created.user.id).catch(() => {});
    return NextResponse.json({ error: serr?.message || 'insert store failed' }, { status: 500 });
  }

  // 初期プリセット投入（slot 1..3）と current_pickup_slot_no=1
  const storeId = storeIns.id as string;
  const presets = [
    { store_id: storeId, slot_no: 1, name: 'プリセット1', start_time: '10:00:00', end_time: '14:00:00', slot_minutes: 10 },
    { store_id: storeId, slot_no: 2, name: 'プリセット2', start_time: '14:00:00', end_time: '18:00:00', slot_minutes: 10 },
    { store_id: storeId, slot_no: 3, name: 'プリセット3', start_time: '18:00:00', end_time: '21:00:00', slot_minutes: 10 },
  ];
  await supabaseAdmin.from('store_pickup_presets').upsert(presets, { onConflict: 'store_id,slot_no' });
  await supabaseAdmin.from('stores').update({ current_pickup_slot_no: 1 }).eq('id', storeId);

  // メンバーシップ(owner)を付与
  // TODO(req v2): store_members.requires_pw_update を用意し初回PW変更を強制
  await supabaseAdmin
    .from('store_members')
    .upsert({ store_id: storeId, operator_user_id: created.user.id, role: 'owner' } as any, { onConflict: 'store_id,operator_user_id' });

  const { error: uerr } = await supabaseAdmin
    .from("store_applications")
    .update({ status: "approved" })
    .eq("id", app.id);
  if (uerr) return NextResponse.json({ error: uerr.message }, { status: 500 });

  // TODO(req v2): 初期パスワード通知（メール/LINE）
  return NextResponse.json({ ok: true, store_id: storeId, operator_user_id: created.user.id });
}
