import type { MessageKind, ParsedLine, ParsedMessage } from '../types';
import { findReportedDate, looksLikeEntry, parseLine } from './lineParser';

/** A message must contain at least this many usable entries to be acted on. */
const MIN_ENTRIES = 3;

/** Share of entry-looking lines that must actually parse. */
const MIN_PARSE_RATIO = 0.6;

export interface ClassifyOptions {
  /** Username (no @) of the bot that posts the call statistics. */
  statsBotUsername?: string;
  /** Username the message came from / was forwarded from. */
  senderUsername?: string | null;
}

/**
 * Works out whether a message is a Billing cap update or a GRSTK call-count
 * report, and returns the parsed entries either way.
 *
 * Signals, strongest first:
 *   1. An explicit `#billing` / `#stats` first line.
 *   2. The sender (or forward origin) being the configured statistics bot.
 *   3. A `Date : ...` header, bullet markers, or arithmetic  -> Billing.
 *   4. Otherwise, a plain `CODE - N` list                    -> statistics.
 */
export function classifyMessage(
  text: string,
  options: ClassifyOptions = {},
): ParsedMessage {
  const reportedDate = findReportedDate(text);
  const lines = text.split(/\r?\n/);

  const entries: ParsedLine[] = [];
  const rejected: string[] = [];
  let candidates = 0;
  let bulleted = 0;
  let multiTerm = 0;
  let negative = 0;

  for (const raw of lines) {
    if (raw.trim() === '') continue;
    const parsed = parseLine(raw);
    if (parsed) {
      candidates += 1;
      entries.push(parsed.line);
      if (parsed.bulleted) bulleted += 1;
      if (parsed.line.terms.length > 1) multiTerm += 1;
      if (parsed.line.terms.some((t) => t < 0)) negative += 1;
    } else if (looksLikeEntry(raw)) {
      candidates += 1;
      rejected.push(raw.trim());
    }
  }

  const explicit = /^\s*#(billing|stats|statistics)\b/i.exec(text);

  if (entries.length < MIN_ENTRIES) {
    return {
      kind: 'unknown',
      reportedDate,
      entries,
      rejected,
      reason: `only ${entries.length} parsable entr${
        entries.length === 1 ? 'y' : 'ies'
      } (need ${MIN_ENTRIES})`,
    };
  }

  if (candidates > 0 && entries.length / candidates < MIN_PARSE_RATIO) {
    return {
      kind: 'unknown',
      reportedDate,
      entries,
      rejected,
      reason: `only ${entries.length}/${candidates} entry-like lines parsed`,
    };
  }

  let kind: MessageKind;
  let reason: string;

  if (explicit) {
    kind = explicit[1]?.toLowerCase() === 'billing' ? 'billing' : 'stats';
    reason = `explicit #${explicit[1]} tag`;
  } else if (
    options.statsBotUsername &&
    options.senderUsername &&
    options.senderUsername.toLowerCase() ===
      options.statsBotUsername.toLowerCase() &&
    multiTerm === 0
  ) {
    kind = 'stats';
    reason = `sent by @${options.senderUsername}`;
  } else if (reportedDate) {
    kind = 'billing';
    reason = 'has a Date header';
  } else if (bulleted > 0) {
    kind = 'billing';
    reason = `${bulleted} bulleted line(s)`;
  } else if (multiTerm > 0 || negative > 0) {
    kind = 'billing';
    reason = `${multiTerm} arithmetic line(s), ${negative} negative value(s)`;
  } else {
    kind = 'stats';
    reason = 'plain CODE - N list';
  }

  return { kind, reportedDate, entries, rejected, reason };
}

/**
 * Collapses codes listed more than once in a single message. The last
 * occurrence wins (a correction further down the list is what Billing meant),
 * and the repeated codes are reported so they can be logged rather than
 * silently swallowed.
 */
export function dedupeEntries(entries: ParsedLine[]): {
  entries: ParsedLine[];
  duplicateCodes: string[];
} {
  const map = new Map<string, ParsedLine>();
  const duplicateCodes: string[] = [];
  for (const e of entries) {
    if (map.has(e.code) && !duplicateCodes.includes(e.code)) {
      duplicateCodes.push(e.code);
    }
    map.set(e.code, e);
  }
  return { entries: [...map.values()], duplicateCodes };
}
