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
const project = loadJson("suratan:project", null) || { files: { [MAIN]: SAMPLE }, synced: {}, current: MAIN };
if (!project.files[project.current]) project.current = Object.keys(project.files)[0];
const github = loadJson("suratan:github", { repo: "vfaizin/kias", branch: "main", dir: "assets/story", token: "" });
let saveFailed = false;

function persist() {
  saveFailed = !saveJson("suratan:project", project);
  showSyncState();
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
  $("graph-count").textContent = `${graph.count.scenes} scenes, ${graph.count.jumps} jumps`;
  fillPlayFrom();
  if (changed && player.story) $("play-stale").hidden = false;
  if (changed) { graph.setOverlay({ unreached: new Set(), deadends: new Set() }); }
  if (!player.story && json) player.start();
}

function scheduleCompile() {
  clearTimeout(scheduleCompile.timer);
  scheduleCompile.timer = setTimeout(compile, 350);
}

/* ---------- Script pane ---------- */

const source = $("source");
const backdrop = $("backdrop");

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
  source.value = project.files[name] ?? "";
  paintBackdrop();
  fillFileSelect();
  persist();
}

function fillFileSelect() {
  const sel = $("file-select");
  sel.replaceChildren(...Object.keys(project.files).sort((a, b) => (b === MAIN) - (a === MAIN) || a.localeCompare(b))
    .map(n => new Option(n, n, false, n === project.current)));
}

function goToLine(file, line) {
  showPane("script");
  if (file !== project.current && project.files[file] !== undefined) showFile(file);
  const lines = source.value.split("\n");
  let offset = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
  source.focus({ preventScroll: true });
  source.setSelectionRange(offset, offset + (lines[line - 1]?.length ?? 0));
  const row = backdrop.children[line - 1];
  if (row) source.scrollTop = Math.max(0, row.offsetTop - source.clientHeight / 3);
  backdrop.scrollTop = source.scrollTop;
}

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

source.addEventListener("input", () => {
  project.files[project.current] = source.value;
  paintBackdrop();
  persist();
  scheduleCompile();
});
source.addEventListener("scroll", () => { backdrop.scrollTop = source.scrollTop; }, { passive: true });
source.addEventListener("keydown", e => {
  if (e.key !== "Tab") return;
  e.preventDefault();
  source.setRangeText("    ", source.selectionStart, source.selectionEnd, "end");
  source.dispatchEvent(new Event("input"));
});

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

/* ---------- Graph pane ---------- */

const graph = new Graph($("graph"), {
  moved: loadJson("suratan:graph-moved", {}),
  onMoved(moved) { saveJson("suratan:graph-moved", moved); },
  onSelect(name) {
    graph.setSelected(name);
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
  },
});

$("graph-fit").onclick = () => graph.fit();
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

function humanError(message) {
  if (/ran out of content/.test(message)) {
    return "Dead end: the story runs out here, with no jump, choice or -> END.";
  }
  return message;
}

// An error Ink doesn't handle itself: its words are about its own code, not the story,
// and nothing says which line. The two causes named are the ones we've found.
function crashError(message) {
  return `Ink stopped here without saying why. It does this on mod by zero, and on ->-> to something that isn't a scene, and maybe on other things. Its own words: "${message}"`;
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
        try { player.story?.variablesState.$(name, next); } catch (e) { addLine(sysLine(e.message, "fail")); }
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
      const text = p.kind === "crash" ? crashError(p.message) : p.message;
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
  if (shown.includes("graph") && !graph.hasFit) requestAnimationFrame(() => graph.fit());
  if (shown.includes("script")) paintBackdrop();
}

for (const b of document.querySelectorAll("#tabs button")) b.onclick = () => showPane(b.dataset.tab);
addEventListener("resize", applyLayout);

/* ---------- Sync ---------- */

let syncing = false;
let syncError = "";

function dirtyCount() {
  return Object.keys(project.files).filter(n => project.files[n] !== project.synced[n]?.text).length;
}

function showSyncState() {
  const el = $("sync-state");
  const dirty = dirtyCount();
  el.className = "sync-state";
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
    el.textContent = "On this device only";
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

async function resolveConflict(gh, name, remoteSha) {
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

async function sync() {
  if (!github.token) { openSettings(); return; }
  if (syncing) return;
  syncing = true;
  syncError = "";
  showSyncState();
  $("sync").disabled = true;
  const gh = new GitHub(github);
  try {
    const remote = await gh.list();
    for (const [name, sha] of Object.entries(remote)) {
      const local = project.files[name];
      const base = project.synced[name];
      if (local === undefined) {
        const f = await gh.read(name);
        project.files[name] = f.text;
        project.synced[name] = { sha: f.sha, text: f.text };
      } else if (base?.sha === sha) {
        if (local !== base.text) {
          try { project.synced[name] = { sha: await gh.write(name, local, sha), text: local }; }
          catch (e) {
            if (!(e instanceof Conflict)) throw e;
            const fresh = await gh.list();
            await resolveConflict(gh, name, fresh[name]);
          }
        }
      } else if (!base || local === base.text) {
        // First sync on this device, or nothing changed here: GitHub's is the one,
        // unless this device has never seen the file and holds different words.
        const f = await gh.read(name);
        if (!base && local !== f.text && !(name === MAIN && local === SAMPLE)) {
          await resolveConflict(gh, name, sha);
        } else {
          project.files[name] = f.text;
          project.synced[name] = { sha: f.sha, text: f.text };
        }
      } else {
        const f = await gh.read(name);
        if (f.text === local) project.synced[name] = { sha: f.sha, text: f.text };
        else await resolveConflict(gh, name, sha);
      }
    }
    for (const name of Object.keys(project.files)) {
      if (remote[name] !== undefined) continue;
      const text = project.files[name];
      project.synced[name] = { sha: await gh.write(name, text, null), text };
    }
    source.value = project.files[project.current] ?? "";
    fillFileSelect();
    compile();
  } catch (e) {
    syncError = e.message;
    throw e;
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
  $("gh-message").textContent = "";
  $("gh-message").className = "message";
}
function openSettings() { fillSettings(); $("settings-dialog").showModal(); }

$("settings").onclick = openSettings;
$("gh-close").onclick = () => $("settings-dialog").close();
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

/* ---------- Begin ---------- */

fillFileSelect();
source.value = project.files[project.current] ?? "";
applyLayout();
compile();
applyLayout();
showSyncState();
if (github.token && navigator.onLine) sync().catch(() => {});

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
