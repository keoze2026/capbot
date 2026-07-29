/**
 * Offline dry-run: feeds the two real message shapes through the exact same
 * parser / engine / formatter the bot uses and prints what would be sent.
 * Nothing is written to disk and no Telegram connection is made.
 *
 *   npm run simulate
 *   npm run simulate -- absolute      (try the other accounting mode)
 *
 * Timestamps are fixed UTC instants so every run prints the same thing.
 */
import * as os from 'os';
import * as path from 'path';
import type { Config } from '../config';
import { Store, fingerprint } from '../store/store';
import { classifyMessage, dedupeEntries } from '../parsers/classify';
import {
  applyBilling,
  applyStats,
  buildReminders,
  carryOverDay,
  report,
} from '../core/capEngine';
import {
  formatCapUpdate,
  formatDuplicateNotice,
  formatReminder,
  formatSkippedLines,
  formatStatus,
} from '../messages/format';
import { BILLING_SAMPLE, STATS_SAMPLE } from './samples';
import type { CapAccounting, ParsedMessage } from '../types';

const mode: CapAccounting = process.argv[2] === 'absolute' ? 'absolute' : 'baseline';

const cfg: Config = {
  botToken: 'simulate',
  replyToChatIds: [],
  allowedChatIds: [],
  adminUserIds: [],
  statsBotUsername: 'GrstkBot',
  excludeFromReminders: new Set(),
  excludeFromUpdates: new Set(),
  excludeBuyers: new Set(),
  reminderThreshold: 10,
  reminderThresholdPercent: 0,
  reminderCooldownMinutes: 180,
  alwaysRemindNegative: true,
  sendUpdates: true,
  sendReminders: true,
  quietUntilPrimed: false, // the dry-run prints every message shape
  enableCommands: true,

  capAccounting: mode,
  statsResetDaily: true,
  duplicateWindowMinutes: 1440,
  notifyOnDuplicate: true,
  processedHistorySize: 500,
  dataDir: path.join(os.tmpdir(), 'buyercapbot-simulate'),
  timezone: 'UTC',
  messageDelayMs: 0,
  logLevel: 'info',
  envFile: '',
};

const AT = (iso: string) => new Date(iso);

/**
 * Renders the HTML the bot sends as terminal text: a bold heading alone on its
 * line gets a `-` rule under it, other tags are dropped.
 */
function plain(html: string): string {
  return html
    // A heading on a line of its own gets a rule under it; one with trailing
    // text stays inline, exactly as Telegram renders it.
    .replace(/^<b>(.*?)<\/b>$/gm, (_m, t: string) => `${t}\n${'-'.repeat(t.length)}`)
    .replace(/<\/?(b|i|u|code|pre)>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function rule(title: string): void {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

const billingMessage = (date: string, lines: string[]): string =>
  [`Date : ${date}`, '', ...lines].join('\n');

const parse = (text: string, fromStatsBot = false): ParsedMessage =>
  classifyMessage(text, {
    statsBotUsername: cfg.statsBotUsername,
    senderUsername: fromStatsBot ? 'GrstkBot' : null,
  });

/** Mirrors what bot.ts does before applying anything. */
function guard(
  store: Store,
  text: string,
  messageId: number,
  at: Date,
  entryCount = 0,
): boolean {
  const hash = fingerprint(text);
  const dup = store.findDuplicate(hash, '-100', messageId, at, cfg.duplicateWindowMinutes);
  if (dup) {
    console.log(plain(formatDuplicateNotice(dup, 'billing', cfg)));
    return false;
  }
  store.rollDay(at);
  store.recordProcessed(
    {
      hash,
      chatId: '-100',
      messageId,
      kind: 'billing',
      at: at.toISOString(),
      day: store.dayOf(at),
      entryCount,
    },
    cfg.processedHistorySize,
  );
  return true;
}

async function main(): Promise<void> {
  const store = new Store(cfg.dataDir, cfg.timezone);

  // -------------------------------------------------------------------------
  rule(`1. CLASSIFY  (accounting mode: ${mode}, timezone: ${cfg.timezone})`);
  const billing = parse(BILLING_SAMPLE);
  const stats = parse(STATS_SAMPLE, true);
  console.log(
    `Billing message -> ${billing.kind} (${billing.reason}); ` +
      `${billing.entries.length} entries, ${billing.rejected.length} rejected`,
  );
  console.log(
    `Stats message   -> ${stats.kind} (${stats.reason}); ` +
      `${stats.entries.length} entries, ${stats.rejected.length} rejected`,
  );

  // -------------------------------------------------------------------------
  rule('2. ARITHMETIC - every line that had a calculation');
  for (const e of billing.entries.filter((x) => x.terms.length > 1 || x.total < 0)) {
    console.log(`  ${e.code.padEnd(5)} ${e.expression.padEnd(16)} = ${e.total}`);
  }

  // -------------------------------------------------------------------------
  rule('3. CAP UPDATE MESSAGES (one per buyer - first 3 shown)');
  const t0 = AT('2026-07-28T09:00:00Z');
  guard(store, BILLING_SAMPLE, 1, t0, billing.entries.length);
  const results = applyBilling(store, dedupeEntries(billing.entries).entries, cfg, t0);
  for (const r of results.slice(0, 3)) {
    console.log(`\n--- message to ${r.code} ---`);
    console.log(plain(formatCapUpdate(r)));
  }
  console.log(`\n... ${results.length} messages in total, sent one at a time.`);

  // -------------------------------------------------------------------------
  rule('4. REMINDER right after the billing update');
  const first = buildReminders(store, cfg, t0, { force: true, commit: false });
  console.log(plain(formatReminder(first.items, cfg)));

  // -------------------------------------------------------------------------
  rule('5. GRSTK STATISTICS APPLIED (same UTC day)');
  const t1 = AT('2026-07-28T10:00:00Z');
  applyStats(store, dedupeEntries(stats.entries).entries, cfg, t1);
  const zzy = () => report(store, cfg).find((r) => r.code === 'ZZY');
  console.log(
    `  ZZY  cap ${zzy()?.cap}  calls-against-cap ${zzy()?.calls}  ->  ${zzy()?.remaining} left`,
  );
  console.log('  (first reading anchors the baseline; caps stay at Billing\'s figures)');

  // -------------------------------------------------------------------------
  rule('6. NEXT GRSTK REPORT, +90 calls each - drawdown check');
  const t2 = AT('2026-07-28T14:00:00Z');
  const later = parse(
    STATS_SAMPLE.replace(/^(\w+) - (\d+)$/gm, (_m, c, n) => `${c} - ${Number(n) + 90}`),
    true,
  );
  applyStats(store, dedupeEntries(later.entries).entries, cfg, t2);
  for (const r of report(store, cfg).filter((x) => ['ZZY', 'BHS', 'Q15'].includes(x.code))) {
    console.log(
      `  ${r.code.padEnd(4)} cap ${String(r.cap).padStart(5)}  calls-against-cap ${String(
        r.calls,
      ).padStart(3)}  ->  ${r.remaining} left`,
    );
  }

  // -------------------------------------------------------------------------
  rule('7. FOLLOW-UP BILLING UPDATE (Previous is now a tracked figure)');
  const t3 = AT('2026-07-28T15:00:00Z');
  const topUpText = billingMessage('28-07-2026', [
    '• ZZY  - 2 + 150',
    '• BHS  - 31 + 100',
    '• Q15  - (-250) + 400',
  ]);
  guard(store, topUpText, 2, t3, 3);
  for (const r of applyBilling(store, dedupeEntries(parse(topUpText).entries).entries, cfg, t3)) {
    console.log(`\n--- message to ${r.code} ---`);
    console.log(plain(formatCapUpdate(r)));
  }

  // -------------------------------------------------------------------------
  rule('8. DOUBLE ENTRY: the same message posted again 5 minutes later');
  const t4 = AT('2026-07-28T15:05:00Z');
  const accepted = guard(store, topUpText, 3, t4, 3);
  console.log(`\n  applied: ${accepted}`);
  console.log(`  ZZY cap is still ${report(store, cfg).find((r) => r.code === 'ZZY')?.cap}.`);

  // -------------------------------------------------------------------------
  rule('9. DOUBLE ENTRY: a new message that repeats two already-applied lines');
  const t5 = AT('2026-07-28T16:00:00Z');
  const partial = billingMessage('28-07-2026', [
    '• ZZY  - 2 + 150', // already applied at 15:00 - identical line
    '• BHS  - 31 + 100', // already applied at 15:00 - identical line
    '• DEE  - 56 + 90', // genuinely new
    '• DEE  - 56 + 90', // listed twice in the same message
  ]);
  guard(store, partial, 4, t5, 3);
  const partialParsed = parse(partial);
  const { entries: partialEntries, duplicateCodes } = dedupeEntries(partialParsed.entries);
  console.log(`  Repeated inside the message: ${duplicateCodes.join(', ') || '(none)'}`);
  const partialResults = applyBilling(store, partialEntries, cfg, t5);
  const skipped = partialResults.filter((r) => r.duplicate);
  const applied = partialResults.filter((r) => !r.duplicate);
  console.log(`  Applied: ${applied.map((r) => r.code).join(', ') || '(none)'}`);
  console.log(`  Skipped: ${skipped.map((r) => r.code).join(', ') || '(none)'}\n`);
  if (skipped.length) console.log(plain(formatSkippedLines(skipped.map((r) => r.code), cfg)));
  const zzyAfter = report(store, cfg).find((r) => r.code === 'ZZY');
  console.log(
    `\n  ZZY untouched: cap ${zzyAfter?.cap}, calls-against-cap ${zzyAfter?.calls}, ` +
      `${zzyAfter?.remaining} left (baseline preserved).`,
  );

  // -------------------------------------------------------------------------
  rule('10. UTC DAY ROLLOVER - GRSTK counter restarts, caps carry over');
  // Late on 28 Jul, Q15 burns through part of the cap it was just given.
  applyStats(
    store,
    dedupeEntries(parse(['Buyers statistics:', '', 'Q15 - 260', 'ZZY - 109', 'BHS - 185'].join('\n'), true).entries)
      .entries,
    cfg,
    AT('2026-07-28T20:00:00Z'),
  );
  const q15Eod = report(store, cfg).find((r) => r.code === 'Q15');
  console.log(
    `  End of 28 Jul: Q15 cap ${q15Eod?.cap}, ${q15Eod?.calls} calls against it, ` +
      `${q15Eod?.remaining} left`,
  );

  const t6 = AT('2026-07-29T08:00:00Z');
  const ended = store.rollDay(t6);
  const carried = carryOverDay(store, cfg, t6);
  console.log(`  Day ended: ${ended} -> now ${store.dayOf(t6)}`);
  for (const c of carried.filter((x) => ['ZZY', 'BHS', 'Q15'].includes(x.code))) {
    console.log(
      `    ${c.code.padEnd(4)} cap ${c.previousCap} - ${c.callsCharged} used = ${c.newCap} carried forward`,
    );
  }
  const nextDay = parse(['Buyers statistics:', '', 'ZZY - 12', 'BHS - 5', 'Q15 - 40'].join('\n'), true);
  applyStats(store, dedupeEntries(nextDay.entries).entries, cfg, t6);
  for (const r of report(store, cfg).filter((x) => ['ZZY', 'BHS', 'Q15'].includes(x.code))) {
    console.log(
      `  ${r.code.padEnd(4)} cap ${String(r.cap).padStart(4)}  today's calls ${String(
        r.calls,
      ).padStart(3)}  ->  ${r.remaining} left`,
    );
  }
  console.log(
    "  (counter restarted from zero; yesterday's cap is charged today's calls, not credited)",
  );

  // -------------------------------------------------------------------------
  rule('11. FULL STATUS');
  console.log(plain(formatStatus(report(store, cfg).slice(0, 12), cfg, t6)));
  console.log('');
}

void main();
