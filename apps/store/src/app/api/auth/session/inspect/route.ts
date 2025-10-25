import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { COOKIE_NAME, verifySessionCookie } from "@/lib/session";

export async function GET() {
  const secret =
    process.env.STORE_SESSION_SECRET ||
    process.env.ADMIN_DASHBOARD_SECRET ||
    process.env.LINE_LOGIN_CHANNEL_SECRET ||
    "";
  if (!secret) {
    return NextResponse.json({ error: "server-misconfig:secret" }, { status: 500 });
  }

  const c = await cookies();
  const sess = verifySessionCookie(c.get(COOKIE_NAME)?.value, secret);
  if (!sess) return NextResponse.json({ error: "no-session" }, { status: 401 });

  // 空欄時は null を返す（UUID 検証はクライアント側で実施）
  const sid = (typeof sess.store_id === "string" ? sess.store_id : "").trim();
  return NextResponse.json({ ok: true, store_id: sid || null });
}

export const runtime = "nodejs";

