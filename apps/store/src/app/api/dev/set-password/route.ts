// apps/store/src/app/api/dev/set-password/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const DEV_SECRET = process.env.ADMIN_DASHBOARD_SECRET; // 開発用シークレット

export async function POST(req: Request) {
  // 本番で無効化
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "forbidden in production" },
      { status: 403 }
    );
  }

  const h = new Headers(req.headers);
  if (!DEV_SECRET || h.get("x-admin-secret") !== DEV_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({} as any));
  const { email, uid, password } = body as {
    email?: string;
    uid?: string;
    password?: string;
  };

  if (!password || (!email && !uid)) {
    return NextResponse.json(
      { error: "email または uid と password が必要です" },
      { status: 400 }
    );
  }

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  // 1) 対象ユーザーの特定
  let userId = uid;

  if (!userId && email) {
    // getUserByEmail は存在しないため listUsers() から検索
    // 開発目的なので perPage を十分大きく（必要に応じてページング拡張可）
    const { data, error } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const found = data.users.find(
      (u) => (u.email ?? "").toLowerCase() === email.toLowerCase()
    );
    if (!found) {
      return NextResponse.json(
        { error: `user not found for ${email}` },
        { status: 404 }
      );
    }
    userId = found.id;
  }

  // 2) パスワード更新
  const { data: upd, error: updErr } = await admin.auth.admin.updateUserById(
    userId!,
    {
      password,
    }
  );

  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, uid: upd.user.id });
}
