// src/deduplicator.js
// Tracks articles we've already sent using a local JSON file so we never
// send duplicates — even across bot restarts.
//
// Pure JavaScript — no native compilation required.

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

// How many URLs to keep in memory/file.
// Oldest entries are dropped when this limit is reached.
const MAX_ENTRIES = 5000;

class Deduplicator {
  constructor() {
    // Ensure data/ directory exists
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.filePath = path.join(dataDir, 'seen_articles.json');
    this.seen = new Set();   // fast in-memory lookup
    this.meta = [];          // keeps {url, title, source, sentAt} for history

    this._load();
    logger.info(`Deduplicator ready — ${this.seen.size} articles already in history`);
  }

  /** Load existing data from disk into memory. */
  _load() {
    if (!fs.existsSync(this.filePath)) return;

    try {
      const raw  = fs.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw);

      this.meta = Array.isArray(data.articles) ? data.articles : [];
      this.seen = new Set(this.meta.map((a) => a.url));
    } catch (err) {
      logger.warn(`Could not read seen_articles.json — starting fresh. (${err.message})`);
      this.meta = [];
      this.seen = new Set();
    }
  }

  /** Persist current state to disk. */
  _save() {
    // Trim oldest entries if we've exceeded the limit
    if (this.meta.length > MAX_ENTRIES) {
      this.meta = this.meta.slice(this.meta.length - MAX_ENTRIES);
      this.seen = new Set(this.meta.map((a) => a.url));
    }

    const payload = {
      lastUpdated: new Date().toISOString(),
      totalCount:  this.meta.length,
      articles:    this.meta
    };

    try {
      // mode 0o600: owner read/write only — protects article history on shared systems
      fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 });
    } catch (err) {
      logger.error(`Failed to save seen_articles.json: ${err.message}`);
    }
  }

  /** Returns true if this URL has already been sent. */
  isSeen(url) {
    return this.seen.has(url);
  }

  /** Mark a URL as seen so it won't be sent again. */
  markSeen(url, title = '', source = '') {
    if (this.seen.has(url)) return;   // idempotent

    this.seen.add(url);
    this.meta.push({
      url:    url.slice(0, 2048),           // cap URL length (prevent file bloat)
      title:  title.slice(0, 120),
      source: String(source).slice(0, 100),
      sentAt: new Date().toISOString()
    });

    this._save();
  }

  /** Return summary stats. */
  getStats() {
    return { totalSent: this.seen.size };
  }
}

module.exports = Deduplicator;
