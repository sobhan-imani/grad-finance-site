-- گرایش و تعداد مهمانِ شرکت‌کننده‌ها + مبلغ هر مهمان
-- یک بار در Supabase → SQL Editor اجرا کن (بعد از schema.sql). فقط ستون اضافه می‌کنه؛ اجرای دوباره‌ش ضرری نداره.

alter table public.participants
  add column if not exists major  text    not null default '',
  add column if not exists guests integer not null default 0 check (guests >= 0);

alter table public.payment_info
  add column if not exists guest_amount bigint not null default 0 check (guest_amount >= 0);

-- اگه دسترسی‌ها در schema.sql ستون‌به‌ستون داده شده باشن، ستون‌های جدید هم همون دسترسی رو بگیرن
-- (اگه دسترسی کل جدول داده شده، این‌ها اثری ندارن؛ قوانین RLS مثل قبل برقرارن)
grant select (major, guests), insert (major, guests), update (major, guests) on public.participants to authenticated;
grant select (guest_amount), update (guest_amount) on public.payment_info to authenticated;

-- تا Data API ستون‌های جدید رو همون لحظه ببینه
notify pgrst, 'reload schema';
