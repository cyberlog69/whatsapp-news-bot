// src/pipeline.js
// Orchestrates the full news pipeline:
//   Fetch → Deduplicate → Extract → Summarize → Format → Send (all platforms)
//
// Security hardening:
//   - Config settings are bounds-checked before use (DoS prevention)
//   - Error messages are sanitized before logging

const { fetchAllSources, getFullArticleText } = require('./fetcher');
const { summarizeArticle }                     = require('./summarizer');
const { formatArticle, formatArticleForTelegram } = require('./formatter');
const Deduplicator                             = require('./deduplicator');
const logger                                   = require('./logger');

// ── Config value bounds ───────────────────────────────────────────────────────
const BOUNDS = {
  maxArticlesPerRun:     { min: 1,  max: 20,   default: 5 },
  delayBetweenMessages:  { min: 1,  max: 60,   default: 3 },
  summaryBulletPoints:   { min: 1,  max: 10,   default: 3 },
  pollIntervalMinutes:   { min: 1,  max: 1440, default: 5 }
};

function clamp(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

class NewsPipeline {
  /**
   * @param {object}   config   - Parsed config.json
   * @param {object[]} senders  - Array of { name, sender, type } objects
   *                             (also accepts a single sender for backward compat)
   */
  constructor(config, senders) {
    const s = config.settings || {};

    // Validate and clamp all config settings (prevents DoS via extreme values)
    this.maxArticles   = clamp(s.maxArticlesPerRun,        ...Object.values(BOUNDS.maxArticlesPerRun));
    this.delaySec      = clamp(s.delayBetweenMessagesSec,  ...Object.values(BOUNDS.delayBetweenMessages));
    this.bulletPoints  = clamp(s.summaryBulletPoints,      ...Object.values(BOUNDS.summaryBulletPoints));

    this.sources      = config.sources;
    this.deduplicator = new Deduplicator();
    this.isRunning    = false;

    // Normalise: accept single sender or array
    this.senders = Array.isArray(senders)
      ? senders
      : [{ name: 'WhatsApp', sender: senders, type: 'whatsapp' }];

    logger.info(`Pipeline ready — broadcasting to: ${this.senders.map((s) => s.name).join(', ')}`);
  }

  /**
   * Run one full pipeline cycle.
   * Called by the scheduler every N minutes.
   */
  async run() {
    if (this.isRunning) {
      logger.warn('Pipeline already running — skipping this tick.');
      return;
    }
    this.isRunning = true;

    try {
      logger.section('News Pipeline Run');

      // ── Step 1: Fetch ──────────────────────────────────────────────────────
      const allArticles = await fetchAllSources(this.sources);
      logger.info(`Fetched ${allArticles.length} articles total`);

      // ── Step 2: Deduplicate ────────────────────────────────────────────────
      const newArticles = allArticles.filter(
        (a) => a.url && !this.deduplicator.isSeen(a.url)
      );

      if (newArticles.length === 0) {
        logger.info('No new articles — nothing to send.');
        return;
      }

      const toSend = newArticles.slice(0, this.maxArticles);
      logger.info(`${newArticles.length} new articles found — sending up to ${this.maxArticles}`);

      // ── Steps 3–5: Process & Broadcast ────────────────────────────────────
      let sentCount = 0;

      for (const article of toSend) {
        try {
          // 3a. Get full text if RSS snippet is too short
          let content = article.description;
          if (content.length < 150) {
            logger.info(`Extracting full text for: ${article.title.slice(0, 50)}`);
            const full = await getFullArticleText(article.url);
            if (full && full.length > content.length) content = full;
          }

          // 3b. AI Summarize (shared across all platforms)
          const summary = await summarizeArticle(
            article.title,
            content,
            this.bulletPoints,
            article.url
          );

          // 3c. Format for each platform type
          const whatsappMsg = formatArticle(article, summary);
          const telegramMsg = formatArticleForTelegram(article, summary);

          // 3d. Broadcast to all configured platforms
          let anySentOk = false;
          for (const { name, sender, type } of this.senders) {
            try {
              const message = type === 'telegram' ? telegramMsg : whatsappMsg;
              await sender.sendMessage(message);
              logger.success(`[${name}] Sent: ${article.title.slice(0, 55)}…`);
              anySentOk = true;
            } catch (err) {
              // Log only the first line (avoid leaking tokens/IDs in stack traces)
              logger.error(`[${name}] Send failed: ${err.message.split('\n')[0]}`);
            }
          }

          // 3e. Mark as seen only if at least one platform delivered it
          if (anySentOk) {
            this.deduplicator.markSeen(article.url, article.title, article.source);
            sentCount++;
          }

          // Polite delay between articles (bounds-checked)
          await sleep(this.delaySec * 1000);

        } catch (err) {
          logger.error(`Failed processing "${article.title.slice(0, 50)}": ${err.message.split('\n')[0]}`);
        }
      }

      const { totalSent } = this.deduplicator.getStats();
      logger.info(`Run complete — sent ${sentCount} now | ${totalSent} total all-time`);

    } finally {
      this.isRunning = false;
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = NewsPipeline;
