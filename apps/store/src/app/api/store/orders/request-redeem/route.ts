// apps/store/src/app/api/store/orders/request-redeem/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { COOKIE_NAME, verifySessionCookie } from "@/lib/session";

type Body = { orderId?: string };

export async function POST(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return NextResponse.json({ ok: false, error: "server-misconfig:supabase" }, { status: 500 });
  }

  const secret =
    process.env.STORE_SESSION_SECRET ||
    process.env.ADMIN_DASHBOARD_SECRET ||
    process.env.LINE_LOGIN_CHANNEL_SECRET ||
    "";
  if (!secret) {
    return NextResponse.json({ ok: false, error: "server-misconfig:secret" }, { status: 500 });
  }

  // 認証（店舗セッション）
  let expectedStoreId: string | null = null;
  try {
    const c = await cookies();
    const sess = verifySessionCookie(c.get(COOKIE_NAME)?.value, secret);
    if (!sess) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    expectedStoreId = String(sess.store_id || "").trim() || null;
  } catch {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!expectedStoreId) {
    return NextResponse.json({ ok: false, error: "store_not_selected" }, { status: 400 });
  }

  // 入力
  let body: Body | null = null;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid-json" }, { status: 400 });
  }
  const orderId = String(body?.orderId || "").trim();
  if (!orderId) return NextResponse.json({ ok: false, error: "ORDER_ID_REQUIRED" }, { status: 400 });

  const supa = createClient(url, serviceKey);

  // 権限チェック（店舗本人の注文か）
  const { data: order, error: selErr } = await supa
    .from("orders")
    .select("id, store_id, status, redeemed_at")
    .eq("id", orderId)
    .single();
  if (selErr || !order) {
    return NextResponse.json({ ok: false, error: "ORDER_NOT_FOUND" }, { status: 404 });
  }
  if (String((order as any).store_id || "") !== expectedStoreId) {
    return NextResponse.json({ ok: false, error: "membership-not-found" }, { status: 403 });
  }

  // 冪等更新: redeem_request_at を現在時刻に（既存値があっても上書き可）
  // TODO(req v2): DB マイグレーションで redeem_request_at / redeemed_at を正式追加
  const nowIso = new Date().toISOString();
  const { error: upErr } = await supa
    .from("orders")
    .update({ redeem_request_at: nowIso })
    .eq("id", orderId)
    .eq("store_id", expectedStoreId);
  if (upErr) {
    return NextResponse.json({ ok: false, error: "UPDATE_FAILED", detail: upErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, orderId });
}

export function GET() {
  return new NextResponse("Method Not Allowed", { status: 405 });
}

