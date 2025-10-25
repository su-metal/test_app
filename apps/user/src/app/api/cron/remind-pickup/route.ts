export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * 受取リマインドを一時停止するための停止ルート。
 * - REMIND_PICKUP_ENABLED が "true" でない限り、即座にスキップ応答を返す。
 * - 認証（Authorization: Bearer <CRON_SECRET>）が設定されていればチェックする。
 * - 将来の再開時は環境変数だけで復活できる。
 */

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        {
          auth: { autoRefreshToken: false, persistSession: false },
        }
      )
    : null;

export async function POST(req: NextRequest) {
  // 0) 認証（任意・設定されていれば必須化）
  const auth = req.headers.get("authorization") || "";
  const secret = process.env.CRON_SECRET || "";
  if (secret && auth !== `Bearer ${secret}`) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 }
    );
  }

  // 1) フィーチャーフラグで完全停止（デフォルトOFF）
  if (process.env.REMIND_PICKUP_ENABLED !== "true") {
    return NextResponse.json({ ok: true, skipped: true, reason: "disabled" });
  }

  // --- ここから下は将来の再開用の雛形（現時点では通らない） -----------------

  // 同時実行防止ロック（任意：再開時に有効）
  if (supabase) {
    const { data: lock, error: lockErr } = await supabase.rpc(
      "pg_try_advisory_lock",
      {
        key: 922337, // 固定任意キー（プロジェクト内でユニークに）
      }
    );
    if (lockErr) {
      console.error("[cron] lock error:", lockErr.message);
      return NextResponse.json(
        { ok: false, reason: "lock-error" },
        { status: 200 }
      );
    }
    if (lock !== true) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "already-running",
      });
    }

    try {
      // 本来の処理（再開時に実装を戻す）
      return NextResponse.json({ ok: true, skipped: true, reason: "no-op" });
    } finally {
      try {
        await supabase.rpc("pg_advisory_unlock", { key: 922337 });
      } catch {
        /* noop */
      }
    }
  }

  // Supabase未設定時のフォールバック
  return NextResponse.json({ ok: true, skipped: true, reason: "no-supabase" });
}

export function GET() {
  return new NextResponse("Method Not Allowed", { status: 405 });
}
