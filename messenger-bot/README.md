# Messenger AI Bot

A Facebook Messenger chatbot, powered by Claude, built to fix the 10 most common reasons Messenger bots fail their customers and their Pages.

**TL;DR:** Customers don't hate bots. They hate bots that loop, forget, guess, and won't let them reach a person. This bot understands free text in any language, remembers the conversation, answers only from your knowledge base, and hands off to a human when it should. It also handles Meta's platform rules: the 24-hour window, webhook retries, signatures, and message limits.

---

## The 10 problems and how this bot fixes each one

| # | Problem (from research) | Fix | Where |
|---|---|---|---|
| 1 | **No way to reach a human.** Most customers want the option to reach a person at any time. | "Talk to a person" in any common phrasing (EN/ES/FIL/DE/FR) skips the AI and hands off right away. The bot then stays silent while a person owns the thread. | `EscalationPolicy`, `Bot::handOff` |
| 2 | **Rigid keyword menus.** The bot only understands its exact buttons. | Claude reads free text, typos, and photos, and replies in the customer's language. | `ClaudeBrain` |
| 3 | **Forgets context.** It asks for things the customer already said. | Per-user history (last 20 turns) is stored in SQLite and sent with every request. | `ConversationStore` |
| 4 | **Loops and canned answers.** | The same intent 3 times in a row, an angry customer, or 2 strikes (frustration or low confidence) escalates to a person. | `EscalationPolicy::evaluate` |
| 5 | **Confident wrong answers.** | Answers come only from `knowledge/faq.md`. The model reports its confidence and says "not sure" instead of guessing. | `ClaudeBrain` system prompt |
| 6 | **24-hour window violations,** which can get a Page restricted. | Automated messages are blocked outside 24h of the user's last message. Handoff uses the Page Inbox, where people can reply. | `MessagingWindow`, `Bot::reply` |
| 7 | **Duplicate replies from webhook retries.** | Every event ID is processed once (idempotency table). | `ConversationStore::markProcessed` |
| 8 | **Slow replies and webhook timeouts.** Meta retries or disables slow webhooks. | Returns `200` before doing AI work (`fastcgi_finish_request`), shows the typing indicator, and uses `low` effort for chat speed. | `public/index.php` |
| 9 | **Send API errors** from oversized messages, too many quick replies, or raw markdown. | Splits text at 2000 chars, caps quick replies at 13 × 20 chars, and strips markdown. | `MessageFormatter` |
| 10 | **Breaks on non-text input** like stickers, voice notes, Get Started, and postbacks. | Every webhook shape is normalized: 👍 stickers count as text, photos go to Claude, and voice/video gets a polite "please type it". | `EventParser` |

**Also covered:**
- **Webhook security.** The `X-Hub-Signature-256` HMAC is checked on every POST.
- **AI outages.** The bot still answers and offers a person.
- **Refusals.** These go to a fallback model on the server side.

---

## How a message flows

```
Meta ──POST──▶ public/index.php
                 ├─ verify signature (401 if bad)
                 ├─ respond 200 immediately
                 └─ for each event ─▶ Bot::handle
                       1. dedupe by event ID
                       2. save message, refresh 24h window
                       3. if a human owns the thread → stay quiet
                       4. typing indicator
                       5. Get Started / voice note / "talk to a person" → handle directly
                       6. Claude → {reply, intent, confidence, sentiment, needs_human, quick_replies}
                       7. loop / frustration check → hand off, or
                       8. format + send (inside 24h window only)
```

---

## Setup

**Requirements:** PHP 8.2+ with curl, pdo_sqlite, and mbstring; Composer; a Facebook Page; a Meta app with the Messenger product; and an Anthropic API key.

```bash
cd messenger-bot
composer install
cp .env.example .env      # fill in tokens
# edit knowledge/faq.md with your real business info
```

**Meta app configuration:**

1. Messenger → Settings → generate a Page access token, then set `PAGE_ACCESS_TOKEN`.
2. App settings → Basic → App Secret, then set `APP_SECRET`.
3. Webhooks:
   - Callback URL: `https://your-domain/` (serve `public/` as the web root)
   - Verify token: your `VERIFY_TOKEN`
   - Subscribe to `messages`, `messaging_postbacks`, and `messaging_handovers`
4. Handover: in Page settings → Advanced messaging, make this app the **Primary Receiver** and **Page Inbox** the Secondary Receiver. When the inbox passes the thread back, the bot resumes.
5. Optional: set a Get Started button with payload `GET_STARTED` via the Messenger Profile API.

**Run locally** (use ngrok or a similar tunnel for the public HTTPS URL):

```bash
php -S 0.0.0.0:8080 -t public
```

> **Production:** run it under **PHP-FPM** (nginx/Apache). `php -S` has no `fastcgi_finish_request`, so it holds the 200 until the AI finishes. That works, but it's slower for Meta.

**Tests:**

```bash
vendor/bin/phpunit      # 19 tests, no network or API key needed
```

---

## Tuning

| Setting | Default | Change it when |
|---|---|---|
| `CLAUDE_MODEL` | `claude-opus-5-5` | You want a different cost/quality trade-off |
| Effort (`ClaudeBrain`) | `low` | Answers need more reasoning (`medium`) |
| `EscalationPolicy::MAX_SAME_INTENT` | 3 | Handoffs come too early or too late |
| `EscalationPolicy::MAX_STRIKES` | 2 | Same as above |
| `HUMAN_REPLY_ETA` | "as soon as possible" | Your team has a real SLA to show customers |
| History length | 20 turns | Conversations are long-running |

The bot resumes after a handoff when:
- The Page Inbox passes the thread back
- The customer types "bot"
- 24 hours pass

## Limitations

- It can't look up orders or accounts. Order-specific questions go to a person. To add lookups, give Claude a tool.
- Single SQLite file: fine for one server. Use MySQL or Postgres when you scale out.
- Handover Protocol needs the Page roles set up as described above. If the pass fails, messages still land in the Page Inbox.
