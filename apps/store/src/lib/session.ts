import crypto from "crypto";

const COOKIE_NAME = "store_session";

type SessionPayload = {
  sub: string; // LINE user id
  iat: number; // issued at (epoch seconds)
  // 店舗ID（選択中）: マルチ店舗運用のためセッションに保持
  // TODO(req v2): 複数店舗メンバー権限やロールも含めたクレーム設計に拡張
  store_id?: string;
};

function b64u(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function hmacSign(data: string, secret: string): string {
  return b64u(require("crypto").createHmac("sha256", secret).update(data).digest());
}

export function issueSessionCookie(sub: string, secret: string, store_id?: string): string {
  const payload: SessionPayload = { sub, iat: Math.floor(Date.now() / 1000), store_id };
  const body = b64u(JSON.stringify(payload));
  const sig = hmacSign(body, secret);
  return `${body}.${sig}`;
}

export function verifySessionCookie(cookie: string | undefined, secret: string): SessionPayload | null {
  if (!cookie) return null;
  const [body, sig] = cookie.split(".");
  if (!body || !sig) return null;
  const expected = hmacSign(body, secret);
  if (!require("crypto").timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const decoded = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    if (!decoded || typeof decoded.sub !== "string") return null;
    // store_id は任意。文字列なら通す。
    if (decoded.store_id != null && typeof decoded.store_id !== "string") decoded.store_id = String(decoded.store_id);
    return decoded as SessionPayload;
  } catch {
    return null;
  }
}

export { COOKIE_NAME };

