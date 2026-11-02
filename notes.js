// The Notes tab: pages of plain thinking, before there is a story to compile. A page is a
// Markdown file named after its title, kept in its own store and its own folder, so Ink,
// the graph and the bot never see one. store: { files, synced, deleted, current }.

const BAD_TITLE = /[\/\\:*?"<>|\n]/;
const MAX_TITLE = 80;
const STARTERS = ["The ending", "The father", "The journal"];

export const noteFile = title => `${title}.md`;
export const noteTitle = file => file.replace(/\.md$/, "");

// The title to use, or { problem } saying why it can't be. A checkout on a Mac can't hold
// two names that differ only in case, so they count as the same name here too.
export function checkTitle(raw, names, except = null) {
  const title = raw.replace(/\s+/g, " ").trim();
  if (!title) return { problem: "A page needs a title." };
  if (title.length > MAX_TITLE) return { problem: `A title can be ${MAX_TITLE} letters at most.` };
  if (BAD_TITLE.test(title) || title.startsWith(".")) return { problem: `A title can't start with a dot or hold any of / \\ : * ? " < > |` };
  const lower = noteFile(title).toLowerCase();
  if (names.some(n => n !== except && n.toLowerCase() === lower)) return { problem: `There's already a page called ${title}.` };
  return { title };
}

export class Notes {
  // saved(): something changed, keep it. narrow(): on a phone, where focusing a page to
  // read it would open the keyboard over the words.
  constructor(store, options) {
    this.store = store;
    this.o = options;
    this.$ = id => document.getElementById(id);
    this.editors = new Map(); // one textarea a page, because replacing a textarea's text loses its undo
    this.$("note-add").onclick = () => {
      const raw = prompt("A title for the page");
      if (raw !== null) this.add(raw);
    };
    this.$("note-delete").onclick = () => this.remove();
    this.$("note-select").onchange = e => this.show(e.target.value);
    const title = this.$("note-title");
    title.addEventListener("change", () => this.rename());
    title.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); title.blur(); }
      if (e.key === "Escape") { title.value = noteTitle(this.store.current); this.say(""); title.blur(); }
    });
    this.$("note-starters").replaceChildren(...STARTERS.map(name => {
      const b = document.createElement("button");
      b.textContent = name;
      b.onclick = () => this.add(name);
      return b;
    }));
  }

  names() {
    return Object.keys(this.store.files).sort((a, b) => a.localeCompare(b));
  }

  say(text) { this.$("note-message").textContent = text; }

  add(raw) {
    const { title, problem } = checkTitle(raw, this.names());
    if (problem) { alert(problem); return; }
    this.store.files[noteFile(title)] = "";
    this.show(noteFile(title));
    this.editors.get(noteFile(title))?.focus();
    this.o.saved();
  }

  // After a sync, or anything else that changed the files without typing.
  refresh() {
    for (const [name, ed] of this.editors) {
      if (this.store.files[name] === undefined) { ed.remove(); this.editors.delete(name); }
      else if (ed.value !== this.store.files[name]) {
        const { selectionStart: from, selectionEnd: to, scrollTop } = ed;
        ed.value = this.store.files[name];
        ed.setSelectionRange(from, to);
        ed.scrollTop = scrollTop;
      }
    }
    this.show(this.store.files[this.store.current] === undefined ? this.names()[0] ?? null : this.store.current);
  }

  editorFor(name) {
    let ed = this.editors.get(name);
    if (ed) return ed;
    ed = document.createElement("textarea");
    ed.className = "note-text off";
    ed.setAttribute("aria-label", `The words of ${noteTitle(name)}`);
    ed.placeholder = "Whatever you have so far. It doesn't need to be tidy.";
    ed.value = this.store.files[name] ?? "";
    ed.setSelectionRange(0, 0);
    ed.addEventListener("input", () => {
      this.store.files[this.store.current] = ed.value; // a rename can change the name it's under
      this.o.saved();
    });
    this.$("note-editors").append(ed);
    this.editors.set(name, ed);
    return ed;
  }

  show(name) {
    const previous = this.store.current;
    if (previous !== name || name === null) this.editors.get(previous)?.classList.add("off");
    this.store.current = name;
    this.say("");
    const names = this.names();
    const empty = name === null;
    this.$("note-empty").hidden = !empty;
    this.$("note-page").hidden = empty;
    this.$("note-delete").hidden = empty;
    this.$("note-select").hidden = empty;
    this.$("note-select").replaceChildren(...names.map(n => new Option(noteTitle(n), n, false, n === name)));
    this.$("note-list").replaceChildren(...names.map(n => {
      const b = document.createElement("button");
      b.textContent = noteTitle(n);
      b.className = n === name ? "active" : "";
      b.onclick = () => this.show(n);
      return b;
    }));
    if (empty) return;
    this.$("note-title").value = noteTitle(name);
    this.editorFor(name).classList.remove("off");
  }

  rename() {
    const from = this.store.current;
    const input = this.$("note-title");
    const { title, problem } = checkTitle(input.value, this.names(), from);
    if (problem) {
      this.say(problem);
      input.value = noteTitle(from);
      return;
    }
    const to = noteFile(title);
    this.say("");
    if (to === from) { input.value = title; return; }
    this.store.files[to] = this.store.files[from];
    this.forget(from);
    // Its editor, with its undo, goes with it.
    const ed = this.editors.get(from);
    if (ed) { this.editors.delete(from); this.editors.set(to, ed); }
    this.store.current = to;
    this.show(to);
    this.o.saved();
  }

  // A synced page is removed from GitHub at the next sync. Its history stays there.
  forget(name) {
    if (this.store.synced[name]) this.store.deleted[name] = this.store.synced[name].sha;
    delete this.store.synced[name];
    delete this.store.files[name];
  }

  remove() {
    const name = this.store.current;
    const end = this.store.synced[name] ? "It stays in GitHub's history." : "It has never been synced, so it can't be got back.";
    if (!confirm(`Delete ${noteTitle(name)}? ${end}`)) return;
    this.forget(name);
    this.refresh();
    this.o.saved();
  }

  // Lines are counted through a hidden copy of the page, because long lines wrap.
  openAt(name, line) {
    this.show(name);
    const ed = this.editorFor(name);
    const lines = ed.value.split("\n");
    const offset = lines.slice(0, line - 1).reduce((sum, l) => sum + l.length + 1, 0);
    if (!this.o.narrow()) ed.focus({ preventScroll: true });
    ed.setSelectionRange(offset, offset + (lines[line - 1]?.length ?? 0));
    const style = getComputedStyle(ed);
    const copy = document.createElement("div");
    copy.style.cssText = `position:absolute;visibility:hidden;white-space:pre-wrap;overflow-wrap:anywhere;box-sizing:border-box;width:${ed.clientWidth}px;padding:${style.padding};font:${style.font}`;
    copy.textContent = ed.value.slice(0, offset) || " ";
    ed.parentNode.append(copy);
    ed.scrollTop = Math.max(0, copy.offsetHeight - ed.clientHeight / 3);
    copy.remove();
  }
}
