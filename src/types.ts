export type CapAccounting = 'baseline' | 'absolute';

export type MessageKind = 'billing' | 'stats' | 'unknown';

/** One `CODE - <expression>` line, already evaluated. */
export interface ParsedLine {
  /** Normalised (upper-case) buyer code. */
  code: string;
  /** Signed terms of the expression, in order. `(-14) + 35` -> [-14, 35] */
  terms: number[];
  /** Sum of all terms — the "final result of the calculation". */
  total: number;
  /** The raw right-hand side, e.g. `(-14) + 35`. */
  expression: string;
  /** The raw source line. */
  raw: string;
}

export interface ParsedMessage {
  kind: MessageKind;
  /** Date string found in a `Date : 28-07-2026` header, if any. */
  reportedDate: string | null;
  entries: ParsedLine[];
  /** Lines that looked like entries but could not be evaluated. */
  rejected: string[];
  /** Why the classifier decided what it decided (for logs / debugging). */
  reason: string;
}

export interface BuyerState {
  code: string;
  /** Cap as last stated by Billing (the whole-number result of the sum). */
  cap: number;
  capUpdatedAt: string | null;
  /** UTC day the cap was last set on, `YYYY-MM-DD`. */
  capDay: string | null;
  /** The `+ N` part of the last billing line (0 when there was none). */
  lastTopUp: number;
  /**
   * The exact expression Billing last sent for this buyer, e.g. `67 + 25`.
   * Re-sending the identical line is treated as a duplicate, not a new top-up.
   */
  lastBillingExpression: string | null;
  /** GRSTK call count at the moment the cap was last set. */
  callsAtCapUpdate: number;
  /** Latest GRSTK call count. */
  calls: number;
  callsUpdatedAt: string | null;
  /** UTC day of the last GRSTK reading, `YYYY-MM-DD`. */
  statsDay: string | null;
  lastReminder: { at: string; remaining: number } | null;
  firstSeenAt: string;
}

/** A message the bot has already acted on — the duplicate guard's memory. */
export interface ProcessedMessage {
  /** sha256 of the whitespace-normalised message text. */
  hash: string;
  chatId: string;
  messageId: number | null;
  kind: MessageKind;
  at: string;
  day: string;
  entryCount: number;
}

export interface AppState {
  version: 1;
  updatedAt: string;
  /** The UTC day the bot is currently operating in, `YYYY-MM-DD`. */
  day: string | null;
  lastBillingAt: string | null;
  lastStatsAt: string | null;
  /**
   * When the bot finished its quiet first run — the moment it had seen both a
   * Billing sheet and a Buyer statistics report. Null means it is still
   * listening silently, taking in the initial configuration.
   */
  primedAt: string | null;
  buyers: Record<string, BuyerState>;
  /** Most recent processed messages, newest last. Pruned to a fixed size. */
  processed: ProcessedMessage[];
}

export interface CapUpdateResult {
  code: string;
  isNew: boolean;
  /** What we believed was left before this update (null for a brand-new buyer). */
  storedRemainingBefore: number | null;
  /** The first term of the billing line — what Billing says was left. */
  reportedBase: number;
  /** Everything after the first term (the top-up). */
  topUp: number;
  /** The new cap = total of the expression. */
  newCap: number;
  calls: number;
  expression: string;
  /** True when our stored remaining disagreed with Billing's reported base. */
  mismatch: boolean;
  /**
   * The identical line was already applied inside the duplicate window, so
   * nothing was changed and no update message is sent.
   */
  duplicate: boolean;
}

export interface ReminderItem {
  code: string;
  remaining: number;
  cap: number;
  calls: number;
}
