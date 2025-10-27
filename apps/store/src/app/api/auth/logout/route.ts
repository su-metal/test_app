import { NextResponse } from "next/server";

export async function POST() {
  // 有効期限切れで store_session を無効化（httpOnly）
  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: "store_session",
    value: "",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    expires: new Date(0), // 1970 にして無効化
  });
  return res;
}
