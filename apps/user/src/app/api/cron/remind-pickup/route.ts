// apps/user/src/app/api/cron/remind-pickup/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { linePush } from "@/lib/line"; // ← 修正済み（@ は src を指す想定）

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // Service Role
);

const WINDOW_MINUTES = 5; // cron間隔
const REMIND_BEFORE_MIN = 10; // 受け取り前10分

export async function POST() {
  try {
    // 抽出窓を作成（UTC前提）
    const now = new Date();
    const lower = new Date(
      now.getTime() + (REMIND_BEFORE_MIN - WINDOW_MINUTES / 2) * 60_000
    );
    const upper = new Date(
      now.getTime() + (REMIND_BEFORE_MIN + WINDOW_MINUTES / 2) * 60_000
    );

    const { data: orders, error } = await supabase
      .from("orders")
      .select(
        "id, status, pickup_start, reminded_at, line_user_id, auth_user_id"
      )
      .is("reminded_at", null)
      .eq("status", "PENDING")
      .gte("pickup_start", lower.toISOString())
      .lte("pickup_start", upper.toISOString());

    if (error) throw error;

    let sent = 0;

    for (const o of orders ?? []) {
      let to = (o as any).line_user_id as string | null;

      // line_user_id が無ければ auth_user_id 経由で解決
      if (!to && (o as any).auth_user_id) {
        const { data: lu, error: luErr } = await supabase
          .from("line_users")
          .select("line_user_id")
          .eq("auth_user_id", (o as any).auth_user_id)
          .maybeSingle();
        if (luErr) throw luErr;
        to = lu?.line_user_id ?? null;
      }

      if (!to) continue; // 宛先不明はスキップ（ログ監視推奨）

      // LINE push（シンプルテキスト）
      await linePush(to, [
        {
          type: "text",
          text: "🍜 まもなく受け取り時間です！ご来店の際にチケットを提示してください。",
        },
      ]);

      // 冪等性：通知済み記録
      const { error: updErr } = await supabase
        .from("orders")
        .update({ reminded_at: new Date().toISOString() })
        .eq("id", (o as any).id);
      if (updErr) throw updErr;

      sent++;
    }

    return NextResponse.json({ ok: true, checked: orders?.length ?? 0, sent });
  } catch (e: any) {
    console.error("[remind-pickup] error:", e?.message ?? e);
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e) },
      { status: 500 }
    );
  }
}
