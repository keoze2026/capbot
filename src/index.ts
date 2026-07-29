import { loadConfig } from './config';
import { createBot } from './bot';
import { Store } from './store/store';
import { log, setLogLevel } from './util/log';

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  const store = new Store(cfg.dataDir, cfg.timezone);
  await store.init();

  const bot = createBot(cfg, store);

  const me = await bot.telegram.getMe();
  log.info(`Starting as @${me.username} (id ${me.id})`);
  log.info(`Data dir: ${cfg.dataDir}`);
  log.info(
    `Day boundary: ${cfg.timezone} (today is ${store.dayOf(new Date())}); ` +
      `daily counter reset: ${cfg.statsResetDaily ? 'on' : 'off'}`,
  );
  log.info(
    `Duplicate guard: ${cfg.duplicateWindowMinutes}m window, ` +
      `${cfg.processedHistorySize} messages remembered, ` +
      `notify: ${cfg.notifyOnDuplicate ? 'on' : 'off'}`,
  );
  log.info(`Accounting: ${cfg.capAccounting}, threshold ${cfg.reminderThreshold}`);
  log.info(
    cfg.enableCommands
      ? 'Commands: on'
      : 'Commands: off - every slash message is ignored, /start included ' +
        '(ENABLE_COMMANDS=true to answer them)',
  );
  if (cfg.quietUntilPrimed && !store.isPrimed()) {
    log.info(
      `Quiet first run: listening silently until a ${store
        .missingForPriming()
        .join(' and a ')} arrive(s); nothing will be posted before then.`,
    );
  }
  log.info(
    `Reply chats: ${
      cfg.replyToChatIds.length > 0
        ? cfg.replyToChatIds.join(', ')
        : '(reply in source chat)'
    }; allowed chats: ${
      cfg.allowedChatIds.length > 0 ? cfg.allowedChatIds.join(', ') : 'any'
    }`,
  );
  if (cfg.excludeFromReminders.size > 0) {
    log.info(`No reminders for: ${[...cfg.excludeFromReminders].join(', ')}`);
  }
  if (cfg.excludeFromUpdates.size > 0) {
    log.info(`No update messages for: ${[...cfg.excludeFromUpdates].join(', ')}`);
  }
  if (cfg.excludeBuyers.size > 0) {
    log.info(`Ignoring entirely: ${[...cfg.excludeBuyers].join(', ')}`);
  }

  const stop = (signal: string) => {
    log.info(`${signal} received, shutting down.`);
    bot.stop(signal);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  await bot.launch({ dropPendingUpdates: false });
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
