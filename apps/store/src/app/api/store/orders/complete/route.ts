// apps/store/src/app/api/store/orders/complete/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { COOKIE_NAME, verifySessionCookie } from "@/lib/session";

// NOTE: 既存の push ユーティリティ（apps/user/src/lib/line.ts）は
// クロスワークスペース参照を避けるため、最小実装をここに複製します。
async function linePush(toUserId: string, messages: any[]) {
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to: toUserId, messages }),
  });
  if (!r.ok) {
    console.error("[complete] linePush error", r.status, await r.text());
  }
  return r.ok;
}

// LIFF URL 正規化（ID/URLいずれでも受け取り、 https://liff.line.me/<ID> に揃える）
function makeLiffUrl(idOrUrl: string | null | undefined): string | null {
  const raw = (idOrUrl || "").trim();
  if (!raw) return null;
  let s = raw.replace(/^https?:\/\/[^/]+\/?/i, "");
  s = s.replace(/^liff\.line\.me\//i, "");
  s = s.replace(/^miniapp\.line\.me\//i, "");
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");
  return `https://liff.line.me/${s}`;
}

type Body = { orderId?: string };

export async function POST(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const expectedStoreId = process.env.NEXT_PUBLIC_STORE_ID;
  const liffUrl = makeLiffUrl(process.env.USER_LIFF_ID);
  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const secret = process.env.ADMIN_DASHBOARD_SECRET || process.env.LINE_LOGIN_CHANNEL_SECRET || "";

  if (!url || !serviceKey) {
    return NextResponse.json({ ok: false, error: "server-misconfig:supabase" }, { status: 500 });
  }
  if (!expectedStoreId) {
    return NextResponse.json({ ok: false, error: "server-misconfig:store" }, { status: 500 });
  }
  if (!lineToken) {
    return NextResponse.json({ ok: false, error: "server-misconfig:line-token" }, { status: 500 });
  }
  if (!secret) {
    return NextResponse.json({ ok: false, error: "server-misconfig:secret" }, { status: 500 });
  }

  // 認可（セッションクッキー）
  try {
    const cookieStore = await cookies();
    const sess = verifySessionCookie(cookieStore.get(COOKIE_NAME)?.value, secret);
    if (!sess) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  } catch {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: Body | null = null;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid-json" }, { status: 400 });
  }

  const orderId = String(body?.orderId || "").trim();
  if (!orderId) {
    return NextResponse.json({ ok: false, error: "ORDER_ID_REQUIRED" }, { status: 400 });
  }

  const supa = createClient(url, serviceKey);

  // 1) 対象注文の取得 + 店舗一致チェック
  const { data: order, error: selErr } = await supa
    .from("orders")
    .select("id, store_id, status, line_user_id, completed_notified_at")
    .eq("id", orderId)
    .single();
  if (selErr) {
    return NextResponse.json({ ok: false, error: "ORDER_NOT_FOUND" }, { status: 404 });
  }
  if (String((order as any).store_id || "") !== expectedStoreId) {
    return NextResponse.json({ ok: false, error: "forbidden:store-mismatch" }, { status: 403 });
  }

  // 2) ステータスを COMPLETED に更新（冪等: 既に COMPLETED/REDEEMED/FULFILLED でもOK）
  //    UI 表記は FULFILLED として扱う実装だが、要件書の COMPLETED に寄せる。
  const { error: upErr } = await supa
    .from("orders")
    .update({ status: "COMPLETED" })
    .eq("id", orderId)
    .eq("store_id", expectedStoreId);
  if (upErr) {
    return NextResponse.json({ ok: false, error: "UPDATE_FAILED", detail: upErr.message }, { status: 500 });
  }

  // 3) 冪等: すでに通知済みなら Push せずに終了
  if ((order as any).completed_notified_at) {
    return NextResponse.json({ ok: true, pushed: 0, updated: 0, skipped: 1, reason: "already-notified" });
  }

  // 4) 宛先解決（orders.line_user_id のみ。TODO(req v2): auth_user_id 経由の解決を追加）
  const toLineUserId: string | null = (order as any).line_user_id || null;
  if (!toLineUserId) {
    return NextResponse.json({ ok: true, pushed: 0, updated: 0, skipped: 1, reason: "no-destination" });
  }

  // 5) LINE Push（日本語 + LIFFボタン）
  const messages: any[] = [
    { type: "text", text: "受け取りありがとうございました。ご利用に感謝いたします。" },
  ];
  if (liffUrl) {
    messages.push({
      type: "template",
      altText: "ミニアプリを開く",
      template: {
        type: "buttons",
        text: "次回のご注文はこちらから",
        actions: [{ type: "uri", label: "ミニアプリを開く", uri: liffUrl }],
      },
    });
  }

  const sent = await linePush(toLineUserId, messages);
  if (!sent) {
    return NextResponse.json({ ok: false, error: "PUSH_FAILED" }, { status: 502 });
  }

  // 6) フラグ更新（冪等: NULL のときだけ上書き）
  const { error: flagErr } = await supa
    .from("orders")
    .update({ completed_notified_at: new Date().toISOString() })
    .eq("id", orderId)
    .eq("store_id", expectedStoreId)
    .is("completed_notified_at", null);
  if (flagErr) {
    // 送信は成功しているため 200 で返しつつ、ログのみ残す
    console.error("[complete] flag update failed:", flagErr.message);
  }

  return NextResponse.json({ ok: true, pushed: 1, updated: 1, skipped: 0, orderId });
}

export function GET() {
  return new NextResponse("Method Not Allowed", { status: 405 });
}

