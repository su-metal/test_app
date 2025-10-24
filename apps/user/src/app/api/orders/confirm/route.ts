// apps/user/src/app/api/orders/confirm/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
// エイリアス未設定なら相対に： '../../../../../lib/line'
import { linePush } from "@/lib/line";

// Supabase（server）
function getServiceClient() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// 6桁引換コード
const genCode = () => Math.floor(100000 + Math.random() * 900000).toString();

// LIFF DeepLink（チケット画面にリダイレクトする例）
function makeLiffTicketsUrl(orderId: string) {
  const liffId = process.env.USER_LIFF_ID!;
  const qs = new URLSearchParams({ redirect: "/tickets", orderId }).toString();
  return `https://liff.line.me/${liffId}?${qs}`;
}

export async function POST(req: NextRequest) {
  try {
    const supa = getServiceClient();

    // 受け取るJSON: items(json配列), total(=金額), authUserId(uuid任意), lineUserId(任意), storeId(任意)
    const { items, amount, total, authUserId, lineUserId, storeId } =
      await req.json();

    // 1) DB保存（あなたのordersスキーマに合わせる）
    // - 列名: total に金額を入れる（amount or total どちらで来ても対応）
    // - status は enum。スクショでは 'FULFILLED' が有効なので一旦それを使用
    // - code / placed_at をこちらで付与
    let orderId = "dummy-order-id";
    try {
      const { data, error } = await supa
        .from("orders")
        .insert({
          code: genCode(),
          customer: null, // あればメール等を入れる
          items, // 受け取った配列をそのままjsonbへ
          total: typeof total === "number" ? total : Number(amount ?? 0),
          placed_at: new Date().toISOString(),
          status: "FULFILLED", // enumに存在する値を使用（必要なら変更）
          store_id: storeId ?? null,
          auth_user_id: authUserId ?? null,
        })
        .select("id")
        .single();

      if (error || !data) {
        console.error("order insert error", error);
      } else {
        orderId = data.id;
      }
    } catch (e) {
      console.error("order insert fatal", e);
    }

    // 2) line_user_id があれば push
    if (lineUserId) {
      const url = makeLiffTicketsUrl(orderId);
      await linePush(lineUserId, [
        {
          type: "text",
          text: "ご注文を受け付けました。ありがとうございます！",
        },
        {
          type: "template",
          altText: "チケットを見る",
          template: {
            type: "buttons",
            text: "チケットを見る",
            actions: [{ type: "uri", label: "開く", uri: url }],
          },
        },
      ]);
    } else {
      console.warn("push skipped: no line_user_id provided");
    }

    return NextResponse.json({ ok: true, orderId });
  } catch (e: any) {
    console.error("[orders/confirm] fatal", e?.message || e);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
