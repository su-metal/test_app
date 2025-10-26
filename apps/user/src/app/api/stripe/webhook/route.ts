import Stripe from "stripe";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // 署名検証で raw body が必要

// Stripe client
// TODO(req v2): API バージョン固定は将来の型更新後に再検討
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);

// ENV
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY as string;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN as string;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET as string;

// processed_events: 冪等性用に記録
async function recordProcessed(eventId: string, type?: string, orderId?: string) {
  if (!SUPABASE_URL || !SERVICE_ROLE) return false;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/processed_events?on_conflict=event_id`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify({
      event_id: eventId,
      ...(type ? { type } : {}),
      ...(orderId ? { order_id: orderId } : {}),
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[processed_events] insert failed:", res.status, body);
  }
  return res.ok;
}

async function isProcessed(eventId: string) {
  if (!SUPABASE_URL || !SERVICE_ROLE) return false;
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/processed_events?event_id=eq.${encodeURIComponent(eventId)}&select=event_id&limit=1`,
    {
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
      },
      cache: "no-store",
    }
  );
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.error("[processed_events] check failed:", r.status, body);
    return false;
  }
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

// orders 更新（Service Role で RLS 回避）
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
        // TODO(req v2): placed_at の扱いは正式要件に合わせて調整
        payment_status: "PAID",
        paid_at: new Date().toISOString(),
        stripe_payment_intent_id: paymentIntentId,
        ...(receiptUrl ? { receipt_url: receiptUrl } : {}),
      }),
    }
  );

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    console.error("[orders] PATCH failed:", resp.status, txt);
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

// LINE push（値がある行のみ表示）
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
      : undefined;

  const lines: Array<string> = [];
  lines.push("お支払いありがとうございます。ご注文を受け付けました 🎉");
  if (payload.store_name) lines.push(`店舗：${payload.store_name}`);
  if (payload.code) lines.push(`引換コード：${payload.code}`);
  if (typeof payload.total_amount === "number")
    lines.push(`お支払い金額：¥${payload.total_amount.toLocaleString()}`);
  if (pickup) lines.push(pickup);
  if (ticketUrl) {
    lines.push("");
    lines.push(`チケットを表示： ${ticketUrl}`);
  }

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
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
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[LINE push] failed:", res.status, body);
  }
}

// Route
export async function POST(req: NextRequest) {
  try {
    const sig = req.headers.get("stripe-signature");
    if (!sig || !STRIPE_WEBHOOK_SECRET) {
      console.error("[webhook] missing Stripe signature or webhook secret");
      return new NextResponse("missing signature", { status: 400 });
    }

    // raw body で署名検証
    const raw = await req.text();
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_SECRET);
    } catch (e: any) {
      console.error("[webhook] signature verification failed:", e?.message || e);
      return new NextResponse("signature verification failed", { status: 400 });
    }

    // 冪等性: 既に処理済みなら即 200
    if (await isProcessed(event.id)) {
      return new NextResponse("ok", { status: 200 });
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      // 支払い情報（PI と領収書 URL）
      let paymentIntentId: string | null =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : (session.payment_intent as any)?.id ?? null;

      // まず session.metadata.order_id
      let orderId = String((session.metadata as any)?.order_id || "");
      let receiptUrl: string | null = null;

      // フォールバック: PaymentIntent.metadata.order_id（latest_charge を expand）
      try {
        if (!paymentIntentId && session.payment_intent) {
          paymentIntentId =
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : (session.payment_intent as any)?.id ?? null;
        }
        if (paymentIntentId) {
          const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
            expand: ["latest_charge"],
          });
          const latestCharge =
            typeof pi.latest_charge === "string"
              ? null
              : (pi.latest_charge as Stripe.Charge | null);
          receiptUrl = latestCharge?.receipt_url ?? null;
          const piMeta = (pi.metadata || {}) as Record<string, string>;
          if (!orderId) orderId = String(piMeta.order_id || "");
        }
      } catch (e: any) {
        console.warn("[webhook] payment_intent retrieve failed:", e?.message || e);
      }

      if (!orderId) {
        console.error(
          "[webhook] order_id missing in both session.metadata and payment_intent.metadata"
        );
        // 受信済みにして重複を無害化
        await recordProcessed(event.id, event.type);
        return new NextResponse("ok", { status: 200 });
      }

      // orders を PAID に更新
      const patched = await patchOrderPaid({
        orderId,
        paymentIntentId: paymentIntentId || "",
        receiptUrl,
      });

      // LINE push（line_user_id が取れるときのみ）
      if (patched?.line_user_id) {
        await pushLine(patched.line_user_id, {
          store_name: patched.store_name,
          code: patched.code,
          total_amount: patched.total_amount,
          pickup_time_from: patched.pickup_time_from,
          pickup_time_to: patched.pickup_time_to,
        });
      }

      // 処理済み記録
      await recordProcessed(event.id, event.type, orderId);
      return new NextResponse("ok", { status: 200 });
    }

    // 対象外イベントも処理済みに記録
    await recordProcessed(event.id, event.type);
    return new NextResponse("ok", { status: 200 });
  } catch (e: any) {
    console.error("[webhook] error:", e?.message || e);
    return new NextResponse("bad request", { status: 400 });
  }
}

export function GET() {
  return new NextResponse("Method Not Allowed", { status: 405 });
}
