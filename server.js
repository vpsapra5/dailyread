/**
 * DailyRead - Cloud & Local Node.js Server
 * 30-minute daily book summaries, Kindle reader, and automated 9:00 PM email delivery.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 4747;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Paths
const DATA_DIR = path.join(__dirname, 'data');
const CATALOG_DIR = path.join(DATA_DIR, 'catalog');
const SUMMARIES_DIR = path.join(DATA_DIR, 'summaries');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const CUSTOM_BOOKS_PATH = path.join(DATA_DIR, 'custom-books.json');
const ENV_PATH = path.join(__dirname, '.env');

// Ensure directories exist
[DATA_DIR, CATALOG_DIR, SUMMARIES_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Load .env if present
function loadEnv() {
  if (fs.existsSync(ENV_PATH)) {
    const lines = fs.readFileSync(ENV_PATH, 'utf-8').split(/\r?\n/);
    lines.forEach(line => {
      const match = line.match(/^\s*([A-Za-z_]+)\s*=\s*(.*)$/);
      if (match) {
        const key = match[1].trim();
        const val = match[2].trim().replace(/^['"]|['"]$/g, '');
        if (!process.env[key]) process.env[key] = val;
      }
    });
  }
}
loadEnv();

// Helpers
function readJson(filePath, defaultValue) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (e) { }
  return defaultValue;
}

function writeJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('Error writing json:', filePath, e.message);
  }
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function getDateKey(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Default Settings
function getDefaultSettings() {
  return {
    notifyTime: '21:00',
    days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    fictionRatio: 0.3,
    summaryMinutes: 30,
    wpm: 230,
    weights: {},
    browserNotify: false,
    model: 'gemini-2.5-flash',
    email: {
      enabled: true,
      targetEmail: 'vpsapra5@gmail.com',
      senderEmail: 'vpsapra5@gmail.com',
      service: 'gmail',
      appPassword: process.env.GMAIL_APP_PASSWORD || 'kadi sljp ikrd ehvb',
      resendApiKey: '',
      includeFullSummary: false
    }
  };
}

function getSettings() {
  const defaults = getDefaultSettings();
  const saved = readJson(SETTINGS_PATH, {});
  const merged = { ...defaults, ...saved };
  if (!merged.email) merged.email = defaults.email;
  return merged;
}

function getCategories() {
  return readJson(path.join(CATALOG_DIR, 'categories.json'), []);
}

function getCategoryMap() {
  const map = {};
  getCategories().forEach(c => { map[c.id] = c; });
  return map;
}

function getAllBooks() {
  const cats = getCategoryMap();
  const standard = readJson(path.join(CATALOG_DIR, 'books.json'), []);
  const custom = readJson(CUSTOM_BOOKS_PATH, []);
  const list = [];
  const seen = new Set();

  [...standard.map(b => ({ ...b, custom: false })), ...custom.map(b => ({ ...b, custom: true }))].forEach(b => {
    const id = b.id || slugify(b.title);
    if (!seen.has(id)) {
      seen.add(id);
      const cat = cats[b.cat] || { name: b.cat || 'General', icon: '📖', domain: 'Other', fiction: false };
      list.push({
        id,
        title: b.title,
        author: b.author || 'Unknown',
        cat: b.cat,
        catName: cat.name,
        icon: cat.icon,
        domain: cat.domain,
        fiction: Boolean(cat.fiction),
        desc: b.desc || `A high-impact breakdown of ${b.title} by ${b.author}.`,
        custom: Boolean(b.custom)
      });
    }
  });

  return list;
}

function getBookById(id) {
  return getAllBooks().find(b => b.id === id) || null;
}

function getHistory() {
  const defaults = { days: {}, queue: [], finished: {}, progress: {} };
  return { ...defaults, ...readJson(HISTORY_PATH, defaults) };
}

function selectNextBook(history, forDate, exclude = []) {
  const settings = getSettings();
  const books = getAllBooks();
  const byId = {};
  books.forEach(b => { byId[b.id] = b; });
  const finished = history.finished || {};

  // 1. Queue always wins
  if (history.queue && history.queue.length > 0) {
    for (let i = 0; i < history.queue.length; i++) {
      const q = history.queue[i];
      if (byId[q] && !finished[q] && !exclude.includes(q)) {
        history.queue.splice(i, 1);
        return byId[q];
      }
    }
  }

  // 2. Used books
  const used = new Set();
  Object.values(history.days || {}).forEach(d => {
    if (d.bookId) used.add(d.bookId);
    (d.skipped || []).forEach(s => used.add(s));
  });

  const available = books.filter(b => !used.has(b.id) && !finished[b.id] && !exclude.includes(b.id));
  if (available.length > 0) {
    // Deterministic pseudo-random pick based on date string
    let hash = 0;
    for (let i = 0; i < forDate.length; i++) hash = (hash * 31 + forDate.charCodeAt(i)) & 0xffffffff;
    const index = Math.abs(hash) % available.length;
    return available[index];
  }

  // Fallback if all finished
  return books[0] || null;
}

function getDayEntry(dateKey = getDateKey()) {
  const history = getHistory();
  if (!history.days) history.days = {};

  if (!history.days[dateKey] || !history.days[dateKey].bookId) {
    const book = selectNextBook(history, dateKey);
    history.days[dateKey] = {
      assignedAt: new Date().toISOString(),
      bookId: book ? book.id : 'atomic-habits',
      skipped: []
    };
    writeJson(HISTORY_PATH, history);
  }

  return history.days[dateKey];
}

function getSummaryStatus(bookId) {
  const p = path.join(SUMMARIES_DIR, `${bookId}.md`);
  const generated = fs.existsSync(p);
  return {
    bookId,
    generated,
    generating: false,
    error: null,
    hasFile: generated
  };
}

// Gemini AI Generation
async function generateSummary(bookId) {
  const book = getBookById(bookId);
  if (!book) throw new Error('Book not found: ' + bookId);

  const apiKey = process.env.GEMINI_API_KEY || (readJson(ENV_PATH, {}).GEMINI_API_KEY);
  if (!apiKey) throw new Error('No GEMINI_API_KEY set. Please enter your API key in Settings.');

  const prompt = `You are a world-class literary analyst and intellectual speed-reader. 
Create an exhaustive, highly structured, practical 30-minute book summary for:
"${book.title}" by ${book.author} (Category: ${book.catName}).

Structure your summary in pristine Markdown with:
# ${book.title}
*By ${book.author} • Category: ${book.catName}*

## Executive Summary: The Big Idea
(A punchy 3-4 paragraph thesis explaining why this book matters and its core paradigm shift).

## 3 Core Mental Models & Takeaways
1. **Model 1**: Description and concrete application.
2. **Model 2**: Description and concrete application.
3. **Model 3**: Description and concrete application.

## Chapter-by-Chapter Deep Dive Breakdown
(Break down the critical chapters with actionable explanations, real-world examples, and memorable case studies).

## Actionable 7-Day Implementation Plan
(Clear, pragmatic daily steps to immediately apply these ideas).

## Memorable Quotes & Critical Takeaway
(5 powerful quotes from the book with brief commentary).
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const payload = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192
    }
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errText}`);
  }

  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini.');

  const outPath = path.join(SUMMARIES_DIR, `${bookId}.md`);
  fs.writeFileSync(outPath, text, 'utf-8');
  return text;
}

// HTML Email Builder
function buildEmailHtml(book, phoneUrl, minutes = 30) {
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset='utf-8'>
  <meta name='viewport' content='width=device-width, initial-scale=1.0'>
  <title>${book.title} - DailyRead</title>
</head>
<body style='margin:0; padding:0; background-color:#0b0f19; font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color:#f8fafc;'>
  <table role='presentation' width='100%' border='0' cellspacing='0' cellpadding='0' style='background-color:#0b0f19; padding: 24px 12px;'>
    <tr>
      <td align='center'>
        <table role='presentation' width='100%' border='0' cellspacing='0' cellpadding='0' style='max-width:620px; background-color:#131b2e; border: 1px solid #1e293b; border-radius:16px; overflow:hidden; box-shadow:0 12px 30px rgba(0,0,0,0.4);'>
          <tr>
            <td style='padding: 24px 32px; background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-bottom: 1px solid #334155;'>
              <table role='presentation' width='100%' border='0' cellspacing='0' cellpadding='0'>
                <tr>
                  <td>
                    <span style='font-size: 18px; font-weight: 800; color: #f59e0b; letter-spacing: -0.02em;'>Daily<span style='color:#ec4899;'>Read</span></span>
                    <span style='font-size: 12px; color: #94a3b8; margin-left: 10px; text-transform: uppercase; letter-spacing: 0.08em;'>Tonight's 9:00 PM Read</span>
                  </td>
                  <td align='right'>
                    <span style='font-size: 13px; color: #cbd5e1; font-weight: 500;'>${dateStr}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style='padding: 36px 32px;'>
              <div style='margin-bottom: 16px;'>
                <span style='background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;'>${book.catName}</span>
                <span style='background: rgba(255, 255, 255, 0.08); color: #cbd5e1; border: 1px solid rgba(255, 255, 255, 0.12); padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 500; margin-left: 6px;'>${minutes} min read</span>
              </div>
              <h1 style='margin: 0 0 8px 0; font-size: 28px; line-height: 1.25; font-weight: 800; color: #ffffff; font-family: Georgia, serif;'>${book.title}</h1>
              <p style='margin: 0 0 20px 0; font-size: 16px; color: #94a3b8;'>by <strong style='color:#e2e8f0;'>${book.author}</strong></p>
              <div style='background: #1a243b; border-left: 3px solid #f59e0b; border-radius: 4px; padding: 16px 20px; margin-bottom: 28px;'>
                <div style='font-size: 11px; text-transform: uppercase; font-weight: 700; color: #fbbf24; letter-spacing: 0.08em; margin-bottom: 6px;'>The Core Premise</div>
                <p style='margin:0; font-size: 15px; line-height: 1.6; color: #e2e8f0; font-style: italic;'>${book.desc || `Discover the pivotal ideas from ${book.title}.`}</p>
              </div>
              <table role='presentation' border='0' cellspacing='0' cellpadding='0' style='margin-bottom: 24px;'>
                <tr>
                  <td align='center' style='border-radius: 10px; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); box-shadow: 0 4px 14px rgba(245, 158, 11, 0.4);'>
                    <a href='${phoneUrl}' target='_blank' style='display: inline-block; padding: 14px 28px; font-size: 16px; font-weight: 700; color: #ffffff; text-decoration: none; border-radius: 10px;'>
                      📱 Read Tonight's Book on Your Phone &rarr;
                    </a>
                  </td>
                </tr>
              </table>
              <p style='font-size: 13px; color: #94a3b8; margin: 0 0 12px 0;'>
                Direct browser link: <a href='${phoneUrl}' style='color:#38bdf8; text-decoration:none;'>${phoneUrl}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style='padding: 24px 32px; background: #0c1220; border-top: 1px solid #1e293b; text-align: center; color: #64748b; font-size: 13px;'>
              <p style='margin: 0 0 6px 0;'>DailyRead 9:00 PM Edition • One great book, every day, in 30 minutes</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Email Sender
async function sendDailyEmail(book, targetEmail) {
  const settings = getSettings();
  const to = targetEmail || settings.email.targetEmail || 'vpsapra5@gmail.com';
  const sender = settings.email.senderEmail || 'vpsapra5@gmail.com';
  const pass = (settings.email.appPassword || process.env.GMAIL_APP_PASSWORD || 'kadi sljp ikrd ehvb').replace(/\s+/g, '');

  const hostUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`);
  const phoneUrl = `${hostUrl}/#/read/${book.id}`;
  const html = buildEmailHtml(book, phoneUrl, settings.summaryMinutes || 30);

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: sender,
      pass: pass
    }
  });

  const info = await transporter.sendMail({
    from: `"DailyRead" <${sender}>`,
    to: to,
    subject: `📚 Tonight's 30-Min Read: ${book.title} by ${book.author}`,
    html: html
  });

  return { ok: true, messageId: info.messageId, to: to };
}

// -----------------------------------------------------------------------------
//  API Routes
// -----------------------------------------------------------------------------
app.get('/api/today', (req, res) => {
  const dateKey = getDateKey();
  const entry = getDayEntry(dateKey);
  const book = getBookById(entry.bookId);
  const status = getSummaryStatus(entry.bookId);
  const settings = getSettings();

  const tomorrowKey = getDateKey(new Date(Date.now() + 86400000));
  const tomorrowEntry = getDayEntry(tomorrowKey);
  const tomorrowBook = getBookById(tomorrowEntry.bookId);

  res.json({
    date: dateKey,
    book,
    status,
    upNext: [],
    tomorrow: tomorrowBook,
    settings,
    isNetwork: true
  });
});

app.get('/api/books', (req, res) => {
  res.json({ books: getAllBooks() });
});

app.get('/api/categories', (req, res) => {
  res.json({ categories: getCategories() });
});

app.get('/api/summary/:id', (req, res) => {
  const book = getBookById(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const summaryPath = path.join(SUMMARIES_DIR, `${req.params.id}.md`);
  let markdown = null;
  if (fs.existsSync(summaryPath)) {
    markdown = fs.readFileSync(summaryPath, 'utf-8');
  }

  const settings = getSettings();
  res.json({
    book,
    markdown,
    status: getSummaryStatus(req.params.id),
    meta: { words: markdown ? markdown.split(/\s+/).length : 0 },
    wpm: settings.wpm || 230
  });
});

app.get('/api/status/:id', (req, res) => {
  res.json(getSummaryStatus(req.params.id));
});

app.post('/api/generate', async (req, res) => {
  const { bookId } = req.body;
  try {
    const text = await generateSummary(bookId);
    res.json({ ok: true, bookId, words: text.split(/\s+/).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/history', (req, res) => {
  const history = getHistory();
  const finishedList = Object.keys(history.finished || {}).map(id => ({
    book: getBookById(id),
    date: history.finished[id]
  })).filter(x => x.book);

  res.json({
    streak: Object.keys(history.finished || {}).length > 0 ? 1 : 0,
    minutes: Object.keys(history.finished || {}).length * 30,
    count: Object.keys(history.finished || {}).length,
    recent: finishedList,
    finished: history.finished || {},
    progress: history.progress || {}
  });
});

app.post('/api/history/finish', (req, res) => {
  const { bookId, minutes = 30 } = req.body;
  const history = getHistory();
  if (!history.finished) history.finished = {};
  history.finished[bookId] = new Date().toISOString();
  writeJson(HISTORY_PATH, history);
  res.json({ ok: true });
});

app.post('/api/history/progress', (req, res) => {
  const { bookId, page } = req.body;
  const history = getHistory();
  if (!history.progress) history.progress = {};
  history.progress[bookId] = page;
  writeJson(HISTORY_PATH, history);
  res.json({ ok: true });
});

app.get('/api/archive', (req, res) => {
  const history = getHistory();
  const todayKey = getDateKey();
  const days = history.days || {};
  const entries = Object.keys(days).sort().reverse().map(dateKey => {
    const d = days[dateKey];
    const b = getBookById(d.bookId);
    return {
      date: dateKey,
      isToday: dateKey === todayKey,
      book: b,
      finished: Boolean(history.finished && history.finished[d.bookId])
    };
  }).filter(e => e.book);

  res.json({ days: entries });
});

app.get('/api/settings', (req, res) => {
  res.json({
    settings: getSettings(),
    task: { registered: true, state: 'Cloud Active (9:00 PM)' },
    hasKey: Boolean(process.env.GEMINI_API_KEY)
  });
});

app.post('/api/settings', (req, res) => {
  const cur = getSettings();
  const updated = { ...cur, ...req.body };
  writeJson(SETTINGS_PATH, updated);
  res.json({ settings: updated, task: { registered: true, state: 'Cloud Active' }, hasKey: Boolean(process.env.GEMINI_API_KEY) });
});

app.post('/api/test-email', async (req, res) => {
  try {
    const entry = getDayEntry();
    const book = getBookById(entry.bookId);
    const result = await sendDailyEmail(book, req.body.targetEmail);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Nightly Cloud Cron endpoint (called by Vercel Cron or Render Cron at 9:00 PM)
app.get('/api/cron', async (req, res) => {
  try {
    const entry = getDayEntry();
    const book = getBookById(entry.bookId);
    if (!fs.existsSync(path.join(SUMMARIES_DIR, `${book.id}.md`))) {
      await generateSummary(book.id);
    }
    const result = await sendDailyEmail(book);
    res.json({ ok: true, scheduled: '9:00 PM', result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/network', (req, res) => {
  res.json({
    port: PORT,
    mobileUrl: process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`
  });
});

// Wildcard for SPA frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Local runner
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`DailyRead server running at http://localhost:${PORT}`);
  });
}

module.exports = app;
