export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { linePush } from "@/lib/line";

// TODO(req v2): 本処理は将来的に正式な通知サービス（キュー＋DLQ）へ移管する。

function getServiceClientOrNull() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn("[thank-completed] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return null;
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---- LIFF URL 正規化（必ず https://liff.line.me/<ID> 形式に）----
const RAW_USER_LIFF_ID = process.env.USER_LIFF_ID ?? "";
function makeLiffUrl(idOrUrl: string): string {
  let s = (idOrUrl || "").trim();
  s = s.replace(/^https?:\/\/[^/]+\/?/i, "");
  s = s.replace(/^liff\.line\.me\//i, "");
  s = s.replace(/^miniapp\.line\.me\//i, "");
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");
  return `https://liff.line.me/${s}`;
}
const USER_LIFF_URL = RAW_USER_LIFF_ID ? makeLiffUrl(RAW_USER_LIFF_ID) : null;

const COMPLETED_EQ = ["FULFILLED", "COMPLETED", "REDEEMED"] as const;

export async function POST(req: NextRequest) {
  // 任意の保護（Vercel Cron 等で叩く想定）
  const auth = req.headers.get("authorization") || "";
  const secret = process.env.CRON_SECRET || "";
  if (secret && auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (process.env.THANK_YOU_COMPLETED_ENABLED === "false") {
    return NextResponse.json({ ok: true, skipped: true, reason: "disabled" });
  }

  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    return NextResponse.json({ ok: true, skipped: true, reason: "no-line-token" });
  }

  const supa = getServiceClientOrNull();
  if (!supa) {
    return NextResponse.json({ ok: true, skipped: true, reason: "no-supabase" });
  }

  // 単純な排他（多重起動抑止）。失敗しても致命ではない。
  const lockKey = 922338; // 任意のキー
  try {
    const { data: locked, error: lockErr } = await (supa as any).rpc("pg_try_advisory_lock", { key: lockKey });
    if (lockErr || locked !== true) {
      return NextResponse.json({ ok: true, skipped: true, reason: "already-running" });
    }
  } catch (e) {
    // lock が使えない環境でも続行
    console.warn("[thank-completed] lock warn:", (e as any)?.message || e);
  }

  let picked = 0;
  let pushed = 0;
  let updated = 0;
  let skipped = 0;
  const failures: Array<{ id: string; reason: string }> = [];

  try {
    // 対象抽出: COMPLETED 相当 かつ 未通知
    const { data: orders, error } = await supa
      .from("orders")
      .select("id, status, line_user_id, auth_user_id")
      .in("status", COMPLETED_EQ as unknown as string[])
      .is("completed_notified_at", null)
      .limit(50);

    if (error) {
      console.error("[thank-completed] select error:", error.message || error);
      return NextResponse.json({ ok: false, error: "select-failed" }, { status: 500 });
    }

    picked = (orders?.length ?? 0);
    if (!orders || orders.length === 0) {
      return NextResponse.json({ ok: true, picked: 0, pushed: 0, updated: 0, skipped: 0 });
    }

    for (const o of orders) {
      const orderId: string = o.id;
      let toLineUserId: string | null = o.line_user_id ?? null;

      // フォールバック解決: orders.auth_user_id -> line_users.line_user_id がある場合
      if (!toLineUserId && o.auth_user_id) {
        try {
          const { data: lu, error: luErr } = await supa
            .from("line_users")
            .select("line_user_id")
            .eq("auth_user_id", o.auth_user_id)
            .limit(1)
            .maybeSingle();
          if (!luErr && lu?.line_user_id) toLineUserId = lu.line_user_id as any;
        } catch (e) {
          // カラム未存在などはスキップ
          console.warn("[thank-completed] resolve via auth_user_id skipped:", (e as any)?.message || e);
        }
      }

      if (!toLineUserId) {
        skipped++;
        failures.push({ id: orderId, reason: "no-destination" });
        continue;
      }

      // 送信メッセージ（日本語統一）
      const msgs: any[] = [
        { type: "text", text: "受け取りありがとうございました。ご利用に感謝いたします。" },
      ];
      if (USER_LIFF_URL) {
        msgs.push({
          type: "template",
          altText: "ミニアプリを開く",
          template: {
            type: "buttons",
            text: "次回のご注文はこちらから",
            actions: [{ type: "uri", label: "ミニアプリを開く", uri: USER_LIFF_URL }],
          },
        });
      }

      try {
        const ok = await linePush(toLineUserId, msgs);
        if (!ok) {
          failures.push({ id: orderId, reason: "push-failed" });
          continue;
        }
        pushed++;
      } catch (e) {
        failures.push({ id: orderId, reason: "push-exception" });
        continue;
      }

      // 成功時のみフラグ更新（冪等）
      const { error: updErr } = await supa
        .from("orders")
        .update({ completed_notified_at: new Date().toISOString() })
        .eq("id", orderId)
        .is("completed_notified_at", null);
      if (updErr) {
        console.error("[thank-completed] update failed", orderId, updErr.message);
      } else {
        updated++;
      }
    }

    return NextResponse.json({ ok: true, picked, pushed, updated, skipped, failures });
  } catch (e) {
    console.error("[thank-completed] fatal:", (e as any)?.message || e);
    return NextResponse.json({ ok: false, reason: "fatal" }, { status: 500 });
  } finally {
    try {
      await (supa as any).rpc("pg_advisory_unlock", { key: 922338 });
    } catch {
      /* noop */
    }
  }
}

export function GET() {
  return new NextResponse("Method Not Allowed", { status: 405 });
}

