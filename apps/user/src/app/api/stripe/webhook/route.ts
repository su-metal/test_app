// apps/user/src/app/api/stripe/webhook/route.ts
import Stripe from "stripe";
// --- TEMP: まず405を解消するための最小実装 ---
import { NextRequest, NextResponse } from "next/server";

// export async function POST(req: NextRequest) {
//   // StripeはPOSTで来る。ここまで来れば405は解消
//   // 一旦200で返してダッシュボードの「配信成功」を確認する
//   await req.text(); // 後で署名検証で使う。ここでは読んで捨て
//   return new NextResponse("ok", { status: 200 });
// }

// App Routerでは pages 由来の bodyParser 設定は不要（=効かない）
// export const config = { api: { bodyParser: false } } は書かないでOK

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // 署名検証に raw body が必要

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// E-3: 冪等テーブルに記録する（なければ作成しておくこと）
async function recordProcessed(
  eventId: string,
  type: string,
  orderId?: string
) {
  const API_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const SERVICE =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  if (!API_URL || !SERVICE) return false;
  const res = await fetch(`${API_URL}/rest/v1/processed_events`, {
    method: "POST",
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates", // 既存なら無視
    },
    body: JSON.stringify({
      event_id: eventId,
      type,
      order_id: orderId ?? null,
    }),
    cache: "no-store",
  });
  return res.ok;
}

async function isProcessed(eventId: string) {
  const API_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const SERVICE =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  if (!API_URL || !SERVICE) return false;
  const r = await fetch(
    `${API_URL}/rest/v1/processed_events?event_id=eq.${encodeURIComponent(
      eventId
    )}&select=event_id`,
    {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
      cache: "no-store",
    }
  );
  if (!r.ok) return false;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

export async function POST(req: NextRequest) {
  try {
    const sig = req.headers.get("stripe-signature");
    const whsec = process.env.STRIPE_WEBHOOK_SECRET;
    if (!sig || !whsec)
      return new NextResponse("missing signature", { status: 400 });

    const raw = await req.text();
    const event = stripe.webhooks.constructEvent(raw, sig, whsec);

    // 冪等：二重は即スキップ
    if (await isProcessed(event.id))
      return new NextResponse("ok", { status: 200 });

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      // --- 支払い情報取得（宣言は先に！以降のPATCHで参照するため） ---
      let paymentIntentId: string | null =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : (session.payment_intent as any)?.id ?? null;

      let receiptUrl: string | null = null;
      try {
        if (paymentIntentId) {
          const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
            expand: ["latest_charge"],
          });
          const ch: any =
            typeof pi.latest_charge === "string"
              ? null
              : (pi.latest_charge as any) ?? null;
          receiptUrl = ch?.receipt_url ?? null;
        }
      } catch {
        // 取得失敗は無視（receiptUrl は null のまま）
      }
      // --- ここまで ---

      const orderId = String((session.metadata as any)?.order_id || "");

      // C-2: Stripe側の支払成功を二重確認（任意拡張）
      // TODO(req v2): 金額/通貨/支払い状態の再検証と保存（専用カラム追加）

      if (orderId) {
        // C-3: 注文確定（DBの状態は PENDING のまま。placed_at を刻む）
        try {
          const API_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
          const SERVICE =
            process.env.SUPABASE_SERVICE_ROLE_KEY ||
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
          if (API_URL && SERVICE) {
            await fetch(
              `${API_URL}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}`,
              {
                method: "PATCH",
                headers: {
                  apikey: SERVICE,
                  Authorization: `Bearer ${SERVICE}`,
                  "Content-Type": "application/json",
                  Prefer: "return=minimal",
                },
                body: JSON.stringify({
                  // 既存
                  placed_at: new Date().toISOString(),

                  // 追加（statusはPENDINGのまま触らない）
                  payment_status: "PAID",
                  paid_at: new Date().toISOString(),
                  stripe_payment_intent_id: paymentIntentId,
                  ...(receiptUrl ? { receipt_url: receiptUrl } : {}),
                }),
              }
            );
            // --- 追記: 注文を取得してLINE push ---
            const detailRes = await fetch(
              `${API_URL}/rest/v1/orders?id=eq.${encodeURIComponent(
                orderId
              )}&select=line_user_id,code,total_amount,store_name,pickup_time_from,pickup_time_to`,
              {
                method: "GET",
                headers: {
                  apikey: SERVICE,
                  Authorization: `Bearer ${SERVICE}`,
                },
              }
            );
            const detailRows = await detailRes.json().catch(() => []);
            const ord = Array.isArray(detailRows) ? detailRows[0] : null;

            if (ord?.line_user_id && process.env.LINE_CHANNEL_ACCESS_TOKEN) {
              const liffId = process.env.NEXT_PUBLIC_LIFF_ID || "";
              const ticketUrl = liffId
                ? `https://liff.line.me/${liffId}?tab=order`
                : "";

              const pickup =
                ord.pickup_time_from && ord.pickup_time_to
                  ? `${ord.pickup_time_from}〜${ord.pickup_time_to}`
                  : "受取時間は注文詳細でご確認ください";

              const lines = [
                "ご注文を受け付けました 🎉",
                ord.store_name ? `店舗：${ord.store_name}` : null,
                ord.code ? `引換コード：${ord.code}` : null,
                typeof ord.total_amount === "number"
                  ? `お支払い金額：¥${ord.total_amount.toLocaleString()}`
                  : null,
                pickup,
                "",
                ticketUrl ? `チケットを表示：${ticketUrl}` : null,
              ].filter(Boolean);

              await fetch("https://api.line.me/v2/bot/message/push", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  to: ord.line_user_id,
                  messages: [{ type: "text", text: lines.join("\n") }],
                }),
              });
            }
            // --- 追記ここまで ---
          }
        } catch {}
      }

      await recordProcessed(event.id, event.type, orderId || undefined);
      return new NextResponse("ok", { status: 200 });
    }

    // その他は記録のみ
    await recordProcessed(event.id, event.type);
    return new NextResponse("ok", { status: 200 });
  } catch (e: any) {
    console.error("[stripe/webhook] error:", e?.message || e);
    return new NextResponse("bad request", { status: 400 });
  }
}

export function GET() {
  return new NextResponse("Method Not Allowed", { status: 405 });
}
