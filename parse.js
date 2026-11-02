// A light scan of Ink source for what the graph and the state panel need:
// knots, stitches, jumps, variables. The real compiler is inkjs; it reports the
// errors. This reads lines only, so a jump held in a variable is not an edge.

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const KNOT = new RegExp(`^\\s*={2,}\\s*(function\\s+)?(${NAME})\\s*(\\(.*\\))?\\s*=*\\s*$`);
const STITCH = new RegExp(`^\\s*=\\s*(${NAME})\\s*(\\(.*\\))?\\s*$`);
const DIVERT = new RegExp(`(?:->|<-)\\s*(${NAME}(?:\\.${NAME})*)`, "g");
const NOT_TARGET = new Set(["END", "DONE"]);

export const ROOT = "(start)";

// Removes // and /* */ comments. `inBlock` carries a block comment across lines.
function stripComments(line, inBlock) {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (inBlock) {
      const end = line.indexOf("*/", i);
      if (end < 0) return { text: out, inBlock: true };
      i = end + 2;
      inBlock = false;
    } else if (line.startsWith("/*", i)) {
      inBlock = true;
      i += 2;
    } else if (line.startsWith("//", i)) {
      break;
    } else {
      out += line[i++];
    }
  }
  return { text: out, inBlock };
}

// files: { name: text }. Returns the scan across all of them.
export function scan(files) {
  const knots = [{ name: ROOT, file: "main.ink", line: 1, stitches: [], isFunction: false, isRoot: true }];
  const rawEdges = [];
  const vars = [];
  const externals = [];
  const includes = new Set();

  for (const [file, text] of Object.entries(files)) {
    let knot = knots[0];
    let stitch = null;
    let inBlock = false;
    let braces = 0;
    let choice = null; // the choice whose body we are in, until a gather or new knot

    text.split("\n").forEach((raw, i) => {
      const lineNo = i + 1;
      const stripped = stripComments(raw, inBlock);
      inBlock = stripped.inBlock;
      const line = stripped.text;
      if (!line.trim()) return;

      let m;
      if ((m = line.match(KNOT))) {
        knot = { name: m[2], file, line: lineNo, stitches: [], isFunction: !!m[1] };
        knots.push(knot);
        stitch = null; choice = null; braces = 0;
        return;
      }
      if ((m = line.match(STITCH))) {
        stitch = m[1];
        knot.stitches.push({ name: m[1], line: lineNo });
        choice = null; braces = 0;
        return;
      }
      if ((m = line.match(new RegExp(`^\\s*INCLUDE\\s+(.+?)\\s*$`)))) { includes.add(m[1]); return; }
      if ((m = line.match(new RegExp(`^\\s*VAR\\s+(${NAME})\\s*=`)))) { vars.push({ name: m[1], file, line: lineNo }); return; }
      if ((m = line.match(new RegExp(`^\\s*EXTERNAL\\s+(${NAME})\\s*\\(`)))) { externals.push(m[1]); return; }
      if (/^\s*(CONST|LIST)\s/.test(line)) return;

      const isChoice = /^\s*[*+]/.test(line);
      const isGather = /^\s*-(?!>)/.test(line);
      if (isChoice) {
        const body = line.replace(/^\s*[*+\s]+/, "");
        const bracket = body.match(/\[(.*?)\]/);
        const label = (bracket ? bracket[1] : body.replace(/->.*$/, "")).replace(/\{[^}]*\}/g, "").trim();
        choice = { label, conditional: /\{/.test(body.split("[")[0]) };
      } else if (isGather) {
        choice = null;
      }

      DIVERT.lastIndex = 0;
      while ((m = DIVERT.exec(line))) {
        if (NOT_TARGET.has(m[1])) continue;
        const before = line.slice(0, m.index);
        const inlineBrace = before.lastIndexOf("{") > before.lastIndexOf("}");
        rawEdges.push({
          from: knot.name, fromFile: file, line: lineNo,
          target: m[1],
          conditional: braces > 0 || inlineBrace || !!(choice && choice.conditional),
          label: choice ? choice.label : "",
          isChoice: !!choice,
        });
      }

      for (const c of line) {
        if (c === "{") braces++;
        else if (c === "}") braces = Math.max(0, braces - 1);
      }
    });
  }

  const byName = new Map(knots.map(k => [k.name, k]));
  const edges = [];
  for (const e of rawEdges) {
    const first = e.target.split(".")[0];
    const from = byName.get(e.from);
    let to = null;
    if (byName.has(first)) to = first;
    // A bare stitch or label name means a place inside this knot, so no edge.
    else if (from.stitches.some(s => s.name === first)) continue;
    if (!to || to === e.from) continue;
    if (byName.get(to).isFunction) continue;
    edges.push({ from: e.from, to, conditional: e.conditional, label: e.label, line: e.line, file: e.fromFile });
  }

  return { knots, edges, vars, externals: [...new Set(externals)], includes };
}

// Every path the bot should try to reach: scenes and their stitches.
export function reachablePaths(result) {
  const paths = [];
  for (const k of result.knots) {
    if (k.isFunction || k.isRoot) continue;
    paths.push(k.name);
    for (const s of k.stitches) paths.push(`${k.name}.${s.name}`);
  }
  return paths;
}
