export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { COOKIE_NAME, issueSessionCookie } from "@/lib/session";

const LINE_JWKS = createRemoteJWKSet(new URL("https://api.line.me/oauth2/v2.1/certs"));

export async function POST(req: NextRequest) {
  const secret = process.env.USER_SESSION_SECRET || process.env.LINE_CHANNEL_SECRET || "";
  // 受け入れオーディエンス（LINE LoginのChannel ID）
  const channelId = process.env.LINE_LOGIN_CHANNEL_ID || process.env.LINE_CHANNEL_ID || "";
  if (!secret) return NextResponse.json({ error: "server-misconfig:secret" }, { status: 500 });
  if (!channelId) return NextResponse.json({ error: "server-misconfig:channel-id" }, { status: 500 });

  let id_token = "";
  try { ({ id_token } = (await req.json()) as { id_token?: string }); } catch {}
  if (!id_token) return NextResponse.json({ error: "id_token_required" }, { status: 400 });

  try {
    const { payload } = await jwtVerify(id_token, LINE_JWKS, { issuer: "https://access.line.me", audience: channelId });
    const sub = String(payload.sub || "");
    if (!sub) return NextResponse.json({ error: "invalid_token" }, { status: 401 });

    const value = issueSessionCookie(sub, secret);
    const res = NextResponse.json({ ok: true, line_user_id: sub });
    res.cookies.set({
      name: COOKIE_NAME,
      value,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return res;
  } catch (e: any) {
    return NextResponse.json({ error: "verify_failed", detail: e?.message || String(e) }, { status: 401 });
  }
}

export function GET() { return new NextResponse("Method Not Allowed", { status: 405 }); }

