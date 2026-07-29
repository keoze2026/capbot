import type { Config } from '../config';
import type {
  BuyerState,
  CapUpdateResult,
  ParsedLine,
  ReminderItem,
} from '../types';
import type { Store } from '../store/store';

/**
 * How much cap a buyer has left right now.
 *
 * baseline: Billing's pre-"+" figure is already the buyer's *remaining* cap
 *           (that's why it can be negative), so GRSTK calls only count from the
 *           moment the cap was posted.
 * absolute: the cap is a total allotment for the same period GRSTK counts, so
 *           every logged call eats into it.
 */
export function remainingFor(b: BuyerState, cfg: Config): number {
  if (cfg.capAccounting === 'absolute') return b.cap - b.calls;
  const used = Math.max(0, b.calls - b.callsAtCapUpdate);
  return b.cap - used;
}

/** Calls counted against the current cap (0 in absolute mode is meaningless). */
export function callsAgainstCap(b: BuyerState, cfg: Config): number {
  if (cfg.capAccounting === 'absolute') return b.calls;
  return Math.max(0, b.calls - b.callsAtCapUpdate);
}

/**
 * Applies a Billing message. Each entry's total becomes the buyer's new cap and
 * resets the call baseline, so the next statistics message measures usage from
 * this point on.
 */
export function applyBilling(
  store: Store,
  entries: ParsedLine[],
  cfg: Config,
  now: Date,
): CapUpdateResult[] {
  const results: CapUpdateResult[] = [];

  const today = store.dayOf(now);

  for (const entry of entries) {
    if (cfg.excludeBuyers.has(entry.code)) continue;

    const existing = store.getBuyer(entry.code);
    const isNew = !existing || existing.capUpdatedAt === null;
    const storedRemainingBefore =
      existing && existing.capUpdatedAt !== null
        ? remainingFor(existing, cfg)
        : null;

    const reportedBase = entry.terms[0] ?? 0;
    const topUp = entry.terms.slice(1).reduce((a, b) => a + b, 0);

    // Guard against the same line being applied twice (a re-posted or partially
    // re-posted list). Setting the cap again would be harmless on its own, but
    // it would also re-anchor the call baseline and wipe out the drawdown that
    // happened in between — which is exactly what corrupts the numbers.
    if (existing && isDuplicateBillingEntry(existing, entry, cfg, now)) {
      results.push({
        code: entry.code,
        isNew: false,
        storedRemainingBefore,
        reportedBase,
        topUp,
        newCap: existing.cap,
        calls: existing.calls,
        expression: entry.expression,
        mismatch: false,
        duplicate: true,
      });
      continue;
    }

    const buyer = store.ensureBuyer(entry.code, now);

    buyer.cap = entry.total;
    buyer.lastTopUp = topUp;
    buyer.lastBillingExpression = entry.expression;
    buyer.capUpdatedAt = now.toISOString();
    buyer.capDay = today;
    buyer.callsAtCapUpdate = buyer.calls;

    results.push({
      code: entry.code,
      isNew,
      storedRemainingBefore,
      reportedBase,
      topUp,
      newCap: entry.total,
      calls: buyer.calls,
      expression: entry.expression,
      mismatch:
        storedRemainingBefore !== null && storedRemainingBefore !== reportedBase,
      duplicate: false,
    });
  }

  store.getState().lastBillingAt = now.toISOString();
  return results;
}

/**
 * The identical billing line, already applied, still inside the window.
 *
 * Billing writes each line as `<what's left> + <top-up>`, so a genuine second
 * top-up always carries a different left-hand figure (`0 + 50`, then `50 + 50`).
 * A byte-identical line can therefore only be a re-post.
 */
function isDuplicateBillingEntry(
  buyer: BuyerState,
  entry: ParsedLine,
  cfg: Config,
  now: Date,
): boolean {
  if (buyer.capUpdatedAt === null) return false;
  if (buyer.lastBillingExpression !== entry.expression) return false;
  if (buyer.cap !== entry.total) return false;

  const ageMinutes = (now.getTime() - Date.parse(buyer.capUpdatedAt)) / 60000;
  return ageMinutes <= cfg.duplicateWindowMinutes;
}

export interface StatsChange {
  code: string;
  previousCalls: number;
  calls: number;
  delta: number;
  remaining: number;
  cap: number;
  isNew: boolean;
  /** The call baseline was (re)anchored to this reading instead of charged. */
  rebaselined: boolean;
  /** Why it was re-anchored, for the event log. */
  rebaselineReason: 'first-reading' | 'new-utc-day' | 'counter-reset' | null;
  /** The reading was identical to the one already stored — a no-op. */
  unchanged: boolean;
}

/** Applies a GRSTK statistics message. */
export function applyStats(
  store: Store,
  entries: ParsedLine[],
  cfg: Config,
  now: Date,
): StatsChange[] {
  const changes: StatsChange[] = [];
  const today = store.dayOf(now);

  for (const entry of entries) {
    if (cfg.excludeBuyers.has(entry.code)) continue;

    const isNew = !store.getBuyer(entry.code);
    const buyer = store.ensureBuyer(entry.code, now);
    const previousCalls = buyer.calls;
    const firstReading = buyer.callsUpdatedAt === null;
    const previousStatsDay = buyer.statsDay;
    const unchanged = !firstReading && entry.total === previousCalls;

    let rebaselineReason: StatsChange['rebaselineReason'] = null;

    if (cfg.capAccounting === 'baseline') {
      if (firstReading && buyer.capUpdatedAt !== null) {
        // The cap was posted before we had ever seen a call count, so we had no
        // real baseline for it (we assumed 0). Billing's figure is already net
        // of the calls made so far, so anchor on this first reading instead of
        // charging the whole counter against the fresh cap.
        buyer.callsAtCapUpdate = entry.total;
        rebaselineReason = 'first-reading';
      } else if (
        cfg.statsResetDaily &&
        previousStatsDay !== null &&
        previousStatsDay !== today
      ) {
        // A new UTC day: GRSTK's counter has restarted from zero. A cap carried
        // over from an earlier day is charged the whole of today's count; a cap
        // set today already has a valid same-day baseline, so leave it alone.
        if (buyer.capDay !== today) {
          buyer.callsAtCapUpdate = 0;
          rebaselineReason = 'new-utc-day';
        }
      } else if (entry.total < buyer.callsAtCapUpdate) {
        // The counter went backwards without a day change — GRSTK started a new
        // period of its own. Re-anchor so the buyer isn't credited phantom cap.
        buyer.callsAtCapUpdate = entry.total;
        rebaselineReason = 'counter-reset';
      }
    }

    buyer.calls = entry.total;
    buyer.callsUpdatedAt = now.toISOString();
    buyer.statsDay = today;

    changes.push({
      code: entry.code,
      previousCalls,
      calls: buyer.calls,
      delta: buyer.calls - previousCalls,
      remaining: remainingFor(buyer, cfg),
      cap: buyer.cap,
      isNew,
      rebaselined: rebaselineReason !== null,
      rebaselineReason,
      unchanged,
    });
  }

  store.getState().lastStatsAt = now.toISOString();
  return changes;
}

export interface DayCarryOver {
  code: string;
  previousCap: number;
  callsCharged: number;
  newCap: number;
}

/**
 * Closes out a UTC day.
 *
 * With `STATS_RESET_DAILY`, GRSTK's counter restarts at zero each UTC midnight,
 * so the previous day's baseline is meaningless from that point on. The cap must
 * therefore be carried forward *net of the calls made against it yesterday* —
 * simply zeroing the baseline would forgive that usage and silently inflate
 * every buyer's remaining cap once a day.
 *
 * Runs once per day, on the first message after midnight, and is a no-op for
 * buyers already updated today.
 */
export function carryOverDay(store: Store, cfg: Config, now: Date): DayCarryOver[] {
  if (cfg.capAccounting !== 'baseline' || !cfg.statsResetDaily) return [];

  const today = store.dayOf(now);
  const carried: DayCarryOver[] = [];

  for (const buyer of Object.values(store.getState().buyers)) {
    if (buyer.capDay === today) continue; // cap already set today
    if (buyer.capUpdatedAt === null && buyer.calls === 0) continue; // nothing to carry

    const callsCharged = callsAgainstCap(buyer, cfg);
    const previousCap = buyer.cap;

    if (buyer.capUpdatedAt !== null) {
      buyer.cap = remainingFor(buyer, cfg);
      buyer.capDay = today;
      carried.push({
        code: buyer.code,
        previousCap,
        callsCharged,
        newCap: buyer.cap,
      });
    }

    // The counter starts the new day from zero for everyone.
    buyer.calls = 0;
    buyer.callsAtCapUpdate = 0;
  }

  return carried;
}

/** The remaining-cap level at or below which a buyer gets a reminder. */
export function thresholdFor(b: BuyerState, cfg: Config): number {
  const pct =
    cfg.reminderThresholdPercent > 0
      ? Math.ceil((cfg.reminderThresholdPercent / 100) * Math.max(b.cap, 0))
      : 0;
  return Math.max(cfg.reminderThreshold, pct);
}

export interface ReminderBuild {
  items: ReminderItem[];
  /** Buyers that were due but suppressed by the cooldown. */
  suppressed: string[];
}

/**
 * Collects every buyer that needs a "ping for funds" reminder.
 *
 * Negative caps are always included (subject to ALWAYS_REMIND_NEGATIVE), and a
 * buyer is never reminded about twice inside the cooldown unless their position
 * got worse since the last reminder.
 */
export function buildReminders(
  store: Store,
  cfg: Config,
  now: Date,
  opts: { force?: boolean; commit?: boolean } = {},
): ReminderBuild {
  const force = opts.force ?? false;
  const commit = opts.commit ?? true;

  const items: ReminderItem[] = [];
  const suppressed: string[] = [];

  for (const buyer of Object.values(store.getState().buyers)) {
    if (cfg.excludeBuyers.has(buyer.code)) continue;
    if (cfg.excludeFromReminders.has(buyer.code)) continue;
    // Nothing to say about a buyer Billing has never given a cap for.
    if (buyer.capUpdatedAt === null) continue;

    const remaining = remainingFor(buyer, cfg);
    if (remaining > thresholdFor(buyer, cfg)) continue;

    const isNegative = remaining < 0;
    const bypassCooldown = force || (isNegative && cfg.alwaysRemindNegative);

    if (!bypassCooldown && buyer.lastReminder) {
      const ageMinutes =
        (now.getTime() - Date.parse(buyer.lastReminder.at)) / 60000;
      const gotWorse = remaining < buyer.lastReminder.remaining;
      if (ageMinutes < cfg.reminderCooldownMinutes && !gotWorse) {
        suppressed.push(buyer.code);
        continue;
      }
    }

    items.push({
      code: buyer.code,
      remaining,
      cap: buyer.cap,
      calls: callsAgainstCap(buyer, cfg),
    });

    if (commit) {
      buyer.lastReminder = { at: now.toISOString(), remaining };
    }
  }

  // Worst position first.
  items.sort((a, b) => a.remaining - b.remaining || a.code.localeCompare(b.code));
  return { items, suppressed };
}

export interface BuyerReport {
  code: string;
  cap: number;
  remaining: number;
  calls: number;
  totalCalls: number;
  capUpdatedAt: string | null;
  callsUpdatedAt: string | null;
  capDay: string | null;
  statsDay: string | null;
}

/** Snapshot of every tracked buyer, lowest remaining cap first. */
export function report(store: Store, cfg: Config): BuyerReport[] {
  return Object.values(store.getState().buyers)
    .filter((b) => !cfg.excludeBuyers.has(b.code))
    .map((b) => ({
      code: b.code,
      cap: b.cap,
      remaining: remainingFor(b, cfg),
      calls: callsAgainstCap(b, cfg),
      totalCalls: b.calls,
      capUpdatedAt: b.capUpdatedAt,
      callsUpdatedAt: b.callsUpdatedAt,
      capDay: b.capDay,
      statsDay: b.statsDay,
    }))
    .sort((a, b) => a.remaining - b.remaining || a.code.localeCompare(b.code));
}
