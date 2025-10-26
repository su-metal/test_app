// apps/user/src/app/api/stripe/webhook/route.ts
import Stripe from "stripe";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // 署名検証に raw body が必要

// --- Stripe client (API version 固定) ---
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-09-30.clover",
});

// --- ENV (必須) ---
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

// ─────────────────────────────────────────────────────────────
// 冪等管理: processed_events
// ─────────────────────────────────────────────────────────────
async function recordProcessed(
  eventId: string,
  type: string,
  orderId?: string
) {
  if (!SUPABASE_URL || !SERVICE_ROLE) return false;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/processed_events`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates",
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
  if (!SUPABASE_URL || !SERVICE_ROLE) return false;
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/processed_events?event_id=eq.${encodeURIComponent(
      eventId
    )}&select=event_id`,
    {
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
      },
      cache: "no-store",
    }
  );
  if (!r.ok) return false;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

// ─────────────────────────────────────────────────────────────
// 注文更新: 支払済みに更新し、必要なら push
// ─────────────────────────────────────────────────────────────
async function patchOrderPaid(params: {
  orderId: string;
  paymentIntentId: string;
  receiptUrl?: string | null;
}) {
  const { orderId, paymentIntentId, receiptUrl } = params;

  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}`,
    {
      method: "PATCH",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        // 既存
        placed_at: new Date().toISOString(),
        // 追加（status は PENDING のまま）
        payment_status: "PAID",
        paid_at: new Date().toISOString(),
        stripe_payment_intent_id: paymentIntentId,
        ...(receiptUrl ? { receipt_url: receiptUrl } : {}),
      }),
    }
  );

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    console.error("Supabase PATCH failed:", resp.status, txt);
    throw new Error(`Supabase PATCH failed: ${resp.status}`);
  }

  const rows = (await resp.json().catch(() => [])) as Array<{
    line_user_id?: string | null;
    code?: string | null;
    total_amount?: number | null;
    store_name?: string | null;
    pickup_time_from?: string | null;
    pickup_time_to?: string | null;
  }>;
  return Array.isArray(rows) ? rows[0] : null;
}

// ─────────────────────────────────────────────────────────────
// LINE push（取得できたときのみ）
// ─────────────────────────────────────────────────────────────
async function pushLine(
  userId: string,
  payload: {
    store_name?: string | null;
    code?: string | null;
    total_amount?: number | null;
    pickup_time_from?: string | null;
    pickup_time_to?: string | null;
  }
) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || !userId) return;

  const liffId = process.env.NEXT_PUBLIC_LIFF_ID || "";
  const ticketUrl = liffId ? `https://liff.line.me/${liffId}?tab=order` : "";

  const pickup =
    payload.pickup_time_from && payload.pickup_time_to
      ? `${payload.pickup_time_from}〜${payload.pickup_time_to}`
      : "受取時間は注文詳細でご確認ください";

  const lines = [
    "お支払いありがとうございます。ご注文を受け付けました 🎉",
    payload.store_name ? `店舗：${payload.store_name}` : null,
    payload.code ? `引換コード：${payload.code}` : null,
    typeof payload.total_amount === "number"
      ? `お支払い金額：¥${payload.total_amount.toLocaleString()}`
      : null,
    pickup,
    "",
    ticketUrl ? `チケットを表示：${ticketUrl}` : null,
  ].filter(Boolean);

  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: "text", text: lines.join("\n") }],
    }),
  });
}

// ─────────────────────────────────────────────────────────────
// Route
// ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const sig = req.headers.get("stripe-signature");
    if (!sig || !STRIPE_WEBHOOK_SECRET) {
      return new NextResponse("missing signature", { status: 400 });
    }

    // Raw body で署名検証
    const raw = await req.text();
    const event = stripe.webhooks.constructEvent(
      raw,
      sig,
      STRIPE_WEBHOOK_SECRET
    );

    // 冪等性（重複配信の無視）
    if (await isProcessed(event.id)) {
      return new NextResponse("ok", { status: 200 });
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      // --- 支払い情報（PI/領収書URL） ---
      let paymentIntentId: string | null =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : (session.payment_intent as any)?.id ?? null;

      // まず session.metadata から
      let orderId = String((session.metadata as any)?.order_id || "");
      let receiptUrl: string | null = null;

      // 必要情報補完のため PI を取得
      let pi: Stripe.PaymentIntent | null = null;
      try {
        if (!paymentIntentId && session.payment_intent) {
          paymentIntentId =
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : (session.payment_intent as any)?.id ?? null;
        }
        if (paymentIntentId) {
          pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
            expand: ["latest_charge"],
          });
          const latestCharge =
            typeof pi.latest_charge === "string"
              ? null
              : (pi.latest_charge as Stripe.Charge | null);
          receiptUrl = latestCharge?.receipt_url ?? null;

          // --- フォールバック: PI.metadata.order_id ---
          const piMeta = (pi.metadata || {}) as Record<string, string>;
          if (!orderId) orderId = String(piMeta.order_id || "");
        }
      } catch (e) {
        // PI 取得失敗は致命ではない（receiptUrl/orderId フォールバック不可になるだけ）
        console.warn(
          "[stripe/webhook] payment_intent retrieve failed:",
          (e as any)?.message
        );
      }

      if (!orderId) {
        console.error(
          "[stripe/webhook] order_id not found in session.metadata and payment_intent.metadata"
        );
        await recordProcessed(event.id, event.type); // 記録だけしておく
        return new NextResponse("ok", { status: 200 });
      }

      // --- 注文を PAID に更新 ---
      const patched = await patchOrderPaid({
        orderId,
        paymentIntentId: paymentIntentId || "",
        receiptUrl,
      });

      // --- push（line_user_id が取得できたら） ---
      if (patched?.line_user_id) {
        await pushLine(patched.line_user_id, {
          store_name: patched.store_name,
          code: patched.code,
          total_amount: patched.total_amount,
          pickup_time_from: patched.pickup_time_from,
          pickup_time_to: patched.pickup_time_to,
        });
      }

      await recordProcessed(event.id, event.type, orderId);
      return new NextResponse("ok", { status: 200 });
    }

    // その他イベントは記録のみ
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
