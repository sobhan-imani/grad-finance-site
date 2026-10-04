// این مقدارها رو پر کن (راهنما در README):
window.APP_CONFIG = {
  // Supabase → Project Settings → API
  supabaseUrl: 'https://hgftelnzebiucarmnbvl.supabase.co',
  supabaseAnonKey: 'sb_publishable_V05LlJT6dMl8xYRsRcfFAQ_F9zuOtmu',          // کلید anon/publishable (عمومیه؛ هیچ‌وقت service_role نذار)
  // نام کاربری ربات تلگرام بدون @ (مثلاً PartyFinanceBot). خالی بذاری، دکمه‌ی ورود با تلگرام نمایش داده نمی‌شه.
  telegramBot: 'loginviatelbot',
  // اختیاری: آیدی تلگرام مسئول‌های مالی (بدون @)، مثلاً ['ali_finance', 'sara_fin'].
  // وقتی شماره‌ی کسی توی لیست نباشه، این‌ها به‌صورت لینک بهش نشون داده می‌شن؛ خالی بمونه، فقط به «آیدی‌هایی که توی گروه اعلام شده» ارجاع می‌ده.
  supportIds: []
};
