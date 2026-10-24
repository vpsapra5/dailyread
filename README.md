# 📚 DailyRead — 1-Hour Daily Book Summary Platform

> **One extraordinary book every day, distilled into an exhaustive 1-hour (60-minute) masterclass.**  
> Powered by an intelligent local CLI, native Windows daily reminders, and a distraction-free editorial web application.

---

## ✨ Features at a Glance

- **Curated 217+ Book Library:** Hand-selected titles spanning **32 distinct subject categories** across 8 life-growth domains (*Mind & Habits, Influence & Leadership, Money & Business, Wisdom & Philosophy, History & Humanity, Science & Tech, Health & Longevity, Fiction & Art*).
- **True 1-Hour Depth:** Unlike superficial blurbs, each summary is an exhaustive **$\ge 13,800–14,000$ word masterclass deep dive** (~60–62 minutes at 230 wpm) following a rigorous multi-part breakdown (The Big Idea, Historical & Author Context, Granular Chapter-by-Chapter Breakdowns with spoiler guards for fiction, 10 Actionable Mental Models with Real-World Mechanics, Attributed Quotes with deep exegesis, Counterpoints & Blind Spots, 30-Day Action Playbook, Related Reading, and Interactive Comprehension Quizzes).
- **Zero-Distraction Web Reader:** Beautiful editorial typography, dark mode by default + warm paper mode toggle, reading progress indicator, time-remaining countdown, and built-in **Listen Mode (Web Speech TTS)** with adjustable playback speeds (0.8x – 1.5x).
- **Native Windows Daily Notifications:** Registered with **Windows Task Scheduler** so you get an interactive desktop toast reminder every single day at the time you set, even when your browser or app is closed. Clicking it opens today's summary immediately.
- **Smart 365-Day Rotation:** Automatically rotates domains so you never get the same category two days in a row, balances non-fiction and fiction according to your chosen ratio, respects custom category weights, and pulls from your personal Up Next queue first.
- **Visual Growth Tracking:** Real-time streak tracking, 84-day (12-week) consistency heatmap, and an interactive 8-axis **Growth Radar Wheel**.
- **CLI & Web Dual Interface:** Control everything from the terminal (`dailyread start`, `dailyread today --terminal`, `dailyread set-time`, `dailyread pick`, etc.) or through the local web dashboard.

---

## 🚀 Quick Start

### 1. Launch the App
Open PowerShell or Command Prompt in the `Book Summary App` folder:
```powershell
.\dailyread.cmd start
```
This automatically starts the local server at `http://localhost:4747` and opens your default browser.

### 2. (Optional) Install Globally to your PATH
To run `dailyread` from any folder or terminal window:
```powershell
.\dailyread.cmd install
```
Then close and reopen your terminal. You can now simply type `dailyread start` anywhere!

### 3. Set Your Daily Reminder Time
Choose when you want your desktop reminder to pop up every day:
```powershell
dailyread set-time 07:30
```
*(Supports any 24-hour time, e.g. `07:00`, `12:30`, `21:15`).*

---

## 💻 CLI Commands Reference

| Command | Description |
| :--- | :--- |
| `dailyread start` | Starts the local server and launches the web dashboard in your browser. |
| `dailyread stop` | Stops the local background server process. |
| `dailyread today` | Opens today's book summary in your browser. |
| `dailyread today --terminal` | Read today's summary directly in the command line (with paging and syntax formatting). |
| `dailyread set-time HH:mm` | Updates your daily reminder time and re-registers the Windows Task. |
| `dailyread set-days Mon,Tue,...` | Select which days of the week you want notifications. |
| `dailyread next` | Skips today's book and selects the next eligible book from the curriculum. |
| `dailyread pick "Title"` | Manually selects a specific book as today's read. |
| `dailyread queue "Title"` | Adds a book to your personal Up Next priority queue. |
| `dailyread queue` | Shows all books currently in your Up Next queue. |
| `dailyread generate` | Pre-synthesizes summaries for offline reading (`--days 7` or `--book id`). |
| `dailyread categories` | Displays all 32 categories with their current weights and book counts. |
| `dailyread weight <cat> <0\|0.5\|1\|2>` | Tunes rotation frequency (0=off, 0.5=less, 1=normal, 2=more). |
| `dailyread history` | Shows your current reading streak, total books finished, and hours read. |
| `dailyread add "Title" --author "Name" --category "Cat"` | Adds your own custom book to the library. |
| `dailyread export --format md\|pdf` | Exports a book summary to clean Markdown or standalone PDF. |
| `dailyread set-key YOUR_KEY` | Updates your Google Gemini API key. |
| `dailyread doctor` | Diagnostics tool: checks PowerShell version, data files, API key, Windows Task, and PATH. |

---

## 🏛️ The 32 Subject Categories & 8 Growth Domains

1. **Mind & Habits (🧠):** Self-Help & Habits, Productivity & Focus, Psychology & Human Behavior, Decision-Making & Mental Models, Parenting & Learning.
2. **Influence & Leadership (🤝):** Negotiation & Persuasion, Leadership & Management, Communication & Relationships, Politics & Power.
3. **Money & Business (💰):** Personal Finance & Investing, Business Strategy & Entrepreneurship, Economics & Society, Career & Work, Marketing & Sales.
4. **Wisdom & Philosophy (🏛️):** Philosophy (Stoicism, Existentialism, Classical), Spirituality & Mindfulness, Ethics & World Cultures.
5. **History & Humanity (📜):** World History, Biography & Memoir, Narrative Non-Fiction & Investigative Journalism, Travel & Adventure, Environment & Global Issues.
6. **Science & Tech (🔭):** Science & Nature, Technology & AI Futures.
7. **Health & Longevity (💪):** Health, Fitness & Longevity, Sleep & Wellness.
8. **Fiction & Art (🎨):** Classic Fiction, Modern & Literary Fiction, Science Fiction, Fantasy, Mystery & Thrillers, Poetry & Short Stories, Creativity & Art.

---

## 📖 The 1-Hour Masterclass Architecture

Every generated summary is structured into 10 cohesive sections targeting $\ge 14,000$ words (~60–62 minutes):
1. **Header & Metadata:** Title, author, original publication year, domain, and 1-line thesis.
2. **The Big Idea:** The core philosophy and foundational insight in plain, powerful language (~150 words).
3. **Author & Context:** Who wrote the book, historical context, and cultural impact (~300 words).
4. **The Chapter-by-Chapter Breakdown:** Exhaustive part-by-part examination with arguments, real research studies, and case stories (~3,500 words). For fiction, plot arcs include interactive expandable spoiler tags for the climax/ending.
5. **10 Key Ideas & Real-Life Applications:** 10 numbered principles, each paired with concrete real-world implementation advice (~1,200 words).
6. **Memorable Quotes:** Verifiable quotes with attributions.
7. **Criticisms & Counterpoints:** Fair, intellectually balanced perspectives on the book's limitations (~300 words).
8. **Apply It Today:** 3–5 actionable checklist items and reflection questions.
9. **Read Next:** 3 recommended companion books from the library.
10. **Quick Quiz:** 5 interactive questions with click-to-reveal answers.

---

## ⚙️ Architecture & Local Storage

DailyRead is completely local-first:
- **No external cloud accounts or tracking.**
- Data is stored in plain JSON and Markdown files inside `./data/`:
  - `data/books.json` & `data/custom_books.json`
  - `data/settings.json` (preferences, notification schedule, weights)
  - `data/history.json` (reading streaks, daily logs, completed books)
  - `data/summaries/<book-id>.md` (cached full summaries for instant offline reading)
- Built with pure, dependency-free native Windows PowerShell 5.1/7+ and standard HTML5/ES6.
