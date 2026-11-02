// Suratan: holds the project, and wires the script, graph, play and check panes.

import { scan, reachablePaths } from "./parse.js";
import { Graph } from "./graph.js";
import { GitHub, Conflict } from "./github.js";
import { SAMPLE } from "./sample.js";

const MAIN = "main.ink";
const $ = id => document.getElementById(id);

/* ---------- Storage on this device. Browsers can refuse it, so nothing assumes it works. ---------- */

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

// files: name -> text now. synced: name -> { sha, text } as of the last sync.
// deleted: name -> sha of a synced file deleted here, for the next sync to remove.
// syncedFrom: the repository, branch and folder that `synced` describes.
const project = loadJson("suratan:project", null) || { files: { [MAIN]: SAMPLE }, synced: {}, current: MAIN };
project.deleted ||= {};
project.removed ||= {}; // name -> when it was deleted or renamed here, to find its history by
if (project.files[project.current] === undefined) project.current = Object.keys(project.files)[0];
const github = loadJson("suratan:github", { repo: "vfaizin/kias", branch: "main", dir: "assets/story", token: "" });
github.auto ??= true;
let saveFailed = false;

function persist() {
  const dirty = dirtyCount() > 0;
  if (!dirty) delete project.dirtySince;
  else project.dirtySince ??= Date.now();
  saveFailed = !saveJson("suratan:project", project);
  showSyncState();
  planAutoSync();
}
navigator.storage?.persist?.().catch(() => {});

/* ---------- Compiling ---------- */

let compiled = { json: null, issues: [], scan: scan(project.files) };

function compile() {
  const issues = [];
  const onMessage = (message, type) => {
    const m = message.match(/^(?:ERROR|WARNING|TODO|RUNTIME ERROR)?:?\s*(?:'(.+?)' )?line (\d+):\s*(.*)$/s);
    const level = type === 2 ? "error" : type === 1 ? "warning" : "note";
    if (m) issues.push({ level, file: m[1] || MAIN, line: +m[2], text: m[3] });
    else issues.push({ level, file: MAIN, line: 0, text: message });
  };
  const handler = {
    ResolveInkFilename: name => name,
    LoadInkFileContents: name => {
      if (!(name in project.files)) throw new Error(`INCLUDE can't find ${name}`);
      return project.files[name];
    },
  };
  let json = null;
  if (MAIN in project.files) {
    try {
      const options = new inkjs.CompilerOptions(MAIN, [], true, onMessage, handler);
      json = new inkjs.Compiler(project.files[MAIN], options).Compile().ToJson();
    } catch (e) {
      if (!issues.some(i => i.level === "error")) issues.push({ level: "error", file: MAIN, line: 0, text: e.message });
      json = null;
    }
  } else {
    issues.push({ level: "error", file: MAIN, line: 0, text: "The story starts from main.ink, and there isn't one." });
  }

  const result = scan(project.files);
  for (const name of Object.keys(project.files)) {
    if (name !== MAIN && !result.includes.has(name)) {
      issues.push({ level: "note", file: name, line: 0, text: `${name} isn't in the story: no file has INCLUDE ${name}.` });
    }
  }
  const changed = json !== compiled.json;
  compiled = { json, issues, scan: result };
  showIssues();
  graph.setResult(result);
  findInGraph(false);
  $("graph-count").textContent = `${graph.count.scenes} scenes, ${graph.count.jumps} jumps in the whole story`;
  fillPlayFrom();
  if (changed && player.story) $("play-stale").hidden = false;
  if (changed) { graph.setOverlay({ unreached: new Set(), deadends: new Set() }); }
  if (!player.story && json) player.start();
  refreshCard();
  showCaret();
}

function scheduleCompile() {
  clearTimeout(scheduleCompile.timer);
  scheduleCompile.timer = setTimeout(compile, 350);
}

/* ---------- Script pane ---------- */

const backdrop = $("backdrop");

// One textarea per file, because a textarea's undo history is lost when its text is
// replaced. Only the current one shows; the rest stay laid out so they keep their scroll.
const editors = new Map();
let source = editorFor(project.current);

function editorFor(name) {
  let ed = editors.get(name);
  if (ed) return ed;
  ed = document.createElement("textarea");
  ed.className = "source off";
  ed.spellcheck = false;
  ed.setAttribute("autocapitalize", "off");
  ed.setAttribute("autocomplete", "off");
  ed.setAttribute("autocorrect", "off");
  ed.setAttribute("aria-label", `Ink script: ${name}`);
  ed.value = project.files[name] ?? "";
  ed.setSelectionRange(0, 0); // a filled textarea's caret starts at the end
  ed.addEventListener("input", () => {
    project.files[project.current] = ed.value; // only the one showing can be typed in, and a rename can change its name
    paintBackdrop();
    persist();
    showCaret();
    scheduleCompile();
  });
  ed.addEventListener("scroll", () => { backdrop.scrollTop = ed.scrollTop; }, { passive: true });
  ed.addEventListener("keydown", e => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    insertText("    ");
  });
  $("editor").append(ed);
  editors.set(name, ed);
  return ed;
}

// Bring the editors in line with the files after something other than typing changed
// them. Only a file whose words differ loses its undo.
function syncEditors() {
  for (const [name, ed] of editors) {
    if (project.files[name] === undefined) { ed.remove(); editors.delete(name); }
    else if (ed.value !== project.files[name]) {
      const { selectionStart: from, selectionEnd: to, scrollTop } = ed;
      ed.value = project.files[name];
      ed.setSelectionRange(from, to);
      ed.scrollTop = scrollTop;
    }
  }
  if (project.files[project.current] === undefined) project.current = MAIN in project.files ? MAIN : Object.keys(project.files)[0];
  showFile(project.current);
}

// At the caret, as typing would, so it can be undone. execCommand is deprecated but is
// the only way that keeps the undo history; the fallback loses it.
function insertText(text) {
  source.focus({ preventScroll: true });
  if (!document.execCommand("insertText", false, text)) {
    source.setRangeText(text, source.selectionStart, source.selectionEnd, "end");
    source.dispatchEvent(new Event("input"));
  }
}

function esc(s) { return s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

function highlightLine(line) {
  if (/^\s*={1,}\s*[A-Za-z_]/.test(line)) return `<span class="syn-knot">${esc(line)}</span>`;
  if (/^\s*(\/\/|TODO)/.test(line)) return `<span class="syn-comment">${esc(line)}</span>`;
  if (/^\s*(VAR|CONST|LIST|INCLUDE|EXTERNAL)\b|^\s*~/.test(line)) return `<span class="syn-logic">${esc(line)}</span>`;
  let html = esc(line);
  html = html.replace(/^(\s*[*+-]+(?!&gt;))/, '<span class="syn-choice">$1</span>');
  html = html.replace(/(\{[^{}]*\})/g, '<span class="syn-logic">$1</span>');
  html = html.replace(/((?:-&gt;|&lt;-)\s*[A-Za-z_][\w.]*|-&gt;-&gt;|-&gt;)/g, '<span class="syn-divert">$1</span>');
  html = html.replace(/( #[^#]*)/g, '<span class="syn-comment">$1</span>');
  return html;
}

// One <div> per line, so a line's offsetTop finds it even when words wrap.
function paintBackdrop() {
  const marks = new Map();
  for (const i of compiled.issues) {
    if (i.file === project.current && i.line && i.level !== "note") {
      if (i.level === "error" || !marks.has(i.line)) marks.set(i.line, i.level === "error" ? "err" : "warn");
    }
  }
  const lines = source.value.split("\n");
  backdrop.innerHTML = lines.map((l, i) => {
    const cls = marks.get(i + 1);
    return `<div${cls ? ` class="${cls}"` : ""}>${highlightLine(l) || "​"}</div>`;
  }).join("");
  // A visible scrollbar narrows the textarea; the copy must wrap at the same width.
  backdrop.style.right = `${source.offsetWidth - source.clientWidth}px`;
  backdrop.scrollTop = source.scrollTop;
}

function showFile(name) {
  project.current = name;
  source.classList.add("off");
  source = editorFor(name);
  source.classList.remove("off");
  paintBackdrop();
  fillFileSelect();
  persist();
  showCaret();
}

function fillFileSelect() {
  const sel = $("file-select");
  sel.replaceChildren(...Object.keys(project.files).sort((a, b) => (b === MAIN) - (a === MAIN) || a.localeCompare(b))
    .map(n => new Option(n, n, false, n === project.current)));
}

// select: take the whole line, ready to type over. focus: on a phone that opens the
// keyboard, which hides what you came to read, so reading jumps there leave it shut.
function goToLine(file, line, { select = false, focus = layoutMode() !== "narrow", pane = true } = {}) {
  if (pane) showPane("script");
  if (file !== project.current && project.files[file] !== undefined) showFile(file);
  const lines = source.value.split("\n");
  let offset = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
  if (focus || select) source.focus({ preventScroll: true });
  source.setSelectionRange(offset, offset + (select ? lines[line - 1]?.length ?? 0 : 0));
  const row = backdrop.children[line - 1];
  if (row) {
    source.scrollTop = Math.max(0, row.offsetTop - source.clientHeight / 3);
    row.classList.remove("flash");
    void row.offsetWidth; // so the animation starts again on a second jump to it
    row.classList.add("flash");
  }
  backdrop.scrollTop = source.scrollTop;
  showCaret();
}

/* ---------- Where the caret is: the scene it's in, and any jump on its line ---------- */

const TARGET = /(?:->|<-)\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/g;
let caretScene = null;
let trail = []; // where jumps came from: { file, offset }

function sceneAt(file, line) {
  let knot = file === MAIN ? compiled.scan.knots[0] : null;
  for (const k of compiled.scan.knots) {
    if (!k.isRoot && k.file === file && k.line <= line && (!knot || knot.isRoot || k.line >= knot.line)) knot = k;
  }
  const stitch = knot?.stitches.filter(s => s.line <= line).at(-1) ?? null;
  return { knot, stitch };
}

function caretLine() {
  const before = source.value.slice(0, source.selectionStart);
  const start = before.lastIndexOf("\n") + 1;
  const end = source.value.indexOf("\n", start);
  return {
    number: before.split("\n").length,
    text: source.value.slice(start, end < 0 ? undefined : end),
    column: source.selectionStart - start,
  };
}

// The place a target names, from inside a scene: a knot, knot.stitch, or a stitch here.
function findPlace(target, from) {
  const [first, second] = target.split(".");
  const knots = compiled.scan.knots;
  const knot = knots.find(k => k.name === first && !k.isRoot);
  if (knot && !second) return { file: knot.file, line: knot.line };
  const stitch = (second ? knot : from)?.stitches.find(s => s.name === (second ?? first));
  return stitch ? { file: (second ? knot : from).file, line: stitch.line } : null;
}

function jumpOnLine(line, from) {
  const text = line.text.split("//")[0];
  const found = [...text.matchAll(TARGET)]
    .filter(m => m[1] !== "END" && m[1] !== "DONE")
    .map(m => ({ target: m[1], start: m.index, end: m.index + m[0].length }));
  if (!found.length) return null;
  const jump = found.find(f => line.column >= f.start && line.column <= f.end) ?? found[0];
  const place = findPlace(jump.target, from);
  if (place) return { ...jump, place };
  // A name the scan doesn't know can be a label or a variable holding a place, so only
  // offer to create it when the compiler has said this line's target doesn't exist.
  const missing = !jump.target.includes(".") && compiled.issues.some(i =>
    i.level === "error" && i.file === project.current && i.line === line.number && i.text.includes(jump.target));
  return missing ? { ...jump, missing: true } : null;
}

function showCaret() {
  const line = caretLine();
  const { knot, stitch } = sceneAt(project.current, line.number);
  $("scene-open").textContent = `☰ ${knot ? (stitch ? `${knot.name}.${stitch.name}` : knot.name) : project.current}`;

  const go = $("jump-go");
  const jump = jumpOnLine(line, knot);
  go.hidden = !jump;
  if (jump) go.textContent = jump.missing ? `+ Create ${jump.target}` : `→ ${jump.target}`;
  go.onclick = !jump ? null : () => {
    if (jump.missing) createScene(jump.target);
    else { leaveTrail(); goToLine(jump.place.file, jump.place.line); }
  };
  $("jump-back").hidden = !trail.length;

  const name = knot?.name ?? null;
  if (name !== caretScene) {
    caretScene = name;
    if (!$("graph-card").hidden && graph.selected !== name) $("graph-card").hidden = true;
    graph.setSelected(name);
    graph.reveal(name);
  }
}
document.addEventListener("selectionchange", () => {
  if (document.activeElement === source) showCaret();
});

function leaveTrail() {
  trail.push({ file: project.current, offset: source.selectionStart });
  if (trail.length > 50) trail.shift();
}

$("jump-back").onclick = () => {
  const { file, offset } = trail.pop();
  if (project.files[file] === undefined) { showCaret(); return; }
  const line = project.files[file].slice(0, offset).split("\n").length;
  goToLine(file, line);
  source.setSelectionRange(offset, offset);
  showCaret();
};

// At the end of this file. The jump to END lets it be played at once, and it's undoable.
function createScene(name) {
  leaveTrail();
  source.setSelectionRange(source.value.length, source.value.length);
  const gap = source.value.endsWith("\n\n") || !source.value ? "" : source.value.endsWith("\n") ? "\n" : "\n\n";
  insertText(`${gap}=== ${name} ===\n// TODO: write this scene\n-> END\n`);
  clearTimeout(scheduleCompile.timer);
  compile();
  const k = compiled.scan.knots.find(x => x.name === name);
  goToLine(k.file, k.line + 1, { select: true });
}

/* ---------- Find: scenes, then the words of every file ---------- */

const MAX_FOUND = 40;
let foundRows = [];
let foundIndex = 0;

function openFind() {
  $("scene-search").value = "";
  showFound();
  $("scene-dialog").showModal();
  $("scene-search").focus();
}

function foundRow(title, place, target, isCurrent) {
  const b = document.createElement("button");
  b.className = `found${isCurrent ? " here" : ""}`;
  const t = document.createElement("span");
  t.className = "found-title";
  t.textContent = title;
  const p = document.createElement("span");
  p.className = "found-place";
  p.textContent = place;
  b.append(t, p);
  b.tabIndex = -1;
  b.onclick = () => {
    $("scene-dialog").close();
    leaveTrail();
    goToLine(target.file, target.line);
  };
  return b;
}

function showFound() {
  const q = $("scene-search").value.trim().toLowerCase();
  const list = $("scene-list");
  const rows = [];
  const scenes = [];
  for (const k of compiled.scan.knots) {
    if (k.isRoot) continue;
    const where = `${k.isFunction ? "function · " : ""}${k.file}:${k.line}`;
    if (!q || k.name.toLowerCase().includes(q)) scenes.push(foundRow(k.name, where, k, k.name === caretScene));
    for (const s of k.stitches) {
      const full = `${k.name}.${s.name}`;
      if (!q || full.toLowerCase().includes(q)) scenes.push(foundRow(full, `${k.file}:${s.line}`, { file: k.file, line: s.line }, false));
    }
  }
  rows.push(...scenes);

  const words = [];
  let wordsTotal = 0;
  if (q.length >= 2) {
    for (const [file, text] of Object.entries(project.files)) {
      text.split("\n").forEach((raw, i) => {
        if (!raw.toLowerCase().includes(q)) return;
        wordsTotal++;
        if (words.length >= MAX_FOUND) return;
        const { knot } = sceneAt(file, i + 1);
        words.push(foundRow(raw.trim(), `${knot?.name ?? file} · ${file}:${i + 1}`, { file, line: i + 1 }, false));
      });
    }
  }

  const parts = [];
  const heading = text => {
    const h = document.createElement("h3");
    h.textContent = text;
    return h;
  };
  if (scenes.length && q) parts.push(heading("Scenes"));
  parts.push(...scenes);
  if (words.length) parts.push(heading(wordsTotal > words.length ? `In the words: first ${words.length} of ${wordsTotal}` : "In the words"), ...words);
  if (!scenes.length && !words.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = q ? "Nothing found." : "No scenes yet.";
    parts.push(p);
  }
  list.replaceChildren(...parts);
  foundRows = [...scenes, ...words];
  const current = q ? -1 : foundRows.findIndex(r => r.classList.contains("here"));
  markFound(Math.max(0, current));
}

function markFound(i) {
  foundRows[foundIndex]?.classList.remove("active");
  foundIndex = i;
  const row = foundRows[i];
  if (!row) return;
  row.classList.add("active");
  row.scrollIntoView({ block: "nearest" });
}

$("scene-open").onclick = openFind;
$("scene-search").addEventListener("input", showFound);
$("scene-search").addEventListener("keydown", e => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (foundRows.length) markFound((foundIndex + (e.key === "ArrowDown" ? 1 : foundRows.length - 1)) % foundRows.length);
  } else if (e.key === "Enter") {
    e.preventDefault();
    foundRows[foundIndex]?.click();
  }
});
$("scene-dialog").addEventListener("click", e => {
  if (e.target === $("scene-dialog")) $("scene-dialog").close();
});
addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (!$("scene-dialog").open) openFind();
  }
});

function showIssues() {
  paintBackdrop();
  const order = { error: 0, warning: 1, note: 2 };
  const list = [...compiled.issues].sort((a, b) => order[a.level] - order[b.level]);
  $("issues").replaceChildren(...list.map(i => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.className = i.level;
    b.textContent = (i.line ? `${i.file}:${i.line}  ` : "") + i.text;
    b.onclick = () => i.line ? goToLine(i.file, i.line) : showFile(i.file in project.files ? i.file : project.current);
    li.append(b);
    return li;
  }));
}

$("file-select").onchange = e => showFile(e.target.value);
$("new-file").onclick = () => {
  let name = prompt("File name, for example town.ink");
  if (!name) return;
  name = name.trim();
  if (!name.endsWith(".ink")) name += ".ink";
  if (!/^[\w.-]+$/.test(name)) { alert("Use letters, numbers, dots, dashes and underscores."); return; }
  if (name in project.files) { showFile(name); return; }
  project.files[name] = "";
  showFile(name);
  compile();
};

// A synced file is removed from GitHub at the next sync. Its history stays there.
function forgetFile(name) {
  if (project.synced[name]) {
    project.deleted[name] = project.synced[name].sha;
    project.removed[name] = Date.now();
  }
  delete project.synced[name];
  delete project.files[name];
}

function renameFile(from, to) {
  project.files[to] = project.files[from];
  forgetFile(from);
  const include = new RegExp(`^(\\s*INCLUDE\\s+)${from.replace(/[.]/g, "\\.")}(\\s*)$`, "m");
  for (const [name, text] of Object.entries(project.files)) project.files[name] = text.replace(include, `$1${to}$2`);
  // Its editor, with its undo, goes with it.
  const ed = editors.get(from);
  if (ed) { editors.delete(from); editors.set(to, ed); }
  if (project.current === from) project.current = to;
  for (const step of trail) if (step.file === from) step.file = to;
}

$("file-menu").onclick = () => {
  const locked = project.current === MAIN;
  const removed = Object.keys(project.removed).filter(n => project.files[n] === undefined)
    .sort((a, b) => project.removed[b] - project.removed[a]).slice(0, 20);
  $("file-removed").hidden = !removed.length;
  $("file-removed-list").replaceChildren(...removed.map(n => {
    const b = document.createElement("button");
    b.textContent = n;
    b.onclick = () => { $("file-dialog").close(); openHistory(n); };
    return b;
  }));
  $("file-title").textContent = project.current;
  $("file-locked").hidden = !locked;
  $("file-actions").hidden = locked;
  $("file-delete").hidden = locked;
  $("file-rename").hidden = locked;
  $("file-name").value = project.current;
  $("file-message").textContent = "";
  $("file-dialog").showModal();
};
$("file-close").onclick = () => $("file-dialog").close();
$("file-history").onclick = () => { $("file-dialog").close(); openHistory(project.current); };
$("file-rename").onclick = () => {
  const from = project.current;
  let to = $("file-name").value.trim();
  if (!to.endsWith(".ink")) to += ".ink";
  const msg = $("file-message");
  msg.className = "message bad";
  if (!/^[\w.-]+$/.test(to)) { msg.textContent = "Use letters, numbers, dots, dashes and underscores."; return; }
  if (to !== from && to in project.files) { msg.textContent = `There's already a ${to}.`; return; }
  $("file-dialog").close();
  if (to === from) return;
  renameFile(from, to);
  syncEditors();
  compile();
};
$("file-delete").onclick = () => {
  const name = project.current;
  const onGitHub = !!project.synced[name];
  const others = Object.keys(project.files).filter(n => new RegExp(`^\\s*INCLUDE\\s+${name.replace(/[.]/g, "\\.")}\\s*$`, "m").test(project.files[n]));
  const warn = others.length ? ` ${others.join(", ")} still includes it, which will be an error until you take that line out.` : "";
  const end = onGitHub ? "It stays in GitHub's history." : "It has never been synced, so it can't be got back.";
  if (!confirm(`Delete ${name}? ${end}${warn}`)) return;
  $("file-dialog").close();
  forgetFile(name);
  syncEditors();
  compile();
};

/* ---------- Graph pane ---------- */

const graph = new Graph($("graph"), {
  moved: loadJson("suratan:graph-moved", {}),
  onMoved(moved) { saveJson("suratan:graph-moved", moved); },
  covered: () => $("graph-card").hidden ? 0 : $("graph-card").offsetHeight + 10,
  onSelect(name) {
    // With the script beside it, the script follows. The keyboard's focus stays put.
    // First, because moving the caret to another scene closes the card.
    const k = name && compiled.scan.knots.find(x => x.name === name);
    if (k && !k.isRoot && layoutMode() !== "narrow") goToLine(k.file, k.line, { focus: false, pane: false });
    showCard(name);
    graph.setSelected(name);
    if (name && graph.shownFocus()) graph.fit(); // the card has just taken up some of the pane
  },
});

// The scene's card. Everything on it is read from the scan, so it's made again whenever
// the scan changes.
function refreshCard() {
  if ($("graph-card").hidden) return;
  showCard(graph.selected);
}

function showCard(name) {
  const card = $("graph-card");
  if (!name) { card.hidden = true; return; }
  const k = compiled.scan.knots.find(x => x.name === name);
  if (!k) { card.hidden = true; return; }
  const out = compiled.scan.edges.filter(e => e.from === name);
  const into = compiled.scan.edges.filter(e => e.to === name);

  card.replaceChildren();
  const h = document.createElement("h3");
  h.textContent = name;
  const sub = document.createElement("div");
  sub.className = "muted";
  sub.textContent = `${k.file}:${k.line} · from ${new Set(into.map(e => e.from)).size} · to ${new Set(out.map(e => e.to)).size}`;
  card.append(h, sub);
  if (k.stitches.length) {
    const s = document.createElement("div");
    s.className = "muted";
    s.textContent = "Stitches: " + k.stitches.map(x => x.name).join(", ");
    card.append(s);
  }
  if (out.length) {
    const ul = document.createElement("ul");
    for (const e of out) {
      const li = document.createElement("li");
      li.textContent = `${e.label || "(goes on)"} → ${e.to}${e.conditional ? " (if)" : ""}`;
      ul.append(li);
    }
    card.append(ul);
  }
  const row = document.createElement("div");
  row.className = "row wrap";
  if (!graph.shownFocus()) {
    const focus = document.createElement("button");
    focus.textContent = "Focus";
    focus.onclick = () => setGraphFocus(true, name);
    row.append(focus);
  }
  const open = document.createElement("button");
  open.textContent = "Open script";
  open.onclick = () => goToLine(k.file, k.line);
  row.append(open);
  if (!k.isRoot) {
    const play = document.createElement("button");
    play.textContent = "Play from here";
    play.onclick = () => { showPane("play"); player.start(name); };
    row.append(play);
  }
  card.append(row);
  card.hidden = false;
}

$("graph-fit").onclick = () => graph.fit();
$("graph-all").onclick = () => graph.fitAll();

function setGraphFocus(on, name) {
  graph.setFocus(on, name);
  $("graph-focus").setAttribute("aria-pressed", on);
  refreshCard();
}
$("graph-focus").onclick = () => setGraphFocus(!graph.focusOn);

// The search. Typing marks what matches and shows the first; Enter steps through them.
let graphMatches = [];
let graphMatchAt = -1;

function findInGraph(showFirst = true) {
  const q = $("graph-find").value.trim().toLowerCase();
  graphMatches = !q ? [] : compiled.scan.knots
    .filter(k => !k.isRoot && !k.isFunction && k.name.toLowerCase().includes(q))
    .map(k => k.name);
  if (graphMatchAt >= graphMatches.length || showFirst) graphMatchAt = -1;
  graph.setFound(q ? new Set(graphMatches) : null);
  $("graph-found").textContent = !q ? "" : graphMatches.length ? `${graphMatches.length} found` : "none";
  if (showFirst && graphMatches.length && !graph.shownFocus()) graph.reveal(graphMatches[0], true);
}

function stepInGraph() {
  if (!graphMatches.length) return;
  graphMatchAt = (graphMatchAt + 1) % graphMatches.length;
  const name = graphMatches[graphMatchAt];
  graph.onSelect(name);
  graph.reveal(name, true);
  $("graph-found").textContent = `${graphMatchAt + 1} of ${graphMatches.length}`;
}

$("graph-find").addEventListener("input", () => findInGraph());
$("graph-find").addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    stepInGraph();
    if (layoutMode() === "narrow") e.target.blur(); // the keyboard would hide what was found
  } else if (e.key === "Escape") {
    e.target.value = "";
    findInGraph();
  }
});

addEventListener("pointerdown", e => {
  if (!e.target.closest("#graph-more")) $("graph-more").open = false;
});
$("graph-tidy").onclick = () => {
  if (graph.moved.size && !confirm("Put every scene you moved back in its automatic place?")) return;
  graph.tidy();
};
$("graph-hubs").onchange = e => { graph.collapseHubs = e.target.checked; graph.draw(); };
$("graph-labels").onchange = e => { graph.showLabels = e.target.checked; graph.draw(); };

/* ---------- Play pane ---------- */

const player = {
  story: null,
  history: [],
  from: null,

  // A new story from what this play began with, even if the script has changed since.
  fresh() {
    const s = new inkjs.Story(this.json);
    s.onError = (message, type) => {
      if (type === 2) this.errors.push(humanError(message));
    };
    for (const name of this.externals) {
      s.BindExternalFunctionGeneral(name, args => {
        addLine(sysLine(`The game would call ${name}(${args.join(", ")}). Here it just succeeds.`));
        return 1;
      }, false);
    }
    return s;
  },

  // path: a scene to begin at. replay: { seed, choices } from the bot.
  start(path = null, replay = null) {
    if (!compiled.json) {
      this.story = null;
      $("transcript").replaceChildren(sysLine("Fix the errors in the script to play.", "fail"));
      $("choices").replaceChildren();
      return;
    }
    this.from = path;
    this.json = compiled.json;
    this.externals = compiled.scan.externals;
    const s = this.fresh();
    this.story = s;
    this.history = [];
    $("play-stale").hidden = true;
    $("transcript").replaceChildren();
    $("choices").replaceChildren();
    // Held back to the end of the line, so it reads after the words that led to it.
    this.errors = [];
    if (replay) {
      s.state.storySeed = replay.seed;
      s.state.previousRandom = 0;
    }
    if (path) {
      try { s.ChoosePathString(path); }
      catch (e) { addLine(sysLine(e.message, "fail")); return; }
    }
    this.advance();
    if (replay) {
      for (const pick of replay.choices) {
        if (!s.currentChoices[pick]) break;
        this.choose(pick);
      }
    }
  },

  advance() {
    const s = this.story;
    try {
      while (s.canContinue) {
        const began = Date.now();
        do { s.ContinueAsync(50); }
        while (!s.asyncContinueComplete && Date.now() - began < 2000);
        if (!s.asyncContinueComplete) {
          addLine(sysLine("The story is looping here with no choices for the player.", "fail"));
          this.story = null;
          $("choices").replaceChildren();
          return;
        }
        addStoryLine(s.currentText, s.currentTags);
      }
    } catch (e) {
      this.errors.push(s.asyncContinueComplete ? humanError(e.message) : crashError(e.message));
    }
    this.broke = this.errors.length > 0;
    for (const m of this.errors) addLine(sysLine(m, "fail"));
    this.errors = [];
    this.show();
  },

  show() {
    const s = this.story;
    showState(s);
    const choices = s.currentChoices;
    if (choices[0]?.sourcePath) graph.setCurrent(choices[0].sourcePath.split(".")[0]);
    $("choices").replaceChildren(...choices.map((c, i) => {
      const b = document.createElement("button");
      b.textContent = c.text;
      b.onclick = () => this.choose(i);
      return b;
    }));
    if (!choices.length && !this.broke) addLine(sysLine("End of the story."));
    const t = $("transcript");
    t.scrollTop = t.scrollHeight;
  },

  choose(i) {
    const s = this.story;
    this.history.push({ state: s.state.ToJson(), lines: $("transcript").childElementCount });
    const p = document.createElement("p");
    p.className = "picked";
    p.textContent = s.currentChoices[i].text;
    addLine(p);
    s.ChooseChoiceIndex(i);
    this.advance();
  },

  back() {
    const h = this.history.pop();
    if (!h || !this.story) return;
    // An error Ink doesn't handle itself leaves it mid-line, and the next line would
    // then begin with the old words still in it.
    if (!this.story.asyncContinueComplete) this.story = this.fresh();
    this.story.state.LoadJson(h.state);
    const t = $("transcript");
    while (t.childElementCount > h.lines) t.lastElementChild.remove();
    this.show();
  },
};

// What Ink calls these, in the words the script uses.
const INK_OPERATOR = { _: "a minus sign", "!": "not", "&&": "and", "||": "or", "%": "mod" };
const INK_TYPE = { String: "text", Int: "a whole number", Float: "a decimal", List: "a list", DivertTarget: "a scene" };

function humanError(message) {
  // Ink's place in its compiled story means nothing here. The scene is named separately.
  const text = message.replace(/^RUNTIME ERROR: \(Ink Pointer [^)]*\): /, "");
  if (/ran out of content/.test(text)) {
    return "Dead end: the story runs out here, with no jump, choice or -> END.";
  }
  if (/Divide by zero/.test(text)) { // from ink-guard.js
    return "Divide by zero: a sum here divides by 0, or takes mod 0.";
  }
  let m = text.match(/^Cannot perform operation (\S+) on (\w+)/);
  if (m) return `Can't use ${INK_OPERATOR[m[1]] || m[1]} on ${INK_TYPE[m[2]] || m[2]}. Check what the variables in this line hold.`;
  m = text.match(/^Tried to divert to a target from a variable, but the variable \((.+?)\) didn't contain a divert target, it contained '(.*)'/s);
  if (m) return `-> ${m[1]} can't go anywhere: ${m[1]} should hold a scene, but it holds ${m[2]}.`;
  if (/on a void value/.test(text)) return "A sum here uses a function that gives back nothing. Does the function need ~ return?";
  if (/^Found tunnel onwards statement/.test(text)) return "->-> here has nothing to go back to. Reach this scene with -> scene ->, or end it with -> END.";
  return text;
}

// An error Ink doesn't handle itself: its words are about its own code, not the story,
// and nothing says which line. The cause named is the one we've found.
function crashError(message) {
  return `Ink stopped here without saying why. It does this on ->-> to something that isn't a scene, and maybe on other things. Its own words: "${message}"`;
}

function sysLine(text, cls = "sys") {
  const p = document.createElement("p");
  p.className = cls;
  p.textContent = text;
  return p;
}
function addLine(node) { $("transcript").append(node); }

function addStoryLine(text, tags) {
  if (!text.trim() && !tags?.length) return;
  const p = document.createElement("p");
  const speakerTag = tags?.find(t => /^speaker:/i.test(t));
  if (speakerTag) {
    const s = document.createElement("span");
    s.className = "speaker";
    s.textContent = speakerTag.split(":")[1].trim();
    p.append(s);
  }
  p.append(text.trim());
  for (const t of tags || []) {
    if (t === speakerTag) continue;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `#${t}`;
    p.append(tag);
  }
  addLine(p);
}

// The variables, live and editable, so a case can be tried without playing up to it.
function showState(s) {
  const box = $("play-state");
  const active = document.activeElement;
  if (active && box.contains(active) && active.tagName === "INPUT" && active.type !== "checkbox") return;
  box.replaceChildren(...compiled.scan.vars.map(({ name }) => {
    let value;
    try { value = s.variablesState.$(name); } catch { return document.createTextNode(""); }
    const label = document.createElement("label");
    label.append(name);
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
      const input = document.createElement("input");
      if (typeof value === "boolean") { input.type = "checkbox"; input.checked = value; }
      else if (typeof value === "number") { input.type = "number"; input.value = value; input.step = "any"; input.inputMode = "decimal"; }
      else { input.className = "text"; input.value = value; }
      input.onchange = () => {
        const next = input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value;
        try {
          const vars = player.story?.variablesState;
          const now = vars?.GetVariableWithName(name);
          // Ink takes any whole number as an int, but a decimal variable stays a decimal.
          if (Number.isInteger(next) && typeof now?.value === "number") vars.SetGlobal(name, new now.constructor(next));
          else vars?.$(name, next);
        } catch (e) { addLine(sysLine(e.message, "fail")); }
      };
      label.append(input);
    } else {
      const span = document.createElement("span");
      span.className = "list";
      span.textContent = String(value) || "(empty)";
      label.append(": ", span);
    }
    return label;
  }));
}

function fillPlayFrom() {
  const sel = $("play-from");
  const keep = sel.value;
  const options = [new Option("From the start", "")];
  for (const k of compiled.scan.knots) {
    if (k.isRoot || k.isFunction) continue;
    options.push(new Option(k.name, k.name));
    for (const st of k.stitches) options.push(new Option(`  ${k.name}.${st.name}`, `${k.name}.${st.name}`));
  }
  sel.replaceChildren(...options);
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
}

$("play-restart").onclick = () => player.start($("play-from").value || null);
$("play-back").onclick = () => player.back();
$("play-from").onchange = e => player.start(e.target.value || null);

/* ---------- Check pane ---------- */

let worker = null;

function runCheck() {
  const out = $("check-out");
  if (!compiled.json) {
    out.replaceChildren(sysLine("Fix the errors in the script first.", "fail"));
    return;
  }
  worker?.terminate();
  const button = $("check-run");
  button.disabled = true;
  button.textContent = "Playing…";
  const progress = sysLine("Starting…");
  out.replaceChildren(progress);

  const json = compiled.json;
  const scanned = compiled.scan;
  const finish = () => { button.disabled = false; button.textContent = "Run the bot"; };
  const paths = reachablePaths(scanned);
  worker = new Worker("check-worker.js");
  // The worker's own limit should end it first; this catches a Continue that never returns.
  const watchdog = setTimeout(() => {
    worker.terminate();
    out.replaceChildren(sysLine("The bot got stuck and was stopped. The story probably has a loop with no choices.", "fail"));
    finish();
  }, 90000);
  worker.onerror = e => {
    clearTimeout(watchdog);
    out.replaceChildren(sysLine(`The bot failed: ${e.message}`, "fail"));
    finish();
  };
  worker.onmessage = ({ data }) => {
    if (data.type === "progress") { progress.textContent = `Playing… ${data.done} of ${data.runs}`; return; }
    clearTimeout(watchdog);
    worker.terminate();
    finish();
    showCheck(data, paths, scanned);
  };
  worker.postMessage({
    json, externals: scanned.externals, paths,
    runs: Number($("check-runs").value) || 1000,
    maxSteps: Number($("check-steps").value) || 200,
  });
}

function tile(value, label, cls = "") {
  const d = document.createElement("div");
  d.className = `tile ${cls}`;
  const b = document.createElement("b");
  b.textContent = value;
  const s = document.createElement("span");
  s.textContent = label;
  d.append(b, s);
  return d;
}

function showCheck(data, paths, scanned) {
  const { totals, reached, problems, stoppedEarly } = data;
  const out = $("check-out");
  out.replaceChildren();
  const unreached = paths.filter(p => reached[p] === 0);
  const deadends = problems.filter(p => p.kind === "deadend");
  const other = problems.filter(p => p.kind !== "deadend");

  const tiles = document.createElement("div");
  tiles.className = "tiles";
  tiles.append(
    tile(totals.runs, "runs played"),
    tile(unreached.length, "never reached", unreached.length ? "bad" : "ok"),
    tile(deadends.length, "dead ends", deadends.length ? "bad" : "ok"),
    tile(other.length, "other errors", other.length ? "bad" : "ok"),
    tile(totals.ended, "reached an ending"),
    tile(totals.capped, "ran out of choices"),
  );
  out.append(tiles);
  if (stoppedEarly) out.append(sysLine("The bot stopped early, so these counts are partial."));
  if (!unreached.length && !problems.length) out.append(sysLine("Nothing wrong found in these runs. That doesn't prove nothing is wrong."));

  const heading = t => { const h = document.createElement("h3"); h.textContent = t; out.append(h); };
  const finding = (text, actions) => {
    const row = document.createElement("div");
    row.className = "finding";
    const w = document.createElement("span");
    w.className = "what";
    w.textContent = text;
    row.append(w);
    for (const [label, fn] of actions) {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = fn;
      row.append(b);
    }
    out.append(row);
  };
  const lineOf = message => {
    const m = message.match(/(?:'(.+?)' )?line (\d+)/);
    return m ? { file: m[1] || MAIN, line: +m[2] } : null;
  };
  const placeOf = p => {
    const k = p.at && scanned.knots.find(x => x.name === p.at.split(".")[0]);
    if (!k) return null;
    const st = k.stitches.find(x => x.name === p.at.split(".")[1]);
    return { file: k.file, line: st ? st.line : k.line, knot: k.name };
  };
  const replay = p => () => { showPane("play"); player.start(null, { seed: p.seed, choices: p.choices }); };

  if (unreached.length) {
    heading("Never reached in these runs");
    for (const p of unreached) {
      const k = scanned.knots.find(x => x.name === p.split(".")[0]);
      const line = p.includes(".") ? k.stitches.find(s => s.name === p.split(".")[1]).line : k.line;
      finding(p, [["Open", () => goToLine(k.file, line)], ["Play from here", () => { showPane("play"); player.start(p); }]]);
    }
  }
  if (deadends.length) {
    heading("Dead ends");
    for (const p of deadends) {
      const at = placeOf(p);
      finding(`${p.at || "Somewhere"}: the story runs out here (${p.count} runs)`, [
        ...(at ? [["Open", () => goToLine(at.file, at.line)]] : []),
        ["Replay", replay(p)],
      ]);
    }
  }
  if (other.length) {
    heading("Other errors");
    for (const p of other) {
      const at = lineOf(p.message) || placeOf(p);
      const text = p.kind === "crash" ? crashError(p.message) : humanError(p.message);
      finding(`${p.at ? `${p.at}: ` : ""}${text} (${p.count} runs)`, [
        ...(at ? [["Open", () => goToLine(at.file, at.line)]] : []),
        ["Replay", replay(p)],
      ]);
    }
  }

  if (paths.length) {
    heading("How often runs reached each scene");
    const grid = document.createElement("div");
    grid.className = "cover";
    const sorted = [...paths].sort((a, b) => reached[a] - reached[b]);
    for (const p of sorted) {
      const share = totals.runs ? reached[p] / totals.runs : 0;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = p;
      const track = document.createElement("div");
      track.className = "track";
      const fill = document.createElement("div");
      fill.className = "fill";
      fill.style.width = `${(share * 100).toFixed(1)}%`;
      track.append(fill);
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = `${Math.round(share * 100)}%`;
      grid.append(name, track, num);
    }
    out.append(grid);
  }

  const deadKnots = new Set();
  for (const p of deadends) {
    const at = placeOf(p);
    if (at) deadKnots.add(at.knot);
  }
  graph.setOverlay({ unreached: new Set(unreached.map(p => p.split(".")[0]).filter(n => unreached.includes(n))), deadends: deadKnots });
}

$("check-run").onclick = runCheck;

/* ---------- Panes: which show depends on the window's width ---------- */

let tabbed = "play"; // the pane in the tabbed slot, or the only one on a phone
let phonePane = "script";

function layoutMode() {
  const w = $("panes").clientWidth || innerWidth;
  return w >= 1180 ? "wide" : w >= 720 ? "medium" : "narrow";
}

function showPane(name) {
  const mode = layoutMode();
  if (mode === "narrow") phonePane = name;
  else if (name !== "script" && !(mode === "wide" && name === "graph")) tabbed = name;
  applyLayout();
}

function applyLayout() {
  const mode = layoutMode();
  let shown;
  if (mode === "wide") shown = ["script", "graph", tabbed === "graph" ? "play" : tabbed];
  else if (mode === "medium") shown = ["script", tabbed];
  else shown = [phonePane];

  for (const pane of document.querySelectorAll(".pane")) {
    pane.classList.toggle("shown", shown.includes(pane.dataset.pane));
  }
  for (const b of document.querySelectorAll("#tabs button")) {
    const t = b.dataset.tab;
    // On wide, script and graph always show, so only the third slot needs tabs.
    b.classList.toggle("hide", (mode === "wide" && (t === "script" || t === "graph")) || (mode === "medium" && t === "script"));
    b.classList.toggle("active", shown.includes(t));
  }
  if (shown.includes("graph")) {
    requestAnimationFrame(() => {
      if (!graph.hasFit) graph.fit();
      graph.reveal(graph.selected);
    });
  }
  if (shown.includes("script")) paintBackdrop();
  showSyncState();
}

for (const b of document.querySelectorAll("#tabs button")) b.onclick = () => showPane(b.dataset.tab);
addEventListener("resize", applyLayout);

/* ---------- Sync ---------- */

let syncing = false;
let syncError = "";
const conflicts = new Set(); // files sync by itself found changed in both places
let lastSyncAt = 0;
let autoTimer = null;
let noteDismissed = false;

const AUTO_PAUSE = 60 * 1000; // after the last edit, so a working session isn't a commit a minute
const AUTO_RETRY = 5 * 60 * 1000; // after a failure or with a conflict waiting
const NOTE_AFTER = 5 * 60 * 1000; // a brief loss of signal isn't worth a note

function planAutoSync() {
  clearTimeout(autoTimer);
  if (!github.token || !github.auto || syncing || !dirtyCount()) return;
  autoTimer = setTimeout(() => {
    if (document.querySelector("dialog[open]")) { planAutoSync(); return; }
    sync({ auto: true });
  }, syncError || conflicts.size ? AUTO_RETRY : AUTO_PAUSE);
}

// Leaving is the moment to try, as a phone may not run again for hours; coming back,
// another device may have written something.
function syncOnReturn() {
  if (!github.token || !github.auto || !navigator.onLine) return;
  if (document.querySelector("dialog[open]")) return;
  if (document.visibilityState === "hidden") { if (dirtyCount()) sync({ auto: true }); return; }
  if (Date.now() - lastSyncAt > 60 * 1000) sync({ auto: true });
}
document.addEventListener("visibilitychange", syncOnReturn);
addEventListener("online", syncOnReturn);

function minutes(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
}

function showNote(text, action, run, { bad = false, dismiss = false } = {}) {
  const note = $("sync-note");
  note.hidden = !text;
  if (!text) return;
  note.classList.toggle("bad", bad);
  $("sync-note-text").textContent = text;
  $("sync-note-do").hidden = !action;
  $("sync-note-do").textContent = action || "";
  $("sync-note-do").onclick = run;
  $("sync-note-close").hidden = !dismiss;
}

// The note under the header: only for what needs a person.
function showSyncNote(dirty) {
  const syncNow = () => sync().catch(() => {});
  const age = project.dirtySince ? Date.now() - project.dirtySince : 0;
  if (saveFailed) {
    showNote("This browser refused to save your latest words. Keep this page open, and sync or copy them out.", github.token ? "Sync now" : "", syncNow, { bad: true });
  } else if (conflicts.size) {
    const names = [...conflicts].join(", ");
    showNote(`${names} changed here and on GitHub. Your words are safe on this device.`, "Decide", syncNow, { bad: true });
  } else if (github.token && syncError && !/^Can't reach/.test(syncError)) {
    showNote(`Sync failed: ${syncError} Your words are safe on this device.`, "Try again", syncNow, { bad: true });
  } else if (github.token && dirty && age > NOTE_AFTER) {
    const why = navigator.onLine ? "GitHub can't be reached" : "offline";
    showNote(`Not synced for ${minutes(age)} (${why}). Your words are safe on this device, but only here.`, navigator.onLine ? "Try again" : "", syncNow);
  } else if (!github.token && !noteDismissed && (Object.keys(project.files).length > 1 || project.files[MAIN] !== SAMPLE)) {
    showNote("These words are only on this device. Connect GitHub to keep them safe, and to have earlier versions.", "Connect", openSettings, { dismiss: true });
  } else {
    showNote("");
  }
}
$("sync-note-close").onclick = () => { noteDismissed = true; showNote(""); };
setInterval(() => showSyncState(), 30 * 1000); // the note's "for 12 min" stays true

function dirtyCount() {
  return Object.keys(project.files).filter(n => project.files[n] !== project.synced[n]?.text).length + Object.keys(project.deleted).length;
}

function showSyncState() {
  const el = $("sync-state");
  const dirty = dirtyCount();
  el.className = "sync-state";
  showSyncNote(dirty);
  if (saveFailed) {
    el.textContent = "Not saved: this browser refused";
    el.classList.add("bad");
  } else if (syncing) {
    el.textContent = "Syncing…";
  } else if (syncError) {
    el.textContent = "Sync failed";
    el.title = syncError;
    el.classList.add("bad");
  } else if (!github.token) {
    // A phone's header has room for about ten letters.
    el.textContent = layoutMode() === "narrow" ? "Local only" : "On this device only";
    el.title = "On this device only: connect GitHub in settings to sync";
    el.classList.add("dirty");
  } else if (dirty) {
    el.textContent = `${dirty} not synced`;
    el.classList.add("dirty");
  } else {
    el.textContent = "Synced";
  }
}

function askConflict(name) {
  const d = $("conflict-dialog");
  $("conflict-title").textContent = name;
  d.showModal();
  return new Promise(resolve => {
    const done = v => () => { d.close(); resolve(v); };
    $("conflict-mine").onclick = done("mine");
    $("conflict-theirs").onclick = done("theirs");
    $("conflict-skip").onclick = done("skip");
  });
}

function copyName(name) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return name.replace(/\.ink$/, `.mine-${stamp}.ink`);
}

async function resolveConflict(gh, name, remoteSha, auto) {
  // Sync by itself doesn't interrupt: it says so, and a Sync pressed by hand asks.
  if (auto) { conflicts.add(name); return; }
  const choice = await askConflict(name);
  if (choice === "mine") {
    project.synced[name] = { sha: await gh.write(name, project.files[name], remoteSha), text: project.files[name] };
  } else if (choice === "theirs") {
    project.files[copyName(name)] = project.files[name];
    const { text, sha } = await gh.read(name);
    project.files[name] = text;
    project.synced[name] = { sha, text };
  }
}

// auto: started by itself rather than by a person, so it doesn't open anything.
// Typing goes on during a sync, so a file is only replaced if it's still the words that
// were looked at; otherwise it's left for the next one.
async function sync({ auto = false } = {}) {
  if (!github.token) { if (!auto) openSettings(); return; }
  if (syncing) return;
  clearTimeout(autoTimer);
  syncing = true;
  syncError = "";
  conflicts.clear();
  lastSyncAt = Date.now();
  showSyncState();
  $("sync").disabled = true;
  const gh = new GitHub(github);
  try {
    // What's known about the last sync says nothing about a different place.
    const place = `${github.repo}/${github.branch}/${github.dir}`;
    if (project.syncedFrom && project.syncedFrom !== place) { project.synced = {}; project.deleted = {}; }
    project.syncedFrom = place;

    const remote = await gh.list();
    // Deleted here. If GitHub's copy has changed since, those words are news: keep them,
    // so nothing is lost, and the loop below brings the file back.
    for (const [name, sha] of Object.entries(project.deleted)) {
      if (remote[name] === sha && project.files[name] === undefined) {
        try { await gh.remove(name, sha); delete remote[name]; }
        catch (e) { if (!(e instanceof Conflict)) throw e; }
      }
      delete project.deleted[name];
    }
    const removedElsewhere = Object.keys(remote).length > 0; // an empty list can mean the folder moved
    for (const [name, sha] of Object.entries(remote)) {
      const local = project.files[name];
      const base = project.synced[name];
      if (local === undefined) {
        const f = await gh.read(name);
        if (project.files[name] !== undefined) continue;
        project.files[name] = f.text;
        project.synced[name] = { sha: f.sha, text: f.text };
      } else if (base?.sha === sha) {
        if (local !== base.text) {
          try { project.synced[name] = { sha: await gh.write(name, local, sha), text: local }; }
          catch (e) {
            if (!(e instanceof Conflict)) throw e;
            const fresh = await gh.list();
            await resolveConflict(gh, name, fresh[name], auto);
          }
        }
      } else if (!base || local === base.text) {
        // First sync on this device, or nothing changed here: GitHub's is the one,
        // unless this device has never seen the file and holds different words.
        const f = await gh.read(name);
        if (project.files[name] !== local) continue;
        if (!base && local !== f.text && !(name === MAIN && local === SAMPLE)) {
          await resolveConflict(gh, name, sha, auto);
        } else {
          project.files[name] = f.text;
          project.synced[name] = { sha: f.sha, text: f.text };
        }
      } else {
        const f = await gh.read(name);
        if (project.files[name] !== local) continue;
        if (f.text === local) project.synced[name] = { sha: f.sha, text: f.text };
        else await resolveConflict(gh, name, sha, auto);
      }
    }
    for (const name of Object.keys(project.files)) {
      if (remote[name] !== undefined) continue;
      const text = project.files[name];
      // Synced before and gone now: another device deleted it. Unless this device has
      // changed it since, in which case those words go back up.
      if (removedElsewhere && name !== MAIN && project.synced[name]?.text === text) {
        delete project.files[name];
        delete project.synced[name];
        continue;
      }
      project.synced[name] = { sha: await gh.write(name, text, null), text };
    }
    syncEditors();
    compile();
  } catch (e) {
    syncError = e.message;
    if (!auto) throw e;
  } finally {
    syncing = false;
    $("sync").disabled = false;
    persist();
  }
}

function fillSettings() {
  $("gh-repo").value = github.repo;
  $("gh-branch").value = github.branch;
  $("gh-dir").value = github.dir;
  $("gh-token").value = github.token;
  $("gh-auto").checked = github.auto;
  $("gh-message").textContent = "";
  $("gh-message").className = "message";
}
function openSettings() { fillSettings(); $("settings-dialog").showModal(); }

$("settings").onclick = openSettings;
$("gh-close").onclick = () => $("settings-dialog").close();
$("gh-auto").onchange = e => {
  github.auto = e.target.checked;
  saveJson("suratan:github", github);
  planAutoSync();
};
$("gh-forget").onclick = () => {
  github.token = "";
  saveJson("suratan:github", github);
  fillSettings();
  showSyncState();
};
$("gh-save").onclick = async () => {
  Object.assign(github, {
    repo: $("gh-repo").value.trim(),
    branch: $("gh-branch").value.trim(),
    dir: $("gh-dir").value.trim(),
    token: $("gh-token").value.trim(),
  });
  saveJson("suratan:github", github);
  const msg = $("gh-message");
  try {
    msg.className = "message";
    msg.textContent = "Syncing…";
    await sync();
    msg.className = "message ok";
    msg.textContent = "Connected and synced.";
  } catch (e) {
    msg.className = "message bad";
    msg.textContent = e.message;
  }
};
$("sync").onclick = () => sync().catch(() => {});

/* ---------- Earlier versions: GitHub's history of a file ---------- */

const MAX_DIFF_LINES = 4000; // past this a line-by-line comparison would hang a phone
const history = { name: null, page: 1, rows: [], chosen: null, cache: new Map() };

function historyMessage(text, bad = false) {
  $("history-message").textContent = text;
  $("history-message").className = `message${bad ? " bad" : ""}`;
}

async function openHistory(name) {
  Object.assign(history, { name, page: 1, rows: [], chosen: null });
  history.cache.clear();
  $("history-title").textContent = name;
  $("history-list").replaceChildren();
  $("history-diff").replaceChildren();
  $("history-summary").textContent = "";
  $("history-restore").hidden = true;
  historyMessage("");
  $("history-dialog").showModal();
  if (!github.token) {
    historyMessage("Earlier versions come from GitHub. Connect it in settings to have them.");
    return;
  }
  await loadHistory();
}

async function loadHistory() {
  historyMessage("Asking GitHub…");
  try {
    const more = await new GitHub(github).history(history.name, history.page);
    history.rows.push(...more);
    historyMessage(history.rows.length ? "" : "GitHub has no versions of this yet: it hasn't been synced.");
    const list = $("history-list");
    list.replaceChildren(...history.rows.map((row, i) => {
      const b = document.createElement("button");
      b.textContent = new Date(row.date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      if (i === 0) b.textContent += " (latest)";
      b.classList.toggle("active", history.chosen === row);
      b.onclick = () => chooseVersion(row);
      return b;
    }));
    if (more.length === 30) {
      const older = document.createElement("button");
      older.textContent = "Older…";
      older.onclick = () => { history.page++; loadHistory(); };
      list.append(older);
    }
    if (!history.chosen && history.rows.length) chooseVersion(history.rows[0]);
  } catch (e) {
    historyMessage(e.message, true);
  }
}

// Which lines to take away from `now` and which to bring back from `then`. Lines kept
// at either end are skipped first, so an ordinary edit compares only a few lines.
function lineChanges(now, then) {
  const a = now === "" ? [] : now.split("\n");
  const b = then === "" ? [] : then.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  const out = a.slice(0, start).map(text => ({ kind: "same", text }));
  if (midA.length * midB.length > MAX_DIFF_LINES * MAX_DIFF_LINES) {
    out.push(...midA.map(text => ({ kind: "gone", text })), ...midB.map(text => ({ kind: "back", text })));
  } else {
    // Longest common subsequence: table[i][j] is how many of midA[i..] and midB[j..] match.
    const table = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1));
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) { out.push({ kind: "same", text: midA[i] }); i++; j++; }
      else if (j < midB.length && (i === midA.length || table[i][j + 1] >= table[i + 1][j])) out.push({ kind: "back", text: midB[j++] });
      else out.push({ kind: "gone", text: midA[i++] });
    }
  }
  out.push(...a.slice(endA).map(text => ({ kind: "same", text })));
  return out;
}

function showChanges(changes) {
  const CONTEXT = 2;
  const near = changes.map(() => false);
  changes.forEach((c, i) => {
    if (c.kind === "same") return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(changes.length - 1, i + CONTEXT); k++) near[k] = true;
  });
  const parts = [];
  let skipped = false;
  changes.forEach((c, i) => {
    if (!near[i]) {
      if (!skipped) {
        const s = document.createElement("span");
        s.className = "skip";
        s.textContent = "…";
        parts.push(s);
      }
      skipped = true;
      return;
    }
    skipped = false;
    const s = document.createElement("span");
    s.className = c.kind;
    s.textContent = `${c.kind === "gone" ? "− " : c.kind === "back" ? "+ " : "  "}${c.text}\n`;
    parts.push(s);
  });
  $("history-diff").replaceChildren(...parts);
}

async function chooseVersion(row) {
  history.chosen = row;
  for (const b of $("history-list").children) b.classList.remove("active");
  $("history-list").children[history.rows.indexOf(row)]?.classList.add("active");
  $("history-diff").replaceChildren();
  $("history-restore").hidden = true;
  $("history-summary").textContent = "Fetching…";
  try {
    if (!history.cache.has(row.sha)) {
      history.cache.set(row.sha, await new GitHub(github).read(history.name, row.sha));
    }
    if (history.chosen !== row) return; // another was chosen while this one came
    const version = history.cache.get(row.sha);
    if (!version) {
      $("history-summary").textContent = "This version is where the file was deleted or renamed. Choose an earlier one.";
      return;
    }
    const now = project.files[history.name] ?? "";
    if (version.text === now) {
      $("history-summary").textContent = "The same as what you have now.";
      return;
    }
    const changes = lineChanges(now, version.text);
    // The empty piece after a file's last line break isn't a line anyone wrote.
    const count = kind => changes.filter(c => c.kind === kind && c.text !== "").length;
    const gone = count("gone");
    const back = count("back");
    $("history-summary").textContent = project.files[history.name] === undefined
      ? `Restoring brings the file back, ${back} lines.`
      : `Restoring takes out ${gone} lines (−) and brings back ${back} (+). You can undo it.`;
    showChanges(changes);
    $("history-restore").hidden = false;
  } catch (e) {
    $("history-summary").textContent = e.message;
  }
}

$("history-close").onclick = () => $("history-dialog").close();
$("history-restore").onclick = () => {
  const { name, chosen } = history;
  const { text } = history.cache.get(chosen.sha);
  $("history-dialog").close();
  if (project.files[name] === undefined) {
    // Deleted here and not yet synced: GitHub still has it, so this is an edit to it.
    if (project.deleted[name]) project.synced[name] = { sha: project.deleted[name], text: null };
    delete project.deleted[name];
    delete project.removed[name];
    project.files[name] = text;
    fillFileSelect();
    showFile(name);
    compile();
    return;
  }
  // Over all of it as typing would be, so that undo brings the words back.
  showPane("script");
  if (name !== project.current) showFile(name);
  source.focus({ preventScroll: true });
  source.select();
  insertText(text);
  source.setSelectionRange(0, 0);
  source.scrollTop = 0;
  showCaret();
};

/* ---------- Begin ---------- */

showFile(project.current);
applyLayout();
compile();
applyLayout();
showSyncState();
if (github.token && navigator.onLine) sync({ auto: true });

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
