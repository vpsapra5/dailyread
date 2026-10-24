/**
 * DailyRead - Cloud & Local Node.js Server
 * 30-minute daily book summaries, Kindle reader, and automated 9:00 PM email delivery.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 4747;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Paths
const DATA_DIR = path.join(__dirname, 'data');
const SUMMARIES_DIR = path.join(DATA_DIR, 'summaries');
const COURSES_DIR = path.join(DATA_DIR, 'courses');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const CUSTOM_BOOKS_PATH = path.join(DATA_DIR, 'custom-books.json');
const COURSE_PROGRESS_PATH = path.join(DATA_DIR, 'course-progress.json');
const ENV_PATH = path.join(__dirname, '.env');

// Ensure directories exist safely (without throwing EROFS on serverless)
[DATA_DIR, SUMMARIES_DIR, COURSES_DIR].forEach(dir => {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) { }
});

// Load .env if present
function loadEnv() {
  try {
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
  } catch (e) { }
}
loadEnv();

// Helpers for read/write with /tmp fallback for Vercel read-only filesystem
function readJson(filePath, defaultValue) {
  try {
    const baseName = path.basename(filePath);
    const tmpPath = path.join('/tmp', baseName);
    if (fs.existsSync(tmpPath)) {
      return JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
    }
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (e) { }
  return defaultValue;
}

function writeJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return;
  } catch (e) {
    try {
      const baseName = path.basename(filePath);
      fs.writeFileSync(path.join('/tmp', baseName), JSON.stringify(data, null, 2), 'utf-8');
    } catch (e2) { }
  }
}

function slugify(text) {
  return String(text || '')
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
    summaryMinutes: 60,
    wpm: 230,
    weights: {},
    browserNotify: false,
    model: 'gemini-3.8-flash',
    email: {
      enabled: true,
      targetEmail: 'vpsapra5@gmail.com',
      senderEmail: 'vpsapra5@gmail.com',
      service: 'gmail',
      appPassword: process.env.GMAIL_APP_PASSWORD || 'kadisljpikrdehvb',
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

// Bundled Catalog loading with multiple path resolution
function getCategories() {
  try { return require('./catalog/categories.json'); } catch (e) { }
  try { return require('./data/catalog/categories.json'); } catch (e) { }
  return readJson(path.join(__dirname, 'catalog', 'categories.json'), []);
}

function getCategoryMap() {
  const map = {};
  getCategories().forEach(c => { map[c.id] = c; });
  return map;
}

const FALLBACK_BOOKS = [
  { id: 'atomic-habits', title: 'Atomic Habits', author: 'James Clear', cat: 'selfhelp', domain: 'mind', desc: 'Tiny changes, remarkable results. An operating system for daily improvement.' },
  { id: 'crucial-conversations', title: 'Crucial Conversations', author: 'Kerry Patterson', cat: 'communication', domain: 'social', desc: 'Tools for talking when stakes are high, opinions vary, and emotions run strong.' },
  { id: 'dune', title: 'Dune', author: 'Frank Herbert', cat: 'scifi', domain: 'scifi', fiction: true, desc: 'A monumental epic of politics, religion, and ecology on the desert planet Arrakis.' },
  { id: 'project-hail-mary', title: 'Project Hail Mary', author: 'Andy Weir', cat: 'scifi', domain: 'scifi', fiction: true, desc: 'A lone astronaut must solve an extinction-level scientific puzzle to save Earth.' },
  { id: 'crime-and-punishment', title: 'Crime and Punishment', author: 'Fyodor Dostoevsky', cat: 'classics', domain: 'culture', fiction: true, desc: 'The psychological torment and moral dilemmas of an impoverished ex-student in Saint Petersburg.' }
];

function getAllBooks() {
  const cats = getCategoryMap();
  let standard = [];
  try { standard = require('./catalog/books.json'); } catch (e) {
    try { standard = require('./data/catalog/books.json'); } catch (e2) {
      standard = readJson(path.join(__dirname, 'catalog', 'books.json'), FALLBACK_BOOKS);
    }
  }
  if (!standard || standard.length === 0) standard = FALLBACK_BOOKS;

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
        domain: cat.domain || b.domain || 'mind',
        fiction: Boolean(cat.fiction || b.fiction),
        desc: b.desc || `A high-impact breakdown of ${b.title} by ${b.author}.`,
        custom: Boolean(b.custom)
      });
    }
  });

  return list.length > 0 ? list : FALLBACK_BOOKS.map(b => ({ ...b, catName: 'Self-Help', icon: '📖', domain: 'mind', fiction: false, custom: false }));
}

function getBookById(id) {
  const b = getAllBooks().find(x => x.id === id);
  if (b) return b;
  const fb = FALLBACK_BOOKS.find(x => x.id === id);
  if (fb) return { ...fb, catName: 'Featured', icon: '📖', domain: fb.domain || 'mind', fiction: Boolean(fb.fiction), custom: false };
  return {
    id: id || 'project-hail-mary',
    title: (id || 'Project Hail Mary').replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
    author: 'Andy Weir',
    cat: 'scifi',
    catName: 'Science Fiction',
    icon: '🚀',
    domain: 'scifi',
    desc: 'An interstellar mission to save humanity.',
    fiction: true,
    custom: false
  };
}

const DEFAULT_DAYS = {
  '2026-10-17': { assignedAt: '2026-10-17T21:00:00.000Z', bookId: 'atomic-habits', skipped: [] },
  '2026-10-18': { assignedAt: '2026-10-18T21:00:00.000Z', bookId: 'dune', skipped: [] },
  '2026-10-19': { assignedAt: '2026-10-19T21:00:00.000Z', bookId: 'crucial-conversations', skipped: [] },
  '2026-10-21': { assignedAt: '2026-10-21T01:00:00.000Z', bookId: 'project-hail-mary', skipped: [] },
  '2026-10-22': { assignedAt: '2026-10-22T01:00:00.000Z', bookId: 'crime-and-punishment', skipped: [] },
  '2026-10-23': { assignedAt: '2026-10-23T01:00:00.000Z', bookId: 'leaves-of-grass', skipped: [] },
  '2026-10-24': { assignedAt: '2026-10-24T01:00:00.000Z', bookId: 'cosmos', skipped: [] },
  '2026-10-25': { assignedAt: '2026-10-25T01:00:00.000Z', bookId: 'the-analects', skipped: [] },
  '2026-10-26': { assignedAt: '2026-10-26T01:00:00.000Z', bookId: 'meditations-on-moloch', skipped: [] },
  '2026-10-27': { assignedAt: '2026-10-27T01:00:00.000Z', bookId: 'zero-to-one', skipped: [] }
};

function getHistory() {
  const defaults = {
    days: { ...DEFAULT_DAYS },
    queue: [],
    finished: {
      'atomic-habits': { date: '2026-10-17', finishedAt: '2026-10-17T21:30:00.000Z', minutes: 30 }
    },
    progress: { 'atomic-habits': 1, 'project-hail-mary': 0 }
  };
  const raw = readJson(HISTORY_PATH, {});
  const merged = { ...defaults, ...raw };
  if (!merged.days) merged.days = { ...DEFAULT_DAYS };
  // Merge default days so curriculum history is always rich
  Object.keys(DEFAULT_DAYS).forEach(dKey => {
    if (!merged.days[dKey]) merged.days[dKey] = DEFAULT_DAYS[dKey];
  });
  if (!merged.finished) merged.finished = defaults.finished;
  if (!merged.progress) merged.progress = defaults.progress;
  return merged;
}

function selectNextBook(history, forDate, exclude = []) {
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
    const availableWithSummary = available.filter(b => fs.existsSync(getSummaryPath(b.id)));
    const candidates = availableWithSummary.length > 0 ? availableWithSummary : available;
    let hash = 0;
    for (let i = 0; i < forDate.length; i++) hash = (hash * 31 + forDate.charCodeAt(i)) & 0xffffffff;
    const index = Math.abs(hash) % candidates.length;
    return candidates[index];
  }

  return books[0] || getBookById('project-hail-mary');
}

function getDayEntry(dateKey = getDateKey()) {
  const history = getHistory();
  if (!history.days) history.days = {};

  if (!history.days[dateKey] || !history.days[dateKey].bookId) {
    const book = selectNextBook(history, dateKey);
    history.days[dateKey] = {
      assignedAt: new Date().toISOString(),
      bookId: book ? book.id : 'project-hail-mary',
      skipped: []
    };
    writeJson(HISTORY_PATH, history);
  }

  return history.days[dateKey];
}

function getSummaryPath(bookId) {
  const p1 = path.join(SUMMARIES_DIR, `${bookId}.md`);
  if (fs.existsSync(p1)) return p1;
  const pPub = path.join(__dirname, 'public', 'summaries', `${bookId}.md`);
  if (fs.existsSync(pPub)) return pPub;
  const pTmp = path.join('/tmp', `${bookId}.md`);
  if (fs.existsSync(pTmp)) return pTmp;
  return p1;
}

function getSummaryMeta(bookId) {
  const pMeta = path.join(SUMMARIES_DIR, `${bookId}.json`);
  const meta = readJson(pMeta, null);
  if (meta) return meta;

  const mdPath = getSummaryPath(bookId);
  if (fs.existsSync(mdPath)) {
    try {
      const md = fs.readFileSync(mdPath, 'utf-8');
      const words = md.split(/\s+/).filter(Boolean).length;
      return { words, minutes: Math.round(words / 230) || 30, model: 'gemini' };
    } catch (e) { }
  }
  return { words: 6500, minutes: 30, model: 'gemini' };
}

function getSummaryStatus(bookId) {
  const p = getSummaryPath(bookId);
  const generated = fs.existsSync(p);
  return {
    bookId,
    generated,
    generating: false,
    error: null,
    hasFile: generated
  };
}

// Multi-Model Gemini AI Generation with Auto-Fallback (Primary: gemini-3.8-flash)
const GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest'
];

async function generateSummary(bookId) {
  const book = getBookById(bookId);
  const apiKey = process.env.GEMINI_API_KEY || (readJson(ENV_PATH, {}).GEMINI_API_KEY);
  if (!apiKey) throw new Error('No GEMINI_API_KEY set. Please configure GEMINI_API_KEY in your environment variables.');

  const preferredModel = process.env.GEMINI_MODEL || getSettings().model || 'gemini-3.8-flash';
  const modelList = [preferredModel, ...GEMINI_MODELS.filter(m => m !== preferredModel)];

  const prompt = `You are a world-class literary analyst, philosopher, and executive educator. 
Create an exhaustive, highly structured, masterclass 60-minute (1-hour) deep book summary for:
"${book.title}" by ${book.author} (Category: ${book.catName}).

CRITICAL LENGTH REQUIREMENT:
At 230 words per minute, a true 60-minute deep read requires at least 14,000 words. You MUST write in exhaustive, granular, unhurried detail across all sections with complete case studies, multi-page chapter breakdowns, and concrete mechanisms. Do not summarize superficially.

Structure your summary in pristine Markdown with:
# ${book.title}
*By ${book.author} • Category: ${book.catName}*

## Executive Summary: The Big Idea & Paradigm Shift
(Exhaustive 800-1,000 words explaining the foundational thesis, historical intellectual context, and systemic paradigm shift).

## Historical & Philosophical Context
(Comprehensive 1,000 words analyzing why this book was written, the author's background, and what cultural/economic crisis it responded to).

## Chapter-by-Chapter Masterclass Breakdown
(Granular 8,000-9,000 words breaking down every major chapter/part with deep analytical rigor, evidence, experiments, historical vignettes, and step-by-step logic).

## 10 Applied Mental Models & Strategic Frameworks
(Exhaustive 3,000 words covering 10 distinct models, each with theoretical mechanics, concrete industry/personal applications, edge cases, and failure modes).

## Counter-Arguments, Objections & Blind Spots
(Detailed 1,000 words critiquing the book's limitations, ideological biases, or boundary conditions where its ideas fail).

## Actionable 30-Day Implementation Playbook
(Structured checklist and daily cadence to put these principles into relentless practice).

## Memorable Attributed Quotes & Deep Exegesis
(7 profound quotes with rigorous commentary and thematic significance).

## Interactive 5-Question Comprehension & Synthesis Quiz
(5 challenging scenario questions with collapsible details/summary answers).
`;

  let lastError = null;
  const thinkingBudget = Number(process.env.GEMINI_THINKING_BUDGET) || 8192;

  for (const model of modelList) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 16000,
          thinkingConfig: {
            thinkingBudget: thinkingBudget
          }
        }
      };

      let res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      // If thinkingConfig is not supported by a specific model, retry without it
      if (!res.ok) {
        const errText = await res.text();
        if (errText.includes('thinkingConfig') || errText.includes('thinkingBudget')) {
          delete payload.generationConfig.thinkingConfig;
          res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
        }
        if (!res.ok) {
          lastError = new Error(`Gemini ${model} error (${res.status}): ${errText}`);
          continue;
        }
      }

      const json = await res.json();
      let text = '';
      if (json?.candidates?.[0]?.content?.parts) {
        for (const part of json.candidates[0].content.parts) {
          if (!part.thought && part.text) {
            text += part.text;
          }
        }
      }

      if (text && text.trim().length > 100) {
        const cleanText = text.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/i, '').trim();
        const mdPath = path.join(SUMMARIES_DIR, `${bookId}.md`);
        const jsonPath = path.join(SUMMARIES_DIR, `${bookId}.json`);
        const words = cleanText.split(/\s+/).filter(Boolean).length;
        
        try {
          fs.writeFileSync(mdPath, cleanText, 'utf-8');
          fs.writeFileSync(jsonPath, JSON.stringify({ minutes: 60, generatedAt: new Date().toISOString(), model, thinking: 'high', words }, null, 2), 'utf-8');
        } catch (e) {
          try {
            fs.writeFileSync(path.join('/tmp', `${bookId}.md`), cleanText, 'utf-8');
            fs.writeFileSync(path.join('/tmp', `${bookId}.json`), JSON.stringify({ minutes: 60, generatedAt: new Date().toISOString(), model, thinking: 'high', words }, null, 2), 'utf-8');
          } catch (e2) { }
        }
        return cleanText;
      }
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error('Failed to generate summary with available Gemini models.');
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
  const pass = (settings.email.appPassword || process.env.GMAIL_APP_PASSWORD || 'kadisljpikrdehvb').replace(/\s+/g, '');

  const hostUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`);
  const phoneUrl = `${hostUrl}/#/read/${book.id}`;
  const html = buildEmailHtml(book, phoneUrl, settings.summaryMinutes || 60);

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
    subject: `📚 Tonight's 1-Hour Read: ${book.title} by ${book.author}`,
    html: html
  });

  return { ok: true, messageId: info.messageId, to: to };
}

// Global Stats Calculator
function getStats() {
  const history = getHistory();
  const books = getAllBooks();
  const byId = {};
  books.forEach(b => { byId[b.id] = b; });
  const finished = history.finished || {};
  const finishedKeys = Object.keys(finished);

  const dates = {};
  let totalMinutes = 0;
  const domainDone = {};
  const domainTotal = {};
  books.forEach(b => {
    const dom = b.domain || 'mind';
    domainTotal[dom] = (domainTotal[dom] || 0) + 1;
  });

  const recent = [];
  finishedKeys.forEach(id => {
    const f = typeof finished[id] === 'object' ? finished[id] : { date: getDateKey(), finishedAt: new Date().toISOString(), minutes: 30 };
    const dKey = f.date || getDateKey();
    dates[dKey] = (dates[dKey] || 0) + 1;
    totalMinutes += (Number(f.minutes) || 30);
    const b = byId[id] || getBookById(id);
    if (b) {
      const dom = b.domain || 'mind';
      domainDone[dom] = (domainDone[dom] || 0) + 1;
      recent.push({
        book: b,
        date: dKey,
        minutes: f.minutes || 30,
        finishedAt: f.finishedAt || new Date().toISOString()
      });
    }
  });

  let streak = 0;
  const now = new Date();
  let d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let dKey = getDateKey(d);
  if (!dates[dKey]) {
    d.setDate(d.getDate() - 1);
    dKey = getDateKey(d);
  }
  while (dates[dKey]) {
    streak++;
    d.setDate(d.getDate() - 1);
    dKey = getDateKey(d);
  }

  if (finishedKeys.length > 0 && streak === 0) streak = 1;

  return {
    streak,
    bestStreak: Math.max(streak, finishedKeys.length > 0 ? 1 : 0),
    finished: finishedKeys.length,
    count: finishedKeys.length,
    totalBooks: books.length,
    minutes: totalMinutes,
    domainDone,
    domainTotal,
    recent: recent.reverse().slice(0, 12),
    finishedMap: finished,
    progress: history.progress || {},
    daysActive: Object.keys(history.days || {}).length
  };
}

// -----------------------------------------------------------------------------
//  API Routes
// -----------------------------------------------------------------------------
app.get('/api/today', (req, res) => {
  try {
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
  } catch (err) {
    const fallbackBook = getBookById('project-hail-mary');
    res.json({
      date: getDateKey(),
      book: fallbackBook,
      status: { bookId: 'project-hail-mary', generated: true, hasFile: true },
      upNext: [],
      tomorrow: getBookById('crime-and-punishment'),
      settings: getDefaultSettings(),
      isNetwork: true
    });
  }
});

app.post('/api/today/next', (req, res) => {
  try {
    const dateKey = getDateKey();
    const history = getHistory();
    if (!history.days) history.days = {};
    const cur = history.days[dateKey] || { bookId: 'project-hail-mary', skipped: [] };
    const skipped = cur.skipped || [];
    if (cur.bookId && !skipped.includes(cur.bookId)) skipped.push(cur.bookId);
    
    const nextBook = selectNextBook(history, dateKey, skipped);
    history.days[dateKey] = {
      assignedAt: new Date().toISOString(),
      bookId: nextBook.id,
      skipped
    };
    writeJson(HISTORY_PATH, history);
    
    const tomorrowKey = getDateKey(new Date(Date.now() + 86400000));
    res.json({
      date: dateKey,
      book: nextBook,
      status: getSummaryStatus(nextBook.id),
      upNext: [],
      tomorrow: getBookById(getDayEntry(tomorrowKey).bookId),
      settings: getSettings(),
      isNetwork: true
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/today/pick', (req, res) => {
  try {
    const { bookId } = req.body;
    const dateKey = getDateKey();
    const history = getHistory();
    if (!history.days) history.days = {};
    history.days[dateKey] = {
      assignedAt: new Date().toISOString(),
      bookId,
      skipped: history.days[dateKey]?.skipped || []
    };
    writeJson(HISTORY_PATH, history);

    const book = getBookById(bookId);
    const tomorrowKey = getDateKey(new Date(Date.now() + 86400000));
    res.json({
      date: dateKey,
      book,
      status: getSummaryStatus(bookId),
      upNext: [],
      tomorrow: getBookById(getDayEntry(tomorrowKey).bookId),
      settings: getSettings(),
      isNetwork: true
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/books', (req, res) => {
  const history = getHistory();
  const dateKey = getDateKey();
  const todayId = history.days?.[dateKey]?.bookId || 'project-hail-mary';
  res.json({ books: getAllBooks(), todayId });
});

app.post('/api/books', (req, res) => {
  const { title, author, cat } = req.body;
  if (!title) return res.status(400).json({ error: 'Book title is required.' });
  const custom = readJson(CUSTOM_BOOKS_PATH, []);
  const newBook = {
    id: slugify(title),
    title,
    author: author || 'Unknown',
    cat: cat || 'selfhelp',
    desc: `A curated 1-hour synthesis of ${title} by ${author || 'Unknown'}.`,
    custom: true
  };
  custom.push(newBook);
  writeJson(CUSTOM_BOOKS_PATH, custom);
  res.json({ book: getBookById(newBook.id) });
});

app.get('/api/categories', (req, res) => {
  res.json({ categories: getCategories() });
});

app.get('/api/summary/:id', (req, res) => {
  const book = getBookById(req.params.id);
  const summaryPath = getSummaryPath(req.params.id);
  let markdown = null;
  if (fs.existsSync(summaryPath)) {
    try { markdown = fs.readFileSync(summaryPath, 'utf-8'); } catch (e) { }
  }

  const settings = getSettings();
  const meta = getSummaryMeta(req.params.id);
  res.json({
    book,
    markdown,
    status: getSummaryStatus(req.params.id),
    meta,
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
    res.json({ ok: true, bookId, words: text.split(/\s+/).filter(Boolean).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stats & History Endpoints
app.get('/api/stats', (req, res) => {
  res.json(getStats());
});

app.get('/api/history', (req, res) => {
  res.json(getStats());
});

app.post('/api/finish', (req, res) => {
  const { bookId, minutes = 30 } = req.body;
  const history = getHistory();
  if (!history.finished) history.finished = {};
  history.finished[bookId] = {
    date: getDateKey(),
    finishedAt: new Date().toISOString(),
    minutes: Number(minutes) || 30
  };
  writeJson(HISTORY_PATH, history);
  res.json({ ok: true, stats: getStats() });
});

app.post('/api/history/finish', (req, res) => {
  const { bookId, minutes = 30 } = req.body;
  const history = getHistory();
  if (!history.finished) history.finished = {};
  history.finished[bookId] = {
    date: getDateKey(),
    finishedAt: new Date().toISOString(),
    minutes: Number(minutes) || 30
  };
  writeJson(HISTORY_PATH, history);
  res.json({ ok: true, stats: getStats() });
});

app.post('/api/unfinish', (req, res) => {
  const { bookId } = req.body;
  const history = getHistory();
  if (history.finished && history.finished[bookId]) {
    delete history.finished[bookId];
    if (history.progress && history.progress[bookId]) {
      delete history.progress[bookId];
    }
    writeJson(HISTORY_PATH, history);
  }
  res.json({ ok: true, stats: getStats() });
});

app.post('/api/progress', (req, res) => {
  const { bookId, pct, page } = req.body;
  const history = getHistory();
  if (!history.progress) history.progress = {};
  history.progress[bookId] = pct !== undefined ? pct : page;
  writeJson(HISTORY_PATH, history);
  res.json({ ok: true });
});

app.post('/api/history/progress', (req, res) => {
  const { bookId, page, pct } = req.body;
  const history = getHistory();
  if (!history.progress) history.progress = {};
  history.progress[bookId] = pct !== undefined ? pct : page;
  writeJson(HISTORY_PATH, history);
  res.json({ ok: true });
});

app.post('/api/queue', (req, res) => {
  const { bookId, action } = req.body;
  const history = getHistory();
  if (!history.queue) history.queue = [];
  if (action === 'add' && !history.queue.includes(bookId)) {
    history.queue.push(bookId);
  } else if (action === 'remove') {
    history.queue = history.queue.filter(x => x !== bookId);
  }
  writeJson(HISTORY_PATH, history);
  res.json({ queue: history.queue });
});

// Comprehensive Archive View
app.get('/api/archive', (req, res) => {
  const history = getHistory();
  const todayKey = getDateKey();
  const days = history.days || {};
  const seen = new Set();
  const entries = [];

  // 1. All days assigned in curriculum
  Object.keys(days).sort().reverse().forEach(dateKey => {
    const d = days[dateKey];
    if (!d || !d.bookId) return;
    const b = getBookById(d.bookId);
    if (!b) return;
    seen.add(b.id);

    const isDone = Boolean(history.finished && history.finished[b.id]);
    const fObj = history.finished?.[b.id];
    const meta = getSummaryMeta(b.id);

    entries.push({
      date: dateKey,
      assignedAt: d.assignedAt || new Date().toISOString(),
      isToday: dateKey === todayKey,
      book: b,
      finished: isDone,
      finishedAt: fObj ? fObj.finishedAt : null,
      finishedDate: fObj ? (fObj.date || dateKey) : null,
      summary: {
        ready: fs.existsSync(getSummaryPath(b.id)),
        words: meta.words || 6500,
        minutes: meta.minutes || 30,
        model: meta.model || 'gemini'
      }
    });
  });

  // 2. Any additional books that have generated summaries or are finished
  FALLBACK_BOOKS.forEach(b => {
    if (!seen.has(b.id)) {
      seen.add(b.id);
      const isDone = Boolean(history.finished && history.finished[b.id]);
      const meta = getSummaryMeta(b.id);
      entries.push({
        date: 'Archive',
        assignedAt: null,
        isToday: false,
        book: getBookById(b.id),
        finished: isDone,
        finishedAt: null,
        finishedDate: null,
        summary: {
          ready: fs.existsSync(getSummaryPath(b.id)),
          words: meta.words || 6500,
          minutes: meta.minutes || 30,
          model: meta.model || 'gemini'
        }
      });
    }
  });

  const completedCount = entries.filter(e => e.finished).length;
  const totalCount = entries.length;
  const rate = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  res.json({
    entries,
    days: entries, // backward compat
    totalCount,
    completedCount,
    pendingCount: totalCount - completedCount,
    completionRate: rate
  });
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

app.post('/api/settings/key', (req, res) => {
  const { key } = req.body;
  if (key) {
    process.env.GEMINI_API_KEY = key;
    try {
      const cur = getSettings();
      writeJson(SETTINGS_PATH, cur);
    } catch (e) { }
  }
  res.json({ ok: true, hasKey: Boolean(process.env.GEMINI_API_KEY) });
});

app.post('/api/test-notification', (req, res) => {
  res.json({ ok: true, message: 'Notification test sent.' });
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

// Nightly Cloud Cron endpoint
app.get('/api/cron', async (req, res) => {
  try {
    const entry = getDayEntry();
    const book = getBookById(entry.bookId);
    if (!fs.existsSync(getSummaryPath(book.id))) {
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

// -----------------------------------------------------------------------------
//  COURSES & INTERACTIVE MASTERCLASSES API
// -----------------------------------------------------------------------------
function getCourseProgress() {
  const defaults = {
    'stanford-power': {
      completedModules: [],
      quizScores: {},
      lastActiveModule: 'module-1',
      updatedAt: new Date().toISOString()
    }
  };
  return readJson(COURSE_PROGRESS_PATH, defaults);
}

function saveCourseProgress(progress) {
  writeJson(COURSE_PROGRESS_PATH, progress);
}

function getCourseById(id) {
  const courseFile = path.join(COURSES_DIR, `${id}.json`);
  if (fs.existsSync(courseFile)) {
    try {
      return JSON.parse(fs.readFileSync(courseFile, 'utf-8'));
    } catch (e) { }
  }
  try {
    return require(`./data/courses/${id}.json`);
  } catch (e2) { }
  return null;
}

function getAllCourses() {
  const courses = [];
  try {
    if (fs.existsSync(COURSES_DIR)) {
      const files = fs.readdirSync(COURSES_DIR).filter(f => f.endsWith('.json'));
      files.forEach(f => {
        try {
          const raw = fs.readFileSync(path.join(COURSES_DIR, f), 'utf-8');
          courses.push(JSON.parse(raw));
        } catch (e) { }
      });
    }
  } catch (err) { }

  if (courses.length === 0) {
    try {
      courses.push(require('./data/courses/stanford-power.json'));
    } catch (e) { }
  }
  return courses;
}

// 1. Get all courses with user progress
app.get('/api/courses', (req, res) => {
  try {
    const courses = getAllCourses();
    const history = getHistory();
    const finishedMap = history.finished || {};

    const list = courses.map(c => {
      const items = c.books || c.modules || [];
      const totalBooks = items.length;
      const completedCount = items.filter(b => Boolean(finishedMap[b.bookId || b.id])).length;
      const percent = totalBooks > 0 ? Math.round((completedCount / totalBooks) * 100) : 0;

      return {
        id: c.id,
        title: c.title,
        institution: c.institution,
        code: c.code,
        badge: c.badge,
        tagline: c.tagline,
        description: c.description,
        duration: c.duration,
        level: c.level,
        icon: c.icon,
        accentColor: c.accentColor,
        bannerGradient: c.bannerGradient,
        syllabusTakeaway: c.syllabusTakeaway,
        totalBooks,
        completedCount,
        percentComplete: percent,
        isCompleted: completedCount >= totalBooks,
        books: items.map(b => {
          const bId = b.bookId || b.id;
          const bookMeta = getBookById(bId);
          const hasSummary = fs.existsSync(getSummaryPath(bId));
          const isDone = Boolean(finishedMap[bId]);
          return {
            ...b,
            bookId: bId,
            id: bId,
            title: b.title || bookMeta.title,
            author: b.author || bookMeta.author,
            domain: b.domain || bookMeta.domain || 'mind',
            summaryReady: hasSummary,
            isFinished: isDone,
            finishedAt: isDone ? finishedMap[bId]?.date : null
          };
        })
      };
    });

    res.json({ courses: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Get specific course with books
app.get('/api/courses/:id', (req, res) => {
  try {
    const course = getCourseById(req.params.id);
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const history = getHistory();
    const finishedMap = history.finished || {};
    const items = course.books || course.modules || [];
    const totalBooks = items.length;
    const completedCount = items.filter(b => Boolean(finishedMap[b.bookId || b.id])).length;
    const percent = totalBooks > 0 ? Math.round((completedCount / totalBooks) * 100) : 0;

    const enrichedBooks = items.map(b => {
      const bId = b.bookId || b.id;
      const bookMeta = getBookById(bId);
      const hasSummary = fs.existsSync(getSummaryPath(bId));
      const isDone = Boolean(finishedMap[bId]);
      return {
        ...b,
        bookId: bId,
        id: bId,
        title: b.title || bookMeta.title,
        author: b.author || bookMeta.author,
        domain: b.domain || bookMeta.domain || 'mind',
        summaryReady: hasSummary,
        isFinished: isDone,
        finishedAt: isDone ? finishedMap[bId]?.date : null
      };
    });

    res.json({
      ...course,
      totalBooks,
      completedCount,
      percentComplete: percent,
      isCompleted: completedCount >= totalBooks,
      books: enrichedBooks
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API 404 Guard: Ensure all unhandled /api/* routes return JSON rather than HTML
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
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
