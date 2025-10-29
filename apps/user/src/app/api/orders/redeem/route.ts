// apps/user/src/app/api/orders/redeem/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import { COOKIE_NAME as USER_COOKIE, verifySessionCookie } from "@/lib/session";
import { verifyLiffIdToken, verifyLiffTokenString } from "@/lib/verifyLiff";

type Body = { orderId?: string };

export async function POST(req: NextRequest) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return NextResponse.json({ ok: false, error: "server-misconfig:supabase" }, { status: 500 });
  }

  const secret = process.env.USER_SESSION_SECRET || process.env.LINE_CHANNEL_SECRET || "";
  if (!secret) return NextResponse.json({ ok: false, error: "server-misconfig:secret" }, { status: 500 });

  // 認証: 1) Authorization: Bearer <LIFF ID token> 2) x-liff-id-token 3) Cookie
  let lineUserId: string | null = null;
  try {
    const auth = req.headers.get("authorization");
    if (auth) lineUserId = await verifyLiffIdToken(auth);
  } catch { /* noop */ }
  if (!lineUserId) {
    try {
      const h2 = req.headers.get("x-liff-id-token");
      if (h2) lineUserId = await verifyLiffTokenString(h2);
    } catch { /* noop */ }
  }
  if (!lineUserId) {
    try {
      const c = await cookies();
      const sess = verifySessionCookie(c.get(USER_COOKIE)?.value, secret);
      if (sess?.sub) lineUserId = sess.sub;
    } catch { /* noop */ }
  }
  if (!lineUserId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: Body | null = null;
  try { body = (await req.json()) as Body; } catch { /* noop */ }
  const orderId = String(body?.orderId || "").trim();
  if (!orderId) return NextResponse.json({ ok: false, error: "ORDER_ID_REQUIRED" }, { status: 400 });

  const supa = createClient(url, serviceKey);

  // 認可: 自分の注文かつ現在引換前（冪等許容）
  const { data: order, error: selErr } = await supa
    .from("orders")
    .select("id, status, line_user_id, redeemed_at")
    .eq("id", orderId)
    .single();
  if (selErr || !order) {
    return NextResponse.json({ ok: false, error: "ORDER_NOT_FOUND" }, { status: 404 });
  }
  if (String((order as any).line_user_id || "") !== lineUserId) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // 冪等: すでに FULFILLED/ redeemed_at でも成功扱い
  const nowIso = new Date().toISOString();
  const { error: upErr } = await supa
    .from("orders")
    .update({ redeemed_at: nowIso, status: "FULFILLED" })
    .eq("id", orderId);
  if (upErr) {
    // 既に更新済みの場合も 200 を返す（冪等）
    // ただし別エラーは透過
    const isConstraint = /duplicate|conflict|violat/i.test(upErr.message || "");
    if (!isConstraint) {
      return NextResponse.json({ ok: false, error: "UPDATE_FAILED", detail: upErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, orderId });
}

export function GET() { return new NextResponse("Method Not Allowed", { status: 405 }); }
