// apps/user/src/app/api/dev/user/mock-login/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME, issueSessionCookie } from "@/lib/session";

// 開発用: 任意の LINE user id(sub) で user_session Cookie を発行
// 本番で使わないこと。デプロイ環境では必ず無効化してください。
export async function POST(req: NextRequest) {
  const secret = process.env.USER_SESSION_SECRET || process.env.LINE_CHANNEL_SECRET || "";
  const allow = process.env.NEXT_PUBLIC_DEBUG === "1" || process.env.NODE_ENV !== "production";
  if (!secret) return NextResponse.json({ ok: false, error: "server-misconfig:secret" }, { status: 500 });
  if (!allow) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  let sub = "";
  try {
    const body = (await req.json()) as { sub?: string };
    sub = String(body?.sub || "").trim();
  } catch { /* ignore */ }
  if (!sub) sub = String(new URL(req.url).searchParams.get("sub") || "").trim();
  if (!sub) return NextResponse.json({ ok: false, error: "sub_required" }, { status: 400 });

  const value = issueSessionCookie(sub, secret);
  const res = NextResponse.json({ ok: true, sub });
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
}

export function GET() { return new NextResponse("Method Not Allowed", { status: 405 }); }

