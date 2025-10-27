export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { COOKIE_NAME, issueSessionCookie } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

type Body = { email?: string; password?: string };

export async function POST(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const secret = process.env.STORE_SESSION_SECRET || process.env.ADMIN_DASHBOARD_SECRET || process.env.LINE_LOGIN_CHANNEL_SECRET || "";
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

    // 所属店舗の解決
    const admin = getSupabaseAdmin();
    const storeIds = new Set<string>();
    try {
      const { data: m1 } = await admin
        .from("store_members")
        .select("store_id")
        .eq("operator_user_id", operatorUserId);
      for (const r of m1 || []) storeIds.add(String((r as any).store_id));
    } catch {}
    // フォールバック: stores.auth_user_id = operatorUserId
    try {
      const { data: own } = await admin
        .from("stores")
        .select("id, auth_user_id")
        .eq("auth_user_id", operatorUserId);
      for (const r of own || []) storeIds.add(String((r as any).id));
    } catch {}

    let value = "";
    let body: any = { ok: true, operator_user_id: operatorUserId };
    if (storeIds.size === 1) {
      const only = Array.from(storeIds)[0]!;
      value = issueSessionCookie(operatorUserId, secret, only);
      body.store_id = only;
    } else {
      // 0 件または複数所属: store_id 未設定のセッションを発行し、選択画面へ誘導
      value = issueSessionCookie(operatorUserId, secret);
      body.need_store_select = true;
    }

    const res = NextResponse.json(body);
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
      maxAge: 60 * 60 * 24 * 7,
    });
    return res;
  } catch (e: any) {
    console.error("[auth/login/password] fatal:", e?.message || e);
    return NextResponse.json({ error: "login-failed" }, { status: 500 });
  }
}

export function GET() { return new NextResponse("Method Not Allowed", { status: 405 }); }
