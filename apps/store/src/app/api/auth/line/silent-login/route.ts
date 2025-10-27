import { NextRequest, NextResponse } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { COOKIE_NAME, issueSessionCookie } from "@/lib/session";

const LINE_JWKS = createRemoteJWKSet(
  new URL("https://api.line.me/oauth2/v2.1/certs")
);

export async function POST(req: NextRequest) {
  try {
    const { id_token } = (await req.json().catch(() => ({}))) as {
      id_token?: string;
    };
    if (!id_token) {
      return new Response(JSON.stringify({ error: "id_token is required" }), {
        status: 400,
      });
    }

    const channelId = process.env.LINE_LOGIN_CHANNEL_ID;
    if (!channelId) {
      return new Response(
        JSON.stringify({ error: "server misconfig: LINE_LOGIN_CHANNEL_ID" }),
        { status: 500 }
      );
    }

    const { payload } = await jwtVerify(id_token, LINE_JWKS, {
      issuer: "https://access.line.me",
      audience: channelId,
    });

    const sub = String(payload.sub || "");
    if (!sub) {
      return new Response(JSON.stringify({ error: "invalid token: no sub" }), {
        status: 401,
      });
    }

    const secret =
      process.env.ADMIN_DASHBOARD_SECRET ||
      process.env.LINE_LOGIN_CHANNEL_SECRET ||
      "";
    if (!secret) {
      return new Response(
        JSON.stringify({ error: "server misconfig: secret" }),
        { status: 500 }
      );
    }

    const value = issueSessionCookie(sub, secret);
    const maxAge = 60 * 60 * 24 * 7; // 7 days

    // Next 15+ では Route Handler での Cookie 変更は
    // Response 経由の API を使うのが安全
    const res = NextResponse.json({ ok: true, sub }, { status: 200 });
    const isProd = process.env.NODE_ENV === "production";
    const sameSite: "lax" | "none" = isProd ? "none" : "lax";
    // TODO(req v2): SameSite=None; Secure は LIFF 埋め込み等のクロスサイト文脈対策（本番のみ）
    res.cookies.set({
      name: COOKIE_NAME,
      value,
      httpOnly: true,
      secure: isProd,
      sameSite,
      path: "/",
      maxAge,
    });
    return res;
  } catch (e: any) {
    return new Response(
      JSON.stringify({ error: e?.message || "verify failed" }),
      { status: 401 }
    );
  }
}
