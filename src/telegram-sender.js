// src/telegram-sender.js
// Sends news articles to a Telegram chat, group, or channel.
//
// Uses Node.js built-in fetch (v18+) — NO third-party HTTP library.
// This avoids the entire vulnerable request/form-data/qs dependency chain.
//
// Setup:
//   1. Message @BotFather on Telegram → /newbot → copy the token
//   2. Set TELEGRAM_BOT_TOKEN in .env
//   3. Set TELEGRAM_TARGET in .env
//   4. Run: npm run list-telegram-chats  to find your chat/group ID
//
// TELEGRAM_TARGET formats:
//   Personal chat:  123456789
//   Group:         -987654321
//   Channel:       @mychannel  |  -1001234567890

const logger = require('./logger');

// Telegram Bot API base URL — always HTTPS
const TG_API = 'https://api.telegram.org';

// Telegram's hard message length limit
const TG_MAX_LENGTH = 4096;

class TelegramSender {
  /**
   * @param {string} token  - Bot token from @BotFather
   * @param {string} target - Chat ID, group ID, or @channelname
   */
  constructor(token, target) {
    this.token  = token;
    this.target = String(target).trim();
    this.type   = 'telegram';
  }

  // ── Private: make an authenticated call to the Bot API ───────────────────
  async _call(method, body = {}, timeoutMs = 15000) {
    const url = `${TG_API}/bot${this.token}/${method}`;

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  controller.signal
      });

      const json = await res.json();

      if (!json.ok) {
        // Never include the token in the error message
        throw new Error(`Telegram API error [${method}]: ${json.description || 'Unknown error'} (code ${json.error_code})`);
      }
      return json.result;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`Telegram API timeout [${method}] after ${timeoutMs}ms`);
      }
      // Sanitize error: remove any accidental token leakage
      const safeMsg = err.message.replace(this.token, '[REDACTED]');
      throw new Error(safeMsg);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Validate token and confirm bot identity. */
  async initialize() {
    logger.info('Initializing Telegram bot...');
    try {
      const me = await this._call('getMe');
      logger.success(`Telegram bot ready: @${me.username} (${me.first_name})`);
      logger.info(`Telegram target: ${this.target}`);
    } catch (err) {
      throw new Error(
        `Telegram initialization failed: ${err.message}\n` +
        'Check TELEGRAM_BOT_TOKEN in your .env file.'
      );
    }
  }

  /**
   * Send an HTML-formatted message to the configured target.
   * Automatically truncates messages that exceed Telegram's 4096 char limit.
   * @param {string} message - HTML-safe string from formatter.js
   */
  async sendMessage(message) {
    // Enforce Telegram's character limit
    const text = message.length > TG_MAX_LENGTH
      ? message.slice(0, TG_MAX_LENGTH - 20) + '\n…<i>(truncated)</i>'
      : message;

    try {
      await this._call('sendMessage', {
        chat_id:                  this.target,
        text,
        parse_mode:               'HTML',
        disable_web_page_preview: true
      });
    } catch (err) {
      // Translate common Telegram errors to actionable messages
      const msg = err.message;
      if (msg.includes('chat not found') || msg.includes('400')) {
        throw new Error(
          'Telegram: target chat not found. Run: npm run list-telegram-chats to find the correct ID.'
        );
      }
      if (msg.includes('kicked') || msg.includes('not a member')) {
        throw new Error('Telegram: bot is not a member of the target chat. Add it to the group/channel first.');
      }
      if (msg.includes('have no rights') || msg.includes('not enough rights')) {
        throw new Error('Telegram: bot lacks permission to post. Make it an Admin with "Post Messages" enabled.');
      }
      throw err;
    }
  }

  /**
   * Fetch recent chats the bot has seen via getUpdates.
   * Used by list-telegram-chats.js.
   */
  async getRecentChats() {
    const updates = await this._call('getUpdates', { limit: 100, timeout: 5 });

    const seen = new Map();
    for (const update of updates) {
      const msg  = update.message || update.channel_post || update.edited_message;
      if (!msg?.chat) continue;
      const chat = msg.chat;
      if (!seen.has(chat.id)) {
        seen.set(chat.id, {
          id:       chat.id,
          type:     chat.type,
          name:     chat.title || `${chat.first_name || ''} ${chat.last_name || ''}`.trim(),
          username: chat.username ? `@${chat.username}` : null
        });
      }
    }
    return [...seen.values()];
  }
}

module.exports = TelegramSender;
