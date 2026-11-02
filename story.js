// The Story tab: the whole story at a glance, threads down and weeks across, kept in
// story.ink as Ink comments. A month counts as four weeks here: this board is for roughly
// when, and Plan is for the day and the hour. So a card's time is a number of weeks from
// the start of December 2007, and `end` is the first week after it.

import { Timeline, cleanWords, cleanRow, el } from "./timeline.js";
import { checkTitle, noteFile } from "./notes.js";

export const STORY = "story.ink";

const NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const FIRST_YEAR = 2007;
const FIRST_MONTH = 11; // December
const MONTH_COUNT = 33; // to August 2010, the college intake
const yearOf = i => FIRST_YEAR + Math.floor((FIRST_MONTH + i) / 12);
const nameOf = i => NAMES[(FIRST_MONTH + i) % 12];
const capital = word => word[0].toUpperCase() + word.slice(1);
const MONTHS = Array.from({ length: MONTH_COUNT }, (_, i) => `${nameOf(i)}${String(yearOf(i)).slice(2)}`);
const labelOfMonth = i => `${capital(nameOf(i))} ${yearOf(i)}`;
// The board's ticks name the year only where it starts.
const MONTH_LABELS = MONTHS.map((_, i) => (i === 0 || nameOf(i) === "jan" ? labelOfMonth(i) : capital(nameOf(i))));
// The first board ran December to June with no year in its names. Files from then still read.
const OLD_NAMES = ["dec", "jan", "feb", "mar", "apr", "may", "jun"];
const monthIndex = name => {
  const lower = name.toLowerCase();
  const old = OLD_NAMES.indexOf(lower);
  return old >= 0 ? old : MONTHS.indexOf(lower);
};
const WEEKS_A_MONTH = 4;
const WEEKS = MONTHS.length * WEEKS_A_MONTH;
const WEEK_WIDTH = 46; // CSS pixels
const MAX_DAY = 1000; // the story runs about 960 days

// A new file starts from what's already settled (the skeleton's dates). They're lines of
// the file, so they can be changed or removed by hand.
const NEW_FILE = `// The whole story. The Story tab reads and writes this file; Ink ignores it.
// A month is four weeks here, so "jan08 3" is January 2008's third week.
// mark mar08 | results
// mark may08-jun08 | intake letter
`;

const MONTH = `(${[...MONTHS, ...OLD_NAMES].join("|")})`;
const THREADS = /^\/\/\s*threads:(.*)$/i;
const CARD = new RegExp(`^//\\s*${MONTH}\\b.*\\|`, "i");
const WHEN = new RegExp(`^${MONTH}\\s+([1-4])(?:\\s*-\\s*${MONTH}\\s+([1-4]))?$`, "i");
const MARK = new RegExp(`^//\\s*mark\\s+${MONTH}(?:\\s*-\\s*${MONTH})?\\s*\\|\\s*(.+)$`, "i");
const MARK_LIKE = /^\/\/\s*mark\b/i;
const NOTE_LINK = /^note:\s*(.+)$/i;
const DAY_LINK = /^day:\s*(\d+)$/i;

const weekOf = (month, week) => monthIndex(month) * WEEKS_A_MONTH + (+week - 1);
const nameOfWeek = w => `${MONTHS[Math.floor(w / WEEKS_A_MONTH)]} ${w % WEEKS_A_MONTH + 1}`;

function parseCard(line) {
  const parts = line.replace(/^\/\/\s*/, "").split("|").map(p => p.trim());
  if (parts.length < 3) return null;
  const when = parts[0].match(WHEN);
  if (!when || !parts[1]) return null;
  const start = weekOf(when[1], when[2]);
  const end = (when[3] ? weekOf(when[3], when[4]) : start) + 1;
  if (end <= start) return null;
  let note = "";
  let day = 0;
  const rest = parts.slice(2);
  // Links are the last fields, so words holding a | stay words.
  for (let i = rest.length - 1; i > 0; i--) {
    const n = rest[i].match(NOTE_LINK);
    const d = rest[i].match(DAY_LINK);
    if (n && !note) note = n[1];
    else if (d && !day) day = +d[1];
    else break;
    rest.pop();
  }
  return { start, end, row: parts[1], words: rest.join(" | "), note, day };
}

function cardLine(c) {
  const last = c.end - 1;
  const when = last === c.start ? nameOfWeek(c.start) : `${nameOfWeek(c.start)} - ${nameOfWeek(last)}`;
  const links = `${c.note ? ` | note: ${c.note}` : ""}${c.day ? ` | day: ${c.day}` : ""}`;
  return `// ${when} | ${c.row} | ${c.words}${links}`.trimEnd();
}

export function parseStory(text) {
  const plan = { lines: [], rows: [], cards: [], marks: [], unread: [] };
  const fileLines = (text || NEW_FILE).split("\n");
  if (fileLines.at(-1) === "") fileLines.pop();
  let listed = false;
  fileLines.forEach((rawLine, i) => {
    const raw = rawLine.replace(/\r$/, "");
    const line = raw.trim();
    const threads = line.match(THREADS);
    const unread = () => plan.unread.push({ line: i + 1, text: line });
    if (threads && !listed) {
      listed = true;
      plan.rows = [...new Set(threads[1].split(",").map(p => p.trim()).filter(Boolean))];
      plan.lines.push({ threads: true });
    } else if (MARK_LIKE.test(line)) {
      const m = line.match(MARK);
      const first = m && monthIndex(m[1]);
      const last = m && monthIndex(m[2] ?? m[1]);
      if (m && first <= last) plan.marks.push({ start: first * WEEKS_A_MONTH, end: (last + 1) * WEEKS_A_MONTH, label: m[3].trim() });
      else unread();
      plan.lines.push({ raw });
    } else if (CARD.test(line)) {
      const card = parseCard(line);
      if (card) { plan.cards.push(card); plan.lines.push({ card }); }
      else { unread(); plan.lines.push({ raw }); }
    } else {
      if (line && !line.startsWith("//")) unread();
      plan.lines.push({ raw });
    }
  });
  for (const c of plan.cards) if (!plan.rows.includes(c.row)) plan.rows.push(c.row);
  return plan;
}

export function storyText(plan) {
  const out = [];
  const threads = `// threads: ${plan.rows.join(", ")}`;
  if (!plan.lines.some(l => l.threads)) out.push(threads);
  for (const l of plan.lines) {
    if (l.threads) out.push(threads);
    else if (l.card) out.push(cardLine(l.card));
    else out.push(l.raw);
  }
  while (out.length > 1 && out.at(-1) === "") out.pop();
  return out.join("\n") + "\n";
}

function fillWhen(monthId, weekId, week) {
  const $ = id => document.getElementById(id);
  $(monthId).replaceChildren(...MONTHS.map((m, i) => new Option(labelOfMonth(i), i)));
  $(weekId).replaceChildren(...[1, 2, 3, 4].map(w => new Option(`Week ${w}`, w - 1)));
  $(monthId).value = Math.floor(week / WEEKS_A_MONTH);
  $(weekId).value = week % WEEKS_A_MONTH;
}

export class Story extends Timeline {
  // Beyond Timeline's options: hasNote(title), openNote(title), makeNote(title),
  // noteNames(), the Notes side; openDay(n), Plan's; view and onView(view), which view
  // shows, kept by the caller.
  constructor(options) {
    super(options, {
      scroller: "story-board", empty: "story-empty", undo: "story-undo", addRow: "story-add-thread",
      addCard: "story-add-card", unread: "story-unread", unreadText: "story-unread-text", unreadGo: "story-unread-go",
    });
    this.view = options.view === "outline" ? "outline" : "board";
    const $ = this.$;
    $("story-view-board").onclick = () => this.setView("board");
    $("story-view-outline").onclick = () => this.setView("outline");
    $("story-card-cancel").onclick = () => $("story-card-dialog").close();
    $("story-card-delete").onclick = () => this.deleteEditing($("story-card-dialog"));
    $("story-card-note-go").onclick = () => this.goToNote();
    $("story-card-day-go").onclick = () => this.goToDay();
    $("story-card-note").addEventListener("input", () => this.showLinkButtons());
    $("story-card-day").addEventListener("input", () => this.showLinkButtons());
    $("story-card-form").addEventListener("submit", e => {
      e.preventDefault();
      if (this.saveCard()) $("story-card-dialog").close();
    });
    for (const name of options.starters) {
      const b = el("button", "", name);
      b.onclick = () => {
        this.plan.rows.push(name);
        this.commit();
      };
      $("story-starters").append(b);
    }
  }

  parse(text) { return parseStory(text); }
  serialise(plan) { return storyText(plan); }
  defaultStart() { return 0; }
  boardShowing() { return this.view === "board"; }

  setView(view) {
    this.view = view;
    this.o.onView?.(view);
    this.render();
  }

  axis() {
    return {
      from: 0, to: WEEKS, unit: WEEK_WIDTH, step: 1, major: WEEKS_A_MONTH, minor: 1,
      ticks: MONTH_LABELS, marks: this.plan.marks,
    };
  }

  cardsIn(row) { return this.plan.cards.filter(c => c.row === row); }
  noteMissing(c) { return c.note && !this.o.hasNote(c.note); }
  cardClass(c) { return `story${this.noteMissing(c) ? " missing" : ""}`; }

  cardWords(c) {
    return `${this.noteMissing(c) ? "⚠ " : ""}${c.words || c.note || "(no words yet)"}`;
  }

  timeText(start, end) {
    const name = w => `${labelOfMonth(Math.floor(w / WEEKS_A_MONTH))} week ${w % WEEKS_A_MONTH + 1}`;
    return end - start === 1 ? name(start) : `${name(start)} to ${name(end - 1)}`;
  }

  cardTitle(c) {
    const links = [
      c.note && (this.noteMissing(c) ? `no page called ${c.note}` : `page: ${c.note}`),
      c.day && `day ${c.day}`,
    ].filter(Boolean).join(", ");
    return `${this.timeText(c.start, c.end)}: ${c.words || "(no words yet)"}${links ? ` (${links})` : ""}`;
  }

  render() {
    const $ = this.$;
    $("story-view-board").classList.toggle("active", this.view === "board");
    $("story-view-outline").classList.toggle("active", this.view === "outline");
    super.render();
    const outline = this.view === "outline" && this.plan.rows.length > 0;
    $("story-outline").hidden = !outline;
    if (outline) this.renderOutline();
  }

  // The same cards as a list in time order, under the month each one starts in.
  renderOutline() {
    const box = this.$("story-outline");
    const cards = [...this.plan.cards].sort((a, b) => a.start - b.start || a.end - b.end);
    const parts = [];
    let month = -1;
    for (const c of cards) {
      const m = Math.floor(c.start / WEEKS_A_MONTH);
      if (m !== month) {
        month = m;
        const marks = this.plan.marks.filter(k => k.start <= m * WEEKS_A_MONTH && m * WEEKS_A_MONTH < k.end).map(k => k.label);
        parts.push(el("h3", "", labelOfMonth(m) + (marks.length ? ` · ${marks.join(", ")}` : "")));
      }
      const row = el("button", `outline-card${this.noteMissing(c) ? " missing" : ""}`);
      row.append(el("span", "outline-words", this.cardWords(c)));
      const place = [c.row, this.timeText(c.start, c.end), c.note && !this.noteMissing(c) && `page: ${c.note}`, c.day && `day ${c.day}`];
      row.append(el("span", "outline-place", place.filter(Boolean).join(" · ")));
      row.onclick = () => this.openCard(c);
      parts.push(row);
    }
    if (!cards.length) parts.push(el("p", "muted", "No cards yet. Add one with + Card."));
    box.replaceChildren(...parts);
  }

  /* ---------- The card's fields ---------- */

  openCard(card, fresh) {
    this.editing = card;
    const c = card ?? { start: fresh.start, end: Math.min(WEEKS, fresh.start + WEEKS_A_MONTH), row: fresh.row, words: "", note: "", day: 0 };
    const $ = this.$;
    $("story-card-title").textContent = card ? `${c.row}, ${this.timeText(c.start, c.end)}` : "A new card";
    $("story-card-words").value = c.words;
    $("story-card-thread").value = c.row;
    $("story-card-threads").replaceChildren(...this.plan.rows.map(p => new Option(p, p)));
    fillWhen("story-card-from-month", "story-card-from-week", c.start);
    fillWhen("story-card-to-month", "story-card-to-week", c.end - 1);
    $("story-card-note").value = c.note;
    $("story-card-notes").replaceChildren(...this.o.noteNames().map(n => new Option(n, n)));
    $("story-card-day").value = c.day || "";
    $("story-card-delete").hidden = !card;
    $("story-card-message").textContent = "";
    this.showLinkButtons();
    $("story-card-dialog").showModal();
    if (!card) $("story-card-words").focus();
  }

  showLinkButtons() {
    const note = this.$("story-card-note").value.trim();
    const day = this.$("story-card-day").value.trim();
    this.$("story-card-note-go").textContent = note && this.o.hasNote(note) ? "Open page" : "Make a page";
    this.$("story-card-day-go").textContent = day ? `Open day ${day}` : "Plan a day";
  }

  say(text) {
    this.$("story-card-message").textContent = text;
    return false;
  }

  saveCard() {
    const $ = this.$;
    const row = cleanRow($("story-card-thread").value);
    const when = (m, w) => +$(m).value * WEEKS_A_MONTH + +$(w).value;
    const start = when("story-card-from-month", "story-card-from-week");
    const end = when("story-card-to-month", "story-card-to-week") + 1;
    // A | at the end of the words could read back as a link.
    const words = cleanWords($("story-card-words").value).replace(/\|/g, "/");
    const note = cleanWords($("story-card-note").value);
    const dayText = $("story-card-day").value.trim();
    const day = dayText ? +dayText : 0;
    if (!row) return this.say("Which thread is it on?");
    if (start >= end) return this.say("It has to end no earlier than it starts.");
    if (note && /\|/.test(note)) return this.say("A page's title can't hold a |.");
    if (dayText && (!Number.isInteger(day) || day < 1 || day > MAX_DAY)) return this.say(`A day runs from 1 to ${MAX_DAY}.`);
    const fields = { row, start, end, words, note, day };
    if (this.editing) Object.assign(this.editing, fields);
    else {
      this.plan.cards.push(fields);
      this.plan.lines.push({ card: fields });
    }
    if (!this.plan.rows.includes(row)) this.plan.rows.push(row);
    this.commit();
    return true;
  }

  goToNote() {
    const $ = this.$;
    const typed = cleanWords($("story-card-note").value);
    const words = cleanWords($("story-card-words").value);
    // A title taken from the card's words loses what a title can't hold, such as a "?".
    const title = typed || cleanWords(words.replace(/[\/\\:*?"<>|]/g, " ")).replace(/^\.+\s*/, "");
    if (!title) { this.say("Give the card some words, or name a page."); return; }
    if (!this.o.hasNote(title)) {
      const { problem } = checkTitle(title, this.o.noteNames().map(noteFile));
      if (problem) { this.say(problem); return; }
    }
    $("story-card-note").value = title;
    if (!this.saveCard()) return;
    $("story-card-dialog").close();
    if (this.o.hasNote(title)) this.o.openNote(title);
    else this.o.makeNote(title);
  }

  goToDay() {
    const $ = this.$;
    if (!$("story-card-day").value.trim()) $("story-card-day").value = this.o.nextDay();
    if (!this.saveCard()) return;
    const day = +$("story-card-day").value;
    $("story-card-dialog").close();
    this.o.openDay(day);
  }
}
