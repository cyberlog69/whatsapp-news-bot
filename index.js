// index.js — Main entry point
// Boots WhatsApp and/or Telegram based on what's configured in .env,
// then runs the news pipeline on a schedule.

require('dotenv').config();

const path           = require('path');
const fs             = require('fs');
const cron           = require('node-cron');
const WhatsAppSender = require('./src/sender');
const TelegramSender = require('./src/telegram-sender');
const NewsPipeline   = require('./src/pipeline');
const { initGemini } = require('./src/summarizer');
const { formatStartupMessage, formatStartupMessageForTelegram } = require('./src/formatter');
const logger         = require('./src/logger');

// ── Banner ────────────────────────────────────────────────────────────────────
console.log('\n');
console.log('╔══════════════════════════════════════════════════╗');
console.log('║   📰  WhatsApp & Telegram News Bot  v2.0         ║');
console.log('║   Cybersecurity & Tech News, delivered live      ║');
console.log('╚══════════════════════════════════════════════════╝\n');

// ── Read environment ──────────────────────────────────────────────────────────
const WA_TARGET      = process.env.WHATSAPP_TARGET;
const TG_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const TG_TARGET      = process.env.TELEGRAM_TARGET;
const GEMINI_KEY     = process.env.GEMINI_API_KEY;

// Must have at least one platform configured
if (!WA_TARGET && !TG_TOKEN) {
  console.error(
    '❌  No platform configured! Set at least one in your .env:\n\n' +
    '   WhatsApp:  WHATSAPP_TARGET=919876543210\n' +
    '   Telegram:  TELEGRAM_BOT_TOKEN=123:ABC...  +  TELEGRAM_TARGET=@mychannel\n\n' +
    '   Copy .env.example → .env to get started.\n'
  );
  process.exit(1);
}

// ── Load config ───────────────────────────────────────────────────────────────
const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('❌  config.json not found! Make sure it exists in the project root.');
  process.exit(1);
}
let config, enabledSources;
try {
  config         = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  enabledSources = config.sources.filter((s) => s.enabled);
} catch (err) {
  console.error(`❌  Failed to parse config.json: ${err.message}`);
  console.error('   Make sure config.json is valid JSON.');
  process.exit(1);
}

logger.info(`Loaded ${enabledSources.length} enabled news sources`);
enabledSources.forEach((s) => logger.info(`  • ${s.name}  (${s.rss})`));

// ── Initialize Gemini AI (optional) ──────────────────────────────────────────
initGemini(GEMINI_KEY || '');

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const senders = [];   // will hold { name, sender, type }

  // ── WhatsApp (optional) ─────────────────────────────────────────────────
  if (WA_TARGET) {
    logger.info(`WhatsApp target: ${WA_TARGET}`);
    const waSender = new WhatsAppSender(WA_TARGET);
    await waSender.initialize();
    await waSender.waitUntilReady();

    // Startup notification
    try {
      await waSender.sendMessage(
        formatStartupMessage(enabledSources.map((s) => s.name), config.settings.pollIntervalMinutes)
      );
      logger.success('WhatsApp startup notification sent');
    } catch (err) {
      logger.warn(`WhatsApp startup notification failed: ${err.message}`);
    }

    senders.push({ name: 'WhatsApp', sender: waSender, type: 'whatsapp' });
  } else {
    logger.info('WhatsApp: not configured (WHATSAPP_TARGET not set) — skipping');
  }

  // ── Telegram (optional) ─────────────────────────────────────────────────
  if (TG_TOKEN && TG_TARGET) {
    logger.info(`Telegram target: ${TG_TARGET}`);
    const tgSender = new TelegramSender(TG_TOKEN, TG_TARGET);
    await tgSender.initialize();

    // Startup notification
    try {
      await tgSender.sendMessage(
        formatStartupMessageForTelegram(enabledSources.map((s) => s.name), config.settings.pollIntervalMinutes)
      );
      logger.success('Telegram startup notification sent');
    } catch (err) {
      logger.warn(`Telegram startup notification failed: ${err.message}`);
    }

    senders.push({ name: 'Telegram', sender: tgSender, type: 'telegram' });
  } else if (TG_TOKEN && !TG_TARGET) {
    logger.warn('TELEGRAM_BOT_TOKEN is set but TELEGRAM_TARGET is missing — Telegram skipped');
    logger.warn('Run: npm run list-telegram-chats to find your chat ID');
  } else {
    logger.info('Telegram: not configured (TELEGRAM_BOT_TOKEN not set) — skipping');
  }

  if (senders.length === 0) {
    logger.error('No platforms initialized — exiting.');
    process.exit(1);
  }

  // ── Pipeline ────────────────────────────────────────────────────────────
  const pipeline = new NewsPipeline(config, senders);

  // Run immediately on startup
  logger.info('Running initial pipeline pass...');
  await pipeline.run();

  // Schedule recurring runs
  const interval = config.settings.pollIntervalMinutes || 5;
  cron.schedule(`*/${interval} * * * *`, async () => {
    await pipeline.run().catch((err) => {
      logger.error(`Unhandled pipeline error: ${err.message}`);
    });
  });

  logger.success(`Bot is live! Broadcasting to: ${senders.map((s) => s.name).join(' + ')}  |  Press Ctrl+C to stop.\n`);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGINT', () => { logger.warn('Shutting down...'); process.exit(0); });
process.on('uncaughtException',  (err) => logger.error(`Uncaught: ${err.message.split('\n')[0]}`));
// Log only message (not full reason) to avoid leaking tokens/paths in stack traces
process.on('unhandledRejection', (r) => logger.error(`Unhandled rejection: ${r?.message || String(r).split('\n')[0]}`));

// ── Start ─────────────────────────────────────────────────────────────────────
main().catch((err) => {
  logger.error(`Fatal startup error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
