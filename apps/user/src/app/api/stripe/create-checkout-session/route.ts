// apps/user/src/app/api/stripe/create-checkout-session/route.ts
import { NextResponse } from "next/server";
import Stripe from "stripe";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY!;
const STRIPE_API_VERSION =
  (process.env.STRIPE_API_VERSION as Stripe.LatestApiVersion) ??
  "2025-09-30.clover";

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: STRIPE_API_VERSION,
});

export async function POST(req: Request) {
  try {
    const { storeId, userEmail, lines, pickup } = (await req.json()) as {
      storeId: string;
      userEmail?: string;
      pickup?: string;
      lines: Array<{ id: string; name: string; price: number; qty: number }>;
    };

    if (!Array.isArray(lines) || lines.length === 0) {
      return NextResponse.json({ error: "NO_LINES" }, { status: 400 });
    }

    // Embedded Checkout 用のセッション
    // 価格は“最小単位(円)”で渡す: 100円→100
    const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] =
      lines.map((l) => ({
        quantity: l.qty,
        price_data: {
          currency: "jpy",
          product_data: {
            name: l.name,
            metadata: {
              product_id: l.id,
              store_id: storeId,
              pickup: pickup ?? "",
            },
          },
          unit_amount: Math.max(0, Math.round(l.price)), // 既に円ならそのまま
        },
      }));

    // ※ 埋め込み型は ui_mode: 'embedded' と client_secret を返すのがポイント
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;
    const return_url = `${origin}/?checkout_return={CHECKOUT_SESSION_ID}`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      ui_mode: "embedded",
      return_url,
      customer_email: userEmail || undefined,
      line_items,
      // 注文識別に必要なら metadata に storeId や pickup を入れる
      metadata: { store_id: storeId, pickup: pickup ?? "" },
      // （任意）外部キー紐付けなどあればここに
      // client_reference_id: ...
    });

    return NextResponse.json(
      { client_secret: session.client_secret },
      { status: 200 }
    );
  } catch (e: any) {
    console.error("[create-checkout-session] error:", e?.message || e);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}
