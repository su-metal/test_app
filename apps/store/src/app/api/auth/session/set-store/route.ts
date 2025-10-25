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
  if (!sess) return NextResponse.json({ error: "no-operator-session" }, { status: 401 });

  let body: { storeId?: string } = {};
  try { body = (await req.json()) as any; } catch { /* noop */ }
  const storeId = String(body.storeId || "").trim();
  if (!storeId) return NextResponse.json({ error: "invalid-store-id" }, { status: 400 });
  // 軽いUUID形式チェック（ハイフン含む36桁）
  if (!/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/i.test(storeId)) {
    return NextResponse.json({ error: "invalid-store-id" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const operatorUserId = sess.sub;

  // 店舗の実在確認
  const { data: storeRow, error: stFindErr } = await admin
    .from("stores")
    .select("id, auth_user_id")
    .eq("id", storeId)
    .single();
  if (stFindErr || !storeRow) return NextResponse.json({ error: "invalid-store-id" }, { status: 400 });

  // メンバーシップ確認:
  // 1) store_members.operator_user_id 優先
  let allowed = false;
  try {
    const { data: m1, error: m1err } = await admin
      .from("store_members")
      .select("store_id, operator_user_id")
      .eq("store_id", storeId)
      .eq("operator_user_id", operatorUserId)
      .limit(1);
    if (!m1err && (m1?.length ?? 0) > 0) allowed = true;
  } catch { /* ignore */ }
  // 2) フォールバック: stores.auth_user_id === operatorUserId
  if (!allowed) {
    if ((storeRow as any).auth_user_id && String((storeRow as any).auth_user_id) === operatorUserId) allowed = true;
  }
  if (!allowed) return NextResponse.json({ error: "membership-not-found" }, { status: 403 });

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

