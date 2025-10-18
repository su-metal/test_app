// app/api/stripe/checkout/route.ts
import Stripe from "stripe";
import { NextResponse } from "next/server";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: Request) {
  try {
    const origin = req.headers.get("origin") || req.headers.get("host") || "";
    const baseUrl = origin.startsWith("http") ? origin : `https://${origin}`;

    const body = await req.json();
    const {
      storeId,
      userEmail,
      lines, // [{ id,name, price, qty }]
      pickup,
    } = body as {
      storeId: string;
      userEmail?: string;
      lines: Array<{ id: string; name: string; price: number; qty: number }>;
      pickup?: string; // "HH:MM〜HH:MM"
    };

    if (!lines?.length) {
      return NextResponse.json({ error: "LINE_ITEMS_EMPTY" }, { status: 400 });
    }

    // StripeはJPYが“ゼロ小数通貨”。unit_amount は「円の整数」でOK（×100しない！）
    const pickupLabel = typeof pickup === "string" ? pickup.trim() : "";

    const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] =
      lines.map((l) => ({
        quantity: l.qty,
        price_data: {
          currency: "jpy",
          unit_amount: Math.max(0, Math.trunc(l.price)), // 円
          product_data: { name: l.name || "商品" },
        },
      }));

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      locale: "ja",
      payment_method_types: ["card"],
      customer_email: userEmail || undefined,
      line_items,
      // 戻り先（成功・キャンセル）
      success_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/checkout/cancel`,
      // 後で注文作成するためのメタデータを付与（サーバー側で取り出す）
      metadata: {
        store_id: storeId,
        items_json: JSON.stringify(
          lines.map((l) => ({
            id: l.id,
            name: l.name,
            qty: l.qty,
            price: l.price,
          }))
        ),
        email: userEmail || "guest@example.com",
        ...(pickupLabel ? { pickup_label: pickupLabel } : {}),
      },
      // Stripe 決済画面のフッター付近にカスタムテキストを表示
      ...(pickupLabel
        ? {
            custom_text: {
              // ボタン直上で強調表示（改行と全角記号で視認性を上げる）
              submit: {
                message: `【重要】⏰ 受取予定時間\n${pickupLabel}（店頭での提示が必要です）`,
              },
            },
          }
        : {}),
    });

    return NextResponse.json({ id: session.id, url: session.url });
  } catch (e: any) {
    console.error("[stripe/checkout] error:", e?.message || e);
    return NextResponse.json(
      { error: "CREATE_SESSION_FAILED" },
      { status: 500 }
    );
  }
}
