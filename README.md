# Graduation Party Finance

**English** · [فارسی](README.fa.md)

A simple, free website for running the money side of a graduation party or any group event. The finance team records expenses, invoices and the budget. Participants sign in from inside Telegram, see their share and send a picture of their payment receipt. The site and its Telegram bot work in English and Persian.

![The main page, with sample data](docs/screenshot-en.png)

<sub>The screenshot uses made-up data.</sub>

## Features

- **Cost estimate against the budget:** every expense is a "must-have", a "maybe" or a "nice-to-have". The main page shows three estimates (minimum, likely, full) next to the budget cap and each person's share.
- **Fund:** money received, money on the way, spent so far and the balance, with a warning when there isn't enough cash for the remaining must-haves.
- **Invoices:** a picture or PDF of each invoice is linked to its expense. Paid expenses without an invoice are flagged.
- **Participants and shares:**
  - The registration list is imported from an Excel or CSV file.
  - Each person opens their own payment page with the phone number Telegram confirms, and sends a picture of their receipt.
  - The finance team approves or rejects receipts.
  - People who never sign in get a personal bot link: the bot shows their amount and the card number, and takes the receipt picture right there.
- **Items:** the admin defines a list of items (for example a plaque, a statue, a yearbook), each with a price. Items marked "in the share" come with the main share. **New participants** who join after the list is final pay only for the items they pick, plus catering once that's decided.
- **Voting codes (optional):** each main participant gets a unique code to sign in to a vote, shown on their payment page and in the bot. Turned on with `votingCodes: true` in `config.js`.
- **Roles and history:** everyone can only do what their role allows. Every change is recorded with who made it and the previous value.
- **Telegram bot (admins):** the bot's welcome message is edited from the site, and a broadcast can be sent to everyone who started the bot.
- **Messages to groups of participants (admins):** personalised messages to people who owe money, haven't paid, have settled and so on. They go out through the bot, and to people the bot can't reach, from the admin's own Telegram account (optional) by phone number.
- **Two languages:** every visitor can switch between English and Persian; the bot answers each person in their language.
- **Live sync and Excel export:** "Excel export" shows a checklist, and only the ticked sheets go into the file: summary, expenses, invoices, budget and shares, main participants, new participants, receipts and (admins only) voting codes. Fonts and libraries ship with the site, so it doesn't depend on a CDN.

## Files

```
index.html                                  the whole site (one file)
i18n.js                                     English translation of the site and the language choice
config.js                                   Supabase address, public key, bot name and options
schema.sql                                  database, access rules, history and file storage
supabase/functions/telegram-auth/index.ts   Telegram sign-in and the bot (Edge Function)
vendor/ , fonts/                            libraries and fonts (gramjs.js loads only when an admin connects their Telegram account)
docs/                                       screenshots for this guide
```

## Roles

| Role | View and export | Add and edit | Delete | Manage members |
|---|:-:|:-:|:-:|:-:|
| Admin | ✓ | ✓ | ✓ | ✓ |
| Editor | ✓ | ✓ | ✗ | ✗ |
| Viewer | ✓ | ✗ | ✗ | ✗ |
| Participant | their own payment page | sending receipts | ✗ | ✗ |
| Awaiting approval | ✗ | ✗ | ✗ | ✗ |
| Rejected / blocked | ✗ | ✗ | ✗ | ✗ |

- Anyone who signs in with Telegram starts as "awaiting approval".
- If their number is on the participant list, confirming it in Telegram makes them a participant automatically.
- Otherwise an admin sets their role in the **Members** tab, or **rejects** or **blocks** the request.
- **Rejected:** they see "your request wasn't approved" and can ask again; the request then shows up in the panel again.
- **Blocked:** they can't ask again and don't show up in the panel, unless an admin unblocks them.
- Rejected and blocked only concern the finance team panel: a participant's payment page keeps working.
- These limits are enforced by the database itself (Row Level Security), not just by the page.

## Setup

Everything runs on the free plans of Supabase and GitHub Pages.

### 1) Supabase database

1. Create a new project at [supabase.com](https://supabase.com).
2. Copy `schema.sql` and, in its section 1, change `me@example.com` to the admin's email. The email is stored only in the database; there's no need to change it in the repository.
3. Paste it in the **SQL Editor** and press **Run**.

### 2) Admin account

1. In **Authentication → Users → Add user → Create new user**, create a user:
   - email: the same email as above
   - a password
   - **Auto Confirm User** on

   This user becomes an admin automatically. The order of this step and step 1 doesn't matter.
2. In **Authentication → Sign In / Providers**, turn **Allow new users to sign up** off. Telegram sign-in still works, because the sign-in function creates Telegram users itself.

Email sign-in is hidden on the main page. Admins open the site with `?email` at the end to see it, e.g. `https://username.github.io/grad-finance-site/?email`.

### 3) Telegram bot

Message [@BotFather](https://t.me/BotFather) in Telegram:

1. Send `/newbot`, then choose a name and a username (e.g. `PartyFinanceBot`). Keep the bot **token** secret.
2. Send `/setdomain`, choose the bot, then send just the site's domain, without `https://` or a path, e.g. `username.github.io`.

### 4) Telegram sign-in function (Edge Function)

**From the Supabase dashboard:**

1. Press **Edge Functions → Deploy a new function → Via Editor**.
   - The function name must be exactly `telegram-auth`.
   - Replace the default code with `supabase/functions/telegram-auth/index.ts` and press **Deploy**.
2. In the function's settings, turn **Verify JWT** (or Enforce JWT verification) off. People have no session yet when they sign in; the function checks Telegram's signature itself.
3. In **Edge Functions → Secrets**, add a secret named `TELEGRAM_BOT_TOKEN` with the bot token.

**Or with the Supabase CLI:**

```bash
supabase functions deploy telegram-auth --no-verify-jwt
supabase secrets set TELEGRAM_BOT_TOKEN=123456:ABC...
```

Optional secrets:

| Secret | What it does |
|---|---|
| `VOTE_URL` | The voting site (`https://…`). With it, a "Go to the vote" button appears under the voting codes the bot sends. |
| `BOT_LANG` | `en` or `fa`: the bot's language for everyone who hasn't picked one with the language button. Without it, each person gets the language of their Telegram app (Persian → Persian, anything else → English). |

Deploy the function again whenever its file changes in the repository.

### 5) `config.js`

Take the values from **Project Settings → API**:

| Key | Value |
|---|---|
| `supabaseUrl` | the project address, like `https://abcd1234.supabase.co` |
| `supabaseAnonKey` | the **anon** or **publishable** key. It's public. Never put the `service_role` or `secret` key here. |
| `telegramBot` | the bot's username, without `@` |
| `supportIds` | optional: the finance team's Telegram usernames, without `@`, e.g. `['ali_finance']`. They're shown to people whose number isn't on the list. |
| `votingCodes` | optional: `true` turns on voting codes (see below). |
| `voteUrl` | optional: the voting site, for the "Go to the vote" button next to each code on the site. |
| `defaultLang` | optional: `'en'` or `'fa'` for visitors who haven't picked a language. Empty: Persian for Persian browsers and Telegram apps, English for everyone else. |

### 6) Publish on GitHub Pages

1. Fork the repository (or put the files in a public repository).
2. In **Settings → Pages**, choose **Deploy from a branch**, with the `main` branch and the root folder.

No file in the repository holds a secret. The key in `config.js` is public, and the admin's email lives only in the database.

### 7) Turn on the bot button

Once the site is up, an admin presses **Set up the bot button** in the **Settings** tab. From then on:

- Anyone who starts the bot gets a welcome message with an "Open the site" button.
- The bot's menu button opens the site inside Telegram (as a Mini App), and the person is signed in without another tap.

The welcome text can be changed in the same tab, under **Bot welcome message**. `{name}` is replaced with each person's first name. A custom welcome is sent as written, in one language; leave it empty to send the built-in welcome in each person's language.

## Using it

### Finance team

- Team members sign in with Telegram. An admin sets each person's role (viewer, editor or admin) in the **Members** tab, and their panel opens right away.
- Each member's display name can be changed in the same tab. That name shows in the history and on "created by" labels.
- The **Members** tab groups people into new requests, finance team, participants, rejected and blocked. The last three are collapsed and open with a click.
- A finance team member's role can be changed to "participant" and back, from the same role list.
- "Remove access" moves a team member to "rejected". They can ask again if they want.

### Participants and payments

1. **Import the list:** in the **Participants** tab, **Import from sheet** reads the registration file (Excel or CSV).
   - A phone column is required. Name, major and number of guests are read too. Headers can be in English or Persian.
   - Headers don't have to be exact; "Phone number (preferably mobile)" is recognised as well.
   - The number of guests can be "2", "2 people" or a Persian word. Unclear ones are shown for checking before importing.
   - If the number cell holds something else too (a Telegram username, or two numbers with "Telegram" next to one), the mobile number is taken and the full text stays in that person's note.
   - People without a valid number are imported tagged "No number". They can't sign in until a number is added, but the finance team can record their payments by hand.
   - Importing the same file again doesn't create duplicates.
2. **The share:** in **Edit payment details**, set the card number, the default share and the amount per guest. Each person's share is "default share + guests × amount per guest". For a different amount, write a "Total amount" in that person's window.
3. **Signing in:** each person opens the site from the bot and taps **📱 Verify my number with Telegram**.
   - The number comes from Telegram itself and is checked against the list. Nobody types their number on the site.
   - Someone who opens the site in a browser only sees a button that opens the bot.
   - If the number isn't on the list, they're pointed to the finance team.
   - Once verified, they see their share (with the guests) and the card details, and send a picture of the receipt. The picture is compressed on their phone.
   - **Adding guests:** they can add guests themselves. They see the new share before confirming. Only the finance team can remove guests. If a "Total amount" was set for them, the new guests are added to it. Every change shows in the **History**.
   - **What you'll receive:** a card on each person's page lists what they get: for main participants, the items marked "in the share" and catering for them and their guests; for new participants, the items they asked for that are marked "in the share" (and catering, once decided).
   - **Extra payments:** after settling, they can still send an "Extra payment receipt". It's reviewed like the others. Anything above the share is shown to them and in the participant list ("+X extra").
4. **Reviewing receipts:** receipts show up in the **Participants** tab under "Receipts awaiting review".
   - **Approve** adds the amount to "Personal shares" in the budget.
   - **Reject** shows the reason to the person.
   - Only admins can reopen an approved receipt.
   - An admin can remove a receipt for good (a duplicate or a test, say) with **Delete receipt**. If it was approved, its amount is taken off "Personal shares" too.
5. **Cash or direct payments:** for money handed straight to the finance team, tap the person's name and choose **+ Record a payment for this person** (the receipt picture is optional). It's approved at once and the person's status updates.
6. **Several people on one number:** if several people registered with the same number, each is saved separately and tagged "Number shared". The number's owner switches between them after signing in and sends a receipt for each.
7. **Bot payment link:** for someone who doesn't sign in to the site (e.g. added by hand), press **Copy link** in their window and send it to them. In group messages, `{link}` is replaced with each person's link.
   - When they open it, the bot shows their share, what's left and the card number, with **Copy amount** and **Copy card number** buttons. (With the currency set to toman, the amount is copied in rials, as Iranian banks expect.)
   - After paying, they tap **🧾 Record payment** and send the receipt picture (or a screenshot). If they paid a different amount, they write it under the picture (as the caption). The receipt lands in the review queue tagged "via the Telegram bot".
   - If they send anything other than a picture after tapping the button (or 30 minutes pass), recording is cancelled and they tap the button again. A picture sent without tapping the button isn't recorded.
   - Opening the link again shows the payment details again. Other messages (even `/start`) get the bot's usual answer.
   - For the **Record payment** button to work in a bot that was set up earlier, press **Set up the bot button** in the **Settings** tab once more.
   - Anyone who has the link can send a receipt for that person (receipts are reviewed anyway). **New link** cancels the old one.

### Items and new participants

In **Edit payment details**, under **Items**, add a row per item: its name, its price and whether it's **in the share** (main participants get it as part of their share; it shows on their "What you'll receive" card). Removing an item takes it off everyone's list.

New participants are people added after the main list was final who only want some of the items:

- **Adding them:** in the **Participants** tab, choose **New (items only)** and press **+ Participant** (or switch a person's type to "New" in their window). Their items and catering are set right there.
- **Amount:** the sum of the items they picked, plus the catering price per person (also in **Edit payment details**) if catering is "yes". They have no guests and don't get a voting code automatically (an admin can give one by hand).
- **Catering:** each row has **Yes / No / ?** buttons, and all undecided people can be set at once from above the list. The summary above the list shows how many want each item, the catering answers and the total catering count (main participants and their guests, plus new participants with catering).
- **Kept apart:** summaries, group messages (the "New participants" group) and the Excel export (its own "New participants" sheet) count them separately.

### Voting codes (optional)

Turned on with `votingCodes: true` in `config.js`. Each main participant gets a unique code to sign in to a vote. Each person sees their own code (and those of people registered with the same number) on their payment page and every time they open the bot. Admins see each person's code in the participant list, in that person's window and in the Excel export, to hand it to someone who uses neither the bot nor the site. Viewers and editors don't see codes.

In the **Participants** tab, the **Voting codes** button above the list (admins only):

1. **Add codes:** choose a CSV or Excel file of codes (one per cell, capital letters and digits). Duplicates are skipped.
2. **Assign to everyone without one:** every main participant without a code gets a random free one. Anyone added to the main list later gets one automatically.
3. **Send everyone their code from the bot (optional):** the bot sends each person their code, to those who signed in with Telegram. These messages have no "Open the site" button.

- **Vote button:** with `voteUrl` in `config.js` (and the `VOTE_URL` secret for the bot), a **🗳 Go to the vote** button next to each code opens the voting site in the browser.
- **Seeing and copying:** each code shows next to the name in the list, and with a copy button in the person's window. Searching by code works too.
- **Codes for new participants:** they don't get one automatically. In the window of anyone you choose, press **Give a code**; it comes from the free codes and shows on the site, in the bot and in Excel like the others.
- **Taking a code back:** **Take the code back** in a person's window cancels it (it's never given to anyone else).
- **New code:** **Give a new code** cancels the current code and gives another free one.
- **Deleting or moving:** the code of someone deleted or moved to "new participants" is cancelled and never given to anyone else.
- **Limits:** whoever has access to the Supabase dashboard (the project owner) can see the codes in the `voting_codes` table. The bot payment link doesn't show the code, because anyone with the link would see it.

### Broadcasts from the bot

In the **Settings** tab, under **Broadcast from the bot** (admins only):

1. Write the message. You can add an "Open the site" button under it.
2. Press **Send a test to me** to get it yourself first and see how it looks. You need to have started the bot yourself.
3. Press **Send to everyone**. The site tells you how many people will get it and asks to confirm.

- **Recipients:** everyone who started the bot or signed in to the site with Telegram.
- **Not delivered:** people who blocked the bot or never started it get nothing, and are counted separately in the result.
- **History:** each broadcast is recorded in the **History** tab with the sender and the number of recipients.

### Messages to groups of participants

In the **Participants** tab, **Message participants** (admins only):

1. **Pick a group:** everyone who owes, not paid, partly paid, receipt awaiting review, settled, not signed in yet, new participants, or everyone. Each group shows its size.
2. **Write the message or pick a template:** payment reminder, thank you, invite to sign in, payment link. `{name}`, `{amount}`, `{paid}`, `{remaining}` and `{link}` are replaced with each person's name, share, amount paid, amount left and bot payment link. A preview shows the first person's message.
3. **Check the recipients:** the list shows how each person will be reached, and anyone can be unticked.
4. Press **Send a test to me** to get the message from the bot yourself, then **Send**.

Each message goes one of two ways:

- **The bot:** for people who signed in to the site with Telegram (or whose shared number's owner did). An "Open the site" button goes under the message, in the recipient's language.
- **The admin's personal Telegram account:** for everyone else, and people who blocked the bot, by their phone number. Messages go one by one, a few seconds apart, so the account isn't limited, and a link to the bot replaces the button. **Stop** works mid-way. If Telegram limits the account, sending stops by itself.

At the end, the people who weren't reached are listed with the reason. Each send is recorded in the **History** with the admin's name.

### The admin's personal Telegram account (optional)

The bot can only message people who signed in to the site with Telegram. To reach everyone else, an admin connects their own Telegram account (**Settings** tab → **My personal Telegram account**):

1. Sign in at [my.telegram.org](https://my.telegram.org/apps) and copy `api_id` and `api_hash` from **API development tools** (the same values libraries like Telethon use).
2. Enter them and your Telegram account's number, and press **Send sign-in code**.
3. Enter the code Telegram sends you, and your two-step password if you have one.

Security and technical notes:

- **The session:** it's kept only in that browser, not in the database. Anyone who has it has full access to the account. Don't use it on a shared device, and press **Disconnect** when you're done. The session also shows (and can be ended) in Telegram → Settings → Devices as "Party finance panel (web)".
- **VPN:** the account connects to Telegram straight from the browser, only while sending (or on **Check connection**). Where Telegram is blocked (as in Iran), this needs a VPN. The rest of the site doesn't.
- **Finding people by number:** a person is found only if their privacy settings allow being found by phone number.
- **Limits:** many messages to people who aren't your contacts can get the account limited for a while.
- **Library:** `vendor/gramjs.js` is the browser build of [GramJS](https://github.com/gram-js/gramjs) (2.26.22, MIT licence).

### Languages

- **The site:** English or Persian, with a language button on the sign-in page, in the panel's header and on the payment page; each visitor's choice is remembered in their browser. Before anyone chooses, the site follows `defaultLang` in `config.js`, else the browser's or Telegram's language (Persian → Persian, anything else → English). In English the page reads left to right and numbers and dates are in English; in Persian it reads right to left, with Persian digits and the Persian calendar. Excel files and backups follow the language of whoever makes them.
- **The bot:** each person gets the bot in their language: their own choice with the 🌐 button under the welcome message, else the `BOT_LANG` secret, else their Telegram app's language. Voting codes and group messages go out in each recipient's language.
- **What isn't translated:** what people type — names, notes, item names, the party title, a custom welcome message, group message texts — stays as typed. The built-in expense categories are stored in Persian and shown in the visitor's language.
- **Translating more text:** the page is written in Persian, and `i18n.js` holds the English text for each Persian string. A string that isn't in that table stays in Persian in the English page, so new text on the site needs a line there.

## Notes

- **Telegram users:** they're stored in Supabase with a made-up email like `tg123456@telegram.local`. It isn't a real address and nothing is sent to it.
- **The Telegram sign-in button in a browser:** works only on the domain set with `/setdomain` (not on `localhost` or a file opened directly).
- **Telegram's script:** the Telegram Mini App script ships with the site in `vendor/telegram-web-app.js`, because telegram.org is unreachable on some networks and a page inside Telegram loads its files over the device's normal connection, not through Telegram's.
- **Full backup (admins):** in the **Settings** tab, "Make a full backup" builds a zip: `data.json` with every table (participants, receipts, voting codes, expenses, invoices, deposits, members, history and the bot tables) and `receipts/` and `invoices/` folders with every receipt and invoice picture. Inside Telegram, the bot sends the file (in several parts if it's large). To restore: run `schema.sql` in a new project, import the rows from `data.json` and upload the folders to the buckets with the same names.
- **Excel export inside Telegram:** file downloads don't work inside Telegram, so when the site is open there, the bot sends the Excel file as a document to that team member (who must have started the bot). In a browser, the file downloads as usual.
- **Paused free projects:** a free Supabase project pauses after about a week without use. The data is kept and comes back with **Restore**.
- **Running `schema.sql` again:** safe on a project built from this file. No data is removed; functions and access rules are recreated, and older databases are upgraded (e.g. fixed plaque/statue/yearbook columns from earlier versions become items).
- **Built for Iran so far:** phone numbers are matched in the Iranian mobile format (`09…`, `+98…`), card numbers have 16 digits, and with the currency set to toman the bot and the site copy amounts in rials.

## Licence

[MIT](LICENSE)
