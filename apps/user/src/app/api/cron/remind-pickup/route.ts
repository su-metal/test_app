// apps/user/src/app/api/cron/remind-pickup/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { linePush } from "@/lib/line";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // Service Role
);

const WINDOW_MINUTES = 5; // cron間隔
const REMIND_BEFORE_MIN = 10; // 受け取り予定の10分前

export async function POST() {
  try {
    // 時刻窓の計算（UTC）
    const now = new Date();
    const lower = new Date(
      now.getTime() + (REMIND_BEFORE_MIN - WINDOW_MINUTES / 2) * 60_000
    );
    const upper = new Date(
      now.getTime() + (REMIND_BEFORE_MIN + WINDOW_MINUTES / 2) * 60_000
    );

    const { data: orders, error } = await supabase
      .from("orders")
      .select("id, status, pickup_start, reminded_at, line_user_id")
      .is("reminded_at", null)
      .eq("status", "PENDING")
      .not("line_user_id", "is", null)
      .gte("pickup_start", lower.toISOString())
      .lte("pickup_start", upper.toISOString());

    if (error) throw error;

    let sent = 0;

    for (const o of orders ?? []) {
      const to = (o as any).line_user_id as string | null;
      if (!to) continue; // 保険（NOT NULL 条件だが二重防御）

      // LINE push（シンプルテキスト）
      await linePush(to, [
        {
          type: "text",
          text: "まもなく受け取り予定です。店舗でチケットをご提示ください。",
        },
      ]);

      // 送信後に reminded_at を記録（冪等確保）
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

