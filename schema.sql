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
create table if not exists public.members (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  role              text not null default 'pending',
  display_name      text not null default '',
  email             text,
  telegram_id       bigint unique,
  telegram_username text,
  created_at        timestamptz not null default now()
);
alter table public.members drop constraint if exists members_role_check;
alter table public.members add constraint members_role_check
  check (role in ('admin','editor','viewer','participant','pending'));

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

-- ۱۹) همگام‌سازی زنده
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
