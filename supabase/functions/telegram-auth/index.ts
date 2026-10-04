// Supabase Edge Function: telegram-auth
// ورود با تلگرام — هم «Telegram Login Widget» روی سایت، هم باز شدن سایت داخل تلگرام (Mini App).
// امضای داده‌ها با توکن ربات بررسی می‌شه، کاربر در Supabase ساخته/پیدا می‌شه
// و یک توکن یک‌بارمصرف برمی‌گرده که سایت باهاش نشست (session) می‌گیره.
//
// کار دوم: وقتی سایت داخل تلگرام بازه، شرکت‌کننده با یک دکمه شماره‌ی تلگرامش رو می‌فرسته (requestContact).
// این تابع امضای اون رو بررسی می‌کنه و با همون منطق «زدن شماره» (claim_student) به لیست وصلش می‌کنه.
//
// کار سوم: ربات. هر کس ربات رو Start کنه، پیام خوش‌آمد با دکمه‌ی «ورود به سایت» می‌گیره.
// تلگرام پیام‌های ربات رو به همین تابع می‌فرسته (webhook)؛ مدیر یک بار از تب «تنظیمات» سایت راه‌اندازیش می‌کنه.
//
// Secrets لازم (Edge Functions → Secrets):  TELEGRAM_BOT_TOKEN
// SUPABASE_URL، SUPABASE_ANON_KEY و SUPABASE_SERVICE_ROLE_KEY خودکار در دسترس‌اند.
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

// شماره‌ای که کاربر داخل Mini App با requestContact فرستاده: رشته‌ای به همون شکل initData
// (contact=…&auth_date=…&hash=…) که تلگرام با توکن ربات امضاش کرده.
type TgContact = { user_id: number; phone_number: string };
async function verifyContact(raw: string): Promise<TgContact | null> {
  const p = new URLSearchParams(raw);
  const hash = p.get("hash") ?? "";
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  // امضا مثل initData است؛ روش Login Widget هم امتحان می‌شه (هر دو فقط با توکن ربات ساخته می‌شن)
  const webApp = await hmac(enc.encode("WebAppData"), BOT_TOKEN);
  const widget = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(BOT_TOKEN)));
  if (!safeEqual(hex(await hmac(webApp, check)), hash) && !safeEqual(hex(await hmac(widget, check)), hash)) return null;
  if (!fresh(p.get("auth_date"))) return null;
  try {
    const c = JSON.parse(p.get("contact") ?? "null");
    return c && Number.isSafeInteger(Number(c.user_id)) && c.phone_number ? { user_id: Number(c.user_id), phone_number: String(c.phone_number) } : null;
  } catch { return null; }
}
// همون شکلی که لیست شرکت‌کننده‌ها ذخیره شده: 09xxxxxxxxx
function canonPhone(s: string): string | null {
  const m = /^(?:0098|98|0)?(9\d{9})$/.exec(s.replace(/\D/g, ""));
  return m ? "0" + m[1] : null;
}
// کاربرِ سایت که این درخواست رو فرستاده (از روی توکن نشستش)
async function caller(req: Request) {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data } = await admin.auth.getUser(jwt);
  return { jwt, user: data?.user ?? null };
}
async function linkByPhone(req: Request, raw: string): Promise<Response> {
  const { jwt, user } = await caller(req);
  const tgId = /^tg(\d+)@telegram\.local$/.exec(user?.email ?? "")?.[1];
  if (!tgId) return json({ error: "not_logged_in" }, 401);
  const contact = await verifyContact(raw);
  // فقط شماره‌ی خودِ همین حساب تلگرام قبوله، نه کارت تماس کس دیگه
  if (!contact || String(contact.user_id) !== tgId) return json({ error: "invalid_signature" }, 401);
  const phone = canonPhone(contact.phone_number);
  if (!phone) return json({ error: "not_found", phone: contact.phone_number });
  // اگه دستور SQL «ورود فقط با تلگرام» اجرا شده باشه، وصل کردن فقط از این مسیر ممکنه:
  // claim_verified_phone رو فقط همین تابع (با service role) می‌تونه صدا بزنه، و اولین نفرِ این شماره رو وصل می‌کنه.
  const verified = await admin.rpc("claim_verified_phone", { p_user: user!.id, p_phone: phone });
  if (!verified.error) return json({ ...(verified.data ?? {}), phone });
  if (!/PGRST202|42883|claim_verified_phone/.test(`${verified.error.code} ${verified.error.message}`)) {
    return json({ error: "claim_failed", detail: verified.error.message }, 500);
  }
  // اون دستور هنوز اجرا نشده: با همون claim_student، به‌عنوان خود کاربر
  const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data, error } = await asUser.rpc("claim_student", { p_no: phone, p_code: phone.slice(-4) });
  if (error) return json({ error: "claim_failed", detail: error.message }, 500);
  return json({ ...(data ?? {}), phone });
}

// ---------- ربات ----------
const OPEN_SITE = "ورود به سایت";
// رمز webhook از خود توکن ربات ساخته می‌شه، پس secret جدایی لازم نیست
const webhookSecret = async () => hex(await hmac(enc.encode(BOT_TOKEN), "telegram-webhook"));

// پیامی که تلگرام برای ربات می‌فرسته. جواب مستقیم در خود پاسخ webhook برمی‌گرده و تلگرام اجراش می‌کنه.
async function onTelegramUpdate(req: Request): Promise<Response> {
  if (!safeEqual(req.headers.get("x-telegram-bot-api-secret-token") ?? "", await webhookSecret())) return json({ error: "forbidden" }, 401);
  const site = new URL(req.url).searchParams.get("site") ?? "";
  let update: { message?: Record<string, any> };
  try { update = await req.json(); } catch { return new Response("ok"); }
  const msg = update.message;
  // فقط چت خصوصی؛ پیام «شماره» که دکمه‌ی تأیید شماره‌ی سایت می‌فرسته جواب نمی‌گیره
  if (!msg || msg.chat?.type !== "private" || msg.contact || !site.startsWith("https://")) return new Response("ok");
  const name = msg.from?.first_name ? ` ${msg.from.first_name}` : "";
  return json({
    method: "sendMessage",
    chat_id: msg.chat.id,
    text: `سلام${name}! 👋\nبرای دیدن مبلغ سهمت از جشن و فرستادن فیش واریز، دکمه‌ی «${OPEN_SITE}» رو بزن.`,
    reply_markup: { inline_keyboard: [[{ text: OPEN_SITE, web_app: { url: site } }]] },
  });
}

// راه‌اندازی یک‌باره توسط مدیر: تلگرام پیام‌های ربات رو به این تابع بفرسته، و دکمه‌ی منوی ربات همین سایت رو باز کنه.
// آدرس سایت از مرورگر مدیر میاد و داخل آدرس webhook نگه داشته می‌شه.
async function setupBot(req: Request, siteRaw: string): Promise<Response> {
  const { user } = await caller(req);
  if (!user) return json({ error: "not_logged_in" }, 401);
  const { data: me } = await admin.from("members").select("role").eq("user_id", user.id).maybeSingle();
  if (me?.role !== "admin") return json({ error: "not_admin" }, 403);
  let site: URL;
  try { site = new URL(siteRaw); } catch { return json({ error: "bad_site" }, 400); }
  if (site.protocol !== "https:") return json({ error: "bad_site" }, 400);
  site.hash = ""; site.search = "";
  const tg = async (method: string, params: unknown) => {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params),
    });
    return await r.json() as { ok: boolean; description?: string };
  };
  const hook = await tg("setWebhook", {
    url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-auth?site=${encodeURIComponent(site.href)}`,
    secret_token: await webhookSecret(), allowed_updates: ["message"], drop_pending_updates: true,
  });
  if (!hook.ok) return json({ error: "telegram_failed", detail: hook.description }, 502);
  const menu = await tg("setChatMenuButton", { menu_button: { type: "web_app", text: OPEN_SITE, web_app: { url: site.href } } });
  return json({ ok: true, site: site.href, menu: menu.ok, detail: menu.ok ? undefined : menu.description });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!BOT_TOKEN) return json({ error: "bot_token_missing" }, 500);
  if (req.headers.has("x-telegram-bot-api-secret-token")) return onTelegramUpdate(req);

  let body: { widget?: Record<string, unknown>; initData?: string; contact?: string; setup_bot?: boolean; site?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  if (typeof body.contact === "string") return linkByPhone(req, body.contact);
  if (body.setup_bot) return setupBot(req, String(body.site ?? ""));

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
