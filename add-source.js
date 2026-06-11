// add-source.js
// Interactive CLI to add a new news source to config.json
// Run with: node add-source.js  OR  npm run add-source
//
// Security hardening:
//   - URL and RSS URL validated (https/http only, no private IPs)
//   - All user inputs length-capped
//   - config.json read/parse wrapped in try/catch

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const { isSafeUrl } = require('./src/fetcher');

const configPath = path.join(__dirname, 'config.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

// Input length limits
const MAX_NAME     = 100;
const MAX_URL      = 500;
const MAX_CATEGORY = 60;

// Common emoji suggestions
const EMOJI_SUGGESTIONS = [
  '🔐 Cybersecurity', '🕵️ Hacking', '💻 Tech', '📡 Infosec',
  '🌐 World News', '📊 Finance', '🤖 AI & ML', '🛡️ Security'
];

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  📰  Add a New News Source                 ');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Safely load config
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    console.error(`❌ Could not read config.json: ${err.message}`);
    console.error('   Make sure config.json exists and is valid JSON.');
    rl.close();
    process.exit(1);
  }

  console.log('Current sources:');
  config.sources.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.enabled ? '✅' : '❌'} ${s.name}`);
  });
  console.log('');

  // ── Collect and validate inputs ──────────────────────────────────────────

  const name = (await ask('Source Name       (e.g. The Hacker News): '))
    .trim().slice(0, MAX_NAME);

  if (!name) {
    console.error('\n❌ Source name is required. Aborting.\n');
    rl.close(); process.exit(1);
  }

  // Website URL (display only — not fetched by the bot, but still validate)
  let url = (await ask('Website URL       (e.g. https://thehackernews.com): ')).trim().slice(0, MAX_URL);
  if (url && !isSafeUrl(url)) {
    console.warn('⚠️  Website URL looks invalid or uses a non-http/https scheme — storing as-is but it won\'t be fetched.');
  }

  // RSS Feed URL — this WILL be fetched, so strict validation required
  let rss = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    rss = (await ask('RSS Feed URL      (e.g. https://feeds.feedburner.com/...): ')).trim().slice(0, MAX_URL);
    if (!rss) {
      console.error('\n❌ RSS Feed URL is required. Aborting.\n');
      rl.close(); process.exit(1);
    }
    if (isSafeUrl(rss)) break;
    console.error(`❌ RSS URL must start with https:// or http:// and cannot point to internal network addresses.`);
    if (attempt === 2) {
      console.error('Too many invalid attempts. Aborting.\n');
      rl.close(); process.exit(1);
    }
  }

  console.log('\nCategory suggestions:');
  EMOJI_SUGGESTIONS.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
  const category = (await ask('\nCategory          (pick from above or type your own): '))
    .trim().slice(0, MAX_CATEGORY) || '📰 News';

  const enabledStr = (await ask('Enable now?       (Y/n): ')).trim().toLowerCase();
  const enabled    = enabledStr !== 'n';

  const newSource = { name, url, rss, category, enabled };

  // ── Duplicate check ──────────────────────────────────────────────────────
  const exists = config.sources.some(
    (s) => s.rss === rss || s.name.toLowerCase() === name.toLowerCase()
  );
  if (exists) {
    console.warn('\n⚠️  A source with this name or RSS URL already exists!');
    const overwrite = (await ask('Add anyway? (y/N): ')).trim().toLowerCase();
    if (overwrite !== 'y') {
      console.log('Aborted.\n');
      rl.close();
      return;
    }
  }

  // ── Save ─────────────────────────────────────────────────────────────────
  config.sources.push(newSource);
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error(`❌ Failed to save config.json: ${err.message}`);
    rl.close(); process.exit(1);
  }

  console.log(`\n✅  Added "${name}" to config.json!`);
  if (enabled) {
    console.log('🔄  Restart the bot (Ctrl+C → npm start) to begin receiving news from this source.');
  } else {
    console.log('ℹ️  Source is disabled. Set "enabled": true in config.json to activate it.');
  }
  console.log('');

  rl.close();
}

main().catch((err) => {
  console.error('Unexpected error:', err.message.split('\n')[0]);
  rl.close();
  process.exit(1);
});
