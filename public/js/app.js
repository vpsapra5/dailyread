/* ==========================================================================
   DAILYREAD FRONTEND APPLICATION ENGINE
   Hash router, API client, Speech Synthesis, Markdown Parser, Canvas Radar
   ========================================================================== */

(function () {
  'use strict';

  // State Store
  const state = {
    currentRoute: 'today',
    todayData: null,
    books: [],
    categories: [],
    stats: null,
    settings: null,
    activeSummaryId: null,
    activeSummaryMeta: null,
    archiveData: null,
    archiveFilter: 'all',
    archiveQuery: '',
    domainFilter: 'all',
    searchQuery: '',
    statusFilter: 'all',
    theme: localStorage.getItem('dailyread_theme') || 'dark',
    readerFont: localStorage.getItem('dailyread_font') || 'serif',
    readerSize: (function () {
      const saved = parseFloat(localStorage.getItem('dailyread_size'));
      if (!saved || saved === 1.15) {
        localStorage.setItem('dailyread_size', '1.02');
        return 1.02;
      }
      return saved;
    })(),
    readerMode: localStorage.getItem('dailyread_read_mode') || 'paged',
    currentPage: 1,
    totalPages: 1,
    pageWidth: 780,
    pageGap: 60,
    tts: {
      synth: window.speechSynthesis,
      utterance: null,
      isPlaying: false,
      speed: 1.0,
      textChunks: [],
      chunkIndex: 0
    },
    activeCourse: null,
    activeCourseModule: null,
    activeCourseId: null,
    courseProgress: null,
    quizAnswers: {},
    activeCrucible: null
  };

  // Domain Colors & Icons
  const DOMAIN_STYLES = {
    mind:        { color: '#8b5cf6', grad: 'linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%)', icon: '🧠', name: 'Mind & Habits' },
    influence:   { color: '#ec4899', grad: 'linear-gradient(135deg, #db2777 0%, #9333ea 100%)', icon: '🤝', name: 'Influence & Leadership' },
    money:       { color: '#f59e0b', grad: 'linear-gradient(135deg, #d97706 0%, #b45309 100%)', icon: '💰', name: 'Money & Business' },
    wisdom:      { color: '#10b981', grad: 'linear-gradient(135deg, #059669 0%, #047857 100%)', icon: '🏛️', name: 'Wisdom & Philosophy' },
    world:       { color: '#3b82f6', grad: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)', icon: '📜', name: 'History & Humanity' },
    science:     { color: '#06b6d4', grad: 'linear-gradient(135deg, #0891b2 0%, #0e7490 100%)', icon: '🔭', name: 'Science & Tech' },
    body:        { color: '#ef4444', grad: 'linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)', icon: '💪', name: 'Health & Longevity' },
    imagination: { color: '#a855f7', grad: 'linear-gradient(135deg, #9333ea 0%, #6366f1 100%)', icon: '🎨', name: 'Fiction & Art' }
  };

  // --------------------------------------------------------------------------
  // API Calls
  // --------------------------------------------------------------------------
  async function api(path, options = {}) {
    try {
      const res = await fetch(path, {
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...options
      });
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        throw new Error(`Unexpected non-JSON response from server`);
      }
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      return data;
    } catch (err) {
      console.error(`API Error on ${path}:`, err);
      showToast(err.message, 'error');
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // UI Helpers & Toasts
  // --------------------------------------------------------------------------
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icon = type === 'error' ? '⚠️' : type === 'success' ? '✅' : 'ℹ️';
    toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  function applyTheme(theme) {
    state.theme = theme;
    localStorage.setItem('dailyread_theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
    const icon = document.getElementById('theme-icon-moon');
    if (icon) {
      if (theme === 'paper') {
        icon.innerHTML = '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>';
      } else {
        icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
      }
    }
    // Sync Appearance Sheet Swatches
    document.querySelectorAll('.theme-swatch').forEach(sw => {
      sw.classList.toggle('active', sw.getAttribute('data-sheet-theme') === theme);
    });
  }

  // --------------------------------------------------------------------------
  // Markdown Parser
  // --------------------------------------------------------------------------
  function parseSummaryMarkdown(md) {
    if (!md) return '';
    let html = '';
    const lines = md.split(/\r?\n/);
    let inList = false;
    let listType = null;
    let inBlockquote = false;
    let bqContent = [];

    const flushList = () => {
      if (inList) {
        html += listType === 'ul' ? '</ul>\n' : '</ol>\n';
        inList = false;
        listType = null;
      }
    };

    const flushBlockquote = () => {
      if (inBlockquote) {
        html += `<blockquote>${bqContent.join('<br>')}</blockquote>\n`;
        inBlockquote = false;
        bqContent = [];
      }
    };

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      // 1. Fenced Code Block Detection: ```
      if (line.trim().startsWith('```')) {
        flushList();
        flushBlockquote();

        const codeLines = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith('```')) {
          codeLines.push(lines[i]);
          i++;
        }

        const rawCode = codeLines.join('\n');
        
        // Check if this block is an ASCII flowchart or diagram
        // Box drawing characters: ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼ │ ─ ▼ ▲ ► ◄ ═ ║ ╔ ╗ ╚ ╝ ╠ ╣ ╦ ╩ ╬ etc.
        const isBoxDiagram = /[\u2500-\u257F\u2580-\u259F│┌┐└┘├┤┬┴┼▼▲►◄═║╔╗╚╝╠╣╦╩╬→←↑↓]/.test(rawCode)
          || (/(\||\+|-{2,}|v|V)/.test(rawCode) && codeLines.length >= 3 && /\[|\]|\(|\)/.test(rawCode));

        const escaped = escapeHtml(rawCode);

        if (isBoxDiagram) {
          html += `
            <div class="reader-diagram-card">
              <div class="reader-diagram-header">
                <span class="diagram-badge">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>
                  Diagram & Habit Loop
                </span>
              </div>
              <pre class="reader-diagram-pre"><code>${escaped}</code></pre>
            </div>
          `;
        } else {
          html += `
            <div class="reader-code-card">
              <pre class="reader-code-pre"><code>${escaped}</code></pre>
            </div>
          `;
        }
        continue;
      }

      // 2. Markdown Table Detection: | col1 | col2 |
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        flushList();
        flushBlockquote();

        const tableLines = [];
        while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
          tableLines.push(lines[i].trim());
          i++;
        }
        i--; // Step back one because outer loop will increment

        if (tableLines.length >= 2) {
          html += renderMarkdownTable(tableLines);
          continue;
        }
      }

      // 3. Details / Summary blocks directly
      if (line.match(/^<details>/i)) {
        flushList();
        flushBlockquote();
        html += '<details>\n';
        continue;
      }
      if (line.match(/^<\/details>/i)) {
        flushList();
        flushBlockquote();
        html += '</details>\n';
        continue;
      }
      if (line.match(/^<summary>(.*)<\/summary>/i)) {
        const m = line.match(/^<summary>(.*)<\/summary>/i);
        html += `<summary>${formatInline(m[1])}</summary>\n`;
        continue;
      }

      // Headings
      if (line.startsWith('# ')) {
        flushList(); flushBlockquote();
        html += `<h1>${formatInline(line.substring(2))}</h1>\n`;
        continue;
      }
      if (line.startsWith('## ')) {
        flushList(); flushBlockquote();
        html += `<h2>${formatInline(line.substring(3))}</h2>\n`;
        continue;
      }
      if (line.startsWith('### ')) {
        flushList(); flushBlockquote();
        html += `<h3>${formatInline(line.substring(4))}</h3>\n`;
        continue;
      }
      if (line.startsWith('#### ')) {
        flushList(); flushBlockquote();
        html += `<h4>${formatInline(line.substring(5))}</h4>\n`;
        continue;
      }

      // Horizontal dividers
      if (line.trim() === '---' || line.trim() === '***') {
        flushList(); flushBlockquote();
        html += '<hr class="summary-divider">\n';
        continue;
      }

      // Blockquotes
      if (line.startsWith('> ')) {
        flushList();
        inBlockquote = true;
        bqContent.push(formatInline(line.substring(2)));
        continue;
      } else if (inBlockquote && line.trim() === '') {
        flushBlockquote();
        continue;
      }

      // Checklist items
      if (line.match(/^\s*-\s*\[([ xX])\]\s+(.*)/)) {
        flushBlockquote();
        if (!inList) { html += '<ul class="checklist" style="list-style:none; padding-left:0;">\n'; inList = true; listType = 'ul'; }
        const checked = line.includes('[x]') || line.includes('[X]');
        const text = line.replace(/^\s*-\s*\[([ xX])\]\s+/, '');
        html += `<li style="display:flex; align-items:flex-start; gap:0.6rem; margin-bottom:0.6rem;">
          <input type="checkbox" ${checked ? 'checked' : ''} style="margin-top:0.3rem; accent-color:var(--accent-gold);">
          <span>${formatInline(text)}</span>
        </li>\n`;
        continue;
      }

      // Unordered lists
      if (line.match(/^\s*[-*]\s+(.*)/)) {
        flushBlockquote();
        if (!inList || listType !== 'ul') { flushList(); html += '<ul>\n'; inList = true; listType = 'ul'; }
        const text = line.replace(/^\s*[-*]\s+/, '');
        html += `<li>${formatInline(text)}</li>\n`;
        continue;
      }

      // Numbered lists
      if (line.match(/^\s*\d+\.\s+(.*)/)) {
        flushBlockquote();
        if (!inList || listType !== 'ol') { flushList(); html += '<ol>\n'; inList = true; listType = 'ol'; }
        const text = line.replace(/^\s*\d+\.\s+/, '');
        html += `<li>${formatInline(text)}</li>\n`;
        continue;
      }

      // Empty lines
      if (!line.trim()) {
        flushList();
        flushBlockquote();
        continue;
      }

      // Regular Paragraph
      flushList();
      flushBlockquote();
      html += `<p>${formatInline(line)}</p>\n`;
    }

    flushList();
    flushBlockquote();
    return html;
  }

  function renderMarkdownTable(tableLines) {
    if (tableLines.length < 2) return '';

    const parseRow = (line) => {
      return line.split('|')
        .slice(1, -1)
        .map(cell => cell.trim());
    };

    const headerCells = parseRow(tableLines[0]);
    const hasSeparator = /^\s*\|?\s*[-:]+[-| :]*\|\s*$/.test(tableLines[1]);
    const startIndex = hasSeparator ? 2 : 1;

    let tableHtml = '<div class="reader-table-wrap"><table class="reader-table"><thead><tr>';
    headerCells.forEach(cell => {
      tableHtml += `<th>${formatInline(cell)}</th>`;
    });
    tableHtml += '</tr></thead><tbody>';

    for (let r = startIndex; r < tableLines.length; r++) {
      const rowCells = parseRow(tableLines[r]);
      tableHtml += '<tr>';
      rowCells.forEach(cell => {
        tableHtml += `<td>${formatInline(cell)}</td>`;
      });
      tableHtml += '</tr>';
    }

    tableHtml += '</tbody></table></div>';
    return tableHtml;
  }

  function formatInline(str) {
    if (!str) return '';

    // 1. Math formulas ($...$) and LaTeX expressions
    let formatted = str.replace(/\$([^$]+)\$/g, (match, expr) => {
      let clean = expr
        .replace(/\\approx/g, '≈')
        .replace(/\\times/g, '×')
        .replace(/\\le(q)?/g, '≤')
        .replace(/\\ge(q)?/g, '≥')
        .replace(/\\neq/g, '≠')
        .replace(/\\cdot/g, '·')
        .replace(/\\pm/g, '±')
        .replace(/\\div/g, '÷')
        .replace(/\\infty/g, '∞')
        .replace(/\\rightarrow/g, '→')
        .replace(/\\leftarrow/g, '←')
        .replace(/\^\{([^}]+)\}/g, '<sup>$1</sup>')
        .replace(/\^([0-9a-zA-Z]+)/g, '<sup>$1</sup>')
        .replace(/_\{([^}]+)\}/g, '<sub>$1</sub>')
        .replace(/_([0-9a-zA-Z]+)/g, '<sub>$1</sub>')
        .replace(/\\/g, '');
      return `<span class="reader-math-badge">${clean}</span>`;
    });

    // 2. Standalone math / LaTeX symbols outside $...$
    formatted = formatted
      .replace(/\\approx/g, '≈')
      .replace(/\\times/g, '×')
      .replace(/\\le(q)?/g, '≤')
      .replace(/\\ge(q)?/g, '≥')
      .replace(/(?<![\w<])(\d+(?:\.\d+)?)\^(\d+)/g, '$1<sup>$2</sup>');

    // 3. Standard Markdown inline elements
    return formatted
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<![\w*])\*(?!\s)([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code class="reader-inline-code">$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:var(--accent-gold); text-decoration:underline;">$1</a>');
  }

  // --------------------------------------------------------------------------
  // Book Cover Visual Builder
  // --------------------------------------------------------------------------
  function renderBookCover(book, containerEl, isLarge = false) {
    if (!containerEl || !book) return;
    const domainStyle = DOMAIN_STYLES[book.domain] || DOMAIN_STYLES.mind;
    containerEl.style.background = domainStyle.grad;
    
    // Check if OpenLibrary cover is available or load styled canvas cover
    const coverUrl = `https://covers.openlibrary.org/b/isbn/${book.id}-M.jpg?default=false`;
    
    containerEl.innerHTML = `
      <div class="book-cover-art-inner">
        <span class="cover-cat-badge" style="color:#ffffff;">${book.icon || '📖'} ${escapeHtml(book.catName || book.cat)}</span>
        <div>
          <div class="cover-book-title" style="font-size: ${isLarge ? '1.4rem' : '1rem'};">${escapeHtml(book.title)}</div>
          <div class="cover-book-author" style="font-size: ${isLarge ? '0.9rem' : '0.75rem'}; margin-top:0.25rem;">${escapeHtml(book.author)}</div>
        </div>
      </div>
    `;
  }

  // --------------------------------------------------------------------------
  // Router
  // --------------------------------------------------------------------------
  function navigateTo(route) {
    const targetHash = route.startsWith('#') ? route : `#/${route}`;
    if (window.location.hash === targetHash) {
      handleRoute();
    } else {
      window.location.hash = targetHash;
    }
  }

  function handleRoute() {
    const hash = window.location.hash || '#/today';
    const parts = hash.replace(/^#\/?/, '').split('/');
    const page = parts[0] || 'today';
    const param = parts[1] || null;
    const subParam = parts[2] || null;

    state.currentRoute = page;

    // Update active nav links (desktop + mobile)
    document.querySelectorAll('.nav-item, .mobile-nav-item').forEach(el => {
      const href = el.getAttribute('href');
      const isCourseNav = (page === 'courses' || page === 'course') && (href === '#/courses' || href === '#courses');
      el.classList.toggle('active', isCourseNav || href === `#/${page}`);
    });

    // Toggle reading-active on body to hide mobile bottom bar in reader view
    const isReadingRoute = page === 'read' || page === 'reader';
    document.body.classList.toggle('reading-active', isReadingRoute);
    if (!isReadingRoute) {
      toggleZenMode(false);
      closeAppearanceSheet();
    }

    // Update view sections
    document.querySelectorAll('.view-section').forEach(el => {
      el.classList.remove('active');
    });

    const isCoursesRoute = page === 'courses' || page === 'course';
    const activeViewId = (page === 'read' || page === 'reader') ? 'view-reader' : isCoursesRoute ? 'view-courses' : `view-${page}`;
    const activeView = document.getElementById(activeViewId);
    if (activeView) {
      activeView.classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      console.warn(`View element not found for route: ${page} (looked for #${activeViewId})`);
    }

    // View initializers
    if (page === 'today') loadTodayView();
    else if (page === 'archive') loadArchiveView();
    else if ((page === 'read' || page === 'reader') && param) loadReaderView(param);
    else if (page === 'library') loadLibraryView();
    else if (page === 'stats') loadStatsView();
    else if (page === 'settings') loadSettingsView();
    else if (page === 'courses' || page === 'course') {
      loadCoursesCatalog();
    }
  }

  // --------------------------------------------------------------------------
  // VIEW: TODAY
  // --------------------------------------------------------------------------
  async function loadTodayView() {
    try {
      const data = await api('/api/today');
      state.todayData = data;
      renderToday(data);
    } catch (e) {
      console.error('Could not load today payload', e);
    }
  }

  function renderToday(data) {
    const { book, status, upNext, tomorrow, settings } = data;
    if (!book) return;

    // Update Header Streak Badge
    updateStreakDisplay();

    // Eyebrow & Badges
    const domain = DOMAIN_STYLES[book.domain] || DOMAIN_STYLES.mind;
    const catBadge = document.getElementById('today-category-badge');
    if (catBadge) {
      catBadge.innerHTML = `${book.icon || '📖'} ${escapeHtml(book.catName)}`;
      catBadge.style.borderColor = `${domain.color}44`;
    }

    // Hero Book Details
    document.getElementById('today-book-title').textContent = book.title;
    document.getElementById('today-book-author').textContent = `by ${book.author}`;
    document.getElementById('today-domain-pill').textContent = `Domain: ${domain.name}`;
    document.getElementById('today-reminder-pill').innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>
      Daily at ${settings.notifyTime}
    `;

    // 3D Book Cover
    const coverEl = document.getElementById('today-book-cover');
    renderBookCover(book, coverEl, true);

    // Status Banner
    const banner = document.getElementById('today-status-banner');
    const bannerText = document.getElementById('status-banner-text');
    const startBtn = document.getElementById('today-start-btn');

    if (status.generating) {
      banner.className = 'status-banner generating';
      bannerText.innerHTML = `Synthesizing chapter-by-chapter summary with Gemini <span class="loading-dots"><span></span><span></span><span></span></span>`;
      startBtn.innerHTML = `Writing Summary...`;
      startBtn.disabled = true;
      // Poll every 4 seconds until done
      setTimeout(async () => {
        const check = await api(`/api/status/${book.id}`);
        if (check.generated || !check.generating) loadTodayView();
      }, 4000);
    } else if (status.generated) {
      banner.className = 'status-banner ready';
      bannerText.textContent = `Full 30-minute summary is ready for reading & listening.`;
      startBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Start 30-Min Read`;
      startBtn.disabled = false;
    } else if (status.error) {
      banner.className = 'status-banner error';
      bannerText.textContent = `AI Notice: ${status.error}`;
      startBtn.innerHTML = `Retry Generation`;
      startBtn.disabled = false;
    }

    // Up Next Queue list
    const queueList = document.getElementById('sidebar-queue-list');
    if (queueList) {
      if (upNext && upNext.length > 0) {
        queueList.innerHTML = upNext.map(b => `
          <div class="upnext-item" onclick="window.location.hash='#/read/${b.id}'">
            <div class="upnext-thumb" style="background:${(DOMAIN_STYLES[b.domain]||DOMAIN_STYLES.mind).grad};">${b.icon || '📖'}</div>
            <div class="upnext-info">
              <div class="upnext-book-title">${escapeHtml(b.title)}</div>
              <div class="upnext-book-author">${escapeHtml(b.author)}</div>
            </div>
          </div>
        `).join('');
      } else {
        queueList.innerHTML = `<p style="color: var(--text-muted); font-size: 0.85rem;">Your queue is empty. Browse the library to queue up books!</p>`;
      }
    }

    // Tomorrow's sneak peek
    if (tomorrow) {
      document.getElementById('tomorrow-thumb').textContent = tomorrow.icon || '⏳';
      document.getElementById('tomorrow-title').textContent = tomorrow.title;
      document.getElementById('tomorrow-category').textContent = tomorrow.catName;
    }
  }

  async function updateStreakDisplay() {
    try {
      const stats = await api('/api/stats');
      state.stats = stats;
      const text = document.getElementById('streak-count-text');
      if (text) text.textContent = `${stats.streak} day streak`;
    } catch (e) { }
  }

  // --------------------------------------------------------------------------
  // VIEW: READER
  // --------------------------------------------------------------------------
  async function loadReaderView(bookId) {
    state.activeSummaryId = bookId;
    const article = document.getElementById('reader-article-content');
    article.innerHTML = `
      <div style="text-align: center; padding: 4rem 1rem;">
        <div class="loading-dots" style="font-size: 1.5rem; color: var(--accent-gold); margin-bottom: 1rem;">
          <span></span><span></span><span></span>
        </div>
        <p style="color: var(--text-secondary);">Loading summary...</p>
      </div>
    `;

    try {
      const res = await api(`/api/summary/${bookId}`);
      state.activeSummaryMeta = res.meta;

      if (!res.markdown) {
        const isGenerating = res.status && res.status.generating;
        article.innerHTML = `
          <div style="text-align: center; padding: 4rem 1rem;">
            <div class="loading-dots" style="font-size: 1.5rem; color: var(--accent-gold); margin-bottom: 1rem; ${isGenerating ? '' : 'display:none;'}">
              <span></span><span></span><span></span>
            </div>
            <p style="color: var(--accent-gold); font-size: 1.25rem; font-weight:700; margin-bottom:0.75rem;">
              ${isGenerating ? 'Gemini is synthesizing this 30-min summary...' : 'Summary Not Yet Generated'}
            </p>
            <p style="color: var(--text-secondary); max-width:460px; margin: 0 auto 1.5rem; font-size:0.95rem; line-height:1.6;">
              ${isGenerating 
                ? 'Synthesizing comprehensive chapter breakdowns, mental models, and action checklists for "' + escapeHtml(res.book.title) + '". It will open automatically in ~45 seconds.'
                : 'This book is in your curriculum catalog. Tap below to generate its 30-minute synthesis using Gemini.'}
            </p>
            ${isGenerating ? '<p style="color:var(--text-muted); font-size:0.85rem;">⏳ Auto-refreshing when complete...</p>' : `<button class="btn btn-primary" onclick="window.DailyRead.triggerGenerate('${bookId}')">⚡ Generate Now (~45s)</button>`}
          </div>
        `;

        if (isGenerating) {
          setTimeout(() => {
            if (state.activeSummaryId === bookId && (state.currentRoute === 'read' || state.currentRoute === 'reader')) {
              loadReaderView(bookId);
            }
          }, 3500);
        }
        return;
      }

      // Render Markdown
      article.innerHTML = parseSummaryMarkdown(res.markdown);
      applyReaderStyles();

      // Setup speech chunks
      setupSpeechChunks(res.markdown);

      // Set book title in Kindle top & bottom bars
      const bookHeader = document.getElementById('kindle-book-header');
      if (bookHeader && res.book) bookHeader.textContent = res.book.title;
      const topTitle = document.getElementById('kindle-top-title');
      if (topTitle && res.book) topTitle.textContent = `${res.book.title} — by ${res.book.author}`;

      // Apply Reader Mode (Paged or Scroll)
      setReaderMode(state.readerMode);

      requestAnimationFrame(() => {
        recalcPagination();
        if (state.readerMode === 'paged') {
          if (res.book && res.book.progress && res.book.progress > 0) {
            const targetPage = Math.max(1, Math.round(res.book.progress * state.totalPages));
            goToKindlePage(targetPage);
          } else {
            goToKindlePage(1);
          }
        } else {
          if (res.book && res.book.progress) {
            const scrollTarget = (document.documentElement.scrollHeight - window.innerHeight) * res.book.progress;
            window.scrollTo({ top: scrollTarget, behavior: 'smooth' });
          }
        }
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(() => {
            if (state.readerMode === 'paged') recalcPagination();
          });
        }
      });
    } catch (e) {
      article.innerHTML = `<div style="text-align:center; padding:3rem; color:var(--accent-rose);">Failed to load summary: ${escapeHtml(e.message)}</div>`;
    }
  }

  function applyReaderStyles() {
    const article = document.getElementById('reader-article-content');
    if (!article) return;
    article.style.fontFamily = state.readerFont === 'serif' ? 'var(--font-serif)' : 'var(--font-sans)';
    article.style.fontSize = `${state.readerSize}rem`;

    // Sync Appearance Sheet UI
    const sizeDisplay = document.getElementById('sheet-size-display');
    if (sizeDisplay) sizeDisplay.textContent = `${Math.round(state.readerSize * 100)}%`;

    document.querySelectorAll('.stepper-dots .step-dot').forEach(dot => {
      const val = parseFloat(dot.getAttribute('data-val'));
      dot.classList.toggle('active', Math.abs(val - state.readerSize) < 0.04);
    });

    const serifBtn = document.getElementById('sheet-font-serif');
    const sansBtn = document.getElementById('sheet-font-sans');
    if (serifBtn) serifBtn.classList.toggle('active', state.readerFont === 'serif');
    if (sansBtn) sansBtn.classList.toggle('active', state.readerFont === 'sans');

    if (state.readerMode === 'paged') {
      requestAnimationFrame(() => recalcPagination());
    }
  }

  // --------------------------------------------------------------------------
  // Kindle Pagination Engine & Zen Mode
  // --------------------------------------------------------------------------
  function toggleZenMode(forceState) {
    const viewport = document.getElementById('kindle-viewport');
    if (!viewport) return;
    const isZen = typeof forceState === 'boolean' ? forceState : !viewport.classList.contains('zen-mode');
    viewport.classList.toggle('zen-mode', isZen);
  }

  function openAppearanceSheet() {
    const backdrop = document.getElementById('reader-appearance-sheet-backdrop');
    if (!backdrop) return;
    backdrop.classList.add('open');
    syncAppearanceSheetUI();
  }

  function closeAppearanceSheet() {
    const backdrop = document.getElementById('reader-appearance-sheet-backdrop');
    if (backdrop) backdrop.classList.remove('open');
  }

  function syncAppearanceSheetUI() {
    const sizeDisplay = document.getElementById('sheet-size-display');
    if (sizeDisplay) sizeDisplay.textContent = `${Math.round(state.readerSize * 100)}%`;

    document.querySelectorAll('.stepper-dots .step-dot').forEach(dot => {
      const val = parseFloat(dot.getAttribute('data-val'));
      dot.classList.toggle('active', Math.abs(val - state.readerSize) < 0.04);
    });

    const serifBtn = document.getElementById('sheet-font-serif');
    const sansBtn = document.getElementById('sheet-font-sans');
    if (serifBtn) serifBtn.classList.toggle('active', state.readerFont === 'serif');
    if (sansBtn) sansBtn.classList.toggle('active', state.readerFont === 'sans');

    document.querySelectorAll('.theme-swatch').forEach(sw => {
      sw.classList.toggle('active', sw.getAttribute('data-sheet-theme') === state.theme);
    });

    const pagedBtn = document.getElementById('sheet-mode-paged');
    const scrollBtn = document.getElementById('sheet-mode-scroll');
    if (pagedBtn) pagedBtn.classList.toggle('active', state.readerMode === 'paged');
    if (scrollBtn) scrollBtn.classList.toggle('active', state.readerMode === 'scroll');

    updateTTSBtn();
  }

  function setReaderMode(mode) {
    state.readerMode = mode;
    localStorage.setItem('dailyread_read_mode', mode);

    const readerView = document.getElementById('view-reader');
    const label = document.getElementById('reader-mode-label');
    const toggleBtn = document.getElementById('reader-mode-toggle');
    const track = document.getElementById('kindle-column-track');

    const pagedBtn = document.getElementById('sheet-mode-paged');
    const scrollBtn = document.getElementById('sheet-mode-scroll');
    if (pagedBtn) pagedBtn.classList.toggle('active', mode === 'paged');
    if (scrollBtn) scrollBtn.classList.toggle('active', mode === 'scroll');

    if (mode === 'scroll') {
      readerView.classList.remove('reader-mode-paged');
      readerView.classList.add('reader-mode-scroll');
      if (track) {
        track.style.width = 'auto';
        track.style.columnWidth = 'auto';
        track.style.columnGap = 'normal';
        track.style.transform = 'none';
      }
      if (label) label.textContent = 'Scroll Mode';
      if (toggleBtn) toggleBtn.classList.remove('active');
    } else {
      readerView.classList.remove('reader-mode-scroll');
      readerView.classList.add('reader-mode-paged');
      if (label) label.textContent = 'Paged Mode';
      if (toggleBtn) toggleBtn.classList.add('active');
      recalcPagination();
    }
  }

  function recalcPagination() {
    if (state.readerMode !== 'paged') return;

    const viewport = document.getElementById('kindle-column-viewport');
    const track = document.getElementById('kindle-column-track');
    if (!viewport || !track) return;

    const rect = viewport.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    if (w <= 0 || h <= 0) return;

    state.pageWidth = w;
    state.pageGap = (w < 600) ? 36 : 60;

    // Explicitly lock track layout width and column width to the exact page width
    track.style.width = `${w}px`;
    track.style.columnWidth = `${w}px`;
    track.style.columnGap = `${state.pageGap}px`;
    track.style.setProperty('--page-width', `${w}px`);
    track.style.setProperty('--page-gap', `${state.pageGap}px`);

    state.step = w + state.pageGap;
    const scrollW = track.scrollWidth;
    state.totalPages = Math.max(1, Math.round((scrollW + state.pageGap) / state.step));

    const scrubber = document.getElementById('kindle-page-scrubber');
    if (scrubber) {
      scrubber.min = '1';
      scrubber.max = String(state.totalPages);
    }

    goToKindlePage(Math.min(state.currentPage || 1, state.totalPages));
  }

  function goToKindlePage(pageNum) {
    state.currentPage = Math.max(1, Math.min(pageNum, state.totalPages));

    const track = document.getElementById('kindle-column-track');
    const step = state.step || (state.pageWidth + state.pageGap);
    const offset = -(state.currentPage - 1) * step;

    if (track) {
      track.style.transform = `translate3d(${offset}px, 0, 0)`;
    }

    // Update Bottom Status Bar UI
    const scrubber = document.getElementById('kindle-page-scrubber');
    if (scrubber) scrubber.value = state.currentPage;

    const indicator = document.getElementById('kindle-page-indicator');
    if (indicator) indicator.textContent = `Page ${state.currentPage} of ${state.totalPages}`;

    const pct = Math.round((state.currentPage / state.totalPages) * 100);
    const pctEl = document.getElementById('kindle-progress-pct');
    if (pctEl) pctEl.textContent = `${pct}%`;

    const timeLeftEl = document.getElementById('kindle-time-left');
    const minsRemaining = Math.max(1, Math.round(30 * (1 - (state.currentPage / state.totalPages))));
    if (timeLeftEl) timeLeftEl.textContent = `⏱️ ${minsRemaining}m left`;

    // Zen Mini Indicator
    const zenPage = document.getElementById('zen-mini-page');
    if (zenPage) zenPage.textContent = `Page ${state.currentPage} of ${state.totalPages}`;

    const zenPct = document.getElementById('zen-mini-pct');
    if (zenPct) zenPct.textContent = `${pct}%`;

    const prevBtn = document.getElementById('kindle-btn-prev');
    const nextBtn = document.getElementById('kindle-btn-next');
    if (prevBtn) prevBtn.disabled = (state.currentPage <= 1);
    if (nextBtn) nextBtn.disabled = (state.currentPage >= state.totalPages);

    // Save reading progress to backend
    if (state.activeSummaryId) {
      api('/api/progress', {
        method: 'POST',
        body: JSON.stringify({ bookId: state.activeSummaryId, pct: state.currentPage / state.totalPages })
      }).catch(() => {});
    }
  }

  function nextKindlePage() {
    if (state.currentPage < state.totalPages) {
      goToKindlePage(state.currentPage + 1);
    }
  }

  function prevKindlePage() {
    if (state.currentPage > 1) {
      goToKindlePage(state.currentPage - 1);
    }
  }

  // --------------------------------------------------------------------------
  // Speech Synthesis ("Listen Mode")
  // --------------------------------------------------------------------------
  function setupSpeechChunks(markdown) {
    // Strip code blocks, diagrams, and LaTeX formatting into clean reading sentences
    const clean = markdown
      .replace(/```[\s\S]*?```/g, '')
      .replace(/#+\s+/g, '')
      .replace(/\*\*|\*/g, '')
      .replace(/<[^>]*>/g, '')
      .replace(/- \[[ xX]\]/g, '')
      .replace(/\\approx/g, 'approximately equal to')
      .replace(/\\times/g, 'times')
      .replace(/\$([^$]+)\$/g, '$1')
      .replace(/\\/g, '');
    
    state.tts.textChunks = clean.match(/[^.!?]+[.!?]+(\s|$)/g) || [clean];
    state.tts.chunkIndex = 0;
  }

  function toggleTTS() {
    if (!state.tts.synth) {
      showToast('Speech synthesis is not supported in this browser.', 'error');
      return;
    }

    if (state.tts.isPlaying) {
      state.tts.synth.cancel();
      state.tts.isPlaying = false;
      updateTTSBtn();
      return;
    }

    speakCurrentChunk();
  }

  function speakCurrentChunk() {
    if (state.tts.chunkIndex >= state.tts.textChunks.length) {
      state.tts.isPlaying = false;
      state.tts.chunkIndex = 0;
      updateTTSBtn();
      return;
    }

    const chunkText = state.tts.textChunks[state.tts.chunkIndex];
    const utter = new SpeechSynthesisUtterance(chunkText);
    utter.rate = state.tts.speed;

    utter.onend = () => {
      state.tts.chunkIndex++;
      if (state.tts.isPlaying) speakCurrentChunk();
    };

    utter.onerror = () => {
      state.tts.isPlaying = false;
      updateTTSBtn();
    };

    state.tts.utterance = utter;
    state.tts.isPlaying = true;
    updateTTSBtn();
    state.tts.synth.speak(utter);
  }

  function updateTTSBtn() {
    const btn = document.getElementById('reader-tts-play');
    const label = document.getElementById('tts-btn-text');
    const sheetBtn = document.getElementById('sheet-tts-play');
    const sheetLabel = document.getElementById('sheet-tts-label');
    const kindleTtsBtn = document.getElementById('kindle-tts-btn');

    if (btn && label) {
      if (state.tts.isPlaying) {
        btn.classList.add('active');
        label.textContent = 'Pause';
      } else {
        btn.classList.remove('active');
        label.textContent = 'Listen';
      }
    }

    if (sheetBtn && sheetLabel) {
      if (state.tts.isPlaying) {
        sheetBtn.classList.add('btn-primary');
        sheetBtn.classList.remove('btn-secondary');
        sheetLabel.textContent = 'Pause Narration';
      } else {
        sheetBtn.classList.remove('btn-primary');
        sheetBtn.classList.add('btn-secondary');
        sheetLabel.textContent = 'Listen Aloud';
      }
    }

    if (kindleTtsBtn) {
      kindleTtsBtn.classList.toggle('active', state.tts.isPlaying);
    }
  }

  // --------------------------------------------------------------------------
  // VIEW: ARCHIVE (Past Summaries & Catch-Up)
  // --------------------------------------------------------------------------
  async function loadArchiveView() {
    const listEl = document.getElementById('archive-cards-list');
    if (listEl && !state.archiveData) {
      listEl.innerHTML = '<div class="archive-loading-state"><p>Loading summary archive...</p></div>';
    }

    try {
      const data = await api('/api/archive');
      state.archiveData = data;
      renderArchive(data);
    } catch (e) {
      console.error('Could not load archive data', e);
      if (listEl) {
        listEl.innerHTML = '<div class="archive-empty-state"><p>Could not load archive. Please try again.</p></div>';
      }
    }
  }

  function renderArchive(data) {
    if (!data) return;
    const { entries, totalCount, completedCount, pendingCount, completionRate } = data;

    // Update stats ribbon
    const totalEl = document.getElementById('archive-stat-total');
    const compEl = document.getElementById('archive-stat-completed');
    const pendEl = document.getElementById('archive-stat-pending');
    const rateEl = document.getElementById('archive-stat-rate');

    if (totalEl) totalEl.textContent = totalCount || 0;
    if (compEl) compEl.textContent = completedCount || 0;
    if (pendEl) pendEl.textContent = pendingCount || 0;
    if (rateEl) rateEl.textContent = `${completionRate || 0}%`;

    const listEl = document.getElementById('archive-cards-list');
    if (!listEl) return;

    const query = (state.archiveQuery || '').toLowerCase().trim();
    const filter = state.archiveFilter || 'all';

    const filtered = (entries || []).filter(e => {
      // Filter tab
      if (filter === 'completed' && !e.finished) return false;
      if (filter === 'unread' && e.finished) return false;

      // Search query
      if (query) {
        const title = (e.book.title || '').toLowerCase();
        const author = (e.book.author || '').toLowerCase();
        const cat = (e.book.catName || '').toLowerCase();
        if (!title.includes(query) && !author.includes(query) && !cat.includes(query)) {
          return false;
        }
      }
      return true;
    });

    if (filtered.length === 0) {
      listEl.innerHTML = `
        <div class="archive-empty-state">
          <p style="font-size:1.1rem; font-weight:600; color:var(--text-secondary); margin-bottom:0.4rem;">No matching summaries found</p>
          <p style="font-size:0.88rem; color:var(--text-muted);">Try adjusting your filter or search query.</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = filtered.map(item => {
      const b = item.book;
      const domain = DOMAIN_STYLES[b.domain] || DOMAIN_STYLES.mind;
      const isCompleted = item.finished;
      
      // Format Date
      let dayDisplay = 'Day';
      let monthDisplay = '';
      let tagDisplay = '';

      if (item.date && item.date !== 'Archive') {
        const parts = item.date.split('-');
        if (parts.length === 3) {
          const dObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
          dayDisplay = dObj.getDate();
          monthDisplay = dObj.toLocaleDateString(undefined, { month: 'short' });
          tagDisplay = item.isToday ? 'Today' : dObj.toLocaleDateString(undefined, { weekday: 'short' });
        }
      } else {
        dayDisplay = '📖';
        monthDisplay = 'Prior';
        tagDisplay = 'Library';
      }

      const words = item.summary && item.summary.words ? item.summary.words : 6500;
      const mins = item.summary && item.summary.minutes ? item.summary.minutes : 30;

      return `
        <div class="archive-item-card ${isCompleted ? 'is-completed' : 'is-pending'}" data-book-id="${b.id}">
          <div class="archive-item-left">
            <div class="archive-date-col" title="${escapeHtml(item.date)}">
              <span class="archive-date-day">${dayDisplay}</span>
              <span class="archive-date-month">${monthDisplay}</span>
              <span class="archive-date-tag">${tagDisplay}</span>
            </div>

            <div class="archive-book-cover" style="background: ${domain.grad};">
              <span>${b.icon || domain.icon}</span>
            </div>

            <div class="archive-book-details">
              <div class="archive-badges-row">
                <span class="archive-cat-chip">${b.icon || ''} ${escapeHtml(b.catName)}</span>
                <span class="archive-status-chip ${isCompleted ? 'chip-completed' : 'chip-pending'}">
                  ${isCompleted ? '✓ Completed' : '⏳ Pending Read'}
                </span>
                ${item.isToday ? '<span class="archive-status-chip" style="background:rgba(99,102,241,0.15); color:var(--accent-indigo);">⭐ Today\'s Selection</span>' : ''}
              </div>

              <h2 class="archive-book-title" title="${escapeHtml(b.title)}">${escapeHtml(b.title)}</h2>
              <p class="archive-book-author">by ${escapeHtml(b.author)}</p>

              <div class="archive-reading-meta">
                <span>⏱️ ~${mins} min read</span>
                <span>•</span>
                <span>${words.toLocaleString()} words</span>
                ${isCompleted && item.finishedDate ? `<span>• Finished on ${escapeHtml(item.finishedDate)}</span>` : ''}
              </div>
            </div>
          </div>

          <div class="archive-item-actions">
            <button class="btn btn-primary archive-read-btn" data-book-id="${b.id}" style="padding:0.5rem 1rem; font-size:0.85rem;">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>
              <span>${isCompleted ? 'Re-read' : 'Read Summary'}</span>
            </button>

            <button class="btn-complete-toggle ${isCompleted ? 'is-finished' : ''}" data-book-id="${b.id}" data-finished="${isCompleted ? 'true' : 'false'}" title="${isCompleted ? 'Click to unmark as complete' : 'Mark this book as complete'}">
              ${isCompleted ? '✓ Completed' : '○ Mark Complete'}
            </button>
          </div>
        </div>
      `;
    }).join('');

    // Attach click events to dynamic buttons
    listEl.querySelectorAll('.archive-read-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-book-id');
        if (id) navigateTo(`read/${id}`);
      });
    });

    listEl.querySelectorAll('.btn-complete-toggle').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-book-id');
        const finished = btn.getAttribute('data-finished') === 'true';
        await toggleArchiveComplete(id, finished);
      });
    });
  }

  async function toggleArchiveComplete(bookId, isCurrentlyFinished) {
    try {
      if (isCurrentlyFinished) {
        await api('/api/unfinish', { method: 'POST', body: JSON.stringify({ bookId }) });
        showToast('Book unmarked as completed.', 'info');
      } else {
        await api('/api/finish', { method: 'POST', body: JSON.stringify({ bookId, minutes: 30 }) });
        showToast('Book marked as completed! Streak compounded! 🔥', 'success');
        updateStreakDisplay();
      }
      // Refresh archive data
      const data = await api('/api/archive');
      state.archiveData = data;
      renderArchive(data);
    } catch (e) {
      showToast('Error updating book status.', 'error');
    }
  }

  // --------------------------------------------------------------------------
  // VIEW: LIBRARY
  // --------------------------------------------------------------------------
  async function loadLibraryView() {
    try {
      const data = await api('/api/books');
      state.books = data.books || [];
      renderLibraryBooks();
    } catch (e) {
      console.error('Could not load library books', e);
    }
  }

  function renderLibraryBooks() {
    const grid = document.getElementById('library-books-grid');
    if (!grid) return;

    const filtered = state.books.filter(b => {
      // Domain filter
      if (state.domainFilter !== 'all' && b.domain !== state.domainFilter) return false;
      
      // Status filter
      if (state.statusFilter === 'ready' && !b.ready) return false;
      if (state.statusFilter === 'finished' && !b.finished) return false;
      if (state.statusFilter === 'unread' && b.finished) return false;

      // Search query
      if (state.searchQuery) {
        const q = state.searchQuery.toLowerCase();
        const matchTitle = b.title.toLowerCase().includes(q);
        const matchAuthor = b.author.toLowerCase().includes(q);
        const matchCat = (b.catName || '').toLowerCase().includes(q);
        if (!matchTitle && !matchAuthor && !matchCat) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      grid.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:3rem; color:var(--text-muted);">No books match your search filters.</div>`;
      return;
    }

    grid.innerHTML = filtered.map(b => {
      const domainStyle = DOMAIN_STYLES[b.domain] || DOMAIN_STYLES.mind;
      return `
        <div class="book-card" onclick="window.location.hash='#/read/${b.id}'">
          <div class="card-top">
            <div class="card-mini-cover" style="background:${domainStyle.grad};">
              <span>${b.icon || '📖'}</span>
            </div>
            <div class="card-meta">
              <div class="card-cat-badge">${escapeHtml(b.catName)}</div>
              <h3 class="card-book-title">${escapeHtml(b.title)}</h3>
              <p class="card-book-author">${escapeHtml(b.author)}</p>
            </div>
          </div>
          <div class="card-footer">
            <span class="read-status-badge ${b.finished ? 'finished' : 'unread'}">
              ${b.finished ? '✓ Finished' : (b.ready ? '⚡ Ready' : '30-min read')}
            </span>
            <div style="display:flex; gap:0.35rem;" onclick="event.stopPropagation();">
              <button class="reader-tool-btn" title="Set as Today's book" onclick="window.DailyRead.setTodayBook('${b.id}')">
                📅 Today
              </button>
              <button class="reader-tool-btn" title="Add to Up Next Queue" onclick="window.DailyRead.toggleQueue('${b.id}')">
                ${b.queued ? '✓ Queued' : '+ Queue'}
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // --------------------------------------------------------------------------
  // VIEW: STATS & GROWTH RADAR
  // --------------------------------------------------------------------------
  async function loadStatsView() {
    try {
      const stats = await api('/api/stats');
      state.stats = stats;
      renderStats(stats);
    } catch (e) {
      console.error('Could not load stats', e);
    }
  }

  function renderStats(stats) {
    document.getElementById('stats-streak-val').textContent = stats.streak || 0;
    document.getElementById('stats-best-streak-val').textContent = stats.bestStreak || 0;
    document.getElementById('stats-finished-val').textContent = stats.finished || 0;
    document.getElementById('stats-hours-val').textContent = ((stats.minutes || 0) / 60).toFixed(1);

    // 84-day Heatmap
    const heatmap = document.getElementById('stats-heatmap-grid');
    if (heatmap) {
      heatmap.innerHTML = '';
      for (let i = 83; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toISOString().split('T')[0];
        const count = stats.activity && stats.activity[key] ? stats.activity[key] : 0;
        const cell = document.createElement('div');
        cell.className = 'heatmap-day';
        if (count >= 3) cell.setAttribute('data-level', '3');
        else if (count === 2) cell.setAttribute('data-level', '2');
        else if (count === 1) cell.setAttribute('data-level', '1');
        cell.title = `${key}: ${count} session(s)`;
        heatmap.appendChild(cell);
      }
    }

    // Recent Finished List
    const historyList = document.getElementById('stats-history-list');
    if (historyList) {
      if (stats.recent && stats.recent.length > 0) {
        historyList.innerHTML = stats.recent.map(r => `
          <div class="weight-row" style="padding:0.75rem 1rem;">
            <div>
              <strong>${escapeHtml(r.book.title)}</strong> by ${escapeHtml(r.book.author)}
              <span style="color:var(--text-muted); font-size:0.8rem; margin-left:0.5rem;">[${escapeHtml(r.book.catName)}]</span>
            </div>
            <div style="color:var(--accent-emerald); font-weight:600; font-size:0.85rem;">
              ✓ Completed (${r.date})
            </div>
          </div>
        `).join('');
      } else {
        historyList.innerHTML = `<p style="color: var(--text-muted); font-size: 0.9rem;">No finished books yet. Read today's book to start your streak!</p>`;
      }
    }

    // Render Canvas Radar Chart
    renderGrowthRadar(stats);
  }

  function renderGrowthRadar(stats) {
    const canvas = document.getElementById('growth-radar-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    const cx = width / 2;
    const cy = height / 2;
    const radius = 130;

    ctx.clearRect(0, 0, width, height);

    const domains = Object.keys(DOMAIN_STYLES);
    const totalSides = domains.length;
    const angleStep = (Math.PI * 2) / totalSides;

    // Draw background concentric web
    for (let level = 1; level <= 4; level++) {
      const r = (radius / 4) * level;
      ctx.beginPath();
      for (let i = 0; i < totalSides; i++) {
        const a = i * angleStep - Math.PI / 2;
        const x = cx + r * Math.cos(a);
        const y = cy + r * Math.sin(a);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = state.theme === 'paper' ? 'rgba(70, 55, 40, 0.12)' : 'rgba(255, 255, 255, 0.08)';
      ctx.stroke();
    }

    // Draw domain axes and labels
    domains.forEach((domKey, i) => {
      const a = i * angleStep - Math.PI / 2;
      const x = cx + radius * Math.cos(a);
      const y = cy + radius * Math.sin(a);

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.strokeStyle = state.theme === 'paper' ? 'rgba(70, 55, 40, 0.15)' : 'rgba(255, 255, 255, 0.1)';
      ctx.stroke();

      // Label
      const dom = DOMAIN_STYLES[domKey];
      const lx = cx + (radius + 28) * Math.cos(a);
      const ly = cy + (radius + 28) * Math.sin(a);
      ctx.fillStyle = dom.color;
      ctx.font = '12px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${dom.icon} ${domKey}`, lx, ly);
    });

    // Draw polygon for user progress
    ctx.beginPath();
    domains.forEach((domKey, i) => {
      const done = stats.domainDone ? (stats.domainDone[domKey] || 0) : 0;
      const total = stats.domainTotal ? (stats.domainTotal[domKey] || 1) : 1;
      const score = Math.max(0.2, Math.min(1.0, 0.2 + (done / Math.max(1, total)) * 0.8));
      const r = radius * score;
      const a = i * angleStep - Math.PI / 2;
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(245, 158, 11, 0.35)';
    ctx.fill();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // --------------------------------------------------------------------------
  // VIEW: SETTINGS
  // --------------------------------------------------------------------------
  async function loadSettingsView() {
    try {
      const [settingsData, netData] = await Promise.all([
        api('/api/settings'),
        api('/api/network').catch(() => null)
      ]);
      state.settings = settingsData.settings;
      renderSettings(settingsData);
      if (netData) renderMobileAccess(netData);
    } catch (e) {
      console.error('Could not load settings', e);
    }
  }

  function renderMobileAccess(net) {
    const urlInput = document.getElementById('mobile-url-input');
    const badge = document.getElementById('mobile-status-badge');
    const qrContainer = document.getElementById('mobile-qr-container');
    const wifiUrl = net.wifiUrl || `http://${net.localIp}:${net.port}`;

    if (urlInput) urlInput.value = wifiUrl;

    if (badge) {
      if (net.networkListening) {
        badge.textContent = '🟢 Wi-Fi Listening Active';
        badge.style.background = 'rgba(16, 185, 129, 0.15)';
        badge.style.color = 'var(--accent-emerald)';
        badge.style.borderColor = 'rgba(16, 185, 129, 0.3)';
      } else {
        badge.textContent = '📶 Local Wi-Fi Ready';
        badge.style.background = 'rgba(245, 158, 11, 0.15)';
        badge.style.color = 'var(--accent-gold)';
        badge.style.borderColor = 'rgba(245, 158, 11, 0.3)';
      }
    }

    if (qrContainer) {
      qrContainer.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=130x130&data=${encodeURIComponent(wifiUrl)}" width="124" height="124" alt="QR Code to open DailyRead on mobile" onerror="this.onerror=null; this.parentNode.innerHTML='<div style=\\'color:#111827;font-size:0.75rem;padding:8px;\\'>Scan or type:<br><strong style=\\'font-family:monospace;font-size:0.8rem;\\'>${escapeHtml(wifiUrl)}</strong></div>';" style="display:block; border-radius:6px;">`;
    }
  }

  function renderSettings(data) {
    const { settings, task, hasKey } = data;
    
    // Time & Days
    const timeInput = document.getElementById('setting-notify-time');
    if (timeInput) timeInput.value = settings.notifyTime || '07:30';

    const daysWrap = document.getElementById('settings-days-picker');
    if (daysWrap) {
      const allDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      daysWrap.innerHTML = allDays.map(d => {
        const checked = (settings.days || []).includes(d) ? 'checked' : '';
        return `
          <input type="checkbox" id="day-${d}" class="day-checkbox-input" value="${d}" ${checked}>
          <label for="day-${d}" class="day-checkbox-label">${d}</label>
        `;
      }).join('');
    }

    // Windows Task Status
    const taskStatus = document.getElementById('task-status-text');
    if (taskStatus) {
      if (task && task.registered) {
        taskStatus.innerHTML = `✓ Scheduled in Windows (${task.state || 'Ready'}). Next: ${task.nextRun ? new Date(task.nextRun).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'Active'}`;
        taskStatus.style.color = 'var(--accent-emerald)';
      } else {
        taskStatus.innerHTML = `Task not registered yet. Click Save Time to activate.`;
        taskStatus.style.color = 'var(--text-muted)';
      }
    }

    // Summaries Duration & Fiction
    const durationSelect = document.getElementById('setting-summary-minutes');
    if (durationSelect) durationSelect.value = settings.summaryMinutes || 30;

    const fictionSelect = document.getElementById('setting-fiction-ratio');
    if (fictionSelect) fictionSelect.value = settings.fictionRatio !== undefined ? settings.fictionRatio : 0.3;

    // Email Settings
    const emailData = settings.email || {};
    const emailEnabled = document.getElementById('setting-email-enabled');
    if (emailEnabled) emailEnabled.checked = emailData.enabled !== false;

    const emailTarget = document.getElementById('setting-email-target');
    if (emailTarget) emailTarget.value = emailData.targetEmail || 'vpsapra5@gmail.com';

    const emailSender = document.getElementById('setting-email-sender');
    if (emailSender) emailSender.value = emailData.senderEmail || 'vpsapra5@gmail.com';

    const emailPass = document.getElementById('setting-email-password');
    if (emailPass && emailData.appPassword) emailPass.value = emailData.appPassword;

    const emailFull = document.getElementById('setting-email-full-summary');
    if (emailFull) emailFull.checked = Boolean(emailData.includeFullSummary);

    const emailResend = document.getElementById('setting-email-resend');
    if (emailResend && emailData.resendApiKey) emailResend.value = emailData.resendApiKey;

    // Category weights
    renderCategoryWeights(settings.weights || {});
  }

  async function renderCategoryWeights(weights) {
    const grid = document.getElementById('settings-weights-grid');
    if (!grid) return;
    
    if (state.categories.length === 0) {
      const res = await api('/api/categories');
      state.categories = res.categories || [];
    }

    grid.innerHTML = state.categories.map(c => {
      const w = weights[c.id] !== undefined ? weights[c.id] : 1.0;
      return `
        <div class="weight-row">
          <span>${c.icon || '📖'} ${escapeHtml(c.name)}</span>
          <select class="weight-selector" onchange="window.DailyRead.updateWeight('${c.id}', this.value)">
            <option value="0" ${w == 0 ? 'selected' : ''}>0 (Off)</option>
            <option value="0.5" ${w == 0.5 ? 'selected' : ''}>0.5 (Less)</option>
            <option value="1.0" ${w == 1.0 ? 'selected' : ''}>1.0 (Normal)</option>
            <option value="2.0" ${w == 2.0 ? 'selected' : ''}>2.0 (More)</option>
          </select>
        </div>
      `;
    }).join('');
  }

  // --------------------------------------------------------------------------
  // VIEW: COURSES (CURATED 30-MINUTE READING SEMINARS)
  // --------------------------------------------------------------------------
  async function loadCoursesCatalog() {
    const listEl = document.getElementById('course-cards-list');
    if (listEl) {
      listEl.innerHTML = `
        <div class="courses-loading-state">
          <div class="loading-dots"><span></span><span></span><span></span></div>
          <p>Loading course curricula & summaries...</p>
        </div>
      `;
    }

    try {
      const data = await api('/api/courses');
      renderCoursesCatalog(data);
    } catch (err) {
      if (listEl) {
        listEl.innerHTML = `
          <div class="empty-state-card">
            <h3>Could not load courses</h3>
            <p>${escapeHtml(err.message || 'Server error')}</p>
            <button class="btn btn-secondary" onclick="loadCoursesCatalog()">Retry</button>
          </div>
        `;
      }
    }
  }

  function renderCoursesCatalog(data) {
    const listEl = document.getElementById('course-cards-list');
    if (!listEl) return;
    const courses = (data && data.courses) || [];
    if (courses.length === 0) {
      listEl.innerHTML = '<div class="empty-state-card"><p>No courses available at this time.</p></div>';
      return;
    }

    listEl.innerHTML = courses.map(course => {
      const books = course.books || [];
      const totalBooks = books.length || 6;
      const completedCount = books.filter(b => b.isFinished).length;
      const percent = totalBooks > 0 ? Math.round((completedCount / totalBooks) * 100) : 0;
      const isComplete = completedCount >= totalBooks;

      const booksHtml = books.map(b => {
        const domainStyle = DOMAIN_STYLES[b.domain] || DOMAIN_STYLES.mind;
        const isFinished = Boolean(b.isFinished);
        const statusBadge = isFinished 
          ? `<span class="badge-status-completed">✓ Finished</span>`
          : `<span class="badge-status-ready">📖 30-Min Summary Ready</span>`;

        return `
          <div class="course-book-row-card ${isFinished ? 'is-completed' : ''}" onclick="navigateTo('read/${b.bookId}')">
            <!-- Left: Styled Mini Cover -->
            <div class="course-book-cover-wrap" style="background: ${domainStyle.grad};">
              <span class="course-cover-icon">${domainStyle.icon || '📖'}</span>
              <div class="course-cover-info">
                <div class="course-cover-title">${escapeHtml(b.title)}</div>
                <div class="course-cover-author">${escapeHtml(b.author)}</div>
              </div>
            </div>

            <!-- Middle: Content & Framework Info -->
            <div class="course-book-details">
              <div class="course-book-header-line">
                <span class="course-topic-pill">Module ${b.number}: ${escapeHtml(b.topic)}</span>
                ${statusBadge}
              </div>
              <h3 class="course-book-title">${escapeHtml(b.title)}</h3>
              <div class="course-book-author-text">by ${escapeHtml(b.author)}</div>
              <div class="course-book-takeaway">
                <strong>Core Takeaway:</strong> ${escapeHtml(b.keyTakeaway)}
              </div>
            </div>

            <!-- Right: Action Button -->
            <div class="course-book-action">
              <button class="btn ${isFinished ? 'btn-secondary' : 'btn-primary'}" onclick="event.stopPropagation(); navigateTo('read/${b.bookId}')">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                <span>${isFinished ? 'Re-read Summary' : 'Read 30-Min Summary'}</span>
              </button>
            </div>
          </div>
        `;
      }).join('');

      return `
        <div class="course-flagship-card" style="border-top: 4px solid ${course.accentColor || '#8c1515'};">
          <div class="course-flagship-header">
            <div class="course-institution-tag">
              <span class="inst-icon">${course.icon || '🏛️'}</span>
              <span>${escapeHtml(course.institution || 'Stanford University Seminar')}</span>
              <span class="inst-code">${escapeHtml(course.code || 'STANFORD-PWR-101')}</span>
            </div>

            <h2 class="course-hero-title">${escapeHtml(course.title)}</h2>
            <div class="course-hero-tagline">${escapeHtml(course.tagline || '')}</div>
            <p class="course-hero-desc">${escapeHtml(course.description || '')}</p>

            <div class="course-meta-tags-row">
              <span class="meta-tag">⏱️ ${escapeHtml(course.duration || '6 Summaries • 30 Mins Each')}</span>
              <span class="meta-tag">🎯 ${escapeHtml(course.level || 'Advanced Strategic Theory')}</span>
              <span class="meta-tag">👥 ${escapeHtml(course.instructor || 'Stanford Political Economy Group')}</span>
              <span class="meta-tag meta-tag-highlight">📖 Full 30-Minute DailyRead Summaries</span>
            </div>
          </div>

          <!-- Progress Ribbon -->
          <div class="course-progress-ribbon">
            <div class="progress-ribbon-left">
              <div class="progress-metric-label">
                ${isComplete 
                  ? '🏆 <strong>Curriculum Completed:</strong> All 6 Summaries Finished!' 
                  : `Curriculum Progress: <strong>${completedCount} of ${totalBooks} Summaries Read (${percent}%)</strong>`
                }
              </div>
              <div class="course-main-progress-track">
                <div class="course-main-progress-fill" style="width: ${percent}%;"></div>
              </div>
            </div>
          </div>

          <!-- Course Books List -->
          <div class="course-books-list-container">
            <div class="syllabus-section-header">
              <h3 class="syllabus-section-title">Required Seminar Texts & 30-Minute Breakdowns</h3>
              <span class="syllabus-section-sub">Read any summary with Kindle-style page flipping, audio narration, and key takeaways</span>
            </div>
            <div class="course-books-stack">
              ${booksHtml}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // --------------------------------------------------------------------------
  // Event Bindings
  // --------------------------------------------------------------------------
  function setupEvents() {
    // Hash routing
    window.addEventListener('hashchange', handleRoute);

    // Theme toggle (Dark -> Paper -> Light)
    document.getElementById('theme-toggle-btn').addEventListener('click', () => {
      const nextTheme = state.theme === 'dark' ? 'paper' : state.theme === 'paper' ? 'light' : 'dark';
      applyTheme(nextTheme);
    });

    // Today Start button
    document.getElementById('today-start-btn').addEventListener('click', async () => {
      if (!state.todayData || !state.todayData.book) {
        showToast('Loading today\'s book...', 'info');
        await loadTodayView();
      }
      if (state.todayData && state.todayData.book) {
        navigateTo(`read/${state.todayData.book.id}`);
      } else {
        showToast('Please select a book first.', 'error');
      }
    });

    // Make book cover and title clickable to read
    const heroCover = document.getElementById('today-book-cover');
    const heroTitle = document.getElementById('today-book-title');
    if (heroCover) {
      heroCover.style.cursor = 'pointer';
      heroCover.addEventListener('click', () => {
        if (state.todayData && state.todayData.book) navigateTo(`read/${state.todayData.book.id}`);
      });
    }
    if (heroTitle) {
      heroTitle.style.cursor = 'pointer';
      heroTitle.addEventListener('click', () => {
        if (state.todayData && state.todayData.book) navigateTo(`read/${state.todayData.book.id}`);
      });
    }

    // Sidebar browse button
    const browseBtn = document.getElementById('sidebar-browse-btn');
    if (browseBtn) {
      browseBtn.addEventListener('click', () => navigateTo('library'));
    }

    // Today Skip / Next
    document.getElementById('today-skip-btn').addEventListener('click', async () => {
      showToast('Picking next book from curriculum...', 'info');
      try {
        const res = await api('/api/today/next', { method: 'POST' });
        state.todayData = res;
        renderToday(res);
      } catch (e) { }
    });

    // Today Pick Book Modal
    document.getElementById('today-pick-btn').addEventListener('click', openPickModal);
    document.getElementById('close-pick-modal').addEventListener('click', () => {
      document.getElementById('pick-modal').classList.remove('open');
    });

    // Regenerate button
    document.getElementById('regenerate-summary-btn').addEventListener('click', async () => {
      if (state.todayData && state.todayData.book) {
        showToast('Requesting fresh summary synthesis...', 'info');
        await api('/api/generate', { method: 'POST', body: JSON.stringify({ bookId: state.todayData.book.id, force: true }) });
        loadTodayView();
      }
    });

    // Reader Font & Size
    document.getElementById('reader-font-toggle').addEventListener('click', () => {
      state.readerFont = state.readerFont === 'serif' ? 'sans' : 'serif';
      localStorage.setItem('dailyread_font', state.readerFont);
      applyReaderStyles();
    });

    document.getElementById('reader-font-minus').addEventListener('click', () => {
      state.readerSize = Math.max(0.85, parseFloat((state.readerSize - 0.05).toFixed(2)));
      localStorage.setItem('dailyread_size', state.readerSize);
      applyReaderStyles();
    });

    document.getElementById('reader-font-plus').addEventListener('click', () => {
      state.readerSize = Math.min(1.45, parseFloat((state.readerSize + 0.05).toFixed(2)));
      localStorage.setItem('dailyread_size', state.readerSize);
      applyReaderStyles();
    });

    // Kindle Mode Toggle (Paged vs Scroll)
    const modeToggle = document.getElementById('reader-mode-toggle');
    if (modeToggle) {
      modeToggle.addEventListener('click', () => {
        const nextMode = state.readerMode === 'paged' ? 'scroll' : 'paged';
        setReaderMode(nextMode);
      });
    }

    // Kindle Turn Zones & Navigation Buttons
    const zonePrev = document.getElementById('page-zone-prev');
    const zoneNext = document.getElementById('page-zone-next');
    const btnPrev = document.getElementById('kindle-btn-prev');
    const btnNext = document.getElementById('kindle-btn-next');
    if (zonePrev) zonePrev.addEventListener('click', prevKindlePage);
    if (zoneNext) zoneNext.addEventListener('click', nextKindlePage);
    if (btnPrev) btnPrev.addEventListener('click', prevKindlePage);
    if (btnNext) btnNext.addEventListener('click', nextKindlePage);

    // Unified Kindle Top Bar Actions
    const kindleBackBtn = document.getElementById('kindle-back-btn');
    if (kindleBackBtn) {
      kindleBackBtn.addEventListener('click', () => {
        if (window.history.length > 1) {
          window.history.back();
        } else {
          navigateTo('today');
        }
      });
    }

    const topCenterZone = document.getElementById('kindle-top-center-zone');
    if (topCenterZone) {
      topCenterZone.addEventListener('click', () => toggleZenMode());
    }

    const zenMini = document.getElementById('zen-mini-indicator');
    if (zenMini) {
      zenMini.addEventListener('click', () => toggleZenMode(false));
    }

    const kindleAaBtn = document.getElementById('kindle-aa-btn');
    if (kindleAaBtn) {
      kindleAaBtn.addEventListener('click', openAppearanceSheet);
    }

    const kindleThemeBtn = document.getElementById('kindle-theme-btn');
    if (kindleThemeBtn) {
      kindleThemeBtn.addEventListener('click', () => {
        const nextTheme = state.theme === 'dark' ? 'paper' : state.theme === 'paper' ? 'light' : 'dark';
        applyTheme(nextTheme);
      });
    }

    const kindleTtsBtn = document.getElementById('kindle-tts-btn');
    if (kindleTtsBtn) {
      kindleTtsBtn.addEventListener('click', toggleTTS);
    }

    // Reading Appearance Bottom Sheet Controls
    const sheetCloseBtn = document.getElementById('sheet-close-btn');
    if (sheetCloseBtn) sheetCloseBtn.addEventListener('click', closeAppearanceSheet);

    const sheetBackdrop = document.getElementById('reader-appearance-sheet-backdrop');
    if (sheetBackdrop) {
      sheetBackdrop.addEventListener('click', (e) => {
        if (e.target === sheetBackdrop) closeAppearanceSheet();
      });
    }

    const sheetMinus = document.getElementById('sheet-size-minus');
    if (sheetMinus) {
      sheetMinus.addEventListener('click', () => {
        state.readerSize = Math.max(0.85, parseFloat((state.readerSize - 0.05).toFixed(2)));
        localStorage.setItem('dailyread_size', state.readerSize);
        applyReaderStyles();
      });
    }

    const sheetPlus = document.getElementById('sheet-size-plus');
    if (sheetPlus) {
      sheetPlus.addEventListener('click', () => {
        state.readerSize = Math.min(1.45, parseFloat((state.readerSize + 0.05).toFixed(2)));
        localStorage.setItem('dailyread_size', state.readerSize);
        applyReaderStyles();
      });
    }

    const sheetSerif = document.getElementById('sheet-font-serif');
    if (sheetSerif) {
      sheetSerif.addEventListener('click', () => {
        state.readerFont = 'serif';
        localStorage.setItem('dailyread_font', 'serif');
        applyReaderStyles();
      });
    }

    const sheetSans = document.getElementById('sheet-font-sans');
    if (sheetSans) {
      sheetSans.addEventListener('click', () => {
        state.readerFont = 'sans';
        localStorage.setItem('dailyread_font', 'sans');
        applyReaderStyles();
      });
    }

    document.querySelectorAll('.theme-swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        const th = sw.getAttribute('data-sheet-theme');
        if (th) applyTheme(th);
      });
    });

    const sheetPaged = document.getElementById('sheet-mode-paged');
    if (sheetPaged) {
      sheetPaged.addEventListener('click', () => setReaderMode('paged'));
    }

    const sheetScroll = document.getElementById('sheet-mode-scroll');
    if (sheetScroll) {
      sheetScroll.addEventListener('click', () => setReaderMode('scroll'));
    }

    const sheetTtsPlay = document.getElementById('sheet-tts-play');
    if (sheetTtsPlay) {
      sheetTtsPlay.addEventListener('click', toggleTTS);
    }

    const sheetTtsSpeed = document.getElementById('sheet-tts-speed');
    if (sheetTtsSpeed) {
      sheetTtsSpeed.addEventListener('click', () => {
        const speeds = [0.8, 1.0, 1.2, 1.5];
        const curIdx = speeds.indexOf(state.tts.speed);
        state.tts.speed = speeds[(curIdx + 1) % speeds.length];
        sheetTtsSpeed.textContent = `${state.tts.speed}x`;
        const desktopSpeed = document.getElementById('reader-tts-speed');
        if (desktopSpeed) desktopSpeed.textContent = `${state.tts.speed}x`;
        if (state.tts.isPlaying) {
          state.tts.synth.cancel();
          speakCurrentChunk();
        }
      });
    }

    // Kindle Page Scrubber Drag
    const scrubber = document.getElementById('kindle-page-scrubber');
    if (scrubber) {
      scrubber.addEventListener('input', (e) => {
        goToKindlePage(parseInt(e.target.value, 10));
      });
    }

    // Kindle Mouse Wheel Page Flipping (with 320ms cooldown throttle)
    const kindleViewport = document.getElementById('kindle-viewport');
    let lastWheelFlip = 0;
    if (kindleViewport) {
      kindleViewport.addEventListener('wheel', (e) => {
        if (state.readerMode !== 'paged') return;
        const now = Date.now();
        if (now - lastWheelFlip < 320) return;

        if (e.deltaY > 25 || e.deltaX > 25) {
          e.preventDefault();
          lastWheelFlip = now;
          nextKindlePage();
        } else if (e.deltaY < -25 || e.deltaX < -25) {
          e.preventDefault();
          lastWheelFlip = now;
          prevKindlePage();
        }
      }, { passive: false });

      // Kindle Touch & Tap Navigation (Kindle / Apple Books thumb tap zones)
      let touchStartX = 0;
      let touchStartY = 0;
      let touchStartTime = 0;

      kindleViewport.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
          touchStartX = e.touches[0].clientX;
          touchStartY = e.touches[0].clientY;
          touchStartTime = Date.now();
        }
      }, { passive: true });

      kindleViewport.addEventListener('touchend', (e) => {
        if (state.readerMode !== 'paged') return;
        if (e.changedTouches.length === 1) {
          const touch = e.changedTouches[0];
          const diffX = touch.clientX - touchStartX;
          const diffY = touch.clientY - touchStartY;
          const duration = Date.now() - touchStartTime;

          // Check for horizontal swipe gesture (> 35px)
          if (Math.abs(diffX) > 35 && Math.abs(diffX) > Math.abs(diffY)) {
            if (diffX < 0) {
              nextKindlePage();
            } else {
              prevKindlePage();
            }
            return;
          }

          // Check for thumb tap (< 350ms and moved < 15px)
          if (duration < 350 && Math.abs(diffX) < 15 && Math.abs(diffY) < 15) {
            const target = e.target;
            // Ignore taps on interactive controls
            if (target && target.closest('button, a, input, select, textarea, details, summary, .kindle-top-bar, .kindle-bottom-bar, .zen-mini-indicator, .reader-appearance-sheet')) {
              return;
            }

            const rect = kindleViewport.getBoundingClientRect();
            const relX = (touch.clientX - rect.left) / rect.width;

            if (relX < 0.25) {
              // Left 25%: Previous Page
              prevKindlePage();
            } else if (relX > 0.75) {
              // Right 25%: Next Page
              nextKindlePage();
            } else {
              // Center 50%: Toggle Zen Mode (hide/show bars)
              toggleZenMode();
            }
          }
        }
      }, { passive: true });
    }

    // Kindle Keyboard Navigation (Arrow Keys / Space / PageUp / PageDown)
    window.addEventListener('keydown', (e) => {
      if (state.currentRoute !== 'read' && state.currentRoute !== 'reader') return;
      if (state.readerMode !== 'paged') return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

      if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) {
        e.preventDefault();
        nextKindlePage();
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) {
        e.preventDefault();
        prevKindlePage();
      }
    });

    // Window Resize / Zoom handler for recalculating pagination
    window.addEventListener('resize', () => {
      if (state.currentRoute === 'read' || state.currentRoute === 'reader') {
        recalcPagination();
      }
    });

    const colViewport = document.getElementById('kindle-column-viewport');
    if (colViewport && window.ResizeObserver) {
      const ro = new ResizeObserver(() => {
        if (state.currentRoute === 'read' || state.currentRoute === 'reader') {
          recalcPagination();
        }
      });
      ro.observe(colViewport);
    }

    // Reader Back to Today (Desktop toolbar button)
    document.getElementById('reader-back-btn').addEventListener('click', () => navigateTo('today'));

    // Reader Speech TTS
    document.getElementById('reader-tts-play').addEventListener('click', toggleTTS);
    document.getElementById('reader-tts-speed').addEventListener('click', () => {
      const speeds = [0.8, 1.0, 1.2, 1.5];
      const curIdx = speeds.indexOf(state.tts.speed);
      state.tts.speed = speeds[(curIdx + 1) % speeds.length];
      document.getElementById('reader-tts-speed').textContent = `${state.tts.speed}x`;
      const sheetSpeed = document.getElementById('sheet-tts-speed');
      if (sheetSpeed) sheetSpeed.textContent = `${state.tts.speed}x`;
      if (state.tts.isPlaying) {
        state.tts.synth.cancel();
        speakCurrentChunk();
      }
    });

    // Reader Scroll Progress (Active in Scroll Mode)
    window.addEventListener('scroll', () => {
      if (state.currentRoute !== 'read' && state.currentRoute !== 'reader') return;
      if (state.readerMode === 'paged') return;
      const totalHeight = document.documentElement.scrollHeight - window.innerHeight;
      if (totalHeight <= 0) return;
      const progress = Math.min(1, Math.max(0, window.scrollY / totalHeight));
      const fill = document.getElementById('reader-progress-fill');
      if (fill) fill.style.width = `${progress * 100}%`;

      const estMins = Math.max(1, Math.round(30 * (1 - progress)));
      const timeRemaining = document.getElementById('reader-time-remaining');
      if (timeRemaining) timeRemaining.textContent = `⏱️ ${estMins} min left`;
    });

    // Reader Complete Book
    document.getElementById('reader-complete-btn').addEventListener('click', async () => {
      if (!state.activeSummaryId) return;
      try {
        await api('/api/finish', { method: 'POST', body: JSON.stringify({ bookId: state.activeSummaryId, minutes: 30 }) });
        showToast('Book marked as finished! Streak compounded! 🔥', 'success');
        updateStreakDisplay();
      } catch (e) { }
    });

    // Reader Download Markdown
    document.getElementById('reader-export-btn').addEventListener('click', () => {
      if (!state.activeSummaryId) return;
      window.open(`/api/summary/${state.activeSummaryId}.md`, '_blank');
    });

    // Archive Search & Filter
    const archiveSearch = document.getElementById('archive-search-input');
    if (archiveSearch) {
      archiveSearch.addEventListener('input', (e) => {
        state.archiveQuery = e.target.value;
        renderArchive(state.archiveData);
      });
    }

    document.querySelectorAll('.archive-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.archive-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.archiveFilter = btn.getAttribute('data-filter') || 'all';
        renderArchive(state.archiveData);
      });
    });

    // Library Domain Pills
    document.getElementById('domain-pills-container').addEventListener('click', (e) => {
      const pill = e.target.closest('.domain-pill');
      if (!pill) return;
      document.querySelectorAll('.domain-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      state.domainFilter = pill.getAttribute('data-domain');
      renderLibraryBooks();
    });

    // Library Search & Status
    document.getElementById('library-search-input').addEventListener('input', (e) => {
      state.searchQuery = e.target.value.trim();
      renderLibraryBooks();
    });

    document.getElementById('lib-status-filter').addEventListener('change', (e) => {
      state.statusFilter = e.target.value;
      renderLibraryBooks();
    });

    // Add Custom Book Modal
    document.getElementById('lib-add-custom-btn').addEventListener('click', openCustomBookModal);
    document.getElementById('close-custom-modal').addEventListener('click', () => {
      document.getElementById('custom-book-modal').classList.remove('open');
    });
    document.getElementById('cancel-custom-btn').addEventListener('click', () => {
      document.getElementById('custom-book-modal').classList.remove('open');
    });

    document.getElementById('custom-book-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = document.getElementById('custom-title-input').value.trim();
      const author = document.getElementById('custom-author-input').value.trim();
      const cat = document.getElementById('custom-cat-select').value;
      try {
        await api('/api/books', { method: 'POST', body: JSON.stringify({ title, author, cat }) });
        showToast(`Added "${title}" to your library!`, 'success');
        document.getElementById('custom-book-modal').classList.remove('open');
        loadLibraryView();
      } catch (err) { }
    });

    // Settings Schedule Form
    document.getElementById('settings-schedule-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const notifyTime = document.getElementById('setting-notify-time').value;
      const checkedDays = Array.from(document.querySelectorAll('.day-checkbox-input:checked')).map(el => el.value);
      try {
        const res = await api('/api/settings', {
          method: 'POST',
          body: JSON.stringify({ notifyTime, days: checkedDays })
        });
        showToast('Schedule updated & Windows Task registered!', 'success');
        renderSettings(res);
      } catch (err) { }
    });

    // Test Toast Notification
    document.getElementById('test-notification-btn').addEventListener('click', async () => {
      showToast('Sending Windows toast notification...', 'info');
      try {
        await api('/api/test-notification', { method: 'POST' });
      } catch (e) { }
    });

    // Settings Email Form
    const emailForm = document.getElementById('settings-email-form');
    if (emailForm) {
      emailForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const enabled = document.getElementById('setting-email-enabled').checked;
        const targetEmail = document.getElementById('setting-email-target').value.trim();
        const senderEmail = document.getElementById('setting-email-sender').value.trim();
        const appPassword = document.getElementById('setting-email-password').value.trim();
        const includeFullSummary = document.getElementById('setting-email-full-summary').checked;
        const resendApiKey = document.getElementById('setting-email-resend') ? document.getElementById('setting-email-resend').value.trim() : '';

        try {
          const res = await api('/api/settings', {
            method: 'POST',
            body: JSON.stringify({
              email: {
                enabled,
                targetEmail,
                senderEmail,
                service: resendApiKey && !appPassword ? 'resend' : 'gmail',
                appPassword,
                resendApiKey,
                includeFullSummary
              }
            })
          });
          showToast('Email preferences saved for 9:00 PM!', 'success');
          renderSettings(res);
        } catch (err) {
          showToast(err.message || 'Could not save email settings', 'error');
        }
      });
    }

    // Toggle email enabled directly
    const emailEnabledToggle = document.getElementById('setting-email-enabled');
    if (emailEnabledToggle) {
      emailEnabledToggle.addEventListener('change', async () => {
        const curEmail = (state.settings && state.settings.email) || {};
        curEmail.enabled = emailEnabledToggle.checked;
        try {
          await api('/api/settings', { method: 'POST', body: JSON.stringify({ email: curEmail }) });
          showToast(curEmail.enabled ? 'Daily 9:00 PM email enabled' : 'Daily email notifications paused', 'info');
        } catch (e) { }
      });
    }

    // Test Email Button
    const testEmailBtn = document.getElementById('test-email-btn');
    if (testEmailBtn) {
      testEmailBtn.addEventListener('click', async () => {
        const targetEmail = document.getElementById('setting-email-target').value.trim() || 'vpsapra5@gmail.com';
        const includeFullSummary = document.getElementById('setting-email-full-summary').checked;
        const statusSpan = document.getElementById('email-test-status');

        if (statusSpan) {
          statusSpan.innerHTML = 'Sending email to ' + escapeHtml(targetEmail) + '...';
          statusSpan.style.color = 'var(--text-muted)';
        }
        showToast('Connecting to mail server...', 'info');

        try {
          const res = await api('/api/test-email', {
            method: 'POST',
            body: JSON.stringify({ targetEmail, includeFullSummary })
          });
          if (res.ok) {
            showToast('✓ Test email sent! Check your inbox at ' + targetEmail, 'success');
            if (statusSpan) {
              statusSpan.innerHTML = '✓ Test email delivered! Check your inbox.';
              statusSpan.style.color = 'var(--accent-emerald)';
            }
          }
        } catch (err) {
          showToast(err.message || 'Email delivery failed', 'error');
          if (statusSpan) {
            statusSpan.innerHTML = '✕ ' + escapeHtml(err.message || 'Delivery failed');
            statusSpan.style.color = 'var(--accent-rose)';
          }
        }
      });
    }

    // Copy mobile URL button
    const copyMobileBtn = document.getElementById('copy-mobile-url-btn');
    if (copyMobileBtn) {
      copyMobileBtn.addEventListener('click', () => {
        const input = document.getElementById('mobile-url-input');
        if (input && input.value) {
          navigator.clipboard.writeText(input.value).then(() => {
            showToast('Mobile URL copied to clipboard!', 'success');
          }).catch(() => {
            input.select();
            document.execCommand('copy');
            showToast('Mobile URL copied to clipboard!', 'success');
          });
        }
      });
    }

    // API Key form
    document.getElementById('settings-key-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = document.getElementById('setting-api-key').value.trim();
      if (!key) return;
      try {
        await api('/api/settings/key', { method: 'POST', body: JSON.stringify({ key }) });
        showToast('Gemini API key updated successfully!', 'success');
        document.getElementById('setting-api-key').value = '';
      } catch (e) { }
    });

    // Summary settings change
    document.getElementById('setting-summary-minutes').addEventListener('change', async (e) => {
      await api('/api/settings', { method: 'POST', body: JSON.stringify({ summaryMinutes: parseInt(e.target.value, 10) }) });
      showToast('Summary duration preference saved.', 'info');
    });

    document.getElementById('setting-fiction-ratio').addEventListener('change', async (e) => {
      await api('/api/settings', { method: 'POST', body: JSON.stringify({ fictionRatio: parseFloat(e.target.value) }) });
      showToast('Fiction ratio preference saved.', 'info');
    });


  }

  // --------------------------------------------------------------------------
  // Modals Implementation
  // --------------------------------------------------------------------------
  async function openPickModal() {
    const modal = document.getElementById('pick-modal');
    const list = document.getElementById('modal-books-list');
    modal.classList.add('open');

    if (state.books.length === 0) {
      const data = await api('/api/books');
      state.books = data.books || [];
    }

    const renderList = (filter = '') => {
      const items = state.books.filter(b => !filter || b.title.toLowerCase().includes(filter) || b.author.toLowerCase().includes(filter));
      list.innerHTML = items.slice(0, 30).map(b => `
        <div class="weight-row" style="cursor:pointer;" onclick="window.DailyRead.selectTodayBook('${b.id}')">
          <div>
            <strong>${escapeHtml(b.title)}</strong> by ${escapeHtml(b.author)}
            <span style="color:var(--text-muted); font-size:0.75rem; margin-left:0.4rem;">[${escapeHtml(b.catName)}]</span>
          </div>
          <button class="btn btn-secondary" style="padding:0.25rem 0.6rem; font-size:0.75rem;">Pick</button>
        </div>
      `).join('');
    };

    renderList();
    document.getElementById('modal-search-input').oninput = (e) => renderList(e.target.value.toLowerCase().trim());
  }

  async function openCustomBookModal() {
    const modal = document.getElementById('custom-book-modal');
    const select = document.getElementById('custom-cat-select');
    modal.classList.add('open');

    if (state.categories.length === 0) {
      const res = await api('/api/categories');
      state.categories = res.categories || [];
    }

    select.innerHTML = state.categories.map(c => `
      <option value="${c.id}">${c.icon || '📖'} ${escapeHtml(c.name)}</option>
    `).join('');
  }

  // --------------------------------------------------------------------------
  // Global Exposure for Inline Handlers
  // --------------------------------------------------------------------------
  window.DailyRead = {
    setTodayBook: async (bookId) => {
      showToast('Setting as today\'s book...', 'info');
      await api('/api/today/pick', { method: 'POST', body: JSON.stringify({ bookId }) });
      navigateTo('today');
    },
    selectTodayBook: async (bookId) => {
      document.getElementById('pick-modal').classList.remove('open');
      await window.DailyRead.setTodayBook(bookId);
    },
    toggleQueue: async (bookId) => {
      await api('/api/queue', { method: 'POST', body: JSON.stringify({ bookId, action: 'add' }) });
      showToast('Book added to up-next queue!', 'success');
      loadLibraryView();
    },
    triggerGenerate: async (bookId) => {
      showToast('Generating summary...', 'info');
      await api('/api/generate', { method: 'POST', body: JSON.stringify({ bookId }) });
      loadReaderView(bookId);
    },
    updateWeight: async (catId, weight) => {
      const s = state.settings || {};
      const weights = s.weights || {};
      weights[catId] = parseFloat(weight);
      await api('/api/settings', { method: 'POST', body: JSON.stringify({ weights }) });
      showToast('Weight updated.', 'info');
    }
  };

  // --------------------------------------------------------------------------
  // App Bootstrapping
  // --------------------------------------------------------------------------
  function init() {
    applyTheme(state.theme);
    setupEvents();
    handleRoute();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
