-- اجازه به تیم مالی (مدیر و ویرایشگر) برای ثبت پرداخت به‌جای شرکت‌کننده‌ها
-- (پرداخت نقدی، یا فیشی که مستقیم برای خودت فرستادن). دکمه‌ی «ثبت پرداخت این نفر» در پنجره‌ی هر شرکت‌کننده.
-- یک بار در Supabase → SQL Editor اجرا کن (بعد از schema.sql). فقط دسترسی اضافه می‌کنه؛ اجرای دوباره‌ش ضرری نداره.
-- تأیید پرداخت مثل قبل با تابع review_payment انجام می‌شه، پس اضافه شدن به «سهم نفرات» همون منطق قبلی رو داره.

-- آیا کاربر فعلی مدیر یا ویرایشگره؟ (security definer تا به قوانین RLS جدول members وابسته نباشه)
create or replace function public.finance_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid() and role in ('admin', 'editor'));
$$;
revoke all on function public.finance_staff() from public;
grant execute on function public.finance_staff() to authenticated;

-- ثبت ردیف پرداخت برای هر شرکت‌کننده (قوانین قبلی، مثل ثبت فیش توسط خود شرکت‌کننده، سر جاشون می‌مونن)
grant insert on public.payments to authenticated;
drop policy if exists "finance staff record payments" on public.payments;
create policy "finance staff record payments" on public.payments
  for insert to authenticated with check (public.finance_staff());

-- آپلود عکس فیش در فضای receipts توسط تیم مالی
drop policy if exists "finance staff upload receipts" on storage.objects;
create policy "finance staff upload receipts" on storage.objects
  for insert to authenticated with check (bucket_id = 'receipts' and public.finance_staff());
