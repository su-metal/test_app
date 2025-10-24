// apps/user/src/app/api/line/webhook/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

/* =========================
   必要な環境変数（Vercel/Production）
   - LINE_CHANNEL_SECRET
   - LINE_CHANNEL_ACCESS_TOKEN
   - USER_LIFF_ID              例: 1651234567-abcd12（IDだけ。https://は付けない）
   - SUPABASE_URL              ← 未設定でも動作継続（保存はスキップ）
   - SUPABASE_SERVICE_ROLE_KEY ← 未設定でも動作継続（保存はスキップ）
   ========================= */

// ---- Supabase（未設定でも null を返す安全版）----
function getServiceClientOrNull() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn(
      "[LINE] Supabase env missing: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
    );
    return null;
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---- LIFF URL 正規化（必ず https://liff.line.me/<ID> 形式に）----
const RAW_USER_LIFF_ID = process.env.USER_LIFF_ID ?? "YOUR_LIFF_ID";
function makeLiffUrl(idOrUrl: string): string {
  let s = (idOrUrl || "").trim();
  s = s.replace(/^https?:\/\/[^/]+\/?/i, ""); // もしURLを入れていてもIDに戻す
  s = s.replace(/^liff\.line\.me\//i, "");
  s = s.replace(/^miniapp\.line\.me\//i, "");
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");
  return `https://liff.line.me/${s}`;
}
const USER_LIFF_URL = makeLiffUrl(RAW_USER_LIFF_ID);
const isValidLiffUrl = (u: string) =>
  /^https:\/\/liff\.line\.me\/[A-Za-z0-9\-_]+$/.test(u);

// ---- 署名検証 ----
function verifyLineSignature(rawBody: string, signature: string | null) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return false;
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");
  return !!signature && hmac === signature;
}

// ---- Messaging API: reply ----
async function lineReply(replyToken: string, messages: any[]) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) console.error("LINE reply failed", res.status, await res.text());
  return res.ok;
}

// ---- Webhook 本体（安全版）----
export async function POST(req: NextRequest) {
  // セーフモード：基本的に落とさない。なるべく 200 を返してLINEの再送ループを防ぐ。
  try {
    const rawBody = await req.text(); // ★ 1回だけ読む
    const signature = req.headers.get("x-line-signature");

    console.log("[LINE] len=", rawBody.length, "sig=", !!signature);

    if (!verifyLineSignature(rawBody, signature)) {
      console.warn("[LINE] invalid signature");
      // 安定運用後は 401 のままでOK。開発中に落ちるなら 200 にしてもよい。
      return new NextResponse("invalid signature", { status: 401 });
    }

    let body: any = null;
    try {
      body = rawBody ? JSON.parse(rawBody) : { events: [] };
    } catch (e: any) {
      console.error("[LINE] json parse error", e?.message || e);
      return NextResponse.json(
        { ok: false, reason: "json-parse-failed" },
        { status: 200 }
      );
    }

    console.log(
      "[LINE] events",
      (body.events ?? []).map((e: any) => ({
        type: e.type,
        source: e?.source?.type,
        userId: e?.source?.userId,
        msg: e?.message?.type,
      }))
    );

    const supa = getServiceClientOrNull();
    let collected = 0;
    let upserted = 0;

    for (const event of body.events ?? []) {
      // 任意イベントで userId を収集し upsert（冪等）
      const anyUserId: string | undefined = event?.source?.userId;
      if (anyUserId) {
        collected++;
        if (supa) {
          try {
            const { error } = await supa
              .from("line_users")
              .upsert({ line_user_id: anyUserId }, { onConflict: "line_user_id" });
            if (error) {
              console.error("[LINE webhook] upsert error", error?.message || error);
            } else {
              upserted++;
            }
          } catch (e: any) {
            console.error("[LINE webhook] upsert fatal", e?.message || e);
          }
        } else {
          console.warn("[LINE webhook] skip upsert: supabase env missing");
        }
      }
      // 友だち追加：userId 保存（Supabase未設定ならスキップ）
      if (event.type === "follow") {
        const lineUserId: string | undefined = event.source?.userId;
        if (lineUserId && supa) {
          const { error } = await supa
            .from("line_users")
            .upsert(
              { line_user_id: lineUserId },
              { onConflict: "line_user_id" }
            );
          if (error) console.error("Supabase upsert error", error);
          else console.log("[LINE] saved line_user_id:", lineUserId);
        } else if (lineUserId && !supa) {
          console.warn(
            "[LINE] skip save: Supabase client not available. lineUserId=",
            lineUserId
          );
        }

        const uri = isValidLiffUrl(USER_LIFF_URL)
          ? USER_LIFF_URL
          : "https://liff.line.me/YOUR_LIFF_ID"; // 念のためのフォールバック
        await lineReply(event.replyToken, [
          {
            type: "text",
            text: "ご登録ありがとうございます！下のボタンからミニアプリを開けます👇",
          },
          {
            type: "template",
            altText: "ミニアプリを開く",
            template: {
              type: "buttons",
              text: "ミニアプリを開く",
              actions: [{ type: "uri", label: "開く", uri }],
            },
          },
        ]);
      }

      // 動作テスト：メッセージで「ping」→「pong」
      if (event.type === "message" && event.message?.type === "text") {
        const txt = String(event.message.text || "")
          .trim()
          .toLowerCase();
        if (txt === "ping") {
          await lineReply(event.replyToken, [{ type: "text", text: "pong" }]);
        }
      }
    }

    return NextResponse.json({ ok: true, collected, upserted });
  } catch (e: any) {
    console.error("[LINE] fatal", e?.message || e);
    // 開発中は 200 にして再送ループを防いでもOK（安定後は500でも可）
    return NextResponse.json({ ok: false, reason: "fatal" }, { status: 200 });
  }
}

// GET は 405
export function GET() {
  return new NextResponse("Method Not Allowed", { status: 405 });
}
