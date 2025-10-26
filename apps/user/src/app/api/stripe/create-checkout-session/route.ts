// apps/user/src/app/api/stripe/create-checkout-session/route.ts
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { verifyLiffIdToken, verifyLiffTokenString } from "@/lib/verifyLiff";
import { cookies } from "next/headers";
import { COOKIE_NAME as USER_COOKIE, verifySessionCookie } from "@/lib/session";

export const runtime = "nodejs"; // Stripe は Node 実行

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

/**
 * 期待ボディ
 * {
 *   storeId?: string,
 *   userEmail?: string,
 *   lines: { id?: string; name: string; price: number; qty: number }[],
 *   pickup?: string,
 *   returnUrl: string
 * }
 */
export async function POST(req: NextRequest) {
  // A-1: 認証（LIFF or サーバー署名 Cookie）
  let lineUserId = "";
  let body: any = null;
  try {
    // --- 開発判定 ---
    const host = req.headers.get("host") || "";
    const isLocalHost =
      /^localhost(?::\d+)?$/.test(host) ||
      /^127\.0\.0\.1(?::\d+)?$/.test(host) ||
      /^\[::1\](?::\d+)?$/.test(host);

    // --- 認証（順に試す） ---
    // 0) localhost + dev_skip_liff=true の明示時はスキップ
    //    ※ 一度だけ body を読み、以降は変数を再利用
    body = body ?? (await req.json().catch(() => null));
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

    // 4) それでも無ければ 401（ただし localhost + dev_skip_liff のときは通過済み）
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
    const { storeId, userEmail, lines, pickup, returnUrl } =
      body ?? (await req.json());

    if (!Array.isArray(lines) || lines.length === 0) {
      return NextResponse.json(
        { error: "line_items is empty" },
        { status: 400 }
      );
    }

    const currency = "jpy";
    const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = (
      lines as Array<any>
    )
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

    // 環境チェック（匿名キーは fulfill でも使用）
    const API_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    if (!API_URL || !ANON) {
      return NextResponse.json(
        { error: "server-misconfig:supabase" },
        { status: 500 }
      );
    }

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

    function parsePickupLabelToJstIsoRange(label?: string): {
      start?: string;
      end?: string;
    } {
      // ラベル中の最初の2つの「HH:MM」を抽出してISO(+09:00)へ変換
      // TODO(req v2): 受取スロットの構造化引き渡しに移行（ラベル依存を排除）
      const text = String(label || "").trim();
      if (!text) return {};
      const times = text.match(/\b(\d{1,2}:\d{2})\b/g);
      if (!times || times.length < 2) return {};
      const [a, b] = times;
      const pad = (s: string) => (s.length === 1 ? `0${s}` : s);
      const toIso = (hhmm: string) => {
        const [hh, mm] = hhmm.split(":");
        const parts = new Intl.DateTimeFormat("ja-JP", {
          timeZone: "Asia/Tokyo",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).formatToParts(new Date());
        const y = parts.find((p) => p.type === "year")?.value ?? "1970";
        const mo = parts.find((p) => p.type === "month")?.value ?? "01";
        const d = parts.find((p) => p.type === "day")?.value ?? "01";
        return `${y}-${mo}-${d}T${pad(hh)}:${pad(mm)}:00+09:00`;
      };
      return { start: toIso(a), end: toIso(b) };
    }
    // ここでは使用しないが、将来の要件でmetadataをISOで持つ場合に備える
    const pick = parsePickupLabelToJstIsoRange(String(pickup || ""));

    // 事前INSERTは行わない。支払い完了後(fulfill)にのみDBへINSERTする。
    // 必要データは Session/PI の metadata に格納する。

    // -------- 1) Customer 取得または作成（任意） --------
    let customerId: string | undefined;
    if (userEmail) {
      const existing = await stripe.customers.list({
        email: userEmail,
        limit: 1,
      });
      if (existing.data.length > 0) customerId = existing.data[0].id;
      else
        customerId = (await stripe.customers.create({ email: userEmail })).id;
    }

    // -------- 2) セッション作成（支払いフローのみ） --------
    const params: Stripe.Checkout.SessionCreateParams = {
      ui_mode: "embedded",
      mode: "payment",
      customer: customerId,
      payment_intent_data: {
        setup_future_usage: "off_session",
        // fulfill 側の補助参照用
        metadata: {
          line_user_id: String(lineUserId ?? ""),
        },
      },
      payment_method_types: ["card"],
      line_items,
      return_url: `${returnUrl}?session_id={CHECKOUT_SESSION_ID}`,
      metadata: {
        // 決済完了後に INSERT するための情報を持たせる
        store_id: String(storeId ?? ""),
        pickup_label: String(pickup ?? ""),
        items_json: JSON.stringify(items),
        email: String(userEmail ?? ""),
        line_user_id: String(lineUserId ?? ""),
        // TODO(req v2): ラベルではなく構造化した start/end または slot_no を渡す
        // start_iso: pick.start, end_iso: pick.end,
        total_yen: String(total),
      },
      // client_reference_id は事前注文がないため未設定
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
