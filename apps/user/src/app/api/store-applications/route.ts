// apps/user/src/app/api/store-applications/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// POST /api/store-applications
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const store_name = (body.store_name ?? "").toString().trim();
    const owner_name = (body.owner_name ?? "").toString().trim();
    const email = (body.email ?? "").toString().trim();
    const phone = (body.phone ?? "").toString().trim();

    if (!store_name || !owner_name || !email) {
      return NextResponse.json(
        { error: "必須項目が不足しています。" },
        { status: 400 }
      );
    }

    // 簡易バリデーション
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json(
        { error: "メールアドレスの形式が正しくありません。" },
        { status: 400 }
      );
    }

    const { error } = await supabase.from("store_applications").insert({
      store_name,
      owner_name,
      email,
      phone,
    });

    if (error) {
      // 同一メールで連投などの制御を足したい場合はここでエラー分岐
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "unknown error" },
      { status: 500 }
    );
  }
}

// （任意）ヘルスチェック：GET /api/store-applications
export async function GET() {
  return NextResponse.json({ ok: true });
}
