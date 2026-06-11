// src/pipeline.js
// Orchestrates the full news pipeline:
//   Fetch → Deduplicate → Extract → Summarize → Format → Send

const { fetchAllSources, getFullArticleText } = require('./fetcher');
const { summarizeArticle }                     = require('./summarizer');
const { formatArticle }                        = require('./formatter');
const Deduplicator                             = require('./deduplicator');
const logger                                   = require('./logger');

class NewsPipeline {
  /**
   * @param {object} config  - Parsed config.json
   * @param {object} sender  - WhatsAppSender instance
   */
  constructor(config, sender) {
    this.sources       = config.sources;
    this.settings      = config.settings;
    this.sender        = sender;
    this.deduplicator  = new Deduplicator();
    this.isRunning     = false;   // prevent concurrent runs
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

      // Cap to avoid flooding
      const cap      = this.settings.maxArticlesPerRun || 5;
      const toSend   = newArticles.slice(0, cap);
      logger.info(`${newArticles.length} new articles found — sending up to ${cap}`);

      // ── Steps 3–5: Process & Send ──────────────────────────────────────────
      let sentCount = 0;

      for (const article of toSend) {
        try {
          // 3a. Get full text if RSS snippet is too short
          let content = article.description;
          if (content.length < 150) {
            logger.info(`Short snippet — extracting full text for: ${article.title.slice(0, 50)}`);
            const full = await getFullArticleText(article.url);
            if (full && full.length > content.length) content = full;
          }

          // 3b. AI Summarize
          const summary = await summarizeArticle(
            article.title,
            content,
            this.settings.summaryBulletPoints || 3,
            article.url   // ← cache key: skip API if already summarized
          );

          // 3c. Format
          const message = formatArticle(article, summary);

          // 3d. Send via WhatsApp
          await this.sender.sendMessage(message);

          // 3e. Mark as seen (only AFTER successful send)
          this.deduplicator.markSeen(article.url, article.title, article.source);
          sentCount++;

          logger.success(`Sent [${article.source}]: ${article.title.slice(0, 65)}…`);

          // Polite delay between messages so WhatsApp doesn't rate-limit us
          const delaySec = this.settings.delayBetweenMessagesSec || 3;
          await sleep(delaySec * 1000);

        } catch (err) {
          logger.error(`Failed on article "${article.title.slice(0, 50)}": ${err.message}`);
          // Continue with remaining articles
        }
      }

      // ── Stats ──────────────────────────────────────────────────────────────
      const { totalSent } = this.deduplicator.getStats();
      logger.info(`Run complete — sent ${sentCount} now | ${totalSent} total all-time`);

    } finally {
      this.isRunning = false;
    }
  }
}

/** Async sleep helper */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = NewsPipeline;
