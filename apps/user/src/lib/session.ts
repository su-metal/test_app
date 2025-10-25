import crypto from "crypto";

export const COOKIE_NAME = "user_session";

type SessionPayload = {
  sub: string; // LINE user id (U...)
  iat: number; // epoch seconds
};

function b64u(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function hmacSign(data: string, secret: string): string {
  return b64u(crypto.createHmac("sha256", secret).update(data).digest());
}

export function issueSessionCookie(sub: string, secret: string): string {
  const payload: SessionPayload = { sub, iat: Math.floor(Date.now() / 1000) };
  const body = b64u(JSON.stringify(payload));
  const sig = hmacSign(body, secret);
  return `${body}.${sig}`;
}

export function verifySessionCookie(cookie: string | undefined, secret: string): SessionPayload | null {
  if (!cookie) return null;
  const [body, sig] = cookie.split(".");
  if (!body || !sig) return null;
  const expected = hmacSign(body, secret);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch { return null; }
  try {
    const decoded = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    if (!decoded || typeof decoded.sub !== "string") return null;
    return decoded as SessionPayload;
  } catch { return null; }
}

