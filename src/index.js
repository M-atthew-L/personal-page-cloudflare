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
const MAX_IMAGES   = 12;
const MAX_UPLOAD   = 8 * 1024 * 1024;          // 8 MB after the browser resize
const IMAGE_TYPES  = {
  "image/jpeg": "jpg",
  "image/png":  "png",
  "image/webp": "webp",
  "image/gif":  "gif"
};

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

function safeSrc(value, label) {
  const s = str(value, label, 2000);
  if (s.startsWith("/img/")) return s;                    // uploaded to R2
  if (/^https?:\/\//i.test(s)) return s;                  // hosted elsewhere
  throw new Error(`${label} must be an uploaded image or an http(s) URL.`);
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

    if (item.slug) {
      const slug = str(item.slug, `${n} slug`, 80);
      if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`${n} has an invalid slug.`);
      out.slug = slug;
    }
    if (item.draft === true)  out.draft = true;
    if (item.pinned === true) out.pinned = true;

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

    if (Array.isArray(item.images) && item.images.length) {
      if (item.images.length > MAX_IMAGES) throw new Error(`${n} has too many images.`);
      out.images = item.images.map((im, j) => {
        const row = { src: safeSrc(im?.src, `${n}, image ${j + 1}`) };
        const alt = str(im?.alt, `${n}, image ${j + 1} caption`, 300, false);
        if (alt) row.alt = alt;
        return row;
      });
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

/* ── image uploads ─────────────────────────────────────────
   Photos are too big for KV, so they go to an R2 bucket bound
   as IMAGES. Without that binding everything else still works;
   only uploads are unavailable, and they say so clearly.
   ────────────────────────────────────────────────────────── */
/* Visitors get published pieces only. With the key, everything. */
async function handleEntries(request, env) {
  if (request.method === "GET" && authorised(request, env)) {
    const stored = await env.PROGRESS_KV.get(ENTRIES_KEY, "json");
    return json((stored ?? []).filter(e => !e.draft));
  }
  return handle(request, env, ENTRIES_KEY, cleanEntries);
}

const escAttr = s => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* Crawlers don't run JavaScript, so the preview card for an
   individual piece is stitched into the HTML here. */
async function withPreview(response, request, env, pathname) {
  const origin = new URL(request.url).origin;
  const site   = await env.PROGRESS_KV.get(SITE_KEY, "json");

  let title = site?.name ? `${site.name} — index` : "Personal site";
  let desc  = site?.intro || "";
  let image = "";

  if (pathname.startsWith("/p/")) {
    const slug    = decodeURIComponent(pathname.slice(3));
    const entries = (await env.PROGRESS_KV.get(ENTRIES_KEY, "json")) ?? [];
    const entry   = entries.find(e => e.slug === slug && !e.draft);

    if (entry) {
      title = site?.name ? `${entry.title} — ${site.name}` : entry.title;
      desc  = entry.sub || desc;
      const first = (entry.images ?? [])[0];
      if (first) image = first.src.startsWith("/") ? origin + first.src : first.src;
    }
  }

  const tags = [
    `<meta property="og:title" content="${escAttr(title)}">`,
    `<meta property="og:description" content="${escAttr(desc)}">`,
    `<meta property="og:url" content="${escAttr(origin + pathname)}">`,
    `<meta name="description" content="${escAttr(desc)}">`,
    image ? `<meta property="og:image" content="${escAttr(image)}">` : ""
  ].join("");

  return new HTMLRewriter()
    .on("title", { element: el => el.setInnerContent(title) })
    /* drop the static homepage tags so they can't duplicate */
    .on('meta[property="og:title"]',       { element: el => el.remove() })
    .on('meta[property="og:description"]', { element: el => el.remove() })
    .on('meta[name="description"]',        { element: el => el.remove() })
    .on("head", { element: el => el.append(tags, { html: true }) })
    .transform(response);
}

async function handleUpload(request, env) {
  const problem = authorised(request, env);
  if (problem) return json({ error: problem }, problem === "Wrong key." ? 401 : 500);

  if (!env.IMAGES) {
    return json({
      error: "No image storage. Create an R2 bucket and bind it as IMAGES in wrangler.jsonc."
    }, 501);
  }

  const type = (request.headers.get("Content-Type") || "").split(";")[0].trim();
  if (!IMAGE_TYPES[type]) {
    return json({ error: "Images must be JPEG, PNG, WebP, or GIF." }, 415);
  }

  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) return json({ error: "That file was empty." }, 400);
  if (bytes.byteLength > MAX_UPLOAD) {
    return json({ error: "That image is over 8 MB, even after resizing." }, 413);
  }

  const key = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}.${IMAGE_TYPES[type]}`;
  await env.IMAGES.put(key, bytes, {
    httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" }
  });

  return json({ src: `/img/${key}` });
}

async function serveImage(pathname, env) {
  if (!env.IMAGES) return new Response("Not found", { status: 404 });

  const key = decodeURIComponent(pathname.slice("/img/".length));
  if (!key || key.includes("/")) return new Response("Not found", { status: 404 });

  const object = await env.IMAGES.get(key);
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/upload" && request.method === "POST") {
      return handleUpload(request, env);
    }
    if (pathname.startsWith("/img/") && request.method === "GET") {
      return serveImage(pathname, env);
    }

    if (pathname === "/api/progress") return handle(request, env, PROGRESS_KEY, cleanProgress);
    if (pathname === "/api/entries")  return handleEntries(request, env);
    if (pathname === "/api/trash")    return handle(request, env, TRASH_KEY,    cleanTrash, true);
    if (pathname === "/api/site")     return handleSite(request, env);

    /* client-side routes: serve the app shell, with its own preview */
    if (pathname.startsWith("/p/") || pathname === "/about" || pathname === "/edit") {
      const shell = await env.ASSETS.fetch(new Request(new URL("/", request.url), request));
      return withPreview(shell, request, env, pathname);
    }

    return env.ASSETS.fetch(request);
  }
};