// apps/user/middleware.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export const config = {
  matcher: "/:path*",
};

export default function middleware(req: NextRequest) {
  const res = NextResponse.next();

  const isProd =
    process.env.VERCEL_ENV === "production" ||
    process.env.NODE_ENV === "production";

  // ==== CSP ====
  // ここはあなたの環境に合わせて必要に応じて調整してください
  const SELF = "'self'";
  const stripeDomains = [
    "https://js.stripe.com",
    "https://*.stripe.com",
    "https://*.stripecdn.com",
    "https://checkout.stripe.com",
  ];
  const lineDomains = [
    "https://liff.line.me",
    "https://static.line-scdn.net",
    "https://api.line.me",
  ];
  const supabaseDomains = [
    // あなたの Supabase プロジェクト
    "https://dsrueuqshqdtkrprcjmc.supabase.co",
    "wss://dsrueuqshqdtkrprcjmc.supabase.co",
  ];
  const googleDomains = [
    "https://maps.googleapis.com",
    "https://maps.gstatic.com",
    "https://*.googleapis.com",
    "https://*.gstatic.com",
    "https://*.google.com",
  ];
  const hcaptchaDomains = ["https://*.hcaptcha.com", "https://hcaptcha.com"];

  // dev では Vercel の Live Reload 等が入るため script-src に 'unsafe-eval' を許容
  const scriptSrc = [
    SELF,
    "'unsafe-inline'",
    ...(isProd ? [] : ["'unsafe-eval'"]),
    ...stripeDomains,
    ...lineDomains,
    ...hcaptchaDomains,
  ];

  const connectSrc = [
    SELF,
    "blob:",
    ...supabaseDomains,
    ...stripeDomains,
    ...lineDomains,
    ...googleDomains,
    ...hcaptchaDomains,
  ];

  const imgSrc = [
    SELF,
    "data:",
    "blob:",
    ...stripeDomains,
    ...googleDomains,
    ...hcaptchaDomains,
  ];

  const styleSrc = [
    SELF,
    "'unsafe-inline'",
    "https://fonts.googleapis.com",
    ...lineDomains,
    ...hcaptchaDomains,
  ];

  const fontSrc = [SELF, "data:", "https://fonts.gstatic.com"];

  const frameSrc = [
    SELF,
    ...stripeDomains,
    ...hcaptchaDomains,
    ...lineDomains,
    "https://accounts.google.com",
    "https://*.google.com",
  ];

  const csp = [
    `default-src ${SELF}`,
    `script-src ${scriptSrc.join(" ")}`,
    `connect-src ${connectSrc.join(" ")}`,
    `img-src ${imgSrc.join(" ")}`,
    `style-src ${styleSrc.join(" ")}`,
    `font-src ${fontSrc.join(" ")}`,
    `frame-src ${frameSrc.join(" ")}`,
    `worker-src ${SELF} blob:`,
    `base-uri ${SELF}`,
    `frame-ancestors ${SELF}`,
    `form-action ${SELF} https://checkout.stripe.com`,
  ].join("; ");

  // 配布ヘッダ
  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "SAMEORIGIN");

  return res;
}
