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

  const { error: serr } = await supabaseAdmin.from("stores").insert({
    name: app.store_name,
    email: app.email,
    auth_user_id: created.user.id,
  });
  if (serr) {
    await supabaseAdmin.auth.admin.deleteUser(created.user.id).catch(() => {});
    return NextResponse.json({ error: serr.message }, { status: 500 });
  }

  const { error: uerr } = await supabaseAdmin
    .from("store_applications")
    .update({ status: "approved" })
    .eq("id", app.id);
  if (uerr) return NextResponse.json({ error: uerr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
