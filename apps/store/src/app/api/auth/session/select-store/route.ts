import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_NAME, verifySessionCookie, issueSessionCookie } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const secret = process.env.STORE_SESSION_SECRET || process.env.ADMIN_DASHBOARD_SECRET || process.env.LINE_LOGIN_CHANNEL_SECRET || "";
  if (!secret) return NextResponse.json({ error: "server-misconfig:secret" }, { status: 500 });

  const c = await cookies();
  const sess = verifySessionCookie(c.get(COOKIE_NAME)?.value, secret);
  if (!sess) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { storeId?: string } = {};
  try { body = (await req.json()) as any; } catch {}
  const storeId = String(body.storeId || "").trim();
  if (!storeId) return NextResponse.json({ error: "invalid-store-id" }, { status: 400 });

  const admin = getSupabaseAdmin();

  // validate membership
  let allowed = false;
  try {
    const { data: m1 } = await admin
      .from("store_members")
      .select("store_id, operator_user_id")
      .eq("store_id", storeId)
      .eq("operator_user_id", sess.sub)
      .limit(1);
    if ((m1?.length ?? 0) > 0) allowed = true;
  } catch {}
  if (!allowed) {
    const { data: s1 } = await admin
      .from("stores")
      .select("id, auth_user_id")
      .eq("id", storeId)
      .eq("auth_user_id", sess.sub)
      .limit(1);
    if ((s1?.length ?? 0) > 0) allowed = true;
  }
  if (!allowed) return NextResponse.json({ error: "forbidden:store-mismatch" }, { status: 403 });

  const value = issueSessionCookie(sess.sub, secret, storeId);
  const res = NextResponse.json({ ok: true, store_id: storeId });
  res.cookies.set({
    name: COOKIE_NAME,
    value,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return res;
}

