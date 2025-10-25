import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { cookies } from "next/headers";
import { COOKIE_NAME, verifySessionCookie } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    // 認可: セッション + 店舗一致
    const secret = process.env.STORE_SESSION_SECRET || process.env.ADMIN_DASHBOARD_SECRET || process.env.LINE_LOGIN_CHANNEL_SECRET || "";
    if (!secret) return NextResponse.json({ ok: false, error: "server-misconfig:secret" }, { status: 500 });
    const c = await cookies();
    const sess = verifySessionCookie(c.get(COOKIE_NAME)?.value, secret);
    if (!sess) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    const { productId, slot } = await req.json();
    if (!productId || !slot) {
      return NextResponse.json(
        { ok: false, error: "invalid_params" },
        { status: 400 }
      );
    }

    const admin = getSupabaseAdmin();
    // プロダクトの店舗一致確認
    const { data: prodOwner, error: prodErr } = await admin
      .from("products")
      .select("id, store_id")
      .eq("id", productId)
      .single();
    if (prodErr || !prodOwner) return NextResponse.json({ ok: false, error: "product_not_found" }, { status: 404 });
    const expectedStoreId = String(sess.store_id || "");
    if (!expectedStoreId) return NextResponse.json({ ok: false, error: "store_not_selected" }, { status: 400 });
    if (String((prodOwner as any).store_id || "") !== expectedStoreId) {
      return NextResponse.json({ ok: false, error: "membership-not-found" }, { status: 403 });
    }
    const baseDir = `products/${productId}`;

    // 削除対象の列名 + 互換列を null に
    const col =
      slot === "main"
        ? "main_image_path"
        : slot === "sub1"
        ? "sub_image_path1"
        : "sub_image_path2";

    // 既存ファイルの削除（同slotの命名規約ファイル）
    try {
      const list = await admin.storage
        .from("public-images")
        .list(baseDir, { limit: 1000 });
      const toDelete = (list.data || [])
        .filter(
          (it) =>
            it.name.startsWith(`${slot}_`) || it.name.includes(`_${slot}_`)
        )
        .map((it) => `${baseDir}/${it.name}`);
      if (toDelete.length > 0) {
        await admin.storage.from("public-images").remove(toDelete);
      }
    } catch {
      // noop
    }

    // DB クリア
    const upd = await admin
      .from("products")
      .update({ [col]: null })
      .eq("id", productId);
    if (upd.error) throw upd.error;

    // 追加の JSONB カラムに派生配列がある場合は該当slotを空配列に
    // TODO(req v2): スキーマ正式化: products.image_variants(jsonb)
    try {
      await admin
        .from("products")
        .update({ image_variants: { [slot]: [] } })
        .eq("id", productId);
    } catch {
      /* ignore */
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[images/delete] error", e);
    return NextResponse.json(
      { ok: false, error: String(e?.message || e) },
      { status: 500 }
    );
  }
}
