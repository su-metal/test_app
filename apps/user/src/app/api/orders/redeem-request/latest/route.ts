// apps/user/src/app/api/orders/redeem-request/latest/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import { COOKIE_NAME as USER_COOKIE, verifySessionCookie } from "@/lib/session";
import { verifyLiffIdToken, verifyLiffTokenString } from "@/lib/verifyLiff";

export async function GET(req: Request) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return NextResponse.json({ ok: false, error: "server-misconfig:supabase" }, { status: 500 });
  }

  const secret = process.env.USER_SESSION_SECRET || process.env.LINE_CHANNEL_SECRET || "";
  if (!secret) return NextResponse.json({ ok: false, error: "server-misconfig:secret" }, { status: 500 });

  // 認証: 1) Authorization: Bearer <LIFF ID token> 2) x-liff-id-token 3) user_session Cookie の順
  let lineUserId: string | null = null;
  try {
    const auth = (req.headers.get("authorization") || "").trim();
    if (auth) {
      lineUserId = await verifyLiffIdToken(auth);
    }
  } catch { /* noop */ }
  if (!lineUserId) {
    try {
      const h2 = req.headers.get("x-liff-id-token");
      if (h2) lineUserId = await verifyLiffTokenString(h2);
    } catch { /* noop */ }
  }
  if (!lineUserId) {
    const c = await cookies();
    const sess = verifySessionCookie(c.get(USER_COOKIE)?.value, secret);
    if (sess?.sub) lineUserId = sess.sub;
  }
  if (!lineUserId) return NextResponse.json({ ok: true, order: null });

  const supa = createClient(url, serviceKey);
  const { data: orders, error } = await supa
    .from("orders")
    .select("id, code, status, redeem_request_at, redeemed_at")
    .eq("line_user_id", lineUserId)
    .eq("status", "PENDING")
    .is("redeemed_at", null)
    .not("redeem_request_at", "is", null)
    .order("redeem_request_at", { ascending: false })
    .limit(1);
  if (error) return NextResponse.json({ ok: false, error: "SELECT_FAILED", detail: error.message }, { status: 500 });

  const order = (orders && orders[0]) || null;
  return NextResponse.json({ ok: true, order: order ? { id: order.id, code: order.code } : null });
}

export function POST() { return new NextResponse("Method Not Allowed", { status: 405 }); }
