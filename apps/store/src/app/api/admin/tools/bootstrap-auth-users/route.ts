import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// （任意）簡易ヘッダ鍵で保護したい場合は .env に ADMIN_DASHBOARD_SECRET を入れてください
const ADMIN_SECRET = process.env.ADMIN_DASHBOARD_SECRET;

// service role（必ずサーバーのみ）
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// 仮メール作成ヘルパー（.test ドメインは実メール送信されない）
function pseudoEmailForStore(storeId: string) {
  return `store_${storeId}@example.test`;
}

// 生存確認
export async function GET() {
  return NextResponse.json({ ok: true, route: "alive" });
}

export async function POST(req: Request) {
  // （任意）簡易ヘッダ鍵チェック
  if (ADMIN_SECRET) {
    const header = new Headers(req.headers).get("x-admin-secret");
    if (header !== ADMIN_SECRET) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  try {
    // 1) auth_user_id が NULL の店舗だけ取得
    const { data: stores, error: qerr } = await supabaseAdmin
      .from("stores")
      .select("id, name, auth_user_id")
      .is("auth_user_id", null);

    if (qerr)
      return NextResponse.json({ error: qerr.message }, { status: 500 });
    if (!stores || stores.length === 0) {
      return NextResponse.json({
        ok: true,
        created: 0,
        updated: 0,
        note: "no target stores",
      });
    }

    let created = 0;
    let updated = 0;

    for (const s of stores) {
      const email = pseudoEmailForStore(s.id);

      // 2) 既存ユーザーをメールで探す（SDKにemailフィルタがない場合があるため簡易実装）
      //    小規模前提：最初に1ページだけ取得してフィルタ
      const listRes = await supabaseAdmin.auth.admin.listUsers({
        page: 1,
        perPage: 100,
      } as any);
      if (listRes.error)
        return NextResponse.json(
          { error: listRes.error.message },
          { status: 500 }
        );

      const maybe = listRes.data?.users?.find(
        (u: any) => String(u.email).toLowerCase() === email.toLowerCase()
      );
      let userId = maybe?.id as string | undefined;

      // 3) 無ければ作成（仮パスワードは後で変更可）
      if (!userId) {
        const createdRes = await supabaseAdmin.auth.admin.createUser({
          email,
          password: "InitPass123!",
          email_confirm: true,
        });
        if (createdRes.error || !createdRes.data?.user?.id) {
          return NextResponse.json(
            { error: createdRes.error?.message ?? "create user failed" },
            { status: 500 }
          );
        }
        userId = createdRes.data.user.id;
        created++;
      }

      // 4) stores に紐付け
      const { error: uerr } = await supabaseAdmin
        .from("stores")
        .update({ auth_user_id: userId })
        .eq("id", s.id);

      if (uerr)
        return NextResponse.json({ error: uerr.message }, { status: 500 });
      updated++;
    }

    return NextResponse.json({ ok: true, created, updated });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "unknown error" },
      { status: 500 }
    );
  }
}
