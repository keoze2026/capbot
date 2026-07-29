import * as path from 'path';
import * as dotenv from 'dotenv';
import type { CapAccounting } from './types';

const ENV_FILE = path.resolve(process.cwd(), '.env');

// Absent in container/CI setups where secrets are injected as real environment
// variables — dotenv simply no-ops then.
dotenv.config({ path: ENV_FILE });

function str(key: string, fallback = ''): string {
  const v = process.env[key];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function num(key: string, fallback: number): number {
  const v = str(key);
  if (v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const v = str(key).toLowerCase();
  if (v === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(v);
}

/** Parses a comma-separated env value into an upper-cased Set. */
function codeSet(key: string): Set<string> {
  return new Set(
    str(key)
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
}

function idList(key: string): string[] {
  return str(key)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface Config {
  botToken: string;
  /** Chats the bot posts to. Empty means "reply in the source chat". */
  replyToChatIds: string[];
  allowedChatIds: string[];
  adminUserIds: string[];
  statsBotUsername: string;

  excludeFromReminders: Set<string>;
  excludeFromUpdates: Set<string>;
  excludeBuyers: Set<string>;

  reminderThreshold: number;
  reminderThresholdPercent: number;
  reminderCooldownMinutes: number;
  alwaysRemindNegative: boolean;
  sendUpdates: boolean;
  sendReminders: boolean;
  /**
   * Stay silent on a fresh install until both a Billing sheet and a Buyer
   * statistics report have been taken in, so the first run configures itself
   * without posting a wall of cap updates.
   */
  quietUntilPrimed: boolean;
  /**
   * Whether the bot answers slash commands at all. Off by default: it shares its
   * groups with other bots that own `/start`, `/stop` and friends, and two bots
   * replying to one command is worse than none.
   */
  enableCommands: boolean;

  capAccounting: CapAccounting;
  statsResetDaily: boolean;

  duplicateWindowMinutes: number;
  notifyOnDuplicate: boolean;
  processedHistorySize: number;

  dataDir: string;
  /** IANA zone every day boundary and timestamp is measured in. UTC by default. */
  timezone: string;
  messageDelayMs: number;
  logLevel: string;

  envFile: string;
}

/** Rejects an unknown IANA zone rather than silently falling back to local. */
function resolveTimezone(raw: string): string {
  const tz = raw === '' ? 'UTC' : raw;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    throw new Error(
      `TIMEZONE="${raw}" is not a valid IANA timezone (e.g. UTC, Africa/Nairobi). ` +
        `Leave it blank to use UTC.`,
    );
  }
}

export function loadConfig(): Config {
  const botToken = str('BOT_TOKEN');
  if (!botToken) {
    throw new Error(
      `BOT_TOKEN is not set. Copy .env.example to .env and fill in your @BotFather token.`,
    );
  }

  const accounting = str('CAP_ACCOUNTING', 'baseline').toLowerCase();

  return {
    botToken,
    replyToChatIds: idList('REPLY_TO_CHAT_IDS'),
    allowedChatIds: idList('ALLOWED_CHAT_IDS'),
    adminUserIds: idList('ADMIN_USER_IDS'),
    statsBotUsername: str('STATS_BOT_USERNAME', 'GrstkBot').replace(/^@/, ''),

    excludeFromReminders: codeSet('EXCLUDE_FROM_REMINDERS'),
    excludeFromUpdates: codeSet('EXCLUDE_FROM_UPDATES'),
    excludeBuyers: codeSet('EXCLUDE_BUYERS'),

    reminderThreshold: num('ALMOST_DEPLETED_THRESHOLD', 10),
    reminderThresholdPercent: num('REMINDER_THRESHOLD_PERCENT', 0),
    reminderCooldownMinutes: num('REMINDER_COOLDOWN_MINUTES', 180),
    alwaysRemindNegative: bool('ALWAYS_REMIND_NEGATIVE', true),
    sendUpdates: bool('SEND_UPDATES', true),
    sendReminders: bool('SEND_REMINDERS', true),
    quietUntilPrimed: bool('QUIET_UNTIL_PRIMED', true),
    enableCommands: bool('ENABLE_COMMANDS', false),

    capAccounting: accounting === 'absolute' ? 'absolute' : 'baseline',
    statsResetDaily: bool('STATS_RESET_DAILY', true),

    duplicateWindowMinutes: num('DUPLICATE_WINDOW_MINUTES', 1440),
    notifyOnDuplicate: bool('NOTIFY_ON_DUPLICATE', true),
    processedHistorySize: Math.max(50, num('PROCESSED_HISTORY_SIZE', 500)),

    dataDir: path.resolve(process.cwd(), str('DATA_DIR', 'data')),
    timezone: resolveTimezone(str('TIMEZONE')),
    messageDelayMs: num('MESSAGE_DELAY_MS', 120),
    logLevel: str('LOG_LEVEL', 'info').toLowerCase(),

    envFile: ENV_FILE,
  };
}
