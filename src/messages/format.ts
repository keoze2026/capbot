import type { Config } from '../config';
import type { CapUpdateResult, MessageKind, ReminderItem } from '../types';
import type { BuyerReport } from '../core/capEngine';
import type { DuplicateHit } from '../store/store';
import { stamp } from '../util/time';

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Left bar that opens every heading — a rule Telegram will actually render. */
const BAR = '▎';

/** Bold, bar-prefixed. Used for every heading. No underlines anywhere. */
function heading(text: string): string {
  return `<b>${BAR}${esc(text)}</b>`;
}

/** Thousands-separated, so a four-figure overrun reads at a glance. */
function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** How badly a buyer needs funds. Ordered most urgent first. */
export type Urgency = 'exceeded' | 'depleted' | 'low' | 'ok';

export function urgencyOf(remaining: number, threshold: number): Urgency {
  if (remaining < 0) return 'exceeded';
  if (remaining === 0) return 'depleted';
  if (remaining <= threshold) return 'low';
  return 'ok';
}

const URGENCY_LABEL: Record<Urgency, string> = {
  exceeded: 'CAP EXCEEDED',
  depleted: 'CAP DEPLETED',
  low: 'CAP ALMOST DEPLETED',
  ok: 'CAP OK',
};

/** Plain-text marker used inside <pre> blocks, where tags don't render. */
const URGENCY_MARK: Record<Urgency, string> = {
  exceeded: '!!',
  depleted: '! ',
  low: '~ ',
  ok: '  ',
};

// ---------------------------------------------------------------------------
// Billing cap update — one line per buyer
// ---------------------------------------------------------------------------

/**
 * The whole cap update, deliberately one line: `Update ZZY Cap 152`.
 *
 * Everything that used to sit under it — previous figure, top-up, urgency,
 * mismatch, accounting footer — is still recorded in the event log, and the
 * funds reminder that follows covers anyone whose new cap is low.
 */
export function formatCapUpdate(r: CapUpdateResult): string {
  return `Update <b>${esc(r.code)}</b> Cap <b>${r.newCap}</b>`;
}

// ---------------------------------------------------------------------------
// Funds reminder — one message covering every buyer that needs a top-up
// ---------------------------------------------------------------------------

/** The group heading: the urgency label, plus the figure that group is about. */
function reminderGroupHeading(level: Urgency, group: ReminderItem[]): string {
  if (level === 'exceeded') {
    const total = group.reduce((sum, i) => sum + i.remaining, 0);
    return heading(`${URGENCY_LABEL.exceeded} (Total Over: ${fmt(total)})`);
  }
  if (level === 'depleted') return heading(`${URGENCY_LABEL.depleted} (0 Left)`);
  return heading(URGENCY_LABEL[level]);
}

/** One numbered entry. Depleted buyers are all at zero, so the code says it all. */
export function reminderLine(item: ReminderItem, level: Urgency): string {
  const code = `<b>${esc(item.code)}</b>`;
  if (level === 'depleted') return code;
  if (level === 'exceeded') return `${code}: ${fmt(item.remaining)}`;
  return `${code}: ${fmt(item.remaining)} left`;
}

/**
 * Buyers needing funds, as a numbered list per urgency level:
 *
 *   ▎PING FOR FUNDS
 *
 *   ▎CAP EXCEEDED (Total Over: -2,141)
 *
 *   1. Q04: -766
 *   2. HOZ: -293
 *
 * Each group restarts its numbering, and the exceeded heading carries the sum of
 * the overrun so the total exposure is visible without adding it up by hand.
 */
export function formatReminder(items: ReminderItem[], cfg: Config): string {
  const lines: string[] = [heading('PING FOR FUNDS')];

  const order: Urgency[] = ['exceeded', 'depleted', 'low'];
  for (const level of order) {
    const group = items.filter(
      (i) => urgencyOf(i.remaining, cfg.reminderThreshold) === level,
    );
    if (group.length === 0) continue;

    lines.push('');
    lines.push(reminderGroupHeading(level, group));
    lines.push('');
    group.forEach((item, i) => lines.push(`${i + 1}. ${reminderLine(item, level)}`));
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Quiet first run
// ---------------------------------------------------------------------------

/**
 * The single line posted once both a Billing sheet and a Buyer statistics
 * report have been taken in — the end of the quiet first run.
 */
export function formatPrimed(buyerCount: number): string {
  const plural = buyerCount === 1 ? 'buyer' : 'buyers';
  return `${heading('READY')} - ${buyerCount} ${plural} configured`;
}

// ---------------------------------------------------------------------------
// Duplicate guard
// ---------------------------------------------------------------------------

/** Posted when a whole message is recognised as one already acted on. */
export function formatDuplicateNotice(
  dup: DuplicateHit,
  kind: MessageKind,
  cfg: Config,
): string {
  const age = Math.round(dup.ageMinutes);
  const when = age < 60 ? `${age} minute(s) ago` : `${Math.round(age / 60)} hour(s) ago`;
  const how =
    dup.reason === 'message-id'
      ? 'the same Telegram message was delivered again'
      : 'the identical list was posted before';

  return [
    heading('DUPLICATE IGNORED'),
    '',
    `This ${kind === 'billing' ? 'Billing update' : 'call-stats report'} was not applied - ${how}`,
    `(${when}, ${dup.previous.entryCount} entries). No caps were changed.`,
    '',
    `<i>Re-post after ${cfg.duplicateWindowMinutes} minutes, or send a corrected list, to apply it.</i>`,
  ].join('\n');
}

/** Posted when only some lines of an otherwise new message were repeats. */
export function formatSkippedLines(codes: string[], cfg: Config): string {
  return [
    heading('LINES ALREADY APPLIED'),
    '',
    `${codes.length} line(s) matched a cap already recorded for the same buyer,`,
    'so they were skipped and their call baselines left untouched:',
    `<code>${esc(codes.join(', '))}</code>`,
    '',
    `<i>A genuine new top-up carries a different opening figure, e.g. 0 + 50 then 50 + 50.</i>` +
      (cfg.duplicateWindowMinutes > 0 ? '' : ''),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function formatStatus(rows: BuyerReport[], cfg: Config, now: Date): string {
  if (rows.length === 0) {
    return `${heading('BUYER CAPS')}\n\nNo buyers tracked yet. Post a Billing update to get started.`;
  }

  const width = Math.max(...rows.map((r) => r.code.length), 4);
  const body = rows
    .map((r) => {
      const mark = URGENCY_MARK[urgencyOf(r.remaining, cfg.reminderThreshold)];
      return `${mark} ${r.code.padEnd(width)}  ${String(r.remaining).padStart(
        6,
      )} left   (cap ${r.cap}, calls ${r.calls})`;
    })
    .join('\n');

  return (
    `${heading('BUYER CAPS')} - ${rows.length} tracked\n` +
    `<pre>${esc(body)}</pre>\n` +
    `<i>!! exceeded   ! depleted   ~ almost depleted (${cfg.reminderThreshold} or fewer left)</i>\n` +
    `<i>${esc(stamp(now, cfg.timezone))} ${esc(cfg.timezone)}  |  mode: ${esc(
      cfg.capAccounting,
    )}</i>`
  );
}

export function formatBuyer(r: BuyerReport, cfg: Config): string {
  const urgency = urgencyOf(r.remaining, cfg.reminderThreshold);
  const lines = [
    heading(r.code),
    '',
    `Cap: <code>${r.cap}</code>`,
    `Calls against cap: <code>${r.calls}</code>`,
    `<b>Remaining: ${r.remaining}</b>`,
  ];
  if (urgency !== 'ok') {
    lines.push('');
    lines.push(heading(URGENCY_LABEL[urgency]));
  }
  lines.push('');
  lines.push(`<i>Cap set: ${r.capUpdatedAt ? esc(r.capUpdatedAt) : 'never'} (day ${r.capDay ?? '-'})</i>`);
  lines.push(
    `<i>Stats seen: ${r.callsUpdatedAt ? esc(r.callsUpdatedAt) : 'never'} (day ${r.statsDay ?? '-'})</i>`,
  );
  lines.push(
    `<i>Last GRSTK reading: ${r.totalCalls}  |  ${esc(cfg.timezone)}  |  mode: ${esc(
      cfg.capAccounting,
    )}</i>`,
  );
  return lines.join('\n');
}

export function formatHelp(cfg: Config): string {
  const list = (s: Set<string>) =>
    s.size === 0 ? '<i>none</i>' : esc([...s].sort().join(', '));

  return [
    heading('BUYERCAPBOT'),
    '',
    'Post a <b>Billing</b> message (bulleted <code>CODE - 67 + 25</code> lines) and',
    'I post one cap-update message per buyer, then a single reminder message',
    'listing everyone whose cap is low, depleted, or exceeded.',
    '',
    `Post a <b>@${esc(cfg.statsBotUsername)}</b> call-count message (<code>CODE - 12</code> lines)`,
    'and I re-check every cap against it.',
    '',
    heading('COMMANDS'),
    '/status - every buyer, lowest cap first',
    '/buyer CODE - one buyer in detail',
    '/remind - re-send the reminder now, ignoring the cooldown',
    '/pending - who is currently below threshold',
    '/excluded - current exclusion lists',
    '/day - current day, clock, and messages applied',
    '/setcap CODE N - manually correct a cap (admin)',
    '/forget CODE - stop tracking a buyer (admin)',
    '/help - this message',
    '',
    heading('DOUBLE ENTRIES'),
    'A message that repeats one already applied is ignored, and a line whose',
    'cap is already recorded for that buyer is skipped, so re-posting a list',
    'never double-counts or resets a call baseline.',
    '',
    heading('EXCLUSIONS'),
    '<i>set in the root <code>.env</code></i>',
    `No reminders: ${list(cfg.excludeFromReminders)}`,
    `No update messages: ${list(cfg.excludeFromUpdates)}`,
    `Ignored entirely: ${list(cfg.excludeBuyers)}`,
    '',
    `<i>Almost-depleted threshold ${cfg.reminderThreshold} | cooldown ${cfg.reminderCooldownMinutes}m | mode ${esc(
      cfg.capAccounting,
    )}</i>`,
    `<i>Days run on ${esc(cfg.timezone)}; duplicate window ${cfg.duplicateWindowMinutes}m</i>`,
  ].join('\n');
}

/** Splits a long HTML message on line boundaries to fit Telegram's limit. */
export function chunk(text: string, limit = 3800): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > limit) {
      if (current) out.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) out.push(current);
  return out;
}
