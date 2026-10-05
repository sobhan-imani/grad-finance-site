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
// متن پیام خوش‌آمد رو مدیر از سایت عوض می‌کنه، و از همون‌جا می‌تونه برای همه‌ی کسایی که ربات رو Start کردن پیام بفرسته.
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
  // همون کلید عمومی که خود سایت می‌فرسته (anon یا publishable)
  const apikey = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY")!;
  return { jwt, apikey, user: data?.user ?? null };
}
// کلاینتی که مثل خود کاربر به دیتابیس وصل می‌شه (با همون قوانین RLS و دسترسی‌هایی که سایت داره)
const asUser = ({ jwt, apikey }: { jwt: string; apikey: string }) => createClient(Deno.env.get("SUPABASE_URL")!, apikey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${jwt}` } },
});
async function linkByPhone(req: Request, raw: string): Promise<Response> {
  const who = await caller(req), user = who.user;
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
  const { data, error } = await asUser(who).rpc("claim_student", { p_no: phone, p_code: phone.slice(-4) });
  if (error) return json({ error: "claim_failed", detail: error.message }, 500);
  return json({ ...(data ?? {}), phone });
}

// ---------- ربات ----------
const OPEN_SITE = "ورود به سایت";
// اگه مدیر متنی ننوشته باشه. {name} جای اسم کوچیک طرف قرار می‌گیره.
const DEFAULT_WELCOME = `سلام {name}! 👋\nبرای دیدن مبلغ سهمت از جشن و فرستادن فیش واریز، دکمه‌ی «${OPEN_SITE}» رو بزن.`;
// رمز webhook از خود توکن ربات ساخته می‌شه، پس secret جدایی لازم نیست
const webhookSecret = async () => hex(await hmac(enc.encode(BOT_TOKEN), "telegram-webhook"));

type TgResult = { ok: boolean; description?: string; error_code?: number; parameters?: { retry_after?: number } };
async function tg(method: string, params: unknown): Promise<TgResult> {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params),
  });
  return await r.json() as TgResult;
}
// {name} → اسم کوچیک؛ بدون اسم، فاصله‌ی قبلش هم برداشته می‌شه («سلام {name}!» → «سلام!»)
const fillName = (text: string, name: string) =>
  text.replace(/( ?)\{name\}/g, (_m, sp: string) => (name ? sp + name : ""));
const siteButton = (site: string) => ({ inline_keyboard: [[{ text: OPEN_SITE, web_app: { url: site } }]] });

// هر کس به ربات پیام بده، برای پیام‌های همگانی نگه داشته می‌شه (اگه قبلاً ربات رو بلاک کرده بود، دوباره فعال حساب می‌شه).
// جدول‌های ربات رو دستور SQL «ربات» می‌سازه؛ تا اجرا نشده، ربات مثل قبل فقط جواب می‌ده.
async function rememberBotUser(from: Record<string, any> | undefined) {
  if (!from?.id || from.is_bot) return;
  try {
    await admin.from("bot_users").upsert({
      telegram_id: from.id, first_name: from.first_name ?? "", username: from.username ?? null,
      last_seen_at: new Date().toISOString(), blocked: false,
    }, { onConflict: "telegram_id" });
  } catch { /* table missing or unreachable: the reply still goes out */ }
}
async function welcomeText(): Promise<string> {
  try {
    const { data } = await admin.from("bot_settings").select("welcome_text").eq("id", 1).maybeSingle();
    return String(data?.welcome_text ?? "").trim() || DEFAULT_WELCOME;
  } catch { return DEFAULT_WELCOME; }
}

// پیامی که تلگرام برای ربات می‌فرسته. جواب مستقیم در خود پاسخ webhook برمی‌گرده و تلگرام اجراش می‌کنه.
async function onTelegramUpdate(req: Request): Promise<Response> {
  if (!safeEqual(req.headers.get("x-telegram-bot-api-secret-token") ?? "", await webhookSecret())) return json({ error: "forbidden" }, 401);
  const site = new URL(req.url).searchParams.get("site") ?? "";
  let update: { message?: Record<string, any> };
  try { update = await req.json(); } catch { return new Response("ok"); }
  const msg = update.message;
  if (!msg || msg.chat?.type !== "private") return new Response("ok");
  // پیام «شماره» که دکمه‌ی تأیید شماره‌ی سایت می‌فرسته جواب نمی‌گیره، ولی فرستنده‌ش هم ربات رو Start کرده
  const [, text] = await Promise.all([rememberBotUser(msg.from), msg.contact ? "" : welcomeText()]);
  if (msg.contact || !site.startsWith("https://")) return new Response("ok");
  return json({
    method: "sendMessage",
    chat_id: msg.chat.id,
    text: fillName(text, String(msg.from?.first_name ?? "")),
    reply_markup: siteButton(site),
  });
}

// فقط مدیر. نقش رو مثل خود سایت (با نشست خود کاربر) می‌خونیم؛ دسترسی service role به جدول members لازم نیست.
async function requireAdmin(req: Request) {
  const who = await caller(req);
  if (!who.user) return { res: json({ error: "not_logged_in" }, 401) };
  const { data: me, error } = await asUser(who).from("members").select("role, telegram_id").eq("user_id", who.user.id).maybeSingle();
  if (error) return { res: json({ error: "role_check_failed", detail: error.message }, 500) };
  if (me?.role !== "admin") return { res: json({ error: "not_admin", role: me?.role ?? null }, 403) };
  return { who, me };
}
function httpsSite(raw: unknown): string | null {
  try {
    const site = new URL(String(raw ?? ""));
    if (site.protocol !== "https:") return null;
    site.hash = ""; site.search = "";
    return site.href;
  } catch { return null; }
}

// راه‌اندازی یک‌باره توسط مدیر: تلگرام پیام‌های ربات رو به این تابع بفرسته، و دکمه‌ی منوی ربات همین سایت رو باز کنه.
// آدرس سایت از مرورگر مدیر میاد و داخل آدرس webhook نگه داشته می‌شه.
async function setupBot(req: Request, siteRaw: string): Promise<Response> {
  const auth = await requireAdmin(req);
  if ("res" in auth) return auth.res!;
  const href = httpsSite(siteRaw);
  if (!href) return json({ error: "bad_site" }, 400);
  const site = new URL(href);
  const hook = await tg("setWebhook", {
    url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-auth?site=${encodeURIComponent(site.href)}`,
    secret_token: await webhookSecret(), allowed_updates: ["message"], drop_pending_updates: true,
  });
  if (!hook.ok) return json({ error: "telegram_failed", detail: hook.description }, 502);
  const menu = await tg("setChatMenuButton", { menu_button: { type: "web_app", text: OPEN_SITE, web_app: { url: site.href } } });
  return json({ ok: true, site: site.href, menu: menu.ok, detail: menu.ok ? undefined : menu.description });
}

// پیام همگانی از طرف ربات (فقط مدیر). گیرنده‌ها: هر کسی که ربات رو Start کرده و بلاکش نکرده، به‌اضافه‌ی هر کسی که با تلگرام
// وارد سایت شده (کسی که هیچ‌وقت ربات رو Start نکرده رو تلگرام قبول نمی‌کنه و «نرسید» حساب می‌شه).
// count_only: فقط تعداد گیرنده‌ها. test: فقط برای خود مدیر، تا قبل از فرستادن برای همه ببینه چطور دیده می‌شه.
type Broadcast = { text?: unknown; test?: boolean; count_only?: boolean; with_button?: boolean; site?: unknown };
const MAX_TEXT = 4000;
const PER_SECOND = 20; // تلگرام حدود ۳۰ پیام در ثانیه رو قبول می‌کنه
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function broadcast(req: Request, b: Broadcast): Promise<Response> {
  const auth = await requireAdmin(req);
  if ("res" in auth) return auth.res!;
  const db = asUser(auth.who);
  let ids: number[];
  if (b.test) {
    const own = Number(auth.me?.telegram_id ?? /^tg(\d+)@telegram\.local$/.exec(auth.who.user!.email ?? "")?.[1] ?? 0);
    if (!Number.isSafeInteger(own) || own <= 0) return json({ error: "no_telegram" }, 400);
    ids = [own];
  } else {
    const [bot, members] = await Promise.all([
      db.from("bot_users").select("telegram_id, blocked"),
      db.from("members").select("telegram_id").not("telegram_id", "is", null),
    ]);
    if (bot.error) return json({ error: "setup_missing", detail: bot.error.message }, 500);
    if (members.error) return json({ error: "read_failed", detail: members.error.message }, 500);
    const blocked = new Set((bot.data ?? []).filter((r) => r.blocked).map((r) => Number(r.telegram_id)));
    ids = [...new Set([...(bot.data ?? []), ...(members.data ?? [])].map((r) => Number(r.telegram_id)))]
      .filter((n) => Number.isSafeInteger(n) && n > 0 && !blocked.has(n));
  }
  if (b.count_only) return json({ ok: true, total: ids.length });

  const text = String(b.text ?? "").trim();
  if (!text) return json({ error: "empty" }, 400);
  if (text.length > MAX_TEXT) return json({ error: "too_long" }, 400);
  let markup: unknown;
  if (b.with_button) {
    const site = httpsSite(b.site);
    if (!site) return json({ error: "bad_site" }, 400);
    markup = siteButton(site);
  }
  let sent = 0;
  const unreachable: number[] = [], failed: number[] = [];
  const sendOne = async (id: number) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let r: TgResult;
      try { r = await tg("sendMessage", { chat_id: id, text, reply_markup: markup, link_preview_options: { is_disabled: true } }); }
      catch { failed.push(id); return; }
      if (r.ok) { sent++; return; }
      if (r.error_code === 429 && attempt === 0) { await sleep(Math.min(30, r.parameters?.retry_after ?? 1) * 1000); continue; }
      // 403: ربات رو بلاک کرده یا هیچ‌وقت Start نکرده
      (r.error_code === 403 ? unreachable : failed).push(id);
      return;
    }
  };
  for (let i = 0; i < ids.length; i += PER_SECOND) {
    const t0 = Date.now();
    await Promise.all(ids.slice(i, i + PER_SECOND).map(sendOne));
    if (i + PER_SECOND < ids.length) await sleep(Math.max(0, 1000 - (Date.now() - t0)));
  }
  if (b.test) {
    if (unreachable.length) return json({ error: "start_bot_first" }, 400);
    if (!sent) return json({ error: "telegram_failed" }, 502);
    return json({ ok: true, test: true, sent });
  }
  if (unreachable.length) {
    try { await admin.from("bot_users").update({ blocked: true }).in("telegram_id", unreachable); } catch { /* best effort */ }
  }
  // سابقه (با نام همین مدیر در تاریخچه‌ی سایت)
  try { await db.from("bot_broadcasts").insert({ text, sent, failed: unreachable.length + failed.length }); } catch { /* best effort */ }
  return json({ ok: true, total: ids.length, sent, unreachable: unreachable.length, failed: failed.length });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!BOT_TOKEN) return json({ error: "bot_token_missing" }, 500);
  if (req.headers.has("x-telegram-bot-api-secret-token")) return onTelegramUpdate(req);

  let body: { widget?: Record<string, unknown>; initData?: string; contact?: string; setup_bot?: boolean; site?: string; broadcast?: Broadcast };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  if (typeof body.contact === "string") return linkByPhone(req, body.contact);
  if (body.setup_bot) return setupBot(req, String(body.site ?? ""));
  if (body.broadcast && typeof body.broadcast === "object") return broadcast(req, body.broadcast);

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
