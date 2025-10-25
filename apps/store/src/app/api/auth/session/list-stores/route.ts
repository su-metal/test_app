import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_NAME, verifySessionCookie, issueSessionCookie } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

export async function GET() {
  const secret = process.env.STORE_SESSION_SECRET || process.env.ADMIN_DASHBOARD_SECRET || process.env.LINE_LOGIN_CHANNEL_SECRET || "";
  if (!secret) return NextResponse.json({ error: "server-misconfig:secret" }, { status: 500 });

  const c = await cookies();
  const sess = verifySessionCookie(c.get(COOKIE_NAME)?.value, secret);
  if (!sess) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const admin = getSupabaseAdmin();
  const stores: Array<{ id: string; name?: string | null }> = [];
  try {
    const { data: m } = await admin
      .from("store_members")
      .select("store_id")
      .eq("operator_user_id", sess.sub);
    const ids = new Set<string>();
    for (const r of m || []) ids.add(String((r as any).store_id));

    // fallback: owner
    const { data: own } = await admin
      .from("stores")
      .select("id, name, auth_user_id")
      .eq("auth_user_id", sess.sub);
    for (const r of own || []) ids.add(String((r as any).id));

    if (ids.size === 0) return NextResponse.json({ ok: true, stores: [] });

    // fetch names
    const { data: items } = await admin
      .from("stores")
      .select("id, name")
      .in("id", Array.from(ids));
    for (const s of items || []) stores.push({ id: String((s as any).id), name: (s as any).name });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, stores });
}

