// apps/user/src/app/api/stripe/create-checkout-session/route.ts
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { verifyLiffIdToken, verifyLiffTokenString } from "@/lib/verifyLiff";
import { cookies } from "next/headers";
import { COOKIE_NAME as USER_COOKIE, verifySessionCookie } from "@/lib/session";

export const runtime = "nodejs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function assertEnv() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("server-misconfig:supabase env missing");
  }
}

/**
 * 期待ボディ
 * {
 *   storeId?: string,
 *   userEmail?: string,
 *   lines: { id?: string; name: string; price: number; qty: number }[],
 *   pickup?: string,
 *   returnUrl: string,
 *   dev_skip_liff?: boolean
 * }
 */
export async function POST(req: NextRequest) {
  // ---- 認証（既存ロジックを踏襲）----
  let lineUserId = "";
  let body: any = null;

  try {
    body = body ?? (await req.json().catch(() => null));

    const host = req.headers.get("host") || "";
    const isLocalHost =
      /^localhost(?::\d+)?$/.test(host) ||
      /^127\.0\.0\.1(?::\d+)?$/.test(host) ||
      /^\[::1\](?::\d+)?$/.test(host);
    const wantDevSkip = Boolean(body?.dev_skip_liff === true);
    if (isLocalHost && wantDevSkip) {
      lineUserId = "dev_local_user";
    }

    if (!lineUserId) {
      const auth = req.headers.get("authorization");
      if (auth) {
        lineUserId = await verifyLiffIdToken(auth);
      } else {
        const h2 = req.headers.get("x-liff-id-token");
        if (h2) lineUserId = await verifyLiffTokenString(h2);
      }
    }

    if (!lineUserId) {
      const tokenInBody: string | undefined = body?.id_token || body?.idToken;
      if (tokenInBody)
        lineUserId = await verifyLiffTokenString(String(tokenInBody));
    }

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

    // ---- 金額/品目整形 ----
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

    // ---- 店舗名を stores.name から取得（後で orders.store_name と metadata に使用）----
    let storeName: string | undefined;
    if (storeId) {
      try {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/stores?id=eq.${encodeURIComponent(
            String(storeId)
          )}&select=name`,
          {
            headers: {
              apikey: SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            },
            cache: "no-store",
          }
        );
        if (r.ok) {
          const rows = (await r.json()) as Array<{ name?: string | null }>;
          const n = rows?.[0]?.name;
          if (n && typeof n === "string" && n.trim()) storeName = n.trim();
        }
      } catch {}
    }

    // ─────────────────────────────────────────────────────
    // 1) プレオーダー INSERT（DB側で code 採番）。store_name も orders に保存。
    // ─────────────────────────────────────────────────────
    const preorder: Record<string, any> = {
      store_id: String(storeId ?? ""),
      line_user_id: String(lineUserId ?? ""),
      status: "PENDING",
      payment_status: "UNPAID",
      total, // 列名は total
      ...(storeName ? { store_name: storeName } : {}),
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
        "[create-checkout-session] preorder insert failed:",
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
      code?: string | null;
    }>;
    const orderId = inserted?.[0]?.id;
    let orderCodeFromDb: string | undefined = inserted?.[0]?.code ?? undefined;
    if (!orderId) {
      return NextResponse.json(
        { error: "preorder-id-missing" },
        { status: 500 }
      );
    }

    // INSERT返りに code が無い設計のときは再取得で補完
    if (!orderCodeFromDb) {
      try {
        const getRes = await fetch(
          `${SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(
            orderId
          )}&select=code`,
          {
            headers: {
              apikey: SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            },
            cache: "no-store",
          }
        );
        if (getRes.ok) {
          const rows = (await getRes.json()) as Array<{ code?: string | null }>;
          const c = rows?.[0]?.code;
          if (typeof c === "string" && c.trim()) orderCodeFromDb = c.trim();
        }
      } catch {}
    }

    // ─────────────────────────────────────────────────────
    // 2) Stripe セッション作成（order_id を Session/PI の両方に付与）
    //    店舗名(store_name)と code は metadata にも載せる。client_reference_id は code が取れたときのみ。
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
      } catch {}
    }

    const params: Stripe.Checkout.SessionCreateParams = {
      ui_mode: "embedded",
      mode: "payment",
      customer: customerId,
      payment_intent_data: {
        setup_future_usage: "off_session",
        metadata: {
          order_id: orderId,
          line_user_id: String(lineUserId ?? ""),
          store_id: String(storeId ?? ""),
          ...(storeName ? { store_name: storeName } : {}),
          ...(orderCodeFromDb ? { code: orderCodeFromDb } : {}),
        },
      },
      payment_method_types: ["card"],
      line_items,
      return_url: `${returnUrl}?session_id={CHECKOUT_SESSION_ID}`,
      metadata: {
        order_id: orderId,
        store_id: String(storeId ?? ""),
        pickup_label: String(pickup ?? ""),
        email: String(userEmail ?? ""),
        line_user_id: String(lineUserId ?? ""),
        total_yen: String(total),
        ...(storeName ? { store_name: storeName } : {}),
        ...(orderCodeFromDb ? { code: orderCodeFromDb } : {}),
      },
      ...(orderCodeFromDb ? { client_reference_id: orderCodeFromDb } : {}),
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
