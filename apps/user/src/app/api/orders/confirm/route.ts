// apps/user/src/app/api/orders/confirm/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { linePush } from "@/lib/line";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // Service Role（サーバーのみ）
);

type ConfirmBody = {
  items: Array<{ sku: string; qty: number }>;
  total: number;
  lineUserId: string; // LIFFの sub（U〜）
  pickupStart?: string | null;
  // 任意で受け取りたいもの（テーブルに NOT NULL があれば使う）
  storeId?: string | null;
  customer?: string | null;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ConfirmBody;

    // --- ここは関数の“内側”なので body を参照できます ---
    console.log("[orders/confirm] body.keys =", Object.keys(body || {}));
    console.log("[orders/confirm] hasLineUserId =", !!body?.lineUserId);

    // 1) バリデーション
    if (!body?.lineUserId) {
      return NextResponse.json(
        { ok: false, error: "LINE_USER_ID_REQUIRED" },
        { status: 400 }
      );
    }
    if (!Array.isArray(body?.items) || body.items.length === 0) {
      return NextResponse.json(
        { ok: false, error: "ITEMS_REQUIRED" },
        { status: 400 }
      );
    }
    if (typeof body?.total !== "number") {
      return NextResponse.json(
        { ok: false, error: "TOTAL_REQUIRED" },
        { status: 400 }
      );
    }

    // 2) insert用ペイロード作成（テーブル定義に合わせて調整可）
    const pickupStartIso =
      (body.pickupStart && new Date(body.pickupStart).toISOString()) ||
      new Date().toISOString(); // フォールバック

    const insertPayload: any = {
      status: "PENDING",
      total: body.total,
      items: body.items ?? null, // jsonb 列があればそのまま
      customer: body.customer ?? null, // text 列があれば
      store_id: body.storeId ?? null, // uuid 列が NOT NULL なら必須化してください
      pickup_start: pickupStartIso,
      reminded_at: null,
      line_user_id: body.lineUserId, // ★ これが本命
      placed_at: new Date().toISOString(), // 置いてあると嬉しい（列があれば）
    };

    console.log("[orders/confirm] insertPayload =", {
      status: insertPayload.status,
      total: insertPayload.total,
      line_user_id: insertPayload.line_user_id,
      pickup_start: insertPayload.pickup_start,
      store_id: insertPayload.store_id,
    });

    // 3) 実書き込み
    const { data: order, error: insertErr } = await supabase
      .from("orders")
      .insert([insertPayload]) // 配列で明示
      .select("id, status, pickup_start, line_user_id")
      .single();

    if (insertErr) {
      console.error("[orders/confirm] insert error:", insertErr);
      return NextResponse.json(
        { ok: false, error: "ORDER_INSERT_FAILED", detail: insertErr.message },
        { status: 500 }
      );
    }

    // 4) 念のための補正（万一 line_user_id が NULL で返る場合に上書き）
    if (!order.line_user_id) {
      const { error: fixErr } = await supabase
        .from("orders")
        .update({ line_user_id: body.lineUserId })
        .eq("id", order.id)
        .is("line_user_id", null);
      if (fixErr) {
        console.error(
          "[orders/confirm] fix line_user_id failed:",
          fixErr.message
        );
      } else {
        console.log("[orders/confirm] fixed line_user_id for", order.id);
      }
    }

    // 5) 任意：到達確認のPush（失敗しても致命ではない）
    try {
      await linePush(body.lineUserId, [
        {
          type: "text",
          text: "ご注文を受け付けました。受け取り予定の10分前にリマインドします。",
        },
      ]);
    } catch (pushErr: any) {
      console.error(
        "[orders/confirm] push error:",
        pushErr?.message ?? pushErr
      );
    }

    const res = NextResponse.json({ ok: true, orderId: order.id });
    res.headers.set("x-orders-confirm", "user-app@v1");
    return res;
  } catch (e: any) {
    console.error("[orders/confirm] fatal:", e?.message ?? e);
    return NextResponse.json(
      {
        ok: false,
        error: "ORDER_CONFIRM_FATAL",
        detail: String(e?.message ?? e),
      },
      { status: 500 }
    );
  }
}

