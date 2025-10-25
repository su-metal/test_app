// apps/user/src/app/api/stripe/create-checkout-session/route.ts
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { verifyLiffIdToken, verifyLiffTokenString } from "@/lib/verifyLiff";
import { cookies } from "next/headers";
import { COOKIE_NAME as USER_COOKIE, verifySessionCookie } from "@/lib/session";

export const runtime = "nodejs"; // Stripe は Node ランタイム

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

/**
 * 入力例（フロントからのボディ）
 * {
 *   storeId?: string,
 *   userEmail?: string,
 *   lines: { id?: string; name: string; price: number; qty: number }[],
 *   pickup?: string,
 *   returnUrl: string
 * }
 */
export async function POST(req: NextRequest) {
  // A-1: Authorization Bearer → x-liff-id-token → サーバ発行 Cookie の順に検証（段階的フォールバック）
  let lineUserId = "";
  let body: any = null;
  try {
    const auth = req.headers.get("authorization");
    if (auth) {
      lineUserId = await verifyLiffIdToken(auth);
    } else {
      const h2 = req.headers.get("x-liff-id-token");
      if (h2) lineUserId = await verifyLiffTokenString(h2);
    }
    if (!lineUserId) {
      body = await req.json().catch(() => null);
      const tokenInBody: string | undefined = body?.id_token || body?.idToken;
      if (tokenInBody) lineUserId = await verifyLiffTokenString(String(tokenInBody));
    }
    if (!lineUserId) {
      // 最後のフォールバック: サーバ発行の HMAC セッション Cookie
      const secret = process.env.USER_SESSION_SECRET || process.env.LINE_CHANNEL_SECRET || "";
      if (secret) {
        const c = await cookies();
        const sess = verifySessionCookie(c.get(USER_COOKIE)?.value, secret);
        const sub = sess?.sub && String(sess.sub).trim();
        if (sub) lineUserId = sub;
      }
    }
    if (!lineUserId) {
      return NextResponse.json({ error: "unauthorized", detail: "Authorization ヘッダーが Bearer 形式ではありません" }, { status: 401 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: "unauthorized", detail: e?.message || String(e) }, { status: 401 });
  }

  try {
    const { storeId, userEmail, lines, pickup, returnUrl } = body ?? (await req.json());

    if (!Array.isArray(lines) || lines.length === 0) {
      return NextResponse.json({ error: "line_items is empty" }, { status: 400 });
    }

    const currency = "jpy";
    const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = (lines as Array<any>)
      .map((l: any) => ({
        quantity: Math.max(0, Number(l?.qty) || 0),
        price_data: {
          currency,
          unit_amount: Math.max(0, Math.floor(Number(l?.price) || 0)),
          product_data: {
            name: String(l?.name || "商品"),
            metadata: { product_id: String(l?.id ?? "") },
          },
        },
      }))
      .filter((li) => (Number(li.quantity) || 0) > 0);

    // B-2: プレオーダー（仮注文）作成
    const API_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    if (!API_URL || !ANON) {
      return NextResponse.json({ error: "server-misconfig:supabase" }, { status: 500 });
    }

    const items = (lines as Array<any>).map((l) => ({
      id: String(l?.id ?? ""),
      name: String(l?.name ?? ""),
      qty: Math.max(0, Number(l?.qty) || 0),
      price: Math.max(0, Math.floor(Number(l?.price) || 0)),
    }));
    const total = items.reduce((a, it) => a + (Number(it.price) || 0) * (Number(it.qty) || 0), 0);

    function code6(): string {
      return Math.floor(Math.random() * 1_000_000).toString().padStart(6, "0");
    }
    function parsePickupLabelToJstIsoRange(label?: string): { start?: string; end?: string } {
      const text = String(label || "").trim();
      if (!text) return {};
      const m = text.match(/(\d{1,2}:\d{2})\s*[?\-??~]\s*(\d{1,2}:\d{2})/);
      if (!m) return {};
      const [_, a, b] = m;
      const pad = (s: string) => (s.length === 1 ? `0${s}` : s);
      const toIso = (hhmm: string) => {
        const [hh, mm] = hhmm.split(":");
        const parts = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
        const y = parts.find((p) => p.type === "year")?.value ?? "1970";
        const mo = parts.find((p) => p.type === "month")?.value ?? "01";
        const d = parts.find((p) => p.type === "day")?.value ?? "01";
        return `${y}-${mo}-${d}T${pad(hh)}:${pad(mm)}:00+09:00`;
      };
      return { start: toIso(a), end: toIso(b) };
    }
    const pick = parsePickupLabelToJstIsoRange(String(pickup || ""));

    const preOrderPayload: any = {
      store_id: String(storeId ?? ""),
      code: code6(),
      customer: String(userEmail ?? "guest@example.com"),
      items,
      total,
      status: "PENDING", // 店側DBの状態: 受け取り待ち
      line_user_id: lineUserId,
    };
    if (pick?.start) preOrderPayload.pickup_start = pick.start;
    if (pick?.end) preOrderPayload.pickup_end = pick.end;

    const preRes = await fetch(`${API_URL}/rest/v1/orders?select=id,code`, {
      method: "POST",
      headers: {
        apikey: ANON,
        Authorization: `Bearer ${ANON}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(preOrderPayload),
      cache: "no-store",
    });
    if (!preRes.ok) {
      const t = await preRes.text().catch(() => "");
      return NextResponse.json({ error: "preorder_failed", detail: `${preRes.status} ${t}` }, { status: 400 });
    }
    const preRows = await preRes.json();
    const pre = Array.isArray(preRows) ? preRows[0] : preRows;
    const orderId: string = String(pre?.id || "");
    const orderCode: string = String(pre?.code || "");
    if (!orderId) return NextResponse.json({ error: "preorder_id_missing" }, { status: 500 });

    // -------- 1) Customer 既存メールで取得 or 作成（任意） --------
    let customerId: string | undefined;
    if (userEmail) {
      const existing = await stripe.customers.list({ email: userEmail, limit: 1 });
      if (existing.data.length > 0) customerId = existing.data[0].id;
      else customerId = (await stripe.customers.create({ email: userEmail })).id;
    }

    // -------- 2) セッション生成（内部相関のみ） --------
    const params: Stripe.Checkout.SessionCreateParams = {
      ui_mode: "embedded",
      mode: "payment",
      customer: customerId,
      payment_intent_data: {
        setup_future_usage: "off_session",
        metadata: { order_id: orderId }, // 内部相関のみ
      },
      payment_method_types: ["card"],
      line_items,
      return_url: `${returnUrl}?session_id={CHECKOUT_SESSION_ID}`,
      metadata: {
        order_id: orderId,
        store_id: String(storeId ?? ""), // 任意
        pickup_label: String(pickup ?? ""), // 任意
      },
      client_reference_id: orderCode || undefined,
    };

    const session = await stripe.checkout.sessions.create(params);
    return NextResponse.json({ client_secret: session.client_secret }, { status: 200 });
  } catch (err: any) {
    console.error("[create-checkout-session] error:", err?.message || err);
    return NextResponse.json({ error: err?.message ?? "unknown" }, { status: 400 });
  }
}

