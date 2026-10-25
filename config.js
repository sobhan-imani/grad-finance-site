// Fill these in (see the README):
window.APP_CONFIG = {
  // Supabase → Project Settings → API
  supabaseUrl: 'https://hgftelnzebiucarmnbvl.supabase.co',
  supabaseAnonKey: 'sb_publishable_V05LlJT6dMl8xYRsRcfFAQ_F9zuOtmu',          // the anon / publishable key (it's public; never put service_role here)
  // Telegram bot username without @ (e.g. PartyFinanceBot). Leave empty to hide "Sign in with Telegram".
  telegramBot: 'loginviatelbot',
  // Optional: Telegram usernames of the finance team (without @), e.g. ['ali_finance', 'sara_fin'].
  // Shown as links to people whose number isn't on the list; if empty, they're told to message "the IDs announced in the group".
  supportIds: [],
  // Optional voting codes: true turns on the voting-code section (admin panel, payment page and bot).
  votingCodes: true,
  // The voting site; a "Go to the vote" button with this address appears next to each person's code. Empty = no button.
  voteUrl: 'https://armo.fun/',
  // Optional: 'en' or 'fa' to choose the language for visitors who haven't picked one with the language button.
  // Unset = Persian for Persian browsers / Telegram apps, English for everyone else.
  defaultLang: ''
};
