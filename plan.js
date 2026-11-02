// The Plan tab: one day's board, places down and hours across, kept in plan.ink.
// The file is nothing but Ink comments, so the compiler never sees a card and an
// unwritten scene can't be an error. A line the board doesn't understand is kept as it
// is, because the file can be edited by hand too. Hours are decimal: 8.5 is 8:30.

import { Timeline, cleanWords, cleanRow, el } from "./timeline.js";

export const PLAN = "plan.ink";

const HEADER = "// The plan. The Plan tab reads and writes this file; Ink ignores it.";
const PLACES = /^\/\/\s*places:(.*)$/i;
const CARD = /^\/\/\s*days?\b.*\|/i;
const DAYS = /^days?\s+(\d+)(?:\s*-\s*(\d+))?$/i;
const HOURS = /^(\d{1,2})(?::(\d\d))?\s*-\s*(\d{1,2})(?::(\d\d))?$/;
const LINK = /\s*->\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*$/;
export const SCENE_NAME = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)?$/;

const MAX_DAY = 1000; // the story runs about 960 days
const FIRST_HOUR = 6; // the board starts here unless a card starts earlier
const HOUR_WIDTH = 72; // CSS pixels
const STEP = 0.5; // hours: what a drag snaps to

export function fmtHour(h) {
  const whole = Math.floor(h);
  const minutes = Math.round((h - whole) * 60);
  return minutes ? `${whole}:${String(minutes).padStart(2, "0")}` : `${whole}`;
}

function parseCard(text) {
  const parts = text.replace(/^\/\/\s*/, "").split("|");
  if (parts.length < 5) return null;
  const words = parts.slice(4).join("|").trim();
  const days = parts[0].trim().match(DAYS);
  const hours = parts[1].trim().match(HOURS);
  const row = parts[2].trim();
  const kind = parts[3].trim().toLowerCase();
  if (!days || !hours || !row || (kind !== "once" && kind !== "open")) return null;
  const from = +days[1];
  const to = days[2] ? +days[2] : from;
  const start = +hours[1] + (+hours[2] || 0) / 60;
  const end = +hours[3] + (+hours[4] || 0) / 60;
  if (+hours[2] > 59 || +hours[4] > 59) return null;
  if (from < 1 || to < from || to > MAX_DAY || end > 24 || start >= end) return null;
  const link = words.match(LINK);
  return {
    from, to, start, end, row, kind,
    words: link ? words.slice(0, link.index).trim() : words,
    scene: link ? link[1] : "",
  };
}

function cardLine(c) {
  const days = c.from === c.to ? `day ${c.from}` : `days ${c.from}-${c.to}`;
  const link = c.scene ? `${c.words ? " " : ""}-> ${c.scene}` : "";
  return `// ${days} | ${fmtHour(c.start)}-${fmtHour(c.end)} | ${c.row} | ${c.kind} | ${c.words}${link}`.trimEnd();
}

// lines: each line of the file in order, as { raw }, { card } or { places: true }.
// rows: the places, those listed first, then any a card names that the list doesn't.
// unread: lines that look meant for the board, or aren't comments, and can't be used.
export function parsePlan(text) {
  const plan = { lines: [], rows: [], cards: [], unread: [] };
  let listed = false;
  const fileLines = (text || "").split("\n");
  if (fileLines.at(-1) === "") fileLines.pop(); // the final newline ends the last line; it isn't a blank one
  fileLines.forEach((rawLine, i) => {
    const raw = rawLine.replace(/\r$/, "");
    const line = raw.trim();
    const places = line.match(PLACES);
    if (places && !listed) {
      listed = true;
      plan.rows = [...new Set(places[1].split(",").map(p => p.trim()).filter(Boolean))];
      plan.lines.push({ places: true });
    } else if (CARD.test(line)) {
      const card = parseCard(line);
      if (card) { plan.cards.push(card); plan.lines.push({ card }); }
      else { plan.unread.push({ line: i + 1, text: line }); plan.lines.push({ raw }); }
    } else {
      if (line && !line.startsWith("//")) plan.unread.push({ line: i + 1, text: line });
      plan.lines.push({ raw });
    }
  });
  for (const c of plan.cards) if (!plan.rows.includes(c.row)) plan.rows.push(c.row);
  return plan;
}

export function planText(plan) {
  const out = [];
  const hasPlaces = plan.lines.some(l => l.places);
  if (!plan.lines.some(l => l.raw?.trim())) out.push(HEADER);
  if (!hasPlaces) out.push(`// places: ${plan.rows.join(", ")}`);
  for (const l of plan.lines) {
    if (l.places) out.push(`// places: ${plan.rows.join(", ")}`);
    else if (l.card) out.push(cardLine(l.card));
    else out.push(l.raw);
  }
  while (out.length > 1 && out.at(-1) === "") out.pop();
  return out.join("\n") + "\n";
}

// A scene name made from the card's words: "the drawer" -> the_drawer, the_drawer_2.
export function sceneNameFrom(words, taken) {
  const base = words.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32).replace(/_+$/, "");
  const name = /^[a-z_]/.test(base) ? base : `scene${base ? `_${base}` : ""}`;
  let tried = name;
  for (let n = 2; taken(tried); n++) tried = `${name}_${n}`;
  return tried;
}

const halfHours = () => Array.from({ length: 49 }, (_, i) => i / 2);

export class Board extends Timeline {
  // Beyond Timeline's options: scenes(), names to link to; hasScene(name), nameTaken(name),
  // openScene(name), writeScene(name, words), the script's side; day and onDay(day), the
  // day showing, kept by the caller.
  constructor(options) {
    super(options, {
      scroller: "plan-board", empty: "plan-empty", undo: "plan-undo", addRow: "plan-add-place",
      addCard: "plan-add-card", unread: "plan-unread", unreadText: "plan-unread-text", unreadGo: "plan-unread-go",
    });
    this.day = options.day || 1;
    this.$("card-cancel").onclick = () => this.$("card-dialog").close();
    this.$("card-delete").onclick = () => this.deleteEditing(this.$("card-dialog"));
    this.$("card-scene-go").onclick = () => this.goToScene();
    this.$("card-scene").addEventListener("input", () => this.showSceneButton());
    this.$("card-words").addEventListener("input", () => this.showSceneButton());
    this.$("card-form").addEventListener("submit", e => {
      e.preventDefault();
      if (this.saveCard()) this.$("card-dialog").close();
    });
  }

  parse(text) { return parsePlan(text); }
  serialise(plan) { return planText(plan); }
  defaultStart() { return 8; }

  dayCount() {
    return Math.max(1, this.day, ...this.plan.cards.map(c => c.to));
  }

  setDay(day) {
    this.day = day;
    this.o.onDay?.(day);
    this.render();
    this.$("plan-days").querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  render() {
    this.renderDays();
    super.render();
  }

  renderDays() {
    const box = this.$("plan-days");
    const buttons = [];
    for (let d = 1; d <= this.dayCount(); d++) {
      const b = el("button", d === this.day ? "active" : "", `Day ${d}`);
      b.onclick = () => this.setDay(d);
      buttons.push(b);
    }
    const add = el("button", "quiet", "+");
    add.title = "The next day";
    add.setAttribute("aria-label", "The next day");
    add.onclick = () => this.setDay(this.dayCount() + 1);
    box.replaceChildren(...buttons, add);
  }

  axis() {
    const from = Math.min(FIRST_HOUR, ...this.plan.cards.map(c => Math.floor(c.start)));
    const ticks = [];
    for (let h = from; h < 24; h++) ticks.push(`${h}`);
    return { from, to: 24, unit: HOUR_WIDTH, step: STEP, major: 1, minor: STEP, ticks };
  }

  cardsIn(row) {
    return this.plan.cards.filter(c => c.row === row && c.from <= this.day && this.day <= c.to);
  }

  cardState(c) {
    if (!c.scene) return "unwritten";
    return this.o.hasScene(c.scene) ? "written" : "missing";
  }

  cardClass(c) { return `${c.kind} ${this.cardState(c)}`; }

  cardWords(c) {
    return `${this.cardState(c) === "missing" ? "⚠ " : ""}${c.words || c.scene || "(no words yet)"}`;
  }

  cardTitle(c) {
    const said = { unwritten: "not written yet", written: `scene ${c.scene}`, missing: `no scene called ${c.scene}` }[this.cardState(c)];
    return `${this.timeText(c.start, c.end)}, ${c.kind}: ${c.words || "(no words yet)"} (${said})`;
  }

  timeText(start, end) { return `${fmtHour(start)} to ${fmtHour(end)}`; }

  /* ---------- The card's fields ---------- */

  openCard(card, fresh) {
    this.editing = card;
    const c = card ?? { from: this.day, to: this.day, start: fresh.start, end: Math.min(24, fresh.start + 1), row: fresh.row, kind: "once", words: "", scene: "" };
    const $ = this.$;
    $("card-title").textContent = card ? `${c.row}, ${fmtHour(c.start)} to ${fmtHour(c.end)}` : "A new card";
    $("card-words").value = c.words;
    $("card-place").value = c.row;
    $("card-places").replaceChildren(...this.plan.rows.map(p => new Option(p, p)));
    $("card-from").value = c.from;
    $("card-to").value = c.to;
    for (const [id, value] of [["card-start", c.start], ["card-end", c.end]]) {
      const hours = halfHours();
      if (!hours.includes(value)) hours.push(value);
      $(id).replaceChildren(...hours.sort((a, b) => a - b).map(h => new Option(fmtHour(h), h)));
      $(id).value = value;
    }
    $(c.kind === "open" ? "card-open" : "card-once").checked = true;
    $("card-scene").value = c.scene;
    $("card-scenes").replaceChildren(...this.o.scenes().map(s => new Option(s, s)));
    $("card-delete").hidden = !card;
    $("card-message").textContent = "";
    this.showSceneButton();
    $("card-dialog").showModal();
    if (!card) $("card-words").focus();
  }

  showSceneButton() {
    const name = this.$("card-scene").value.trim();
    this.$("card-scene-go").textContent = name && this.o.hasScene(name) ? `Open ${name}` : "Write this scene";
  }

  // Takes the dialog's fields into the plan. False, with a message, if they don't work.
  saveCard() {
    const $ = this.$;
    const bad = text => { $("card-message").textContent = text; return false; };
    const row = cleanRow($("card-place").value);
    const from = +$("card-from").value;
    const to = +$("card-to").value;
    const start = +$("card-start").value;
    const end = +$("card-end").value;
    const scene = $("card-scene").value.trim();
    // An arrow at the end of the words would read back as the card's scene.
    const words = cleanWords($("card-words").value).replace(/->/g, "→");
    if (!row) return bad("Which place is it in?");
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > MAX_DAY) return bad(`The days run from 1 to ${MAX_DAY}, the first no later than the last.`);
    if (start >= end) return bad("It has to end after it starts.");
    if (scene && !SCENE_NAME.test(scene)) return bad("A scene's name is letters, numbers and underscores, and doesn't start with a number.");
    const fields = { row, from, to, start, end, words, scene, kind: $("card-open").checked ? "open" : "once" };
    if (this.editing) Object.assign(this.editing, fields);
    else {
      this.plan.cards.push(fields);
      this.plan.lines.push({ card: fields });
    }
    if (!this.plan.rows.includes(row)) this.plan.rows.push(row);
    this.commit();
    return true;
  }

  goToScene() {
    const words = cleanWords(this.$("card-words").value);
    const typed = this.$("card-scene").value.trim();
    if (!typed) {
      const taken = name => this.o.hasScene(name) || this.o.nameTaken(name);
      this.$("card-scene").value = sceneNameFrom(words, taken);
    }
    if (!this.saveCard()) return;
    const name = this.$("card-scene").value.trim();
    this.$("card-dialog").close();
    if (this.o.hasScene(name)) this.o.openScene(name);
    else this.o.writeScene(name, words);
  }
}
