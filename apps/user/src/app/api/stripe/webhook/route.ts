// apps/user/src/app/api/stripe/webhook/route.ts
import Stripe from "stripe";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // 署名検証に raw body が必要

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// E-3: 冪等テーブルに記録する（なければ作成しておくこと）
async function recordProcessed(eventId: string, type: string, orderId?: string) {
  const API_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  if (!API_URL || !SERVICE) return false;
  const res = await fetch(`${API_URL}/rest/v1/processed_events`, {
    method: "POST",
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates", // 既存なら無視
    },
    body: JSON.stringify({ event_id: eventId, type, order_id: orderId ?? null }),
    cache: "no-store",
  });
  return res.ok;
}

async function isProcessed(eventId: string) {
  const API_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  if (!API_URL || !SERVICE) return false;
  const r = await fetch(`${API_URL}/rest/v1/processed_events?event_id=eq.${encodeURIComponent(eventId)}&select=event_id`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    cache: "no-store",
  });
  if (!r.ok) return false;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

export async function POST(req: NextRequest) {
  try {
    const sig = req.headers.get("stripe-signature");
    const whsec = process.env.STRIPE_WEBHOOK_SECRET;
    if (!sig || !whsec) return new NextResponse("missing signature", { status: 400 });

    const raw = await req.text();
    const event = stripe.webhooks.constructEvent(raw, sig, whsec);

    // 冪等：二重は即スキップ
    if (await isProcessed(event.id)) return new NextResponse("ok", { status: 200 });

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId = String((session.metadata as any)?.order_id || "");

      // C-2: Stripe側の支払成功を二重確認（任意拡張）
      // TODO(req v2): 金額/通貨/支払い状態の再検証と保存（専用カラム追加）

      if (orderId) {
        // C-3: 注文確定（DBの状態は PENDING のまま。placed_at を刻む）
        try {
          const API_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
          const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
          if (API_URL && SERVICE) {
            await fetch(`${API_URL}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}`, {
              method: "PATCH",
              headers: {
                apikey: SERVICE,
                Authorization: `Bearer ${SERVICE}`,
                "Content-Type": "application/json",
                Prefer: "return=minimal",
              },
              body: JSON.stringify({ placed_at: new Date().toISOString() }),
            });
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

export function GET() { return new NextResponse("Method Not Allowed", { status: 405 }); }

