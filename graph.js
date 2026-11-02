// Draws the scan as columns of scenes, by how many jumps each is from the start.
// Coordinates are graph units; the view transform (pan, zoom) sits on one <g>.

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

export class Graph {
  constructor(svg, { onSelect }) {
    this.svg = svg;
    this.onSelect = onSelect;
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
    this.result = result;
    this.draw();
    if (!this.hasFit || before === 0) this.fit();
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

    const inCount = new Map();
    for (const e of edges) inCount.set(e.to, (inCount.get(e.to) || 0) + 1);
    const hubs = new Set([...inCount].filter(([, c]) => c >= HUB_IN).map(([n]) => n));

    const edgeLayer = el("g", {}, this.layer);
    for (const e of edges) {
      if (this.collapseHubs && hubs.has(e.to)) continue; // the hub's badge counts them
      const a = pos.get(e.from), b = pos.get(e.to);
      const back = b.col <= a.col;
      let d;
      if (back) {
        const lift = 46 + 18 * Math.abs(a.col - b.col);
        const y0 = a.y, y1 = b.y;
        d = `M${a.x + NODE_W / 2} ${y0} C${a.x + NODE_W / 2} ${y0 - lift}, ${b.x + NODE_W / 2} ${y1 - lift}, ${b.x + NODE_W / 2} ${y1 - 1}`;
      } else {
        const x0 = a.x + NODE_W, y0 = a.y + a.h / 2, x1 = b.x - 1, y1 = b.y + b.h / 2;
        const mid = (x0 + x1) / 2;
        d = `M${x0} ${y0} C${mid} ${y0}, ${mid} ${y1}, ${x1} ${y1}`;
      }
      const path = el("path", { d, class: `edge${e.conditional ? " cond" : ""}${back ? " back" : ""}`, "marker-end": "url(#arrow)" }, edgeLayer);
      if (e.labels.length) el("title", {}, path).textContent = e.labels.join(" / ");
      if (this.showLabels && e.labels.length && !back) {
        const t = el("text", { x: a.x + NODE_W + COL_GAP / 2, y: (a.y + a.h / 2 + b.y + b.h / 2) / 2 - 3, "text-anchor": "middle", class: "edge-label" }, edgeLayer);
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

    svg.addEventListener("pointerdown", e => {
      svg.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, local(e));
      moved = 0;
      downNode = e.target.closest?.(".node")?.dataset.name ?? null;
      pinch = null;
    });
    svg.addEventListener("pointermove", e => {
      if (!this.pointers.has(e.pointerId)) return;
      const prev = this.pointers.get(e.pointerId);
      const now = local(e);
      this.pointers.set(e.pointerId, now);
      if (this.pointers.size === 1) {
        this.view.x += now.x - prev.x;
        this.view.y += now.y - prev.y;
        moved += Math.abs(now.x - prev.x) + Math.abs(now.y - prev.y);
        this.apply();
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
