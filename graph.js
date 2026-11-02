// Draws the scan as columns of scenes, by how many jumps each is from the start.
// Coordinates are graph units; the view transform (pan, zoom) sits on one <g>.
// A scene dragged by hand keeps its place, by name, over the columns.

import { ROOT } from "./parse.js";

const NODE_W = 132;
const COL_GAP = 64;
const ROW_GAP = 22;
const SVG = "http://www.w3.org/2000/svg";
const HUB_IN = 4; // a scene this many others jump to is treated as a hub

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

function nodeHeight(k) { return 38 + (k.stitches.length ? 16 : 0); }

// Columns by shortest jump count from the start; scenes nothing reaches go last.
function layout(nodes, edges) {
  const out = new Map(nodes.map(n => [n.name, []]));
  const inc = new Map(nodes.map(n => [n.name, []]));
  for (const e of edges) { out.get(e.from).push(e.to); inc.get(e.to).push(e.from); }

  const depth = new Map([[ROOT, 0]]);
  const queue = [ROOT];
  while (queue.length) {
    const n = queue.shift();
    for (const t of out.get(n) || []) {
      if (!depth.has(t)) { depth.set(t, depth.get(n) + 1); queue.push(t); }
    }
  }
  const maxDepth = Math.max(0, ...depth.values());
  const columns = [];
  const orphans = new Set();
  for (const n of nodes) {
    let d = depth.get(n.name);
    if (d === undefined) { d = maxDepth + 1; orphans.add(n.name); }
    (columns[d] ||= []).push(n);
  }

  // A few sweeps ordering each column by where its neighbours sit, to untangle lines.
  const rank = new Map();
  const setRanks = () => columns.forEach(c => c?.forEach((n, i) => rank.set(n.name, i)));
  setRanks();
  for (let sweep = 0; sweep < 6; sweep++) {
    for (const col of columns) {
      if (!col) continue;
      const weight = n => {
        const ns = [...inc.get(n.name), ...out.get(n.name)].filter(x => rank.has(x));
        return ns.length ? ns.reduce((a, x) => a + rank.get(x), 0) / ns.length : rank.get(n.name);
      };
      col.sort((a, b) => weight(a) - weight(b));
      col.forEach((n, i) => rank.set(n.name, i));
    }
  }

  const pos = new Map();
  columns.forEach((col, c) => {
    if (!col) return;
    let y = 0;
    for (const n of col) {
      pos.set(n.name, { x: c * (NODE_W + COL_GAP), y, h: nodeHeight(n), col: c });
      y += nodeHeight(n) + ROW_GAP;
    }
    const shift = -y / 2;
    for (const n of col) pos.get(n.name).y += shift;
  });
  return { pos, orphans };
}

// Two scenes closer than a row's gap, one above the other, or overlapping.
function touching(a, b) {
  return a.x < b.x + NODE_W && b.x < a.x + NODE_W && a.y < b.y + b.h + ROW_GAP && b.y < a.y + a.h + ROW_GAP;
}

export class Graph {
  constructor(svg, { onSelect, moved, onMoved }) {
    this.svg = svg;
    this.onSelect = onSelect;
    this.onMoved = onMoved;
    this.moved = new Map(Object.entries(moved)); // name -> { x, y } in graph units
    this.view = { x: 20, y: 20, k: 1 };
    this.collapseHubs = true;
    this.showLabels = true;
    this.overlay = { unreached: new Set(), deadends: new Set() };
    this.current = null;
    this.selected = null;
    this.result = null;
    this.bounds = { x: 0, y: 0, w: 1, h: 1 };
    this.hasFit = false;
    this.pointers = new Map();
    this.bindGestures();
  }

  setResult(result) {
    const before = this.result ? this.result.knots.length : 0;
    this.keepPlaceOnRename(result);
    this.result = result;
    this.draw();
    if (!this.hasFit || before === 0) this.fit();
  }

  // A rename reads as one scene gone and one new. The script is scanned as it's typed,
  // so the old name can go a scan or more before the new one comes (=== ===).
  keepPlaceOnRename(result) {
    const names = new Set(result.knots.map(k => k.name));
    const old = this.names;
    this.names = names;
    if (!old) return;
    const gone = [...old].filter(n => !names.has(n));
    const added = [...names].filter(n => !old.has(n));
    if (gone.length > 1 || added.length > 1) { this.vanished = null; return; }
    if (!added.length) {
      if (gone.length) this.vanished = gone[0];
      return;
    }
    const from = gone[0] ?? this.vanished;
    this.vanished = null;
    if (from && this.moved.has(from) && !this.moved.has(added[0])) {
      this.moved.set(added[0], this.moved.get(from));
      this.moved.delete(from);
      this.onMoved(Object.fromEntries(this.moved));
    }
  }

  setCurrent(name) { this.current = name; this.draw(); }
  setOverlay(o) { this.overlay = o; this.draw(); }
  setSelected(name) { this.selected = name; this.draw(); }

  draw() {
    if (!this.result) return;
    const svg = this.svg;
    svg.replaceChildren();
    const defs = el("defs", {}, svg);
    const marker = el("marker", { id: "arrow", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, defs);
    el("path", { d: "M0 0 L8 4 L0 8 z", class: "arrow" }, marker);
    this.layer = el("g", {}, svg);

    const nodes = this.result.knots.filter(k => !k.isFunction && (!k.isRoot || this.result.edges.some(e => e.from === ROOT)));
    const names = new Set(nodes.map(n => n.name));
    // One line per pair of scenes; its labels gathered.
    const pairs = new Map();
    for (const e of this.result.edges) {
      if (!names.has(e.from) || !names.has(e.to)) continue;
      const key = `${e.from}\u0000${e.to}`;
      const p = pairs.get(key) || { from: e.from, to: e.to, conditional: true, labels: [] };
      p.conditional = p.conditional && e.conditional;
      if (e.label) p.labels.push(e.label);
      pairs.set(key, p);
    }
    const edges = [...pairs.values()];
    const { pos, orphans } = layout(nodes, edges);
    for (const [name, p] of pos) {
      const m = this.moved.get(name);
      if (m) { p.x = m.x; p.y = m.y; }
    }
    // Automatic scenes step down out of the way of moved ones, except the one being
    // dragged: nothing else shifts until it's dropped.
    const placed = [...this.moved.keys()].filter(n => pos.has(n) && n !== this.dragging).map(n => pos.get(n));
    if (placed.length) {
      for (const [name, p] of pos) {
        if (this.moved.has(name)) continue;
        for (let hit; (hit = placed.find(q => touching(p, q)));) p.y = hit.y + hit.h + ROW_GAP;
        placed.push(p);
      }
    }
    this.pos = pos;

    const inCount = new Map();
    for (const e of edges) inCount.set(e.to, (inCount.get(e.to) || 0) + 1);
    const hubs = new Set([...inCount].filter(([, c]) => c >= HUB_IN).map(([n]) => n));

    const edgeLayer = el("g", {}, this.layer);
    for (const e of edges) {
      if (this.collapseHubs && hubs.has(e.to)) continue; // the hub's badge counts them
      const a = pos.get(e.from), b = pos.get(e.to);
      // By where they sit, not their columns: a moved scene can be anywhere.
      const back = b.x < a.x + NODE_W;
      // One moved above the other: bottom to top, each direction to its own side.
      const stacked = (this.moved.has(e.from) || this.moved.has(e.to))
        && Math.abs(a.x - b.x) < NODE_W && (b.y >= a.y + a.h || b.y + b.h <= a.y);
      let d, labelX = (a.x + NODE_W + b.x) / 2, labelY = (a.y + a.h / 2 + b.y + b.h / 2) / 2 - 3, labelAnchor = "middle";
      if (stacked) {
        const down = b.y > a.y;
        const side = down ? 14 : -14;
        const x0 = a.x + NODE_W / 2 + side, y0 = down ? a.y + a.h : a.y;
        const x1 = b.x + NODE_W / 2 + side, y1 = down ? b.y - 1 : b.y + b.h + 1;
        const mid = (y0 + y1) / 2;
        d = `M${x0} ${y0} C${x0} ${mid}, ${x1} ${mid}, ${x1} ${y1}`;
        labelX = (x0 + x1) / 2 + (down ? 4 : -4);
        labelY = mid;
        labelAnchor = down ? "start" : "end"; // outward, so a pair's labels don't overlap
      } else if (back) {
        const lift = 46 + 18 * Math.abs(a.x - b.x) / (NODE_W + COL_GAP);
        const y0 = a.y, y1 = b.y;
        d = `M${a.x + NODE_W / 2} ${y0} C${a.x + NODE_W / 2} ${y0 - lift}, ${b.x + NODE_W / 2} ${y1 - lift}, ${b.x + NODE_W / 2} ${y1 - 1}`;
      } else {
        const x0 = a.x + NODE_W, y0 = a.y + a.h / 2, x1 = b.x - 1, y1 = b.y + b.h / 2;
        const mid = (x0 + x1) / 2;
        d = `M${x0} ${y0} C${mid} ${y0}, ${mid} ${y1}, ${x1} ${y1}`;
      }
      const arc = back && !stacked;
      const path = el("path", { d, class: `edge${e.conditional ? " cond" : ""}${arc ? " back" : ""}`, "marker-end": "url(#arrow)" }, edgeLayer);
      if (e.labels.length) el("title", {}, path).textContent = e.labels.join(" / ");
      if (this.showLabels && e.labels.length && !arc) {
        const t = el("text", { x: labelX, y: labelY, "text-anchor": labelAnchor, class: "edge-label" }, edgeLayer);
        const s = e.labels[0] + (e.labels.length > 1 ? ` +${e.labels.length - 1}` : "");
        t.textContent = s.length > 20 ? s.slice(0, 19) + "…" : s;
      }
    }

    for (const n of nodes) {
      const p = pos.get(n.name);
      const classes = ["node"];
      if (n.isRoot) classes.push("entry");
      if (hubs.has(n.name)) classes.push("hub");
      if (orphans.has(n.name)) classes.push("orphan");
      if (this.overlay.unreached.has(n.name)) classes.push("unreached");
      if (this.overlay.deadends.has(n.name)) classes.push("deadend");
      if (this.current === n.name) classes.push("current");
      if (this.selected === n.name) classes.push("selected");
      const g = el("g", { class: classes.join(" "), transform: `translate(${p.x} ${p.y})`, "data-name": n.name }, this.layer);
      el("rect", { width: NODE_W, height: p.h, rx: 8 }, g);
      const label = n.name.length > 16 ? n.name.slice(0, 15) + "…" : n.name;
      el("text", { x: 10, y: 23 }, g).textContent = label;
      if (n.stitches.length) el("text", { x: 10, y: 40, class: "sub" }, g).textContent = `${n.stitches.length} stitch${n.stitches.length > 1 ? "es" : ""}`;
      if (this.collapseHubs && hubs.has(n.name)) {
        el("text", { x: NODE_W - 8, y: 23, class: "sub", "text-anchor": "end" }, g).textContent = `← ${inCount.get(n.name)}`;
      }
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pos.values()) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x + NODE_W);
      minY = Math.min(minY, p.y - 50); maxY = Math.max(maxY, p.y + p.h);
    }
    this.bounds = { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
    this.count = { scenes: nodes.filter(n => !n.isRoot).length, jumps: edges.length };
    this.apply();
  }

  fit() {
    const r = this.svg.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return; // hidden pane: fit when it shows
    const pad = 24;
    const k = Math.min(1.3, (r.width - pad * 2) / this.bounds.w, (r.height - pad * 2) / this.bounds.h);
    this.view.k = Math.max(0.15, k);
    this.view.x = (r.width - this.bounds.w * this.view.k) / 2 - this.bounds.x * this.view.k;
    this.view.y = (r.height - this.bounds.h * this.view.k) / 2 - this.bounds.y * this.view.k;
    this.hasFit = true;
    this.apply();
  }

  // Every scene back in its column.
  tidy() {
    this.moved.clear();
    this.onMoved(Object.fromEntries(this.moved));
    this.draw();
    this.fit();
  }

  apply() {
    if (this.layer) this.layer.setAttribute("transform", `translate(${this.view.x} ${this.view.y}) scale(${this.view.k})`);
  }

  zoomAt(cx, cy, factor) {
    const k = Math.min(3, Math.max(0.15, this.view.k * factor));
    const real = k / this.view.k;
    this.view.x = cx - (cx - this.view.x) * real;
    this.view.y = cy - (cy - this.view.y) * real;
    this.view.k = k;
    this.apply();
  }

  bindGestures() {
    const svg = this.svg;
    const local = e => { const r = svg.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    let moved = 0;
    let pinch = null;
    let downNode = null;
    let drag = null; // { name, node, pointer }: where the scene and the pointer began
    const endDrag = () => {
      if (this.dragging) {
        this.dragging = null;
        this.onMoved(Object.fromEntries(this.moved));
        this.draw();
      }
      drag = null;
    };

    svg.addEventListener("pointerdown", e => {
      svg.setPointerCapture(e.pointerId);
      const now = local(e);
      this.pointers.set(e.pointerId, now);
      moved = 0;
      downNode = e.target.closest?.(".node")?.dataset.name ?? null;
      pinch = null;
      endDrag(); // a second finger makes it a pinch
      const p = this.pos?.get(downNode);
      if (p && this.pointers.size === 1) drag = { name: downNode, node: { x: p.x, y: p.y }, pointer: now };
    });
    svg.addEventListener("pointermove", e => {
      if (!this.pointers.has(e.pointerId)) return;
      const prev = this.pointers.get(e.pointerId);
      const now = local(e);
      this.pointers.set(e.pointerId, now);
      if (this.pointers.size === 1) {
        moved += Math.abs(now.x - prev.x) + Math.abs(now.y - prev.y);
        if (drag) {
          if (moved < 8) return; // still a tap: it hasn't left its place
          this.dragging = drag.name;
          this.moved.set(drag.name, {
            x: Math.round(drag.node.x + (now.x - drag.pointer.x) / this.view.k),
            y: Math.round(drag.node.y + (now.y - drag.pointer.y) / this.view.k),
          });
          this.draw();
        } else {
          this.view.x += now.x - prev.x;
          this.view.y += now.y - prev.y;
          this.apply();
        }
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        if (pinch) {
          this.view.x += cx - pinch.cx;
          this.view.y += cy - pinch.cy;
          this.zoomAt(cx, cy, dist / pinch.dist);
        }
        pinch = { dist, cx, cy };
        moved += 100; // a pinch is never a tap
      }
    });
    const up = e => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      endDrag();
      if (this.pointers.size < 2) pinch = null;
      if (this.pointers.size === 0 && moved < 8 && e.type === "pointerup") this.onSelect(downNode);
    };
    svg.addEventListener("pointerup", up);
    svg.addEventListener("pointercancel", up);
    svg.addEventListener("wheel", e => {
      e.preventDefault();
      const p = local(e);
      if (e.ctrlKey || e.metaKey) {
        this.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.01));
      } else {
        this.view.x -= e.deltaX;
        this.view.y -= e.deltaY;
        this.apply();
      }
    }, { passive: false });
  }
}
