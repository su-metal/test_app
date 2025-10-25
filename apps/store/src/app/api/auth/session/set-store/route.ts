import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME, issueSessionCookie, verifySessionCookie } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

// 選択中の店舗IDをセッションCookieに格納する
// 認可: 既存セッションの LINE user (sub) が対象店舗のメンバーであること
// TODO(req v2): 役割(OWNER/STAFF)のチェック、失効/更新の扱いを追加
export async function POST(req: NextRequest) {
  const secret = process.env.ADMIN_DASHBOARD_SECRET || process.env.LINE_LOGIN_CHANNEL_SECRET || "";
  if (!secret) return NextResponse.json({ error: "server-misconfig:secret" }, { status: 500 });

  const cookieStore = await cookies();
  const sess = verifySessionCookie(cookieStore.get(COOKIE_NAME)?.value, secret);
  if (!sess) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { storeId?: string } = {};
  try { body = (await req.json()) as any; } catch { /* noop */ }
  const storeId = String(body.storeId || "").trim();
  if (!storeId) return NextResponse.json({ error: "STORE_ID_REQUIRED" }, { status: 400 });

  // メンバーシップ確認: store_members or stores.fallback(line_user_id)
  const admin = getSupabaseAdmin();
  const lineUserId = sess.sub;

  // store_members に存在するか
  const { data: members, error: memErr } = await admin
    .from("store_members")
    .select("store_id, line_user_id, role")
    .eq("store_id", storeId)
    .eq("line_user_id", lineUserId)
    .limit(1);
  if (memErr) return NextResponse.json({ error: memErr.message }, { status: 500 });

  let allowed = (members?.length ?? 0) > 0;
  if (!allowed) {
    // フォールバック: stores.line_user_id = sub であるか
    const { data: stores, error: stErr } = await admin
      .from("stores")
      .select("id, line_user_id")
      .eq("id", storeId)
      .eq("line_user_id", lineUserId)
      .limit(1);
    if (stErr) return NextResponse.json({ error: stErr.message }, { status: 500 });
    allowed = (stores?.length ?? 0) > 0;
  }

  if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Cookie を再発行 (store_id 更新)
  const value = issueSessionCookie(sess.sub, secret, storeId);
  const maxAge = 60 * 60 * 24 * 7; // 7 days
  const res = NextResponse.json({ ok: true, store_id: storeId });
  res.cookies.set({
    name: COOKIE_NAME,
    value,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge,
  });
  return res;
}

export function GET() {
  return new NextResponse("Method Not Allowed", { status: 405 });
}

