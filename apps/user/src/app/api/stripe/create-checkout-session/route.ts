// apps/user/src/app/api/stripe/create-checkout-session/route.ts
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { verifyLiffIdToken, verifyLiffTokenString } from "@/lib/verifyLiff";
import { cookies } from "next/headers";
import { COOKIE_NAME as USER_COOKIE, verifySessionCookie } from "@/lib/session";

export const runtime = "nodejs"; // Stripe は Node 実行

// Stripe クライアント（型の都合で apiVersion は未指定：ライブラリ同梱のデフォルトに合わせる）
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// ─────────────────────────────────────────────────────────────
// ENV / Helpers
// ─────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function assertEnv() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("server-misconfig:supabase env missing");
  }
}

function genShortCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 読みやすい集合
  let s = "";
  for (let i = 0; i < len; i++)
    s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/**
 * 期待ボディ
 * {
 *   storeId?: string,
 *   userEmail?: string,
 *   lines: { id?: string; name: string; price: number; qty: number }[],
 *   pickup?: string,         // 例 "18:30〜18:40"（DBへは送らず Stripe metadata のみに格納）
 *   returnUrl: string,
 *   dev_skip_liff?: boolean  // localhost 限定
 * }
 */
export async function POST(req: NextRequest) {
  // A-1: 認証（LIFF or サーバー署名 Cookie）
  let lineUserId = "";
  let body: any = null;

  try {
    // 一度だけ body を読む（以降は変数を再利用）
    body = body ?? (await req.json().catch(() => null));

    // --- 開発判定 ---
    const host = req.headers.get("host") || "";
    const isLocalHost =
      /^localhost(?::\d+)?$/.test(host) ||
      /^127\.0\.0\.1(?::\d+)?$/.test(host) ||
      /^\[::1\](?::\d+)?$/.test(host);

    const wantDevSkip = Boolean(body?.dev_skip_liff === true);
    if (isLocalHost && wantDevSkip) {
      lineUserId = "dev_local_user"; // 開発用ダミー
    }

    // 1) Authorization: Bearer ...（LIFF ID トークン）
    if (!lineUserId) {
      const auth = req.headers.get("authorization");
      if (auth) {
        lineUserId = await verifyLiffIdToken(auth);
      } else {
        const h2 = req.headers.get("x-liff-id-token");
        if (h2) lineUserId = await verifyLiffTokenString(h2);
      }
    }

    // 2) body.id_token / body.idToken（フォーム経由）
    if (!lineUserId) {
      const tokenInBody: string | undefined = body?.id_token || body?.idToken;
      if (tokenInBody)
        lineUserId = await verifyLiffTokenString(String(tokenInBody));
    }

    // 3) サーバー署名 HMAC セッション Cookie
    if (!lineUserId) {
      const secret =
        process.env.USER_SESSION_SECRET ||
        process.env.LINE_CHANNEL_SECRET ||
        "";
      if (secret) {
        const c = await cookies();
        const sess = verifySessionCookie(c.get(USER_COOKIE)?.value, secret);
        const sub = sess?.sub && String(sess.sub).trim();
        if (sub) lineUserId = sub;
      }
    }

    // 4) いずれも無ければ 401
    if (!lineUserId) {
      return NextResponse.json(
        {
          error: "unauthorized",
          detail: "Authorization ヘッダーか Bearer トークンが必要です",
        },
        { status: 401 }
      );
    }
  } catch (e: any) {
    return NextResponse.json(
      { error: "unauthorized", detail: e?.message || String(e) },
      { status: 401 }
    );
  }

  try {
    assertEnv();

    const { storeId, userEmail, lines, pickup, returnUrl } =
      body ?? (await req.json());

    if (!Array.isArray(lines) || lines.length === 0) {
      return NextResponse.json(
        { error: "line_items is empty" },
        { status: 400 }
      );
    }
    if (!returnUrl) {
      return NextResponse.json({ error: "missing returnUrl" }, { status: 400 });
    }

    // ── 金額/品目整形（必ず数値化） ──
    const currency = "jpy";
    const items = (lines as Array<any>).map((l) => ({
      id: String(l?.id ?? ""),
      name: String(l?.name ?? ""),
      qty: Math.max(0, Number(l?.qty) || 0),
      price: Math.max(0, Math.floor(Number(l?.price) || 0)),
    }));
    const total = items.reduce(
      (a, it) => a + (Number(it.price) || 0) * (Number(it.qty) || 0),
      0
    );
    const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = items
      .map((it) => ({
        quantity: it.qty,
        price_data: {
          currency,
          unit_amount: it.price,
          product_data: {
            name: it.name || "商品",
            metadata: { product_id: it.id },
          },
        },
      }))
      .filter((li) => (Number(li.quantity) || 0) > 0);

    // ─────────────────────────────────────────────────────
    // 1) プレオーダーを orders に作成（status=PENDING, payment_status=UNPAID）
    //    ※ スキーマ未定義の列は一切送らない（created_at / items_json / pickup_* など）
    // ─────────────────────────────────────────────────────
    const orderCode = genShortCode(6);

    const preorder: Record<string, any> = {
      store_id: String(storeId ?? ""),
      line_user_id: String(lineUserId ?? ""),
      status: "PENDING", // 引換前
      payment_status: "UNPAID",
      code: orderCode,
      total, // ← total_amount ではなく total
    };

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(preorder),
    });
    if (!insertRes.ok) {
      const txt = await insertRes.text().catch(() => "");
      console.error(
        "[create-checkout-session] pre-order insert failed:",
        insertRes.status,
        txt
      );
      return NextResponse.json(
        { error: "preorder-insert-failed", detail: txt },
        { status: 500 }
      );
    }
    const inserted = (await insertRes.json()) as Array<{
      id: string;
      code?: string;
    }>;
    const orderId = inserted?.[0]?.id;
    const orderShortCode = inserted?.[0]?.code || orderCode;
    if (!orderId) {
      return NextResponse.json(
        { error: "preorder-id-missing" },
        { status: 500 }
      );
    }

    // ─────────────────────────────────────────────────────
    // 2) Stripe セッション作成（order_id を Session/PI の両方に付与）
    // ─────────────────────────────────────────────────────
    // 既存顧客の再利用（任意）
    let customerId: string | undefined;
    if (userEmail) {
      try {
        const existing = await stripe.customers.list({
          email: userEmail,
          limit: 1,
        });
        if (existing.data.length > 0) customerId = existing.data[0].id;
        else
          customerId = (await stripe.customers.create({ email: userEmail })).id;
      } catch {
        // 顧客作成は必須ではないので握りつぶす
      }
    }

    const params: Stripe.Checkout.SessionCreateParams = {
      ui_mode: "embedded",
      mode: "payment",
      customer: customerId,
      payment_intent_data: {
        setup_future_usage: "off_session",
        metadata: {
          order_id: orderId, // ← PI 側 metadata（フォールバック）
          line_user_id: String(lineUserId ?? ""),
          store_id: String(storeId ?? ""),
        },
      },
      payment_method_types: ["card"],
      line_items,
      // 決済完了後の戻り先
      return_url: `${returnUrl}?session_id={CHECKOUT_SESSION_ID}`,
      // セッション側にも order_id を重複格納（Webhook が第一参照）
      metadata: {
        order_id: orderId, // ← セッション metadata（第一参照）
        store_id: String(storeId ?? ""),
        pickup_label: String(pickup ?? ""), // DB には送らず metadata のみ
        email: String(userEmail ?? ""),
        line_user_id: String(lineUserId ?? ""),
        // 冗長情報（任意）
        total_yen: String(total),
        items_json: JSON.stringify(items),
      },
      // ダッシュボードやUIでの突合を楽にする短い相関コード
      client_reference_id: orderShortCode,
    };

    const session = await stripe.checkout.sessions.create(params);

    return NextResponse.json(
      { client_secret: session.client_secret },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("[create-checkout-session] error:", err?.message || err);
    return NextResponse.json(
      { error: err?.message ?? "unknown" },
      { status: 400 }
    );
  }
}
