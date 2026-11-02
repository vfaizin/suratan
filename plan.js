// The Plan tab: one day's board, places down and hours across, kept in plan.ink.
// The file is nothing but Ink comments, so the compiler never sees a card and an
// unwritten scene can't be an error. A line the board doesn't understand is kept as it
// is, because the file can be edited by hand too. Hours are decimal: 8.5 is 8:30.

export const PLAN = "plan.ink";

const HEADER = "// The plan. The Plan tab reads and writes this file; Ink ignores it.";
const PLACES = /^\/\/\s*places:(.*)$/i;
const CARD = /^\/\/\s*days?\b.*\|/i;
const DAYS = /^days?\s+(\d+)(?:\s*-\s*(\d+))?$/i;
const HOURS = /^(\d{1,2})(?::(\d\d))?\s*-\s*(\d{1,2})(?::(\d\d))?$/;
const LINK = /\s*->\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*$/;
export const SCENE_NAME = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)?$/;

const MAX_DAY = 366;
const FIRST_HOUR = 6; // the board starts here unless a card starts earlier
const HOUR_WIDTH = 72; // CSS pixels; half of it is the step a drag snaps to
const LANE_HEIGHT = 46;

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
  const place = parts[2].trim();
  const kind = parts[3].trim().toLowerCase();
  if (!days || !hours || !place || (kind !== "once" && kind !== "open")) return null;
  const from = +days[1];
  const to = days[2] ? +days[2] : from;
  const start = +hours[1] + (+hours[2] || 0) / 60;
  const end = +hours[3] + (+hours[4] || 0) / 60;
  if (+hours[2] > 59 || +hours[4] > 59) return null;
  if (from < 1 || to < from || to > MAX_DAY || end > 24 || start >= end) return null;
  const link = words.match(LINK);
  return {
    from, to, start, end, place, kind,
    words: link ? words.slice(0, link.index).trim() : words,
    scene: link ? link[1] : "",
  };
}

function cardLine(c) {
  const days = c.from === c.to ? `day ${c.from}` : `days ${c.from}-${c.to}`;
  const link = c.scene ? `${c.words ? " " : ""}-> ${c.scene}` : "";
  return `// ${days} | ${fmtHour(c.start)}-${fmtHour(c.end)} | ${c.place} | ${c.kind} | ${c.words}${link}`.trimEnd();
}

// lines: each line of the file in order, as { raw }, { card } or { places: true }.
// places: the rows, those listed first, then any a card names that the list doesn't.
// unread: lines that look meant for the board, or aren't comments, and can't be used.
export function parsePlan(text) {
  const plan = { lines: [], places: [], cards: [], unread: [] };
  let listed = false;
  const rows = (text || "").split("\n");
  if (rows.at(-1) === "") rows.pop(); // the final newline ends the last line; it isn't a blank one
  rows.forEach((rawLine, i) => {
    const raw = rawLine.replace(/\r$/, "");
    const line = raw.trim();
    const places = line.match(PLACES);
    if (places && !listed) {
      listed = true;
      plan.places = [...new Set(places[1].split(",").map(p => p.trim()).filter(Boolean))];
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
  for (const c of plan.cards) if (!plan.places.includes(c.place)) plan.places.push(c.place);
  return plan;
}

export function planText(plan) {
  const out = [];
  const hasPlaces = plan.lines.some(l => l.places);
  if (!plan.lines.some(l => l.raw?.trim())) out.push(HEADER);
  if (!hasPlaces) out.push(`// places: ${plan.places.join(", ")}`);
  for (const l of plan.lines) {
    if (l.places) out.push(`// places: ${plan.places.join(", ")}`);
    else if (l.card) out.push(cardLine(l.card));
    else out.push(l.raw);
  }
  while (out.length > 1 && out.at(-1) === "") out.pop();
  return out.join("\n") + "\n";
}

// Puts cards that share hours on separate lanes of their row. Longest first among those
// starting together, so a window sits above the moments inside it.
export function layLanes(cards) {
  const sorted = [...cards].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const laneEnds = [];
  const lanes = new Map();
  for (const c of sorted) {
    let lane = laneEnds.findIndex(end => end <= c.start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = c.end;
    lanes.set(c, lane);
  }
  return { lanes, count: Math.max(1, laneEnds.length) };
}

// A scene name made from the card's words: "the drawer" -> the_drawer, the_drawer_2.
export function sceneNameFrom(words, taken) {
  const base = words.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32).replace(/_+$/, "");
  const name = /^[a-z_]/.test(base) ? base : `scene${base ? `_${base}` : ""}`;
  let tried = name;
  for (let n = 2; taken(tried); n++) tried = `${name}_${n}`;
  return tried;
}

const clean = s => s.replace(/\s+/g, " ").trim();
const cleanPlace = s => clean(s).replace(/[|,]/g, " ").replace(/\s+/g, " ").trim();
const halfHours = () => Array.from({ length: 49 }, (_, i) => i / 2);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Board {
  // read() and write(text): the file. openLine(n): show a line of it. scenes(): names to
  // link to. hasScene(name), nameTaken(name), openScene(name), writeScene(name, words):
  // the script's side. canDrag(): false on a phone, where a finger on a card must still
  // scroll the board. day, onDay(day): the day showing, kept by the caller.
  constructor(options) {
    this.o = options;
    this.$ = id => document.getElementById(id);
    this.scroller = this.$("plan-board");
    this.day = options.day || 1;
    this.text = null;
    this.plan = parsePlan("");
    this.undoStack = [];
    this.lastWritten = null;
    this.drag = null;
    this.suppressClick = false;
    this.editing = null; // the card in the dialog, or null for a new one
    this.editingPlace = null;

    this.$("plan-add-card").onclick = () => this.openCard(null, { place: this.plan.places[0] ?? "", start: 8 });
    this.$("plan-add-place").onclick = () => this.openPlace(null);
    this.$("plan-undo").onclick = () => this.undo();
    this.$("card-cancel").onclick = () => this.$("card-dialog").close();
    this.$("card-delete").onclick = () => this.deleteCard();
    this.$("card-scene-go").onclick = () => this.goToScene();
    this.$("card-scene").addEventListener("input", () => this.showSceneButton());
    this.$("card-words").addEventListener("input", () => this.showSceneButton());
    this.$("card-form").addEventListener("submit", e => {
      e.preventDefault();
      if (this.saveCard()) this.$("card-dialog").close();
    });
    this.$("place-cancel").onclick = () => this.$("place-dialog").close();
    this.$("place-remove").onclick = () => this.removePlace();
    this.$("place-up").onclick = () => this.movePlace(-1);
    this.$("place-down").onclick = () => this.movePlace(1);
    this.$("place-form").addEventListener("submit", e => { e.preventDefault(); this.savePlace(); });
  }

  // Called whenever the file or the scenes may have changed. A drag in progress is left
  // alone; when it ends, it sees that the file moved and gives way.
  refresh() {
    if (this.drag) return;
    this.text = this.o.read();
    this.plan = parsePlan(this.text);
    if (this.lastWritten !== null && this.text !== this.lastWritten) {
      this.undoStack = []; // edited by hand or by a sync: going back would lose that
      this.lastWritten = null;
    }
    this.render();
  }

  commit() {
    const next = planText(this.plan);
    if (next === this.text) { this.render(); return; }
    this.undoStack.push(this.text);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.lastWritten = next;
    this.o.write(next);
    this.refresh();
  }

  undo() {
    if (!this.undoStack.length) return;
    this.lastWritten = this.undoStack.pop();
    this.o.write(this.lastWritten);
    this.refresh();
  }

  dayCount() {
    return Math.max(1, this.day, ...this.plan.cards.map(c => c.to));
  }

  setDay(day) {
    this.day = day;
    this.o.onDay?.(day);
    this.render();
    this.$("plan-days").querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  firstHour() {
    return Math.min(FIRST_HOUR, ...this.plan.cards.map(c => Math.floor(c.start)));
  }

  render() {
    this.$("plan-undo").disabled = !this.undoStack.length;
    this.renderDays();
    this.renderUnread();
    this.renderBoard();
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

  renderUnread() {
    const { unread } = this.plan;
    const box = this.$("plan-unread");
    box.hidden = !unread.length;
    if (!unread.length) return;
    this.$("plan-unread-text").textContent = unread.length === 1
      ? `Line ${unread[0].line} of ${PLAN} isn't a card the board can read.`
      : `${unread.length} lines of ${PLAN} aren't cards the board can read, starting at line ${unread[0].line}.`;
    this.$("plan-unread-go").onclick = () => this.o.openLine(unread[0].line);
  }

  renderBoard() {
    const { scrollLeft, scrollTop } = this.scroller;
    const first = this.firstHour();
    const width = (24 - first) * HOUR_WIDTH;
    const board = el("div", "plan-grid");
    board.style.setProperty("--hour", `${HOUR_WIDTH}px`);
    board.style.setProperty("--tracks", `${width}px`);

    const head = el("div", "plan-head");
    head.append(el("div", "plan-corner"));
    const hours = el("div", "plan-hours");
    for (let h = first; h < 24; h++) hours.append(el("span", "", `${h}`));
    head.append(hours);
    board.append(head);

    this.rows = [];
    this.scroller.classList.toggle("can-drag", this.o.canDrag());
    for (const place of this.plan.places) board.append(this.renderRow(place, first));
    this.scroller.replaceChildren(board);
    this.$("plan-empty").hidden = this.plan.places.length > 0;
    this.scroller.hidden = this.plan.places.length === 0;
    this.scroller.scrollLeft = scrollLeft;
    this.scroller.scrollTop = scrollTop;
  }

  renderRow(place, first) {
    const row = el("div", "plan-row");
    const name = el("button", "plan-place", place);
    name.title = `Rename or move ${place}`;
    name.onclick = () => this.openPlace(place);
    row.append(name);

    const cards = this.plan.cards.filter(c => c.place === place && c.from <= this.day && this.day <= c.to);
    const { lanes, count } = layLanes(cards);
    const track = el("div", "plan-track");
    track.style.minHeight = `${count * LANE_HEIGHT + 4}px`; // a long place name can make the row taller
    track.onclick = e => {
      if (e.target !== track || this.suppressClick) return;
      const start = Math.min(23.5, first + Math.floor(e.offsetX / (HOUR_WIDTH / 2)) / 2);
      this.openCard(null, { place, start });
    };
    for (const c of cards) track.append(this.renderCard(c, lanes.get(c), first));
    row.append(track);
    this.rows.push({ place, row, track });
    return row;
  }

  cardState(c) {
    if (!c.scene) return "unwritten";
    return this.o.hasScene(c.scene) ? "written" : "missing";
  }

  renderCard(c, lane, first) {
    const state = this.cardState(c);
    const node = el("div", `plan-card ${c.kind} ${state}`);
    node.style.left = `${(c.start - first) * HOUR_WIDTH}px`;
    node.style.width = `${(c.end - c.start) * HOUR_WIDTH}px`;
    node.style.top = `${lane * LANE_HEIGHT + 2}px`;
    node.style.height = `${LANE_HEIGHT - 2}px`;
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    const hours = `${fmtHour(c.start)} to ${fmtHour(c.end)}`;
    const said = { unwritten: "not written yet", written: `scene ${c.scene}`, missing: `no scene called ${c.scene}` }[state];
    node.title = `${hours}, ${c.kind}: ${c.words || "(no words yet)"} (${said})`;
    node.setAttribute("aria-label", `${c.place}, ${node.title}`);
    node.append(el("span", "plan-card-words", `${state === "missing" ? "⚠ " : ""}${c.words || c.scene || "(no words yet)"}`));
    node.append(el("span", "plan-card-time", hours));
    node.append(el("span", "plan-edge left"), el("span", "plan-edge right"));
    node.onclick = e => {
      e.stopPropagation();
      if (!this.suppressClick) this.openCard(c);
    };
    node.onkeydown = e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.openCard(c); }
    };
    if (this.o.canDrag()) node.onpointerdown = e => this.startDrag(e, c, node, first);
    return node;
  }

  /* ---------- Dragging: a card's middle moves it, its edges change its hours ---------- */

  startDrag(e, card, node, first) {
    if (e.button !== 0) return;
    const mode = e.target.classList.contains("left") ? "left" : e.target.classList.contains("right") ? "right" : "move";
    this.suppressClick = false;
    this.drag = {
      card, node, first, mode, moved: false,
      x: e.clientX, y: e.clientY, scroll: this.scroller.scrollLeft,
      start: card.start, end: card.end, place: card.place,
    };
    node.setPointerCapture(e.pointerId);
    node.onpointermove = ev => this.moveDrag(ev);
    node.onpointerup = () => this.endDrag(true);
    node.onpointercancel = () => this.endDrag(false);
  }

  moveDrag(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
    d.moved = true;
    d.node.classList.add("dragging");

    const box = this.scroller.getBoundingClientRect();
    const edge = 28;
    if (e.clientX > box.right - edge) this.scroller.scrollLeft += 18;
    else if (e.clientX < box.left + 96 + edge) this.scroller.scrollLeft -= 18;

    const moved = e.clientX - d.x + this.scroller.scrollLeft - d.scroll;
    const steps = Math.round(moved / (HOUR_WIDTH / 2)) / 2;
    const { start, end } = d.card;
    const snap = h => Math.round(h * 2) / 2;
    if (d.mode === "move") {
      const length = end - start;
      d.start = Math.max(d.first, Math.min(24 - length, snap(start + steps)));
      d.end = d.start + length;
      const over = this.rows.find(r => {
        const b = r.row.getBoundingClientRect();
        return e.clientY >= b.top && e.clientY < b.bottom;
      });
      if (over) d.place = over.place;
      const home = this.rows.find(r => r.place === d.card.place);
      const there = this.rows.find(r => r.place === d.place);
      const shift = there.row.getBoundingClientRect().top - home.row.getBoundingClientRect().top;
      d.node.style.transform = `translateY(${shift}px)`;
    } else if (d.mode === "left") {
      d.start = Math.max(d.first, Math.min(end - 0.5, snap(start + steps)));
    } else {
      d.end = Math.min(24, Math.max(start + 0.5, snap(end + steps)));
    }
    d.node.style.left = `${(d.start - d.first) * HOUR_WIDTH}px`;
    d.node.style.width = `${(d.end - d.start) * HOUR_WIDTH}px`;
    d.node.querySelector(".plan-card-time").textContent = `${fmtHour(d.start)} to ${fmtHour(d.end)}`;
  }

  endDrag(keep) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    d.node.onpointermove = d.node.onpointerup = d.node.onpointercancel = null;
    if (!d.moved) return;
    // The click that follows a drag isn't a tap on the card or the board.
    this.suppressClick = true;
    setTimeout(() => { this.suppressClick = false; }, 60);
    // A sync can change the file under a drag. Then what was dragged no longer exists.
    if (!keep || this.o.read() !== this.text) { this.refresh(); return; }
    d.card.start = d.start;
    d.card.end = d.end;
    d.card.place = d.place;
    this.commit();
  }

  /* ---------- The card's fields ---------- */

  openCard(card, fresh) {
    this.editing = card;
    const c = card ?? { from: this.day, to: this.day, start: fresh.start, end: Math.min(24, fresh.start + 1), place: fresh.place, kind: "once", words: "", scene: "" };
    const $ = this.$;
    $("card-title").textContent = card ? `${c.place}, ${fmtHour(c.start)} to ${fmtHour(c.end)}` : "A new card";
    $("card-words").value = c.words;
    $("card-place").value = c.place;
    $("card-places").replaceChildren(...this.plan.places.map(p => new Option(p, p)));
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
    const place = cleanPlace($("card-place").value);
    const from = +$("card-from").value;
    const to = +$("card-to").value;
    const start = +$("card-start").value;
    const end = +$("card-end").value;
    const scene = $("card-scene").value.trim();
    // An arrow at the end of the words would read back as the card's scene.
    const words = clean($("card-words").value).replace(/->/g, "→");
    if (!place) return bad("Which place is it in?");
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > MAX_DAY) return bad(`The days run from 1 to ${MAX_DAY}, the first no later than the last.`);
    if (start >= end) return bad("It has to end after it starts.");
    if (scene && !SCENE_NAME.test(scene)) return bad("A scene's name is letters, numbers and underscores, and doesn't start with a number.");
    const fields = { place, from, to, start, end, words, scene, kind: $("card-open").checked ? "open" : "once" };
    if (this.editing) Object.assign(this.editing, fields);
    else {
      this.plan.cards.push(fields);
      this.plan.lines.push({ card: fields });
    }
    if (!this.plan.places.includes(place)) this.plan.places.push(place);
    this.commit();
    return true;
  }

  deleteCard() {
    const line = this.plan.lines.findIndex(l => l.card === this.editing);
    if (line >= 0) this.plan.lines.splice(line, 1);
    this.plan.cards = this.plan.cards.filter(c => c !== this.editing);
    this.$("card-dialog").close();
    this.commit();
  }

  goToScene() {
    const words = clean(this.$("card-words").value);
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

  /* ---------- The rows ---------- */

  openPlace(place) {
    this.editingPlace = place;
    const $ = this.$;
    $("place-title").textContent = place ?? "A new place";
    $("place-name").value = place ?? "";
    $("place-message").textContent = "";
    $("place-moves").hidden = place === null;
    this.showPlaceMoves();
    $("place-dialog").showModal();
    if (place === null) $("place-name").focus();
  }

  showPlaceMoves() {
    const i = this.plan.places.indexOf(this.editingPlace);
    this.$("place-up").disabled = i <= 0;
    this.$("place-down").disabled = i < 0 || i === this.plan.places.length - 1;
  }

  savePlace() {
    const $ = this.$;
    const name = cleanPlace($("place-name").value);
    const old = this.editingPlace;
    if (!name) { $("place-message").textContent = "It needs a name."; return; }
    if (name !== old && this.plan.places.includes(name)) { $("place-message").textContent = `There's already a ${name}.`; return; }
    $("place-dialog").close();
    if (name === old) return;
    if (old === null) this.plan.places.push(name);
    else {
      this.plan.places[this.plan.places.indexOf(old)] = name;
      for (const c of this.plan.cards) if (c.place === old) c.place = name;
    }
    this.commit();
  }

  removePlace() {
    const place = this.editingPlace;
    const used = this.plan.cards.filter(c => c.place === place).length;
    if (used) {
      this.$("place-message").textContent = `${used === 1 ? "One card is" : `${used} cards are`} still here, on some day. Move or delete ${used === 1 ? "it" : "them"} first.`;
      return;
    }
    this.plan.places = this.plan.places.filter(p => p !== place);
    this.$("place-dialog").close();
    this.commit();
  }

  movePlace(by) {
    const i = this.plan.places.indexOf(this.editingPlace);
    const j = i + by;
    if (i < 0 || j < 0 || j >= this.plan.places.length) return;
    [this.plan.places[i], this.plan.places[j]] = [this.plan.places[j], this.plan.places[i]];
    this.commit();
    this.showPlaceMoves();
  }
}
