// apps/user/src/lib/line-push.ts
export type LineMessage = { type: "text"; text: string };

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;

export async function pushToLineUser(to: string, messages: LineMessage[]) {
  if (!CHANNEL_ACCESS_TOKEN)
    throw new Error("LINE_CHANNEL_ACCESS_TOKEN is missing");
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to, messages }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `LINE push failed: ${res.status} ${res.statusText} ${text}`
    );
  }
}
