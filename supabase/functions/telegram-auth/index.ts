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
// متن پیام خوش‌آمد رو مدیر از سایت عوض می‌کنه، و از همون‌جا می‌تونه برای همه‌ی کسایی که ربات رو Start کردن پیام بفرسته،
// یا به گروهی از شرکت‌کننده‌ها (مثلاً پرداخت‌نکرده‌ها) پیام شخصی‌شده بده.
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

type TgResult = { ok: boolean; description?: string; error_code?: number; parameters?: { retry_after?: number }; result?: Record<string, any> };
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
// زیر کد رأی: دکمه‌ی سایت رأی‌گیری (در مرورگر باز می‌شه). با secret اختیاری VOTE_URL عوض می‌شه؛ مقدار "off" یعنی بدون دکمه.
const VOTE_URL = Deno.env.get("VOTE_URL") ?? "https://armo.fun/";
const voteRow = () => /^https:\/\//.test(VOTE_URL) ? [{ text: "🗳 ورود به رأی‌گیری", url: VOTE_URL }] : null;
const voteButton = () => { const r = voteRow(); return r ? { inline_keyboard: [r] } : undefined; };

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
  let update: { message?: Record<string, any>; callback_query?: Record<string, any> };
  try { update = await req.json(); } catch { return new Response("ok"); }
  if (update.callback_query) return onButton(update.callback_query);
  const msg = update.message;
  if (!msg || msg.chat?.type !== "private") return new Response("ok");
  const tgId = Number(msg.from?.id);
  const reply = (text: string) => json({ method: "sendMessage", chat_id: msg.chat.id, text });
  // لینک پرداخت: t.me/<ربات>?start=<pay_token> (اگه وسط ثبت رسید بود، اون رو کنار می‌ذاره)
  const start = /^\/start(?:@\w+)?\s+([\w-]{1,64})\s*$/.exec(String(msg.text ?? ""));
  if (start) {
    const [, pay] = await Promise.all([rememberBotUser(msg.from), payInfo(tgId, start[1]), setReceiptWait(tgId, false)]);
    return json({ method: "sendMessage", chat_id: msg.chat.id, ...payMessage(pay) });
  }
  // بعد از زدن «ثبت پرداخت»، پیام بعدی باید عکس رسید باشه؛ هر چیز دیگه‌ای خطا می‌ده و ثبت رسید تموم می‌شه
  if (!msg.contact) {
    const waiting = await receiptWait(tgId);
    if (waiting) {
      await Promise.all([rememberBotUser(msg.from), setReceiptWait(tgId, false)]);
      if (msg.photo || msg.document) return reply(await onReceipt(msg));
      return reply(`❌ رسید ثبت نشد، چون عکس رسید نفرستادی. برای ثبت، دوباره دکمه‌ی «${RECEIPT_BUTTON}» رو بزن و بعدش عکس رو بفرست.`);
    }
    if (msg.photo || msg.document) {
      await rememberBotUser(msg.from);
      return reply(`برای ثبت رسید، اول دکمه‌ی «${RECEIPT_BUTTON}» رو زیر پیام پرداخت بزن (یا لینک پرداختی که مسئول‌های مالی فرستادن رو دوباره باز کن)، بعد عکس رو بفرست.`);
    }
  }
  // پیام «شماره» که دکمه‌ی تأیید شماره‌ی سایت می‌فرسته جواب نمی‌گیره، ولی فرستنده‌ش هم ربات رو Start کرده
  // جزئیات پرداخت فقط با باز کردن خود لینک نشون داده می‌شه؛ بقیه‌ی پیام‌ها (حتی /start) همون جواب همیشگی رو می‌گیرن
  const [, text, codes] = await Promise.all([rememberBotUser(msg.from), msg.contact ? "" : welcomeText(),
    msg.contact ? [] : votingCodes(tgId)]);
  if (msg.contact) return new Response("ok");
  if (!site.startsWith("https://")) return new Response("ok");
  const welcome = fillName(text, String(msg.from?.first_name ?? ""));
  return json({
    method: "sendMessage",
    chat_id: msg.chat.id,
    // with a code the reply is HTML, so the code is tap-to-copy; the welcome text is escaped for that
    ...(codes.length ? { text: escHtml(welcome) + "\n\n" + codesText(codes), parse_mode: "HTML" } : { text: welcome }),
    reply_markup: codes.length && voteRow() ? { inline_keyboard: [...siteButton(site).inline_keyboard, voteRow()] } : siteButton(site),
  });
}

// کد رأی‌گیری صاحب این حساب تلگرام (و هم‌شماره‌هاش). فقط خود همین آدم این جواب رو می‌بینه. تا دستور SQL کدها اجرا نشده، خالیه.
type CodeRow = { full_name: string | null; code: string };
async function votingCodes(tgId: number): Promise<CodeRow[]> {
  if (!Number.isSafeInteger(tgId) || tgId <= 0) return [];
  try {
    const { data, error } = await admin.rpc("voting_codes_for_telegram", { p_tg: tgId });
    return error || !Array.isArray(data) ? [] : data as CodeRow[];
  } catch { return []; }
}
const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- لینک پرداخت (برای کسایی که خودشون وارد سایت نشدن) ----------
// مدیر از سایت لینک t.me/<ربات>?start=<pay_token> هر نفر رو براش می‌فرسته. ربات مبلغ و کارت رو با دکمه‌ی کپی نشون می‌ده و
// عکس رسید رو می‌گیره: عکس در receipts/bot/<شرکت‌کننده>/ می‌ره و یک فیش «در انتظار بررسی» ثبت می‌شه، مثل فیشی که از سایت بیاد.
// کد رأی از این راه نشون داده نمی‌شه (لینک ممکنه دست کس دیگه‌ای هم بیفته). تابع‌های SQL مربوط رو دستور «لینک پرداخت» می‌سازه.
type PayInfo = { ok: boolean; error?: string; via?: "link" | "account"; id?: string; full_name?: string | null; due?: number; approved?: number;
  pending?: number; card_number?: string; card_holder?: string; bank?: string; deadline?: string; currency?: string };
async function payInfo(tgId: number, token?: string): Promise<PayInfo | null> {
  if (!Number.isSafeInteger(tgId) || tgId <= 0) return null;
  try {
    const { data, error } = await admin.rpc("bot_pay_info", { p_tg: tgId, p_token: token ?? null });
    return error || !data ? null : data as PayInfo;
  } catch { return null; }
}
const faNum = (n: number) => new Intl.NumberFormat("fa-IR").format(n);
const remainingOf = (p: PayInfo) => Math.max(0, Number(p.due ?? 0) - Number(p.approved ?? 0) - Number(p.pending ?? 0));
function payMessage(p: PayInfo | null): { text: string; reply_markup?: unknown } {
  if (!p) return { text: "الان جواب نمی‌دم؛ چند دقیقه‌ی دیگه دوباره لینک رو باز کن." };
  if (!p.ok) return { text: "این لینک معتبر نیست (شاید لینک جدید براتون ساخته شده). از مسئول‌های مالی لینک درست رو بگیر." };
  const cur = p.currency || "تومان", m = (n: number) => `${faNum(n)} ${cur}`;
  const due = Number(p.due ?? 0), approved = Number(p.approved ?? 0), pending = Number(p.pending ?? 0), left = remainingOf(p);
  const card = String(p.card_number ?? "").replace(/\D/g, "");
  const lines = [`سلام ${p.full_name || ""}! 👋`.replace(" !", "!")];
  if (!due) lines.push("مبلغ سهمت هنوز تعیین نشده.");
  else {
    lines.push(`مبلغ سهمت از جشن: ${m(due)}`);
    if (approved || pending) lines.push(`تأییدشده: ${m(approved)}${pending ? ` · در انتظار بررسی: ${m(pending)}` : ""}`);
    lines.push(left ? `مونده: ${m(left)}` : approved >= due ? "سهمت کامل پرداخت شده. ممنون! 🌸" : "رسیدت در انتظار بررسیه.");
  }
  const holder = [p.card_holder && `به نام ${p.card_holder}`, p.bank].filter(Boolean).join(" · ");
  // \u200E (علامت چپ‌به‌راست): بدون اون، تلگرام چهارتایی‌های شماره کارت رو وسط متن فارسی جابه‌جا نشون می‌ده
  lines.push("", card ? `شماره کارت: \u200E${card.match(/.{1,4}/g)!.join(" ")}` : "شماره کارت هنوز ثبت نشده.");
  if (card && holder) lines.push(holder);
  if (p.deadline) lines.push(`مهلت پرداخت: ${p.deadline}`);
  lines.push("", `بعد از واریز، دکمه‌ی «${RECEIPT_BUTTON}» رو بزن و عکس رسید (اسکرین‌شات) رو بفرست.`);
  // بانک‌ها مبلغ رو به ریال می‌خوان: مبلغ تومانی با یک صفر بیشتر کپی می‌شه
  const rial = (n: number) => cur === "تومان" ? n * 10 : n;
  const copy = [left || due ? { text: "کپی مبلغ (ریال)", copy_text: { text: String(rial(left || due)) } } : null,
    card ? { text: "کپی شماره کارت", copy_text: { text: card } } : null].filter(Boolean);
  const rows = [...(copy.length ? [copy] : []), [{ text: RECEIPT_BUTTON, callback_data: RECEIPT_ACTION }]];
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: rows } };
}
// مبلغ از کپشن عکس: «۱٬۵۰۰٬۰۰۰»، «1,500,000» یا «1500000 تومان»
function captionAmount(caption: unknown): number {
  const s = String(caption ?? "").replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  for (const raw of s.match(/\d[\d,٬،.]*/g) ?? []) {
    const n = Number(raw.replace(/\D/g, ""));
    if (n >= 1000 && n <= 1e11) return n;
  }
  return 0;
}
// «ثبت پرداخت»: بعد از زدنش، ربات تا RECEIPT_WAIT_MIN دقیقه منتظر یک عکس رسیده (در bot_users.receipt_wait_at)
const RECEIPT_BUTTON = "🧾 ثبت پرداخت", RECEIPT_ACTION = "receipt", RECEIPT_WAIT_MIN = 30;
async function receiptWait(tgId: number): Promise<boolean> {
  if (!Number.isSafeInteger(tgId) || tgId <= 0) return false;
  try {
    const { data, error } = await admin.from("bot_users").select("receipt_wait_at").eq("telegram_id", tgId).maybeSingle();
    const at = !error && data?.receipt_wait_at ? Date.parse(String(data.receipt_wait_at)) : NaN;
    return Date.now() - at < RECEIPT_WAIT_MIN * 60_000;
  } catch { return false; }
}
async function setReceiptWait(tgId: number, on: boolean) {
  if (!Number.isSafeInteger(tgId) || tgId <= 0) return;
  try { await admin.from("bot_users").update({ receipt_wait_at: on ? new Date().toISOString() : null }).eq("telegram_id", tgId); }
  catch { /* column missing (SQL not run): the button just says to send the photo */ }
}
async function onButton(cq: Record<string, any>): Promise<Response> {
  const tgId = Number(cq.from?.id), chat = cq.message?.chat;
  if (cq.data !== RECEIPT_ACTION || !chat || chat.type !== "private") {
    return json({ method: "answerCallbackQuery", callback_query_id: cq.id });
  }
  const pay = await payInfo(tgId);
  await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => null);
  if (!pay?.ok) return json({ method: "sendMessage", chat_id: chat.id,
    text: pay ? "این لینک پرداخت دیگه معتبر نیست؛ از مسئول‌های مالی لینک جدید بگیر." : "الان نشد؛ چند دقیقه‌ی دیگه دوباره دکمه رو بزن." });
  await Promise.all([rememberBotUser(cq.from), setReceiptWait(tgId, true)]);
  const left = remainingOf(pay), cur = pay.currency || "تومان";
  return json({ method: "sendMessage", chat_id: chat.id, text: `حالا عکس رسید (اسکرین‌شات) رو بفرست${pay.full_name ? ` (برای ${pay.full_name})` : ""}.`
    + (left ? ` اگه مبلغی که واریز کردی با ${faNum(left)} ${cur} فرق داره، عددش رو زیر عکس (کپشن) بنویس.` : " مبلغی که واریز کردی رو زیر عکس (کپشن) بنویس.")
    + "\nاگه پیام دیگه‌ای بفرستی، ثبت رسید لغو می‌شه." });
}
const MAX_RECEIPT = 2 * 1024 * 1024; // حد سطل receipts
const RECEIPT_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
async function onReceipt(msg: Record<string, any>): Promise<string> {
  const pay = await payInfo(Number(msg.from?.id));
  if (!pay) return "الان نشد رسید رو بگیرم؛ چند دقیقه‌ی دیگه دوباره بفرست.";
  if (!pay.ok) return "برای فرستادن رسید، اول لینکی رو که مسئول‌های مالی برات فرستادن باز کن (یا از سایت وارد شو و رسید رو همون‌جا بفرست).";
  let fileId = "", type = "image/jpeg";
  if (Array.isArray(msg.photo) && msg.photo.length) {
    // بزرگ‌ترین اندازه‌ای که از حد مجاز کوچیک‌تره
    const sizes = [...msg.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0));
    fileId = (sizes.filter((s) => (s.file_size ?? 0) <= MAX_RECEIPT).at(-1) ?? sizes[0]).file_id;
  } else {
    type = String(msg.document?.mime_type ?? "");
    if (!RECEIPT_TYPES[type]) return "فقط عکس رسید قبول می‌شه (نه PDF یا فایل دیگه)؛ یه اسکرین‌شات بگیر و همون رو بفرست.";
    if (Number(msg.document?.file_size ?? 0) > MAX_RECEIPT) return "این عکس خیلی بزرگه؛ یه اسکرین‌شات بگیر و همون رو بفرست.";
    fileId = String(msg.document?.file_id ?? "");
  }
  const amount = captionAmount(msg.caption) || remainingOf(pay);
  if (!amount) return "مبلغی که واریز کردی رو زیر عکس (کپشن) بنویس و دوباره بفرست.";
  const failed = "رسید ذخیره نشد؛ چند دقیقه‌ی دیگه دوباره بفرست.";
  const f = await tg("getFile", { file_id: fileId }).catch(() => null);
  if (!f?.ok || !f.result?.file_path) return failed;
  let bytes: Uint8Array;
  try {
    const r = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${f.result.file_path}`);
    if (!r.ok) return failed;
    bytes = new Uint8Array(await r.arrayBuffer());
  } catch { return failed; }
  if (bytes.length > MAX_RECEIPT) return "این عکس خیلی بزرگه؛ یه اسکرین‌شات بگیر و همون رو بفرست.";
  const path = `bot/${pay.id}/${crypto.randomUUID()}.${RECEIPT_TYPES[type]}`;
  const up = await admin.storage.from("receipts").upload(path, bytes, { contentType: type, upsert: false });
  if (up.error) return failed;
  const { data, error } = await admin.rpc("bot_pay_receipt", { p_tg: Number(msg.from?.id), p_participant: pay.id, p_path: path, p_amount: amount });
  if (error || !data?.ok) {
    await admin.storage.from("receipts").remove([path]).catch(() => {}); // عکس بی‌صاحب نمونه
    return failed;
  }
  const cur = pay.currency || "تومان";
  return `رسید${pay.full_name ? ` ${pay.full_name}` : ""} با مبلغ ${faNum(amount)} ${cur} رسید ✅\nبعد از بررسی مسئول‌های مالی تأیید می‌شه.`
    + (captionAmount(msg.caption) ? "" : " اگه مبلغی که واریز کردی فرق داره، به مسئول‌های مالی بگو.");
}
function codesText(rows: CodeRow[]): string {
  const code = (c: string) => `<code>${escHtml(c)}</code>`;
  if (rows.length === 1) return `🗳 کد ورود رأی‌گیری: ${code(rows[0].code)}\nاین کد مخصوص خودته؛ به کس دیگه‌ای نده.`;
  return "🗳 کدهای ورود رأی‌گیری:\n" + rows.map((r) => `${escHtml(r.full_name || "—")}: ${code(r.code)}`).join("\n")
    + "\nکد هر نفر مخصوص خودشه؛ به کس دیگه‌ای ندید.";
}

// فقط مدیر. نقش رو مثل خود سایت (با نشست خود کاربر) می‌خونیم؛ دسترسی service role به جدول members لازم نیست.
async function requireAdmin(req: Request) { return requireRole(req, ["admin"], "not_admin"); }
async function requireRole(req: Request, roles: string[], refusal: string) {
  const who = await caller(req);
  if (!who.user) return { res: json({ error: "not_logged_in" }, 401) };
  const { data: me, error } = await asUser(who).from("members").select("role, telegram_id").eq("user_id", who.user.id).maybeSingle();
  if (error) return { res: json({ error: "role_check_failed", detail: error.message }, 500) };
  if (!roles.includes(me?.role)) return { res: json({ error: refusal, role: me?.role ?? null }, 403) };
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
    secret_token: await webhookSecret(), allowed_updates: ["message", "callback_query"], drop_pending_updates: true,
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
// Sends each {to, text} through the bot, at most PER_SECOND a second; one result per job, in the same order.
// "unreachable": Telegram answered 403 (the person blocked the bot or never started it).
type Job = { to: number; text: string };
type Outcome = "sent" | "unreachable" | "failed";
async function sendPaced(jobs: Job[], markup: unknown, parseMode?: "HTML"): Promise<Outcome[]> {
  const out: Outcome[] = new Array(jobs.length);
  const sendOne = async ({ to, text }: Job, i: number) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let r: TgResult;
      try { r = await tg("sendMessage", { chat_id: to, text, reply_markup: markup, link_preview_options: { is_disabled: true }, ...(parseMode ? { parse_mode: parseMode } : {}) }); }
      catch { out[i] = "failed"; return; }
      if (r.ok) { out[i] = "sent"; return; }
      if (r.error_code === 429 && attempt === 0) { await sleep(Math.min(30, r.parameters?.retry_after ?? 1) * 1000); continue; }
      out[i] = r.error_code === 403 ? "unreachable" : "failed";
      return;
    }
  };
  for (let i = 0; i < jobs.length; i += PER_SECOND) {
    const t0 = Date.now();
    await Promise.all(jobs.slice(i, i + PER_SECOND).map((j, k) => sendOne(j, i + k)));
    if (i + PER_SECOND < jobs.length) await sleep(Math.max(0, 1000 - (Date.now() - t0)));
  }
  return out;
}
const ownTelegramId = (auth: { who: { user: { email?: string } | null }; me: { telegram_id?: unknown } | null }) => {
  const id = Number(auth.me?.telegram_id ?? /^tg(\d+)@telegram\.local$/.exec(auth.who.user?.email ?? "")?.[1] ?? 0);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
};
function buttonFor(b: { with_button?: boolean; site?: unknown }): { markup?: unknown; error?: Response } {
  if (!b.with_button) return {};
  const site = httpsSite(b.site);
  return site ? { markup: siteButton(site) } : { error: json({ error: "bad_site" }, 400) };
}
async function markBlocked(ids: number[]) {
  if (!ids.length) return;
  try { await admin.from("bot_users").update({ blocked: true }).in("telegram_id", ids); } catch { /* best effort */ }
}

async function broadcast(req: Request, b: Broadcast): Promise<Response> {
  const auth = await requireAdmin(req);
  if ("res" in auth) return auth.res!;
  const db = asUser(auth.who);
  let ids: number[];
  if (b.test) {
    const own = ownTelegramId(auth);
    if (!own) return json({ error: "no_telegram" }, 400);
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
  const btn = buttonFor(b);
  if (btn.error) return btn.error;
  const res = await sendPaced(ids.map((to) => ({ to, text })), btn.markup);
  const sent = res.filter((r) => r === "sent").length;
  const unreachable = ids.filter((_, i) => res[i] === "unreachable"), failed = res.filter((r) => r === "failed").length;
  if (b.test) {
    if (unreachable.length) return json({ error: "start_bot_first" }, 400);
    if (!sent) return json({ error: "telegram_failed" }, 502);
    return json({ ok: true, test: true, sent });
  }
  await markBlocked(unreachable);
  // سابقه (با نام همین مدیر در تاریخچه‌ی سایت)
  try { await db.from("bot_broadcasts").insert({ text, sent, failed: unreachable.length + failed }); } catch { /* best effort */ }
  return json({ ok: true, total: ids.length, sent, unreachable: unreachable.length, failed });
}

// پیام به گروهی از شرکت‌کننده‌ها (فقط مدیر). سایت گیرنده‌ها رو بر اساس وضعیت پرداخت انتخاب می‌کنه و متن هر نفر رو
// آماده می‌کنه ({name}، {remaining}…)؛ اینجا فقط به حساب‌های تلگرامی فرستاده می‌شه که سایت می‌شناسه (اعضای سایت و کسایی
// که ربات رو Start کردن). نتیجه‌ی هر پیام به همون ترتیب برمی‌گرده تا سایت بقیه رو از حساب شخصی مدیر بفرسته.
// test: فقط اولین پیام، برای خود مدیر.
type Notify = { messages?: unknown; with_button?: boolean; site?: unknown; test?: boolean };
const MAX_MESSAGES = 500;
async function notify(req: Request, b: Notify): Promise<Response> {
  const auth = await requireAdmin(req);
  if ("res" in auth) return auth.res!;
  const db = asUser(auth.who);
  const list = Array.isArray(b.messages) ? b.messages as { to?: unknown; text?: unknown }[] : [];
  if (!list.length) return json({ error: "empty" }, 400);
  if (list.length > MAX_MESSAGES) return json({ error: "too_many" }, 400);
  const jobs: Job[] = list.map((m) => ({ to: Number(m?.to), text: String(m?.text ?? "").trim() }));
  if (jobs.some((j) => !j.text)) return json({ error: "empty" }, 400);
  if (jobs.some((j) => j.text.length > MAX_TEXT)) return json({ error: "too_long" }, 400);
  const btn = buttonFor(b);
  if (btn.error) return btn.error;
  if (b.test) {
    const own = ownTelegramId(auth);
    if (!own) return json({ error: "no_telegram" }, 400);
    const [r] = await sendPaced([{ to: own, text: jobs[0].text }], btn.markup);
    if (r === "unreachable") return json({ error: "start_bot_first" }, 400);
    if (r !== "sent") return json({ error: "telegram_failed" }, 502);
    return json({ ok: true, test: true });
  }
  const [bot, members] = await Promise.all([
    db.from("bot_users").select("telegram_id"),
    db.from("members").select("telegram_id").not("telegram_id", "is", null),
  ]);
  if (members.error) return json({ error: "read_failed", detail: members.error.message }, 500);
  // bot_users may not exist yet (bot SQL not run): then only people who signed in to the site
  const known = new Set([...(bot.error ? [] : bot.data ?? []), ...(members.data ?? [])].map((r) => Number(r.telegram_id)));
  if (jobs.some((j) => !Number.isSafeInteger(j.to) || !known.has(j.to))) return json({ error: "unknown_recipient" }, 400);
  const results = await sendPaced(jobs, btn.markup);
  const sent = results.filter((r) => r === "sent").length;
  await markBlocked([...new Set(jobs.filter((_, i) => results[i] === "unreachable").map((j) => j.to))]);
  // the site records the whole send (bot and personal account together) in the history, so nothing is logged here
  return json({ ok: true, results, sent });
}

// کد رأی هر شرکت‌کننده، از ربات برای خودش (فقط مدیر)، بدون دکمه‌ی «ورود به سایت».
// گیرنده: حساب تلگرامی که خود اون نفر (یا صاحب شماره‌ش) باهاش وارد سایت شده؛ چند نفرِ یک شماره در یک پیام.
// test: یک پیام نمونه با کد ساختگی برای خود مدیر.
type SendCodes = { test?: boolean };
async function sendCodes(req: Request, b: SendCodes): Promise<Response> {
  const auth = await requireAdmin(req);
  if ("res" in auth) return auth.res!;
  const btn = { markup: voteButton() }; // only the voting-site button, no "open the site"
  if (b.test) {
    const own = ownTelegramId(auth);
    if (!own) return json({ error: "no_telegram" }, 400);
    const [r] = await sendPaced([{ to: own, text: "(نمونه؛ کد واقعی نیست)\n" + codesText([{ full_name: null, code: "AB12CD" }]) }], btn.markup, "HTML");
    if (r === "unreachable") return json({ error: "start_bot_first" }, 400);
    if (r !== "sent") return json({ error: "telegram_failed" }, 502);
    return json({ ok: true, test: true });
  }
  const { data, error } = await admin.rpc("voting_codes_to_send");
  if (error) return json({ error: "setup_missing", detail: error.message }, 500);
  const byTg = new Map<number, CodeRow[]>();
  for (const r of (data ?? []) as (CodeRow & { telegram_id: unknown })[]) {
    const id = Number(r.telegram_id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    if (!byTg.has(id)) byTg.set(id, []);
    byTg.get(id)!.push({ full_name: r.full_name, code: r.code });
  }
  const ids = [...byTg.keys()];
  const res = await sendPaced(ids.map((to) => ({ to, text: codesText(byTg.get(to)!) })), btn.markup, "HTML");
  const unreachable = ids.filter((_, i) => res[i] === "unreachable");
  await markBlocked(unreachable);
  return json({
    ok: true, people: (data ?? []).length, accounts: ids.length,
    sent: res.filter((r) => r === "sent").length, unreachable: unreachable.length, failed: res.filter((r) => r === "failed").length,
    reached: ids.filter((_, i) => res[i] === "sent").reduce((a, id) => a + byTg.get(id)!.length, 0),
  });
}

// خروجی اکسل و پشتیبان (zip) از داخل تلگرام: دانلود فایل داخل تلگرام کار نمی‌کنه، پس سایت فایل رو (base64) می‌فرسته و ربات به‌عنوان
// سند برای خود همون عضو تیم مالی می‌فرستتش. فقط برای کسایی که اکسل گرفتن براشون مجازه (مدیر، ویرایشگر، بیننده).
type SendFile = { name?: unknown; data?: unknown; caption?: unknown };
const MAX_FILE = 10 * 1024 * 1024;
async function sendFile(req: Request, b: SendFile): Promise<Response> {
  const auth = await requireRole(req, ["admin", "editor", "viewer"], "not_staff");
  if ("res" in auth) return auth.res!;
  const own = ownTelegramId(auth);
  if (!own) return json({ error: "no_telegram" }, 400);
  const name = String(b.name ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").trim().slice(0, 120);
  const type = /\.xlsx$/i.test(name) ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : /\.zip$/i.test(name) ? "application/zip" : "";
  if (!type) return json({ error: "bad_file" }, 400);
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(String(b.data ?? "")), (c) => c.charCodeAt(0)); } catch { return json({ error: "bad_file" }, 400); }
  if (!bytes.length || bytes.length > MAX_FILE) return json({ error: "bad_file" }, 400);
  const form = new FormData();
  form.append("chat_id", String(own));
  form.append("document", new Blob([bytes.buffer as ArrayBuffer], { type }), name);
  const caption = String(b.caption ?? "").slice(0, 900);
  if (caption) form.append("caption", caption);
  let r: TgResult;
  try { r = await (await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: "POST", body: form })).json() as TgResult; }
  catch { return json({ error: "telegram_failed" }, 502); }
  if (r.ok) return json({ ok: true });
  if (r.error_code === 403) return json({ error: "start_bot_first" }, 400);
  return json({ error: "telegram_failed", detail: r.description }, 502);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!BOT_TOKEN) return json({ error: "bot_token_missing" }, 500);
  if (req.headers.has("x-telegram-bot-api-secret-token")) return onTelegramUpdate(req);

  let body: { widget?: Record<string, unknown>; initData?: string; contact?: string; setup_bot?: boolean; site?: string; broadcast?: Broadcast; notify?: Notify; send_codes?: SendCodes; send_file?: SendFile };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  if (typeof body.contact === "string") return linkByPhone(req, body.contact);
  if (body.setup_bot) return setupBot(req, String(body.site ?? ""));
  if (body.broadcast && typeof body.broadcast === "object") return broadcast(req, body.broadcast);
  if (body.notify && typeof body.notify === "object") return notify(req, body.notify);
  if (body.send_codes && typeof body.send_codes === "object") return sendCodes(req, body.send_codes);
  if (body.send_file && typeof body.send_file === "object") return sendFile(req, body.send_file);

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
