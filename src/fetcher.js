// src/fetcher.js
// Fetches news articles from RSS feeds.
// Falls back to article-extractor if the RSS snippet is too short to summarize.
//
// Security hardening:
//   - All RSS/article URLs are validated (https/http only, no file:// or SSRF)
//   - Content fields are capped in length before leaving this module
//   - Private IP ranges are blocked to prevent SSRF against internal networks

const Parser  = require('rss-parser');
const { extract } = require('@extractus/article-extractor');
const logger  = require('./logger');

// ── SSRF Protection ───────────────────────────────────────────────────────────

// Block private/internal IP ranges (SSRF protection)
const PRIVATE_IP_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\.0\.0\.0/,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

/**
 * Validate that a URL is safe to fetch:
 *   - Must be http or https
 *   - Must not target private/internal IP ranges
 * @param {string} url
 * @returns {boolean}
 */
function isSafeUrl(url) {
  try {
    const parsed = new URL(url);
    // Only allow http and https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    // Block private IP ranges
    const hostname = parsed.hostname;
    if (PRIVATE_IP_PATTERNS.some((p) => p.test(hostname))) return false;
    return true;
  } catch {
    return false; // malformed URL
  }
}

const parser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (compatible; NewsFeederBot/2.0; +https://github.com/cyberlog69/news-feeder-bot)'
  },
  // Handle Atom + RSS
  customFields: {
    item: [
      ['media:content', 'mediaContent'],
      ['content:encoded', 'contentEncoded']
    ]
  }
});

/**
 * Fetch the latest articles from a single RSS source.
 * Returns an array of article objects.
 */
async function fetchSource(source) {
  // SSRF: validate RSS URL before fetching
  if (!isSafeUrl(source.rss)) {
    logger.warn(`Skipping source "${source.name}": invalid or unsafe RSS URL: ${source.rss}`);
    return [];
  }

  try {
    logger.info(`Fetching: ${source.name}`);
    const feed = await parser.parseURL(source.rss);

    return feed.items.slice(0, 15).map((item) => {
      const rawContent =
        item.contentSnippet ||
        item.contentEncoded ||
        item.content ||
        item.summary ||
        '';

      const url = item.link || item.guid || '';

      return {
        title:       cleanText(item.title || 'No Title').slice(0, 300),    // cap title
        url:         isSafeUrl(url) ? url : '',                             // SSRF: validate item URL
        description: cleanText(rawContent).slice(0, 5000),                  // cap description
        publishedAt: item.pubDate || item.isoDate || new Date().toISOString(),
        source:      source.name,
        category:    source.category
      };
    }).filter((a) => a.url);  // drop articles with invalid/empty URLs

  } catch (err) {
    logger.error(`Failed to fetch ${source.name}: ${err.message}`);
    return [];
  }
}

/**
 * Fetch all enabled sources in parallel.
 * Returns a flat array of all articles found.
 */
async function fetchAllSources(sources) {
  const enabled = sources.filter((s) => s.enabled);
  const results = await Promise.allSettled(enabled.map(fetchSource));

  const all = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      all.push(...result.value);
    } else {
      logger.warn(`Source ${enabled[i].name} rejected: ${result.reason}`);
    }
  });

  return all;
}

/**
 * Attempt to extract full article text from a URL.
 * Returns plain text string, or null on failure.
 * SSRF: URL is validated before fetching.
 */
async function getFullArticleText(url) {
  // SSRF: re-validate the article URL before fetching
  if (!isSafeUrl(url)) return null;

  try {
    const article = await extract(url, {}, { timeout: 12000 });
    if (!article?.content) return null;

    // Strip HTML tags and collapse whitespace — cap at 5000 chars
    return article.content
      .replace(/<[^>]{0,500}>/g, ' ')    // bounded tag regex (prevents ReDoS)
      .replace(/&[a-z]{1,10};/gi, ' ')   // bounded entity regex
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 5000);
  } catch {
    return null;
  }
}

/** Strip HTML and collapse whitespace from a string */
function cleanText(str) {
  return String(str || '')
    .replace(/<[^>]{0,500}>/g, ' ')     // bounded regex (prevents ReDoS)
    .replace(/&[a-z]{1,10};/gi, ' ')    // bounded entity regex
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { fetchAllSources, getFullArticleText, isSafeUrl };
