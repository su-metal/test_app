// apps/user/src/lib/line.ts
const API = "https://api.line.me/v2/bot";

export async function linePush(toUserId: string, messages: any[]) {
  const r = await fetch(`${API}/message/push`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to: toUserId, messages }),
  });
  if (!r.ok) {
    console.error("linePush error", r.status, await r.text());
  }
  return r.ok;
}
