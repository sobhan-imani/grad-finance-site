// Supabase Edge Function: telegram-auth
// ورود با تلگرام — هم «Telegram Login Widget» روی سایت، هم باز شدن سایت داخل تلگرام (Mini App).
// امضای داده‌ها با توکن ربات بررسی می‌شه، کاربر در Supabase ساخته/پیدا می‌شه
// و یک توکن یک‌بارمصرف برمی‌گرده که سایت باهاش نشست (session) می‌گیره.
//
// Secrets لازم (Edge Functions → Secrets):  TELEGRAM_BOT_TOKEN
// SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY خودکار در دسترس‌اند.
// تنظیم مهم: «Verify JWT» / «Enforce JWT verification» برای این تابع خاموش باشه.

import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const enc = new TextEncoder();
async function hmac(key: Uint8Array, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const MAX_AGE = 24 * 60 * 60; // seconds
// «!(x <= MAX)» به‌جای «x > MAX» تا auth_date نامعتبر (NaN) هم رد بشه
const fresh = (authDate: unknown) => Date.now() / 1000 - Number(authDate) <= MAX_AGE;

type TgUser = { id: number; first_name?: string; last_name?: string; username?: string; photo_url?: string };

// https://core.telegram.org/widgets/login#checking-authorization
async function verifyWidget(data: Record<string, unknown>): Promise<TgUser | null> {
  const hash = String(data.hash ?? "");
  const check = Object.keys(data).filter((k) => k !== "hash" && data[k] !== undefined && data[k] !== null)
    .sort().map((k) => `${k}=${data[k]}`).join("\n");
  const secret = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(BOT_TOKEN)));
  if (!safeEqual(hex(await hmac(secret, check)), hash)) return null;
  if (!fresh(data.auth_date)) return null;
  return { id: Number(data.id), first_name: data.first_name as string, last_name: data.last_name as string,
           username: data.username as string, photo_url: data.photo_url as string };
}

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
async function verifyInitData(initData: string): Promise<TgUser | null> {
  const p = new URLSearchParams(initData);
  const hash = p.get("hash") ?? "";
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(enc.encode("WebAppData"), BOT_TOKEN);
  if (!safeEqual(hex(await hmac(secret, check)), hash)) return null;
  if (!fresh(p.get("auth_date"))) return null;
  try { return JSON.parse(p.get("user") ?? "null"); } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!BOT_TOKEN) return json({ error: "bot_token_missing" }, 500);

  let body: { widget?: Record<string, unknown>; initData?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const tg = body.initData ? await verifyInitData(body.initData)
           : body.widget ? await verifyWidget(body.widget) : null;
  if (!tg || !Number.isSafeInteger(tg.id) || tg.id <= 0) return json({ error: "invalid_signature" }, 401);

  const email = `tg${tg.id}@telegram.local`;
  const meta = { telegram_id: String(tg.id), first_name: tg.first_name ?? "", last_name: tg.last_name ?? "",
                 username: tg.username ?? "", photo_url: tg.photo_url ?? "" };

  // اولین ورود: ساخت کاربر (تریگر دیتابیس اون رو با نقش pending به members اضافه می‌کنه)
  const created = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: meta });
  const exists = created.error && ((created.error as { code?: string }).code === "email_exists" ||
    /already|exists|registered/i.test(created.error.message));
  if (created.error && !exists) {
    return json({ error: "create_failed", detail: created.error.message }, 500);
  }

  // توکن یک‌بارمصرف برای گرفتن نشست در مرورگر (ایمیلی ارسال نمی‌شه)
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (link.error || !link.data?.properties?.hashed_token) {
    return json({ error: "link_failed", detail: link.error?.message }, 500);
  }

  // به‌روزرسانی نام کاربری تلگرام (نام نمایشی رو دست نمی‌زنیم؛ مدیر ممکنه عوضش کرده باشه)
  await admin.from("members").update({ telegram_username: tg.username ?? null, telegram_id: tg.id })
    .eq("user_id", link.data.user.id);

  return json({ token_hash: link.data.properties.hashed_token });
});
