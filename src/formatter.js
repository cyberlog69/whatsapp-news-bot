// src/formatter.js
// Formats news articles for WhatsApp and Telegram.
//
// Security hardening:
//   - All external text (titles, summaries, sources) is escaped before insertion
//   - Article URLs are validated to be http/https only (blocks javascript: XSS)
//   - WhatsApp markdown special chars are escaped to prevent format injection
//   - Telegram uses HTML parse mode with proper esc() on ALL user-supplied content

// ── Shared Security Helpers ───────────────────────────────────────────────────

/**
 * Escape HTML special characters for safe use in Telegram HTML mode.
 * Prevents XSS / HTML injection from untrusted RSS content.
 */
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Escape WhatsApp markdown special characters.
 * Prevents format injection from article titles/summaries with *, _, ~, ` chars.
 */
function escWA(str) {
  return String(str || '').replace(/[*_~`]/g, (c) => `\\${c}`);
}

/**
 * Validate and return a safe URL for embedding in links.
 * Rejects non-http/https schemes (e.g. javascript:, file:, data:).
 * @param {string} url
 * @returns {string} safe URL, or '#' if invalid
 */
function safeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return url;
    }
    return '#'; // reject javascript:, file:, data:, etc.
  } catch {
    return '#'; // reject malformed URLs
  }
}

// ── WhatsApp Formatter ────────────────────────────────────────────────────────

/**
 * Format an article for WhatsApp.
 * Escapes markdown special chars in all untrusted text.
 */
function formatArticle(article, summary) {
  const timeStr = formatDate(article.publishedAt);
  const divider = '━━━━━━━━━━━━━━━━━━━━━━━━━';

  // Escape WhatsApp markdown in untrusted fields
  const title    = escWA(article.title);
  const source   = escWA(article.source);
  const category = escWA(article.category);
  const url      = safeUrl(article.url);

  return [
    `${category}  |  *${source}*`,
    divider,
    `*${title}*`,
    '',
    summary,           // already bullet-formatted; * and _ are intentional here
    '',
    `🔗 ${url}`,
    `⏰ _${timeStr}_`,
    divider
  ].join('\n');
}

/**
 * Format a startup message for WhatsApp.
 */
function formatStartupMessage(sourceNames, intervalMin) {
  const divider = '━━━━━━━━━━━━━━━━━━━━━━━━━';
  return [
    `📰 *News Bot Started!*`,
    divider,
    `Monitoring *${sourceNames.length}* sources:`,
    '',
    ...sourceNames.map((n) => `   ✅ ${escWA(n)}`),
    '',
    `🔄 Checking every *${intervalMin} minutes*`,
    `🤖 Gemini AI summarization: active`,
    divider,
    `_Articles will be delivered as soon as they're published._`
  ].join('\n');
}

// ── Telegram Formatter (HTML mode) ───────────────────────────────────────────

/**
 * Format an article for Telegram (HTML parse mode).
 * ALL untrusted content (title, source, category, summary, url) is escaped/validated.
 */
function formatArticleForTelegram(article, summary) {
  const timeStr = formatDate(article.publishedAt);
  const divider = '━━━━━━━━━━━━━━━━━━━━━━━━━';

  // Escape ALL external text before inserting into HTML
  const title    = esc(article.title);
  const source   = esc(article.source);
  const category = esc(article.category);
  const url      = safeUrl(article.url);   // scheme-validated, then HTML-escaped in href

  // Escape AI summary — Gemini could include HTML tags; strip them safely
  const telegramSummary = summary
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => `▪ ${esc(l.replace(/^[•▪\-*]\s*/, ''))}`)
    .join('\n');

  return [
    `${esc(category)}  |  <b>${source}</b>`,
    divider,
    `<b>${title}</b>`,
    '',
    telegramSummary,
    '',
    `🔗 <a href="${esc(url)}">Read full article</a>`,
    `⏰ <i>${esc(timeStr)}</i>`,
    divider
  ].join('\n');
}

/**
 * Startup message for Telegram (HTML).
 */
function formatStartupMessageForTelegram(sourceNames, intervalMin) {
  const divider = '━━━━━━━━━━━━━━━━━━━━━━━━━';
  return [
    `📰 <b>News Bot Started!</b>`,
    divider,
    `Monitoring <b>${esc(String(sourceNames.length))}</b> sources:`,
    '',
    ...sourceNames.map((n) => `   ✅ ${esc(n)}`),
    '',
    `🔄 Checking every <b>${esc(String(intervalMin))}</b> minutes`,
    `🤖 Gemini AI summarization: active`,
    divider,
    `<i>Articles will be delivered as soon as they're published.</i>`
  ].join('\n');
}

// ── Shared Helpers ────────────────────────────────────────────────────────────

/** Convert ISO / RFC date string to a human-readable local time */
function formatDate(dateStr) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 'Unknown date';
    return d.toLocaleString('en-IN', {
      day:    '2-digit',
      month:  'short',
      year:   'numeric',
      hour:   '2-digit',
      minute: '2-digit',
      hour12: true
    });
  } catch {
    return 'Unknown date';
  }
}

module.exports = {
  formatArticle,
  formatStartupMessage,
  formatArticleForTelegram,
  formatStartupMessageForTelegram
};
