# BuyerCapBot

A Telegram bot that watches your Billing team's cap messages and @GrstkBot's
call-count reports, keeps a running cap per buyer, and posts:

- **one cap-update message per buyer**, so every cap lands against the right code;
- **one reminder message** listing every buyer whose cap is low, depleted, or negative.

Everything it sees is stored as timestamped JSON under `data/`, in a folder per day.

---

## The two message formats

**Billing** — bulleted, values may be arithmetic. Only the final whole number matters:

```
Date : 28-07-2026

• Q01  - (-10)
• ZZY  - 67 + 25
• NB48 - (-30) + 20
• VKS  - 18 + 10
```

**@GrstkBot statistics** — plain `CODE - N` lines, cumulative calls made:

```
Buyers statistics:

NB48 - 2
ZZY - 19
C4V - 397
```

The bot tells them apart automatically (bullets, a `Date :` header, arithmetic, or
parenthesised negatives ⇒ Billing; a plain list from the stats bot ⇒ statistics).
You can force it by starting a message with `#billing` or `#stats`.

## What it posts

Per buyer, one line each:

> Update **ZZY** Cap **92**

Then a single reminder covering everyone who needs funds, as a numbered list per
urgency level, worst first:

> **▎PING FOR FUNDS**
>
> **▎CAP EXCEEDED (Total Over: -546)**
>
> 1\. **Q15**: -160
> 2\. **TLC**: -159
> 3\. **RHO**: -73
>
> **▎CAP DEPLETED (0 Left)**
>
> 1\. **N4K**
> 2\. **Q09**
>
> **▎CAP ALMOST DEPLETED**
>
> 1\. **BTJ**: 5 left
> 2\. **DSV**: 8 left

The three urgency levels are `CAP EXCEEDED` (negative), `CAP DEPLETED` (exactly
zero), and `CAP ALMOST DEPLETED` (at or below `ALMOST_DEPLETED_THRESHOLD`).
Numbering restarts in each group, and the exceeded heading carries the sum of the
overrun so total exposure is visible without adding it up by hand. Depleted
buyers are all at zero by definition, so their entries are just the code.

Every heading in every message opens with a `▎` bar and is bold — no underlines,
no emoji.

The cap-update line carries no footer. The figures behind it — previous
remaining, Billing's reported base, the top-up, the expression, and any mismatch
between the tracker and Billing — are all still written to the event log, and a
mismatch is also logged as a warning.

### Quiet first run

On a fresh install the bot **says nothing** until it has taken in both a Billing
sheet and a Buyer statistics report. Both are applied to the ledger silently —
that's the initial configuration. When the second one lands it posts a single
line and works normally from the next message on:

> **▎READY - 56 buyers configured**

The startup log says which of the two it's still waiting for, and repeats it each
time a message is applied — with `ENABLE_COMMANDS=true` you can also ask in the
group with `/day`. Set `QUIET_UNTIL_PRIMED=false` to have it post from its very
first message instead. An existing `data/state.json` that has already seen both
message kinds counts as configured, so upgrading doesn't silence a running bot.

Reminders are re-evaluated after **both** message types, so a cap that gets
eaten by new calls is caught as soon as the next GRSTK report lands.

---

## Setup

```bash
npm install
cp .env.example .env      # then fill in BOT_TOKEN
npm run build
npm start
```

For development: `npm run dev` (watch mode). To put it on a server, see
[DEPLOY.md](DEPLOY.md).

Add the bot to the group where Billing and @GrstkBot post, and — if it's a group —
disable privacy mode in @BotFather (`/setprivacy` → Disable) so it can read
messages it wasn't directly addressed in. To get a group's ID, run with
`LOG_LEVEL=debug` and post anything — the ID is in the log line. (`/chatid` also
reports it, but only if you've turned commands on; see below.)

### Where it listens vs. where it posts

These are separate lists, so the bot can watch the billing group and report
somewhere else entirely:

```dotenv
ALLOWED_CHAT_IDS=-1001111111111          # only read from the billing group
REPLY_TO_CHAT_IDS=-1002222222222,-1003333333333   # post to ops and management
```

`REPLY_TO_CHAT_IDS` takes any number of chats — each cap update, reminder, and
notice goes to all of them, in order, spaced by `MESSAGE_DELAY_MS`. Leave it
blank and the bot replies in whichever chat the source message came from.

Command replies (`/status`, `/buyer`, …) always go back to the chat the command
was typed in, so checking the numbers never spams the reporting groups. The one
exception is `/remind`, which deliberately posts the reminder to
`REPLY_TO_CHAT_IDS` because that is the message you are asking it to send.

### Dry run, no Telegram needed

```bash
npm run simulate            # baseline accounting
npm run simulate -- absolute
```

Feeds your real sample messages through the exact parser, engine, and formatter
the bot uses and prints what it would send. Nothing is written or transmitted.

---

## Excluding buyers

Set in the root `.env`, comma-separated, case-insensitive:

| Variable | Effect |
| --- | --- |
| `EXCLUDE_FROM_REMINDERS` | Cap still tracked, never appears in a funds reminder. |
| `EXCLUDE_FROM_UPDATES` | Cap still tracked, no cap-update message posted. |
| `EXCLUDE_BUYERS` | Ignored entirely — not tracked, not reported. |

```dotenv
EXCLUDE_FROM_REMINDERS=ZZY,TLC,Q01
EXCLUDE_FROM_UPDATES=BTJ,DSV
```

Changes take effect on restart. `/excluded` shows the live lists.

---

## Commands

**Off by default.** `ENABLE_COMMANDS=false` (the default) makes the bot drop
*every* slash message without a reply — `/start` and `/help` included — because
these groups host other bots that own those commands, and two bots answering one
command is worse than none. Billing and statistics messages are read and acted on
exactly as normal; only the `/` path is muted.

Set `ENABLE_COMMANDS=true` to switch the table below on:

| Command | |
| --- | --- |
| `/status` | Every buyer, lowest remaining cap first |
| `/buyer CODE` | One buyer in detail |
| `/pending` | Who is below threshold right now (doesn't send or reset cooldowns) |
| `/remind` | Re-send the reminder now, ignoring the cooldown |
| `/excluded` | Current exclusion lists |
| `/day` | Current UTC day, bot clock, messages applied today, quiet-run state |
| `/setcap CODE N` | Manually correct a cap (admin) |
| `/forget CODE` | Stop tracking a buyer (admin) |
| `/chatid` | This chat's ID |
| `/help` | Summary of all of the above |

Admin commands are open to everyone unless `ADMIN_USER_IDS` is set — worth setting
before you ever turn commands on, since `/setcap` and `/forget` write to the
ledger. Pair it with `ALLOWED_CHAT_IDS` so only your own groups can reach the bot.

---

## How "remaining" is calculated

Billing's pre-`+` figure is what's *left*, which is why it can be negative
(`Q01 - (-10)`). GRSTK's counter is cumulative. So with `CAP_ACCOUNTING=baseline`
(the default) the bot records the call count at the moment a cap is posted and
charges only calls made after it:

```
remaining = cap - (calls_now - calls_when_cap_was_set)
```

If a cap arrives before the bot has ever seen a call count for that buyer, the
next GRSTK report is adopted as the baseline rather than charged — otherwise the
buyer's history would be double-counted on the bot's first day. A counter that
goes backwards (GRSTK starting a new period) re-anchors the same way.

Set `CAP_ACCOUNTING=absolute` if the cap is instead a total allotment for the
same period GRSTK counts, i.e. `remaining = cap - calls_now` — a cap of 300
against 295 calls reads as 5 left regardless of when the cap was posted.

A reminder fires when `remaining <= ALMOST_DEPLETED_THRESHOLD` (default 10), or
below `REMINDER_THRESHOLD_PERCENT` of the cap if you set one. The same buyer isn't
re-reminded within `REMINDER_COOLDOWN_MINUTES` unless their position got worse —
except negative caps, which always remind while `ALWAYS_REMIND_NEGATIVE=true`.

---

## The daily UTC cycle

Every day boundary, folder name, and timestamp is measured in **UTC** (override
with `TIMEZONE`, but only if your billing day genuinely ends elsewhere).

GRSTK's counter restarts at zero each UTC midnight, so on the first message after
midnight the bot **closes out the previous day**: each cap is carried forward
*minus the calls made against it that day*, and the call baseline restarts at
zero. Skipping that step would forgive a whole day of usage every night:

```
28 Jul  Billing gives Q15 a cap of 150; Q15 then makes 48 calls  ->  102 left
29 Jul  counter restarts. Cap carried forward = 150 - 48 = 102
        first report of the day shows 40 calls                   ->   62 left
```

Without the carry-over the same buyer would read 110 left — the 48 calls silently
written off. `/day` shows the active day and whether the reset is on; set
`STATS_RESET_DAILY=false` if GRSTK's counter is in fact cumulative forever.

A rollover writes a `day-rollover.json` event recording every cap it moved, and
buyers whose cap was set that same day are left alone.

---

## Double-entry protection

Billing lists get re-pasted, forwarded, and corrected. Four independent guards
keep that from moving the numbers:

1. **Whole-message, by Telegram id.** A redelivered update (bot restart, network
   retry) is dropped — same chat + message id, at any age.
2. **Whole-message, by content.** The identical list posted again within
   `DUPLICATE_WINDOW_MINUTES` (default 24h) is dropped. Matching is on a
   whitespace-normalised, case-folded fingerprint, so a hand re-paste with
   different spacing is still caught.
3. **Per line.** In an otherwise new message, a line identical to the cap already
   recorded for that buyer is skipped. This is the one that matters most: setting
   the cap again is harmless by itself, but it would also re-anchor the call
   baseline and erase the drawdown since — which is what actually corrupts the
   figures. A genuine second top-up always carries a different opening figure
   (`0 + 50`, then `50 + 50`), so it is never mistaken for a repeat.
4. **Within one message.** A code listed twice takes its last value, and the
   repeat is logged and recorded in the event file rather than passing unnoticed.

Guards 1–3 post a short notice when they fire (`NOTIFY_ON_DUPLICATE=false` to
stay silent) and write a `duplicate-ignored.json` event either way. Everything a
guard skipped is listed in the day's event file, so nothing is lost — only
un-applied.

Applying a cap is idempotent by design too: `cap` is *set* to the line's total,
never accumulated, so even if a guard were bypassed the cap value itself would
land on the same number.

---

## Data layout

Created automatically on the first message:

```
data/
  state.json                    current cap + calls per buyer, and the
                                fingerprints of recently applied messages
  2026-07-28/
    142305-billing.json         parsed entries + the resulting cap changes
    150112-stats.json           parsed entries + per-buyer deltas
    150113-reminders.json       who was reminded, who was suppressed
    150500-duplicate-ignored.json   what was dropped and why
    manual-setcap ...           admin overrides
    summary.json                snapshot of all buyers, rewritten live
  2026-07-29/
    080000-day-rollover.json    every cap carried across UTC midnight
```

Day folders and file timestamps are UTC (or `TIMEZONE`). Writes are serialised
and atomic (temp file + rename), so a crash can't leave a half-written file.

`data/`, `.env`, and `.claude/` are git-ignored; `.env.example` is committed.

---

## Project layout

```
.env                    credentials (git-ignored)
.env.example            template, committed
src/
  index.ts              startup, config logging, graceful shutdown
  config.ts             .env loading and validation
  bot.ts                Telegram wiring, routing, commands
  parsers/
    lineParser.ts       CODE - <expression> lines, arithmetic evaluation
    classify.ts         Billing vs. statistics detection
  core/capEngine.ts     cap maths, reminder eligibility, reporting
  store/store.ts        the JSON store
  messages/format.ts    every outgoing message
  dev/                  offline simulation against real sample messages
```
