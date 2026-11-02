// The GitHub contents API: the story's .ink files in one folder of one branch.
// The token goes only to api.github.com, from this device.

const API = "https://api.github.com";

function encode(text) {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function decode(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

export class Conflict extends Error {}

export class GitHub {
  constructor({ repo, branch, dir, token }) {
    Object.assign(this, { repo, branch, dir: dir.replace(/^\/+|\/+$/g, ""), token });
  }

  async call(path, options = {}) {
    let res;
    try {
      res = await fetch(`${API}/repos/${this.repo}/contents/${path}`, {
        ...options,
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...options.headers,
        },
      });
    } catch {
      throw new Error("Can't reach GitHub. Your work is still saved on this device.");
    }
    if (res.status === 401) throw new Error("GitHub refused the token. It may have expired.");
    if (res.status === 403) throw new Error("The token can't do that. It needs Contents set to read and write on this repository.");
    if (res.status === 409 || res.status === 422) throw new Conflict("changed on GitHub");
    return res;
  }

  // Name -> sha for the folder's .ink files. An absent folder is an empty one.
  async list() {
    const res = await this.call(`${this.dir}?ref=${encodeURIComponent(this.branch)}`);
    if (res.status === 404) {
      await this.checkRepo();
      return {};
    }
    if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
    const out = {};
    for (const f of await res.json()) {
      if (f.type === "file" && f.name.endsWith(".ink")) out[f.name] = f.sha;
    }
    return out;
  }

  // 404 means either no folder yet or no such repository; the root tells which.
  async checkRepo() {
    const res = await this.call(`?ref=${encodeURIComponent(this.branch)}`);
    if (res.status === 404) throw new Error("Can't find that repository or branch with this token.");
  }

  async read(name) {
    const res = await this.call(`${this.dir}/${encodeURIComponent(name)}?ref=${encodeURIComponent(this.branch)}`);
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${name}.`);
    const f = await res.json();
    return { text: decode(f.content), sha: f.sha };
  }

  // sha is the version this edit started from; none means a new file.
  async write(name, text, sha) {
    const body = { message: `Story: ${name} (Suratan)`, content: encode(text), branch: this.branch };
    if (sha) body.sha = sha;
    const res = await this.call(`${this.dir}/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} saving ${name}.`);
    return (await res.json()).content.sha;
  }

  // sha as in write: a file changed since then isn't removed, it's a Conflict.
  async remove(name, sha) {
    const body = { message: `Story: ${name} removed (Suratan)`, sha, branch: this.branch };
    const res = await this.call(`${this.dir}/${encodeURIComponent(name)}`, { method: "DELETE", body: JSON.stringify(body) });
    if (!res.ok && res.status !== 404) throw new Error(`GitHub answered ${res.status} removing ${name}.`);
  }
}
