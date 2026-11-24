(function(){
const TYPES = {
  must:{l:'قطعی', c:'var(--must)', order:0},
  maybe:{l:'احتمالی', c:'var(--maybe)', order:1},
  optional:{l:'انتخابی', c:'var(--opt)', order:2}
};
const CATS = ['مکان و سالن','غذا و نوشیدنی','کیک و شیرینی','دکور و گل','عکاسی و فیلم','موسیقی و صوت','لباس و کلاه','هدیه و یادبود','چاپ و دعوت‌نامه','حمل‌ونقل','سایر'];
const QUICK = [['اجاره سالن','مکان و سالن','must'],['شام / پذیرایی','غذا و نوشیدنی','must'],['کیک','کیک و شیرینی','must'],['عکاس','عکاسی و فیلم','maybe'],['کلاه و ردای فارغ‌التحصیلی','لباس و کلاه','must'],['دی‌جی یا سیستم صوت','موسیقی و صوت','maybe'],['بادکنک و دکور','دکور و گل','optional'],['هدیه برای استادها','هدیه و یادبود','optional']];
const QUICK_FUNDS = ['پول نقد اولیه','کمک دانشگاه یا انجمن','اسپانسر','باقی‌مانده‌ی جشن قبلی'];
const FUND = 'صندوق';
const BUCKET = 'invoices';
const DEFAULT_SETTINGS = {id:1, title:'جشن فارغ‌التحصیلی', budget:0, headcount:0, currency:'تومان'};
const TABLES = ['items','funds','invoices','participants','payments'];
const UPLOAD_TYPES = ['image/jpeg','image/png','image/webp','image/gif','application/pdf'];
const AUDIT = ['created_at','created_by','updated_at','updated_by'];

const $ = s => document.querySelector(s);
const cfg = window.APP_CONFIG || {};
// the language button offers the other language
document.querySelectorAll('[data-act="lang"]').forEach(b => { const fa = I18N.lang !== 'fa'; b.textContent = fa ? 'فارسی' : 'English'; b.lang = fa ? 'fa' : 'en'; b.title = fa ? 'نمایش به فارسی' : 'Show in English'; });
let sb = null, me = null, channel = null, ready = false;
const emptyState = () => ({settings:{...DEFAULT_SETTINGS}, items:{}, funds:{}, invoices:{}, members:{}, activity:[], participants:{}, payments:{}, payInfo:{}});
let S = emptyState();
const uploading = new Map();
const urlCache = new Map(); // file_path -> {url, exp}
const urlPending = new Set();

/* ---------- helpers ---------- */
const nf = new Intl.NumberFormat(I18N.numLocale);
const fmt = n => nf.format(Math.round(n || 0));
// the currency as shown (stored as typed; Toman and Rial have English names)
const curName = () => tr(S.settings.currency || 'تومان');
const money = n => fmt(n) + ' ' + curName();
const toLatin = s => String(s ?? '').replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
const parseNum = s => { const v = toLatin(s).replace(/[^\d]/g, ''); return v ? Number(v) : 0; };
const normNo = s => toLatin(s).replace(/[\s\-_/.]/g, '').toUpperCase(); // student number, as stored
const last4 = s => toLatin(s).replace(/\D/g, '').slice(-4);
// Every Iranian mobile written in a cell, in the one form participants are stored under (09xxxxxxxxx).
// Accepts +98/0098/98 prefixes, Persian digits, spaces/dashes inside the number, a lost leading 0 (Excel drops it
// from numeric cells), and other text around it ("09367…(@user)", "0910…(تلگرام) 0999…(تماس)").
// tg: the text right after the number says it's the Telegram one.
function phonesIn(s){
  const t = toLatin(s), out = [], re = /(^|\D)((?:\+?98|0098|0)?[\s\-]*9(?:[\s\-]*\d){9})(?!\d)/g;
  let m;
  while ((m = re.exec(t))){
    const d = m[2].replace(/\D/g, ''), phone = '0' + d.slice(-10), after = t.slice(m.index + m[0].length, m.index + m[0].length + 16);
    if (!out.some(x => x.phone === phone)) out.push({phone, tg: /^\s*[(\[\-–:]?\s*(تلگرام|telegram|tg)/i.test(after)});
  }
  return out;
}
// the number a person logs in with: the one marked Telegram if a cell has several, else the first; or null
const canonPhone = s => { const ps = phonesIn(s); return (ps.find(x => x.tg) || ps[0] || {}).phone || null; };
// Several people can register with one number (e.g. someone signs up a friend too). The number column has to stay
// unique, so they're stored as 0912…, 0912…#2, 0912…#3; the number's owner logs in once and switches between them.
const baseNo = s => String(s ?? '').split('#')[0];
const shareNo = s => +(String(s ?? '').split('#')[1] || 1);
const sameNumber = (a, b) => baseNo(a) === baseNo(b);
const normName = s => String(s ?? '').replace(/\u200c/g, ' ').replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/\s+/g, ' ').trim();
// the stored key for one more person on this number (taken: keys already in use)
function freeKey(base, taken){ if (!taken.has(base)) return base; let k = 2; while (taken.has(`${base}#${k}`)) k++; return `${base}#${k}`; }
const isPhoneId = s => /^09\d{9}$/.test(baseNo(s));
// Someone on the list without a usable number is stored as "~<name>" (the column can't be empty and must stay unique).
// They can't log in until a number is added for them; the finance team can still record their payments.
const noPhone = s => String(s ?? '').startsWith('~');
const noPhoneKey = name => '~' + normName(name);
const shownNo = s => noPhone(s) ? '' : baseNo(s);
// Guest count as people write it: "2", "۲ نفر", "دو نفر", "ندارم", "-".
// sure=false when the cell had more than a plain count (e.g. "۲ نفر (پدر و مادر)") or couldn't be read, so the admin can check it.
const GUEST_WORDS = {'صفر':0, 'یک':1, 'یه':1, 'دو':2, 'سه':3, 'چهار':4, 'پنج':5, 'شش':6, 'شیش':6, 'هفت':7, 'هشت':8, 'ده':10};
function parseGuests(v){
  const s = toLatin(v).replace(/[\u200cيك]/g, c => ({'\u200c':' ', 'ي':'ی', 'ك':'ک'}[c])).trim();
  if (!s || /^(?:[-—ـ.]+|0|ندارم|ندارد|نداره|ندارن|ندارند|خیر|نخیر|هیچ|هیچی|هیچکس|بدون|بدون مهمان|نمیارم|نمیاورم)$/.test(s)) return {n:0, sure:true};
  const plain = /^\S+\s*(?:نفر|مهمان|تا)?$/.test(s), d = s.match(/\d+/);
  if (d) return {n:Math.min(+d[0], 50), sure: plain && +d[0] <= 10};
  const w = s.split(/\s+/).find(x => x in GUEST_WORDS);
  return w ? {n:GUEST_WORDS[w], sure:plain} : {n:0, sure:false};
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random()*16|0; return (c === 'x' ? r : (r&3|8)).toString(16); }));
const estimate = it => (Number(it.unit) || 0) * (Number(it.qty) || 1);
const cost = it => (it.paid && Number(it.actual) > 0) ? Number(it.actual) : estimate(it);
const isFund = p => !p || p.trim() === '' || p.trim() === FUND;
const contribs = () => Object.values(S.funds).filter(f => f.kind === 'contrib');
const fundsOnly = () => Object.values(S.funds).filter(f => f.kind !== 'contrib');
const invOf = itemId => Object.values(S.invoices).filter(v => v.item_id === itemId);
const invSum = itemId => invOf(itemId).reduce((a,v) => a + (Number(v.total)||0), 0);
const ts = v => v ? new Date(v).getTime() : 0;
const faDate = v => v ? new Intl.DateTimeFormat(I18N.dateLocale, {month:'short', day:'numeric'}).format(new Date(v)) : '';
const who = e => e ? String(e) : '';
const metaLine = r => r && r.updated_by ? `آخرین تغییر: ${who(r.updated_by)}، ${new Intl.DateTimeFormat(I18N.dateLocale, {month:'long', day:'numeric', hour:'2-digit', minute:'2-digit'}).format(new Date(r.updated_at))}` + (r.created_by && r.created_by !== r.updated_by ? ` · ثبت اولیه: ${who(r.created_by)}` : '') : '';

function toast(msg){
  const t = $('#toast'); t.firstElementChild.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2800);
}
function fail(error, what){
  console.error(what, error);
  const m = String(error && (error.message || error) || '');
  if (/row-level security|permission|not authorized/i.test(m)) toast('برای این کار دسترسی لازم رو نداری');
  else if (/JWT|expired/i.test(m)) toast('نشستت تموم شده؛ دوباره وارد شو');
  else if (/Failed to fetch|NetworkError|network/i.test(m)) toast('اتصال اینترنت برقرار نیست');
  else if (/exceeded|too large|Payload/i.test(m)) toast('حجم فایل بیشتر از حد مجازه');
  else toast('ذخیره نشد؛ دوباره امتحان کن');
}
const clean = row => { const o = {...row}; AUDIT.forEach(k => delete o[k]); return o; };

/* ---------- data ---------- */
// All writes are optimistic: local state and UI change first; on failure the table is re-read from the server.
// Each returns true on success so callers can show a confirmation only when the change really stuck.
async function upsert(table, row){
  S[table][row.id] = {...S[table][row.id], ...row}; render();
  const { error } = await sb.from(table).upsert(clean(row));
  if (error){ fail(error, table); await resync(table); return false; }
  return true;
}
// Update only the given fields, so a stale copy of the row can't overwrite someone else's concurrent edit.
async function patch(table, id, fields){
  if (!S[table][id]) return false;
  S[table][id] = {...S[table][id], ...fields}; render();
  const { error } = await sb.from(table).update(fields).eq('id', id);
  if (error){ fail(error, table); await resync(table); return false; }
  return true;
}
async function del(table, id){
  const old = S[table][id]; delete S[table][id]; render();
  const { data, error } = await sb.from(table).delete().eq('id', id).select('id');
  if (error){ fail(error, table); if (old) S[table][id] = old; render(); return false; }
  // Row-level security filters a forbidden delete silently (no error, nothing deleted)
  if (!data || !data.length){ toast('حذف نشد؛ شاید دسترسی لازم رو نداری'); await resync(table); return false; }
  return true;
}
async function resync(table){ try { await reload(table); } catch(e){ console.error(table, e); } render(); }
async function saveSettings(fields){
  const old = S.settings; S.settings = {...S.settings, ...fields}; render();
  const { error } = await sb.from('settings').update(fields).eq('id', 1);
  if (error){ fail(error, 'settings'); S.settings = old; render(); fillSettings(); }
}
async function reload(table){
  const { data, error } = await sb.from(table).select('*');
  if (error) throw error;
  const next = {}; data.forEach(r => next[r.id] = r); S[table] = next;
}
async function loadSettings(){
  const { data, error } = await sb.from('settings').select('*').eq('id', 1).maybeSingle();
  if (error) throw error;
  S.settings = {...DEFAULT_SETTINGS, ...(data || {})};
}
async function loadAll(){
  await Promise.all([loadSettings(), ...TABLES.map(reload), loadMembers(), loadActivity(), loadPayInfo(), probeGuestCols(), probeExtraCols(), loadMyCodes()]);
  ready = true; render(); fillSettings();
  // who has a voting code only adds tags to the list; it doesn't hold up the first render
  reloadCodes().then(codeStatusShown);
}
// major / guests / guest_amount are added to the database after schema.sql; until they exist, the app works without them
// and leaves them out of every write (sending an unknown column would make the whole save fail)
let hasGuestCols = false;
async function probeGuestCols(){
  const [a, b] = await Promise.all([sb.from('participants').select('guests,major').limit(1), sb.from('payment_info').select('guest_amount').limit(1)]);
  hasGuestCols = !a.error && !b.error;
}
// same for the "new participants" columns (kind, chosen items, catering; the item list and catering price)
let hasExtraCols = false;
async function probeExtraCols(){
  const [a, b] = await Promise.all([sb.from('participants').select('kind,addons,catering').limit(1), sb.from('payment_info').select('addons,catering_amount').limit(1)]);
  hasExtraCols = !a.error && !b.error;
}
async function loadParticipantData(){
  // settings is only needed for the currency label; participants may not be allowed to read it
  await Promise.all([reload('participants'), reload('payments'), loadPayInfo(), loadSettings().catch(() => {}), loadMyCodes()]);
  ready = true; render();
}
function subscribe(){
  if (channel) sb.removeChannel(channel);
  channel = sb.channel('party-finance');
  const tables = myRole === 'participant' ? ['participants','payments'] : TABLES;
  [...tables, 'settings', 'payment_info'].forEach(table => {
    channel.on('postgres_changes', {event:'*', schema:'public', table}, p => {
      if (table === 'payment_info'){ if (p.new && p.new.id === 1) S.payInfo = {...DEFAULT_PAYINFO, ...p.new}; }
      else if (table === 'settings'){ if (p.new && p.new.id === 1){ S.settings = {...DEFAULT_SETTINGS, ...p.new}; fillSettings(); } }
      else if (p.eventType === 'DELETE'){ if (p.old && p.old.id) delete S[table][p.old.id]; }
      else if (p.new && p.new.id) S[table][p.new.id] = p.new;
      // the database hands out (or takes back) voting codes when someone is added, removed or moved between the lists
      if (table === 'participants' && canAdmin) loadCodeStatusSoon();
      render();
    });
  });
  channel.on('postgres_changes', {event:'*', schema:'public', table:'members'}, p => {
    const row = p.new && p.new.user_id ? p.new : null, oldId = p.old && p.old.user_id;
    if (row && row.user_id === me.id){
      me.member = row;
      // a 'pending' member who claimed a student number is shown the participant page, so that's not a role change
      const changed = myRole === 'participant' ? !NO_PANEL.includes(row.role) : row.role !== myRole;
      if (changed){ enter({user:me}); return; }
    }
    if ((p.eventType === 'DELETE' && oldId === me.id)){ enter({user:me}); return; }
    if (canAdmin){ if (p.eventType === 'DELETE'){ if (oldId) delete S.members[oldId]; } else if (row) S.members[row.user_id] = row; render(); }
  });
  channel.on('postgres_changes', {event:'INSERT', schema:'public', table:'activity'}, p => {
    if (p.new){ S.activity.unshift(p.new); S.activity.length = Math.min(S.activity.length, 300); if (currentTab === 'history') renderHistory(); }
  });
  channel.subscribe(status => {
    if (status === 'SUBSCRIBED') setSync(true, 'همگام؛ تغییرات بقیه همون لحظه اینجا دیده می‌شه');
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setSync(false, 'همگام‌سازی زنده قطعه؛ تغییرات بعد از تازه‌سازی دیده می‌شن');
  });
}
function setSync(on, text){ $('#syncDot').classList.toggle('on', on); $('#syncText').textContent = text; }
// realtime events can be missed while a phone has the page in the background, so re-read everything on return
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !ready || !me) return;
  (myRole === 'participant' ? loadParticipantData() : loadAll()).catch(e => console.warn('refresh', e));
});
window.addEventListener('beforeunload', e => { if (uploading.size){ e.preventDefault(); e.returnValue = ''; } });

/* ---------- roles ---------- */
const ROLE_LABEL = {participant:'شرکت‌کننده', admin:'مدیر', editor:'ویرایشگر', viewer:'بیننده', pending:'در انتظار تأیید', rejected:'ردشده', blocked:'مسدود'};
// roles that don't open the finance team's panel: these people get the participant page (if their number is linked) or the
// claim screen. rejected: their team request was turned down and they may ask again; blocked: they can't ask again.
const NO_PANEL = ['pending','participant','rejected','blocked'];
let myRole = null, canEdit = false, canAdmin = false;
function applyRole(role){
  myRole = role; canEdit = role === 'admin' || role === 'editor'; canAdmin = role === 'admin';
  document.body.classList.toggle('can-edit', canEdit);
  document.body.classList.toggle('can-admin', canAdmin);
  $('#roleTag').textContent = ROLE_LABEL[role] || '';
  ['#setTitle','#setBudget','#setHead','#setCur'].forEach(s => $(s).disabled = !canEdit);
  if (!canAdmin && currentTab === 'members') document.querySelector('.tab[data-tab="items"]').click();
  $('#bottomBar').dataset.key = ''; render();
}
function lockForm(form){ form.querySelectorAll('input,select,textarea').forEach(el => { el.disabled = !canEdit; }); }

/* ---------- auth ---------- */
// Mini App: Telegram passes the signed login data in the URL hash (tgWebAppData)
let tgScript = 'loading'; // Telegram's Mini App script: 'loading' | 'ready' | 'failed'
const tgWA = (() => {
  let init = '';
  try { init = new URLSearchParams(location.hash.slice(1)).get('tgWebAppData') || ''; } catch(e){}
  if (!init) return null;
  let user = null; try { user = JSON.parse(new URLSearchParams(init).get('user')); } catch(e){}
  // Telegram's official Mini App script ships with the site (vendor/) instead of loading from telegram.org:
  // telegram.org is filtered for many users, and while the Telegram app reaches its servers through its own proxy,
  // this page loads files over the phone's normal connection, so the share-number button would never appear.
  const s = document.createElement('script'); s.async = true; s.src = 'vendor/telegram-web-app.js';
  const settled = state => { tgScript = state; if (gateMode === 'claim' && !$('#gate').hidden) setClaimMode(); }; // the claim screen may already be up
  s.onload = () => {
    try { const W = window.Telegram.WebApp; W.ready(); W.expand(); document.documentElement.dataset.theme = W.colorScheme === 'dark' ? 'dark' : 'light'; } catch(e){}
    settled('ready');
  };
  s.onerror = () => settled('failed');
  document.head.appendChild(s);
  return {initData:init, user};
})();
function gateState(state, msg, err){
  $('#app').hidden = true; $('#bottomBar').hidden = true; $('#gate').hidden = false;
  $('#gateMsg').innerHTML = msg || '';
  $('#loginErr').textContent = err || '';
  $('#waitBox').hidden = state !== 'wait' && state !== 'claim';
  // on the claim screen "check again" only concerns team members waiting for approval: it sits in their hint line instead
  $('#recheckBtn').hidden = state === 'claim'; $('#gateLogout').classList.toggle('small', state === 'claim');
  gateMode = state; $('#tgPhoneBox').hidden = true; $('#openInTgBox').hidden = true; $('#claimHelp').hidden = true;
  if (state === 'claim') setClaimMode();
  $('#payApp').hidden = true;
  $('#tgBox').hidden = state !== 'login';
  $('#emailBox').hidden = state !== 'login' || !!tgWA || !emailLogin;
  if (state === 'login'){ mountTelegramWidget(); if (!botConfigured) $('#emailBox').open = true; }
}
// Everyone logs in with Telegram. Email login (the admin account made in Supabase) is only offered at <site>?email,
// or before a bot is configured.
const botConfigured = !!cfg.telegramBot && !/YOUR/.test(cfg.telegramBot);
const emailLogin = !botConfigured || new URLSearchParams(location.search).has('email');
let gateMode = '';
let widgetMounted = false;
function mountTelegramWidget(){
  if (widgetMounted) return;
  if (tgWA){
    // inside Telegram the login widget isn't used; after a failed auto-login or a logout, offer a retry instead of a dead end
    widgetMounted = true;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn primary'; b.textContent = 'ورود با حساب تلگرام';
    b.addEventListener('click', () => telegramLogin({initData: tgWA.initData}));
    $('#tgBox').appendChild(b); return;
  }
  if (!cfg.telegramBot || /YOUR/.test(cfg.telegramBot)) return;
  widgetMounted = true;
  const s = document.createElement('script');
  s.async = true; s.src = 'https://telegram.org/js/telegram-widget.js?22';
  s.setAttribute('data-telegram-login', cfg.telegramBot.replace(/^@/, ''));
  s.setAttribute('data-size', 'large'); s.setAttribute('data-radius', '10');
  s.setAttribute('data-userpic', 'false'); s.setAttribute('data-onauth', 'onTelegramAuth(user)');
  s.onerror = () => { $('#loginErr').textContent = 'دکمه‌ی تلگرام بارگذاری نشد؛ اتصال به telegram.org رو چک کن.'; };
  $('#tgBox').appendChild(s);
}
window.onTelegramAuth = user => telegramLogin({widget:user});
async function telegramLogin(payload){
  gateState('busy', 'در حال ورود با تلگرام…');
  try {
    const { data, error } = await sb.functions.invoke('telegram-auth', {body:payload});
    if (error){
      let code = ''; try { code = (await error.context.json()).error; } catch(e){}
      throw new Error(code === 'invalid_signature' ? 'تأیید تلگرام ناموفق بود؛ دوباره امتحان کن.' : code === 'bot_token_missing' ? 'توکن ربات در Supabase تنظیم نشده.' : 'تابع ورود تلگرام در دسترس نیست (Edge Function رو چک کن).');
    }
    const v = await sb.auth.verifyOtp({token_hash:data.token_hash, type:'magiclink'});
    if (v.error) throw new Error('ساختن نشست ناموفق بود: ' + v.error.message);
    await enter(v.data.session);
  } catch(e){
    gateState('login', tgWA ? 'ورود خودکار از داخل تلگرام انجام نشد.' : 'برای ورود، با تلگرام وارد شو.', e.message || 'ورود ناموفق بود.');
  }
}
let ownChannel = null, enterSeq = 0;
function stopOwnWatch(){ if (ownChannel){ sb.removeChannel(ownChannel); ownChannel = null; } }
async function enter(session){
  // enter() can be triggered again (role change, realtime) while a previous call is still awaiting; only the latest wins
  const seq = ++enterSeq;
  me = session.user;
  const { data: row, error } = await sb.from('members').select('*').eq('user_id', me.id).maybeSingle();
  if (seq !== enterSeq) return;
  if (error){
    console.error('members', error);
    const m = `${error.code || ''} ${error.message || ''}`;
    const hint = /PGRST205|does not exist|schema cache/i.test(m) ? 'جدول‌ها پیدا نشدن؛ schema.sql اجرا نشده یا Data API جدول‌ها رو نمی‌بینه.'
      : /42501|permission denied/i.test(m) ? 'دیتابیس اجازه‌ی دسترسی نمی‌ده؛ دستورهای grant رو در SQL Editor اجرا کن.'
      : /infinite recursion/i.test(m) ? 'مشکل در قوانین دسترسی جدول members.'
      : 'اتصال به دیتابیس برقرار نشد.';
    gateState('wait', '', `${hint} (جزئیات: ${m.trim()})`); return;
  }
  me.member = row;
  let role0 = row ? row.role : 'pending';
  // no members row (removed by an admin before, when that deleted the row): ask again, so the request shows in the panel
  if (!row){
    const r = await sb.rpc('request_access');
    if (seq !== enterSeq) return;
    if (!r.error && r.data) role0 = r.data; else if (r.error) console.warn('request_access', r.error);
  }
  if (NO_PANEL.includes(role0)){
    const { data: part } = await sb.from('participants').select('id').eq('user_id', me.id).maybeSingle();
    if (seq !== enterSeq) return;
    if (part) return enterParticipant();
    const team = role0 === 'pending' ? 'اگه از تیم مالی هستی، منتظر تأیید مدیر بمون؛ خودکار وارد می‌شی. <button class="link-btn" type="button" data-act="recheck">بررسی دوباره</button>'
      : role0 === 'rejected' ? 'درخواست دسترسی‌ت به پنل تیم مالی تأیید نشد. اگه فکر می‌کنی اشتباه شده، <button class="link-btn" type="button" data-act="re-request">دوباره درخواست بده</button>.'
      : role0 === 'blocked' ? 'دسترسی‌ت به پنل تیم مالی بسته شده.' : '';
    gateState('claim', `سلام${row && row.display_name ? ' ' + esc(row.display_name) : ''}! اگه برای جشن ثبت‌نام کردی، شماره‌ت با لیست ثبت‌نام چک می‌شه تا مبلغ و اطلاعات پرداخت رو ببینی.` + (team ? `<br><span class="sub">${team}</span>` : ''));
    watchOwnRow(); return;
  }
  stopOwnWatch();
  $('#gate').hidden = true; $('#payApp').hidden = true; $('#app').hidden = false; $('#bottomBar').hidden = false;
  $('#me').textContent = row.display_name || (me.email && !me.email.endsWith('@telegram.local') ? me.email : '');
  applyRole(row.role);
  try { await loadAll(); subscribe(); } catch(e){ fail(e, 'load'); setSync(false, 'بارگذاری ناموفق بود؛ صفحه رو تازه کن'); }
}
async function enterParticipant(){
  stopOwnWatch();
  $('#gate').hidden = true; $('#app').hidden = true; $('#payApp').hidden = false; $('#bottomBar').hidden = true;
  applyRole('participant');
  try { await loadParticipantData(); subscribe(); }
  catch(e){ fail(e, 'load'); }
}
// "message the people announced in the group", with their Telegram links when config.js lists them
function askAdmins(){
  const ids = (Array.isArray(cfg.supportIds) ? cfg.supportIds : []).map(x => String(x).trim().replace(/^@/, '')).filter(x => /^[A-Za-z0-9_]{4,32}$/.test(x));
  return 'به آیدی‌هایی که توی گروه اعلام شده پیام بده تا درستش کنن' + (ids.length ? ': ' + ids.map(x => `<a href="https://t.me/${x}" target="_blank" rel="noopener" dir="ltr">@${x}</a>`).join('، ') : '') + '.';
}
function showClaimHelp(html){ const h = $('#claimHelp'); h.innerHTML = html; h.hidden = false; }
// result of linking through the number Telegram confirmed
async function claimResult(data, phone){
  $('#claimHelp').hidden = true; $('#loginErr').textContent = '';
  if (data && data.ok){ const s = await sb.auth.getSession(); if (s.data.session) enter(s.data.session); return; }
  const code = data && data.error, shown = phone ? `<span dir="ltr">${esc(phone)}</span>` : 'این شماره';
  if (code === 'too_many') return showClaimHelp('تلاش‌ها زیاد شد؛ یک ساعت دیگه دوباره امتحان کن.');
  showClaimHelp((code === 'not_found' ? `شماره‌ی ${shown} توی لیست شرکت‌کننده‌ها نیست.`
    : code === 'taken' ? `شماره‌ی ${shown} قبلاً به یه حساب تلگرام دیگه وصل شده.`
    : code === 'already_linked' ? 'حسابت قبلاً به یه شماره‌ی دیگه وصل شده.' : 'شماره‌ت تأیید نشد.') + ' ' + askAdmins());
}
// Participants link their account only through the number Telegram itself confirms (Mini App, client 6.9+).
// Nobody types a number: outside Telegram they're sent to the bot.
const canAskPhone = () => { try { return !!tgWA && window.Telegram.WebApp.isVersionAtLeast('6.9'); } catch(e){ return false; } };
function setClaimMode(){
  const ask = canAskPhone();
  $('#tgPhoneBox').hidden = !ask; $('#openInTgBox').hidden = !!tgWA;
  const bot = botConfigured ? cfg.telegramBot.replace(/^@/, '') : '';
  $('#openInTgBtn').hidden = !bot; if (bot) $('#openInTgBtn').href = `https://t.me/${bot}`;
  if (ask || (tgWA && tgScript === 'loading')) $('#claimHelp').hidden = true;
  else if (tgWA) showClaimHelp(tgScript === 'failed' ? 'ابزار تلگرام روی این صفحه بارگذاری نشد؛ صفحه رو ببند و دوباره از ربات «ورود به سایت» رو بزن.' : oldClientText());
}
// "update Telegram", with the version and platform Telegram reported, so a wrong guess is easy to spot
function oldClientText(){
  let v = ''; try { const W = window.Telegram.WebApp; v = [W.version, W.platform].filter(Boolean).join(' · '); } catch(e){}
  return 'تأیید شماره توی این نسخه‌ی تلگرام در دسترس نیست؛ تلگرام رو به‌روز کن و دوباره از ربات وارد شو.' + (v ? ` <span class="sub" dir="ltr">(Telegram ${esc(v)})</span>` : '');
}
// Asking Telegram for the user's number. This talks to Telegram directly (the same messages WebApp.requestContact
// sends) because requestContact refuses a second request while the first got no answer, and some Android clients
// never answer when the share dialog is closed; a second tap then just asks again.
// One listener, registered once, answers the newest tap (removing listeners while Telegram's script is calling them
// would make it skip the next one).
let phoneWaiter = null, phoneListening = false;
function askTelegramPhone(){
  const V = window.Telegram.WebView;
  if (!phoneListening){
    phoneListening = true;
    V.onEvent('phone_requested', (type, data) => { const w = phoneWaiter; phoneWaiter = null; if (w) w(data && data.status); });
  }
  return new Promise(resolve => { phoneWaiter = resolve; V.postEvent('web_app_request_phone'); });
}
// After the user shares, Telegram's servers hand over the signed number; over a slow proxy that can take several
// seconds (Telegram's own script gives up after 3), so keep asking for up to ~20s. Empty string if it never came.
async function fetchSignedContact(stillWanted){
  const W = window.Telegram.WebApp, end = Date.now() + 20000;
  const once = () => new Promise(done => {
    const t = setTimeout(() => done(''), 5000);
    try { W.invokeCustomMethod('getRequestedContact', {}, (err, res) => { clearTimeout(t); done(!err && res ? String(res) : ''); }); }
    catch(e){ clearTimeout(t); done(''); }
  });
  for (let wait = 300; Date.now() < end && stillWanted(); wait = Math.min(wait + 300, 1500)){
    const raw = await once(); if (raw) return raw;
    await new Promise(r => setTimeout(r, wait));
  }
  return '';
}
let phoneAttempt = 0;
$('#tgPhoneBtn').addEventListener('click', async () => {
  const btn = $('#tgPhoneBtn'), id = ++phoneAttempt, current = () => id === phoneAttempt, label = '📱 تأیید شماره با تلگرام';
  $('#loginErr').textContent = ''; $('#claimHelp').hidden = true;
  // no answer from Telegram for a while: the dialog may not have opened, or was closed without Telegram saying so
  const nudge = setTimeout(() => { if (current()) $('#loginErr').textContent = 'اگه پنجره‌ی تلگرام باز نشد یا بستیش، دوباره دکمه رو بزن.'; }, 8000);
  let status;
  try { status = await askTelegramPhone(); }
  catch(e){ clearTimeout(nudge); console.error('request phone', e); return showClaimHelp('درخواست شماره به تلگرام فرستاده نشد. صفحه رو ببند و دوباره از ربات «ورود به سایت» رو بزن؛ اگه باز نشد، ' + askAdmins()); }
  clearTimeout(nudge);
  if (!current()) return; // an older tap; the newer one handles it
  $('#loginErr').textContent = '';
  if (status !== 'sent'){ $('#loginErr').textContent = 'برای دیدن مبلغ و پرداخت، باید شماره‌ت رو با ربات به اشتراک بذاری.'; return; }
  btn.disabled = true; btn.textContent = 'در حال دریافت شماره از تلگرام…';
  try {
    const raw = await fetchSignedContact(current);
    if (!current()) return;
    if (!raw) return showClaimHelp('تلگرام شماره رو نفرستاد (احتمالاً اینترنت کند بود). یه بار دیگه دکمه رو بزن؛ اگه باز نشد، ' + askAdmins());
    btn.textContent = 'در حال بررسی…';
    const { data, error } = await sb.functions.invoke('telegram-auth', {body:{contact:raw}});
    if (error){
      let code = ''; try { code = (await error.context.json()).error; } catch(e){}
      console.error('telegram phone', code, error);
      return showClaimHelp('تأیید شماره انجام نشد. یه بار دیگه دکمه رو بزن؛ اگه باز نشد، ' + askAdmins());
    }
    await claimResult(data, data && data.phone);
  } finally { btn.disabled = false; btn.textContent = label; }
});
function watchOwnRow(){
  if (ownChannel) sb.removeChannel(ownChannel);
  ownChannel = sb.channel('me-' + me.id).on('postgres_changes', {event:'*', schema:'public', table:'members', filter:`user_id=eq.${me.id}`}, async () => {
    const { data } = await sb.auth.getSession(); if (data.session) enter(data.session);
  }).subscribe();
}
async function recheck(){ const { data } = await sb.auth.getSession(); if (data.session) enter(data.session); else gateState('login', 'برای ورود، با تلگرام وارد شو.'); }
// someone whose team request was rejected asks again; it shows up in the admins' panel as a new request
async function reRequest(btn){
  btn.disabled = true;
  const { error } = await sb.rpc('request_access');
  if (error){ btn.disabled = false; console.error('request_access', error); toast(/PGRST202|42883|request_access/.test(`${error.code} ${error.message}`) ? 'درخواست ثبت نشد؛ مدیر هنوز دستور SQL نقش‌ها رو اجرا نکرده.' : 'درخواست ثبت نشد؛ دوباره امتحان کن.'); return; }
  toast('درخواستت دوباره برای مدیر فرستاده شد'); recheck();
}
$('#recheckBtn').addEventListener('click', recheck);
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target.elements, btn = $('#loginBtn');
  if (!sb) return;
  btn.disabled = true; $('#loginErr').textContent = '';
  const { data, error } = await sb.auth.signInWithPassword({email:f.email.value.trim(), password:f.password.value});
  btn.disabled = false;
  if (error){ $('#loginErr').textContent = /Invalid login/i.test(error.message) ? 'ایمیل یا رمز اشتباهه.' : /fetch/i.test(error.message) ? 'به Supabase وصل نمی‌شه؛ اینترنت رو چک کن.' : error.message; return; }
  await enter(data.session);
});
function resetSession(){
  enterSeq++; // cancel any enter() still in flight
  [channel, ownChannel].forEach(c => c && sb.removeChannel(c)); channel = ownChannel = null;
  me = null; ready = false; myRole = null; canEdit = canAdmin = false; payForId = null;
  document.body.classList.remove('can-edit', 'can-admin');
  if (draftReceipt){ URL.revokeObjectURL(draftReceipt.url); draftReceipt = null; }
  S = emptyState();
  tgReset(); // disconnects; the Telegram session stays saved for this admin on this browser
  botWelcomeLoaded = false; ['#botWelcome','#bcText'].forEach(x => $(x).value = ''); ['#botWelcomeMsg','#bcMsg','#botSetupMsg'].forEach(x => $(x).textContent = '');
}
async function logout(){
  resetSession();
  await sb.auth.signOut();
  gateState('login', 'برای ورود، با تلگرام وارد شو.');
}
$('#logoutBtn').addEventListener('click', logout);
$('#gateLogout').addEventListener('click', logout);

async function boot(){
  if (!cfg.supabaseUrl || /YOUR/.test(cfg.supabaseUrl + cfg.supabaseAnonKey) || !window.supabase){
    gateState('setup', 'هنوز تنظیم نشده. آدرس پروژه و کلید anon رو در فایل <code>config.js</code> بنویس (راهنما در README).');
    return;
  }
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const { data } = await sb.auth.getSession();
  const tgIdOfSession = data.session && /^tg(\d+)@telegram\.local$/.exec(data.session.user.email || '');
  const tgIdHere = tgWA && tgWA.user && String(tgWA.user.id);
  if (data.session && (!tgIdHere || (tgIdOfSession && tgIdOfSession[1] === tgIdHere))) await enter(data.session);
  else if (tgWA) await telegramLogin({initData: tgWA.initData});
  else gateState('login', 'برای ورود، با تلگرام وارد شو.');
  sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT' && me){ resetSession(); gateState('login', 'از حساب خارج شدی.'); } });
}

/* ---------- members (admin) ---------- */
async function loadMembers(){
  if (!canAdmin) { S.members = {}; return; }
  const { data, error } = await sb.from('members').select('*');
  if (error) throw error;
  S.members = {}; data.forEach(m => S.members[m.user_id] = m);
}
async function setMember(uid, fields){
  const old = S.members[uid]; S.members[uid] = {...old, ...fields}; render();
  const { error } = await sb.from('members').update(fields).eq('user_id', uid);
  if (error){
    S.members[uid] = old; render(); console.error('members', error);
    const m = `${error.code || ''} ${error.message || ''}`;
    toast(/LAST_ADMIN/.test(m) ? 'حداقل یک مدیر باید بمونه'
      : /23514|check constraint/i.test(m) ? 'دیتابیس این نقش رو نمی‌شناسه؛ دستور SQL نقش‌ها رو در SQL Editor اجرا کن.'
      : 'تغییر ذخیره نشد: ' + (error.message || 'خطای ناشناخته'));
  }
  else if (fields.role) toast(`${old.display_name || 'عضو'}: ${ROLE_LABEL[fields.role] || fields.role}`);
}
// reject / block / take access away / bring back: a role change, never a deleted row (a deleted row never came back)
function memberRole(uid, role){
  const m = S.members[uid]; if (!m) return;
  const name = m.display_name || 'این شخص', team = ['admin','editor','viewer'].includes(m.role);
  const ask = role === 'blocked' ? `«${name}» مسدود بشه؟ دیگه درخواستش توی پنل نمیاد (مگه از «مسدودشده‌ها» رفع مسدودی کنی). اگه شرکت‌کننده باشه، صفحه‌ی پرداختش سر جاش می‌مونه.`
    : role === 'rejected' && team ? `دسترسی «${name}» به پنل برداشته بشه؟ اگه بخواد، می‌تونه دوباره درخواست بده.` : '';
  if (ask && !confirm(ask)) return;
  setMember(uid, {role});
}
const memOpen = new Set(); // which collapsible member groups the admin opened
function renderMembers(){
  const box = $('#memberList'), all = Object.values(S.members);
  const byName = (a,b) => (a.display_name||'').localeCompare(b.display_name||'','fa');
  const pending = all.filter(m => m.role === 'pending').sort((a,b) => ts(b.created_at) - ts(a.created_at));
  const team = all.filter(m => !NO_PANEL.includes(m.role)).sort((a,b) => role_rank(b.role) - role_rank(a.role) || byName(a,b));
  const parts = all.filter(m => m.role === 'participant').sort(byName);
  const rejected = all.filter(m => m.role === 'rejected').sort(byName), blocked = all.filter(m => m.role === 'blocked').sort(byName);
  $('#nMembers').textContent = pending.length ? fmt(pending.length) + ' جدید' : fmt(team.length);
  $('#nMembers').classList.toggle('alert', !!pending.length);
  if (!canAdmin){ box.innerHTML = ''; return; }
  // don't wipe a display name the admin is typing when a realtime update arrives
  if (box.contains(document.activeElement) && document.activeElement.matches('input')) return;
  const ident = m => m.telegram_username ? '@' + m.telegram_username : (m.telegram_id ? 'tg ' + m.telegram_id : (m.email || ''));
  const id = m => esc(m.user_id), act = (m, role, label, cls = '') => `<button class="btn small ${cls}" type="button" data-mem-role="${id(m)}:${role}">${label}</button>`;
  const roleSelect = (m, roles) => `<select data-mem-select="${id(m)}" aria-label="نقش">${roles.map(r => `<option value="${r}"${r === m.role ? ' selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>`;
  const ctl = m => m.role === 'pending' ? act(m, 'viewer', 'تأیید به‌عنوان بیننده', 'primary') + act(m, 'editor', 'ویرایشگر') + act(m, 'rejected', 'رد', 'danger') + act(m, 'blocked', 'مسدود', 'danger')
    : m.role === 'participant' ? roleSelect(m, ['participant','viewer','editor','admin'])
    : m.role === 'rejected' ? act(m, 'pending', 'برگرداندن به درخواست‌ها') + act(m, 'blocked', 'مسدود', 'danger')
    : m.role === 'blocked' ? act(m, 'pending', 'رفع مسدودی')
    : roleSelect(m, ['admin','editor','viewer','participant']) + (m.user_id === me.id ? '<span class="tag">خودت</span>' : act(m, 'rejected', 'برداشتن دسترسی', 'danger'));
  const row = m => `<div class="mem">
      <div><input class="field" value="${esc(m.display_name)}" data-mem-name="${id(m)}" aria-label="نام نمایشی" maxlength="60"><div class="id">${esc(ident(m))}</div></div>
      <div class="ctl">${ctl(m)}</div>
    </div>`;
  const group = (key, title, color, list, hint, folded) => !list.length ? '' : folded
    ? `<details class="group mem-fold" data-mem-group="${key}" style="--c:${color}"${memOpen.has(key) ? ' open' : ''}><summary class="group-head"><h4>${title}</h4><span class="sum">${fmt(list.length)} نفر</span></summary>${hint ? `<p class="hint">${hint}</p>` : ''}<div class="list">${list.map(row).join('')}</div></details>`
    : `<div class="group" style="--c:${color}"><div class="group-head"><h4>${title}</h4><span class="sum">${fmt(list.length)} نفر</span></div>${hint ? `<p class="hint">${hint}</p>` : ''}<div class="list">${list.map(row).join('')}</div></div>`;
  box.innerHTML = group('pending', 'درخواست‌های جدید', 'var(--warn)', pending, '«رد»: اگه بخواد، می‌تونه دوباره درخواست بده. «مسدود»: درخواستش دیگه توی پنل نمیاد.', false)
    + group('team', 'تیم مالی', 'var(--ok)', team, '', false)
    + group('participants', 'شرکت‌کننده‌ها', 'var(--must)', parts, 'برای اضافه کردن یه شرکت‌کننده به تیم مالی، نقشش رو عوض کن.', true)
    + group('rejected', 'ردشده‌ها', 'var(--line)', rejected, 'این‌ها می‌تونن دوباره درخواست بدن؛ اون موقع توی «درخواست‌های جدید» میان.', true)
    + group('blocked', 'مسدودشده‌ها', 'var(--bad)', blocked, 'درخواست این‌ها توی پنل نمیاد. اگه شرکت‌کننده باشن، صفحه‌ی پرداختشون کار می‌کنه.', true);
}
$('#memberList').addEventListener('toggle', e => { const g = e.target.closest && e.target.closest('[data-mem-group]'); if (g) g.open ? memOpen.add(g.dataset.memGroup) : memOpen.delete(g.dataset.memGroup); }, true);
const role_rank = r => ({admin:3, editor:2, viewer:1}[r] || 0);

/* ---------- history ---------- */
const FIELD_LABELS = {welcome_text:'متن پیام خوش‌آمد', student_no:'شماره', full_name:'نام', major:'گرایش', guests:'تعداد مهمان', guest_amount:'مبلغ هر مهمان', status:'وضعیت فیش', review_note:'یادداشت بررسی', tracking_code:'کد پیگیری', card_number:'شماره کارت', card_holder:'به نام', default_amount:'مبلغ پیش‌فرض', deadline:'مهلت', user_id:'حساب متصل', verify_code:'کد تأیید', title:'عنوان', reason:'دلیل', type:'نوع', category:'دسته', vendor:'فروشنده', unit:'قیمت واحد', qty:'تعداد', paid:'وضعیت', actual:'مبلغ واقعی', payer:'پرداخت از',
  name:'نام', amount:'مبلغ', note:'یادداشت', item_id:'خرج مربوط', total:'مبلغ فاکتور', invoice_date:'تاریخ فاکتور', budget:'سقف بودجه', headcount:'تعداد نفرات', currency:'واحد پول',
  kind:'دسته', addons:'اقلام', catering:'پذیرایی', catering_amount:'مبلغ پذیرایی'};
function valText(k, v, tbl, kind){
  if (v === null || v === undefined || v === '') return '—';
  if (['unit','actual','amount','total','budget','headcount','qty','default_amount','guest_amount','guests','catering_amount'].includes(k)) return fmt(v);
  if (k === 'kind') return v === 'extra' ? 'جدید (فقط اقلام)' : 'اصلی';
  if (k === 'addons' && Array.isArray(v)) return v.map(x => typeof x === 'object' ? `${x.name} ${fmt(x.price || 0)}` : (ADDONS().find(a => a.id === x)?.name || x)).join('، ') || '—';
  if (k === 'catering') return {yes:'بله', no:'خیر', undecided:'تصمیم نشده'}[v] || v;
  if (k === 'status') return PAY_STATUS[v] || v;
  if (k === 'user_id') return 'متصل';
  if (k === 'paid') return v ? (tbl === 'funds' ? (kind === 'contrib' ? 'واریز کرده' : 'دریافت شد') : 'پرداخت شد') : (tbl === 'funds' ? 'در راه' : 'پرداخت‌نشده');
  if (k === 'type') return TYPES[v]?.l || v;
  if (k === 'item_id') return S.items[v]?.title || 'خرج حذف‌شده';
  return String(v).slice(0, 60);
}
async function loadActivity(){
  const { data, error } = await sb.from('activity').select('*').order('id', {ascending:false}).limit(200);
  if (!error) S.activity = data;
}
const ARROW = I18N.lang === 'fa' ? '←' : '→';
function renderHistory(){
  const box = $('#historyList');
  if (!S.activity.length){ box.innerHTML = '<div class="empty">هنوز تغییری ثبت نشده.</div>'; return; }
  const TBL = {items:'هزینه', invoices:'فاکتور', settings:'تنظیمات', participants:'شرکت‌کننده', payments:'فیش', payment_info:'اطلاعات پرداخت', bot_settings:'ربات', bot_broadcasts:'پیام'};
  const ACT = {insert:'اضافه کرد', update:'ویرایش کرد', delete:'حذف کرد'};
  const COL = {insert:'var(--ok)', update:'var(--gold)', delete:'var(--bad)'};
  const dt = new Intl.DateTimeFormat(I18N.dateLocale, {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
  box.innerHTML = S.activity.map(a => {
    const r = a.new_row || a.old_row || {}, kind = r.kind;
    const what = a.tbl === 'funds' ? (kind === 'contrib' ? 'سهم' : 'واریزی') : (TBL[a.tbl] || a.tbl);
    const verb = a.tbl === 'bot_broadcasts' && a.action === 'insert' ? 'فرستاد' : ACT[a.action] || a.action;
    let chg = '';
    if (a.action === 'update' && a.old_row && a.new_row){
      chg = Object.keys(FIELD_LABELS).filter(k => k in a.new_row && JSON.stringify(a.old_row[k]) !== JSON.stringify(a.new_row[k]))
        .map(k => `${tr(FIELD_LABELS[k])}: ${esc(tr(valText(k, a.old_row[k], a.tbl, kind)))} ${ARROW} ${esc(tr(valText(k, a.new_row[k], a.tbl, kind)))}`).join(tr('، '));
    } else if (a.tbl === 'bot_broadcasts'){
      chg = `برای ${fmt(r.sent || 0)} نفر` + (r.failed ? `، ${fmt(r.failed)} نفر نرسید` : '');
    } else if (a.action !== 'update'){
      const amt = r.total || r.amount || r.actual || estimate(r);
      chg = amt ? `مبلغ: ${fmt(amt)}` : '';
    }
    return `<div class="hist" style="--c:${COL[a.action] || 'var(--line)'}"><span class="who2">${esc(a.actor_name || '—')}</span><span class="when">${dt.format(new Date(a.at))}</span>
      <span class="what">${a.title ? tr('{0} «{1}» رو {2}', esc(tr(what)), esc(a.title), esc(tr(verb))) : tr('{0} رو {1}', esc(tr(what)), esc(tr(verb)))}${chg ? `<span class="chg">${chg}</span>` : ''}</span></div>`;
  }).join('');
}

/* ---------- computations ---------- */
function totals(){
  const t = {must:0, maybe:0, optional:0, spent:0, spentFund:0, owed:{}, unpaidMust:0};
  Object.values(S.items).forEach(it => {
    const c = cost(it), ty = it.type in TYPES ? it.type : 'must'; t[ty] += c;
    if (it.paid){ t.spent += c; if (isFund(it.payer)) t.spentFund += c; else { const p = it.payer.trim(); t.owed[p] = (t.owed[p]||0) + c; } }
    else if (ty === 'must') t.unpaidMust += c;
  });
  const sum = (arr, f) => arr.filter(f).reduce((a,c) => a + (Number(c.amount)||0), 0);
  const cs = contribs(), fs = fundsOnly();
  t.contribIn = sum(cs, c => c.paid); t.contribAll = sum(cs, () => true);
  t.fundIn = sum(fs, f => f.paid); t.fundAll = sum(fs, () => true);
  t.income = t.contribIn + t.fundIn; t.expected = t.contribAll + t.fundAll; t.incoming = t.expected - t.income;
  t.owedTotal = Object.values(t.owed).reduce((a,b) => a+b, 0);
  t.balance = t.income - t.spentFund - t.owedTotal;
  t.min = t.must; t.mid = t.must + t.maybe; t.max = t.mid + t.optional;
  t.review = Object.values(S.invoices).filter(v => !v.item_id || !S.items[v.item_id]).length;
  return t;
}

/* ---------- render ---------- */
function render(){
  if (myRole === 'participant'){ renderMyPay($('#myPayFull')); hydrateThumbs(); return; }
  const t = totals(), st = S.settings, head = Number(st.headcount)||0;
  const budget = Number(st.budget) || t.expected, budgetName = Number(st.budget) ? 'سقف بودجه' : 'کل بودجه';
  $('#title').textContent = st.title || DEFAULT_SETTINGS.title;
  document.title = tr('حساب و کتاب {0}', tr(st.title || DEFAULT_SETTINGS.title));

  $('#sMin').textContent = fmt(t.min); $('#sMid').textContent = fmt(t.mid); $('#sMax').textContent = fmt(t.max);
  const pp = v => head ? `هر نفر ${fmt(Math.ceil(v/head))} ${curName()}` : curName();
  $('#pMin').textContent = pp(t.min); $('#pMid').textContent = pp(t.mid); $('#pMax').textContent = pp(t.max);

  // every bar uses the same scale, so their lengths compare directly with each other and with the budget tick
  const scale = Math.max(budget, t.max, 1), pct = v => (v/scale*100) + '%';
  [['Min', t.min, [t.must, 0, 0]], ['Mid', t.mid, [t.must, t.maybe, 0]], ['Max', t.max, [t.must, t.maybe, t.optional]]].forEach(([k, total, parts]) => {
    const segs = $('#b' + k).children; parts.forEach((v, i) => segs[i].style.width = pct(v));
    $('#s' + k).classList.toggle('over', !!budget && total > budget);
  });
  $('#scen').classList.toggle('no-cap', !budget); $('#budgetKey').hidden = !budget;
  if (budget){ $('#scen').style.setProperty('--cap', pct(budget)); $('#budgetLabel').textContent = budgetName + ' ' + fmt(budget); }

  const v = $('#verdict'); v.className = 'verdict';
  if (!Object.keys(S.items).length) v.textContent = 'هنوز هزینه‌ای ثبت نشده.';
  else if (!budget) v.textContent = 'برای مقایسه با بودجه، از تب «بودجه» پولی که دارید یا قراره جمع بشه رو اضافه کن.';
  else if (t.min > budget){ v.classList.add('bad'); v.textContent = `حتی هزینه‌های قطعی ${money(t.min - budget)} از ${budgetName} بیشترن.`; }
  else if (t.mid > budget){ v.classList.add('bad'); v.textContent = `قطعی‌ها جا می‌شن، ولی اگه احتمالی‌ها هم لازم بشن ${money(t.mid - budget)} کم میاد.`; }
  else if (t.max > budget){ v.classList.add('good'); v.textContent = `قطعی و احتمالی جا می‌شن. از انتخابی‌ها تا ${money(budget - t.mid)} جا داری.`; }
  else { v.classList.add('good'); v.textContent = `همه‌چیز جا می‌شه و ${money(budget - t.max)} هم اضافه می‌مونه.`; }

  $('#fIncome').textContent = fmt(t.income); $('#fIncoming').textContent = fmt(t.incoming); $('#fSpent').textContent = fmt(t.spent);
  const fb = $('#fBalance'); fb.textContent = fmt(t.balance); fb.className = 'v ' + (t.balance < 0 ? 'neg' : t.balance > 0 ? 'pos' : '');
  const cn = $('#cashNote'); cn.className = 'cash-note';
  if (t.unpaidMust > 0 && t.expected){
    if (t.balance >= t.unpaidMust) cn.textContent = `موجودی الان برای پرداخت همه‌ی قطعی‌های باقی‌مونده (${money(t.unpaidMust)}) کافیه.`;
    else { cn.classList.add('bad'); cn.textContent = `برای پرداخت قطعی‌های باقی‌مونده الان ${money(t.unpaidMust - t.balance)} نقد کم داری` + (t.incoming ? `؛ ${money(t.incoming)} هم در راهه.` : '.'); }
  } else cn.textContent = '';

  $('#nItems').textContent = fmt(Object.keys(S.items).length);
  const ni = $('#nInv'); ni.textContent = t.review ? fmt(t.review) + ' وصل‌نشده' : fmt(Object.keys(S.invoices).length); ni.classList.toggle('alert', !!t.review);

  renderItems(t); renderInvoices(); renderBudget(t); renderCats(t); renderPayers(); renderBottomBar(); renderMembers(); if (currentTab === 'history') renderHistory();
  renderPeople(); $('#myPayTab').hidden = !myParticipant(); if (currentTab === 'mypay') renderMyPay($('#myPayStaff'));
  if ($('#itemDlg').open && editingItem) renderItemAtt(editingItem.id);
  if ($('#personDlg').open && editingPerson) renderPersonPays();
  hydrateThumbs();
}

function renderItems(t){
  const list = $('#itemList');
  if (!ready){ list.innerHTML = '<div class="empty">در حال بارگذاری…</div>'; return; }
  const all = Object.values(S.items);
  if (!all.length){
    list.innerHTML = `<div class="empty"><h3>اولین هزینه رو اضافه کن</h3>با یکی از این‌ها شروع کن یا دکمه «هزینه جدید» رو بزن.
      <div class="chips need-edit">${QUICK.map((q,i) => `<button class="chip" type="button" data-quick="${i}">${esc(q[0])}</button>`).join('')}</div></div>`;
    $('#owedBox').innerHTML = ''; return;
  }
  const q = toLatin($('#q').value).trim().toLowerCase(), ft = $('#fType').value, fs = $('#fStatus').value, so = $('#fSort').value;
  let rows = all.filter(it => {
    if (ft && it.type !== ft) return false;
    if (fs === 'paid' && !it.paid) return false;
    if (fs === 'open' && it.paid) return false;
    if (fs === 'noinv' && (!it.paid || invOf(it.id).length)) return false;
    if (q && !toLatin([it.title,it.reason,it.vendor,it.category,it.payer].join(' ')).toLowerCase().includes(q)) return false;
    return true;
  });
  const sorters = {
    type:(a,b) => (TYPES[a.type]?.order ?? 0) - (TYPES[b.type]?.order ?? 0) || cost(b) - cost(a),
    amtDesc:(a,b) => cost(b) - cost(a), amtAsc:(a,b) => cost(a) - cost(b), new:(a,b) => ts(b.created_at) - ts(a.created_at)
  };
  rows.sort(sorters[so] || sorters.type);
  list.innerHTML = rows.map(it => {
    const ty = TYPES[it.type] || TYPES.must, qty = Number(it.qty)||1, n = invOf(it.id).length;
    const sub = it.paid && Number(it.actual) > 0 && Number(it.actual) !== estimate(it) ? `برآورد ${fmt(estimate(it))}` : (qty > 1 ? `${fmt(qty)} × ${fmt(it.unit)}` : '');
    const invTag = n ? `<span class="tag ok">${fmt(n)} فاکتور</span>` : (it.paid ? '<span class="tag warn">بدون فاکتور</span>' : '');
    return `<button class="row" type="button" data-item="${esc(it.id)}" style="--c:${ty.c}">
      <span class="stripe"></span>
      <span><span class="t">${esc(it.title)}</span>${it.reason ? `<span class="r" translate="no">${esc(it.reason)}</span>` : ''}
        <span class="meta"><span class="tag type">${ty.l}</span><span class="tag">${esc(it.category||'سایر')}</span>${invTag}${it.paid && !isFund(it.payer) ? `<span class="tag">از جیب ${esc(it.payer)}</span>` : ''}${it.updated_by ? `<span class="tag">${esc(who(it.updated_by))}</span>` : ''}</span></span>
      <span class="status ${it.paid ? 'paid' : ''}">${it.paid ? 'پرداخت شد' : 'پرداخت‌نشده'}</span>
      <span class="amt"><b>${fmt(cost(it))}</b>${sub ? `<small>${sub}</small>` : ''}</span>
    </button>`;
  }).join('') || '<div class="empty">موردی با این فیلترها پیدا نشد.</div>';
  if (rows.length && rows.length !== all.length)
    list.insertAdjacentHTML('beforeend', `<div class="foot-total"><span>${fmt(rows.length)} مورد از ${fmt(all.length)}</span><span>جمع: ${money(rows.reduce((a,it) => a + cost(it), 0))}</span></div>`);
  const owed = Object.entries(t.owed);
  $('#owedBox').innerHTML = owed.length ? `<div class="owed"><h3>صندوق باید به این افراد برگردونه</h3><ul>${owed.sort((a,b) => b[1]-a[1]).map(([n,v]) => `<li><span>${esc(n)}</span><b>${money(v)}</b></li>`).join('')}</ul></div>` : '';
}

/* ---------- invoices ---------- */
function thumbHtml(v, small){
  if (v.file_type === 'application/pdf') return `<span class="thumb">PDF</span>`;
  const c = urlCache.get(BUCKET + ':' + v.file_path), src = c && c.exp > Date.now() ? ` src="${esc(c.url)}"` : '';
  return `<span class="thumb"><img data-path="${esc(v.file_path)}"${src} alt="" loading="lazy"></span>`;
}
async function signedUrls(paths, bucket = BUCKET){
  const key = p => bucket + ':' + p;
  const need = paths.filter(p => { const c = urlCache.get(key(p)); return !(c && c.exp > Date.now() + 60000) && !urlPending.has(key(p)); });
  if (need.length){
    need.forEach(p => urlPending.add(key(p)));
    try {
      const { data, error } = await sb.storage.from(bucket).createSignedUrls(need, 3600);
      if (!error && data) data.forEach(d => { if (d.signedUrl) urlCache.set(key(d.path), {url:d.signedUrl, exp:Date.now() + 3500e3}); });
    } catch(e){ console.warn('signed urls', e); }
    finally { need.forEach(p => urlPending.delete(key(p))); }
  }
  return paths.map(p => urlCache.get(key(p))?.url);
}
async function hydrateThumbs(){
  if (!sb || !me) return;
  const imgs = [...document.querySelectorAll('img[data-path]:not([src])')];
  if (!imgs.length) return;
  const groups = {};
  imgs.forEach(i => (groups[i.dataset.bucket || BUCKET] = groups[i.dataset.bucket || BUCKET] || new Set()).add(i.dataset.path));
  await Promise.all(Object.entries(groups).map(([b, set]) => signedUrls([...set], b)));
  document.querySelectorAll('img[data-path]:not([src])').forEach(i => { const c = urlCache.get((i.dataset.bucket || BUCKET) + ':' + i.dataset.path); if (c) i.src = c.url; });
}
function itemOptions(selected){
  const items = Object.values(S.items).sort((a,b) => (TYPES[a.type]?.order??0) - (TYPES[b.type]?.order??0) || (a.title||'').localeCompare(b.title||'','fa'));
  return `<option value="">— هنوز به خرجی وصل نشده —</option>` +
    items.map(it => `<option value="${esc(it.id)}"${it.id === selected ? ' selected' : ''}>${esc(it.title)} (${TYPES[it.type]?.l || ''})</option>`).join('') +
    `<option value="__new">+ ساختن خرج جدید از این فاکتور</option>`;
}
function invCard(v){
  const linked = v.item_id && S.items[v.item_id];
  const sub = [v.invoice_date, v.note].filter(Boolean).join(' · ') || v.file_name || '';
  return `<div class="inv ${linked ? '' : 'review'}">
    ${thumbHtml(v)}
    <button class="inv-open" type="button" data-inv="${esc(v.id)}"><span class="t">${esc(v.vendor || v.file_name || 'فاکتور')}</span><span class="amt"><b>${v.total ? fmt(v.total) : '—'}</b><small>${faDate(v.created_at)}</small></span><span class="s">${esc(sub)}</span></button>
    <div class="inv-actions">${linked ? '' : '<span class="tag warn">وصل‌نشده</span>'}${!v.total ? '<span class="tag warn">مبلغ ثبت نشده</span>' : ''}<select aria-label="مربوط به خرج" data-inv-map="${esc(v.id)}"${canEdit ? '' : ' disabled'}>${itemOptions(v.item_id)}</select>${v.updated_by ? `<span class="tag">${esc(who(v.updated_by))}</span>` : ''}</div>
  </div>`;
}
function renderInvoices(){
  const list = $('#invList'), all = Object.values(S.invoices);
  const pend = [...uploading.values()].map(n => `<div class="inv"><span class="thumb"><span class="spin"></span></span><div><b>${esc(n)}</b><div style="color:var(--muted);font-size:13px">در حال آپلود…</div></div></div>`).join('');
  if (!all.length && !uploading.size){ list.innerHTML = ''; return; }
  const unlinked = all.filter(v => !v.item_id || !S.items[v.item_id]).sort((a,b) => ts(b.created_at) - ts(a.created_at));
  let html = '';
  if (pend || unlinked.length) html += `<div class="group" style="--c:var(--warn)"><div class="group-head"><h4>وصل‌نشده</h4><span class="sum">${fmt(unlinked.length)} فاکتور</span></div><div class="list">${pend}${unlinked.map(invCard).join('')}</div></div>`;
  const groups = {};
  all.filter(v => v.item_id && S.items[v.item_id]).forEach(v => (groups[v.item_id] = groups[v.item_id] || []).push(v));
  Object.keys(groups).map(id => S.items[id]).sort((a,b) => (TYPES[a.type]?.order??0) - (TYPES[b.type]?.order??0) || (a.title||'').localeCompare(b.title||'','fa')).forEach(it => {
    const invs = groups[it.id].sort((a,b) => ts(a.created_at) - ts(b.created_at)), s = invSum(it.id);
    const recorded = it.paid ? cost(it) : 0, differs = s && (!it.paid || s !== recorded);
    html += `<div class="group" style="--c:${(TYPES[it.type]||TYPES.must).c}"><div class="group-head"><h4>${esc(it.title)}</h4><span class="tag type">${(TYPES[it.type]||TYPES.must).l}</span>
      <span class="sum">جمع فاکتورها <b>${fmt(s)}</b>${it.paid ? ` · ثبت‌شده <b>${fmt(recorded)}</b>` : ' · هنوز پرداخت ثبت نشده'}</span>
      ${differs ? `<button class="btn small need-edit" type="button" data-apply="${esc(it.id)}">${it.paid ? 'اصلاح پرداخت با جمع فاکتورها' : 'ثبت پرداخت با جمع فاکتورها'}</button>` : ''}</div>
      <div class="list">${invs.map(invCard).join('')}</div></div>`;
  });
  list.innerHTML = html;
}

async function shrink(file){
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1.2e6) return file;
  try {
    const bmp = await createImageBitmap(file), k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width*k); c.height = Math.round(bmp.height*k);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0,0,c.width,c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const b = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.86));
    return b && b.size < file.size ? b : file;
  } catch(e){ return file; }
}
let uploadTarget = null; // item id when uploading from the expense dialog
async function handleFiles(files){
  if (!canEdit){ toast('برای آپلود فاکتور دسترسی ویرایش لازمه'); return; }
  const target = uploadTarget; uploadTarget = null;
  const created = [];
  for (const f of files){
    const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
    if (!isPdf && !UPLOAD_TYPES.includes(f.type)){ toast(`«${f.name}» عکس یا PDF نیست`); continue; }
    const tmp = newId(); uploading.set(tmp, f.name); render();
    try {
      const blob = isPdf ? f : await shrink(f);
      const type = isPdf ? 'application/pdf' : (blob.type || f.type);
      if (blob.size > 10 * 1024 * 1024) throw new Error('too large');
      const ext = isPdf ? 'pdf' : ({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'}[type] || 'jpg');
      const path = `${new Date().toISOString().slice(0,7)}/${newId()}.${ext}`;
      const up = await sb.storage.from(BUCKET).upload(path, blob, {contentType:type, upsert:false});
      if (up.error) throw up.error;
      const row = {id:newId(), item_id: target || null, file_path:path, file_name:f.name.slice(0,120), file_type:type, vendor:'', invoice_date:'', total:0, note:''};
      const { data, error } = await sb.from('invoices').insert(row).select().single();
      if (error){ await sb.storage.from(BUCKET).remove([path]); throw error; }
      S.invoices[data.id] = data; created.push(data.id);
    } catch(e){ fail(e, 'upload'); }
    finally { uploading.delete(tmp); render(); }
  }
  if (created.length === 1) openInvoice(created[0]);
  else if (created.length > 1) toast(`${fmt(created.length)} فاکتور آپلود شد؛ مبلغ و خرج هر کدوم رو مشخص کن`);
}
function mapInvoice(id, itemId){
  if (!canEdit) return;
  const v = S.invoices[id]; if (!v) return;
  if (itemId === '__new') return createFromInvoice(id);
  patch('invoices', id, {item_id: itemId || null}).then(ok => { if (ok && itemId) toast(`به «${S.items[itemId]?.title}» وصل شد`); });
}
// fields: unsaved edits from the invoice dialog, saved together with the new link
async function createFromInvoice(id, fields = {}){
  if (!S.invoices[id]) return;
  const v = {...S.invoices[id], ...fields};
  const item = {id:newId(), title:(v.note || v.vendor || 'خرج جدید').slice(0,100), reason:'', vendor:v.vendor || '', type:'must', category:'سایر',
    unit:v.total || 0, qty:1, paid:!!v.total, actual:v.total || 0, payer: v.total ? FUND : ''};
  S.items[item.id] = item; render();
  const { error } = await sb.from('items').insert(item);
  if (error){ delete S.items[item.id]; render(); fail(error, 'items'); return; }
  if (!await patch('invoices', id, {...fields, item_id:item.id})) return;
  toast('خرج جدید ساخته شد؛ عنوان، نوع و دسته‌ش رو کامل کن');
  openItem(item.id);
}
async function applyInvoices(itemId){
  const it = S.items[itemId], s = invSum(itemId); if (!it || !s) return;
  if (await patch('items', itemId, {paid:true, actual:s, payer: it.payer || FUND})) toast('پرداخت با جمع فاکتورها ثبت شد');
}

const invDlg = $('#invDlg'), invForm = $('#invForm'); let editingInv = null;
async function openInvoice(id){
  const v = S.invoices[id]; if (!v) return; editingInv = v;
  const f = invForm.elements;
  $('#invItemSel').innerHTML = itemOptions(v.item_id);
  f.total.value = v.total ? fmt(v.total) : ''; f.vendor.value = v.vendor || ''; f.invoice_date.value = v.invoice_date || ''; f.note.value = v.note || '';
  $('#invCurHint').textContent = curName(); lockForm(invForm);
  $('#invMeta').textContent = [v.file_name, metaLine(v)].filter(Boolean).join(' · ');
  const pv = $('#invPreview'); pv.innerHTML = '<span style="padding:24px;color:var(--muted)">در حال بارگذاری فایل…</span>';
  if (!invDlg.open) invDlg.showModal();
  if (!v.total && canEdit) setTimeout(() => f.total.focus(), 30);
  const [url] = await signedUrls([v.file_path]);
  if (editingInv !== v) return;
  if (!url){ pv.innerHTML = '<span style="padding:24px;color:var(--bad)">فایل پیدا نشد</span>'; return; }
  pv.innerHTML = v.file_type === 'application/pdf'
    ? `<a href="${esc(url)}" target="_blank" rel="noopener">باز کردن PDF «${esc(v.file_name)}»</a>`
    : `<a href="${esc(url)}" target="_blank" rel="noopener" style="padding:0"><img src="${esc(url)}" alt="تصویر فاکتور"></a>`;
}
invForm.addEventListener('input', liveFormat);
invForm.addEventListener('submit', async e => {
  e.preventDefault(); if (!editingInv) return;
  const f = invForm.elements, sel = f.item_id.value, id = editingInv.id;
  const fields = {vendor:f.vendor.value.trim(), invoice_date:f.invoice_date.value.trim(), total:parseNum(f.total.value), note:f.note.value.trim()};
  invDlg.close();
  if (sel === '__new') return createFromInvoice(id, fields);
  fields.item_id = sel || null;
  if (await patch('invoices', id, fields)) toast(fields.item_id ? `فاکتور ذخیره و به «${S.items[fields.item_id]?.title}» وصل شد` : 'فاکتور ذخیره شد');
});
$('#invDel').addEventListener('click', async () => {
  const v = editingInv; if (!v || !confirm('این فاکتور و فایلش برای همیشه حذف بشه؟')) return;
  invDlg.close();
  if (!await del('invoices', v.id)) return; // keep the file if the row couldn't be deleted
  const { error } = await sb.storage.from(BUCKET).remove([v.file_path]);
  if (error) console.warn(error);
  toast('فاکتور حذف شد');
});

/* ---------- budget ---------- */
function moneyRows(arr, kind){
  arr = arr.sort((a,b) => (a.paid === b.paid ? ts(b.created_at) - ts(a.created_at) : a.paid ? 1 : -1));
  const yes = kind === 'fund' ? 'دریافت شد' : 'واریز کرده', no = kind === 'fund' ? 'در راه' : 'هنوز نداده';
  return arr.map(c => `<button class="row" type="button" data-entry="${esc(c.id)}" style="--c:${c.paid ? 'var(--ok)' : 'var(--line)'}">
      <span class="stripe"></span>
      <span><span class="t">${esc(c.name)}</span>${c.note ? `<span class="r" translate="no">${esc(c.note)}</span>` : ''}${c.updated_by ? `<span class="meta"><span class="tag">${esc(who(c.updated_by))}</span></span>` : ''}</span>
      <span class="status ${c.paid ? 'paid' : ''}">${c.paid ? yes : no}</span>
      <span class="amt"><b>${fmt(c.amount)}</b><small>${faDate(c.created_at)}</small></span>
    </button>`).join('');
}
function renderBudget(t){
  const head = Number(S.settings.headcount)||0;
  $('#shareHint').textContent = head ? `سهم پیشنهادی هر نفر (سناریوی محتمل، منهای بقیه‌ی منابع): ${money(Math.max(0, Math.ceil((t.mid - t.fundAll)/head)))}` : 'تعداد نفرات رو در تنظیمات بزن تا سهم هر نفر حساب بشه.';
  if (!ready){ $('#fundList').innerHTML = ''; $('#contribList').innerHTML = ''; return; }
  const fs = fundsOnly(), cs = contribs();
  $('#fundList').innerHTML = fs.length
    ? moneyRows(fs, 'fund') + `<div class="foot-total"><span>دریافت‌شده ${money(t.fundIn)}</span><span>کل ${money(t.fundAll)}</span></div>`
    : `<div class="empty"><h3>بودجه‌ای که الان دارید رو ثبت کن</h3>هر پولی که غیر از سهم نفرات دستته یا قراره برسه.
       <div class="chips need-edit">${QUICK_FUNDS.map((q,i) => `<button class="chip" type="button" data-quick-fund="${i}">${esc(q)}</button>`).join('')}</div></div>`;
  $('#contribList').innerHTML = cs.length
    ? moneyRows(cs, 'contrib') + `<div class="foot-total"><span>واریزشده ${money(t.contribIn)}</span><span>کل تعهدها ${money(t.contribAll)}</span></div>`
    : `<div class="empty">اسم هر کسی که قراره سهم بده و مبلغش رو ثبت کن؛ وقتی واریز کرد، تیکش رو بزن.</div>`;
}
function renderCats(t){
  const by = {};
  Object.values(S.items).forEach(it => {
    const k = it.category || 'سایر'; by[k] = by[k] || {must:0,maybe:0,optional:0,total:0};
    const c = cost(it); by[k][it.type in TYPES ? it.type : 'must'] += c; by[k].total += c;
  });
  const entries = Object.entries(by).sort((a,b) => b[1].total - a[1].total);
  if (!entries.length){ $('#catList').innerHTML = '<div class="empty">وقتی هزینه اضافه کنی، اینجا می‌بینی پول بیشتر کجا می‌ره.</div>'; return; }
  const max = entries[0][1].total || 1;
  $('#catList').innerHTML = entries.map(([k,v]) => `<div class="cat-row"><span>${esc(k)}</span>
    <span class="mini" style="width:${Math.max(4, v.total/max*100)}%"><span class="must" style="width:${v.must/(v.total||1)*100}%"></span><span class="maybe" style="width:${v.maybe/(v.total||1)*100}%"></span><span class="optional" style="width:${v.optional/(v.total||1)*100}%"></span></span>
    <span class="amt"><b>${fmt(v.total)}</b><small>${t.max ? fmt(v.total/t.max*100) + '٪' : ''}</small></span></div>`).join('');
}
function renderPayers(){
  const names = new Set([FUND]);
  contribs().forEach(c => c.name && names.add(c.name));
  Object.values(S.items).forEach(i => i.payer && names.add(i.payer));
  $('#payerList').innerHTML = [...names].map(n => `<option value="${esc(n)}">`).join('');
}
function fillSettings(){
  const st = S.settings;
  if (document.activeElement !== $('#setTitle')) $('#setTitle').value = st.title || '';
  if (document.activeElement !== $('#setBudget')) $('#setBudget').value = st.budget ? fmt(st.budget) : '';
  if (document.activeElement !== $('#setHead')) $('#setHead').value = st.headcount ? fmt(st.headcount) : '';
  $('#setCur').value = st.currency || 'تومان';
  $('#setMeta').textContent = metaLine(st);
}

/* ---------- participants & receipts ---------- */
const PAY_STATUS = {submitted:'در انتظار بررسی', approved:'تأیید شد', rejected:'رد شد'};
const PAY_COLOR = {submitted:'var(--warn)', approved:'var(--ok)', rejected:'var(--bad)'};
const DEFAULT_PAYINFO = {card_number:'', card_holder:'', bank:'', sheba:'', default_amount:0, guest_amount:0, addons:[], catering_amount:0, deadline:'', note:''};
const cardFmt = n => (toLatin(n).replace(/\D/g, '').match(/.{1,4}/g) || []).join(' ');
// Items (payment_info.addons): things such as a plaque, a statue or a yearbook, each with a price. "main" items are part
// of every main participant's share. "New participants" (kind 'extra') joined after the main list was final: they
// don't pay a share, only for the items they asked for (participants.addons) plus catering once the team decides they
// get it. They bring no guests.
const isExtra = p => p.kind === 'extra';
const CATERING = {undecided:'پذیرایی: تصمیم نشده', yes:'با پذیرایی', no:'بدون پذیرایی'};
const ADDONS = () => Array.isArray(S.payInfo.addons) ? S.payInfo.addons.filter(a => a && a.id && a.name) : [];
const addonsOf = p => { const mine = Array.isArray(p.addons) ? p.addons : []; return ADDONS().filter(a => mine.includes(a.id)); };
const extraItems = p => addonsOf(p).map(a => a.name);
const guestsOf = p => isExtra(p) ? 0 : Math.max(0, Math.floor(Number(p.guests) || 0));
// what someone owes: their own share plus the guest price for each guest (for a new participant: the price of each
// thing they asked for), unless a total was set by hand for them
const autoDue = p => isExtra(p)
  ? addonsOf(p).reduce((t, a) => t + (Number(a.price) || 0), 0) + (p.catering === 'yes' ? Number(S.payInfo.catering_amount || 0) : 0)
  : Number(S.payInfo.default_amount || 0) + guestsOf(p) * Number(S.payInfo.guest_amount || 0);
const dueOf = p => (p.amount !== null && p.amount !== undefined) ? Number(p.amount) : autoDue(p);
const paysOf = pid => Object.values(S.payments).filter(x => x.participant_id === pid).sort((a,b) => ts(b.created_at) - ts(a.created_at));
function payState(p){
  const ps = paysOf(p.id), due = dueOf(p);
  const approved = ps.filter(x => x.status === 'approved').reduce((a,x) => a + (Number(x.amount)||0), 0);
  const pending = ps.filter(x => x.status === 'submitted').reduce((a,x) => a + (Number(x.amount)||0), 0);
  const key = due > 0 && approved >= due ? 'settled' : pending ? 'review' : approved > 0 ? 'partial' : 'unpaid';
  return {due, approved, pending, key, remaining:Math.max(0, due - approved - pending), extra:due > 0 ? Math.max(0, approved - due) : 0, count:ps.length};
}
const STATE_LABEL = {settled:'تسویه', review:'فیش در انتظار بررسی', partial:'بخشی پرداخت شده', unpaid:'پرداخت نکرده'};
const STATE_COLOR = {settled:'var(--ok)', review:'var(--warn)', partial:'var(--gold)', unpaid:'var(--line)'};
const myParticipant = () => me && Object.values(S.participants).find(p => p.user_id === me.id);

async function loadPayInfo(){
  const { data } = await sb.from('payment_info').select('*').eq('id', 1).maybeSingle();
  S.payInfo = {...DEFAULT_PAYINFO, ...(data || {})};
}
async function copyText(text, label){
  try { await navigator.clipboard.writeText(text); }
  catch(e){ const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch(_){} ta.remove(); }
  toast((label || 'متن') + ' کپی شد');
}

/* receipt compression: done on the device, so only a small WebP/JPEG ever reaches the server */
function loadImage(file){
  return createImageBitmap(file, {imageOrientation:'from-image'}).catch(() => new Promise((res, rej) => {
    const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error('decode')); img.src = URL.createObjectURL(file);
  }));
}
async function encodeImage(src, maxSide, q){
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight, k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w*k)); c.height = Math.max(1, Math.round(h*k));
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(src, 0, 0, c.width, c.height);
  const toBlob = type => new Promise(r => c.toBlob(r, type, q));
  let b = await toBlob('image/webp');
  if (!b || b.type !== 'image/webp') b = await toBlob('image/jpeg');
  return b;
}
async function compressReceipt(file){
  const src = await loadImage(file);
  let b = await encodeImage(src, 1400, 0.6);
  if (b.size > 300e3) b = await encodeImage(src, 1100, 0.5);
  if (b.size > 800e3) b = await encodeImage(src, 900, 0.4);
  return b;
}
const kb = n => fmt(Math.max(1, Math.round(n / 1024))) + ' کیلوبایت';

/* participant's own payment page (full page for participants, a tab for staff who are also participants) */
let draftReceipt = null; // {blob, url, origSize}
// "your share + 2 guests × price" under the amount, so people see why their total is what it is
function guestLine(p, m, own = true){
  if (isExtra(p)) return extraLine(p, m);
  const g = guestsOf(p), price = Number(S.payInfo.guest_amount || 0); if (!g) return '';
  if (p.amount !== null && p.amount !== undefined) return `<span class="sub">با ${fmt(g)} مهمان</span>`;
  return `<span class="sub">${price ? `${own ? 'سهم خودت' : 'سهم خودش'} ${m(S.payInfo.default_amount || 0)} + ${fmt(g)} مهمان × ${m(price)}` : `با ${fmt(g)} مهمان`}</span>`;
}
// what the person receives at the party: the items that are part of the share, and catering (for them and their
// guests). A new participant gets the share items they asked for (and catering once it's decided).
function getsCard(p, own){
  const extra = isExtra(p), g = guestsOf(p), list = (extra ? addonsOf(p) : ADDONS()).filter(a => a.main).map(a => ['🎁', esc(a.name)]);
  if (!extra) list.push(['🍽', g ? `پذیرایی برای ${own ? 'خودتان' : 'خودش'} و ${fmt(g)} مهمان` : 'پذیرایی']);
  else if (p.catering === 'yes') list.push(['🍽', 'پذیرایی']);
  else if ((p.catering || 'undecided') === 'undecided') list.push(['🍽', 'پذیرایی: هنوز مشخص نشده', true]);
  if (!list.length) return '';
  return `<div class="pay-card gets-card"><span class="k">${own ? 'چیزهایی که دریافت خواهید کرد' : `چیزهایی که ${esc(p.full_name || '')} دریافت خواهد کرد`}</span>
    <ul class="gets">${list.map(([icon, text, maybe]) => `<li${maybe ? ' class="maybe"' : ''}><span aria-hidden="true">${icon}</span>${text}</li>`).join('')}</ul></div>`;
}
// a new participant pays for the items they asked for: "plaque 300,000 + statue 500,000"
function extraLine(p, m){
  const i = S.payInfo, custom = p.amount !== null && p.amount !== undefined;
  const parts = [...addonsOf(p).map(a => esc(a.name) + (custom ? '' : ' ' + m(Number(a.price) || 0))),
    p.catering === 'yes' && `پذیرایی${custom ? '' : ' ' + m(i.catering_amount || 0)}`].filter(Boolean);
  return (parts.length ? `<span class="sub">${parts.join(custom ? ' و ' : ' + ')}</span>` : '')
    + ((p.catering || 'undecided') === 'undecided' ? '<span class="sub">پذیرایی هنوز مشخص نشده؛ اگه اضافه بشه، مبلغ هم بیشتر می‌شه.</span>' : '');
}
// A participant can add guests to their own share (or to someone on their number) from the payment page. Only adding:
// lowering a share is up to the finance team. add_guests also raises a total the team set by hand by the guests' price.
const MAX_GUESTS = 20;
let guestAddFor = null;
function guestBox(p, m, own){
  if (p.guests === undefined || isExtra(p)) return ''; // database without the guest columns; new participants bring no guests
  const g = guestsOf(p), price = Number(S.payInfo.guest_amount || 0), whose = own ? 'سهمت' : `سهم ${esc(p.full_name || '')}`;
  if (guestAddFor !== p.id) return `<div class="pay-card guest-box"><span class="k">مهمان‌ها</span><b>${g ? fmt(g) + ' نفر' : 'بدون مهمان'}</b>
      ${g < MAX_GUESTS ? '<button class="btn small" type="button" data-act="guest-add-open">+ اضافه کردن مهمان</button>' : ''}
      ${price ? `<span class="sub">هر مهمان ${m(price)}</span>` : ''}</div>`;
  return `<div class="pay-card guest-box open"><span class="k">چند مهمان اضافه بشه؟</span>
      <input class="field" id="gaCount" inputmode="numeric" value="1" aria-label="تعداد مهمان‌های جدید">
      <span class="sub" id="gaPreview"></span>
      <div class="row-btns"><button class="btn primary" type="button" data-act="guest-add">ثبت</button><button class="btn" type="button" data-act="guest-add-cancel">انصراف</button></div>
      <span class="hint">بعد از ثبت، ${whose} بیشتر می‌شه و باید مابه‌التفاوت رو واریز کنی. کم کردن مهمان‌ها فقط از طریق مسئول‌های مالی انجام می‌شه.</span></div>`;
}
function guestCount(){ const n = parseNum($('#gaCount') ? $('#gaCount').value : ''); return n; }
// the share after adding n guests, worked out the same way add_guests does it
function shareWithGuests(p, n){
  const price = Number(S.payInfo.guest_amount || 0);
  return p.amount !== null && p.amount !== undefined ? Number(p.amount) + n * price : dueOf({...p, guests:guestsOf(p) + n});
}
function updateGuestPreview(){
  const out = $('#gaPreview'), p = payee(); if (!out || !p) return;
  const n = guestCount(), cur = curName(), g = guestsOf(p);
  out.className = 'sub';
  if (!n){ out.textContent = 'تعداد رو بنویس.'; return; }
  if (n > 10 || g + n > MAX_GUESTS){ out.classList.add('bad'); out.textContent = `هر بار حداکثر ۱۰ نفر، و در کل حداکثر ${fmt(MAX_GUESTS)} مهمان. برای بیشتر با مسئول‌های مالی هماهنگ کن.`; return; }
  const before = dueOf(p), after = shareWithGuests(p, n);
  out.textContent = `با ${fmt(g + n)} مهمان، سهم می‌شه ${fmt(after)} ${cur}` + (after > before ? ` (${fmt(after - before)} ${cur} بیشتر)` : '');
}
async function addGuests(btn){
  const p = payee(), n = guestCount(); if (!p) return;
  if (!n || n > 10 || guestsOf(p) + n > MAX_GUESTS){ updateGuestPreview(); return; }
  const cur = curName(), after = shareWithGuests(p, n);
  if (!confirm(`${fmt(n)} مهمان به ${p.id === myParticipant()?.id ? 'سهمت' : `سهم «${p.full_name || ''}»`} اضافه بشه؟ مبلغ می‌شه ${fmt(after)} ${cur}. کم کردنش بعداً فقط از طریق مسئول‌های مالی ممکنه.`)) return;
  btn.disabled = true;
  const { data, error } = await sb.rpc('add_guests', {p_id:p.id, p_count:n});
  btn.disabled = false;
  if (error){
    console.error('add_guests', error);
    const m = `${error.code || ''} ${error.message || ''}`;
    toast(/PGRST202|42883|add_guests/.test(m) ? 'اضافه کردن مهمان هنوز فعال نشده؛ به مسئول‌های مالی بگو.' : /TOO_MANY/.test(m) ? `حداکثر ${fmt(MAX_GUESTS)} مهمان؛ برای بیشتر با مسئول‌های مالی هماهنگ کن.` : 'ثبت نشد؛ دوباره امتحان کن.');
    return;
  }
  if (data && data.id) S.participants[data.id] = {...S.participants[data.id], ...data};
  guestAddFor = null; render();
  toast(`${fmt(n)} مهمان اضافه شد؛ مبلغ جدید ${fmt(dueOf(S.participants[p.id]))} ${cur}`);
}
document.addEventListener('input', e => { if (e.target.id === 'gaCount') updateGuestPreview(); });
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'gaCount'){ e.preventDefault(); const b = $('[data-act="guest-add"]'); if (b && !b.disabled) b.click(); } });

// Everyone registered on the logged-in person's number (see baseNo); the payment page shows one of them at a time.
// Others on the number are only visible once the database allows it; until then this is just the person themself.
// banking apps take rials: a toman amount is copied with one more zero
const isToman = () => (S.settings.currency || 'تومان') === 'تومان';
const toRial = n => isToman() ? Number(n) * 10 : Number(n);
const myGroup = () => { const me0 = myParticipant(); return me0 ? Object.values(S.participants).filter(x => sameNumber(x.student_no, me0.student_no)).sort((a,b) => shareNo(a.student_no) - shareNo(b.student_no)) : []; };
let payForId = null;
const payee = () => myGroup().find(x => x.id === payForId) || myParticipant();
function renderMyPay(el){
  const me0 = myParticipant(), p = payee(); if (!el) return;
  const keepA = el.querySelector('#rdAmount')?.value, keepT = el.querySelector('#rdTrack')?.value, keepG = el.querySelector('#gaCount')?.value;
  queueMicrotask(() => {
    if (draftReceipt){ const a = el.querySelector('#rdAmount'), t = el.querySelector('#rdTrack'); if (a && keepA !== undefined) a.value = keepA; if (t && keepT !== undefined) t.value = keepT; }
    const g = el.querySelector('#gaCount'); if (g && keepG !== undefined){ g.value = keepG; updateGuestPreview(); }
  });
  if (!p){ el.innerHTML = ''; return; }
  const info = S.payInfo, st = payState(p), ps = paysOf(p.id), cur = curName(), group = myGroup();
  const own = p.id === me0.id, whose = own ? 'سهمت' : `سهم ${esc(p.full_name || '')}`;
  const m = n => fmt(n) + ' ' + cur;
  const statusLine = st.key === 'settled' ? `<div class="pay-status ok">${whose} کامل پرداخت و تأیید شده. ممنون!</div>`
    : st.pending ? `<div class="pay-status warn">فیش رسید و در انتظار بررسیه.</div>`
    : st.due ? `<div class="pay-status">مبلغ باقی‌مونده: <b>${m(st.remaining)}</b></div>` : `<div class="pay-status">مبلغ ${whose} هنوز تعیین نشده.</div>`;
  // several people on this number: pick whose share this page is about
  const switcher = group.length > 1 ? `<div class="pay-for"><span class="sub">این ${fmt(group.length)} نفر با شماره‌ی تو ثبت‌نام کردن؛ برای هر کدوم جدا پرداخت کن:</span>
      <div class="chips">${group.map(x => `<button class="chip${x.id === p.id ? ' on' : ''}" type="button" data-pay-for="${esc(x.id)}" aria-pressed="${x.id === p.id}">${esc(x.full_name || '—')}<small>${STATE_LABEL[payState(x).key]}</small></button>`).join('')}</div></div>` : '';
  const cardRow = info.card_number ? `<div class="pay-card">
      <span class="k">شماره کارت</span><b class="num" dir="ltr">${esc(cardFmt(info.card_number))}</b>
      <button class="btn small" type="button" data-copy="${esc(toLatin(info.card_number).replace(/\D/g, ''))}" data-copy-label="شماره کارت">کپی</button>
      ${info.card_holder ? `<span class="sub">به نام ${esc(info.card_holder)}${info.bank ? ' · ' + esc(info.bank) : ''}</span>` : ''}
    </div>` : `<div class="pay-card"><span class="sub">شماره کارت هنوز توسط مسئول مالی وارد نشده.</span></div>`;
  const shebaRow = info.sheba ? `<div class="pay-card"><span class="k">شبا</span><b class="num" dir="ltr">${esc(info.sheba)}</b><button class="btn small" type="button" data-copy="${esc(info.sheba.replace(/\s/g, ''))}" data-copy-label="شبا">کپی</button></div>` : '';
  const upload = draftReceipt ? `<div class="receipt-draft">
      <img src="${draftReceipt.url}" alt="پیش‌نمایش فیش">
      <div class="rd-fields">
        <span class="sub">حجم بعد از فشرده‌سازی: ${kb(draftReceipt.blob.size)} (اصل: ${kb(draftReceipt.origSize)})</span>
        <label class="lbl">${st.key === 'settled' ? 'مبلغ پرداخت اضافه' : 'مبلغ واریزی'}<input class="field" id="rdAmount" inputmode="numeric" value="${st.key === 'settled' ? '' : fmt(st.remaining || st.due)}" placeholder="${st.key === 'settled' ? 'مبلغی که اضافه واریز کردی' : ''}"></label>
        <label class="lbl">کد پیگیری <span class="hint">اختیاری</span><input class="field" id="rdTrack" inputmode="numeric" dir="ltr" maxlength="40"></label>
        <div class="row-btns"><button class="btn primary" type="button" data-act="send-receipt">${group.length > 1 ? `ارسال فیش برای ${esc(p.full_name || '')}` : 'ارسال فیش'}</button><button class="btn" type="button" data-act="cancel-receipt">انصراف</button></div>
      </div></div>`
    : st.key !== 'settled' ? `<button class="btn primary big" type="button" data-act="pick-receipt">آپلود عکس فیش</button><p class="sub">اسکرین‌شات رسید بانکی کافیه؛ قبل از ارسال خودکار فشرده می‌شه.</p>`
    // settled: anyone who wants to give more (or paid more) can still send a receipt; it's checked like any other
    : `<button class="btn" type="button" data-act="pick-receipt">فیش پرداخت اضافه</button><p class="sub">اگه بیشتر از سهمت واریز کردی (مثلاً کمک بیشتر به جشن)، فیشش رو اینجا بفرست.</p>`;
  el.innerHTML = `<div class="pay-wrap">
    <div class="pay-hello"><h2>سلام ${esc(me0.full_name || '')}</h2><span class="sub">${isPhoneId(me0.student_no) ? 'موبایل' : 'شماره دانشجویی'} <span dir="ltr">${esc(baseNo(me0.student_no))}</span>${me0.major ? ' · ' + esc(me0.major) : ''}</span></div>
    ${switcher}
    ${codeCard(p, own)}
    ${statusLine}
    <div class="pay-amount"><span class="k">${own ? 'مبلغ سهم' : `مبلغ سهم ${esc(p.full_name || '')}`}</span><b class="num">${st.due ? m(st.due) : '—'}</b>${st.due ? `<button class="btn small" type="button" data-copy="${toRial(st.remaining || st.due)}" data-copy-label="${isToman() ? 'مبلغ به ریال' : 'مبلغ'}">${isToman() ? 'کپی مبلغ (ریال)' : 'کپی مبلغ'}</button>` : ''}
      ${guestLine(p, m, own)}
      ${st.approved || st.pending ? `<span class="sub">تأییدشده ${m(st.approved)}${st.pending ? ` · در انتظار بررسی ${m(st.pending)}` : ''}</span>` : ''}
      ${st.extra ? `<span class="sub pos">${m(st.extra)} بیشتر از سهم پرداخت شده. ممنون!</span>` : ''}</div>
    ${guestBox(p, m, own)}
    ${getsCard(p, own)}
    ${cardRow}${shebaRow}
    ${info.deadline ? `<p class="sub">مهلت پرداخت: <b>${esc(info.deadline)}</b></p>` : ''}
    ${info.note ? `<p class="pay-note" translate="no">${esc(info.note)}</p>` : ''}
    <div class="pay-upload">${upload}</div>
    ${ps.length ? `<h3 class="pay-h">${own ? 'فیش‌های من' : `فیش‌های ${esc(p.full_name || '')}`}</h3><div class="list">${ps.map(x => `<div class="rcpt" style="--c:${PAY_COLOR[x.status]}">
        ${receiptThumb(x)}<div><b>${m(x.amount)}</b><span class="sub">${faDate(x.created_at)}${x.tracking_code ? ' · پیگیری ' + esc(x.tracking_code) : ''}</span>
        ${x.status === 'rejected' && x.review_note ? `<span class="sub bad">دلیل: ${esc(x.review_note)}</span>` : ''}</div>
        <span class="tag" style="color:${PAY_COLOR[x.status]}">${PAY_STATUS[x.status]}</span></div>`).join('')}</div>` : ''}
  </div>`;
}
// payments the finance team records by hand (e.g. cash) may have no picture; their file_path is a placeholder
const NO_FILE = 'manual/';
const hasFile = x => !!x.file_path && !x.file_path.startsWith(NO_FILE);
function receiptThumb(x){
  if (!hasFile(x)) return '<span class="thumb" title="بدون عکس فیش">دستی</span>';
  const key = 'receipts:' + x.file_path, c = urlCache.get(key), src = c && c.exp > Date.now() ? ` src="${esc(c.url)}"` : '';
  return `<span class="thumb"><img data-bucket="receipts" data-path="${esc(x.file_path)}"${src} alt="" loading="lazy"></span>`;
}
const receiptInput = document.createElement('input');
receiptInput.type = 'file'; receiptInput.accept = 'image/*'; receiptInput.hidden = true; document.body.appendChild(receiptInput);
receiptInput.addEventListener('change', async () => {
  const f = receiptInput.files[0]; receiptInput.value = ''; if (!f) return;
  if (!/^image\//.test(f.type) && !/\.(jpe?g|png|webp|heic|gif)$/i.test(f.name)){ toast('فقط عکس فیش قابل قبوله'); return; }
  toast('در حال فشرده‌سازی…');
  try {
    const blob = await compressReceipt(f);
    if (blob.size > 1024*1024){ toast('عکس خیلی بزرگه؛ یه اسکرین‌شات بگیر و اونو بفرست'); return; }
    if (draftReceipt) URL.revokeObjectURL(draftReceipt.url);
    draftReceipt = {blob, url:URL.createObjectURL(blob), origSize:f.size};
    render();
  } catch(e){ toast('این عکس خونده نشد؛ یه اسکرین‌شات بگیر و دوباره امتحان کن'); }
});
async function sendReceipt(btn){
  const p = payee(); if (!p || !draftReceipt) return;
  const box = btn.closest('.receipt-draft'), amount = parseNum(box.querySelector('#rdAmount').value), track = toLatin(box.querySelector('#rdTrack').value).trim();
  if (!amount){ toast('مبلغ واریزی رو بنویس'); box.querySelector('#rdAmount').focus(); return; }
  btn.disabled = true; btn.textContent = 'در حال ارسال…';
  const ext = draftReceipt.blob.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${me.id}/${newId()}.${ext}`;
  const up = await sb.storage.from('receipts').upload(path, draftReceipt.blob, {contentType:draftReceipt.blob.type, upsert:false});
  if (up.error){ btn.disabled = false; btn.textContent = 'ارسال فیش'; fail(up.error, 'receipt'); return; }
  const row = {id:newId(), participant_id:p.id, file_path:path, amount, tracking_code:track};
  const { error } = await sb.from('payments').insert(row);
  if (error){
    sb.storage.from('receipts').remove([path]).catch(() => {}); // don't leave an orphan file behind
    btn.disabled = false; btn.textContent = 'ارسال فیش'; fail(error, 'payment'); return;
  }
  S.payments[row.id] = {...row, status:'submitted', created_at:new Date().toISOString()};
  URL.revokeObjectURL(draftReceipt.url); draftReceipt = null;
  render(); toast('فیش ارسال شد؛ بعد از بررسی تأیید می‌شه');
}

/* staff: participants panel */
// which list the tab shows: the main participants, or the new ones who only asked for some items
let peopleKind = 'main';
function renderPeople(){
  const info = S.payInfo, everyone = Object.values(S.participants);
  const mains = everyone.filter(p => !isExtra(p)), extras = everyone.filter(isExtra);
  const showKinds = hasExtraCols || extras.length > 0;
  if (!showKinds) peopleKind = 'main';
  const xv = peopleKind === 'extra', all = xv ? extras : mains;
  const cur = curName(), money = n => n ? fmt(n) + ' ' + cur : '—';
  $('#payInfoCard').innerHTML = `<div class="payinfo ${info.card_number ? '' : 'warn'}${hasExtraCols ? ' wide' : ''}">
    <div><span class="k">کارت مقصد</span><b dir="ltr" class="num">${info.card_number ? esc(cardFmt(info.card_number)) : '—'}</b>${info.card_holder ? `<span class="sub">${esc(info.card_holder)}</span>` : ''}</div>
    <div><span class="k">مبلغ پیش‌فرض سهم</span><b>${info.default_amount ? fmt(info.default_amount) + ' ' + cur : '—'}</b>${hasGuestCols ? `<span class="sub">هر مهمان ${info.guest_amount ? fmt(info.guest_amount) + ' ' + cur : 'رایگان'}</span>` : ''}</div>
    ${hasExtraCols ? `<div><span class="k">اقلام</span><b>${ADDONS().length ? ADDONS().map(a => `${esc(a.name)} ${money(Number(a.price) || 0)}`).join(' · ') : '—'}</b><span class="sub">پذیرایی هر نفر ${money(info.catering_amount)}</span></div>` : ''}
    <div><span class="k">مهلت</span><b>${esc(info.deadline) || '—'}</b></div>
    <button class="btn small need-edit" type="button" data-act="edit-payinfo">ویرایش اطلاعات پرداخت</button>
    ${info.card_number ? '' : '<p class="sub bad" style="grid-column:1/-1;margin:0">تا شماره کارت وارد نشه، شرکت‌کننده‌ها جایی برای واریز نمی‌بینن.</p>'}
    ${hasGuestCols || !ready ? '' : '<p class="sub bad need-admin" style="grid-column:1/-1;margin:0">ستون‌های گرایش، تعداد مهمان و مبلغ هر مهمان هنوز در دیتابیس ساخته نشدن؛ دستور SQL مربوط به مهمان‌ها رو در SQL Editor سوپابیس اجرا کن و صفحه رو تازه کن.</p>'}
    ${hasExtraCols || !hasGuestCols || !ready ? '' : '<p class="sub bad need-admin" style="grid-column:1/-1;margin:0">ستون‌های اقلام و شرکت‌کننده‌های جدید هنوز در دیتابیس ساخته نشدن؛ دستور SQL مربوط رو در SQL Editor سوپابیس اجرا کن و صفحه رو تازه کن.</p>'}
  </div>`;
  const kt = $('#peopleKind'); kt.hidden = !showKinds;
  kt.innerHTML = showKinds ? [['main', 'شرکت‌کننده‌های اصلی', mains.length], ['extra', 'جدید (فقط اقلام)', extras.length]].map(([k, l, n]) =>
    `<button class="chip${k === peopleKind ? ' on' : ''}" type="button" role="tab" aria-selected="${k === peopleKind}" data-people-kind="${k}">${l}<small>${fmt(n)}</small></button>`).join('') : '';
  $('#pItems').hidden = !xv;
  if (xv){ // filter by item or catering; the options follow the item list
    const sel = $('#pItems'), cur0 = sel.value, opts = [['', 'اقلام و پذیرایی'], ...ADDONS().map(a => ['a:' + a.id, `${a.name} می‌خوان`]), ['cat-undecided', 'پذیرایی: تصمیم نشده'], ['cat-yes', 'با پذیرایی'], ['cat-no', 'بدون پذیرایی']];
    sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}"${v === cur0 ? ' selected' : ''}>${esc(l)}</option>`).join('');
  }
  $('#panel-people .toolbar [data-act="import-people"]').hidden = xv; // the sheet import fills the main list
  const states = all.map(p => [p, payState(p)]);
  // people sharing a number (across both lists): how many per number, and whose number's owner has already logged in
  const perNo = new Map(); everyone.filter(p => isPhoneId(p.student_no)).forEach(p => perNo.set(baseNo(p.student_no), (perNo.get(baseNo(p.student_no)) || 0) + 1));
  const linkedNos = new Set(everyone.filter(p => p.user_id && isPhoneId(p.student_no)).map(p => baseNo(p.student_no)));
  const isLinked = p => !!p.user_id || (isPhoneId(p.student_no) && linkedNos.has(baseNo(p.student_no)));
  const sum = k => states.reduce((a,[,s]) => a + s[k], 0);
  const cnt = k => states.filter(([,s]) => s.key === k).length;
  const left = () => fmt(states.reduce((a,[,s]) => a + Math.max(0, s.due - s.approved), 0));
  const guests = mains.reduce((a,p) => a + guestsOf(p), 0);
  if (!xv) $('#peopleSummary').innerHTML = all.length ? `<span>${fmt(all.length)} نفر</span>${guests ? `<span>مهمان ${fmt(guests)}</span><span>کل حضور ${fmt(all.length + guests)}</span>` : ''}<span>تسویه ${fmt(cnt('settled'))}</span><span>وصل‌شده ${fmt(all.filter(isLinked).length)}</span><span>تأییدشده ${fmt(sum('approved'))}</span><span>مانده ${left()}</span>${codeSummary(mains)}` : '';
  else {
    // catering is decided later: show how the head count comes out either way
    const n = f => extras.filter(f).length, yes = n(p => p.catering === 'yes'), no = n(p => p.catering === 'no'), und = extras.length - yes - no;
    const base = mains.length + guests;
    $('#peopleSummary').innerHTML = all.length ? `<span>${fmt(all.length)} نفر</span>${ADDONS().map(a => `<span>${esc(a.name)} ${fmt(n(p => (p.addons || []).includes(a.id)))}</span>`).join('')}${canAdmin && VC.status && n(p => codeOf(p.id)) ? `<span class="need-admin">کد رأی ${fmt(n(p => codeOf(p.id)))}</span>` : ''}`
      + `<span>پذیرایی: بله ${fmt(yes)} · نه ${fmt(no)} · تصمیم‌نشده ${fmt(und)}</span>`
      + `<span title="اصلی‌ها و مهمان‌هاشون، به‌علاوه‌ی جدیدهایی که پذیرایی دارن">کل پذیرایی ${fmt(base + yes)}${und ? ` (اگه تصمیم‌نشده‌ها هم بیان ${fmt(base + yes + und)})` : ''}</span>`
      + `<span>تسویه ${fmt(cnt('settled'))}</span><span>تأییدشده ${fmt(sum('approved'))}</span><span>مانده ${left()}</span>`
      + (und ? `<span class="bulk need-edit">همه‌ی تصمیم‌نشده‌ها: <button class="btn small" type="button" data-act="cater-bulk" data-v="yes">با پذیرایی</button><button class="btn small" type="button" data-act="cater-bulk" data-v="no">بدون پذیرایی</button></span>` : '') : '';
  }

  const queue = Object.values(S.payments).filter(x => x.status === 'submitted').sort((a,b) => ts(a.created_at) - ts(b.created_at));
  const nPeople = $('#nPeople'); nPeople.textContent = queue.length ? fmt(queue.length) + ' فیش' : fmt(everyone.length); nPeople.classList.toggle('alert', !!queue.length);
  $('#reviewQueue').innerHTML = queue.length ? `<div class="group" style="--c:var(--warn)"><div class="group-head"><h4>فیش‌های در انتظار بررسی</h4><span class="sum">${fmt(queue.length)}</span></div><div class="list">${queue.map(x => {
      const p = S.participants[x.participant_id] || {};
      return `<button class="rcpt" type="button" data-receipt="${esc(x.id)}" style="--c:var(--warn)">${receiptThumb(x)}<div><b>${esc(p.full_name || shownNo(p.student_no))}</b><span class="sub"><span dir="ltr">${esc(shownNo(p.student_no))}</span> · ${faDate(x.created_at)}</span></div><b class="num">${fmt(x.amount)}</b></button>`;
    }).join('')}</div></div>` : '';

  // major filter: options follow whatever majors are in the list; keep the current choice across re-renders
  const majors = [...new Set(all.map(p => (p.major || '').trim()).filter(Boolean))].sort((a,b) => a.localeCompare(b,'fa'));
  const ms = $('#pMajor'), mv = majors.includes(ms.value) ? ms.value : '';
  ms.hidden = !majors.length;
  ms.innerHTML = '<option value="">همه گرایش‌ها</option>' + majors.map(m => `<option${m === mv ? ' selected' : ''}>${esc(m)}</option>`).join('');
  const q = toLatin($('#pq').value).trim().toLowerCase(), f = $('#pFilter').value, fi = xv ? $('#pItems').value : '';
  const rows = states.filter(([p, s]) => {
    if (f === 'unclaimed' ? isLinked(p) : f && s.key !== f) return false;
    if (mv && (p.major || '').trim() !== mv) return false;
    if (fi && !(fi.startsWith('a:') ? (p.addons || []).includes(fi.slice(2)) : 'cat-' + (p.catering || 'undecided') === fi)) return false;
    if (q && !toLatin([p.full_name, p.student_no, p.major, p.note, canAdmin ? myCodes.get(p.id) : ''].join(' ')).toLowerCase().includes(q)) return false;
    return true;
  }).sort(([a,sa],[b,sb2]) => ['review','unpaid','partial','settled'].indexOf(sa.key) - ['review','unpaid','partial','settled'].indexOf(sb2.key) || (a.full_name||'').localeCompare(b.full_name||'','fa'));
  const meta = (p, s) => `${noPhone(p.student_no) ? '<span class="tag warn">بدون شماره</span>' : `<span class="tag" dir="ltr">${esc(baseNo(p.student_no))}</span>`}${perNo.get(baseNo(p.student_no)) > 1 ? `<span class="tag warn">شماره‌ی مشترک ${fmt(perNo.get(baseNo(p.student_no)))} نفر</span>` : ''}${p.major ? `<span class="tag">${esc(p.major)}</span>` : ''}${guestsOf(p) ? `<span class="tag">${fmt(guestsOf(p))} مهمان</span>` : ''}`
    + (xv ? (extraItems(p).length ? extraItems(p).map(x => `<span class="tag type" style="--c:var(--gold)">${esc(x)}</span>`).join('') : '<span class="tag warn">بدون قلم</span>') : '')
    + `<span class="tag ${s.key === 'settled' ? 'ok' : s.key === 'review' ? 'warn' : ''}">${STATE_LABEL[s.key]}</span>${s.extra ? `<span class="tag ok">+${fmt(s.extra)} اضافه</span>` : ''}${isLinked(p) ? '<span class="tag">حساب وصل شده</span>' : '<span class="tag">هنوز وارد نشده</span>'}`
    + (!xv && hasCodeStatus() && !codeOf(p.id) ? '<span class="tag warn need-admin">بدون کد رأی</span>' : '')
    + (canAdmin && myCodes.get(p.id) ? `<span class="tag need-admin" dir="ltr" title="کد رأی">🗳 ${esc(myCodes.get(p.id))}</span>` : '')
    + (xv ? `<span class="tag view-only">${CATERING[p.catering] || CATERING.undecided}</span><span class="cater-pick need-edit">پذیرایی:${[['yes','بله'],['no','نه'],['undecided','؟']].map(([v, l]) =>
        `<button class="chip ${v}${(p.catering || 'undecided') === v ? ' on' : ''}" type="button" data-act="cater" data-id="${esc(p.id)}" data-v="${v}" aria-pressed="${(p.catering || 'undecided') === v}" title="${CATERING[v]}">${l}</button>`).join('')}</span>` : '');
  // a new participant's row holds the catering buttons, so it can't itself be a <button>
  const row = (p, s) => `<${xv ? 'div role="button" tabindex="0"' : 'button type="button"'} class="row" data-person="${esc(p.id)}" style="--c:${STATE_COLOR[s.key]}">
        <span class="stripe"></span>
        <span><span class="t">${esc(p.full_name || '—')}</span><span class="meta">${meta(p, s)}</span></span>
        <span></span>
        <span class="amt"><b>${fmt(s.approved)}</b><small>از ${fmt(s.due)}</small></span>
      </${xv ? 'div' : 'button'}>`;
  $('#peopleList').innerHTML = !all.length
    ? (xv ? `<div class="empty"><h3>هنوز شرکت‌کننده‌ی جدیدی ثبت نشده</h3>کسانی که بعد از قطعی شدن لیست اصلی فقط بعضی اقلام (و شاید پذیرایی) می‌خوان، اینجا جدا ثبت می‌شن.<div class="chips need-edit"><button class="chip" type="button" data-act="add-person">افزودن شرکت‌کننده‌ی جدید</button></div></div>`
      : `<div class="empty"><h3>هنوز شرکت‌کننده‌ای ثبت نشده</h3>فایل اکسل یا CSV لیست ثبت‌نام رو وارد کن؛ کافیه ستون «شماره تماس» (یا «شماره دانشجویی») و «نام» داشته باشه. «گرایش» و «تعداد مهمان» هم خونده می‌شن.<div class="chips need-edit"><button class="chip" type="button" data-act="import-people">ورود از شیت</button><button class="chip" type="button" data-act="add-person">افزودن دستی</button></div></div>`)
    : rows.map(([p, s]) => row(p, s)).join('') || '<div class="empty">موردی با این فیلتر پیدا نشد.</div>';
}
/* ---------- voting codes ----------
   Every main participant gets one code to sign in to the vote. Only the person (and whoever shares their number) can
   read it, on their payment page and in the bot, and admins (to hand a code to someone who doesn't use the bot).
   Admins' loadMyCodes gets every code; the status function adds who has one even before that read.
   An optional module: off unless config.js sets votingCodes: true. */
const VOTING = cfg.votingCodes === true;
if (VOTING) $('#pkMainHint').textContent = 'سهم کامل، مهمان، کد رأی';
const VC = {status:null, timer:0, busy:false};
async function loadCodeStatus(){
  if (!canAdmin || !VOTING){ VC.status = null; return; }
  const { data, error } = await sb.rpc('voting_code_status');
  VC.status = error || !data ? null : {...data, has:new Set(data.has || [])};
}
function codeStatusShown(){ render(); if (codesDlg.open) renderCodes(); if (personDlg.open) renderPersonCode(); }
const reloadCodes = () => Promise.all([loadCodeStatus(), loadMyCodes()]);
function loadCodeStatusSoon(){ clearTimeout(VC.timer); VC.timer = setTimeout(() => reloadCodes().then(codeStatusShown), 800); }
const hasCodeStatus = () => !!VC.status;
const codeOf = id => !!VC.status && VC.status.has.has(id);
function codeSummary(mains){
  if (!canAdmin || !VOTING) return '';
  const s = VC.status, n = s ? mains.filter(p => s.has.has(p.id)).length : 0;
  return `<span class="need-admin"><button class="btn small" type="button" data-act="codes">${s ? `کد رأی: ${fmt(n)} از ${fmt(mains.length)}` : 'کدهای رأی‌گیری'}</button></span>`;
}
// the signed-in person's own codes (theirs and their number's), by participant id; row-level security returns nothing else
let myCodes = new Map();
async function loadMyCodes(){
  if (!me || !VOTING) return;
  const { data, error } = await sb.from('voting_codes').select('participant_id,code').eq('retired', false);
  myCodes = new Map(error || !data ? [] : data.filter(x => x.participant_id).map(x => [x.participant_id, x.code]));
}
function codeCard(p, own){
  const code = myCodes.get(p.id); if (!code) return '';
  return `<div class="pay-card code-card"><span class="k">کد ورود رأی‌گیری${own ? '' : ` ${esc(p.full_name || '')}`}</span><b class="num vcode" dir="ltr">${esc(code)}</b>
    <button class="btn small" type="button" data-copy="${esc(code)}" data-copy-label="کد رأی">کپی</button>
    <span class="sub">${own ? 'مخصوص خودته' : 'مخصوص همین نفره'}؛ به کس دیگه‌ای نده.</span>
    ${voteUrl() ? `<a class="btn primary vote-go" href="${esc(voteUrl())}" target="_blank" rel="noopener" data-ext-link>🗳 ورود به رأی‌گیری</a>` : ''}</div>`;
}
// the voting site, from config.js (https only)
const voteUrl = () => /^https:\/\//.test(cfg.voteUrl || '') ? cfg.voteUrl : '';
// inside Telegram a plain link stays in the Mini App's webview; openLink hands it to the browser instead
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a[data-ext-link]'); if (!a) return;
  try { const W = tgWA && window.Telegram && window.Telegram.WebApp; if (W && W.openLink){ e.preventDefault(); W.openLink(a.href); } } catch(_){}
});
/* bot payment link: for people who never sign in to the site. The bot shows them their amount and the card number
   (with copy buttons) and takes the receipt picture; it lands in the review queue like any other receipt. */
const payLinkOf = p => p && p.pay_token && botConfigured ? `https://t.me/${cfg.telegramBot.replace(/^@/, '')}?start=${p.pay_token}` : '';
function renderPayLink(){
  const box = $('#personPayLink'), p = editingPerson, link = payLinkOf(p);
  box.hidden = !link;
  box.innerHTML = link ? `<span class="k"><b>لینک پرداخت در ربات</b> <span class="hint">برای کسی که خودش وارد سایت نمی‌شه</span></span>
    <input class="field" dir="ltr" readonly value="${esc(link)}" aria-label="لینک پرداخت در ربات" data-select-all>
    <div class="row-btns"><button class="btn small primary" type="button" data-copy="${esc(link)}" data-copy-label="لینک">کپی لینک</button><button class="btn small" type="button" data-act="pay-link-new">لینک جدید</button></div>
    <span class="hint">این لینک رو براش بفرست: ربات مبلغ و شماره کارت رو با دکمه‌ی کپی نشونش می‌ده و عکس رسید رو ازش می‌گیره تا اینجا بررسی بشه. هر کی لینک رو داشته باشه می‌تونه برای این نفر رسید بفرسته؛ «لینک جدید» لینک قبلی رو باطل می‌کنه.</span>` : '';
}
async function newPayLink(btn){
  const p = editingPerson; if (!p || !canEdit) return;
  if (!confirm(`لینک پرداخت جدید برای «${p.full_name || ''}» ساخته بشه؟ لینک قبلی دیگه کار نمی‌کنه.`)) return;
  btn.disabled = true;
  const ok = await patch('participants', p.id, {pay_token:newId()});
  btn.disabled = false;
  if (ok){ editingPerson = S.participants[p.id]; renderPayLink(); toast('لینک جدید ساخته شد'); }
}
// admin: in the person dialog, whether they have a code, a new one in its place (the old one stops working), or taking
// it back. Main participants get one automatically; a new participant only when the admin gives it here.
function renderPersonCode(){
  const box = $('#personCode'), p = editingPerson;
  box.hidden = !canAdmin || !p || !VC.status;
  if (box.hidden){ box.innerHTML = ''; return; }
  const has = codeOf(p.id), code = myCodes.get(p.id);
  box.innerHTML = has ? `<span class="k">کد رأی</span>${code ? `<b class="num vcode" dir="ltr">${esc(code)}</b><button class="btn small" type="button" data-copy="${esc(code)}" data-copy-label="کد رأی">کپی</button>` : '<span class="tag ok">داره</span>'}
    <button class="btn small" type="button" data-act="code-reissue">کد جدید بده</button><button class="btn small danger" type="button" data-act="code-revoke">پس گرفتن کد</button>`
    : `<span class="tag ${isExtra(p) ? '' : 'warn'}">کد رأی نداره</span><button class="btn small" type="button" data-act="code-reissue">یه کد بهش بده</button>`;
}
const VC_ERR = {NO_FREE_CODES:'کد آزادی نمونده؛ اول از «کدهای رأی‌گیری» کدهای بیشتری اضافه کن.', NOT_FOUND:'این شرکت‌کننده پیدا نشد؛ صفحه رو تازه کن.', FORBIDDEN:'فقط مدیر می‌تونه کدها رو مدیریت کنه.'};
const vcErr = e => { const m = `${e && e.code || ''} ${e && e.message || ''}`; const k = Object.keys(VC_ERR).find(x => m.includes(x));
  return k ? VC_ERR[k] : /PGRST202|42883|voting/.test(m) ? 'بخش کدهای رأی هنوز در دیتابیس ساخته نشده؛ دستور SQL مربوط رو اجرا کن.' : 'انجام نشد؛ دوباره امتحان کن.'; };
async function reissueCode(btn){
  const p = editingPerson; if (!p || !canAdmin) return;
  const had = codeOf(p.id);
  if (had && !confirm(`کد فعلی «${p.full_name || ''}» باطل بشه و یه کد جدید بگیره؟ کد قبلی دیگه به کسی داده نمی‌شه.`)) return;
  btn.disabled = true;
  const { error } = await sb.rpc('reissue_voting_code', {p_participant:p.id});
  btn.disabled = false;
  if (error){ console.error('reissue_voting_code', error); toast(vcErr(error)); return; }
  await reloadCodes(); renderPersonCode(); render();
  toast(had ? 'کد جدید داده شد؛ کد قبلی باطل شد' : 'کد داده شد');
}
async function revokeCode(btn){
  const p = editingPerson; if (!p || !canAdmin || !codeOf(p.id)) return;
  if (!confirm(`کد رأی «${p.full_name || ''}» پس گرفته بشه؟ کدش باطل می‌شه و دیگه به کسی داده نمی‌شه.`)) return;
  btn.disabled = true;
  const { error } = await sb.rpc('revoke_voting_code', {p_participant:p.id});
  btn.disabled = false;
  if (error){ console.error('revoke_voting_code', error); toast(vcErr(error)); return; }
  await reloadCodes(); renderPersonCode(); render();
  toast('کد پس گرفته شد');
}
const codesDlg = $('#codesDlg');
async function openCodes(){
  if (!canAdmin) return;
  $('#vcOut').hidden = true;
  renderCodes(); if (!codesDlg.open) codesDlg.showModal();
  await loadCodeStatus(); renderCodes();
}
function renderCodes(){
  const s = VC.status, mains = Object.values(S.participants).filter(p => !isExtra(p));
  const without = s ? mains.filter(p => !s.has.has(p.id)) : [];
  $('#vcStats').innerHTML = s ? `<span>کدهای فعال ${fmt(s.total)}</span><span>تخصیص‌داده ${fmt(s.assigned)}</span><span>آزاد ${fmt(s.free)}</span>${s.retired ? `<span>باطل‌شده ${fmt(s.retired)}</span>` : ''}<span>اصلی‌های بدون کد ${fmt(without.length)}</span>`
    : '<span class="bad">بخش کدهای رأی هنوز در دیتابیس ساخته نشده (یا جواب نداد)؛ دستور SQL مربوط رو در SQL Editor سوپابیس اجرا کن.</span>';
  $('#vcMissing').innerHTML = without.length && without.length <= 40 ? `<p class="sub">بدون کد: ${esc(without.map(p => p.full_name || shownNo(p.student_no)).join('، '))}</p>` : '';
  codesDlg.querySelectorAll('button[data-act^="codes-"], #vcFile').forEach(b => { b.disabled = VC.busy || !s; });
  const assign = codesDlg.querySelector('[data-act="codes-assign"]'); if (s && !without.length) assign.disabled = true;
}
function codesOut(html, bad){ const o = $('#vcOut'); o.hidden = false; o.className = 'sub' + (bad ? ' bad' : ''); o.innerHTML = html; }
async function codesBusy(fn){ VC.busy = true; renderCodes(); try { await fn(); } finally { VC.busy = false; renderCodes(); render(); } }
// codes from the file: every cell that looks like a code (capital letters and digits; a header such as "code" doesn't)
async function importCodes(file){
  let text = '';
  try {
    if (/\.xlsx?$/i.test(file.name) && window.XLSX){ const wb = XLSX.read(await file.arrayBuffer()); text = wb.SheetNames.map(n => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n'); }
    else text = await file.text();
  } catch(e){ toast('فایل خونده نشد'); return; }
  const codes = [...new Set(toLatin(text).split(/[\s,;"'\t]+/).filter(x => /^[A-Z0-9]{4,16}$/.test(x) && x !== 'CODE'))];
  if (!codes.length){ codesOut('کدی توی این فایل پیدا نشد. هر کد باید ۴ تا ۱۶ حرف بزرگ انگلیسی یا رقم باشه.', true); return; }
  if (codes.length > 5000){ codesOut('حداکثر ۵۰۰۰ کد در هر بار.', true); return; }
  await codesBusy(async () => {
    const { data, error } = await sb.rpc('add_voting_codes', {p_codes:codes});
    if (error){ console.error('add_voting_codes', error); codesOut(esc(vcErr(error)), true); return; }
    await reloadCodes();
    codesOut(`${fmt(data.added)} کد جدید اضافه شد${data.existing ? `؛ ${fmt(data.existing)} تا از قبل بودن` : ''}${data.invalid ? `؛ ${fmt(data.invalid)} تا نامعتبر بودن` : ''}.`);
  });
}
async function assignCodes(){
  const s = VC.status; if (!s) return;
  if (!confirm('به همه‌ی شرکت‌کننده‌های اصلی‌ای که کد ندارن، یک کد تصادفی داده بشه؟')) return;
  await codesBusy(async () => {
    const { data, error } = await sb.rpc('assign_voting_codes');
    if (error){ console.error('assign_voting_codes', error); codesOut(esc(vcErr(error)), true); return; }
    await reloadCodes();
    codesOut(`به ${fmt(data.assigned)} نفر کد داده شد.` + (data.without ? ` <span class="bad">${fmt(data.without)} نفر هنوز کد ندارن چون کد آزاد کم بود؛ کدهای بیشتری اضافه کن.</span>` : ` ${fmt(data.free)} کد آزاد مونده.`), !!data.without);
  });
}
const VC_SEND_ERR = {no_telegram:'حسابت به تلگرام وصل نیست (با ایمیل وارد شدی)؛ نمونه فقط برای حساب تلگرامی فرستاده می‌شه.', start_bot_first:'اول خودت ربات رو توی تلگرام Start کن، بعد دوباره امتحان کن.',
  setup_missing:'بخش کدهای رأی هنوز در دیتابیس ساخته نشده؛ دستور SQL مربوط رو اجرا کن.', not_admin:'فقط مدیر می‌تونه کدها رو بفرسته.', telegram_failed:'تلگرام پیام رو قبول نکرد.'};
async function sendCodes(test){
  const s = VC.status; if (!s) return;
  if (!test && !confirm(`ربات کد رأی هر شرکت‌کننده رو برای خودش بفرسته؟ (به ${fmt(s.assigned)} نفری که کد دارن، هر کدوم که با تلگرام وارد سایت شده)`)) return;
  await codesBusy(async () => {
    const { data, error } = await sb.functions.invoke('telegram-auth', {body:{send_codes:{test:!!test, lang:I18N.lang}}});
    if (error){ let b = {}; try { b = await error.context.json(); } catch(e){} console.error('send_codes', b); codesOut(esc(VC_SEND_ERR[b.error] || 'تابع telegram-auth جواب درست نداد؛ مطمئن شو نسخه‌ی جدیدش Deploy شده.'), true); return; }
    if (test){ toast('نمونه برات فرستاده شد؛ توی تلگرام ببینش'); return; }
    const d = data || {};
    codesOut(`کد ${fmt(d.reached || 0)} نفر فرستاده شد${d.accounts ? ` (به ${fmt(d.sent || 0)} حساب تلگرام از ${fmt(d.accounts)})` : ''}.`
      + (d.unreachable ? ` ${fmt(d.unreachable)} حساب ربات رو بلاک کردن یا Start نکردن.` : '')
      + (s.assigned > (d.people || 0) ? ` ${fmt(s.assigned - (d.people || 0))} نفر هنوز با تلگرام وارد سایت نشدن؛ وقتی وارد بشن یا ربات رو باز کنن، کدشون رو می‌بینن.` : ''));
  });
}
$('#vcFile').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importCodes(f); });

// catering for a new participant, from the buttons on their row; or for everyone still undecided at once
async function setCatering(id, v){
  const p = S.participants[id]; if (!p || !canEdit || p.catering === v) return;
  if (await patch('participants', id, {catering:v})) toast(`${p.full_name || 'شرکت‌کننده'}: ${CATERING[v]}`);
}
async function cateringBulk(v){
  const ids = Object.values(S.participants).filter(p => isExtra(p) && (p.catering || 'undecided') === 'undecided').map(p => p.id);
  if (!ids.length || !canEdit) return;
  if (!confirm(`پذیرایی برای ${fmt(ids.length)} شرکت‌کننده‌ی جدیدی که هنوز تصمیم نگرفتی «${v === 'yes' ? 'بله' : 'نه'}» بشه؟`)) return;
  ids.forEach(id => { S.participants[id] = {...S.participants[id], catering:v}; }); render();
  const { error } = await sb.from('participants').update({catering:v}).in('id', ids);
  if (error){ fail(error, 'participants'); await resync('participants'); return; }
  toast('ذخیره شد');
}

/* participant dialog */
const personDlg = $('#personDlg'), personForm = $('#personForm'); let editingPerson = null;
function openPerson(id, kind){
  if (!ready || (!id && !canEdit)) return;
  editingPerson = id ? S.participants[id] : null;
  const p = editingPerson || {student_no:'', full_name:'', amount:null, verify_code:'', note:'', major:'', guests:0, kind:kind || 'main', addons:[], catering:'undecided'};
  const f = personForm.elements;
  f.student_no.value = shownNo(p.student_no); f.full_name.value = p.full_name || '';
  f.major.value = p.major || ''; f.guests.value = guestsOf(p) ? fmt(guestsOf(p)) : '';
  $('#personExtra').hidden = !hasGuestCols;
  $('#personKind').hidden = !hasExtraCols;
  f.kind.value = isExtra(p) ? 'extra' : 'main';
  const mine = Array.isArray(p.addons) ? p.addons : [];
  $('#personAddons').innerHTML = ADDONS().map(a => `<label class="check"><input type="checkbox" name="addon" value="${esc(a.id)}"${mine.includes(a.id) ? ' checked' : ''}> ${esc(a.name)}</label>`).join('')
    || '<span class="hint">هنوز قلمی تعریف نشده؛ از «ویرایش اطلاعات پرداخت» اضافه کن.</span>';
  f.catering.value = p.catering || 'undecided';
  f.amount.value = p.amount !== null && p.amount !== undefined ? fmt(p.amount) : '';
  syncPersonKind();
  f.verify_code.value = p.verify_code || ''; f.note.value = p.note || '';
  $('#personDlgTitle').textContent = editingPerson ? (p.full_name || 'شرکت‌کننده') : isExtra(p) ? 'افزودن شرکت‌کننده‌ی جدید (فقط اقلام)' : 'افزودن شرکت‌کننده';
  $('#personDel').hidden = !editingPerson;
  const linked = p.user_id ? (S.members[p.user_id]?.display_name || 'متصل') : '';
  const sharing = editingPerson ? Object.values(S.participants).filter(x => x.id !== p.id && sameNumber(x.student_no, p.student_no) && isPhoneId(p.student_no)) : [];
  const viaShared = !p.user_id && sharing.find(x => x.user_id);
  $('#personLink').innerHTML = editingPerson ? (p.user_id
    ? `<span class="tag ok">حساب تلگرام: ${esc(linked)}</span> <button class="btn small danger need-admin" type="button" data-act="unlink-person">جدا کردن حساب</button>`
    : viaShared ? `<span class="tag ok">صاحب شماره (حساب «${esc(S.members[viaShared.user_id]?.display_name || viaShared.full_name || '')}») براش پرداخت می‌کنه</span>`
    : noPhone(p.student_no) ? '<span class="tag warn">بدون شماره؛ تا شماره‌ش رو بالا ننویسی، خودش نمی‌تونه وارد سایت بشه</span>'
    : '<span class="tag">هنوز وارد نشده</span>')
    + (sharing.length ? ` <span class="tag warn">با همین شماره: ${esc(sharing.map(x => x.full_name || '—').join('، '))}</span>` : '') : '';
  renderPersonPays();
  renderPersonCode();
  renderPayLink();
  resetManualPay();
  $('#personMeta').textContent = metaLine(editingPerson);
  lockForm(personForm);
  if (!personDlg.open) personDlg.showModal();
  hydrateThumbs();
}
// the amount placeholder shows what "empty = automatic" works out to for the guests (or items) typed in
const personDraft = () => { const f = personForm.elements; return {guests:parseNum(f.guests.value), kind:hasExtraCols && f.kind.value === 'extra' ? 'extra' : 'main',
  addons:[...personForm.querySelectorAll('input[name="addon"]:checked')].map(i => i.value), catering:f.catering.value}; };
function updateAutoDue(){ personForm.elements.amount.placeholder = `خودکار: ${fmt(autoDue(personDraft()))}`; }
// a new participant has items and catering instead of guests
function syncPersonKind(){ const x = isExtra(personDraft()); $('#personItems').hidden = !x; $('#guestsWrap').hidden = x; updateAutoDue(); }
function renderPersonPays(){
  const ps = editingPerson ? paysOf(editingPerson.id) : [];
  $('#personPays').innerHTML = ps.length ? `<div class="lbl">فیش‌ها<div class="list">${ps.map(x => `<button class="rcpt" type="button" data-receipt="${esc(x.id)}" style="--c:${PAY_COLOR[x.status]}">${receiptThumb(x)}<div><b>${fmt(x.amount)}</b><span class="sub">${faDate(x.created_at)}</span></div><span class="tag" style="color:${PAY_COLOR[x.status]}">${PAY_STATUS[x.status]}</span></button>`).join('')}</div></div>` : '';
  hydrateThumbs();
}
function resetManualPay(){
  const box = $('#manualPay'), f = personForm.elements, rem = editingPerson ? payState(editingPerson).remaining : 0;
  box.hidden = !editingPerson; box.open = false; $('#mpErr').hidden = true;
  f.mp_amount.value = rem ? fmt(rem) : ''; f.mp_track.value = ''; f.mp_note.value = ''; f.mp_file.value = '';
}
// The finance team records a payment for someone (cash, or a receipt sent to them directly):
// the same payments row a participant would create, then approved through review_payment,
// so the budget contribution and the person's status work exactly as for an uploaded receipt.
async function recordPayment(btn){
  const p = editingPerson; if (!p || !canEdit) return;
  const f = personForm.elements, amount = parseNum(f.mp_amount.value), file = f.mp_file.files[0], err = $('#mpErr');
  const track = toLatin(f.mp_track.value).trim(), note = f.mp_note.value.trim() || 'ثبت دستی توسط تیم مالی';
  if (!amount){ f.mp_amount.focus(); toast('مبلغ رو بنویس'); return; }
  const label = btn.textContent; btn.disabled = true; btn.textContent = 'در حال ثبت…'; err.hidden = true;
  const id = newId();
  let path = NO_FILE + id, step = 'upload';
  try {
    if (file){
      const blob = await compressReceipt(file);
      path = `${me.id}/${id}.${blob.type === 'image/webp' ? 'webp' : 'jpg'}`;
      const up = await sb.storage.from('receipts').upload(path, blob, {contentType:blob.type, upsert:false});
      if (up.error) throw up.error;
    }
    step = 'insert';
    const ins = await sb.from('payments').insert({id, participant_id:p.id, file_path:path, amount, tracking_code:track});
    if (ins.error){ if (file) sb.storage.from('receipts').remove([path]).catch(() => {}); throw ins.error; }
    step = 'approve';
    const rv = await sb.rpc('review_payment', {p_id:id, p_status:'approved', p_note:note, p_amount:amount});
    await resync('payments'); await resync('funds');
    if (rv.error) throw rv.error;
    if (editingPerson === p){ renderPersonPays(); resetManualPay(); }
    toast(`پرداخت ${money(amount)} برای «${p.full_name || p.student_no}» ثبت و تأیید شد`);
  } catch(e){
    console.error('manual payment', step, e);
    const m = String(e && (e.message || e) || ''), denied = /row-level security|permission denied|42501|not authorized|unauthorized|FORBIDDEN/i.test(m);
    err.textContent = step === 'approve' ? 'پرداخت ثبت شد ولی تأیید نشد؛ از «فیش‌های در انتظار بررسی» تأییدش کن.'
      : (step === 'upload' && !/storage|bucket|row-level|policy/i.test(m) ? 'این عکس خونده یا آپلود نشد؛ یه اسکرین‌شات ازش بگیر و دوباره امتحان کن.'
      : denied ? 'دیتابیس هنوز به تیم مالی اجازه‌ی ثبت پرداخت برای بقیه رو نمی‌ده؛ دستور SQL دسترسی ثبت پرداخت (برای مدیر و ویرایشگر) رو در SQL Editor سوپابیس اجرا کن و دوباره امتحان کن.'
      : 'ثبت نشد: ' + m);
    err.hidden = false;
  } finally { btn.disabled = false; btn.textContent = label; }
}
// Enter inside the payment fields would otherwise submit (and close) the whole person form
$('#manualPay').addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); recordPayment($('#manualPay [data-act="manual-pay"]')); } });
personForm.addEventListener('input', e => { liveFormat(e); if (e.target.name === 'guests') updateAutoDue(); });
personForm.addEventListener('change', e => { const n = e.target.name; if (n === 'kind') syncPersonKind(); else if (n === 'addon' || n === 'catering') updateAutoDue(); });
// most of the list is phone numbers (imported from a registration sheet)?
const phoneList = () => { const ids = Object.values(S.participants).map(p => p.student_no); return ids.length > 0 && ids.filter(isPhoneId).length * 2 >= ids.length; };
personForm.addEventListener('submit', async e => {
  e.preventDefault();
  const f = personForm.elements, typed = f.student_no.value.trim(), plain = normNo(typed), phone = canonPhone(typed);
  const othersKeys = () => new Set(Object.values(S.participants).filter(x => !editingPerson || x.id !== editingPerson.id).map(x => x.student_no));
  let no;
  if (!typed){
    // no number (yet): kept under "~<name>"; they can't log in until one is added
    const nm = f.full_name.value.trim();
    if (!nm){ f.full_name.focus(); toast('دست‌کم اسم رو بنویس'); return; }
    no = editingPerson && noPhone(editingPerson.student_no) ? editingPerson.student_no : freeKey(noPhoneKey(nm), othersKeys());
  } else if (!phone && phoneList()){
    f.student_no.focus(); toast('این شماره موبایل درستی نیست؛ اگه شماره نداره، خالی بذار'); return;
  } else {
    // store phones as 09xxxxxxxxx like the import does; a bare 10-digit "9…" is only taken as a phone in a phone-based list
    const base = baseNo(phone && (!/^9\d{9}$/.test(plain) || phoneList()) ? phone : plain);
    no = base;
    if (editingPerson && sameNumber(editingPerson.student_no, base)) no = editingPerson.student_no; // number unchanged: keep its key
    else {
      const others = Object.values(S.participants).filter(x => sameNumber(x.student_no, base) && (!editingPerson || x.id !== editingPerson.id));
      if (others.length){
        // only a phone can be shared; a student number belongs to one person
        if (!isPhoneId(base)){ toast(`این شماره قبلاً برای «${others[0].full_name || base}» ثبت شده`); return; }
        if (!confirm(`این شماره برای «${others.map(x => x.full_name || '—').join('، ')}» هم ثبت شده.\nاگه واقعاً با یک شماره ثبت‌نام کردن، هر کدوم جدا ذخیره می‌شه و صاحب شماره بعد از ورود می‌تونه بینشون جابه‌جا بشه و برای هر کدوم جدا پرداخت کنه. ادامه؟`)) return;
        no = freeKey(base, new Set(Object.values(S.participants).map(x => x.student_no)));
      }
    }
  }
  const amt = f.amount.value.trim() ? parseNum(f.amount.value) : null;
  const obj = {id: editingPerson ? editingPerson.id : newId(), student_no:no, full_name:f.full_name.value.trim(), amount:amt,
    verify_code: last4(f.verify_code.value) || null, note:f.note.value.trim()};
  if (hasGuestCols){ obj.major = f.major.value.trim(); obj.guests = Math.min(50, parseNum(f.guests.value)); }
  if (hasExtraCols){
    obj.kind = f.kind.value === 'extra' ? 'extra' : 'main';
    if (obj.kind === 'extra'){
      Object.assign(obj, {addons:personDraft().addons, catering:f.catering.value});
      if (hasGuestCols) obj.guests = 0;
      // moving someone off the main list: the database also takes back their voting code
      if (editingPerson && !isExtra(editingPerson) && !confirm(`«${obj.full_name || obj.student_no}» از لیست اصلی به شرکت‌کننده‌های جدید منتقل بشه؟${[guestsOf(editingPerson) && ' مهمان‌هاش صفر می‌شه', VOTING && ' کد رأی‌ش (اگه داشته) باطل می‌شه'].filter(Boolean).join(' و') + '.'}`)) return;
    }
  }
  // user_id is deliberately not sent: if the person linked their account while this dialog was open,
  // re-sending the old (empty) value would silently unlink them
  personDlg.close(); if (await upsert('participants', obj)) toast('ذخیره شد');
});
$('#personDel').addEventListener('click', async () => {
  const p = editingPerson; if (!p) return;
  const pays = paysOf(p.id);
  if (!confirm(`«${p.full_name || p.student_no}» حذف بشه؟` + (pays.length ? `\n${fmt(pays.length)} فیش ثبت‌شده‌ش هم حذف می‌شه (سهم‌های تأییدشده در بودجه می‌مونن).` : ''))) return;
  personDlg.close(); pays.forEach(x => delete S.payments[x.id]);
  if (!await del('participants', p.id)){ resync('payments'); return; }
  toast('حذف شد');
  // if the number's first entry went, the next person on that number takes over the plain number (logins look that one up)
  const next = Object.values(S.participants).filter(x => sameNumber(x.student_no, p.student_no)).sort((a,b) => shareNo(a.student_no) - shareNo(b.student_no))[0];
  if (p.student_no === baseNo(p.student_no) && next && next.student_no !== p.student_no) patch('participants', next.id, {student_no:p.student_no});
});
async function unlinkPerson(){
  const p = editingPerson; if (!p || !confirm('حساب تلگرام از این شماره جدا بشه؟ بعدش هر کسی می‌تونه دوباره با این شماره وارد بشه.')) return;
  personDlg.close();
  if (await patch('participants', p.id, {user_id:null})) toast('حساب جدا شد');
}

/* receipt review dialog */
const receiptDlg = $('#receiptDlg'); let reviewing = null;
async function openReceipt(id){
  const x = S.payments[id]; if (!x) return; reviewing = x;
  const p = S.participants[x.participant_id] || {}, st = payState(p.id ? p : {id:null});
  $('#rcTitle').textContent = `فیش ${p.full_name || shownNo(p.student_no)}`;
  $('#rcInfo').innerHTML = `<span dir="ltr" class="tag">${esc(shownNo(p.student_no) || 'بدون شماره')}</span> <span class="tag" style="color:${PAY_COLOR[x.status]}">${PAY_STATUS[x.status]}</span>
    <span class="sub">سهم ${fmt(p.id ? dueOf(p) : 0)} · تأییدشده قبلی ${fmt(st.approved)}${x.tracking_code ? ` · پیگیری <span dir="ltr">${esc(x.tracking_code)}</span>` : ''} · ارسال ${faDate(x.created_at)}${String(x.file_path || '').startsWith('bot/') ? ' · از ربات تلگرام' : ''}</span>
    ${x.reviewed_by ? `<span class="sub">بررسی: ${esc(x.reviewed_by)}</span>` : ''}`;
  $('#rcAmount').value = fmt(x.amount); $('#rcAmount').disabled = !canEdit || (x.status === 'approved' && !canAdmin);
  $('#rcNote').value = x.review_note || ''; $('#rcNote').disabled = !canEdit;
  $('#rcApprove').hidden = x.status === 'approved';
  $('#rcReject').hidden = x.status !== 'submitted';
  $('#rcReset').hidden = x.status === 'submitted';
  $('#rcReset').classList.toggle('need-admin', x.status === 'approved');
  $('#rcAmountSave').hidden = x.status !== 'approved';
  const pv = $('#rcPreview'); pv.innerHTML = '<span style="padding:24px;color:var(--muted)">در حال بارگذاری…</span>';
  if (!receiptDlg.open) receiptDlg.showModal();
  if (!hasFile(x)){ pv.innerHTML = '<span style="padding:24px;color:var(--muted)">بدون عکس فیش؛ تیم مالی دستی ثبتش کرده</span>'; return; }
  const [url] = await signedUrls([x.file_path], 'receipts');
  if (reviewing !== x) return;
  pv.innerHTML = url ? `<a href="${esc(url)}" target="_blank" rel="noopener" style="padding:0"><img src="${esc(url)}" alt="فیش"></a>` : '<span style="padding:24px;color:var(--bad)">فایل پیدا نشد</span>';
}
let reviewBusy = false;
async function review(status){
  const x = reviewing; if (!x || reviewBusy) return;
  const amount = parseNum($('#rcAmount').value), note = $('#rcNote').value.trim();
  if (status === 'rejected' && !note && !confirm('بدون نوشتن دلیل رد بشه؟ (دلیل برای خود شخص نمایش داده می‌شه)')) return;
  // approving adds the amount to the budget, so a double click must not send the request twice
  const btns = receiptDlg.querySelectorAll('.dlg-foot button');
  reviewBusy = true; btns.forEach(b => b.disabled = true);
  let error;
  try { ({ error } = await sb.rpc('review_payment', {p_id:x.id, p_status:status, p_note:note, p_amount:amount || null})); }
  catch(e){ error = e; }
  finally { reviewBusy = false; btns.forEach(b => b.disabled = false); }
  if (error){
    const m = error.message || '';
    toast(/ADMIN_ONLY/.test(m) ? 'برگرداندن فیش تأییدشده فقط کار مدیره' : /NO_AMOUNT/.test(m) ? 'مبلغ فیش رو وارد کن' : /FORBIDDEN/.test(m) ? 'دسترسی بررسی فیش رو نداری' : 'ثبت نشد؛ دوباره امتحان کن');
    return;
  }
  receiptDlg.close();
  await Promise.all([reload('payments'), reload('funds')]); render();
  toast(status === 'approved' ? 'تأیید شد و به سهم نفرات اضافه شد' : status === 'rejected' ? 'فیش رد شد' : 'به حالت بررسی برگشت');
}
$('#rcApprove').addEventListener('click', () => review('approved'));
$('#rcReject').addEventListener('click', () => review('rejected'));
$('#rcReset').addEventListener('click', () => review('submitted'));
$('#rcAmountSave').addEventListener('click', () => review('approved'));
$('#rcAmount').addEventListener('input', liveFormat);
// Deleting a receipt (admin only). An approved one is first returned to review through review_payment, exactly like
// «برگرداندن به بررسی», so its amount leaves the budget the usual way; the database only deletes unapproved receipts.
$('#rcDelete').addEventListener('click', async () => {
  const x = reviewing; if (!x || reviewBusy || !canAdmin) return;
  const p = S.participants[x.participant_id] || {}, approved = x.status === 'approved';
  if (!confirm(`فیش ${money(x.amount)} «${p.full_name || shownNo(p.student_no) || '—'}» برای همیشه حذف بشه؟`
    + (approved ? '\nاین فیش تأیید شده؛ مبلغش از سهم نفرات در بودجه هم کم می‌شه.' : ''))) return;
  const btns = receiptDlg.querySelectorAll('.dlg-foot button');
  reviewBusy = true; btns.forEach(b => b.disabled = true);
  let step = 'revert', error = null, gone = false;
  try {
    if (approved) ({ error } = await sb.rpc('review_payment', {p_id:x.id, p_status:'submitted', p_note:x.review_note || '', p_amount:null}));
    if (!error){
      step = 'delete';
      let data; ({ data, error } = await sb.from('payments').delete().eq('id', x.id).select('id'));
      gone = !error && !!data && data.length > 0;
    }
  } catch(e){ error = e; }
  finally { reviewBusy = false; btns.forEach(b => b.disabled = false); }
  try { await Promise.all([reload('payments'), approved ? reload('funds') : null]); } catch(e){ console.error('reload', e); }
  render();
  if (!gone){
    console.error('delete receipt', step, error);
    const back = approved && step === 'delete' ? 'فیش به حالت بررسی برگشت ولی ' : '';
    // row-level security drops a forbidden delete silently: no error, nothing deleted
    if (step === 'delete' && !error) toast(back + 'حذف نشد؛ دیتابیس هنوز اجازه‌ی حذف فیش رو نمی‌ده (دستور SQL حذف فیش رو در SQL Editor اجرا کن)');
    else if (back) toast(back + 'حذف نشد؛ دوباره امتحان کن');
    else fail(error, 'receipt');
    if (back && S.payments[x.id]) openReceipt(x.id);
    return;
  }
  receiptDlg.close();
  if (hasFile(x)){ const { error: fileErr } = await sb.storage.from('receipts').remove([x.file_path]); if (fileErr) console.warn(fileErr); }
  toast('فیش حذف شد');
});

/* payment info dialog */
const payInfoDlg = $('#payInfoDlg'), payInfoForm = $('#payInfoForm');
function openPayInfo(){
  const i = S.payInfo, f = payInfoForm.elements;
  f.card_number.value = cardFmt(i.card_number); f.card_holder.value = i.card_holder; f.bank.value = i.bank; f.sheba.value = i.sheba;
  f.default_amount.value = i.default_amount ? fmt(i.default_amount) : ''; f.deadline.value = i.deadline; f.note.value = i.note;
  f.guest_amount.value = i.guest_amount ? fmt(i.guest_amount) : ''; $('#guestAmtWrap').hidden = !hasGuestCols;
  f.catering_amount.value = i.catering_amount ? fmt(i.catering_amount) : ''; $('#extraAmtWrap').hidden = !hasExtraCols;
  $('#addonRows').innerHTML = ''; ADDONS().forEach(addonRow);
  lockForm(payInfoForm); payInfoDlg.showModal();
}
payInfoForm.addEventListener('input', liveFormat);
// one row per item: name, price, part of the main share; a removed item is dropped from the list (people who chose it
// keep its id, which no longer counts)
function addonRow(a = {}){
  const row = document.createElement('div'); row.className = 'addon-row'; row.dataset.id = a.id || newId().slice(0, 8);
  row.innerHTML = `<input class="field" data-k="name" maxlength="40" placeholder="اسم قلم" aria-label="اسم قلم" value="${esc(a.name || '')}">
    <input class="field" data-k="price" inputmode="numeric" placeholder="قیمت" aria-label="قیمت" value="${a.price ? fmt(a.price) : ''}">
    <label class="check"><input type="checkbox" data-k="main"${a.main ? ' checked' : ''}> جزو سهم</label>
    <button class="icon-btn need-edit" type="button" data-act="addon-del" aria-label="حذف قلم">×</button>`;
  $('#addonRows').appendChild(row); lockForm(payInfoForm);
  return row;
}
payInfoForm.addEventListener('submit', async e => {
  e.preventDefault();
  const f = payInfoForm.elements, card = toLatin(f.card_number.value).replace(/\D/g, '');
  if (card && card.length !== 16){ toast('شماره کارت باید ۱۶ رقم باشه'); f.card_number.focus(); return; }
  const fields = {card_number:card, card_holder:f.card_holder.value.trim(), bank:f.bank.value.trim(),
    sheba:toLatin(f.sheba.value).replace(/\s/g, '').toUpperCase(), default_amount:parseNum(f.default_amount.value), deadline:f.deadline.value.trim(), note:f.note.value.trim()};
  if (hasGuestCols) fields.guest_amount = parseNum(f.guest_amount.value);
  if (hasExtraCols){
    fields.catering_amount = parseNum(f.catering_amount.value);
    fields.addons = [...$('#addonRows').querySelectorAll('.addon-row')].map(r => ({id:r.dataset.id, name:r.querySelector('[data-k="name"]').value.trim(),
      price:parseNum(r.querySelector('[data-k="price"]').value), main:r.querySelector('[data-k="main"]').checked})).filter(a => a.name);
  }
  payInfoDlg.close(); S.payInfo = {...S.payInfo, ...fields}; render();
  const { error } = await sb.from('payment_info').update(fields).eq('id', 1);
  if (error){ fail(error, 'payment_info'); await loadPayInfo(); render(); } else toast('اطلاعات پرداخت ذخیره شد');
});

/* import from sheet */
const importDlg = $('#importDlg'); let importRows = null;
const normHead = h => String(h ?? '').replace(/[\s\u200c_\-\/\\().:*؟?]/g, '').replace(/ي/g, 'ی').replace(/ك/g, 'ک').toLowerCase();
// exact: the whole normalized header; has: a distinctive word anywhere in it, for long Google Form questions
// like "شماره تماس (ترجیحاً موبایل)". "نام" is only matched exactly: it's also inside "نام خانوادگی", "ثبت‌نام"…
const HEADS = {
  student_no:{exact:['شمارهدانشجویی','شمارهدانشجوئی','شدانشجویی','کددانشجویی','شمارهیدانشجویی','studentno','studentid','student','stdno'], has:['شمارهدانشجو','کددانشجو']},
  full_name:{exact:['نامونامخانوادگی','نامکامل','fullname','name','اسم'], has:['نامونامخانوادگی','نامدانشجو','نامفارغالتحصیل']},
  first:{exact:['نام','firstname','first']},
  last:{exact:['نامخانوادگی','فامیلی','lastname','last','family']},
  phone:{exact:['همراه'], has:['موبایل','تماس','تلفن','شمارههمراه','mobile','phone']},
  guests:{has:['مهمان','همراهان','تعدادهمراه','guest']},
  major:{has:['گرایش','رشته','major']},
  amount:{exact:['مبلغ','سهم','مبلغسهم','amount','share']},
  note:{exact:['یادداشت','note','notes'], has:['توضیح']}
};
function findCols(row){
  const heads = row.map(normHead), col = {}, used = new Set();
  const take = (k, test) => { if (k in col) return; const i = heads.findIndex((h, j) => h && !used.has(j) && test(h)); if (i >= 0){ col[k] = i; used.add(i); } };
  Object.entries(HEADS).forEach(([k, m]) => m.exact && take(k, h => m.exact.includes(h)));
  Object.entries(HEADS).forEach(([k, m]) => m.has && take(k, h => m.has.some(w => h.includes(w))));
  return col;
}
// A CSV from Google Sheets is UTF-8 without a BOM, which SheetJS would read as Latin-1 (garbled Persian);
// Excel's "CSV" on Persian Windows is Windows-1256. So CSV text is decoded here.
async function readWorkbook(file){
  const buf = await file.arrayBuffer();
  if (!/\.(csv|txt)$/i.test(file.name) && !/csv|text\/plain/.test(file.type)) return XLSX.read(buf, {type:'array'});
  let text;
  try { text = new TextDecoder('utf-8', {fatal:true}).decode(buf); } catch(e){ text = new TextDecoder('windows-1256').decode(buf); }
  return XLSX.read(text.replace(/^﻿/, ''), {type:'string'});
}
async function readSheet(file){
  const wb = await readWorkbook(file);
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header:1, defval:'', raw:false});
  let hi = -1, col = {};
  for (let i = 0; i < Math.min(aoa.length, 20) && hi < 0; i++){ const c = findCols(aoa[i]); if (c.student_no !== undefined || c.phone !== undefined){ hi = i; col = c; } }
  if (hi < 0) throw new Error('ستون «شماره تماس» یا «شماره دانشجویی» پیدا نشد. سطر اول فایل باید عنوان ستون‌ها باشه.');
  // with a student-number column the phone only gives the 4-digit check code; otherwise the phone itself is what people log in with
  const byPhone = col.student_no === undefined;
  const cell = (r, k) => col[k] === undefined ? '' : String(r[col[k]] ?? '').trim();
  const parsed = [], noNumber = [], picked = [], unsure = [];
  aoa.slice(hi + 1).forEach(r => {
    // Arabic-keyboard ي/ك become Persian ی/ک, so names match searches and each other
    const name = (cell(r, 'full_name') || [cell(r, 'first'), cell(r, 'last')].filter(Boolean).join(' ')).replace(/ي/g, 'ی').replace(/ك/g, 'ک');
    const rawPhone = cell(r, 'phone');
    let no, extra = '';
    if (byPhone){
      const ps = phonesIn(rawPhone), chosen = ps.find(x => x.tg) || ps[0];
      no = chosen ? chosen.phone : null;
      // whatever else the cell said (a second number, a Telegram ID…) goes into a new person's note
      if (rawPhone && (!no || ps.length > 1 || /[^\d\s\-+()]/.test(toLatin(rawPhone)))) extra = `شماره در شیت: ${rawPhone}`;
      if (!no){ if (!name) return; noNumber.push(`${name} (${rawPhone || 'بدون شماره'})`); }
      else if (extra) picked.push(`${name || no}: ${no}${chosen.tg ? ' (تلگرام)' : ''}`);
    } else {
      no = normNo(cell(r, 'student_no')); if (!no) return;
    }
    const row = {student_no:no, full_name:name.slice(0, 80)};
    if (col.amount !== undefined) row.amount = parseNum(cell(r, 'amount')) || null;
    if (!byPhone && col.phone !== undefined) row.verify_code = last4(rawPhone) || null;
    if (col.note !== undefined) row.note = cell(r, 'note').slice(0, 140);
    if (col.major !== undefined) row.major = cell(r, 'major').slice(0, 80);
    if (col.guests !== undefined){ const g = parseGuests(cell(r, 'guests')); row.guests = g.n; if (!g.sure) unsure.push({name:name || no, raw:cell(r, 'guests'), n:g.n}); }
    parsed.push({row, nn:normName(name), extra, noNumber:!no});
  });
  // Rows on one phone number: the same name again is a repeated registration (the last row wins);
  // a different name is another person, stored under the next free key (0912…#2) so both are kept.
  // A student number always means one person.
  const keyOf = new Map(), shared = [];
  if (byPhone){
    const groups = new Map();
    parsed.filter(x => !x.noNumber).forEach(x => { const g = groups.get(x.row.student_no) || []; g.push(x); groups.set(x.row.student_no, g); });
    // no usable number: the person already on the list under this name, else "~<name>"
    parsed.filter(x => x.noNumber).forEach(x => {
      const same = Object.values(S.participants).filter(p => normName(p.full_name) === x.nn);
      keyOf.set(x, same.length === 1 ? same[0].student_no : (same.find(p => p.student_no === noPhoneKey(x.nn)) || {}).student_no || noPhoneKey(x.nn));
    });
    groups.forEach((list, base) => {
      const names = [...new Set(list.map(x => x.nn))], ex = Object.values(S.participants).filter(p => baseNo(p.student_no) === base);
      const keys = new Map(), used = new Set();
      // one person on this number before and after: keep it even if the name's spelling changed
      if (names.length === 1 && ex.length === 1) keys.set(names[0], ex[0].student_no);
      else names.forEach(nn => { const m = ex.find(p => normName(p.full_name) === nn && !used.has(p.student_no)); if (m){ keys.set(nn, m.student_no); used.add(m.student_no); } });
      const taken = new Set(ex.map(p => p.student_no));
      names.forEach(nn => { if (!keys.has(nn)){ const k = freeKey(base, taken); taken.add(k); keys.set(nn, k); } });
      list.forEach(x => keyOf.set(x, keys.get(x.nn)));
      if (names.length > 1) shared.push(`${base}: ${[...new Set(list.map(x => x.row.full_name || '—'))].join(tr(' و '))}`);
    });
  }
  const seen = new Map(), dups = [], known = new Set(Object.values(S.participants).map(p => p.student_no));
  parsed.forEach(x => {
    const key = keyOf.get(x) || x.row.student_no, row = {...x.row, student_no:key};
    // the cell's leftovers only go into the note of someone new, so a re-import doesn't overwrite notes made since
    if (x.extra && !known.has(key)) row.note = [row.note, x.extra].filter(Boolean).join(' · ').slice(0, 140);
    if (seen.has(key)) dups.push(x.row.full_name || shownNo(key));
    seen.set(key, row);
  });
  return {rows:[...seen.values()], col, byPhone, noNumber, picked, dups, unsure, shared};
}
function openImport(){ importRows = null; $('#importInfo').innerHTML = ''; $('#importGo').disabled = true; $('#importFile').value = ''; importDlg.showModal(); }
$('#importFile').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  importRows = null; $('#importGo').disabled = true;
  try {
    const {rows, col, byPhone, noNumber, picked, dups, unsure, shared} = await readSheet(file); importRows = rows;
    const known = new Set(Object.values(S.participants).map(p => p.student_no)), existing = rows.filter(r => known.has(r.student_no)).length;
    const guests = rows.reduce((a, r) => a + (r.guests || 0), 0);
    const colNames = {student_no:'شماره دانشجویی', phone: byPhone ? 'شماره تماس (برای ورود)' : 'موبایل (برای ۴ رقم تأیید)', full_name:'نام', first:'نام', last:'نام خانوادگی', major:'گرایش', guests:'تعداد مهمان', amount:'مبلغ', note:'توضیحات'};
    const few = (arr, n = 6) => esc(arr.slice(0, n).join('، ')) + (arr.length > n ? ` و ${fmt(arr.length - n)} مورد دیگه` : '');
    $('#importInfo').innerHTML = `<p><b>${fmt(rows.length)}</b> نفر پیدا شد: ${fmt(rows.length - existing)} جدید، ${fmt(existing)} به‌روزرسانی.${col.guests !== undefined ? ` جمع مهمان‌ها: <b>${fmt(guests)}</b> (کل حضور ${fmt(rows.length + guests)} نفر)` : ''}</p>
      <p class="sub">ستون‌های شناسایی‌شده: ${Object.keys(col).map(k => colNames[k]).join('، ')}</p>
      <p class="sub">${byPhone ? 'هر نفر بعداً با همین شماره موبایل وارد می‌شه.' : col.phone !== undefined ? 'چون ستون موبایل هست، هر نفر موقع ورود باید ۴ رقم آخر موبایلش رو هم بزنه.' : 'ستون موبایل نیست؛ ورود فقط با شماره دانشجویی انجام می‌شه.'}</p>
      ${col.amount === undefined ? `<p class="sub">ستون مبلغ نیست؛ مبلغ هر نفر از «اطلاعات پرداخت» حساب می‌شه${col.guests !== undefined ? ' (سهم خودش + تعداد مهمان × مبلغ هر مهمان)' : ''}.</p>` : ''}
      ${noNumber.length ? `<p class="sub bad">${fmt(noNumber.length)} نفر شماره موبایل درست ندارن؛ با برچسب «بدون شماره» وارد می‌شن، ولی تا شماره‌شون رو در پنجره‌ی خودشون ننویسی خودشون نمی‌تونن وارد سایت بشن (پرداختشون رو می‌تونی دستی ثبت کنی): ${few(noNumber)}</p>` : ''}
      ${picked.length ? `<p class="sub">از خونه‌ی شماره‌ی این‌ها فقط شماره‌ی موبایل برداشته شد (اگه چند شماره بود، اونی که «تلگرام» کنارش بود) و متن کامل توی یادداشتشون می‌مونه: ${few(picked)}</p>` : ''}
      ${dups.length ? `<p class="sub">${fmt(dups.length)} نفر دو بار ثبت‌نام کرده بودن (همون شماره و همون اسم) و آخرین ردیفشون ملاک شد: ${few(dups)}</p>` : ''}
      ${shared.length ? `<p class="sub">${fmt(shared.length)} شماره برای بیش از یک نفر ثبت شده؛ هر نفر جدا ثبت می‌شه و صاحب شماره بعد از ورود می‌تونه بینشون جابه‌جا بشه و برای هر کدوم جدا پرداخت کنه: ${few(shared, 4)}</p>` : ''}
      ${unsure.length ? `<p class="sub bad">تعداد مهمان این‌ها دقیق خونده نشد؛ بعد از ورود چک کن:</p><ul class="lines">${unsure.slice(0, 8).map(u => `<li><span>${esc(u.name)}: «${esc(u.raw)}»</span><span>${fmt(u.n)} مهمان</span></li>`).join('')}</ul>${unsure.length > 8 ? `<p class="sub">و ${fmt(unsure.length - 8)} مورد دیگه</p>` : ''}` : ''}
      ${(col.guests !== undefined || col.major !== undefined) && !hasGuestCols ? '<p class="sub bad">گرایش و تعداد مهمان ذخیره نمی‌شن، چون ستون‌هاشون هنوز در دیتابیس ساخته نشده (دستور SQL مربوط به مهمان‌ها رو اجرا کن).</p>' : ''}
      <ul class="lines">${rows.slice(0, 5).map(r => `<li><span>${esc(r.full_name || '—')}${r.major ? ' · ' + esc(r.major) : ''}${r.guests ? ` · ${fmt(r.guests)} مهمان` : ''}</span><span dir="ltr">${noPhone(r.student_no) ? 'بدون شماره' : esc(baseNo(r.student_no))}</span></li>`).join('')}</ul>`;
    $('#importGo').disabled = !rows.length;
  } catch(err){ console.error('import', err); $('#importInfo').innerHTML = `<p class="sub bad">${esc(err.message || 'فایل خونده نشد')}</p>`; }
});
$('#importGo').addEventListener('click', async () => {
  if (!importRows || !importRows.length) return;
  const btn = $('#importGo'); btn.disabled = true; btn.textContent = 'در حال ورود…';
  // existing people keep their id; new ones get one here, so this works whether or not the table has an id default.
  // Until those columns exist there are no major/guests columns to write, and sending them would fail the whole import.
  const byNo = new Map(Object.values(S.participants).map(p => [p.student_no, p.id]));
  const rows = importRows.map(r => { const o = {id: byNo.get(r.student_no) || newId(), ...r}; if (!hasGuestCols){ delete o.major; delete o.guests; } return o; });
  // A batch upsert sends every column any row has and blanks it where a row lacks it, so rows are sent in groups
  // with the same columns (e.g. only new people with a messy number cell get a note; others keep theirs).
  const groups = new Map(); rows.forEach(r => { const k = Object.keys(r).sort().join(); groups.set(k, [...(groups.get(k) || []), r]); });
  let okCount = 0, error = null;
  for (const list of groups.values()){
    for (let i = 0; i < list.length && !error; i += 200){
      const chunk = list.slice(i, i + 200);
      try { ({ error } = await sb.from('participants').upsert(chunk, {onConflict:'student_no'})); } catch(e){ error = e; }
      if (!error) okCount += chunk.length;
    }
    if (error) break;
  }
  btn.textContent = 'وارد کردن';
  await resync('participants');
  if (error){ fail(error, 'import'); btn.disabled = false; $('#importInfo').insertAdjacentHTML('beforeend', `<p class="sub bad">${fmt(okCount)} از ${fmt(rows.length)} نفر وارد شد و بقیه نه؛ دوباره «وارد کردن» رو بزن.</p>`); return; }
  importDlg.close(); toast(`${fmt(okCount)} نفر وارد شد`);
});


/* ---------- tabs & bottom bar ---------- */
let currentTab = 'items';
const tabs = [...document.querySelectorAll('.tab')];
tabs.forEach(b => {
  b.setAttribute('aria-controls', 'panel-' + b.dataset.tab); b.id ||= 'tab-' + b.dataset.tab;
  b.tabIndex = b.getAttribute('aria-selected') === 'true' ? 0 : -1;
  b.addEventListener('click', () => {
    currentTab = b.dataset.tab;
    tabs.forEach(x => { x.setAttribute('aria-selected', x === b); x.tabIndex = x === b ? 0 : -1; });
    document.querySelectorAll('.panel').forEach(p => p.hidden = p.id !== 'panel-' + currentTab);
    if (currentTab === 'history') renderHistory();
    if (currentTab === 'mypay'){ renderMyPay($('#myPayStaff')); hydrateThumbs(); }
    if (currentTab === 'settings'){ loadBotWelcome(); renderTgAcct(); }
    renderBottomBar();
  });
});
tabs.forEach(b => { const p = $('#panel-' + b.dataset.tab); p.setAttribute('role', 'tabpanel'); p.setAttribute('aria-labelledby', b.id); });
// arrow keys move between tabs (in RTL, ArrowLeft goes to the next tab)
$('.tabs').addEventListener('keydown', e => {
  const shown = tabs.filter(t => !t.hidden && t.offsetParent), i = shown.indexOf(document.activeElement);
  if (i < 0) return;
  const fwd = document.documentElement.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight', back = fwd === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
  const next = {[fwd]:i + 1, [back]:i - 1, Home:0, End:shown.length - 1}[e.key];
  if (next === undefined) return;
  e.preventDefault();
  const t = shown[(next + shown.length) % shown.length]; t.focus(); t.click();
});
function renderBottomBar(){
  const bar = $('#bottomBar'), key = currentTab + ':' + myRole; if (bar.dataset.key === key) return; bar.dataset.key = key;
  const btn = (act, l, p) => `<button class="btn ${p ? 'primary' : ''}" type="button" data-act="${act}">${l}</button>`;
  if (!canEdit){ bar.innerHTML = btn('export','خروجی اکسل',1); return; }
  bar.innerHTML = currentTab === 'items' ? btn('add-item','+ هزینه جدید',1)
    : currentTab === 'invoices' ? btn('upload','+ آپلود فاکتور',1)
    : currentTab === 'budget' ? btn('add-fund','+ واریزی',1) + btn('add-contrib','+ سهم نفر')
    : currentTab === 'people' ? btn('add-person','+ شرکت‌کننده',1) + btn('import-people','ورود از شیت') + (canAdmin ? btn('notify','پیام') : '') : '';
}
['#q','#fType','#fStatus','#fSort'].forEach(s => $(s).addEventListener('input', () => renderItems(totals())));
['#pq','#pFilter','#pMajor','#pItems'].forEach(s => $(s).addEventListener('input', () => { renderPeople(); hydrateThumbs(); }));
document.addEventListener('focusin', e => { if (e.target.matches && e.target.matches('[data-select-all]')) e.target.select(); });
// a new participant's row is a div (it holds buttons), so it needs its own keyboard handling
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('div.row[data-person]')){ e.preventDefault(); openPerson(e.target.dataset.person); } });

/* ---------- item dialog ---------- */
$('#catSelect').innerHTML = CATS.map(c => `<option value="${c}">${c}</option>`).join('');
const itemDlg = $('#itemDlg'), itemForm = $('#itemForm'); let editingItem = null;
function numField(el, v){ el.value = v ? fmt(v) : ''; }
function liveFormat(e){
  const el = e.target; if (!el || el.getAttribute('inputmode') !== 'numeric') return;
  if (el.name === 'card_number'){ const s = cardFmt(el.value); if (el.value !== s) el.value = s; return; }
  // dir=ltr numeric fields are codes (phone digits, tracking code): keep leading zeros, no thousands separators
  if (el.dir === 'ltr') return;
  const n = parseNum(el.value), s = n ? fmt(n) : ''; if (el.value !== s) el.value = s;
}
function renderItemAtt(itemId){
  const box = $('#itemAtt');
  if (!itemId || !S.items[itemId]){ box.innerHTML = '<p class="hint" style="color:var(--muted);font-size:13px;margin:0">بعد از ذخیره‌ی این خرج می‌تونی فاکتور بهش وصل کنی.</p>'; return; }
  const invs = invOf(itemId), free = Object.values(S.invoices).filter(v => !v.item_id || !S.items[v.item_id]);
  box.innerHTML = `<div class="lbl">فاکتورهای این خرج${invs.length ? ` <span class="hint">جمع ${money(invSum(itemId))}</span>` : ''}
    <div class="att">${invs.map(v => `<button class="att-row" type="button" data-inv="${esc(v.id)}">${thumbHtml(v)}<span>${esc(v.vendor || v.file_name)}</span><b>${v.total ? fmt(v.total) : '—'}</b></button>`).join('')}</div>
    <div class="att-tools need-edit"><button class="btn small" type="button" data-attach="${esc(itemId)}">+ آپلود فاکتور برای این خرج</button>
    ${free.length ? `<select data-link-free="${esc(itemId)}" aria-label="وصل کردن فاکتور موجود"><option value="">وصل کردن یکی از فاکتورهای وصل‌نشده…</option>${free.map(v => `<option value="${esc(v.id)}">${esc(v.vendor || v.file_name)}${v.total ? ' — ' + fmt(v.total) : ''}</option>`).join('')}</select>` : ''}</div></div>`;
  hydrateThumbs();
}
function openItem(id, preset){
  if (!ready || (!id && !canEdit)) return;
  editingItem = id ? S.items[id] : null;
  const it = editingItem ? {...editingItem} : {title:'', reason:'', type:'must', category:CATS[0], vendor:'', unit:0, qty:1, paid:false, actual:0, payer:''};
  if (preset){ it.title = tr(preset[0]); it.category = preset[1]; it.type = preset[2]; }
  const f = itemForm.elements;
  f.title.value = it.title || ''; f.reason.value = it.reason || ''; f.vendor.value = it.vendor || '';
  f.category.value = CATS.includes(it.category) ? it.category : 'سایر';
  itemForm.querySelector(`input[name=type][value="${it.type in TYPES ? it.type : 'must'}"]`).checked = true;
  numField(f.unit, it.unit); f.qty.value = fmt(it.qty || 1);
  f.paid.checked = !!it.paid; numField(f.actual, it.actual); f.payer.value = isFund(it.payer) ? '' : it.payer;
  $('#paidBox').hidden = !it.paid;
  $('#itemDlgTitle').textContent = editingItem ? 'ویرایش هزینه' : 'هزینه جدید';
  $('#itemDel').hidden = !editingItem;
  $('#itemMeta').textContent = metaLine(editingItem);
  renderItemAtt(editingItem && editingItem.id);
  lockForm(itemForm); if (!canEdit) $('#itemDlgTitle').textContent = 'جزئیات هزینه';
  updateCalc(); if (!itemDlg.open) itemDlg.showModal();
  if (!editingItem) setTimeout(() => (preset ? f.unit : f.title).focus(), 30);
}
function updateCalc(){ const f = itemForm.elements, u = parseNum(f.unit.value), q = parseNum(f.qty.value) || 1; $('#calc').innerHTML = u ? `برآورد کل: <b>${money(u*q)}</b>` : ''; }
itemForm.addEventListener('input', e => { liveFormat(e); updateCalc(); });
$('#paidChk').addEventListener('change', e => { $('#paidBox').hidden = !e.target.checked; });
itemForm.addEventListener('submit', async e => {
  e.preventDefault();
  const f = itemForm.elements, title = f.title.value.trim();
  if (!title){ f.title.focus(); toast('عنوان رو بنویس'); return; }
  const obj = {id: editingItem ? editingItem.id : newId(), title, reason:f.reason.value.trim(), vendor:f.vendor.value.trim(),
    type:itemForm.querySelector('input[name=type]:checked').value, category:f.category.value, unit:parseNum(f.unit.value), qty:parseNum(f.qty.value) || 1,
    paid:f.paid.checked, actual:f.paid.checked ? parseNum(f.actual.value) : 0, payer:f.paid.checked ? (f.payer.value.trim() || FUND) : ''};
  const wasNew = !editingItem;
  itemDlg.close(); if (await upsert('items', obj)) toast(wasNew ? 'هزینه اضافه شد' : 'تغییرات ذخیره شد');
});
$('#itemDel').addEventListener('click', async () => {
  const it = editingItem; if (!it) return;
  const invs = invOf(it.id);
  if (!confirm(`«${it.title}» حذف بشه؟` + (invs.length ? `\n${fmt(invs.length)} فاکتورِ وصل‌شده حذف نمی‌شن و می‌رن توی «وصل‌نشده».` : ''))) return;
  itemDlg.close();
  invs.forEach(v => { S.invoices[v.id] = {...v, item_id:null}; }); // database does this via ON DELETE SET NULL
  if (await del('items', it.id)) toast('حذف شد'); else resync('invoices');
});

/* ---------- money entry dialog ---------- */
const entryDlg = $('#entryDlg'), entryForm = $('#entryForm'); let entryKind = 'fund', editingEntry = null;
function openEntry(kind, id, presetName){
  if (!ready || (!id && !canEdit)) return;
  editingEntry = id ? S.funds[id] : null; entryKind = editingEntry ? editingEntry.kind : kind;
  const t = totals(), head = Number(S.settings.headcount)||0;
  const defAmt = entryKind === 'contrib' && head ? Math.max(0, Math.ceil((t.mid - t.fundAll)/head)) : 0;
  const c = editingEntry || {name:presetName || '', amount:defAmt, paid:entryKind === 'fund', note:''};
  const f = entryForm.elements, isF = entryKind === 'fund';
  f.name.value = c.name || ''; numField(f.amount, c.amount); f.paid.checked = !!c.paid; f.note.value = c.note || '';
  $('#entryNameLbl').textContent = isF ? 'منبع' : 'نام';
  f.name.placeholder = isF ? 'مثلاً کمک انجمن علمی' : '';
  $('#entryPaidLbl').textContent = isF ? 'دریافت شد (الان دستمونه)' : 'واریز کرده';
  $('#entryDlgTitle').textContent = (editingEntry ? 'ویرایش ' : '') + (isF ? 'واریزی' : 'سهم') + (editingEntry ? '' : ' جدید');
  $('#entryDel').hidden = !editingEntry;
  $('#entryMeta').textContent = metaLine(editingEntry);
  lockForm(entryForm); updateECalc(); entryDlg.showModal();
  if (!editingEntry) setTimeout(() => (presetName ? f.amount : f.name).focus(), 30);
}
function updateECalc(){ const n = parseNum(entryForm.elements.amount.value); $('#ecalc').innerHTML = n ? `<b>${money(n)}</b>` : ''; }
entryForm.addEventListener('input', e => { liveFormat(e); updateECalc(); });
entryForm.addEventListener('submit', async e => {
  e.preventDefault();
  const f = entryForm.elements, name = f.name.value.trim();
  if (!name){ f.name.focus(); toast(entryKind === 'fund' ? 'منبع رو بنویس' : 'اسم رو بنویس'); return; }
  const obj = {id: editingEntry ? editingEntry.id : newId(), kind:entryKind, name, amount:parseNum(f.amount.value), paid:f.paid.checked, note:f.note.value.trim()};
  const wasNew = !editingEntry;
  entryDlg.close(); if (await upsert('funds', obj)) toast(wasNew ? 'ثبت شد' : 'تغییرات ذخیره شد');
});
$('#entryDel').addEventListener('click', async () => {
  const c = editingEntry; if (!c || !confirm(`«${c.name}» حذف بشه؟`)) return;
  entryDlg.close(); if (await del('funds', c.id)) toast('حذف شد');
});

document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
[itemDlg, entryDlg, invDlg, personDlg, receiptDlg, payInfoDlg, importDlg, codesDlg].forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

/* ---------- delegation ---------- */
const fileInput = $('#invFile');
fileInput.addEventListener('change', () => { const files = [...fileInput.files]; fileInput.value = ''; if (files.length) handleFiles(files); else uploadTarget = null; });
document.addEventListener('click', e => {
  const g = sel => e.target.closest(sel); let el;
  if ((el = g('[data-act]'))){ const a = el.dataset.act;
    if (a === 'lang') return I18N.set(I18N.lang === 'fa' ? 'en' : 'fa');
    if (a === 'add-item') return openItem(); if (a === 'add-fund') return openEntry('fund'); if (a === 'add-contrib') return openEntry('contrib');
    if (a === 'upload'){ uploadTarget = null; return fileInput.click(); }
    if (a === 'export') return openXlsx();
    if (a === 'xl-build') return xlBuild();
    if (a === 'full-backup') return fullBackup(el);
    if (a === 'xl-all' || a === 'xl-none'){ xlDlg.querySelectorAll('input[data-xl]:not(:disabled)').forEach(i => { i.checked = a === 'xl-all'; }); return xlSync(); }
    if (a === 'logout') return logout();
    if (a === 'recheck') return recheck();
    if (a === 'guest-add-open'){ guestAddFor = payee()?.id || null; render(); updateGuestPreview(); const g = $('#gaCount'); if (g){ g.focus(); g.select(); } return; }
    if (a === 'guest-add-cancel'){ guestAddFor = null; return render(); }
    if (a === 'guest-add') return addGuests(el);
    if (a === 're-request') return reRequest(el);
    if (a === 'pick-receipt') return receiptInput.click();
    if (a === 'send-receipt') return sendReceipt(el);
    if (a === 'cancel-receipt'){ if (draftReceipt) URL.revokeObjectURL(draftReceipt.url); draftReceipt = null; return render(); }
    if (a === 'edit-payinfo') return openPayInfo();
    if (a === 'addon-add'){ if (canEdit) addonRow().querySelector('input').focus(); return; }
    if (a === 'addon-del'){ if (canEdit) el.closest('.addon-row').remove(); return; }
    if (a === 'import-people') return openImport();
    if (a === 'add-person') return openPerson(null, peopleKind);
    if (a === 'cater') return setCatering(el.dataset.id, el.dataset.v);
    if (a === 'cater-bulk') return cateringBulk(el.dataset.v);
    if (a === 'codes') return openCodes();
    if (a === 'codes-assign') return assignCodes();
    if (a === 'codes-send') return sendCodes(!!el.dataset.test);
    if (a === 'code-reissue') return reissueCode(el);
    if (a === 'code-revoke') return revokeCode(el);
    if (a === 'pay-link-new') return newPayLink(el);
    if (a === 'unlink-person') return unlinkPerson();
    if (a === 'manual-pay') return recordPayment(el);
    if (a === 'setup-bot') return setupBot(el);
    if (a === 'save-welcome') return saveWelcome(el);
    if (a === 'bc-test') return botBroadcast(true);
    if (a === 'bc-send') return botBroadcast(false);
    if (a === 'tg-send-code') return tgSendCode();
    if (a === 'tg-sign-in') return tgSignIn();
    if (a === 'tg-password') return tgPassword();
    if (a === 'tg-cancel') return tgCancel();
    if (a === 'tg-logout') return tgLogout();
    if (a === 'tg-retry') return tgRestore();
    if (a === 'notify') return openNotify(); }
  if ((el = g('[data-pay-for]'))){ payForId = el.dataset.payFor; guestAddFor = null; return render(); }
  if ((el = g('[data-people-kind]'))){ peopleKind = el.dataset.peopleKind; renderPeople(); return hydrateThumbs(); }
  if ((el = g('[data-copy]'))) return copyText(el.dataset.copy, el.dataset.copyLabel);
  if ((el = g('[data-receipt]'))) return openReceipt(el.dataset.receipt);
  if ((el = g('[data-person]'))) return openPerson(el.dataset.person);
  if ((el = g('#drop'))){ uploadTarget = null; return fileInput.click(); }
  if ((el = g('[data-attach]'))){ uploadTarget = el.dataset.attach; itemDlg.close(); return fileInput.click(); }
  if ((el = g('[data-inv]'))) return openInvoice(el.dataset.inv);
  if ((el = g('[data-item]'))) return openItem(el.dataset.item);
  if ((el = g('[data-entry]'))) return openEntry(null, el.dataset.entry);
  if ((el = g('[data-quick]'))) return openItem(null, QUICK[+el.dataset.quick]);
  if ((el = g('[data-quick-fund]'))) return openEntry('fund', null, QUICK_FUNDS[+el.dataset.quickFund]);
  if ((el = g('[data-apply]'))) return applyInvoices(el.dataset.apply);
  if ((el = g('[data-mem-role]'))){ const [u, r] = el.dataset.memRole.split(':'); return memberRole(u, r); }
});
document.addEventListener('change', e => {
  let m = e.target.closest('[data-mem-select]');
  if (m){
    const uid = m.dataset.memSelect;
    if (uid === me.id && m.value !== 'admin' && !confirm('نقش خودت عوض بشه؟ دسترسی مدیر رو از دست می‌دی.')){ m.value = S.members[uid].role; return; }
    return setMember(uid, {role:m.value});
  }
  m = e.target.closest('[data-mem-name]'); if (m){ const v = m.value.trim(); if (v) setMember(m.dataset.memName, {display_name:v}); return; }
  let s = e.target.closest('[data-inv-map]'); if (s) return mapInvoice(s.dataset.invMap, s.value);
  s = e.target.closest('[data-link-free]');
  if (s && s.value) patch('invoices', s.value, {item_id:s.dataset.linkFree}).then(ok => ok && toast('فاکتور وصل شد'));
});
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.id === 'drop'){ e.preventDefault(); fileInput.click(); } });
const drop = $('#drop');
['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); if (ev === 'drop' && e.dataTransfer.files.length){ uploadTarget = null; handleFiles([...e.dataTransfer.files]); } }));

/* ---------- settings ---------- */
$('#setTitle').addEventListener('change', e => saveSettings({title: e.target.value.trim() || DEFAULT_SETTINGS.title}));
$('#setBudget').addEventListener('input', liveFormat);
$('#setHead').addEventListener('input', liveFormat);
$('#setBudget').addEventListener('change', e => saveSettings({budget: parseNum(e.target.value)}));
$('#setHead').addEventListener('change', e => saveSettings({headcount: parseNum(e.target.value)}));
$('#setCur').addEventListener('change', e => saveSettings({currency: e.target.value}));
// connects the bot to telegram-auth (welcome message with an "open the site" button on /start) and sets its menu button
async function setupBot(btn){
  if (!canAdmin) return;
  const out = $('#botSetupMsg'), site = location.origin + location.pathname.replace(/index\.html$/, '');
  out.className = 'sub';
  if (location.protocol !== 'https:'){ out.classList.add('bad'); out.textContent = 'این کار رو از آدرس اصلی سایت (https://…) انجام بده، نه از نسخه‌ی محلی.'; return; }
  btn.disabled = true; out.textContent = 'در حال راه‌اندازی…';
  try {
    const { data, error } = await sb.functions.invoke('telegram-auth', {body:{setup_bot:true, site, lang:I18N.lang}});
    if (error){
      let b = {}; try { b = await error.context.json(); } catch(e){}
      throw new Error(b.error === 'not_admin' ? 'فقط مدیر می‌تونه ربات رو راه‌اندازی کنه.'
        : b.error === 'role_check_failed' ? 'نقشت از دیتابیس خونده نشد: ' + (b.detail || '')
        : b.error === 'telegram_failed' ? 'تلگرام قبول نکرد' + (b.detail ? ': ' + b.detail : '.')
        : b.error === 'bot_token_missing' ? 'توکن ربات در Supabase تنظیم نشده.'
        : 'تابع telegram-auth جواب درست نداد؛ مطمئن شو نسخه‌ی جدیدش Deploy شده.');
    }
    out.classList.add('pos');
    out.textContent = 'انجام شد. ربات رو توی تلگرام Start کن تا پیام و دکمه‌ی «ورود به سایت» رو ببینی.' + (data && data.menu === false ? ' (دکمه‌ی منوی ربات تنظیم نشد؛ می‌تونی از BotFather تنظیمش کنی.)' : '');
  } catch(e){ out.classList.add('bad'); out.textContent = e.message; }
  finally { btn.disabled = false; }
}

// The bot's welcome text and messages to everyone who started the bot (admin only). The tables come from the bot SQL,
// and the sending is done by telegram-auth, so both missing pieces are explained instead of failing silently.
const BOT_SQL_HINT = 'جدول‌های ربات توی دیتابیس نیستن؛ دستور SQL ربات رو یک بار در SQL Editor اجرا کن.';
const missingTable = e => /PGRST205|42P01|does not exist|schema cache/i.test(`${e && e.code || ''} ${e && e.message || ''}`);
let botWelcomeLoaded = false;
async function loadBotWelcome(){
  if (!canAdmin || botWelcomeLoaded) return;
  const out = $('#botWelcomeMsg');
  const { data, error } = await sb.from('bot_settings').select('welcome_text').eq('id', 1).maybeSingle();
  out.className = 'sub';
  if (error){ out.classList.add('bad'); out.textContent = missingTable(error) ? BOT_SQL_HINT : 'متن فعلی خونده نشد: ' + error.message; return; }
  botWelcomeLoaded = true; out.textContent = '';
  if (document.activeElement !== $('#botWelcome')) $('#botWelcome').value = (data && data.welcome_text) || '';
}
async function saveWelcome(btn){
  if (!canAdmin) return;
  const out = $('#botWelcomeMsg'), text = $('#botWelcome').value.trim();
  btn.disabled = true;
  const { data, error } = await sb.from('bot_settings').update({welcome_text:text}).eq('id', 1).select('id');
  btn.disabled = false; out.className = 'sub';
  if (error || !data || !data.length){
    out.classList.add('bad');
    out.textContent = error ? (missingTable(error) ? BOT_SQL_HINT : 'ذخیره نشد: ' + error.message) : 'ذخیره نشد؛ دسترسی لازم رو نداری.';
    return;
  }
  botWelcomeLoaded = true; out.classList.add('pos');
  out.textContent = text ? 'ذخیره شد. ربات رو توی تلگرام Start کن تا ببینیش.' : 'خالی ذخیره شد؛ متن پیش‌فرض فرستاده می‌شه.';
}
const BOT_ERRORS = {
  not_admin:'فقط مدیر می‌تونه پیام همگانی بفرسته.', setup_missing:BOT_SQL_HINT,
  no_telegram:'حسابت به تلگرام وصل نیست (با ایمیل وارد شدی)؛ ارسال آزمایشی رو با حساب تلگرامی امتحان کن.',
  start_bot_first:'اول خودت ربات رو توی تلگرام Start کن، بعد دوباره امتحان کن.', empty:'متن پیام رو بنویس.',
  too_long:'پیام خیلی طولانیه (حداکثر ۴۰۰۰ حرف).', bad_site:'دکمه‌ی «ورود به سایت» فقط از آدرس اصلی سایت (https) ساخته می‌شه.',
  telegram_failed:'تلگرام پیام رو قبول نکرد.', role_check_failed:'نقشت از دیتابیس خونده نشد.', bot_token_missing:'توکن ربات در Supabase تنظیم نشده.'
};
let broadcasting = false;
async function botBroadcast(test){
  if (!canAdmin || broadcasting) return;
  const out = $('#bcMsg'), text = $('#bcText').value.trim(), withButton = $('#bcButton').checked;
  const site = location.origin + location.pathname.replace(/index\.html$/, '');
  out.className = 'sub';
  if (!text){ out.classList.add('bad'); out.textContent = BOT_ERRORS.empty; $('#bcText').focus(); return; }
  if (withButton && location.protocol !== 'https:'){ out.classList.add('bad'); out.textContent = BOT_ERRORS.bad_site; return; }
  const call = async body => {
    const { data, error } = await sb.functions.invoke('telegram-auth', {body:{broadcast:{...body, lang:I18N.lang}}});
    if (error){ let b = {}; try { b = await error.context.json(); } catch(e){} throw b; }
    return data || {};
  };
  const btns = document.querySelectorAll('[data-act="bc-test"],[data-act="bc-send"]');
  broadcasting = true; btns.forEach(b => b.disabled = true);
  try {
    if (test){
      out.textContent = 'در حال ارسال…';
      await call({text, test:true, with_button:withButton, site});
      out.classList.add('pos'); out.textContent = 'برات فرستاده شد؛ توی تلگرام ببینش.';
      return;
    }
    out.textContent = 'در حال شمردن گیرنده‌ها…';
    const { total } = await call({count_only:true});
    if (!total){ out.textContent = 'هنوز کسی ربات رو Start نکرده.'; return; }
    if (!confirm(`این پیام برای ${fmt(total)} نفر فرستاده بشه؟`)){ out.textContent = ''; return; }
    out.textContent = `در حال ارسال برای ${fmt(total)} نفر… چند ثانیه طول می‌کشه؛ صفحه رو نبند.`;
    const r = await call({text, with_button:withButton, site});
    out.classList.add(r.sent ? 'pos' : 'bad');
    out.textContent = `برای ${fmt(r.sent || 0)} نفر فرستاده شد`
      + (r.unreachable ? `؛ ${fmt(r.unreachable)} نفر ربات رو بلاک کردن یا هیچ‌وقت Start نکردن` : '')
      + (r.failed ? `؛ ${fmt(r.failed)} پیام به‌خاطر خطا نرسید` : '') + '.';
    if (r.sent) $('#bcText').value = ''; // so the same message isn't sent twice by accident
  } catch(b){
    console.error('broadcast', b);
    out.classList.add('bad'); out.textContent = BOT_ERRORS[b && b.error] || 'تابع telegram-auth جواب درست نداد؛ مطمئن شو نسخه‌ی جدیدش Deploy شده.';
  } finally { broadcasting = false; btns.forEach(b => b.disabled = false); }
}

/* ---------- messages to participants (admin only) ----------
   One personalised message to a group of participants chosen by payment state. It goes through the bot to everyone
   who signed in to the site with Telegram (or whose shared number's owner did); everyone else, and anyone who blocked
   the bot, gets it from the admin's own Telegram account by phone number, one at a time with a pause in between so
   the account isn't flagged for spam. */
const NT_AUD = [
  ['debt', 'همه‌ی بدهکارها', r => r.s.key === 'unpaid' || r.s.key === 'partial'],
  ['unpaid', 'پرداخت نکرده', r => r.s.key === 'unpaid'],
  ['partial', 'بخشی پرداخت کرده', r => r.s.key === 'partial'],
  ['review', 'فیش در انتظار بررسی', r => r.s.key === 'review'],
  ['settled', 'تسویه', r => r.s.key === 'settled'],
  ['unclaimed', 'هنوز وارد سایت نشده', r => !r.linked],
  ['extra', 'شرکت‌کننده‌های جدید', r => isExtra(r.p)],
  ['all', 'همه', () => true],
];
const NT_ROUTE = {bot:'ربات', phone:'حساب شخصی', none:'راهی نیست'};
const NT_GAP = 4000; // ms between messages from the personal account (plus up to 2s at random)
const notifyDlg = $('#notifyDlg');
const NT = {aud:'debt', off:new Set(), running:false, stop:false, report:null};
const ntTemplates = () => [
  ['یادآوری پرداخت', 'سلام {name}! 👋\nیادآوری: از سهمت برای جشن {remaining} مونده. لطفاً واریز کن و عکس فیش رو از سایت بفرست. ممنون 🙏'],
  ['تشکر', 'سلام {name}! پرداختت ({paid}) رسید و تأیید شد. ممنون که همراهی کردی 🌸'],
  ['دعوت به ورود', 'سلام {name}! سهمت از جشن {amount} ـه. برای دیدن جزئیات و فرستادن فیش، از ربات وارد سایت شو.'],
  ['لینک پرداخت', 'سلام {name}! 👋\nسهمت از جشن {remaining} مونده. از این لینک مبلغ و شماره کارت رو ببین و بعد از واریز، عکس رسید رو همون‌جا برای ربات بفرست:\n{link}'],
];
const ntAcct = () => TG.state === 'on' || tgHasSession();
// everyone, with their payment state and how a message reaches them
function ntPeople(){
  const all = Object.values(S.participants), tgOfNo = new Map();
  const linkedNos = new Set(all.filter(p => p.user_id && isPhoneId(p.student_no)).map(p => baseNo(p.student_no)));
  all.forEach(p => { const m = p.user_id && S.members[p.user_id]; if (m && m.telegram_id && isPhoneId(p.student_no)) tgOfNo.set(baseNo(p.student_no), Number(m.telegram_id)); });
  return all.map(p => {
    const m = p.user_id && S.members[p.user_id];
    const tg = (m && m.telegram_id ? Number(m.telegram_id) : 0) || (isPhoneId(p.student_no) && tgOfNo.get(baseNo(p.student_no))) || 0;
    return {p, s:payState(p), tg, route:tg ? 'bot' : isPhoneId(p.student_no) ? 'phone' : 'none',
            linked:!!p.user_id || (isPhoneId(p.student_no) && linkedNos.has(baseNo(p.student_no)))};
  }).sort((a,b) => (a.p.full_name || '').localeCompare(b.p.full_name || '', 'fa'));
}
const ntAudience = () => { const f = (NT_AUD.find(a => a[0] === NT.aud) || NT_AUD[0])[2]; return ntPeople().filter(f); };
const ntChosen = () => ntAudience().filter(r => r.route !== 'none' && !NT.off.has(r.p.id));
function ntFill(text, r){
  const cur = curName(), money2 = n => fmt(n) + ' ' + cur;
  return text.replace(/\{name\}/g, r.p.full_name || 'دوست عزیز').replace(/\{amount\}/g, money2(r.s.due))
    .replace(/\{paid\}/g, money2(r.s.approved)).replace(/\{remaining\}/g, money2(r.s.remaining)).replace(/\{link\}/g, payLinkOf(r.p) || '');
}
const ntBot = () => botConfigured ? cfg.telegramBot.replace(/^@/, '') : '';
// the bot attaches an "open the site" button; a message from the personal account gets the bot's link instead
const ntPhoneText = (text, r) => ntFill(text, r) + ($('#ntButton').checked && ntBot() ? '\n\n' + tr('ورود به سایت: https://t.me/{0}', ntBot()) : '');
function openNotify(){
  if (!canAdmin) return;
  if (!NT.running){ NT.off.clear(); NT.report = null; }
  if (!$('#ntText').value.trim()) $('#ntText').value = ntTemplates()[0][1];
  renderNotify();
  if (!notifyDlg.open) notifyDlg.showModal();
}
function renderNotify(){
  const people = ntPeople(), list = ntAudience(), chosen = ntChosen(), acct = ntAcct();
  $('#ntAud').innerHTML = NT_AUD.filter(([k, , f]) => k !== 'extra' || k === NT.aud || people.some(f)).map(([k, label, f]) => `<button class="chip${k === NT.aud ? ' on' : ''}" type="button" data-nt-aud="${k}" aria-pressed="${k === NT.aud}">${label}<small>${fmt(people.filter(f).length)}</small></button>`).join('');
  $('#ntTpl').innerHTML = '<span class="sub">متن آماده:</span>' + ntTemplates().map(([l], i) => `<button class="chip" type="button" data-nt-tpl="${i}">${l}</button>`).join('');
  const n = k => chosen.filter(r => r.route === k).length, none = list.filter(r => r.route === 'none').length;
  $('#ntSummary').textContent = tr('گیرنده‌ها: {0} نفر — {1} از ربات، {2} از حساب شخصیت', fmt(chosen.length), fmt(n('bot')), fmt(n('phone')))
    + (none ? tr('؛ {0} نفر شماره ندارن', fmt(none)) : '') + ' ' + tr('(برای دیدن و برداشتن تیک بزن)');
  $('#ntList').innerHTML = list.length ? list.map(r => {
    const dead = r.route === 'none', on = !dead && !NT.off.has(r.p.id);
    const route = r.route === 'phone' && !acct ? '<span class="tag warn">حساب شخصی وصل نیست</span>' : `<span class="tag${r.route === 'none' ? ' warn' : ''}">${NT_ROUTE[r.route]}</span>`;
    return `<label class="nt-row${on ? '' : ' off'}"><input type="checkbox" data-nt-p="${esc(r.p.id)}"${on ? ' checked' : ''}${dead || NT.running ? ' disabled' : ''}>
      <b>${esc(r.p.full_name || shownNo(r.p.student_no) || '—')}</b><span class="tag">${STATE_LABEL[r.s.key]}</span>${route}</label>`;
  }).join('') : '<p class="sub">کسی توی این گروه نیست.</p>';
  const first = chosen[0], text = $('#ntText').value.trim();
  $('#ntPreview').innerHTML = first && text ? `<b>پیش‌نمایش برای ${esc(first.p.full_name || '')}:</b><br><span translate="no">${esc(ntFill(text, first)).replace(/\n/g, '<br>')}</span>` : '';
  const phoneNoAcct = n('phone') && !acct;
  const pr = $('#ntProgress');
  if (NT.running) pr.innerHTML = `<p class="sub">${esc(NT.status || '')}</p>`;
  else if (NT.report) pr.innerHTML = ntReportHtml(NT.report);
  else pr.innerHTML = phoneNoAcct ? `<p class="sub bad">${fmt(n('phone'))} نفر فقط از حساب تلگرام شخصیت (با شماره‌شون) پیام می‌گیرن؛ اول از تب «تنظیمات» وصلش کن، وگرنه بهشون نمی‌رسه.</p>` : '';
  notifyDlg.querySelector('[data-act="nt-send"]').disabled = NT.running || !chosen.length;
  notifyDlg.querySelector('[data-act="nt-test"]').disabled = NT.running;
  notifyDlg.querySelector('[data-act="nt-stop"]').hidden = !NT.running;
}
function ntReportHtml(rep){
  const sent = rep.sent.length, viaPhone = rep.sent.filter(r => r.via === 'phone').length;
  return `<div class="nt-report"><b class="${rep.failed.length ? '' : 'pos'}">برای ${fmt(sent)} نفر فرستاده شد${viaPhone ? ` (${fmt(sent - viaPhone)} از ربات، ${fmt(viaPhone)} از حساب شخصیت)` : ''}.</b>
    ${rep.failed.length ? `<span class="bad">به ${fmt(rep.failed.length)} نفر نرسید:</span><ul>${rep.failed.map(([r, why]) => `<li>${esc(r.p.full_name || shownNo(r.p.student_no))}: ${esc(why)}</li>`).join('')}</ul>` : ''}</div>`;
}
const ntErr = b => ({unknown_recipient:'یکی از گیرنده‌ها رو تابع نمی‌شناسه؛ صفحه رو تازه کن و دوباره امتحان کن.', not_admin:'فقط مدیر می‌تونه پیام بفرسته.',
  too_many:'حداکثر ۵۰۰ نفر در هر ارسال.', no_telegram:'حسابت به تلگرام وصل نیست (با ایمیل وارد شدی)؛ ارسال آزمایشی با حساب تلگرامی ممکنه.',
  start_bot_first:'اول خودت ربات رو توی تلگرام Start کن، بعد دوباره امتحان کن.', bad_site:BOT_ERRORS.bad_site, telegram_failed:'تلگرام پیام رو قبول نکرد.'}[b && b.error]
  || 'تابع telegram-auth جواب درست نداد؛ مطمئن شو نسخه‌ی جدیدش Deploy شده.');
async function ntCall(body){
  const { data, error } = await sb.functions.invoke('telegram-auth', {body:{notify:{...body, lang:I18N.lang}}});
  if (error){ let b = {}; try { b = await error.context.json(); } catch(e){} throw b; }
  return data || {};
}
const ntSite = () => location.origin + location.pathname.replace(/index\.html$/, '');
const ntWithButton = () => $('#ntButton').checked && location.protocol === 'https:';
async function ntTest(){
  const text = $('#ntText').value.trim(), r = ntChosen()[0] || ntAudience()[0];
  if (!text){ toast('متن پیام رو بنویس'); $('#ntText').focus(); return; }
  NT.running = true; NT.status = 'در حال ارسال آزمایشی…'; renderNotify();
  try {
    await ntCall({test:true, messages:[{to:0, text:r ? ntFill(text, r) : text}], with_button:ntWithButton(), site:ntSite()});
    toast('پیام آزمایشی برات فرستاده شد؛ توی تلگرام ببینش');
  } catch(b){ console.error('notify test', b); toast(ntErr(b)); }
  finally { NT.running = false; renderNotify(); }
}
async function ntSend(){
  const text = $('#ntText').value.trim(), chosen = ntChosen(), label = (NT_AUD.find(a => a[0] === NT.aud) || NT_AUD[0])[1];
  if (!text){ toast('متن پیام رو بنویس'); $('#ntText').focus(); return; }
  if (!chosen.length) return;
  const viaBot = chosen.filter(r => r.route === 'bot'), viaPhone = chosen.filter(r => r.route === 'phone'), acct = ntAcct();
  if (!confirm(`پیام برای ${fmt(chosen.length)} نفر («${label}») فرستاده بشه؟\n${fmt(viaBot.length)} نفر از ربات`
    + (viaPhone.length ? (acct ? `، ${fmt(viaPhone.length)} نفر از حساب شخصیت (یکی‌یکی؛ حدود ${fmt(Math.ceil(viaPhone.length * 5 / 60))} دقیقه طول می‌کشه و VPN لازمه)` : `؛ ${fmt(viaPhone.length)} نفر بدون حساب شخصی نمی‌گیرن`) : ''))) return;
  const rep = {sent:[], failed:[]};
  NT.running = true; NT.stop = false; NT.report = null;
  const status = t => { NT.status = t; renderNotify(); };
  try {
    if (viaBot.length){
      status(`در حال ارسال از ربات برای ${fmt(viaBot.length)} نفر…`);
      try {
        const { results = [] } = await ntCall({messages:viaBot.map(r => ({to:r.tg, text:ntFill(text, r)})), with_button:ntWithButton(), site:ntSite()});
        viaBot.forEach((r, i) => {
          if (results[i] === 'sent') rep.sent.push({...r, via:'bot'});
          // blocked the bot (or never started it): try their number from the personal account instead
          else if (results[i] === 'unreachable' && isPhoneId(r.p.student_no)) viaPhone.push(r);
          else rep.failed.push([r, results[i] === 'unreachable' ? 'ربات رو بلاک کرده' : 'خطای تلگرام']);
        });
      } catch(b){ console.error('notify', b); viaBot.forEach(r => rep.failed.push([r, ntErr(b)])); }
    }
    if (viaPhone.length && !acct) viaPhone.forEach(r => rep.failed.push([r, 'فقط با حساب تلگرام شخصی می‌رسه که وصل نیست']));
    else if (viaPhone.length){
      status('در حال اتصال به حساب تلگرامت…');
      await tgRestore();
      if (TG.state !== 'on') viaPhone.forEach(r => rep.failed.push([r, TG.err || 'به حساب تلگرامت وصل نشد']));
      else for (let i = 0; i < viaPhone.length; i++){
        const r = viaPhone[i];
        if (NT.stop){ viaPhone.slice(i).forEach(x => rep.failed.push([x, 'ارسال رو متوقف کردی'])); break; }
        status(`از حساب شخصیت: ${fmt(i + 1)} از ${fmt(viaPhone.length)} (${r.p.full_name || ''})…`);
        try { await tgSendToPhone(r.p.student_no, ntPhoneText(text, r)); rep.sent.push({...r, via:'phone'}); }
        catch(e){
          console.error('notify phone', e); rep.failed.push([r, tgErrText(e)]);
          // Telegram is limiting this account: stop before it gets worse
          if (/FLOOD/.test(tgCode(e))){ viaPhone.slice(i + 1).forEach(x => rep.failed.push([x, 'متوقف شد چون تلگرام حسابت رو موقتاً محدود کرد'])); break; }
        }
        if (i < viaPhone.length - 1 && !NT.stop) await new Promise(res => setTimeout(res, NT_GAP + Math.random() * 2000));
      }
    }
    // history: one entry per send, under this admin's name
    try { await sb.from('bot_broadcasts').insert({text:`[${label}] ${text}`.slice(0, 4000), sent:rep.sent.length, failed:rep.failed.length}); } catch(e){}
  } finally {
    NT.running = false; NT.report = rep; renderNotify();
    toast(`پیام برای ${fmt(rep.sent.length)} نفر فرستاده شد` + (rep.failed.length ? `؛ ${fmt(rep.failed.length)} نفر نرسید` : ''));
  }
}
notifyDlg.addEventListener('click', e => {
  if (e.target === notifyDlg && !NT.running) return notifyDlg.close();
  const a = e.target.closest('[data-nt-aud]'); if (a && !NT.running){ NT.aud = a.dataset.ntAud; NT.off.clear(); NT.report = null; return renderNotify(); }
  const t = e.target.closest('[data-nt-tpl]'); if (t){ $('#ntText').value = tr(ntTemplates()[+t.dataset.ntTpl][1]); return renderNotify(); }
  const act = e.target.closest('[data-act]') && e.target.closest('[data-act]').dataset.act;
  if (act === 'nt-send') return ntSend();
  if (act === 'nt-test') return ntTest();
  if (act === 'nt-stop'){ NT.stop = true; NT.status = 'بعد از پیام فعلی متوقف می‌شه…'; return renderNotify(); }
});
notifyDlg.addEventListener('change', e => { const c = e.target.closest('[data-nt-p]'); if (c){ c.checked ? NT.off.delete(c.dataset.ntP) : NT.off.add(c.dataset.ntP); renderNotify(); } });
notifyDlg.addEventListener('input', e => { if (e.target.id === 'ntText') renderNotify(); });
notifyDlg.addEventListener('cancel', e => { if (NT.running) e.preventDefault(); }); // Esc mustn't hide a send in progress

/* ---------- personal Telegram account (admin only) ----------
   An admin can connect their own Telegram account (api_id / api_hash from my.telegram.org, the same ones Telethon uses).
   Group messages to participants then reach, by phone number, the people the bot can't (those who never signed in to
   the site). It all runs in this browser through GramJS (vendor/gramjs.js, loaded only when needed). The session stays
   on this device: whoever holds it holds the whole account, so it never goes to the database. Telegram's servers are
   filtered in Iran, so this part needs a VPN; the rest of the site doesn't. */
const TG = {client:null, state:'off', busy:false, err:'', note:'', step:null, me:null, restoring:null};
const tgKey = () => me ? 'tgAccount:' + me.id : null; // per site account, so two admins sharing a browser don't share a session
function tgSaved(){ try { return (tgKey() && JSON.parse(localStorage.getItem(tgKey()) || 'null')) || {}; } catch(e){ return {}; } }
function tgSave(v){ try { if (tgKey()) localStorage.setItem(tgKey(), JSON.stringify(v)); } catch(e){} }
const tgHasSession = () => canAdmin && !!tgSaved().session;
let gramLoading = null;
function loadGram(){
  if (window.GramJS) return Promise.resolve(window.GramJS);
  return gramLoading ||= new Promise((resolve, reject) => {
    const sc = document.createElement('script'); sc.src = 'vendor/gramjs.js';
    sc.onload = () => window.GramJS ? resolve(window.GramJS) : reject(new Error('GRAMJS_LOAD'));
    sc.onerror = () => { gramLoading = null; sc.remove(); reject(new Error('GRAMJS_LOAD')); };
    document.head.appendChild(sc);
  });
}
// a blocked connection doesn't fail, it just never answers
const tgTimeout = (p, ms = 20000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), ms))]);
const tgCode = e => String(e && (e.errorMessage || e.message) || e || '');
const tgRevoked = e => /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED/.test(tgCode(e));
function tgErrText(e){
  const m = tgCode(e);
  if (/GRAMJS_LOAD/.test(m)) return 'ابزار تلگرام (vendor/gramjs.js) بارگذاری نشد؛ صفحه رو تازه کن.';
  if (/TIMEOUT|websocket|network|Not connected|disconnected|Failed to fetch/i.test(m)) return 'به تلگرام وصل نشد؛ برای این بخش VPN لازمه.';
  if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/.test(m)) return 'api_id یا api_hash درست نیست.';
  if (/PHONE_NUMBER_INVALID|PHONE_NUMBER_BANNED/.test(m)) return 'این شماره رو تلگرام قبول نکرد؛ با کد کشور بنویس، مثلاً +989121234567.';
  if (/NOT_REGISTERED|PHONE_NUMBER_UNOCCUPIED/.test(m)) return 'با این شماره حساب تلگرامی ساخته نشده.';
  if (/PHONE_CODE_INVALID|PHONE_CODE_EMPTY/.test(m)) return 'کد اشتباهه.';
  if (/PHONE_CODE_EXPIRED/.test(m)) return 'کد منقضی شده؛ «انصراف» رو بزن و دوباره کد بگیر.';
  if (/PASSWORD_HASH_INVALID/.test(m)) return 'رمز دو مرحله‌ای اشتباهه.';
  if (/PEER_FLOOD/.test(m)) return 'تلگرام فعلاً اجازه‌ی پیام دادن به کسایی که مخاطبت نیستن رو به این حساب نمی‌ده.';
  if (/FLOOD/.test(m)){ const sec = Number(e && e.seconds) || Number((/(\d+)/.exec(m) || [])[1]) || 0; return 'تلگرام موقتاً محدودت کرده' + (sec ? `؛ ${fmt(Math.ceil(sec / 60))} دقیقه‌ی دیگه امتحان کن.` : '؛ کمی بعد امتحان کن.'); }
  if (tgRevoked(e)) return 'این نشست از طرف تلگرام باطل شده (مثلاً از «دستگاه‌ها» بیرونش کردی)؛ دوباره وصل شو.';
  if (/PRIVACY/.test(m)) return 'تنظیمات حریم خصوصی این شخص اجازه نمی‌ده.';
  if (/NOT_FOUND|PHONE_NOT_OCCUPIED|USERNAME_NOT_OCCUPIED/.test(m)) return 'با این شماره پیدا نشد (تلگرام نداره یا اجازه‌ی پیدا شدن با شماره رو نداده).';
  return 'خطای تلگرام: ' + m;
}
function tgClient(G, a){
  const c = new G.TelegramClient(new G.StringSession(a.session || ''), Number(a.apiId), String(a.apiHash),
    {connectionRetries:2, retryDelay:1500, autoReconnect:true, useWSS:true, deviceModel:'Party finance panel (web)', appVersion:'1.0', langCode:'fa', systemLangCode:'fa'});
  try { c.setLogLevel('none'); } catch(e){}
  return c;
}
async function tgDrop(){
  const c = TG.client; TG.client = null; TG.me = null;
  if (c){ try { await c.destroy(); } catch(e){ try { await c.disconnect(); } catch(_){} } }
}
function tgSet(state, busy){ TG.state = state; TG.busy = !!busy; renderTgAcct(); if (notifyDlg.open) renderNotify(); }
const tgName = u => u ? ([u.firstName, u.lastName].filter(Boolean).join(' ') || (u.username ? '@' + u.username : '') || (u.phone ? '+' + u.phone : 'بی‌نام')) : '';

// ---- connecting ----
function tgPhone(v){
  const d = toLatin(v).replace(/[^\d+]/g, '');
  if (/^09\d{9}$/.test(d)) return '+98' + d.slice(1);
  if (/^\+?\d{8,15}$/.test(d)) return '+' + d.replace('+', '');
  return null;
}
async function tgSendCode(){
  const apiId = parseInt(toLatin($('#tgApiId').value).trim(), 10), apiHash = $('#tgApiHash').value.trim(), phone = tgPhone($('#tgPhoneIn').value);
  TG.note = '';
  TG.err = !(apiId > 0) ? 'api_id یک عدده؛ از my.telegram.org بردار.' : !/^[0-9a-f]{32}$/i.test(apiHash) ? 'api_hash باید ۳۲ حرف و عدد انگلیسی باشه.' : !phone ? 'شماره‌ی حساب تلگرامت رو با کد کشور بنویس، مثلاً +989121234567.' : '';
  if (TG.err) return renderTgAcct(true);
  tgSave({...tgSaved(), apiId, apiHash, phone, session:undefined}); // remembered for next time, without a session yet
  tgSet('sending', true);
  try {
    const G = await loadGram(); await tgDrop();
    const c = TG.client = tgClient(G, {apiId, apiHash});
    await tgTimeout(c.connect());
    const r = await tgTimeout(c.sendCode({apiId, apiHash}, phone));
    TG.step = {apiId, apiHash, phone, hash:r.phoneCodeHash, viaApp:!!r.isCodeViaApp};
    tgSet('code');
  } catch(e){ console.error('telegram code', e); TG.err = tgErrText(e); await tgDrop(); tgSet('off'); }
}
async function tgSignIn(){
  const code = toLatin($('#tgCodeIn').value).replace(/\D/g, ''), c = TG.client, G = window.GramJS, st = TG.step;
  if (!code || !c || !st) return;
  TG.err = ''; tgSet('code', true);
  try {
    const r = await tgTimeout(c.invoke(new G.Api.auth.SignIn({phoneNumber:st.phone, phoneCodeHash:st.hash, phoneCode:code})));
    if (r instanceof G.Api.auth.AuthorizationSignUpRequired) throw new Error('NOT_REGISTERED');
    await tgFinish();
  } catch(e){
    if (tgCode(e) === 'SESSION_PASSWORD_NEEDED'){
      try { const pw = await tgTimeout(c.invoke(new G.Api.account.GetPassword())); st.hint = pw.hint || ''; } catch(_){}
      return tgSet('password');
    }
    console.error('telegram sign in', e); TG.err = tgErrText(e); tgSet('code');
  }
}
async function tgPassword(){
  const pw = $('#tgPwIn').value, c = TG.client, st = TG.step;
  if (!pw || !c || !st) return;
  TG.err = ''; tgSet('password', true);
  try {
    await tgTimeout(c.signInWithPassword({apiId:st.apiId, apiHash:st.apiHash}, {password: async () => pw, onError: async e => { throw e; }}), 30000);
    await tgFinish();
  } catch(e){ console.error('telegram password', e); TG.err = tgErrText(e); tgSet('password'); }
}
async function tgFinish(){
  const st = TG.step;
  tgSave({...tgSaved(), apiId:st.apiId, apiHash:st.apiHash, phone:st.phone, session:TG.client.session.save()});
  TG.step = null;
  await tgReady();
}
async function tgReady(){
  TG.me = await tgTimeout(TG.client.getMe());
  tgSet('on');
}
// a saved session connects only when it's needed (sending, or "check connection"): not on every page load
function tgRestore(){
  if (!tgHasSession() || TG.state === 'on') return Promise.resolve();
  return TG.restoring ||= (async () => {
    TG.err = ''; tgSet('connecting', true);
    try {
      const G = await loadGram(); await tgDrop();
      TG.client = tgClient(G, tgSaved());
      await tgTimeout(TG.client.connect());
      await tgReady();
    } catch(e){
      console.error('telegram connect', e); TG.err = tgErrText(e); await tgDrop();
      if (tgRevoked(e)){ const a = tgSaved(); delete a.session; tgSave(a); tgSet('off'); } else tgSet('offline');
    }
  })().finally(() => { TG.restoring = null; });
}
function tgCancel(){ TG.step = null; TG.err = ''; tgDrop(); tgSet('off'); }
async function tgLogout(){
  if (!confirm('اتصال حساب تلگرامت از این سایت قطع بشه؟ این نشست از حسابت خارج می‌شه.')) return;
  if (TG.state !== 'on') await tgRestore(); // so the session is logged out at Telegram too, not only forgotten here
  const c = TG.client, G = window.GramJS, online = TG.state === 'on';
  tgSet(TG.state, true);
  if (c && G && online){ try { await tgTimeout(c.invoke(new G.Api.auth.LogOut()), 8000); } catch(e){ console.warn('telegram logout', e); } }
  await tgDrop();
  const a = tgSaved(); delete a.session; tgSave(a);
  TG.err = ''; TG.note = online ? 'اتصال قطع شد.' : 'از این مرورگر پاک شد. چون الان وصل نبود، از تلگرام → تنظیمات → دستگاه‌ها هم این نشست رو ببند.';
  tgSet('off');
}

// sending from the personal account: people are found by phone number (when their privacy settings allow it)
async function tgSendToPhone(no, text){
  const c = TG.client, G = window.GramJS;
  const r = await tgTimeout(c.invoke(new G.Api.contacts.ResolvePhone({phone:'98' + baseNo(no).slice(1)})), 15000);
  const u = r && r.users && r.users[0];
  if (!u) throw new Error('NOT_FOUND');
  await tgTimeout(c.sendMessage(u, {message:text}), 15000);
}

const TG_USE = 'پیام گروهی به شرکت‌کننده‌هایی که ربات بهشون نمی‌رسه (مثلاً هنوز وارد سایت نشدن)، از این حساب و با شماره‌شون فرستاده می‌شه.';
function renderTgAcct(force){
  const box = $('#tgAcctBody'); if (!box || !canAdmin) return;
  const a = tgSaved(), st = TG.step, dis = TG.busy ? ' disabled' : '';
  const state = TG.state === 'off' && tgHasSession() ? 'saved' : TG.state; // connected earlier on this browser, not now
  const err = TG.err ? `<span class="sub bad">${esc(TG.err)}</span>` : TG.note ? `<span class="sub pos">${esc(TG.note)}</span>` : '';
  const html = {
    off: `<div class="tg-form"><div class="two">
        <label class="lbl">api_id<input class="field" id="tgApiId" inputmode="numeric" dir="ltr" autocomplete="off" value="${esc(a.apiId || '')}"></label>
        <label class="lbl">api_hash<input class="field" id="tgApiHash" dir="ltr" autocomplete="off" spellcheck="false" value="${esc(a.apiHash || '')}"></label></div>
      <label class="lbl">شماره‌ی حساب تلگرامت<input class="field" id="tgPhoneIn" dir="ltr" inputmode="tel" autocomplete="off" placeholder="+98912…" value="${esc(a.phone || '')}"></label>
      <span class="hint">api_id و api_hash رو از <a href="https://my.telegram.org/apps" target="_blank" rel="noopener">my.telegram.org</a> → API development tools می‌گیری (همونایی که برای Telethon گرفتی). بعد تلگرام یه کد ورود برات می‌فرسته.</span>
      <div class="row-btns"><button class="btn primary" type="button" data-act="tg-send-code"${dis}>ارسال کد ورود</button></div>${err}</div>`,
    sending: `<span class="sub">در حال اتصال به تلگرام و فرستادن کد…</span>`,
    connecting: `<span class="sub">در حال اتصال به تلگرام…</span>`,
    code: `<div class="tg-form"><label class="lbl">کد ورود <span class="hint">${st && st.viaApp ? 'کد توی خود اپ تلگرامت اومده (پیام از طرف Telegram)' : 'کد با پیامک اومده'}${st ? ` · <span dir="ltr">${esc(st.phone)}</span>` : ''}</span>
        <input class="field" id="tgCodeIn" inputmode="numeric" dir="ltr" autocomplete="one-time-code"${dis}></label>
      <div class="row-btns"><button class="btn primary" type="button" data-act="tg-sign-in"${dis}>ورود</button><button class="btn" type="button" data-act="tg-cancel"${dis}>انصراف</button></div>${err}</div>`,
    password: `<div class="tg-form"><label class="lbl">رمز تأیید دو مرحله‌ای${st && st.hint ? ` <span class="hint">راهنما: ${esc(st.hint)}</span>` : ''}
        <input class="field" id="tgPwIn" type="password" dir="ltr" autocomplete="current-password"${dis}></label>
      <div class="row-btns"><button class="btn primary" type="button" data-act="tg-password"${dis}>ورود</button><button class="btn" type="button" data-act="tg-cancel"${dis}>انصراف</button></div>${err}</div>`,
    on: `<div class="tg-form"><span><span class="tag ok">وصل به: ${esc(tgName(TG.me))}${TG.me && TG.me.username ? ` (@${esc(TG.me.username)})` : ''}</span></span>
      <span class="sub">${TG_USE}</span>
      <div class="row-btns"><button class="btn danger" type="button" data-act="tg-logout"${dis}>قطع اتصال</button></div>${err}</div>`,
    saved: `<div class="tg-form"><span><span class="tag ok">روی این مرورگر وصله${a.phone ? ` (<span dir="ltr">${esc(a.phone)}</span>)` : ''}</span></span>
      <span class="sub">${TG_USE} موقع ارسال خودکار وصل می‌شه.</span>
      <div class="row-btns"><button class="btn" type="button" data-act="tg-retry"${dis}>بررسی اتصال</button><button class="btn danger" type="button" data-act="tg-logout"${dis}>قطع اتصال</button></div>${err}</div>`,
    offline: `<div class="tg-form">${err || '<span class="sub bad">به تلگرام وصل نیست.</span>'}
      <div class="row-btns"><button class="btn" type="button" data-act="tg-retry"${dis}>تلاش دوباره</button><button class="btn danger" type="button" data-act="tg-logout"${dis}>قطع اتصال</button></div></div>`,
  }[state] || '';
  // don't wipe a field the admin is typing in just because something else re-rendered
  const key = state + '|' + TG.busy + '|' + TG.err + '|' + TG.note + '|' + (TG.me && TG.me.id);
  if (!force && box.dataset.key === key) return;
  box.dataset.key = key; box.innerHTML = html;
  const first = box.querySelector('#tgCodeIn,#tgPwIn');
  if (first && !TG.busy && currentTab === 'settings') first.focus();
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.closest('#tgAcctBody')) return;
  const go = {tgPhoneIn:'tg-send-code', tgApiHash:'tg-send-code', tgApiId:'tg-send-code', tgCodeIn:'tg-sign-in', tgPwIn:'tg-password'}[e.target.id];
  if (go){ e.preventDefault(); const b = $(`[data-act="${go}"]`); if (b && !b.disabled) b.click(); }
});
function tgReset(){ TG.step = null; TG.err = ''; TG.note = ''; tgDrop(); TG.state = 'off'; $('#tgAcctBody').innerHTML = ''; delete $('#tgAcctBody').dataset.key; }

/* ---------- excel ---------- */
// file names carry the date in Latin digits (the Persian calendar in Persian)
const FILE_DATE = I18N.lang === 'fa' ? 'fa-IR-u-nu-latn' : 'en-GB';
const faDay = v => v ? new Date(v).toLocaleDateString(I18N.dateLocale) : '';
/* ---------- Excel export ----------
   «خروجی اکسل» opens a checklist and the file holds only the ticked sheets. Plain sheets (SheetJS): the header in the
   first row, column widths, thousands separators, right to left. The choice is remembered in this browser. */
const addSheet = (wb, ws, name) => XLSX.utils.book_append_sheet(wb, ws, tr(name));
function sheetFrom(aoa, widths, numCols){
  const ws = XLSX.utils.aoa_to_sheet(aoa.map(r => r.map(c => typeof c === 'string' ? tr(c) : c)));
  ws['!cols'] = widths.map(w => ({wch:w}));
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let R = 1; R <= range.e.r; R++) numCols.forEach(C => { const cell = ws[XLSX.utils.encode_cell({r:R, c:C})]; if (cell && cell.t === 'n') cell.z = '#,##0'; });
  return ws;
}
const XL_SAVED = 'party-finance:xl-sheets';
// [key, sheet name, what's in it, how many rows] — only what this person can see
function xlChoices(){
  const all = Object.values(S.participants), main = all.filter(p => !isExtra(p)).length, extra = all.length - main;
  return [
    ['summary', 'خلاصه', 'برآورد هزینه‌ها، بودجه و صندوق، سهم‌ها، حضور و پذیرایی', null],
    ['items', 'هزینه‌ها', 'همه‌ی هزینه‌ها با برآورد، وضعیت و فاکتورها', Object.keys(S.items).length],
    ['invoices', 'فاکتورها', 'فاکتورهای آپلودشده', Object.keys(S.invoices).length],
    ['funds', 'بودجه و سهم‌ها', 'واریزی‌ها، منابع و سهم نفرات', Object.keys(S.funds).length],
    ['main', 'شرکت‌کننده‌های اصلی', 'سهم، پرداخت و وضعیت هر نفر' + (canAdmin && VC.status ? '، با کد رأی' : ''), main],
    ['extra', 'شرکت‌کننده‌های جدید', 'اقلامی که خواستن، پذیرایی و پرداخت' + (canAdmin && VC.status ? '، با کد رأی' : ''), extra],
    ['payments', 'فیش‌ها', 'همه‌ی فیش‌ها با وضعیت، تاریخ و اینکه از کجا اومده', Object.keys(S.payments).length],
    ...(canAdmin && VC.status ? [['codes', 'کدهای رأی', 'نام و کد هر نفر، برای چاپ یا دادن دستی', all.filter(p => myCodes.get(p.id)).length]] : []),
  ];
}
const XL_DEFAULT = ['summary', 'items', 'main', 'extra', 'payments'];
function xlSaved(){ try { const v = JSON.parse(localStorage.getItem(XL_SAVED)); return Array.isArray(v) ? v : XL_DEFAULT; } catch(e){ return XL_DEFAULT; } }
const xlDlg = $('#xlDlg');
function openXlsx(){
  if (!ready){ toast('صبر کن داده‌ها بارگذاری بشن'); return; }
  if (!window.XLSX){ toast('ابزار ساخت اکسل بارگذاری نشد'); return; }
  const saved = new Set(xlSaved());
  $('#xlList').innerHTML = xlChoices().map(([k, name, what, n]) => { const empty = n === 0;
    return `<label class="check xl-item${empty ? ' off' : ''}"><input type="checkbox" data-xl="${k}"${saved.has(k) && !empty ? ' checked' : ''}${empty ? ' disabled' : ''}>
      <span><b>${name}</b>${n !== null ? `<small>${empty ? 'خالی' : fmt(n) + ' مورد'}</small>` : ''}<span class="sub">${what}</span></span></label>`; }).join('');
  xlDlg.querySelector('.xl-tg').hidden = !tgWA;
  xlSync();
  if (!xlDlg.open) xlDlg.showModal();
}
const xlPicked = () => [...xlDlg.querySelectorAll('input[data-xl]:checked')].map(i => i.dataset.xl);
function xlSync(){ const n = xlPicked().length, b = xlDlg.querySelector('[data-act="xl-build"]'); b.disabled = !n; b.textContent = n ? `${tgWA ? 'فرستادن در ربات' : 'ساخت فایل اکسل'} (${fmt(n)} برگه)` : 'یک مورد رو انتخاب کن'; }
xlDlg.addEventListener('change', xlSync);
xlDlg.addEventListener('click', e => { if (e.target === xlDlg) xlDlg.close(); });
function xlBuild(){
  const picked = xlPicked(); if (!picked.length) return;
  try { localStorage.setItem(XL_SAVED, JSON.stringify(picked)); } catch(e){}
  xlDlg.close();
  try { exportXlsx(new Set(picked)); } catch(e){ console.error('export', e); toast('ساخت فایل اکسل انجام نشد'); }
}
function exportXlsx(want){
  const t = totals(), st = S.settings, cur = curName(), head = Number(st.headcount)||0;
  const items = Object.values(S.items).sort((a,b) => (TYPES[a.type]?.order??0) - (TYPES[b.type]?.order??0) || cost(b) - cost(a));
  const wb = XLSX.utils.book_new(); wb.Workbook = {Views:[{RTL:true}]};
  const everyone = Object.values(S.participants).sort((a,b) => (a.full_name||'').localeCompare(b.full_name||'','fa'));
  const parts = everyone.filter(p => !isExtra(p)), extras = everyone.filter(isExtra);
  const guests = parts.reduce((a,p) => a + guestsOf(p), 0), withCodes = canAdmin && !!VC.status;
  const codeText = p => myCodes.get(p.id) || (codeOf(p.id) ? 'دارد' : '—');
  const sum = (list, f) => list.reduce((a, x) => a + (Number(f(x)) || 0), 0);
  const left = s => Math.max(0, s.due - s.approved);

  if (want.has('summary')){
    const a = [['شرح', 'مبلغ (' + cur + ')', 'سهم هر نفر'],
      ['هزینه‌های قطعی (حداقل)', t.min, head ? Math.ceil(t.min/head) : ''],
      ['قطعی + احتمالی (محتمل)', t.mid, head ? Math.ceil(t.mid/head) : ''],
      ['همه موارد (کامل)', t.max, head ? Math.ceil(t.max/head) : ''], [],
      ['سقف بودجه برنامه‌ریزی‌شده', Number(st.budget)||''], ['تعداد نفرات', head || ''],
      ['بودجه دریافت‌شده', t.income], ['  از منابع و واریزی‌ها', t.fundIn], ['  از سهم نفرات', t.contribIn], ['در راه (قول داده‌شده)', t.incoming],
      ['خرج‌شده تا الان', t.spent], ['بدهی صندوق به افراد', t.owedTotal], ['موجودی خالص صندوق', t.balance], ['قطعی‌های پرداخت‌نشده', t.unpaidMust]];
    const owed = Object.entries(t.owed);
    if (owed.length){ a.push([], ['بازپرداخت به', 'مبلغ']); owed.forEach(([n,v]) => a.push([n, v])); }
    if (everyone.length){
      const sm = parts.map(payState), sx = extras.map(payState), xs = extras.length;
      a.push([], ['سهم شرکت‌کننده‌ها', 'اصلی', xs ? 'جدید' : '']);
      [['تعداد نفرات', s => s.length], ['جمع مبلغ‌ها', s => sum(s, x => x.due)], ['تأییدشده', s => sum(s, x => x.approved)],
       ['فیش در انتظار بررسی', s => sum(s, x => x.pending)], ['مانده', s => sum(s, left)],
       ['تسویه‌شده (نفر)', s => s.filter(x => x.key === 'settled').length], ['پرداخت‌نکرده (نفر)', s => s.filter(x => x.key === 'unpaid').length]]
        .forEach(([label, f]) => a.push([label, f(sm), xs ? f(sx) : '']));
      const n = f => extras.filter(f).length, yes = n(p => p.catering === 'yes');
      a.push([], ['حضور و پذیرایی', 'تعداد'], ['شرکت‌کننده‌های اصلی', parts.length]);
      if (guests) a.push(['  مهمان‌هاشون', guests]);
      if (xs){
        a.push(['شرکت‌کننده‌های جدید', xs], ...ADDONS().map(ad => ['  ' + ad.name, n(p => (p.addons || []).includes(ad.id))]));
        a.push(['  با پذیرایی', yes], ['  بدون پذیرایی', n(p => p.catering === 'no')], ['  پذیرایی تصمیم‌نشده', n(p => (p.catering || 'undecided') === 'undecided')]);
      }
      a.push(['کل پذیرایی', parts.length + guests + yes]);
    }
    if (withCodes){ const s = VC.status; a.push([], ['کدهای رأی', 'تعداد'], ['کدهای فعال', s.total], ['تخصیص‌داده', s.assigned], ['آزاد', s.free], ['شرکت‌کننده‌های اصلی بدون کد', parts.filter(p => !codeOf(p.id)).length]); }
    const byCat = {}; items.forEach(it => { const k = it.category||'سایر'; byCat[k] = (byCat[k]||0) + cost(it); });
    if (items.length){ a.push([], ['دسته', 'جمع']); Object.entries(byCat).sort((x,y) => y[1]-x[1]).forEach(([k,v]) => a.push([k, v])); }
    addSheet(wb, sheetFrom(a, [30,18,16], [1,2]), 'خلاصه');
  }
  if (want.has('items')){
    const a = [['ردیف','عنوان','دلیل / توضیح','نوع','دسته','فروشنده / تماس','قیمت واحد','تعداد','برآورد','وضعیت','مبلغ واقعی','مبلغ نهایی','پرداخت از','تعداد فاکتور','جمع فاکتورها','ثبت‌کننده','آخرین تغییر']];
    items.forEach((it,i) => a.push([i+1, it.title, it.reason||'', (TYPES[it.type]||TYPES.must).l, it.category||'', it.vendor||'', Number(it.unit)||0, Number(it.qty)||1, estimate(it), it.paid ? 'پرداخت شد' : 'پرداخت‌نشده', it.paid && it.actual ? Number(it.actual) : '', cost(it), it.paid ? (it.payer||FUND) : '', invOf(it.id).length, invSum(it.id) || '', who(it.created_by), who(it.updated_by)]));
    a.push([], ['','جمع کل','','','','','','', sum(items, estimate),'','', t.max]);
    addSheet(wb, sheetFrom(a, [6,26,40,10,16,20,14,7,14,13,14,14,14,10,14,14,14], [6,7,8,10,11,14]), 'هزینه‌ها');
  }
  if (want.has('invoices')){
    const invs = Object.values(S.invoices).sort((a,b) => ts(a.created_at) - ts(b.created_at));
    const a = [['ردیف','فروشنده','تاریخ فاکتور','مبلغ','مربوط به خرج','نوع خرج','یادداشت','نام فایل','تاریخ آپلود','آپلودکننده']];
    invs.forEach((v,i) => { const it = S.items[v.item_id]; a.push([i+1, v.vendor||'', v.invoice_date||'', Number(v.total)||0, it ? it.title : 'وصل‌نشده', it ? (TYPES[it.type]||TYPES.must).l : '', v.note||'', v.file_name||'', faDay(v.created_at), who(v.created_by)]); });
    a.push([], ['','جمع','', sum(invs, v => v.total)]);
    addSheet(wb, sheetFrom(a, [6,22,14,14,24,10,34,24,12,14], [3]), 'فاکتورها');
  }
  if (want.has('funds')){
    const a = [['ردیف','نوع','منبع / نام','مبلغ','وضعیت','یادداشت','تاریخ ثبت','ثبت‌کننده']];
    let r = 0;
    fundsOnly().forEach(f => a.push([++r, 'واریزی / منبع', f.name, Number(f.amount)||0, f.paid ? 'دریافت شد' : 'در راه', f.note||'', faDay(f.created_at), who(f.created_by)]));
    contribs().forEach(c => a.push([++r, 'سهم نفر', c.name, Number(c.amount)||0, c.paid ? 'واریز کرده' : 'هنوز نداده', c.note||'', faDay(c.created_at), who(c.created_by)]));
    a.push([], ['','','دریافت‌شده', t.income], ['','','در راه', t.incoming]);
    addSheet(wb, sheetFrom(a, [6,14,24,16,14,34,12,14], [3]), 'بودجه و سهم‌ها');
  }
  if (want.has('main') && parts.length){
    const ss = parts.map(payState);
    const a = [['ردیف','موبایل / شماره دانشجویی','نام','گرایش','تعداد مهمان','مبلغ سهم','تأییدشده','در انتظار بررسی','مانده','وضعیت','حساب وصل','تعداد فیش','یادداشت', ...(withCodes ? ['کد رأی'] : [])]];
    parts.forEach((p,i) => { const s = ss[i]; a.push([i+1, shownNo(p.student_no) || 'بدون شماره', p.full_name||'', p.major||'', guestsOf(p), s.due, s.approved, s.pending, left(s), STATE_LABEL[s.key], p.user_id ? 'بله' : 'خیر', s.count, p.note||'', ...(withCodes ? [codeText(p)] : [])]); });
    a.push([], ['','','جمع','', guests, sum(ss, s => s.due), sum(ss, s => s.approved), sum(ss, s => s.pending), sum(ss, left)]);
    a.push(['','','کل حضور (نفرات + مهمان‌ها)','', parts.length + guests]);
    addSheet(wb, sheetFrom(a, [6,16,24,18,10,14,14,14,14,18,10,10,30,10], [4,5,6,7,8]), 'شرکت‌کننده‌ها');
  }
  if (want.has('extra') && extras.length){
    const ss = extras.map(payState), yn = v => v ? 'بله' : '—', n = f => extras.filter(f).length;
    const items = ADDONS(), has = (p, ad) => (p.addons || []).includes(ad.id), k = items.length, money = 5 + k; // first money column
    const a = [['ردیف','موبایل / شماره دانشجویی','نام','گرایش', ...items.map(ad => ad.name),'پذیرایی','مبلغ','تأییدشده','در انتظار بررسی','مانده','وضعیت','حساب وصل','تعداد فیش','یادداشت', ...(withCodes ? ['کد رأی'] : [])]];
    extras.forEach((p,i) => { const s = ss[i]; a.push([i+1, shownNo(p.student_no) || 'بدون شماره', p.full_name||'', p.major||'', ...items.map(ad => yn(has(p, ad))), {yes:'بله', no:'خیر'}[p.catering] || 'تصمیم نشده', s.due, s.approved, s.pending, left(s), STATE_LABEL[s.key], p.user_id ? 'بله' : 'خیر', s.count, p.note||'', ...(withCodes ? [codeText(p)] : [])]); });
    const yes = n(p => p.catering === 'yes'), no = n(p => p.catering === 'no');
    const pad = Array(k).fill('');
    a.push([], ['','','جمع','', ...items.map(ad => n(p => has(p, ad))), yes, sum(ss, s => s.due), sum(ss, s => s.approved), sum(ss, s => s.pending), sum(ss, left)]);
    a.push(['','','پذیرایی','', ...pad, `بله ${yes} · خیر ${no} · تصمیم‌نشده ${extras.length - yes - no}`]);
    a.push(['','','کل پذیرایی (اصلی‌ها + مهمان‌ها + جدیدهای با پذیرایی)','', ...pad, parts.length + guests + yes]);
    addSheet(wb, sheetFrom(a, [6,16,24,18, ...items.map(() => 10),12,14,14,14,14,18,10,10,30,10], [money, money + 1, money + 2, money + 3]), 'شرکت‌کننده‌های جدید');
  }
  if (want.has('payments')){
    const pays = Object.values(S.payments).sort((a,b) => ts(a.created_at) - ts(b.created_at));
    const via = x => String(x.file_path || '').startsWith('bot/') ? 'ربات تلگرام' : !hasFile(x) ? 'ثبت دستی' : 'سایت';
    const a = [['ردیف','نام','موبایل / شماره','لیست','مبلغ','وضعیت','کد پیگیری','تاریخ','از طریق','بررسی‌کننده','یادداشت بررسی']];
    pays.forEach((x,i) => { const p = S.participants[x.participant_id] || {}; a.push([i+1, p.full_name||'', shownNo(p.student_no)||'', isExtra(p) ? 'جدید' : 'اصلی', Number(x.amount)||0, PAY_STATUS[x.status] || x.status, x.tracking_code||'', faDay(x.created_at), via(x), x.reviewed_by||'', x.review_note||'']); });
    a.push([], ['','تأییدشده','','', sum(pays.filter(x => x.status === 'approved'), x => x.amount)], ['','در انتظار بررسی','','', sum(pays.filter(x => x.status === 'submitted'), x => x.amount)]);
    addSheet(wb, sheetFrom(a, [6,24,16,8,14,14,16,12,12,14,28], [4]), 'فیش‌ها');
  }
  if (want.has('codes') && withCodes){
    const a = [['ردیف','نام','موبایل / شماره','لیست','کد رأی']];
    everyone.filter(p => myCodes.get(p.id)).forEach((p,i) => a.push([i+1, p.full_name||'', shownNo(p.student_no)||'', isExtra(p) ? 'جدید' : 'اصلی', myCodes.get(p.id)]));
    addSheet(wb, sheetFrom(a, [6,26,16,8,12], []), 'کدهای رأی');
  }
  if (!wb.SheetNames.length){ toast('برای موارد انتخاب‌شده چیزی ثبت نشده'); return; }

  const d = new Intl.DateTimeFormat(FILE_DATE, {year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(new Date());
  const ds = ['year','month','day'].map(k => d.find(p => p.type === k)?.value).join('-');
  const name = `grad-finance-${ds}.xlsx`; // a plain Latin name: Persian ones get mangled by some apps
  // inside Telegram a download goes nowhere, so the bot sends the file to the person instead
  if (tgWA) return xlToBot(wb, name, [...want].map(k => (xlChoices().find(c => c[0] === k) || [])[1]).filter(Boolean));
  XLSX.writeFile(wb, name);
}
const XL_BOT_ERR = {no_telegram:'حسابت به تلگرام وصل نیست؛ سایت رو در مرورگر باز کن و از اونجا خروجی بگیر.', start_bot_first:'اول ربات رو توی تلگرام Start کن، بعد دوباره امتحان کن.',
  not_staff:'فقط تیم مالی می‌تونه خروجی بگیره.', bad_file:'فایل خیلی بزرگه؛ موارد کمتری انتخاب کن.'};
async function xlToBot(wb, name, sheets){
  toast('در حال فرستادن فایل در ربات…');
  const data = XLSX.write(wb, {bookType:'xlsx', type:'base64'});
  const caption = tr('📊 خروجی اکسل · {0}', new Intl.DateTimeFormat(I18N.dateLocale, {dateStyle:'medium', timeStyle:'short'}).format(new Date())) + (sheets.length ? `\n${sheets.map(x => tr(x)).join(tr('، '))}` : '');
  const { error } = await sb.functions.invoke('telegram-auth', {body:{send_file:{name, data, caption}}});
  if (!error){ toast('فایل اکسل توی ربات برات فرستاده شد'); return; }
  let b = {}; try { b = await error.context.json(); } catch(e){}
  console.error('send_file', b);
  toast(XL_BOT_ERR[b.error] || 'فرستادن فایل در ربات نشد؛ مطمئن شو تابع telegram-auth به‌روز شده، یا سایت رو در مرورگر باز کن.');
}
$('#exportBtn').addEventListener('click', openXlsx);
/* ---------- full backup (admin) ----------
   Every table the admin can read, as JSON, plus the receipt and invoice pictures, in one zip. Rows are read fresh from
   the database (1000 at a time), not from the page. Inside Telegram the bot sends it instead, split in parts under 6 MB. */
const BK_TABLES = [['settings','id'], ['payment_info','id'], ['members','user_id'], ['participants','id'], ['payments','id'], ['voting_codes','code'],
  ['items','id'], ['invoices','id'], ['funds','id'], ['activity','id'], ['bot_settings','id'], ['bot_users','telegram_id'], ['bot_broadcasts','id']];
const BK_PART = 6 * 1024 * 1024;
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++){ let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8){ let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
// a plain (stored, uncompressed) zip; pictures are compressed already. File names are UTF-8.
function makeZip(files){
  const enc = new TextEncoder(), parts = [], central = [], d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  let off = 0;
  files.forEach(f => {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(10, time, true); h.setUint16(12, date, true);
    h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true); h.setUint16(26, name.length, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(12, time, true); c.setUint16(14, date, true);
    c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    parts.push(new Uint8Array(h.buffer), name, f.data); central.push(new Uint8Array(c.buffer), name);
    off += 30 + name.length + size;
  });
  const e = new DataView(new ArrayBuffer(22)), cd = central.reduce((a, b) => a + b.length, 0);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cd, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], {type:'application/zip'});
}
async function bkTable(table, key){
  const rows = [];
  for (let from = 0; ; from += 1000){
    const { data, error } = await sb.from(table).select('*').order(key).range(from, from + 999);
    if (error) return {rows, error:error.message || String(error.code || 'error')};
    rows.push(...(data || []));
    if (!data || data.length < 1000) return {rows};
  }
}
async function bkFiles(bucket, paths, got, status){
  const out = [], missing = [];
  for (let i = 0; i < paths.length; i += 50){
    const chunk = paths.slice(i, i + 50);
    const { data, error } = await sb.storage.from(bucket).createSignedUrls(chunk, 600);
    if (error){ missing.push(...chunk); continue; }
    const urls = new Map((data || []).filter(x => x.signedUrl).map(x => [x.path, x.signedUrl]));
    for (let j = 0; j < chunk.length; j += 4) await Promise.all(chunk.slice(j, j + 4).map(async p => {
      try { const r = await fetch(urls.get(p)); if (!r.ok) throw 0; out.push({name:`${bucket}/${p}`, data:new Uint8Array(await r.arrayBuffer())}); }
      catch(e){ missing.push(p); }
      status(++got.n);
    }));
  }
  return {out, missing};
}
const u8ToB64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
let bkBusy = false;
async function fullBackup(btn){
  if (!canAdmin || bkBusy) return;
  bkBusy = true; btn.disabled = true;
  const msg = $('#bkMsg'), say = (t, cls = '') => { msg.className = 'sub ' + cls; msg.textContent = t; };
  try {
    say('در حال خواندن جدول‌ها…');
    const tables = {}, errors = {};
    for (const [t, key] of BK_TABLES){ const r = await bkTable(t, key); tables[t] = r.rows; if (r.error) errors[t] = r.error; }
    const receipts = [...new Set((tables.payments || []).filter(hasFile).map(x => x.file_path))];
    const invoices = [...new Set((tables.invoices || []).map(v => v.file_path).filter(Boolean))];
    const total = receipts.length + invoices.length, got = {n:0}, status = n => say(`در حال دریافت عکس‌ها: ${fmt(n)} از ${fmt(total)}…`);
    const r1 = await bkFiles('receipts', receipts, got, status), r2 = await bkFiles(BUCKET, invoices, got, status);
    const stamp = new Date();
    const data = {app:'grad-finance-site', exported_at:stamp.toISOString(), supabase_url:cfg.supabaseUrl || '', tables, errors,
      files:{receipts:receipts.length - r1.missing.length, invoices:invoices.length - r2.missing.length}, missing_files:{receipts:r1.missing, invoices:r2.missing}};
    const enc = new TextEncoder();
    const head = [{name:'data.json', data:enc.encode(JSON.stringify(data, null, 1))},
      {name:'README.txt', data:enc.encode([tr('پشتیبان کامل «{0}» — {1}', tr(S.settings.title || 'جشن'), stamp.toLocaleString(I18N.dateLocale)), '',
        tr('data.json: همه‌ی جدول‌ها (هر جدول یک فهرست از ردیف‌ها).'), tr('receipts/ و invoices/: عکس فیش‌ها و فاکتورها با همون مسیری که در Storage سوپابیس دارن.'),
        tr('برای برگرداندن: schema.sql رو در پروژه‌ی تازه اجرا کن، بعد ردیف‌ها رو از data.json وارد کن و پوشه‌ها رو در سطل‌های receipts و invoices آپلود کن.'), ''].join('\n'))}];
    const files = [...head, ...r1.out, ...r2.out];
    const d = new Intl.DateTimeFormat(FILE_DATE, {year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(stamp);
    const base = `grad-finance-backup-${['year','month','day'].map(k => d.find(p => p.type === k)?.value).join('-')}`;
    const problems = Object.keys(errors).length + r1.missing.length + r2.missing.length;
    const tail = tr('{0} ردیف، {1} عکس', fmt(Object.values(tables).reduce((a, r) => a + r.length, 0)), fmt(r1.out.length + r2.out.length)) + (problems ? ' ' + tr('({0} مورد خوانده نشد؛ فهرستش در data.json هست)', fmt(problems)) : '');
    if (!tgWA){
      const a = document.createElement('a'); a.href = URL.createObjectURL(makeZip(files)); a.download = base + '.zip';
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
      say(tr('پشتیبان دانلود شد:') + ' ' + tail, problems ? 'bad' : 'pos'); return;
    }
    // inside Telegram: the bot sends it, in parts small enough to upload
    const groups = [[]]; let size = 0;
    files.forEach(f => { if (size + f.data.length > BK_PART && groups.at(-1).length){ groups.push([]); size = 0; } groups.at(-1).push(f); size += f.data.length; });
    for (let i = 0; i < groups.length; i++){
      say(`در حال فرستادن در ربات: بخش ${fmt(i + 1)} از ${fmt(groups.length)}…`);
      const zip = new Uint8Array(await makeZip(groups[i]).arrayBuffer());
      const name = groups.length > 1 ? `${base}-part${i + 1}of${groups.length}.zip` : base + '.zip';
      const { error } = await sb.functions.invoke('telegram-auth', {body:{send_file:{name, data:u8ToB64(zip), caption:tr('🗄 پشتیبان کامل{0} {1}', groups.length > 1 ? tr('· بخش {0} از {1}', fmt(i + 1), fmt(groups.length)) : '', '\n' + tail)}}});
      if (error){ let b = {}; try { b = await error.context.json(); } catch(e){} say(XL_BOT_ERR[b.error] || 'فرستادن در ربات نشد؛ مطمئن شو تابع telegram-auth به‌روز شده، یا سایت رو در مرورگر باز کن.', 'bad'); return; }
    }
    say(tr('پشتیبان در ربات برات فرستاده شد{0}:', groups.length > 1 ? ' ' + tr('({0} بخش)', fmt(groups.length)) : '') + ' ' + tail, problems ? 'bad' : 'pos');
  } catch(e){ console.error('backup', e); say('ساخت پشتیبان انجام نشد؛ دوباره امتحان کن.', 'bad'); }
  finally { bkBusy = false; btn.disabled = false; }
}


boot();
})();
