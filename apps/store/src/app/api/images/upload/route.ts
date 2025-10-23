import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { randomUUID } from "crypto";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

// ---- Next.js Route config ----
export const runtime = "nodejs"; // これは許可された export

const BUCKET = "public-images";

// 生成する幅（px）— ★ここは export しない

const PRESETS = [320, 480, 640, 960, 1280] as const;
type PresetWidth = (typeof PRESETS)[number];

type Variant = {
  width: number;
  path: string;
  url?: string;
};

function assertPreset(w: number): asserts w is PresetWidth {
  if (!PRESETS.includes(w as any)) {
    throw new Error(`invalid preset width: ${w}`);
  }
}

function pathOf(productId: string, slot: string, w: number, uuid: string) {
  return `products/${productId}/${uuid}_${slot}_${w}.webp`;
}

// ---- Only handler exports are allowed ----
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const productId = String(form.get("productId") || "");
    const slot = String(form.get("slot") || "main");
    const file = form.get("file") as File | null;

    if (!productId) {
      return NextResponse.json(
        { ok: false, error: "productId is required" },
        { status: 400 }
      );
    }
    if (!file) {
      return NextResponse.json(
        { ok: false, error: "file is required" },
        { status: 400 }
      );
    }

    const mime = file.type || "application/octet-stream";
    if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(mime)) {
      return NextResponse.json(
        { ok: false, error: `unsupported content-type: ${mime}` },
        { status: 400 }
      );
    }

    const uuid = randomUUID();
    const input = Buffer.from(await file.arrayBuffer());

    // 画像パイプライン（自動回転）
    const base = sharp(input, {
      failOn: "none",
      animated: mime.endsWith("gif"),
    }).rotate();
    const meta = await base.metadata();
    const origWidth = meta.width ?? 0;

    // 元画像より大きいプリセットは省く（幅不明なら最小だけ作る）
    const targets: PresetWidth[] = PRESETS.filter(
      (w) => w <= origWidth || origWidth === 0
    ) as PresetWidth[];
    if (targets.length === 0) targets.push(PRESETS[0] as PresetWidth);

    const supabase = getSupabaseAdmin();
    const variants: Variant[] = [];

    for (const w of targets) {
      assertPreset(w);

      const buf = await base
        .clone()
        .resize({ width: w, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82, effort: 5 })
        .toBuffer();

      const path = pathOf(productId, slot, w, uuid);
      const up = await supabase.storage.from(BUCKET).upload(path, buf, {
        contentType: "image/webp",
        upsert: true,
      });
      if (up.error) throw up.error;

      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
      variants.push({ width: w, path, url: pub.publicUrl });
    }

    const biggest = variants.reduce((a, b) => (a.width > b.width ? a : b));

    // （任意）DBに保存（存在しない場合は握りつぶす）
    try {
      const variantsJson = variants.map((v) => ({
        width: v.width,
        path: v.path,
        url: v.url,
      }));
      await supabase
        .from("products")
        .update({ image_variants: variantsJson })
        .eq("id", productId);
    } catch {}

    return NextResponse.json({ ok: true, path: biggest.path, variants });
  } catch (e: any) {
    console.error("[images/upload] error", e);
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e) },
      { status: 500 }
    );
  }
}
