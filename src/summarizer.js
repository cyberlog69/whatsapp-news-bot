// src/summarizer.js
// Uses Google Gemini 2.0 Flash (free tier) to summarize news articles.
//
// Free tier limits:
//   • 15 requests / minute
//   • 1,500 requests / day
//   • 1,000,000 tokens / minute
//
// This module handles all three gracefully:
//   • Rate limiter  — enforces ≥4s gap between calls (max 15/min)
//   • Retry logic   — on 429, waits the exact retryDelay the API specifies
//   • Summary cache — skips API call if we've already summarized a URL today

const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('./logger');

let genAI = null;
let model = null;

// ── In-memory summary cache (url → summary string) ───────────────────────────
// Cleared on restart — that's fine, restarts are rare
const summaryCache = new Map();

// ── Rate limiter state ────────────────────────────────────────────────────────
// Ensures at least MIN_INTERVAL_MS between consecutive Gemini API calls
const MIN_INTERVAL_MS = 4500;  // 4.5s gap → max ~13 req/min (safely under 15)
let lastCallAt = 0;

/**
 * Call once at startup with your Gemini API key.
 * If apiKey is falsy, the module runs in fallback (no-AI) mode.
 */
function initGemini(apiKey) {
  if (!apiKey) {
    logger.warn('GEMINI_API_KEY not set — using basic (no-AI) summarization.');
    return;
  }
  genAI = new GoogleGenerativeAI(apiKey);
  model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  logger.success('Gemini AI summarizer ready (gemini-2.0-flash)');
}

/**
 * Summarize an article into bullet points.
 *
 * @param {string} title    - Article headline
 * @param {string} content  - Article body / RSS description
 * @param {number} bullets  - How many bullet points to produce
 * @param {string} [url]    - Article URL (used for cache key)
 * @returns {Promise<string>}
 */
async function summarizeArticle(title, content, bullets = 3, url = '') {
  // ── AI mode ──────────────────────────────────────────────────────────────
  if (model) {
    // 1. Check cache first
    if (url && summaryCache.has(url)) {
      logger.info('Using cached summary (no API call needed)');
      return summaryCache.get(url);
    }

    // 2. Rate limit — wait if last call was too recent
    const now     = Date.now();
    const elapsed = now - lastCallAt;
    if (elapsed < MIN_INTERVAL_MS) {
      const wait = MIN_INTERVAL_MS - elapsed;
      logger.info(`Rate limiting: waiting ${(wait / 1000).toFixed(1)}s before Gemini call`);
      await sleep(wait);
    }

    // 3. Try with up to 3 retries on 429
    const summary = await callGeminiWithRetry(title, content, bullets, url, 3);
    if (summary) return summary;
  }

  // ── Fallback: extract first N meaningful sentences ────────────────────────
  return extractSentences(content || title, bullets);
}

/**
 * Call the Gemini API with automatic retry on rate-limit errors (429).
 * Parses the retryDelay from the API error response and waits exactly that long.
 */
async function callGeminiWithRetry(title, content, bullets, url, maxRetries) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      lastCallAt = Date.now();

      const prompt =
        `Summarize this news article in exactly ${bullets} concise bullet points. ` +
        `Each bullet must be ONE clear sentence. Focus on the most important facts. ` +
        `Output ONLY the bullet points — no intro, no headings, no markdown.\n\n` +
        `Title: ${title}\n` +
        `Content: ${content.slice(0, 2500)}`;

      const result   = await model.generateContent(prompt);
      const response = result.response.text().trim();

      // Normalise all bullet styles to •
      const summary = response
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => `• ${l.replace(/^[•\-*\d.]+\s*/, '')}`)
        .slice(0, bullets)
        .join('\n');

      // Cache the result
      if (url) summaryCache.set(url, summary);

      return summary;

    } catch (err) {
      const is429 = err.message && (
        err.message.includes('429') ||
        err.message.includes('Too Many Requests') ||
        err.message.includes('quota')
      );

      if (is429) {
        // Parse the retryDelay from the error message if present
        const delayMatch = err.message.match(/retryDelay["\s:]+(\d+)/);
        const retrySec   = delayMatch ? parseInt(delayMatch[1], 10) : 15;
        const waitMs     = (retrySec + 2) * 1000;  // add 2s buffer

        if (attempt < maxRetries) {
          logger.warn(`Gemini rate limit hit — waiting ${retrySec + 2}s then retrying (attempt ${attempt}/${maxRetries})`);
          await sleep(waitMs);
          continue;
        } else {
          logger.warn(`Gemini quota exhausted after ${maxRetries} attempts — using fallback summary`);
        }
      } else {
        logger.warn(`Gemini error (falling back): ${err.message.split('\n')[0]}`);
      }
      break;
    }
  }

  return null; // trigger fallback
}

/** Extract the first N meaningful sentences as bullet points */
function extractSentences(text, count) {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30 && s.length < 400);

  if (sentences.length === 0) {
    return `• ${text.slice(0, 250).trim()}`;
  }

  return sentences
    .slice(0, count)
    .map((s) => `• ${s}`)
    .join('\n');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { initGemini, summarizeArticle };
