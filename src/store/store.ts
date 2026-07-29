import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import type { AppState, BuyerState, MessageKind, ProcessedMessage } from '../types';
import { dayKey, timeKey } from '../util/time';
import { log } from '../util/log';

const STATE_FILE = 'state.json';

function emptyState(now: Date): AppState {
  return {
    version: 1,
    updatedAt: now.toISOString(),
    day: null,
    lastBillingAt: null,
    lastStatsAt: null,
    primedAt: null,
    buyers: {},
    processed: [],
  };
}

export function newBuyer(code: string, now: Date): BuyerState {
  return {
    code,
    cap: 0,
    capUpdatedAt: null,
    capDay: null,
    lastTopUp: 0,
    lastBillingExpression: null,
    callsAtCapUpdate: 0,
    calls: 0,
    callsUpdatedAt: null,
    statsDay: null,
    lastReminder: null,
    firstSeenAt: now.toISOString(),
  };
}

/**
 * Fingerprint of a message's *content*, so the same list re-pasted by hand (new
 * message id, maybe different spacing) is still recognised as the same message.
 */
export function fingerprint(text: string): string {
  const normalised = text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .filter((l) => l !== '')
    .join('\n')
    .toUpperCase();
  return createHash('sha256').update(normalised).digest('hex');
}

export interface DuplicateHit {
  reason: 'message-id' | 'content';
  previous: ProcessedMessage;
  ageMinutes: number;
}

/**
 * JSON store.
 *
 *   data/
 *     state.json                       <- rolling current state
 *     2026-07-28/
 *       142305-billing.json            <- every event, timestamped
 *       150112-stats.json
 *       150113-reminders.json
 *       summary.json                   <- end-of-day snapshot, rewritten live
 *
 * The whole tree is created lazily, on the first message the bot processes.
 */
export class Store {
  private state: AppState;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dataDir: string,
    private readonly timezone: string = 'UTC',
  ) {
    this.state = emptyState(new Date());
  }

  async init(): Promise<void> {
    const file = path.join(this.dataDir, STATE_FILE);
    try {
      const text = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(text) as AppState;
      if (parsed && typeof parsed === 'object' && parsed.buyers) {
        // Backfill fields added after a state file was first written.
        for (const [code, b] of Object.entries(parsed.buyers)) {
          parsed.buyers[code] = { ...newBuyer(code, new Date()), ...b };
        }
        parsed.processed = Array.isArray(parsed.processed) ? parsed.processed : [];
        parsed.day = parsed.day ?? null;
        // A store written before quiet-first-run existed: if it has already seen
        // both message kinds it was configured long ago, so don't silence it.
        parsed.primedAt =
          parsed.primedAt ??
          (parsed.lastBillingAt && parsed.lastStatsAt ? parsed.updatedAt : null);
        this.state = parsed;
        log.info(
          `Loaded state for ${Object.keys(this.state.buyers).length} buyer(s) from ${file}`,
        );
        return;
      }
      log.warn(`${file} was malformed; starting from an empty state.`);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`Could not read ${file}: ${(err as Error).message}`);
      } else {
        log.info('No existing state found — it will be created on first use.');
      }
    }
  }

  getState(): AppState {
    return this.state;
  }

  getBuyer(code: string): BuyerState | undefined {
    return this.state.buyers[code.toUpperCase()];
  }

  /** Returns the buyer, creating it if this is the first time we see the code. */
  ensureBuyer(code: string, now: Date): BuyerState {
    const key = code.toUpperCase();
    let b = this.state.buyers[key];
    if (!b) {
      b = newBuyer(key, now);
      this.state.buyers[key] = b;
    }
    return b;
  }

  /** Has the bot taken in both a Billing sheet and a statistics report? */
  isPrimed(): boolean {
    return this.state.primedAt !== null;
  }

  /**
   * Ends the quiet first run once both message kinds have been seen. Returns
   * true only on the transition, so the caller can announce it exactly once.
   */
  markPrimedIfReady(now: Date): boolean {
    if (this.state.primedAt !== null) return false;
    if (!this.state.lastBillingAt || !this.state.lastStatsAt) return false;
    this.state.primedAt = now.toISOString();
    return true;
  }

  /** Which of the two initial-configuration inputs are still missing. */
  missingForPriming(): string[] {
    const missing: string[] = [];
    if (!this.state.lastBillingAt) missing.push('billing sheet');
    if (!this.state.lastStatsAt) missing.push('buyer statistics');
    return missing;
  }

  /** `YYYY-MM-DD` in the configured zone (UTC unless overridden). */
  dayOf(now: Date): string {
    return dayKey(now, this.timezone);
  }

  /**
   * Advances the bot's current day. Returns the day that just ended when the
   * clock has crossed midnight since the last message, otherwise null.
   */
  rollDay(now: Date): string | null {
    const today = this.dayOf(now);
    const previous = this.state.day;
    this.state.day = today;
    return previous !== null && previous !== today ? previous : null;
  }

  /**
   * Has this exact message already been acted on? Matches on Telegram's
   * chat+message id first (a redelivered update), then on content fingerprint
   * (the same list posted again) within the window.
   */
  findDuplicate(
    hash: string,
    chatId: string,
    messageId: number | null,
    now: Date,
    windowMinutes: number,
  ): DuplicateHit | null {
    for (let i = this.state.processed.length - 1; i >= 0; i -= 1) {
      const p = this.state.processed[i];
      if (!p) continue;
      const ageMinutes = (now.getTime() - Date.parse(p.at)) / 60000;

      if (
        messageId !== null &&
        p.messageId === messageId &&
        p.chatId === chatId
      ) {
        return { reason: 'message-id', previous: p, ageMinutes };
      }
      if (p.hash === hash && ageMinutes <= windowMinutes) {
        return { reason: 'content', previous: p, ageMinutes };
      }
    }
    return null;
  }

  recordProcessed(entry: ProcessedMessage, historySize: number): void {
    this.state.processed.push(entry);
    if (this.state.processed.length > historySize) {
      this.state.processed.splice(0, this.state.processed.length - historySize);
    }
  }

  /** Messages handled on a given day — used for the daily summary. */
  processedOn(day: string, kind?: MessageKind): ProcessedMessage[] {
    return this.state.processed.filter(
      (p) => p.day === day && (kind === undefined || p.kind === kind),
    );
  }

  removeBuyer(code: string): boolean {
    const key = code.toUpperCase();
    if (!this.state.buyers[key]) return false;
    delete this.state.buyers[key];
    return true;
  }

  /** Persists state.json. Writes are serialised so they can't interleave. */
  persist(now: Date): Promise<void> {
    this.state.updatedAt = now.toISOString();
    return this.enqueue(async () => {
      await ensureDir(this.dataDir);
      await atomicWrite(
        path.join(this.dataDir, STATE_FILE),
        JSON.stringify(this.state, null, 2),
      );
    });
  }

  /** Appends a timestamped event file inside the day's folder. */
  writeEvent(kind: string, payload: unknown, now: Date): Promise<string> {
    return this.enqueue(async () => {
      const dir = path.join(this.dataDir, dayKey(now, this.timezone));
      await ensureDir(dir);

      const base = `${timeKey(now, this.timezone)}-${kind}`;
      let file = path.join(dir, `${base}.json`);
      let n = 1;
      while (await exists(file)) {
        file = path.join(dir, `${base}-${n}.json`);
        n += 1;
      }

      await atomicWrite(
        file,
        JSON.stringify(
          { kind, at: now.toISOString(), timezone: this.timezone, ...(payload as object) },
          null,
          2,
        ),
      );
      log.debug(`Wrote ${file}`);
      return file;
    });
  }

  /** Rewrites the day's summary.json with the current snapshot of all buyers. */
  writeDailySummary(now: Date, extra: Record<string, unknown> = {}): Promise<void> {
    return this.enqueue(async () => {
      const day = dayKey(now, this.timezone);
      const dir = path.join(this.dataDir, day);
      await ensureDir(dir);
      await atomicWrite(
        path.join(dir, 'summary.json'),
        JSON.stringify(
          {
            day,
            timezone: this.timezone,
            updatedAt: now.toISOString(),
            buyerCount: Object.keys(this.state.buyers).length,
            ...extra,
            buyers: this.state.buyers,
          },
          null,
          2,
        ),
      );
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.catch((err) => {
      log.error('Store write failed:', err);
    });
    return run;
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Write to a temp file then rename, so a crash can't leave a half file. */
async function atomicWrite(file: string, contents: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, contents, 'utf8');
  await fs.rename(tmp, file);
}
