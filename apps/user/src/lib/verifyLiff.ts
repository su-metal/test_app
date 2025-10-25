// apps/user/src/lib/verifyLiff.ts
// LIFF/LINE Login の ID トークンをサーバー側で検証して sub(Line User ID) を返す
// TODO(req v2): nonce 検証や `amr` チェックの強化

import { createRemoteJWKSet, jwtVerify } from "jose";

const LINE_JWKS = createRemoteJWKSet(new URL("https://api.line.me/oauth2/v2.1/certs"));

export async function verifyLiffIdToken(authorizationHeader: string | null | undefined): Promise<string> {
  const header = authorizationHeader || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error("Authorization ヘッダーが Bearer 形式ではありません");
  const idToken = m[1].trim();
  return verifyLiffTokenString(idToken);
}

export async function verifyLiffTokenString(idToken: string): Promise<string> {
  if (!idToken) throw new Error("ID トークンが空です");

  const channelId = process.env.LINE_LOGIN_CHANNEL_ID || process.env.LINE_CHANNEL_ID || "";
  if (!channelId) throw new Error("サーバ設定不備: LINE チャネルIDが未設定です");

  const { payload } = await jwtVerify(idToken, LINE_JWKS, {
    issuer: "https://access.line.me",
    audience: channelId,
  });
  const sub = String(payload.sub || "").trim();
  if (!sub) throw new Error("ID トークン検証に失敗しました (sub なし)");
  return sub;
}

