export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { COOKIE_NAME, issueSessionCookie } from "@/lib/session";

type Body = { email?: string; password?: string };

export async function POST(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const secret = process.env.ADMIN_DASHBOARD_SECRET || process.env.LINE_LOGIN_CHANNEL_SECRET || "";
  if (!url || !anonKey) return NextResponse.json({ error: "server-misconfig:supabase" }, { status: 500 });
  if (!secret) return NextResponse.json({ error: "server-misconfig:secret" }, { status: 500 });

  let body: Body = {};
  try { body = (await req.json()) as Body; } catch {}
  const email = String(body.email || "").trim();
  const password = String(body.password || "").trim();
  if (!email || !password) return NextResponse.json({ error: "invalid-credentials" }, { status: 401 });

  try {
    const supabase = createClient(url, anonKey);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data?.user?.id) {
      return NextResponse.json({ error: "invalid-credentials" }, { status: 401 });
    }

    const operatorUserId = data.user.id;
    const value = issueSessionCookie(operatorUserId, secret);
    const res = NextResponse.json({ ok: true, operator_user_id: operatorUserId });
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
  } catch (e: any) {
    console.error("[auth/login/password] fatal:", e?.message || e);
    return NextResponse.json({ error: "login-failed" }, { status: 500 });
  }
}

export function GET() { return new NextResponse("Method Not Allowed", { status: 405 }); }

