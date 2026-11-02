// What the Plan and Story boards share: rows down, time across, cards you can drag, all
// kept in one .ink file of comments. A board says what its file means (parse, serialise)
// and what its time means (axis); this draws it and keeps the undo. Time here is a plain
// number in the board's own unit: hours on Plan, weeks on Story.

const LANE_HEIGHT = 46;

// Puts cards that share time on separate lanes of their row. Longest first among those
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

export const cleanWords = s => s.replace(/\s+/g, " ").trim();
export const cleanRow = s => cleanWords(s.replace(/[|,]/g, " "));

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Timeline {
  // options: read() and write(text), the file; canDrag(), false on a phone, where a finger
  // on a card must still scroll the board; openLine(n), show a line of the file; file, its
  // name; rowWord, what a row is called. ids: scroller, empty, undo, addRow, addCard,
  // unread, unreadText, unreadGo.
  constructor(options, ids) {
    this.o = options;
    this.$ = id => document.getElementById(id);
    this.ids = ids;
    this.scroller = this.$(ids.scroller);
    this.text = null;
    this.plan = this.parse("");
    this.undoStack = [];
    this.lastWritten = null;
    this.drag = null;
    this.suppressClick = false;
    this.editing = null; // the card in the dialog, or null for a new one
    this.editingRow = null;
    this.$(ids.undo).onclick = () => this.undo();
    this.$(ids.addRow).onclick = () => this.openRow(null);
    this.$(ids.addCard).onclick = () => this.openCard(null, { row: this.plan.rows[0] ?? "", start: this.defaultStart() });
  }

  // Called whenever the file or what it links to may have changed. A drag in progress is
  // left alone; when it ends, it sees that the file moved and gives way.
  refresh() {
    if (this.drag) return;
    this.text = this.o.read();
    this.plan = this.parse(this.text);
    if (this.lastWritten !== null && this.text !== this.lastWritten) {
      this.undoStack = []; // edited by hand or by a sync: going back would lose that
      this.lastWritten = null;
    }
    this.render();
  }

  commit() {
    const next = this.serialise(this.plan);
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

  render() {
    this.$(this.ids.undo).disabled = !this.undoStack.length;
    this.renderUnread();
    this.renderBoard();
  }

  renderUnread() {
    const { unread } = this.plan;
    const { file } = this.o;
    this.$(this.ids.unread).hidden = !unread.length;
    if (!unread.length) return;
    this.$(this.ids.unreadText).textContent = unread.length === 1
      ? `Line ${unread[0].line} of ${file} isn't something the board can read.`
      : `${unread.length} lines of ${file} aren't things the board can read, starting at line ${unread[0].line}.`;
    this.$(this.ids.unreadGo).onclick = () => this.o.openLine(unread[0].line);
  }

  boardShowing() { return true; }

  renderBoard() {
    const { scrollLeft, scrollTop } = this.scroller;
    const axis = this.axis();
    const board = el("div", "plan-grid");
    board.style.setProperty("--unit", `${axis.unit}px`);
    board.style.setProperty("--major", `${axis.unit * axis.major}px`);
    board.style.setProperty("--minor", `${axis.unit * axis.minor}px`);
    board.style.setProperty("--tracks", `${(axis.to - axis.from) * axis.unit}px`);

    const head = el("div", "plan-head");
    head.append(el("div", "plan-corner"));
    const scale = el("div", "plan-scale");
    const ticks = el("div", "plan-hours");
    for (const label of axis.ticks) ticks.append(el("span", "", label));
    scale.append(ticks);
    if (axis.marks?.length) {
      const marks = el("div", "plan-marks");
      for (const m of axis.marks) {
        const mark = el("span", "plan-mark", m.label);
        mark.style.left = `${(m.start - axis.from) * axis.unit}px`;
        mark.style.width = `${(m.end - m.start) * axis.unit}px`;
        mark.title = m.label;
        marks.append(mark);
      }
      scale.append(marks);
    }
    head.append(scale);
    board.append(head);

    this.rows = [];
    this.scroller.classList.toggle("can-drag", this.o.canDrag());
    for (const row of this.plan.rows) board.append(this.renderRow(row, axis));
    this.scroller.replaceChildren(board);
    const any = this.plan.rows.length > 0;
    this.$(this.ids.empty).hidden = any;
    this.scroller.hidden = !any || !this.boardShowing();
    this.scroller.scrollLeft = scrollLeft;
    this.scroller.scrollTop = scrollTop;
  }

  renderRow(name, axis) {
    const row = el("div", "plan-row");
    const button = el("button", "plan-place", name);
    button.title = `Rename or move ${name}`;
    button.onclick = () => this.openRow(name);
    row.append(button);

    const cards = this.cardsIn(name);
    const { lanes, count } = layLanes(cards);
    const track = el("div", "plan-track");
    track.style.minHeight = `${count * LANE_HEIGHT + 4}px`; // a long name can make the row taller
    track.onclick = e => {
      if (e.target !== track || this.suppressClick) return;
      const width = axis.unit * axis.step;
      const start = Math.min(axis.to - axis.step, axis.from + Math.floor(e.offsetX / width) * axis.step);
      this.openCard(null, { row: name, start });
    };
    for (const c of cards) track.append(this.renderCard(c, lanes.get(c), axis));
    row.append(track);
    this.rows.push({ name, row, track });
    return row;
  }

  renderCard(c, lane, axis) {
    const node = el("div", `plan-card ${this.cardClass(c)}`);
    node.style.left = `${(c.start - axis.from) * axis.unit}px`;
    node.style.width = `${(c.end - c.start) * axis.unit}px`;
    node.style.top = `${lane * LANE_HEIGHT + 2}px`;
    node.style.height = `${LANE_HEIGHT - 2}px`;
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    node.title = this.cardTitle(c);
    node.setAttribute("aria-label", `${c.row}, ${node.title}`);
    node.append(el("span", "plan-card-words", this.cardWords(c)));
    node.append(el("span", "plan-card-time", this.timeText(c.start, c.end)));
    node.append(el("span", "plan-edge left"), el("span", "plan-edge right"));
    node.onclick = e => {
      e.stopPropagation();
      if (!this.suppressClick) this.openCard(c);
    };
    node.onkeydown = e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.openCard(c); }
    };
    if (this.o.canDrag()) node.onpointerdown = e => this.startDrag(e, c, node, axis);
    return node;
  }

  /* ---------- Dragging: a card's middle moves it, its edges change its time ---------- */

  startDrag(e, card, node, axis) {
    if (e.button !== 0) return;
    const mode = e.target.classList.contains("left") ? "left" : e.target.classList.contains("right") ? "right" : "move";
    this.suppressClick = false;
    this.drag = {
      card, node, axis, mode, moved: false,
      x: e.clientX, y: e.clientY, scroll: this.scroller.scrollLeft,
      start: card.start, end: card.end, row: card.row,
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

    const { from, to, unit, step } = d.axis;
    const snap = t => Math.round(t / step) * step;
    const moved = snap((e.clientX - d.x + this.scroller.scrollLeft - d.scroll) / unit);
    const { start, end } = d.card;
    if (d.mode === "move") {
      const length = end - start;
      d.start = Math.max(from, Math.min(to - length, snap(start + moved)));
      d.end = d.start + length;
      const over = this.rows.find(r => {
        const b = r.row.getBoundingClientRect();
        return e.clientY >= b.top && e.clientY < b.bottom;
      });
      if (over) d.row = over.name;
      const home = this.rows.find(r => r.name === d.card.row);
      const there = this.rows.find(r => r.name === d.row);
      const shift = there.row.getBoundingClientRect().top - home.row.getBoundingClientRect().top;
      d.node.style.transform = `translateY(${shift}px)`;
    } else if (d.mode === "left") {
      d.start = Math.max(from, Math.min(end - step, snap(start + moved)));
    } else {
      d.end = Math.min(to, Math.max(start + step, snap(end + moved)));
    }
    d.node.style.left = `${(d.start - from) * unit}px`;
    d.node.style.width = `${(d.end - d.start) * unit}px`;
    d.node.querySelector(".plan-card-time").textContent = this.timeText(d.start, d.end);
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
    d.card.row = d.row;
    this.commit();
  }

  deleteEditing(dialog) {
    const line = this.plan.lines.findIndex(l => l.card === this.editing);
    if (line >= 0) this.plan.lines.splice(line, 1);
    this.plan.cards = this.plan.cards.filter(c => c !== this.editing);
    dialog.close();
    this.commit();
  }

  /* ---------- The rows' dialog, one for both boards ---------- */

  openRow(row) {
    this.editingRow = row;
    const $ = this.$;
    const word = this.o.rowWord;
    $("place-title").textContent = row ?? `A new ${word}`;
    $("place-name").value = row ?? "";
    $("place-message").textContent = "";
    $("place-moves").hidden = row === null;
    $("place-cancel").onclick = () => $("place-dialog").close();
    $("place-remove").onclick = () => this.removeRow();
    $("place-up").onclick = () => this.moveRow(-1);
    $("place-down").onclick = () => this.moveRow(1);
    $("place-form").onsubmit = e => { e.preventDefault(); this.saveRow(); };
    this.showRowMoves();
    $("place-dialog").showModal();
    if (row === null) $("place-name").focus();
  }

  showRowMoves() {
    const i = this.plan.rows.indexOf(this.editingRow);
    this.$("place-up").disabled = i <= 0;
    this.$("place-down").disabled = i < 0 || i === this.plan.rows.length - 1;
  }

  saveRow() {
    const $ = this.$;
    const name = cleanRow($("place-name").value);
    const old = this.editingRow;
    if (!name) { $("place-message").textContent = "It needs a name."; return; }
    if (name !== old && this.plan.rows.includes(name)) { $("place-message").textContent = `There's already a ${name}.`; return; }
    $("place-dialog").close();
    if (name === old) return;
    if (old === null) this.plan.rows.push(name);
    else {
      this.plan.rows[this.plan.rows.indexOf(old)] = name;
      for (const c of this.plan.cards) if (c.row === old) c.row = name;
    }
    this.commit();
  }

  removeRow() {
    const row = this.editingRow;
    const used = this.plan.cards.filter(c => c.row === row).length;
    if (used) {
      this.$("place-message").textContent = `${used === 1 ? "One card is" : `${used} cards are`} still here. Move or delete ${used === 1 ? "it" : "them"} first.`;
      return;
    }
    this.plan.rows = this.plan.rows.filter(p => p !== row);
    this.$("place-dialog").close();
    this.commit();
  }

  moveRow(by) {
    const i = this.plan.rows.indexOf(this.editingRow);
    const j = i + by;
    if (i < 0 || j < 0 || j >= this.plan.rows.length) return;
    [this.plan.rows[i], this.plan.rows[j]] = [this.plan.rows[j], this.plan.rows[i]];
    this.commit();
    this.showRowMoves();
  }
}
