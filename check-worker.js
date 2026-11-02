// The bot, in a worker so a story that loops forever cannot freeze the page.
// Plays seeded random runs. A seed plus its list of choices replays a run exactly.
importScripts("vendor/ink-full.js");

const STUCK_MS = 2000; // a line taking this long is a loop with no choices, not a slow machine
const TOTAL_MS = 45000;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

onmessage = ({ data }) => {
  const { json, externals, paths, runs, maxSteps } = data;
  let runErrors = [];
  const fresh = () => {
    const s = new inkjs.Story(json);
    for (const name of externals) s.BindExternalFunctionGeneral(name, () => 1, false);
    s.onError = (message, type) => { if (type === 2 /* error */) runErrors.push(message); };
    return s;
  };
  let story = fresh();

  const reached = Object.fromEntries(paths.map(p => [p, 0]));
  const problems = new Map(); // message -> { kind, message, count, seed, choices }
  // "town.square.0.c-1" -> "town.square": drop the positions inside a scene.
  const scene = path => (path || "").split(".").filter(c => !/^(\d+|[a-z]-\d+)$/.test(c)).join(".");

  // Compiled JSON keeps no line numbers, and the story has no position once it has
  // run out. So replay the run and see which scene the last lines of it entered.
  const locate = (seed, choices) => {
    const kept = runErrors;
    runErrors = [];
    const s = fresh();
    s.state.storySeed = seed;
    s.state.previousRandom = 0;
    const counts = () => paths.map(p => { try { return s.state.VisitCountAtPathString(p); } catch { return 0; } });
    let at = null;
    try {
      for (const pick of choices) {
        while (s.canContinue) s.Continue();
        s.ChooseChoiceIndex(pick);
      }
      let before = counts();
      while (s.canContinue) {
        s.Continue();
        const now = counts();
        const entered = paths.filter((_, i) => now[i] > before[i]);
        if (entered.length) at = entered[entered.length - 1]; // a stitch follows its knot
        before = now;
      }
    } catch { /* the run's own error; `at` holds as far as it got */ }
    runErrors = kept;
    return at;
  };

  // Keyed by the raw path, so two dead ends behind one scene's choices stay apart.
  const note = (kind, message, path, seed, choices) => {
    const key = `${path}\u0000${message}`;
    const p = problems.get(key);
    if (p) { p.count++; return; }
    const at = (kind !== "stuck" && locate(seed, choices)) || scene(path);
    problems.set(key, { kind, message, at, count: 1, seed, choices: [...choices] });
  };

  const totals = { runs: 0, ended: 0, capped: 0, broken: 0, choices: 0 };
  const started = Date.now();
  let stoppedEarly = false;

  for (let r = 0; r < runs; r++) {
    if (Date.now() - started > TOTAL_MS) { stoppedEarly = true; break; }
    const seed = r + 1;
    const random = rng(seed);
    const choices = [];
    runErrors = [];
    story.ResetState();
    story.state.storySeed = seed;
    story.state.previousRandom = 0;

    let outcome = null;
    let lastPath = null;
    while (outcome === null) {
      try {
        while (story.canContinue) {
          lastPath = story.state.currentPathString || lastPath;
          // Short slices, so a pause in the browser is not mistaken for a loop.
          const began = Date.now();
          do { story.ContinueAsync(50); }
          while (!story.asyncContinueComplete && Date.now() - began < STUCK_MS);
          if (!story.asyncContinueComplete) { outcome = "stuck"; break; }
        }
      } catch (e) {
        runErrors.push(e.message || String(e));
      }
      if (outcome) break;
      if (runErrors.length) { outcome = "broken"; break; }
      const n = story.currentChoices.length;
      if (n === 0) { outcome = "ended"; break; }
      if (choices.length >= maxSteps) { outcome = "capped"; break; }
      const pick = Math.floor(random() * n);
      choices.push(pick);
      try { story.ChooseChoiceIndex(pick); }
      catch (e) { runErrors.push(e.message || String(e)); outcome = "broken"; }
    }

    if (outcome === "stuck") {
      note("stuck", "A loop with no choices: the story spins here and the player can do nothing", lastPath, seed, choices);
      totals.broken++;
    } else if (outcome === "broken") {
      totals.broken++;
      for (const m of runErrors) {
        note(/ran out of content/.test(m) ? "deadend" : "error", m, lastPath, seed, choices);
      }
    } else if (outcome === "ended") totals.ended++;
    else totals.capped++;
    totals.runs++;
    totals.choices += choices.length;

    if (outcome !== "stuck") {
      for (const p of paths) {
        try { if (story.state.VisitCountAtPathString(p) > 0) reached[p]++; } catch { /* not a counted path */ }
      }
    }

    // A story stopped mid-line can't be reset, so the next run needs a new one.
    if (outcome === "stuck") story = fresh();

    if (outcome === "stuck" && [...problems.values()].some(p => p.kind === "stuck" && p.count >= 3)) {
      stoppedEarly = true;
      break;
    }
    if (r % 25 === 0) postMessage({ type: "progress", done: r + 1, runs });
  }

  // Different ways into one place are one finding.
  const merged = new Map();
  for (const p of problems.values()) {
    const key = `${p.kind}\u0000${p.at}\u0000${p.message}`;
    if (merged.has(key)) merged.get(key).count += p.count;
    else merged.set(key, p);
  }
  postMessage({ type: "done", totals, reached, problems: [...merged.values()], stoppedEarly });
};
