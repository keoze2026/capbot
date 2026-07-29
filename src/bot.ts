import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import type { Config } from './config';
import type { Store } from './store/store';
import { classifyMessage, dedupeEntries } from './parsers/classify';
import {
  applyBilling,
  applyStats,
  buildReminders,
  carryOverDay,
  remainingFor,
  report,
} from './core/capEngine';
import {
  chunk,
  esc,
  formatBuyer,
  formatCapUpdate,
  formatDuplicateNotice,
  formatHelp,
  formatPrimed,
  formatReminder,
  formatSkippedLines,
  formatStatus,
} from './messages/format';
import { fingerprint } from './store/store';
import { sleep } from './util/time';
import { log } from './util/log';

interface Incoming {
  text: string;
  chatId: string;
  messageId: number | null;
  userId: string | null;
  senderUsername: string | null;
}

export function createBot(cfg: Config, store: Store): Telegraf<Context> {
  const bot = new Telegraf<Context>(cfg.botToken);

  bot.catch((err, ctx) => {
    log.error(`Unhandled error for update ${ctx.updateType}:`, err);
  });

  bot.on('message', async (ctx) => {
    const incoming = readIncoming(ctx, 'message');
    if (incoming) await handle(ctx, incoming, cfg, store);
  });

  bot.on('channel_post', async (ctx) => {
    const incoming = readIncoming(ctx, 'channel_post');
    if (incoming) await handle(ctx, incoming, cfg, store);
  });

  return bot;
}

function readIncoming(ctx: Context, key: 'message' | 'channel_post'): Incoming | null {
  const msg = (ctx as unknown as Record<string, any>).update?.[key];
  if (!msg || typeof msg.text !== 'string' || msg.text.trim() === '') return null;

  // A forwarded GRSTK report should still be attributed to GRSTK.
  const origin = msg.forward_origin;
  const senderUsername: string | null =
    origin?.sender_user?.username ??
    origin?.chat?.username ??
    msg.forward_from?.username ??
    msg.forward_from_chat?.username ??
    msg.from?.username ??
    msg.sender_chat?.username ??
    null;

  return {
    text: msg.text,
    chatId: String(msg.chat?.id ?? ''),
    messageId: typeof msg.message_id === 'number' ? msg.message_id : null,
    userId: msg.from?.id != null ? String(msg.from.id) : null,
    senderUsername,
  };
}

async function handle(
  ctx: Context,
  incoming: Incoming,
  cfg: Config,
  store: Store,
): Promise<void> {
  if (cfg.allowedChatIds.length > 0 && !cfg.allowedChatIds.includes(incoming.chatId)) {
    log.debug(`Ignoring message from unlisted chat ${incoming.chatId}`);
    return;
  }

  const text = incoming.text.trim();

  if (text.startsWith('/')) {
    // The bot shares its groups with other bots that own /start, /stop and the
    // rest, so unless commands are explicitly switched on a slash message is
    // dropped without a reply — no exceptions, /start included.
    if (!cfg.enableCommands) {
      log.debug(
        `Commands are off; ignoring "${text.split(/\s+/)[0]}" in ${incoming.chatId}`,
      );
      return;
    }
    await handleCommand(ctx, incoming, text, cfg, store);
    return;
  }

  const parsed = classifyMessage(text, {
    statsBotUsername: cfg.statsBotUsername,
    senderUsername: incoming.senderUsername,
  });

  if (parsed.kind === 'unknown') {
    log.debug(`Ignoring message in ${incoming.chatId}: ${parsed.reason}`);
    return;
  }

  const now = new Date();
  const replyChats = replyTargets(cfg, incoming.chatId);

  // --- quiet first run -------------------------------------------------------
  // Until a Billing sheet *and* a Buyer statistics report have both been taken
  // in, everything is applied to the ledger but nothing is posted: the initial
  // configuration would otherwise arrive as a wall of cap updates. Commands are
  // unaffected — an explicit /status still answers.
  const quiet = cfg.quietUntilPrimed && !store.isPrimed();
  if (quiet) {
    log.info(
      `Quiet first run: applying silently, still waiting for ` +
        `${store.missingForPriming().join(' and ')}.`,
    );
  }
  const targets = quiet ? [] : replyChats;

  // --- duplicate guard, before anything is applied --------------------------
  const hash = fingerprint(text);
  const dup = store.findDuplicate(
    hash,
    incoming.chatId,
    incoming.messageId,
    now,
    cfg.duplicateWindowMinutes,
  );
  if (dup) {
    log.warn(
      `Ignoring duplicate ${parsed.kind} message from chat ${incoming.chatId} ` +
        `(${dup.reason}, first seen ${Math.round(dup.ageMinutes)}m ago).`,
    );
    await store.writeEvent(
      'duplicate-ignored',
      {
        chatId: incoming.chatId,
        messageId: incoming.messageId,
        kind: parsed.kind,
        hash,
        matchedOn: dup.reason,
        firstSeenAt: dup.previous.at,
        ageMinutes: Math.round(dup.ageMinutes),
      },
      now,
    );
    if (cfg.notifyOnDuplicate) {
      await broadcast(ctx, targets, formatDuplicateNotice(dup, parsed.kind, cfg), cfg);
    }
    return;
  }

  // --- UTC day rollover ------------------------------------------------------
  const endedDay = store.rollDay(now);
  if (endedDay) {
    // Carry each cap forward net of yesterday's usage before anything new is
    // applied, so the fresh day's call counter starts from a truthful figure.
    const carried = carryOverDay(store, cfg, now);
    log.info(
      `Day rolled over: ${endedDay} -> ${store.dayOf(now)} (${cfg.timezone}); ` +
        `${carried.length} cap(s) carried forward.`,
    );
    await store.writeEvent(
      'day-rollover',
      { endedDay, newDay: store.dayOf(now), timezone: cfg.timezone, carried },
      now,
    );
    await store.persist(now);
  }

  const { entries, duplicateCodes } = dedupeEntries(parsed.entries);

  log.info(
    `${parsed.kind} message from chat ${incoming.chatId} ` +
      `(${entries.length} entries, ${parsed.reason})`,
  );
  if (duplicateCodes.length > 0) {
    log.warn(
      `Message listed ${duplicateCodes.join(', ')} more than once; last value used.`,
    );
  }

  const recordSeen = () => {
    store.recordProcessed(
      {
        hash,
        chatId: incoming.chatId,
        messageId: incoming.messageId,
        kind: parsed.kind,
        at: now.toISOString(),
        day: store.dayOf(now),
        entryCount: entries.length,
      },
      cfg.processedHistorySize,
    );
  };

  if (parsed.kind === 'billing') {
    const results = applyBilling(store, entries, cfg, now);
    const applied = results.filter((r) => !r.duplicate);
    const skipped = results.filter((r) => r.duplicate);
    recordSeen();

    await store.writeEvent(
      'billing',
      {
        chatId: incoming.chatId,
        messageId: incoming.messageId,
        senderUsername: incoming.senderUsername,
        reportedDate: parsed.reportedDate,
        classifierReason: parsed.reason,
        hash,
        rejectedLines: parsed.rejected,
        repeatedCodesInMessage: duplicateCodes,
        skippedAsDuplicate: skipped.map((r) => r.code),
        entries,
        results,
      },
      now,
    );
    await store.persist(now);

    if (skipped.length > 0) {
      log.warn(
        `Skipped ${skipped.length} already-applied line(s): ${skipped
          .map((r) => r.code)
          .join(', ')}`,
      );
    }
    for (const r of applied.filter((x) => x.mismatch)) {
      log.warn(
        `${r.code}: tracker had ${r.storedRemainingBefore} left, Billing reported ` +
          `${r.reportedBase} (${r.expression}). Billing's figure was used.`,
      );
    }

    const justPrimed = await finishPriming(ctx, replyChats, cfg, store, now);

    if (cfg.sendUpdates && !quiet) {
      const toSend = applied.filter((r) => !cfg.excludeFromUpdates.has(r.code));
      // One message per buyer, sequential, so each cap lands against its code.
      for (const r of toSend) {
        await broadcast(ctx, targets, formatCapUpdate(r), cfg);
        await sleep(cfg.messageDelayMs);
      }
      log.info(`Sent ${toSend.length} cap-update message(s).`);
    }

    if (skipped.length > 0 && cfg.notifyOnDuplicate) {
      await broadcast(ctx, targets, formatSkippedLines(skipped.map((r) => r.code), cfg), cfg);
    }

    if (parsed.rejected.length > 0) {
      await broadcast(
        ctx,
        targets,
        `<b><u>UNREADABLE LINES</u></b> - ${parsed.rejected.length}\n<pre>${esc(
          parsed.rejected.join('\n'),
        )}</pre>`,
        cfg,
      );
    }

    if (!quiet || justPrimed) {
      await sendReminders(ctx, replyChats, cfg, store, now, { force: false });
    }
    await store.writeDailySummary(now, { lastEvent: 'billing' });
    return;
  }

  // statistics
  const changes = applyStats(store, entries, cfg, now);
  recordSeen();

  await store.writeEvent(
    'stats',
    {
      chatId: incoming.chatId,
      messageId: incoming.messageId,
      senderUsername: incoming.senderUsername,
      classifierReason: parsed.reason,
      hash,
      rejectedLines: parsed.rejected,
      repeatedCodesInMessage: duplicateCodes,
      rebaselined: changes.filter((c) => c.rebaselined).map((c) => c.code),
      entries,
      changes,
    },
    now,
  );
  await store.persist(now);

  const rolled = changes.filter((c) => c.rebaselineReason === 'new-utc-day').length;
  log.info(
    `Applied call statistics for ${changes.length} buyer(s)` +
      (rolled > 0 ? `; ${rolled} re-baselined for the new UTC day.` : '.'),
  );

  const justPrimed = await finishPriming(ctx, replyChats, cfg, store, now);
  if (!quiet || justPrimed) {
    await sendReminders(ctx, replyChats, cfg, store, now, { force: false });
  }
  await store.writeDailySummary(now, { lastEvent: 'stats' });
}

/**
 * Ends the quiet first run when the second of the two configuration inputs has
 * landed, announcing it with a single line. Returns true only on that
 * transition, so the caller knows it may now speak.
 */
async function finishPriming(
  ctx: Context,
  replyChats: string[],
  cfg: Config,
  store: Store,
  now: Date,
): Promise<boolean> {
  if (!cfg.quietUntilPrimed) {
    // Nothing was being held back; still record the moment for /day.
    store.markPrimedIfReady(now);
    return false;
  }
  if (!store.markPrimedIfReady(now)) return false;

  const buyers = report(store, cfg).length;
  log.info(`Initial configuration complete (${buyers} buyer(s)); going live.`);
  await store.writeEvent('primed', { buyerCount: buyers }, now);
  await store.persist(now);
  await broadcast(ctx, replyChats, formatPrimed(buyers), cfg);
  return true;
}

async function sendReminders(
  ctx: Context,
  targets: string[],
  cfg: Config,
  store: Store,
  now: Date,
  opts: { force: boolean },
): Promise<number> {
  if (!cfg.sendReminders) return 0;

  const { items, suppressed } = buildReminders(store, cfg, now, {
    force: opts.force,
    commit: true,
  });

  if (suppressed.length > 0) {
    log.debug(`Reminder cooldown suppressed: ${suppressed.join(', ')}`);
  }
  if (items.length === 0) return 0;

  await store.writeEvent('reminders', { items, suppressed, forced: opts.force }, now);
  await store.persist(now);

  for (const part of chunk(formatReminder(items, cfg))) {
    await broadcast(ctx, targets, part, cfg);
    await sleep(cfg.messageDelayMs);
  }
  log.info(`Reminded about ${items.length} buyer(s): ${items.map((i) => i.code).join(', ')}`);
  return items.length;
}

async function handleCommand(
  ctx: Context,
  incoming: Incoming,
  text: string,
  cfg: Config,
  store: Store,
): Promise<void> {
  // Strip the @BotName suffix Telegram adds in groups.
  const [rawCmd = '', ...args] = text.split(/\s+/);
  const cmd = rawCmd.split('@')[0]?.toLowerCase() ?? '';
  const now = new Date();
  const reply = (body: string) => send(ctx, incoming.chatId, body);

  const isAdmin =
    cfg.adminUserIds.length === 0 ||
    (incoming.userId !== null && cfg.adminUserIds.includes(incoming.userId));

  switch (cmd) {
    case '/start':
    case '/help':
      await reply(formatHelp(cfg));
      return;

    case '/status': {
      for (const part of chunk(formatStatus(report(store, cfg), cfg, now))) {
        await reply(part);
        await sleep(cfg.messageDelayMs);
      }
      return;
    }

    case '/pending': {
      const { items } = buildReminders(store, cfg, now, { force: true, commit: false });
      if (items.length === 0) {
        await reply('No buyer is below the almost-depleted threshold.');
        return;
      }
      for (const part of chunk(formatReminder(items, cfg))) {
        await reply(part);
        await sleep(cfg.messageDelayMs);
      }
      return;
    }

    case '/remind': {
      const targets = replyTargets(cfg, incoming.chatId);
      const n = await sendReminders(ctx, targets, cfg, store, now, { force: true });
      if (n === 0) await reply('Nothing to remind about right now.');
      return;
    }

    case '/buyer': {
      const code = (args[0] ?? '').toUpperCase();
      if (!code) {
        await reply('Usage: <code>/buyer CODE</code>');
        return;
      }
      const row = report(store, cfg).find((r) => r.code === code);
      if (!row) {
        await reply(`No record for <b>${esc(code)}</b>.`);
        return;
      }
      await reply(formatBuyer(row, cfg));
      return;
    }

    case '/excluded': {
      const list = (s: Set<string>) =>
        s.size === 0 ? '<i>none</i>' : esc([...s].sort().join(', '));
      await reply(
        [
          '<b><u>EXCLUSIONS</u></b>',
          '<i>edit the root <code>.env</code> and restart</i>',
          `No reminders: ${list(cfg.excludeFromReminders)}`,
          `No update messages: ${list(cfg.excludeFromUpdates)}`,
          `Ignored entirely: ${list(cfg.excludeBuyers)}`,
        ].join('\n'),
      );
      return;
    }

    case '/setcap': {
      if (!isAdmin) {
        await reply('Admins only.');
        return;
      }
      const code = (args[0] ?? '').toUpperCase();
      const value = Number(args[1]);
      if (!code || !Number.isFinite(value)) {
        await reply('Usage: <code>/setcap CODE 250</code>');
        return;
      }
      const buyer = store.ensureBuyer(code, now);
      const before = remainingFor(buyer, cfg);
      buyer.cap = value;
      buyer.lastTopUp = 0;
      buyer.capUpdatedAt = now.toISOString();
      buyer.callsAtCapUpdate = buyer.calls;
      buyer.lastReminder = null;

      await store.writeEvent('manual-setcap', { code, before, cap: value, by: incoming.userId }, now);
      await store.persist(now);
      await store.writeDailySummary(now, { lastEvent: 'manual-setcap' });
      await reply(`<b>${esc(code)}</b> cap set to <code>${value}</code> (was ${before}).`);
      return;
    }

    case '/forget': {
      if (!isAdmin) {
        await reply('Admins only.');
        return;
      }
      const code = (args[0] ?? '').toUpperCase();
      if (!code) {
        await reply('Usage: <code>/forget CODE</code>');
        return;
      }
      const removed = store.removeBuyer(code);
      if (removed) {
        await store.writeEvent('manual-forget', { code, by: incoming.userId }, now);
        await store.persist(now);
        await store.writeDailySummary(now, { lastEvent: 'manual-forget' });
      }
      await reply(removed ? `Stopped tracking <b>${esc(code)}</b>.` : `No record for <b>${esc(code)}</b>.`);
      return;
    }

    case '/chatid':
      await reply(`Chat ID: <code>${esc(incoming.chatId)}</code>`);
      return;

    case '/day': {
      const state = store.getState();
      const today = store.dayOf(now);
      const handled = store.processedOn(today);
      await reply(
        [
          '<b><u>CURRENT DAY</u></b>',
          '',
          `Day: <code>${esc(today)}</code> (${esc(cfg.timezone)})`,
          `Bot clock: <code>${esc(now.toISOString())}</code>`,
          `Messages applied today: ${handled.length}` +
            (handled.length > 0
              ? ` (${handled.filter((p) => p.kind === 'billing').length} billing, ` +
                `${handled.filter((p) => p.kind === 'stats').length} stats)`
              : ''),
          `Last billing: ${state.lastBillingAt ? esc(state.lastBillingAt) : 'never'}`,
          `Last stats: ${state.lastStatsAt ? esc(state.lastStatsAt) : 'never'}`,
          store.isPrimed()
            ? `Live since: <code>${esc(state.primedAt ?? '-')}</code>`
            : `<b>Quiet first run</b> - waiting for ${esc(
                store.missingForPriming().join(' and '),
              )}`,
          '',
          `<i>Duplicate window: ${cfg.duplicateWindowMinutes} minutes  |  ` +
            `daily counter reset: ${cfg.statsResetDaily ? 'on' : 'off'}</i>`,
        ].join('\n'),
      );
      return;
    }

    default:
      return; // ignore commands meant for other bots
  }
}

/**
 * Where the bot's own output goes: every chat in REPLY_TO_CHAT_IDS, or the chat
 * the source message arrived in when that list is empty.
 */
function replyTargets(cfg: Config, sourceChatId: string): string[] {
  return cfg.replyToChatIds.length > 0 ? cfg.replyToChatIds : [sourceChatId];
}

/** Posts the same message to every reply chat, one at a time. */
async function broadcast(
  ctx: Context,
  chatIds: string[],
  html: string,
  cfg: Config,
): Promise<void> {
  for (const [i, chatId] of chatIds.entries()) {
    if (i > 0) await sleep(cfg.messageDelayMs);
    await send(ctx, chatId, html);
  }
}

async function send(ctx: Context, chatId: string, html: string): Promise<void> {
  try {
    await ctx.telegram.sendMessage(chatId, html, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    log.error(`Failed to send message to ${chatId}:`, err);
  }
}
