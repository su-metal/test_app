import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { getSupabaseAdmin } from "@/src/lib/supabaseAdmin";

// サイズプリセットと命名サフィックス
const PRESETS = [320, 480, 640, 960, 1280] as const;
type Variant = { width: number; path: string; url?: string };

// ファイル名は products/{productId}/{uuid}_{slot}_{w}.webp
function pathOf(productId: string, slot: string, w: number, uuid: string): string {
  return `products/${productId}/${uuid}_${slot}_${w}.webp`;
}

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const productId = String(form.get("productId") || "");
    const slot = String(form.get("slot") || "");
    const file = form.get("file") as File | null;

    if (!productId || !slot || !file) {
      return NextResponse.json({ ok: false, error: "invalid_params" }, { status: 400 });
    }

    const arrayBuf = await file.arrayBuffer();
    const input = Buffer.from(arrayBuf);

    // 入力画像のメタデータを取得
    const img = sharp(input, { failOnError: false });
    const meta = await img.metadata();
    const srcW = meta.width ?? 0;
    const srcH = meta.height ?? 0;
    if (!srcW || !srcH) {
      return NextResponse.json({ ok: false, error: "invalid_image" }, { status: 400 });
    }

    // アップスケール禁止 + 最大辺 1280px 上限
    const maxEdge = 1280;
    const effectiveMax = Math.min(maxEdge, Math.max(srcW, srcH));
    const targets = PRESETS.filter((w) => w <= effectiveMax);
    if (targets.length === 0) targets.push(Math.min(320, effectiveMax));

    const admin = getSupabaseAdmin();
    const uuid = (globalThis.crypto?.randomUUID?.() || require("crypto").randomUUID());

    // 既存の同slotファイルをクリーンアップ（prefix一致）
    try {
      const baseDir = `products/${productId}`;
      const list = await admin.storage.from("public-images").list(baseDir, { limit: 1000 });
      const toDelete = (list.data || [])
        .filter((it) => it.name.startsWith(`${slot}_`) || it.name.includes(`_${slot}_`))
        .map((it) => `${baseDir}/${it.name}`);
      if (toDelete.length > 0) {
        await admin.storage.from("public-images").remove(toDelete);
      }
    } catch {
      // noop: 権限や0件時は無視
    }

    // 各サイズを生成してアップロード
    const variants: Variant[] = [];
    for (const w of targets) {
      const resized = await sharp(input, { failOnError: false })
        .rotate() // EXIF 補正、メタデータは保持しない（除去）
        .resize({ width: w, withoutEnlargement: true, fit: "inside" })
        .webp({ quality: 82, alphaQuality: 90 })
        .toBuffer();

      const path = pathOf(productId, slot, w, uuid);
      const up = await admin.storage.from("public-images").upload(path, resized, {
        contentType: "image/webp",
        cacheControl: "31536000, immutable",
        upsert: true,
      });
      if (up.error) throw up.error;
      variants.push({ width: w, path });
    }

    // DB 更新: 既存の互換カラム（*_image_path）を最大幅のものに更新
    const biggest = variants.reduce((a, b) => (a.width >= b.width ? a : b));
    const col = slot === "main" ? "main_image_path"
      : slot === "sub1" ? "sub_image_path1" : "sub_image_path2";
    const upd = await admin.from("products").update({ [col]: biggest.path }).eq("id", productId);
    if (upd.error) throw upd.error;

    // 追加の JSONB カラムに派生配列を保存（存在しなければ無視）
    // TODO(req v2): スキーマ正式化: products.image_variants(jsonb)
    try {
      const variantsJson = { [slot]: variants.map((v) => ({ width: v.width, path: v.path })) };
      await admin.from("products").update({ image_variants: variantsJson }).eq("id", productId);
    } catch {
      // カラム未作成などは無視
    }

    return NextResponse.json({ ok: true, path: biggest.path, variants });
  } catch (e: any) {
    console.error("[images/upload] error", e);
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}

