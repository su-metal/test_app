import { NextResponse } from "next/server";

// 店舗切替は無効化（再ログインのみ許可）
export async function POST() {
  return new NextResponse("Method Not Allowed", { status: 405 });
}

export function GET() {
  return new NextResponse("Method Not Allowed", { status: 405 });
}

export const runtime = "nodejs";

