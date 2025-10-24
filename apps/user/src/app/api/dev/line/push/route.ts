import { NextRequest, NextResponse } from "next/server";
import { linePush } from "@/lib/line";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  // 簡易ガード（実運用では認証/署名をつけてください）
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "disabled in production" },
      { status: 403 }
    );
  }
  const { to, text } = await req.json();
  if (!to || !text)
    return NextResponse.json({ error: "to/text required" }, { status: 400 });

  const ok = await linePush(to, [{ type: "text", text }]);
  return NextResponse.json({ ok });
}
