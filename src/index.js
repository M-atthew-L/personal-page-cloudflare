/* ═══════════════════════════════════════════════════════════
   Serves the site, plus a small API behind it.

   GET  /api/progress   public
   PUT  /api/progress   requires the EDIT_KEY secret
   GET  /api/entries    public
   PUT  /api/entries    requires the EDIT_KEY secret

   Everything else falls through to the static files in
   ./public, which Cloudflare serves before this code runs.
   ═══════════════════════════════════════════════════════════ */

const PROGRESS_KEY = "progress:v1";
const ENTRIES_KEY  = "entries:v1";
const TRASH_KEY    = "trash:v1";
const SITE_KEY     = "site:v1";

const TONES = new Set(["building", "queued", "idea"]);
const KINDS = new Set(["project", "research", "writing", "poem"]);

const MAX_PROGRESS = 100;
const MAX_ENTRIES  = 400;
const MAX_SHORT    = 300;
const MAX_BODY     = 40000;
const MAX_LINKS    = 25;
const MAX_TRASH    = 50;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });

/* constant time, so the key can't be guessed a character at a time */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function str(value, label, max, required = true) {
  if (typeof value !== "string" || !value.trim()) {
    if (required) throw new Error(`${label} is missing.`);
    return "";
  }
  if (value.length > max) throw new Error(`${label} is too long.`);
  return value.trim();
}

/* only http(s) links get through — blocks javascript: and data: URLs */
function safeHref(value, label) {
  const s = str(value, label, 2000);
  if (s === "#") return s;
  if (!/^(https?:\/\/|mailto:)/i.test(s)) {
    throw new Error(`${label} must start with http://, https://, or mailto:`);
  }
  return s;
}

function cleanProgress(list) {
  if (!Array.isArray(list)) throw new Error("Expected a list.");
  if (list.length > MAX_PROGRESS) throw new Error(`Too many items (limit ${MAX_PROGRESS}).`);

  return list.map((item, i) => {
    const n = `Item ${i + 1}`;
    if (!item || typeof item !== "object") throw new Error(`${n} isn't an object.`);
    if (!TONES.has(item.state)) throw new Error(`${n} has an unknown tone.`);

    const out = { state: item.state, text: str(item.text, `${n} text`, MAX_SHORT) };
    const note = str(item.note, `${n} note`, MAX_SHORT, false);
    if (note) out.note = note;
    return out;
  });
}

function cleanEntries(list) {
  if (!Array.isArray(list)) throw new Error("Expected a list.");
  if (list.length > MAX_ENTRIES) throw new Error(`Too many entries (limit ${MAX_ENTRIES}).`);

  return list.map((item, i) => {
    const n = `Entry ${i + 1}`;
    if (!item || typeof item !== "object") throw new Error(`${n} isn't an object.`);
    if (!KINDS.has(item.kind)) throw new Error(`${n} has an unknown kind.`);

    const out = {
      kind:  item.kind,
      title: str(item.title, `${n} title`, 200),
      date:  str(item.date, `${n} date`, 40),
      sort:  Number.isFinite(item.sort) ? Math.trunc(item.sort) : 0
    };

    const sub = str(item.sub, `${n} description`, 400, false);
    if (sub) out.sub = sub;

    if (item.kind === "poem") {
      if (typeof item.body !== "string" || !item.body.trim()) {
        throw new Error(`${n} has no body.`);
      }
      if (item.body.length > MAX_BODY) throw new Error(`${n} is too long.`);
      out.body = item.body;                       // whitespace preserved verbatim
    } else {
      if (!Array.isArray(item.body) || !item.body.length) {
        throw new Error(`${n} has no body.`);
      }
      out.body = item.body
        .map((p, j) => str(p, `${n}, paragraph ${j + 1}`, MAX_BODY))
        .filter(Boolean);
      if (!out.body.length) throw new Error(`${n} has no body.`);
    }

    if (item.link && typeof item.link === "object") {
      out.link = {
        label: str(item.link.label, `${n} link label`, 200),
        href:  safeHref(item.link.href, `${n} link`)
      };
    }

    if (Array.isArray(item.links) && item.links.length) {
      if (item.links.length > MAX_LINKS) throw new Error(`${n} has too many links.`);
      out.links = item.links.map((l, j) => ({
        label: str(l?.label, `${n}, link ${j + 1} label`, 200),
        href:  safeHref(l?.href, `${n}, link ${j + 1}`)
      }));
    }

    return out;
  });
}

/* Recently deleted holds content the owner removed — reading it
   needs the key, unlike the two public lists. */
function cleanTrash(list) {
  if (!Array.isArray(list)) throw new Error("Expected a list.");

  return list.slice(0, MAX_TRASH).map((t, i) => {
    const n = `Trash item ${i + 1}`;
    if (!t || typeof t !== "object") throw new Error(`${n} isn't an object.`);
    const at = Number.isFinite(t.at) ? Math.trunc(t.at) : 0;

    if (t.type === "entry")    return { type: "entry",    at, item: cleanEntries([t.item])[0] };
    if (t.type === "progress") return { type: "progress", at, item: cleanProgress([t.item])[0] };
    throw new Error(`${n} has an unknown type.`);
  });
}

/* The site copy is a single object rather than a list, so it
   gets its own handler below. */
function cleanSite(site) {
  if (!site || typeof site !== "object" || Array.isArray(site)) {
    throw new Error("Expected an object.");
  }

  const out = {
    name:     str(site.name, "Name", 80),
    headline: str(site.headline, "Headline", 300, false),
    intro:    str(site.intro, "Subheading", 800, false),
    about:    [],
    contact:  []
  };

  if (Array.isArray(site.about)) {
    if (site.about.length > 30) throw new Error("Too many About paragraphs.");
    out.about = site.about
      .map((p, i) => str(p, `About paragraph ${i + 1}`, 5000, false))
      .filter(Boolean);
  }

  if (Array.isArray(site.contact)) {
    if (site.contact.length > 12) throw new Error("Too many contact lines.");
    out.contact = site.contact.map((c, i) => {
      const n = `Contact line ${i + 1}`;
      const row = { label: str(c?.label, `${n} label`, 60), text: str(c?.text, `${n} text`, 200) };
      if (c?.href) row.href = safeHref(c.href, `${n} link`);
      return row;
    });
  }

  return out;
}

async function handleSite(request, env) {
  if (request.method === "GET") {
    const stored = await env.PROGRESS_KV.get(SITE_KEY, "json");
    return json(stored ?? null);
  }

  if (request.method === "PUT") {
    const problem = authorised(request, env);
    if (problem) return json({ error: problem }, problem === "Wrong key." ? 401 : 500);

    let site;
    try {
      site = cleanSite(await request.json());
    } catch (err) {
      return json({ error: err.message }, 400);
    }

    await env.PROGRESS_KV.put(SITE_KEY, JSON.stringify(site));
    return json(site);
  }

  return json({ error: "Use GET or PUT." }, 405);
}

function authorised(request, env) {
  if (!env.EDIT_KEY) return "No EDIT_KEY secret is set on this Worker.";
  if (!safeEqual(request.headers.get("X-Edit-Key") ?? "", env.EDIT_KEY)) return "Wrong key.";
  return null;
}

async function handle(request, env, kvKey, cleaner, privateRead = false) {
  if (request.method === "GET") {
    if (privateRead) {
      const problem = authorised(request, env);
      if (problem) return json({ error: problem }, problem === "Wrong key." ? 401 : 500);
    }
    const stored = await env.PROGRESS_KV.get(kvKey, "json");
    return json(stored ?? []);
  }

  if (request.method === "PUT") {
    const problem = authorised(request, env);
    if (problem) return json({ error: problem }, problem === "Wrong key." ? 401 : 500);

    let list;
    try {
      list = cleaner(await request.json());
    } catch (err) {
      return json({ error: err.message }, 400);
    }

    await env.PROGRESS_KV.put(kvKey, JSON.stringify(list));
    return json(list);
  }

  return json({ error: "Use GET or PUT." }, 405);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/progress") return handle(request, env, PROGRESS_KEY, cleanProgress);
    if (pathname === "/api/entries")  return handle(request, env, ENTRIES_KEY,  cleanEntries);
    if (pathname === "/api/trash")    return handle(request, env, TRASH_KEY,    cleanTrash, true);
    if (pathname === "/api/site")     return handleSite(request, env);

    return env.ASSETS.fetch(request);
  }
};