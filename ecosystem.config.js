/**
 * pm2 process definition. Used on the VPS:
 *
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *
 * `cwd` is what matters most here. The bot resolves both its `.env` and its JSON
 * store relative to the working directory, so pm2 must start it from the repo
 * root — otherwise it comes up with no BOT_TOKEN and writes `data/` in the wrong
 * place. `__dirname` keeps that true wherever the folder lives, spaces and all.
 *
 * Nothing sets env vars here on purpose: `.env` is the single source of config,
 * so editing it and running `pm2 restart cap-reminder` is the whole loop.
 */
module.exports = {
  apps: [
    {
      name: 'cap-reminder',
      script: 'dist/index.js',
      cwd: __dirname,

      // One process, and only one: Telegram permits a single long-polling
      // connection per token, so a second instance would fight this one for
      // every message.
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      restart_delay: 5000,
      // A crash loop is a broken config, not something to retry forever.
      max_restarts: 10,
      min_uptime: '30s',
      max_memory_restart: '300M',

      time: true, // timestamp every log line
    },
  ],
};
