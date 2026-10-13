-- ساختار کامل دیتابیس سایت مالی جشن (Supabase)
-- برای یک پروژه‌ی تازه: فقط بخش ۱ (ایمیل مدیر) رو عوض کن، کل فایل رو در SQL Editor بچسبون و Run بزن.
-- اجرای دوباره‌ی کل فایل روی پروژه‌ای که با همین فایل ساخته شده ضرری نداره: داده‌ها پاک نمی‌شن،
-- فقط تابع‌ها و قوانین دسترسی دوباره ساخته می‌شن.
-- روی دیتابیسی که با نسخه‌ی دیگه‌ای از این فایل ساخته شده اجراش نکن: تابع‌هایی مثل review_payment
-- جایگزین می‌شن و ممکنه با ستون‌های اون دیتابیس جور نباشن.

-- ۱) ایمیل مدیر اصلی (خودت). هر وقت با این ایمیل حساب ساخته بشه، خودکار admin می‌شه.
create table if not exists public.app_config (
  id int primary key default 1 check (id = 1),
  admin_email text not null
);
insert into public.app_config (id, admin_email) values (1, 'me@example.com')
on conflict (id) do update set admin_email = excluded.admin_email;
alter table public.app_config enable row level security;   -- بدون policy: از سمت سایت خوانده نمی‌شه

-- ۲) اعضا و نقش‌ها
-- participant: شرکت‌کننده‌ای که شماره‌ش با تلگرام تأیید شده؛ فقط صفحه‌ی پرداخت خودش رو می‌بینه
-- rejected: درخواست دسترسی به پنل تیم مالی رد شده و می‌تونه دوباره درخواست بده؛ blocked: نمی‌تونه
-- (هر دو اگه شرکت‌کننده باشن، صفحه‌ی پرداختشون مثل قبل کار می‌کنه)
create table if not exists public.members (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  role              text not null default 'pending',
  display_name      text not null default '',
  email             text,
  telegram_id       bigint unique,
  telegram_username text,
  created_at        timestamptz not null default now()
);
-- قانون نقش‌ها (هر اسمی که قبلاً داشته) برداشته می‌شه و قانون کامل جاش میاد
do $$ declare c record; begin
  for c in select conname from pg_constraint
           where conrelid = 'public.members'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%role%' loop
    execute format('alter table public.members drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.members add constraint members_role_check
  check (role in ('admin','editor','viewer','participant','pending','rejected','blocked'));

create or replace function public.role_rank(r text)
returns int language sql immutable
as $$ select case r when 'admin' then 3 when 'editor' then 2 when 'viewer' then 1 else 0 end $$;

create or replace function public.my_role()
returns text language sql stable security definer set search_path = public
as $$ select role from public.members where user_id = auth.uid() $$;

create or replace function public.has_role(min_role text)
returns boolean language sql stable security definer set search_path = public
as $$ select public.role_rank(coalesce(public.my_role(), '')) >= public.role_rank(min_role) $$;

create or replace function public.my_name()
returns text language sql stable security definer set search_path = public
as $$ select coalesce(nullif(display_name, ''), 'نامشخص') from public.members where user_id = auth.uid() $$;

-- هر کاربر جدید (ایمیلی یا تلگرامی) خودکار با نقش pending اضافه می‌شه
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
declare meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  insert into public.members (user_id, email, display_name, telegram_id, telegram_username, role)
  values (
    new.id,
    case when new.email like '%@telegram.local' then null else new.email end,
    coalesce(nullif(trim(concat_ws(' ', meta->>'first_name', meta->>'last_name')), ''), split_part(new.email, '@', 1)),
    nullif(meta->>'telegram_id', '')::bigint,
    meta->>'username',
    case when lower(new.email) = (select lower(admin_email) from public.app_config where id = 1) then 'admin' else 'pending' end
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- کاربرهایی که از قبل ساخته شدن
insert into public.members (user_id, email, display_name, role)
select u.id, u.email, split_part(u.email, '@', 1),
       case when lower(u.email) = (select lower(admin_email) from public.app_config where id = 1) then 'admin' else 'pending' end
from auth.users u
on conflict (user_id) do nothing;
update public.members set role = 'admin'
where lower(email) = (select lower(admin_email) from public.app_config where id = 1);

-- درخواست دسترسی (خود کاربر صداش می‌زنه): کسی که ردیفش قبلاً پاک شده دوباره «در انتظار» می‌شه،
--    ردشده دوباره درخواست می‌ده، و مسدود همون مسدود می‌مونه. نقش فعلی رو برمی‌گردونه.
create or replace function public.request_access()
returns text language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); r text; u auth.users; meta jsonb;
begin
  if uid is null then return null; end if;
  select role into r from public.members where user_id = uid;
  if r is null then
    select * into u from auth.users where id = uid;
    if not found then return null; end if;
    meta := coalesce(u.raw_user_meta_data, '{}'::jsonb);
    insert into public.members (user_id, email, display_name, telegram_id, telegram_username, role)
    values (uid,
      case when u.email like '%@telegram.local' then null else u.email end,
      coalesce(nullif(trim(concat_ws(' ', meta->>'first_name', meta->>'last_name')), ''), split_part(u.email, '@', 1)),
      nullif(meta->>'telegram_id', '')::bigint, meta->>'username',
      case when lower(u.email) = (select lower(admin_email) from public.app_config where id = 1) then 'admin' else 'pending' end)
    on conflict (user_id) do nothing;
    select role into r from public.members where user_id = uid;
  elsif r = 'rejected' then
    update public.members set role = 'pending', created_at = now() where user_id = uid;
    r := 'pending';
  end if;
  return r;
end $$;
revoke all on function public.request_access() from public, anon;
grant execute on function public.request_access() to authenticated;

-- همیشه حداقل یک مدیر بمونه
create or replace function public.keep_one_admin()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin')
     and (select count(*) from public.members where role = 'admin') <= 1 then
    raise exception 'LAST_ADMIN';
  end if;
  return coalesce(new, old);
end;
$$;
drop trigger if exists members_keep_admin on public.members;
create trigger members_keep_admin before update or delete on public.members
  for each row execute function public.keep_one_admin();

-- ۳) ثبت «چه کسی و کی» روی هر ردیف
create or replace function public.stamp()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  new.updated_at := now();
  new.updated_by := public.my_name();
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := public.my_name();
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;

-- ۴) تنظیمات
create table if not exists public.settings (
  id          int primary key default 1 check (id = 1),
  title       text   not null default 'جشن فارغ‌التحصیلی',
  budget      bigint not null default 0,
  headcount   int    not null default 0,
  currency    text   not null default 'تومان',
  created_at  timestamptz, created_by text,
  updated_at  timestamptz, updated_by text
);
insert into public.settings (id) values (1) on conflict do nothing;

-- ۵) هزینه‌ها
create table if not exists public.items (
  id          uuid primary key default gen_random_uuid(),
  title       text   not null,
  reason      text   not null default '',
  type        text   not null default 'must' check (type in ('must','maybe','optional')),
  category    text   not null default 'سایر',
  vendor      text   not null default '',
  unit        bigint not null default 0,
  qty         int    not null default 1,
  paid        boolean not null default false,
  actual      bigint not null default 0,
  payer       text   not null default '',
  created_at  timestamptz, created_by text,
  updated_at  timestamptz, updated_by text
);

-- ۶) بودجه: واریزی‌ها/منابع (fund) و سهم نفرات (contrib)
create table if not exists public.funds (
  id          uuid primary key default gen_random_uuid(),
  kind        text   not null check (kind in ('fund','contrib')),
  name        text   not null,
  amount      bigint not null default 0,
  paid        boolean not null default false,
  note        text   not null default '',
  created_at  timestamptz, created_by text,
  updated_at  timestamptz, updated_by text
);

-- ۷) فاکتورها — item_id به یک خرج اشاره می‌کنه (یک خرج، چند فاکتور)
create table if not exists public.invoices (
  id           uuid primary key default gen_random_uuid(),
  item_id      uuid references public.items(id) on delete set null,
  file_path    text not null,
  file_name    text not null default '',
  file_type    text not null default '',
  vendor       text not null default '',
  invoice_date text not null default '',
  total        bigint not null default 0,
  note         text not null default '',
  created_at   timestamptz, created_by text,
  updated_at   timestamptz, updated_by text
);
create index if not exists invoices_item_id_idx on public.invoices (item_id);

-- ۸) شرکت‌کننده‌ها
-- student_no: شماره‌ی موبایل به شکل 09xxxxxxxxx (کلید ورود با تلگرام). چند نفر با یک شماره:
-- 0912…، 0912…#2، 0912…#3. کسی که شماره نداره: ~<اسم>. شماره‌ی دانشجویی هم قبوله.
-- amount: اگه خالی باشه، سهم = مبلغ پیش‌فرض + تعداد مهمان × مبلغ هر مهمان
create table if not exists public.participants (
  id          uuid primary key default gen_random_uuid(),
  student_no  text   not null unique,
  full_name   text   not null default '',
  major       text   not null default '',
  guests      integer not null default 0 check (guests >= 0),
  amount      bigint check (amount >= 0),
  verify_code text,
  note        text   not null default '',
  user_id     uuid unique references auth.users(id) on delete set null,
  created_at  timestamptz, created_by text,
  updated_at  timestamptz, updated_by text
);
alter table public.participants
  add column if not exists major  text    not null default '',
  add column if not exists guests integer not null default 0 check (guests >= 0);

-- ۹) اطلاعات پرداخت (به شرکت‌کننده‌ها نشون داده می‌شه)
create table if not exists public.payment_info (
  id             int primary key default 1 check (id = 1),
  card_number    text   not null default '',
  card_holder    text   not null default '',
  bank           text   not null default '',
  sheba          text   not null default '',
  default_amount bigint not null default 0 check (default_amount >= 0),
  guest_amount   bigint not null default 0 check (guest_amount >= 0),
  deadline       text   not null default '',
  note           text   not null default '',
  created_at  timestamptz, created_by text,
  updated_at  timestamptz, updated_by text
);
alter table public.payment_info
  add column if not exists guest_amount bigint not null default 0 check (guest_amount >= 0);
-- شرکت‌کننده‌های جدید (تکمیلی): نوع، لوح، تندیس، پذیرایی؛ و قیمت این‌ها
alter table public.participants
  add column if not exists kind         text    not null default 'main' check (kind in ('main','extra')),
  add column if not exists wants_plaque boolean not null default false,
  add column if not exists wants_statue boolean not null default false,
  add column if not exists wants_album  boolean not null default false,   -- آلبوم عکس (Yearbook)
  add column if not exists catering     text    not null default 'undecided' check (catering in ('undecided','yes','no'));
alter table public.payment_info
  add column if not exists plaque_amount   bigint not null default 0 check (plaque_amount >= 0),
  add column if not exists statue_amount   bigint not null default 0 check (statue_amount >= 0),
  add column if not exists album_amount    bigint not null default 0 check (album_amount >= 0),
  add column if not exists catering_amount bigint not null default 0 check (catering_amount >= 0);
insert into public.payment_info (id) values (1) on conflict do nothing;

-- ۱۰) فیش‌ها (پرداخت‌ها)
-- فقط با «در انتظار بررسی» ثبت می‌شن؛ تأیید/رد فقط با تابع review_payment.
-- file_path: مسیر عکس در فضای receipts، یا manual/<id> برای پرداختی که تیم مالی بدون عکس ثبت کرده.
-- fund_id: ردیف «سهم نفرات» در بودجه که با تأیید این فیش ساخته شده
create table if not exists public.payments (
  id             uuid primary key default gen_random_uuid(),
  participant_id uuid   not null references public.participants(id) on delete cascade,
  file_path      text   not null,
  amount         bigint not null default 0 check (amount >= 0),
  tracking_code  text   not null default '',
  status         text   not null default 'submitted' check (status in ('submitted','approved','rejected')),
  review_note    text   not null default '',
  reviewed_by    text,
  reviewed_at    timestamptz,
  fund_id        uuid references public.funds(id) on delete set null,
  created_at  timestamptz, created_by text,
  updated_at  timestamptz, updated_by text
);
create index if not exists payments_participant_idx on public.payments (participant_id);

-- هر فیش تازه، هر کی ثبتش کنه، «در انتظار بررسی» شروع می‌شه
create or replace function public.payments_new()
returns trigger language plpgsql set search_path = public
as $$
begin
  new.status := 'submitted'; new.review_note := ''; new.reviewed_by := null; new.reviewed_at := null; new.fund_id := null;
  return new;
end;
$$;
drop trigger if exists payments_new on public.payments;
create trigger payments_new before insert on public.payments
  for each row execute function public.payments_new();

-- ۱۱) تاریخچه‌ی تغییرات (خودکار؛ هیچ‌کس از سمت سایت نمی‌تونه دستکاریش کنه)
create table if not exists public.activity (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor       uuid,
  actor_name  text,
  tbl         text not null,
  action      text not null,
  row_id      text,
  title       text,
  old_row     jsonb,
  new_row     jsonb
);
create index if not exists activity_at_idx on public.activity (at desc);

create or replace function public.log_activity()
returns trigger language plpgsql security definer set search_path = public
as $$
declare o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
        n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
        r jsonb := coalesce(n, o);
begin
  insert into public.activity (actor, actor_name, tbl, action, row_id, title, old_row, new_row)
  values (auth.uid(), public.my_name(), tg_table_name, lower(tg_op), r->>'id',
          coalesce(r->>'title', r->>'name', nullif(r->>'full_name', ''), nullif(r->>'vendor', ''), r->>'file_name',
                   case tg_table_name
                     when 'payments' then (select coalesce(nullif(full_name, ''), split_part(student_no, '#', 1))
                                             from public.participants where id::text = r->>'participant_id')
                     when 'payment_info' then 'اطلاعات پرداخت'
                     when 'participants' then split_part(r->>'student_no', '#', 1)
                   end,
                   'تنظیمات'), o, n);
  return null;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['settings','items','funds','invoices','participants','payments','payment_info'] loop
    execute format('drop trigger if exists %I_stamp on public.%I', t, t);
    execute format('create trigger %I_stamp before insert or update on public.%I for each row execute function public.stamp()', t, t);
    execute format('drop trigger if exists %I_log on public.%I', t, t);
    execute format('create trigger %I_log after insert or update or delete on public.%I for each row execute function public.log_activity()', t, t);
  end loop;
end $$;

-- ۱۲) تابع‌های کمکی دسترسی (security definer تا به قوانین RLS خود جدول‌ها وابسته نباشن)
-- آیا کاربر فعلی مدیر یا ویرایشگره؟
create or replace function public.finance_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid() and role in ('admin', 'editor'));
$$;
-- آیا کاربر فعلی به یک شرکت‌کننده وصل شده؟
create or replace function public.is_participant()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.participants where user_id = auth.uid());
$$;
-- شرکت‌کننده‌هایی که کاربر فعلی براشون پرداخت می‌کنه: خودش و هم‌شماره‌هاش (0912…، 0912…#2، …)
create or replace function public.my_number_participants()
returns setof text language sql stable security definer set search_path = public as $$
  select p.id::text from public.participants p
   where split_part(p.student_no, '#', 1) in
         (select split_part(student_no, '#', 1) from public.participants where user_id = auth.uid());
$$;
revoke all on function public.finance_staff() from public, anon;
revoke all on function public.is_participant() from public, anon;
revoke all on function public.my_number_participants() from public, anon;
grant execute on function public.finance_staff(), public.is_participant(), public.my_number_participants() to authenticated;

-- ۱۳) وصل شدن شرکت‌کننده به حسابش
-- claim_student رو کاربر مستقیم نمی‌تونه صدا بزنه (پایین‌تر دسترسیش گرفته می‌شه). فقط claim_verified_phone صداش
-- می‌زنه، اون هم فقط از تابع telegram-auth و بعد از اینکه تلگرام شماره رو امضا کرده.
create or replace function public.claim_student(p_no text, p_code text default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare uid uuid := auth.uid(); p public.participants; mine public.participants;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'not_signed_in'); end if;
  select * into p from public.participants where student_no = p_no;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if p.user_id = uid then return jsonb_build_object('ok', true); end if;
  if p.user_id is not null then return jsonb_build_object('ok', false, 'error', 'taken'); end if;
  select * into mine from public.participants where user_id = uid;
  if found then
    -- همین حساب قبلاً صاحب این شماره شده (مثلاً به نفر دوم همین شماره)
    if split_part(mine.student_no, '#', 1) = split_part(p_no, '#', 1) then return jsonb_build_object('ok', true); end if;
    return jsonb_build_object('ok', false, 'error', 'already_linked');
  end if;
  if coalesce(p.verify_code, '') <> '' and coalesce(p_code, '') <> p.verify_code then
    return jsonb_build_object('ok', false, 'error', 'bad_code');
  end if;
  update public.participants set user_id = uid where id = p.id and user_id is null;
  if not found then return jsonb_build_object('ok', false, 'error', 'taken'); end if;
  -- از «درخواست‌های جدید» تیم مالی بیرون بره
  update public.members set role = 'participant' where user_id = uid and role = 'pending';
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.claim_verified_phone(p_user uuid, p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_no text;
begin
  select student_no into v_no from public.participants
   where split_part(student_no, '#', 1) = p_phone
   order by length(student_no), student_no limit 1;
  if v_no is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  -- claim_student دقیقاً مثل وقتی که خود کاربر صداش می‌زد اجرا می‌شه
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  return to_jsonb(public.claim_student(p_no => v_no, p_code => right(p_phone, 4)));
end $$;
revoke all on function public.claim_verified_phone(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_verified_phone(uuid, text) to service_role;

do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'claim_student' loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- ۱۴) بررسی فیش: تأیید (approved)، رد (rejected) یا برگشت به بررسی (submitted)
-- تأیید، مبلغ رو به «سهم نفرات» در بودجه اضافه می‌کنه و برگشتش اون ردیف رو برمی‌داره.
-- خطاها: FORBIDDEN (بیننده/شرکت‌کننده)، ADMIN_ONLY (دست زدن به فیش تأییدشده)، NO_AMOUNT
create or replace function public.review_payment(p_id uuid, p_status text, p_note text default '', p_amount bigint default null)
returns void language plpgsql security definer set search_path = public
as $$
declare x public.payments; v_amount bigint; v_fund uuid; v_who text;
begin
  if not public.has_role('editor') then raise exception 'FORBIDDEN'; end if;
  if p_status not in ('submitted','approved','rejected') then raise exception 'BAD_STATUS'; end if;
  select * into x from public.payments where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  v_amount := coalesce(nullif(p_amount, 0), x.amount);
  if x.status = 'approved' and (p_status <> 'approved' or v_amount <> x.amount) and not public.has_role('admin') then
    raise exception 'ADMIN_ONLY';
  end if;
  if p_status = 'approved' and coalesce(v_amount, 0) <= 0 then raise exception 'NO_AMOUNT'; end if;

  v_fund := x.fund_id;
  if p_status = 'approved' then
    if v_fund is not null and exists (select 1 from public.funds where id = v_fund) then
      update public.funds set amount = v_amount, paid = true where id = v_fund and (amount <> v_amount or not paid);
    else
      select coalesce(nullif(full_name, ''), split_part(student_no, '#', 1)) into v_who
        from public.participants where id = x.participant_id;
      insert into public.funds (kind, name, amount, paid, note)
      values ('contrib', coalesce(v_who, 'شرکت‌کننده'), v_amount, true,
              'فیش' || case when x.tracking_code <> '' then ' · پیگیری ' || x.tracking_code else '' end)
      returning id into v_fund;
    end if;
  elsif v_fund is not null then
    delete from public.funds where id = v_fund;
    v_fund := null;
  end if;

  update public.payments
     set status = p_status, amount = v_amount, review_note = coalesce(p_note, ''),
         reviewed_by = public.my_name(), reviewed_at = now(), fund_id = v_fund
   where id = p_id;
end;
$$;
revoke all on function public.review_payment(uuid, text, text, bigint) from public, anon;
grant execute on function public.review_payment(uuid, text, text, bigint) to authenticated;

-- اضافه کردن مهمان توسط خود شرکت‌کننده (فقط زیاد کردن؛ کم کردن با تیم مالی)
-- برای خودش و هم‌شماره‌هاش؛ اگه مدیر «مبلغ کل» دستی گذاشته، هزینه‌ی مهمان‌های جدید به همون اضافه می‌شه.
create or replace function public.add_guests(p_id uuid, p_count int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.participants; price bigint;
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN'; end if;
  if p_count is null or p_count < 1 or p_count > 10 then raise exception 'BAD_COUNT'; end if;
  if p_id::text not in (select public.my_number_participants()) then raise exception 'FORBIDDEN'; end if;
  select * into p from public.participants where id = p_id for update;
  if p.kind <> 'main' then raise exception 'NOT_MAIN'; end if;
  if p.guests + p_count > 20 then raise exception 'TOO_MANY'; end if;
  select coalesce(guest_amount, 0) into price from public.payment_info where id = 1;
  update public.participants
     set guests = guests + p_count,
         amount = case when amount is null then null else amount + p_count * coalesce(price, 0) end
   where id = p_id
  returning * into p;
  return to_jsonb(p);
end $$;
revoke all on function public.add_guests(uuid, int) from public, anon;
grant execute on function public.add_guests(uuid, int) to authenticated;

-- ۱۵) دسترسی‌ها (Row Level Security)
alter table public.members      enable row level security;
alter table public.settings     enable row level security;
alter table public.items        enable row level security;
alter table public.funds        enable row level security;
alter table public.invoices     enable row level security;
alter table public.activity     enable row level security;
alter table public.participants enable row level security;
alter table public.payment_info enable row level security;
alter table public.payments     enable row level security;

grant select, insert, update, delete on public.members, public.settings, public.items, public.funds, public.invoices,
  public.participants, public.payment_info, public.payments to authenticated;
grant select on public.activity to authenticated;
grant all on all tables in schema public to service_role;
revoke all on public.app_config from anon, authenticated;

drop policy if exists members_select on public.members;
drop policy if exists members_update on public.members;
drop policy if exists members_delete on public.members;
create policy members_select on public.members for select to authenticated
  using (user_id = auth.uid() or public.has_role('admin'));
create policy members_update on public.members for update to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));
create policy members_delete on public.members for delete to authenticated
  using (public.has_role('admin'));

-- شرکت‌کننده‌ها واحد پول رو از تنظیمات می‌خونن
drop policy if exists settings_select on public.settings;
drop policy if exists settings_update on public.settings;
create policy settings_select on public.settings for select to authenticated
  using (public.has_role('viewer') or public.is_participant());
create policy settings_update on public.settings for update to authenticated
  using (public.has_role('editor')) with check (public.has_role('editor'));

do $$
declare t text;
begin
  foreach t in array array['items','funds','invoices','participants'] loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format('drop policy if exists %I_delete on public.%I', t, t);
    execute format('create policy %I_select on public.%I for select to authenticated using (public.has_role(''viewer''))', t, t);
    execute format('create policy %I_insert on public.%I for insert to authenticated with check (public.has_role(''editor''))', t, t);
    execute format('create policy %I_update on public.%I for update to authenticated using (public.has_role(''editor'')) with check (public.has_role(''editor''))', t, t);
    execute format('create policy %I_delete on public.%I for delete to authenticated using (public.has_role(''admin''))', t, t);
  end loop;
end $$;

-- شرکت‌کننده خودش و هم‌شماره‌هاش رو می‌بینه (و فقط می‌بینه)
drop policy if exists "shared number: see the others" on public.participants;
create policy "shared number: see the others" on public.participants for select to authenticated
  using (id::text in (select public.my_number_participants()));

drop policy if exists payment_info_select on public.payment_info;
drop policy if exists payment_info_update on public.payment_info;
create policy payment_info_select on public.payment_info for select to authenticated
  using (public.has_role('viewer') or public.is_participant());
create policy payment_info_update on public.payment_info for update to authenticated
  using (public.has_role('editor')) with check (public.has_role('editor'));

-- فیش‌ها: تیم مالی همه رو می‌بینه؛ شرکت‌کننده فیش‌های خودش و هم‌شماره‌هاش رو می‌بینه و می‌فرسته.
-- تغییر وضعیت فقط با review_payment؛ با حذف شرکت‌کننده فیش‌هاش هم پاک می‌شن.
drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments for select to authenticated using (public.has_role('viewer'));
drop policy if exists "shared number: see their receipts" on public.payments;
create policy "shared number: see their receipts" on public.payments for select to authenticated
  using (participant_id::text in (select public.my_number_participants()));
drop policy if exists "shared number: send their receipts" on public.payments;
create policy "shared number: send their receipts" on public.payments for insert to authenticated
  with check (participant_id::text in (select public.my_number_participants()) and status = 'submitted' and amount > 0);
-- تیم مالی برای هر کسی پرداخت ثبت می‌کنه (نقدی، یا فیشی که مستقیم براش فرستادن)
drop policy if exists "finance staff record payments" on public.payments;
create policy "finance staff record payments" on public.payments
  for insert to authenticated with check (public.finance_staff());
-- حذف فیش فقط کار مدیره، و فقط وقتی تأییدشده نیست؛ سایت فیش تأییدشده رو اول با review_payment به بررسی
-- برمی‌گردونه تا مبلغش از «سهم نفرات» کم بشه
drop policy if exists "admin deletes receipts" on public.payments;
create policy "admin deletes receipts" on public.payments
  for delete to authenticated using (public.has_role('admin') and status <> 'approved');

drop policy if exists activity_select on public.activity;
create policy activity_select on public.activity for select to authenticated using (public.has_role('viewer'));

-- ۱۶) فضای ذخیره فاکتورها (خصوصی، حداکثر ۱۰ مگابایت برای هر فایل)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoices', 'invoices', false, 10485760,
        array['image/jpeg','image/png','image/webp','image/gif','application/pdf'])
on conflict (id) do nothing;

drop policy if exists invoices_files_select on storage.objects;
drop policy if exists invoices_files_insert on storage.objects;
drop policy if exists invoices_files_update on storage.objects;
drop policy if exists invoices_files_delete on storage.objects;
create policy invoices_files_select on storage.objects for select to authenticated
  using (bucket_id = 'invoices' and public.has_role('viewer'));
create policy invoices_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'invoices' and public.has_role('editor'));
create policy invoices_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'invoices' and public.has_role('admin'));

-- ۱۷) فضای ذخیره عکس فیش‌ها (خصوصی). سایت عکس رو قبل از ارسال فشرده می‌کنه (زیر ۱ مگابایت).
-- هر کس در پوشه‌ی خودش (<user_id>/…) آپلود می‌کنه؛ هر کس عکس فیش‌هایی رو می‌بینه که خود فیش رو می‌تونه ببینه.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 2097152, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

drop policy if exists receipts_files_select on storage.objects;
drop policy if exists receipts_files_insert on storage.objects;
drop policy if exists receipts_files_delete on storage.objects;
create policy receipts_files_select on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and (public.has_role('viewer')
         or (storage.foldername(name))[1] = auth.uid()::text
         or exists (select 1 from public.payments x where x.file_path = objects.name)));
create policy receipts_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text
              and public.is_participant());
-- تیم مالی موقع ثبت پرداخت برای دیگران
drop policy if exists "finance staff upload receipts" on storage.objects;
create policy "finance staff upload receipts" on storage.objects
  for insert to authenticated with check (bucket_id = 'receipts' and public.finance_staff());
-- پاک کردن عکسی که فیشش ثبت نشد (فقط توسط خود آپلودکننده)، یا توسط مدیر
create policy receipts_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and (public.has_role('admin')
         or ((storage.foldername(name))[1] = auth.uid()::text
             and not exists (select 1 from public.payments x where x.file_path = objects.name))));

-- ۱۸) ربات: متن پیام خوش‌آمد، کسایی که ربات رو Start کردن، و سابقه‌ی پیام‌های همگانی (همه فقط برای مدیر)
create table if not exists public.bot_settings (
  id           int  primary key default 1 check (id = 1),
  welcome_text text not null default '' check (length(welcome_text) <= 2000),
  title        text generated always as ('پیام خوش‌آمد ربات') stored,   -- عنوان در تاریخچه
  created_at timestamptz, created_by text, updated_at timestamptz, updated_by text
);
insert into public.bot_settings (id) values (1) on conflict do nothing;

-- هر کس به ربات پیام بده (تابع telegram-auth با service role می‌نویسه)
create table if not exists public.bot_users (
  telegram_id  bigint primary key,
  first_name   text   not null default '',
  username     text,
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  blocked      boolean not null default false
);

create table if not exists public.bot_broadcasts (
  id     uuid primary key default gen_random_uuid(),
  text   text not null,
  sent   int  not null default 0,
  failed int  not null default 0,
  title  text generated always as (left(text, 60)) stored,             -- عنوان در تاریخچه
  created_at timestamptz, created_by text, updated_at timestamptz, updated_by text
);

do $$
declare t text;
begin
  foreach t in array array['bot_settings','bot_broadcasts'] loop
    execute format('drop trigger if exists %I_stamp on public.%I', t, t);
    execute format('create trigger %I_stamp before insert or update on public.%I for each row execute function public.stamp()', t, t);
    execute format('drop trigger if exists %I_log on public.%I', t, t);
    execute format('create trigger %I_log after insert or update or delete on public.%I for each row execute function public.log_activity()', t, t);
  end loop;
end $$;

alter table public.bot_settings   enable row level security;
alter table public.bot_users      enable row level security;
alter table public.bot_broadcasts enable row level security;
grant select, update on public.bot_settings to authenticated;
grant select on public.bot_users to authenticated;
grant select, insert on public.bot_broadcasts to authenticated;
grant all on public.bot_settings, public.bot_users, public.bot_broadcasts to service_role;

drop policy if exists bot_settings_admin on public.bot_settings;
create policy bot_settings_admin on public.bot_settings for all to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));
drop policy if exists bot_users_admin on public.bot_users;
create policy bot_users_admin on public.bot_users for select to authenticated using (public.has_role('admin'));
drop policy if exists bot_broadcasts_select on public.bot_broadcasts;
create policy bot_broadcasts_select on public.bot_broadcasts for select to authenticated using (public.has_role('admin'));
drop policy if exists bot_broadcasts_insert on public.bot_broadcasts;
create policy bot_broadcasts_insert on public.bot_broadcasts for insert to authenticated with check (public.has_role('admin'));

-- ۱۹) کدهای ورود رأی‌گیری: هر شرکت‌کننده‌ی اصلی یک کد تصادفی (شرکت‌کننده‌های جدید کد ندارن). هر کس کد خودش (و هم‌شماره‌هاش) رو می‌بینه؛
-- مدیرها همه‌ی کدها رو می‌بینن (برای کسی که از ربات و سایت استفاده نمی‌کنه). تغییر کدها فقط از طریق تابع‌های پایینه.
-- کدی که عوض می‌شه یا صاحبش حذف می‌شه «باطل» (retired) می‌شه و دیگه به کسی داده نمی‌شه. در تاریخچه ثبت نمی‌شه.
-- اجرای دوباره ضرری نداره.
create table if not exists public.voting_codes (
  code           text primary key check (code ~ '^[A-Z0-9]{4,16}$'),
  participant_id uuid unique references public.participants(id) on delete set null,
  retired        boolean not null default false,
  assigned_at    timestamptz,
  created_at     timestamptz not null default now()
);
alter table public.voting_codes enable row level security;
revoke all on public.voting_codes from anon, authenticated;
grant select on public.voting_codes to authenticated;
grant all on public.voting_codes to service_role;
drop policy if exists voting_codes_own on public.voting_codes;
create policy voting_codes_own on public.voting_codes for select to authenticated
  using (participant_id::text in (select public.my_number_participants()));
drop policy if exists voting_codes_admin on public.voting_codes;
create policy voting_codes_admin on public.voting_codes for select to authenticated using (public.has_role('admin'));

-- وضعیت برای مدیر: چند کد، کیا کد دارن (بدون خود کد)
create or replace function public.voting_code_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_role('admin') then raise exception 'FORBIDDEN'; end if;
  return jsonb_build_object(
    'total',    (select count(*) from public.voting_codes where not retired),
    'assigned', (select count(*) from public.voting_codes where participant_id is not null),
    'free',     (select count(*) from public.voting_codes where participant_id is null and not retired),
    'retired',  (select count(*) from public.voting_codes where retired),
    'has',      (select coalesce(jsonb_agg(participant_id), '[]'::jsonb) from public.voting_codes where participant_id is not null));
end $$;

-- اضافه کردن کدها از فایل (تکراری‌ها و کدهای باطل‌شده نادیده گرفته می‌شن)
create or replace function public.add_voting_codes(p_codes text[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare v text; added int := 0; existing int := 0; invalid int := 0;
begin
  if not public.has_role('admin') then raise exception 'FORBIDDEN'; end if;
  foreach v in array coalesce(p_codes, '{}') loop
    v := upper(regexp_replace(coalesce(v, ''), '\s', '', 'g'));
    if v = '' then continue; end if;
    if v !~ '^[A-Z0-9]{4,16}$' then invalid := invalid + 1; continue; end if;
    insert into public.voting_codes (code) values (v) on conflict (code) do nothing;
    if found then added := added + 1; else existing := existing + 1; end if;
  end loop;
  return jsonb_build_object('added', added, 'existing', existing, 'invalid', invalid);
end $$;

-- به هر شرکت‌کننده‌ی بدون کد، یک کد آزاد تصادفی
create or replace function public.assign_voting_codes()
returns jsonb language plpgsql security definer set search_path = public as $$
declare k int;
begin
  if not public.has_role('admin') then raise exception 'FORBIDDEN'; end if;
  with need as (select p.id, row_number() over (order by random()) n from public.participants p
                 where p.kind = 'main' and not exists (select 1 from public.voting_codes v where v.participant_id = p.id)),
       pool as (select code, row_number() over (order by random()) n from public.voting_codes
                 where participant_id is null and not retired)
  update public.voting_codes v set participant_id = need.id, assigned_at = now()
    from need join pool using (n) where v.code = pool.code;
  get diagnostics k = row_count;
  return jsonb_build_object('assigned', k,
    'free', (select count(*) from public.voting_codes where participant_id is null and not retired),
    'without', (select count(*) from public.participants p where p.kind = 'main' and not exists (select 1 from public.voting_codes v where v.participant_id = p.id)));
end $$;

-- کد جدید برای یک نفر (کد قبلی باطل می‌شه)
create or replace function public.reissue_voting_code(p_participant uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v text;
begin
  if not public.has_role('admin') then raise exception 'FORBIDDEN'; end if;
  if not exists (select 1 from public.participants where id = p_participant and kind = 'main') then raise exception 'NOT_FOUND'; end if;
  select code into v from public.voting_codes where participant_id is null and not retired order by random() limit 1 for update skip locked;
  if v is null then raise exception 'NO_FREE_CODES'; end if;
  update public.voting_codes set participant_id = null, retired = true where participant_id = p_participant;
  update public.voting_codes set participant_id = p_participant, assigned_at = now() where code = v;
  return jsonb_build_object('ok', true);
end $$;

-- کد شخص حذف‌شده (یا کسی که دیگه شرکت‌کننده‌ی اصلی نیست) باطل می‌شه؛ شرکت‌کننده‌ی اصلی‌ای که بعداً اضافه بشه،
-- اگه کد آزاد باشه خودکار یکی می‌گیره
create or replace function public.voting_code_on_participant()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    update public.voting_codes set participant_id = null, retired = true where participant_id = old.id;
    return old;
  end if;
  if tg_op = 'UPDATE' and new.kind is not distinct from old.kind then return new; end if;
  if new.kind <> 'main' then
    update public.voting_codes set participant_id = null, retired = true where participant_id = new.id;
    return new;
  end if;
  if exists (select 1 from public.voting_codes where participant_id = new.id) then return new; end if;
  update public.voting_codes set participant_id = new.id, assigned_at = now()
   where code = (select code from public.voting_codes where participant_id is null and not retired order by random() limit 1 for update skip locked);
  return new;
end $$;
drop trigger if exists participants_voting_code_del on public.participants;
create trigger participants_voting_code_del before delete on public.participants
  for each row execute function public.voting_code_on_participant();
drop trigger if exists participants_voting_code_new on public.participants;
create trigger participants_voting_code_new after insert or update of kind on public.participants
  for each row execute function public.voting_code_on_participant();

-- برای ربات (فقط تابع telegram-auth با service role): کد صاحب این حساب تلگرام و هم‌شماره‌هاش
create or replace function public.voting_codes_for_telegram(p_tg bigint)
returns table (full_name text, code text) language sql stable security definer set search_path = public as $$
  select p.full_name, v.code
    from public.members m
    join public.participants mine on mine.user_id = m.user_id
    join public.participants p on split_part(p.student_no, '#', 1) = split_part(mine.student_no, '#', 1)
    join public.voting_codes v on v.participant_id = p.id
   where m.telegram_id = p_tg
   order by p.student_no;
$$;
-- برای «ارسال کد برای همه»: هر کدی که صاحبش (یا صاحب شماره‌ش) با تلگرام وارد سایت شده
create or replace function public.voting_codes_to_send()
returns table (telegram_id bigint, full_name text, code text) language sql stable security definer set search_path = public as $$
  select distinct on (p.id) m.telegram_id, p.full_name, v.code
    from public.voting_codes v
    join public.participants p on p.id = v.participant_id
    join public.participants owner on split_part(owner.student_no, '#', 1) = split_part(p.student_no, '#', 1) and owner.user_id is not null
    join public.members m on m.user_id = owner.user_id and m.telegram_id is not null
   order by p.id, (owner.id = p.id) desc;
$$;
revoke all on function public.voting_code_status(), public.add_voting_codes(text[]), public.assign_voting_codes(),
  public.reissue_voting_code(uuid) from public, anon;
grant execute on function public.voting_code_status(), public.add_voting_codes(text[]), public.assign_voting_codes(),
  public.reissue_voting_code(uuid) to authenticated;
revoke all on function public.voting_codes_for_telegram(bigint), public.voting_codes_to_send() from public, anon, authenticated;
grant execute on function public.voting_codes_for_telegram(bigint), public.voting_codes_to_send() to service_role;

-- ۲۰) لینک پرداخت در ربات، برای کسایی که خودشون وارد سایت نشدن: t.me/<ربات>?start=<pay_token>
-- با این لینک ربات مبلغ و شماره کارت رو (با دکمه‌ی کپی) نشون می‌ده و عکس رسید رو می‌گیره و برای بررسی ثبت می‌کنه.
-- «لینک جدید» (pay_token تازه) لینک قبلی رو باطل می‌کنه. کد رأی از این راه نشون داده نمی‌شه، چون لینک ممکنه دست کس دیگه‌ای هم بیفته.
-- تابع‌ها فقط برای telegram-auth (service role) هستن. اجرای دوباره ضرری نداره.
alter table public.participants add column if not exists pay_token uuid not null default gen_random_uuid();
create unique index if not exists participants_pay_token_key on public.participants (pay_token);
alter table public.bot_users add column if not exists pay_token uuid;
-- بعد از زدن «ثبت پرداخت» در ربات: از کی منتظر عکس رسیده (پیام بعدی اگه عکس نباشه، ثبت رسید لغو می‌شه)
alter table public.bot_users add column if not exists receipt_wait_at timestamptz;

-- مبلغ هر نفر، با همون حسابی که سایت می‌کنه
create or replace function public.participant_due(p public.participants)
returns bigint language sql stable security definer set search_path = public as $$
  select case
    when p.amount is not null then p.amount
    when p.kind = 'extra' then (case when p.wants_plaque then i.plaque_amount else 0 end)
                             + (case when p.wants_statue then i.statue_amount else 0 end)
                             + (case when p.wants_album then i.album_amount else 0 end)
                             + (case when p.catering = 'yes' then i.catering_amount else 0 end)
    else i.default_amount + p.guests * i.guest_amount
  end
  from public.payment_info i where i.id = 1;
$$;

-- کسی که این حساب تلگرام براش پرداخت می‌کنه: آخرین لینکی که باهاش Start کرده (اگه هنوز معتبره)، وگرنه شرکت‌کننده‌ای که
-- صاحب این حساب تلگرام با اون وارد سایت شده
create or replace function public.bot_pay_target(p_tg bigint)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select p.id from public.bot_users b join public.participants p on p.pay_token = b.pay_token where b.telegram_id = p_tg),
    (select p.id from public.members m join public.participants p on p.user_id = m.user_id where m.telegram_id = p_tg limit 1));
$$;

-- p_token: لینکی که باهاش ربات رو Start کرده (این حساب از این به بعد برای همون نفر رسید می‌فرسته). بدون p_token: همون نفر قبلی.
create or replace function public.bot_pay_info(p_tg bigint, p_token text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t uuid; pid uuid; via text := 'link'; p public.participants; i public.payment_info; ok bigint; pend bigint; cur text;
begin
  if p_token is not null then
    begin t := p_token::uuid; exception when others then return jsonb_build_object('ok', false, 'error', 'bad_link'); end;
    select id into pid from public.participants where pay_token = t;
    if pid is null then return jsonb_build_object('ok', false, 'error', 'bad_link'); end if;
    insert into public.bot_users (telegram_id, pay_token) values (p_tg, t)
      on conflict (telegram_id) do update set pay_token = excluded.pay_token, last_seen_at = now();
  else
    select x.id into pid from public.bot_users b join public.participants x on x.pay_token = b.pay_token where b.telegram_id = p_tg;
    if pid is null then via := 'account'; pid := public.bot_pay_target(p_tg); end if;
    if pid is null then return jsonb_build_object('ok', false, 'error', 'unknown'); end if;
  end if;
  select * into p from public.participants where id = pid;
  select * into i from public.payment_info where id = 1;
  select coalesce(sum(amount) filter (where status = 'approved'), 0), coalesce(sum(amount) filter (where status = 'submitted'), 0)
    into ok, pend from public.payments where participant_id = pid;
  select coalesce(nullif(currency, ''), 'تومان') into cur from public.settings where id = 1;
  return jsonb_build_object('ok', true, 'via', via, 'id', p.id, 'full_name', p.full_name, 'due', public.participant_due(p),
    'approved', ok, 'pending', pend, 'card_number', i.card_number, 'card_holder', i.card_holder, 'bank', i.bank,
    'deadline', i.deadline, 'currency', coalesce(cur, 'تومان'));
end $$;

-- رسیدی که از ربات رسیده (عکسش رو telegram-auth قبلش در receipts/bot/... گذاشته)
create or replace function public.bot_pay_receipt(p_tg bigint, p_participant uuid, p_path text, p_amount bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  if public.bot_pay_target(p_tg) is distinct from p_participant then return jsonb_build_object('ok', false, 'error', 'unknown'); end if;
  if p_amount is null or p_amount <= 0 or p_path !~ '^bot/' then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  insert into public.payments (participant_id, file_path, amount, tracking_code) values (p_participant, p_path, p_amount, '')
    returning id into pid;
  return jsonb_build_object('ok', true, 'id', pid);
end $$;

revoke all on function public.participant_due(public.participants), public.bot_pay_target(bigint), public.bot_pay_info(bigint, text),
  public.bot_pay_receipt(bigint, uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.participant_due(public.participants), public.bot_pay_target(bigint), public.bot_pay_info(bigint, text),
  public.bot_pay_receipt(bigint, uuid, text, bigint) to service_role;

-- ۲۱) همگام‌سازی زنده
do $$
declare t text;
begin
  foreach t in array array['settings','items','funds','invoices','members','activity','participants','payments','payment_info'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- تا Data API تغییرات رو همون لحظه ببینه
notify pgrst, 'reload schema';
