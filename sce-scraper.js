/**
 * SCE account scraper — fetches balance, due date, and billing-period usage.
 * Uses system Chrome (puppeteer-core) to avoid a 300 MB Chromium download.
 * Results are cached to .sce-cache.json and only re-scraped once per day.
 */

const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const path      = require('path');

const CHROME_PATH = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].find(candidate => fs.existsSync(candidate));
const CACHE_FILE  = path.join(__dirname, '.sce-cache.json');
const CACHE_TTL_MS       = 24 * 60 * 60 * 1000; // 24 hours — successful scrape
const ERROR_CACHE_TTL_MS = 15 * 60 * 1000;      // 15 minutes — failed scrape (retry sooner, but don't hammer every request)
const SCRAPE_TIMEOUT_MS  = 20 * 1000;            // hard cap so a hung browser/login never blocks the dashboard

const LOGIN_URL     = 'https://www.sce.com/mysce/login';
const DASHBOARD_URL = 'https://www.sce.com/mysce/myaccount';

function loadCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    const ttl = data.error ? ERROR_CACHE_TTL_MS : CACHE_TTL_MS;
    if (Date.now() - new Date(data.fetchedAt).getTime() < ttl) {
      return data;
    }
  } catch (_) { /* no cache or expired */ }
  return null;
}

function saveCache(data) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}

async function scrape() {
  const email    = process.env.SCE_EMAIL;
  const password = process.env.SCE_PASSWORD;

  if (!email || !password) {
    throw new Error('SCE_EMAIL and SCE_PASSWORD must be set in .env');
  }
  if (!CHROME_PATH) {
    throw new Error('No Chrome executable found for SCE scraping');
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // --- Login ---
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // Dismiss cookie banner if present
    try {
      await page.waitForSelector('button[id*="accept"], button.onetrust-accept-btn-handler', { timeout: 5000 });
      await page.click('button[id*="accept"], button.onetrust-accept-btn-handler');
    } catch (_) { /* no banner */ }

    // Okta form — wait for it to render
    await page.waitForSelector('input[name="identifier"]', { timeout: 15000 });
    await page.type('input[name="identifier"]', email, { delay: 50 });
    await page.type('input[name="credentials.passcode"]', password, { delay: 50 });

    // Set up navigation listener BEFORE clicking to avoid race condition
    const navPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    await page.click('button.button-primary');
    await navPromise;

    // Allow any post-login redirects to settle
    await new Promise(r => setTimeout(r, 2000));

    // Check for login error
    const errorText = await page.evaluate(() => {
      const el = document.querySelector('.okta-form-infobox-error, [data-se="error-container"]');
      return el ? el.textContent.trim() : null;
    });
    if (errorText) throw new Error(`SCE login failed: ${errorText}`);

    // --- Dashboard ---
    // Log where we landed after login, then navigate to account overview
    console.log('[SCE] post-login URL:', page.url());
    await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    console.log('[SCE] dashboard URL:', page.url());
    await new Promise(r => setTimeout(r, 3000)); // let JS widgets settle

    const rawBody = await page.evaluate(() => document.body.innerText);

    // Debug: log the Projected Next Bill section
    const projIdx = rawBody.search(/projected next bill/i);
    if (projIdx !== -1) {
      console.log('[SCE] Projected section:\n', rawBody.substring(projIdx, projIdx + 400));
    }

    const balanceMatch  = rawBody.match(/Amount Due\s+(\$[\d,]+\.\d{2})/i);
    const billDateMatch = rawBody.match(/Next Bill Date:\s+(\w+ \d+,\s*\d{4})/i);
    const lastPayMatch  = rawBody.match(/Last Payment:\s+(\$[\d,]+\.\d{2})\s+on\s+(\w+ \d+,\s*\d{4})/i);

    // SCE concatenates the $ amount and kWh with no separator, e.g. "Projected Bill$8932,428 kWh"
    // meaning $893 and 2,428 kWh. Use non-greedy digits + lookahead for "digit,digit" to find the split.
    const projLineMatch = rawBody.match(/Projected Bill\s*\$(\d+?)(?=\d,\d)(\d[\d,]+)\s*kWh/i);

    // "Usage as of Aug 02 $6911,909 kWh" → $691 and 1,909 kWh
    const usageToDateMatch = rawBody.match(/Usage as of[^\n]*\$(\d+?)(?=\d,\d)(\d[\d,]+)\s*kWh/i);

    // Fallback: first standalone kWh mention (prior-month comparison section)
    const usageMatch = rawBody.match(/([\d,]+(?:\.\d+)?)\s*kWh/i);

    const data = {
      balance:         balanceMatch?.[1]                                        || null,
      dueDate:         billDateMatch?.[1]?.trim()                               || null,
      lastPayment:     lastPayMatch ? `${lastPayMatch[1]} on ${lastPayMatch[2]}` : null,
      projectedBill:   projLineMatch   ? `$${projLineMatch[1]}`                 : null,
      projectedKwh:    projLineMatch   ? `${projLineMatch[2]} kWh`              : null,
      usageToDateAmt:  usageToDateMatch ? `$${usageToDateMatch[1]}`             : null,
      usageToDateKwh:  usageToDateMatch ? `${usageToDateMatch[2]} kWh`          : null,
      usage:           usageMatch ? `${usageMatch[1]} kWh`                      : null,
    };

    return data;
  } finally {
    await browser.close();
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`SCE scrape timed out after ${ms / 1000}s`)), ms)),
  ]);
}

/**
 * Returns cached SCE data if fresh, otherwise re-scrapes.
 * Safe to call from multiple routes — won't double-scrape.
 */
let _scrapeInProgress = null;

async function getSceData() {
  const cached = loadCache();
  if (cached) return cached;

  // Dedupe concurrent requests
  if (_scrapeInProgress) return _scrapeInProgress;

  _scrapeInProgress = withTimeout(scrape(), SCRAPE_TIMEOUT_MS)
    .then(data => {
      const result = { ...data, fetchedAt: new Date().toISOString() };
      saveCache(result);
      return result;
    })
    .catch(err => {
      console.error('[SCE] scrape error:', err.message);
      // Return a graceful fallback so the page still renders, and cache it
      // briefly so a broken/slow scrape doesn't re-run (and re-stall the
      // dashboard) on every single request.
      const result = { balance: null, dueDate: null, usage: null, error: err.message, fetchedAt: new Date().toISOString() };
      saveCache(result);
      return result;
    })
    .finally(() => { _scrapeInProgress = null; });

  return _scrapeInProgress;
}

module.exports = { getSceData };
