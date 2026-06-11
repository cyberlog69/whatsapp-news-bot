// src/sender.js
// WhatsApp client using whatsapp-web.js (unofficial library).
//
// On first run → displays a QR code in the terminal. Scan it with WhatsApp.
// After that → session is saved to .wwebjs_auth/ so you never scan again.
//
// USAGE:
//   const sender = new WhatsAppSender('919876543210');
//   await sender.initialize();
//   await sender.waitUntilReady();
//   await sender.sendMessage('Hello from the bot!');

const fs = require('fs');

// Detect system Chrome — tries common Windows install paths
function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null; // let puppeteer auto-detect
}

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const logger  = require('./logger');

class WhatsAppSender {
  /**
   * @param {string} targetNumber - Phone number with country code, no + or spaces
   *                                e.g. '919876543210'
   */
  constructor(targetNumber) {
    this.targetNumber = targetNumber;
    this.isReady      = false;
    this.client       = null;
    this._readyResolve = null;
    this._readyPromise = new Promise((resolve) => { this._readyResolve = resolve; });
  }

  /** Initialize the WhatsApp client and begin authentication. */
  async initialize() {
    const chromePath = findChrome();
    if (chromePath) {
      logger.info(`Using system Chrome: ${chromePath}`);
    } else {
      logger.warn('System Chrome not found — puppeteer will try to auto-detect.');
    }

    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: 'news-bot' }),
      puppeteer: {
        headless: true,
        executablePath: chromePath || undefined,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ]
      }
    });

    // ── Events ───────────────────────────────────────────────────────────────

    this.client.on('qr', (qr) => {
      console.log('\n');
      console.log('╔══════════════════════════════════════════════════╗');
      console.log('║  📱  SCAN THIS QR CODE WITH WHATSAPP              ║');
      console.log('║  Open WhatsApp → Linked Devices → Link a Device  ║');
      console.log('╚══════════════════════════════════════════════════╝\n');
      qrcode.generate(qr, { small: true });
      console.log('\n⏳  Waiting for you to scan...\n');
    });

    this.client.on('loading_screen', (percent) => {
      process.stdout.write(`\r⏳  WhatsApp loading: ${percent}%   `);
    });

    this.client.on('authenticated', () => {
      console.log('');
      logger.success('WhatsApp authenticated! (session saved for future runs)');
    });

    this.client.on('ready', () => {
      console.log('');
      logger.success('WhatsApp client READY — messages can now be sent.');
      this.isReady = true;
      this._readyResolve();
    });

    this.client.on('auth_failure', (msg) => {
      logger.error(`WhatsApp authentication FAILED: ${msg}`);
      logger.warn('Delete the .wwebjs_auth folder and restart to re-scan QR.');
    });

    this.client.on('disconnected', (reason) => {
      logger.warn(`WhatsApp disconnected: ${reason}`);
      this.isReady = false;
    });

    // Start the client (launches headless browser)
    logger.info('Starting WhatsApp client (this may take ~30 seconds)...');
    await this.client.initialize();
  }

  /** Wait until the client is authenticated and ready. */
  waitUntilReady() {
    return this._readyPromise;
  }

  /**
   * Send a text message to the configured target number.
   * @param {string} message
   */
  async sendMessage(message) {
    if (!this.isReady) {
      throw new Error('WhatsApp client not ready — cannot send message.');
    }

    // WhatsApp expects: countrycode + number + @c.us
    // e.g. 919876543210@c.us
    const chatId = this.targetNumber.replace(/\D/g, '') + '@c.us';

    try {
      await this.client.sendMessage(chatId, message);
    } catch (err) {
      // Surface a more helpful error message
      throw new Error(`sendMessage failed to ${chatId}: ${err.message}`);
    }
  }

  /** Gracefully shut down the client. */
  async destroy() {
    if (this.client) {
      await this.client.destroy().catch(() => {});
    }
  }
}

module.exports = WhatsAppSender;
