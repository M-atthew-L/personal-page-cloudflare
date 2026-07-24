/* ═══════════════════════════════════════════════════════════
   Serves the site, plus a tiny API for the Progress list.

   GET  /api/progress   public — anyone can read the list
   PUT  /api/progress   requires the EDIT_KEY secret

   Everything else falls through to the static files in
   ./public, which Cloudflare serves before this code runs.
   ═══════════════════════════════════════════════════════════ */

const KEY       = "progress:v1";
const TONES     = new Set(["building", "queued", "idea"]);
const MAX_ITEMS = 100;
const MAX_CHARS = 300;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });

/* compare in constant time so the key can't be guessed a character at a time */
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

/* never trust what arrives — rebuild the list from scratch */
function clean(list) {
  if (!Array.isArray(list)) throw new Error("Expected a list.");
  if (list.length > MAX_ITEMS) throw new Error(`Too many items (limit ${MAX_ITEMS}).`);

  return list.map((item, i) => {
    const n = i + 1;
    if (!item || typeof item !== "object") throw new Error(`Item ${n} isn't an object.`);
    if (!TONES.has(item.state))            throw new Error(`Item ${n} has an unknown tone.`);
    if (typeof item.text !== "string" || !item.text.trim())
                                           throw new Error(`Item ${n} has no text.`);
    if (item.text.length > MAX_CHARS)       throw new Error(`Item ${n} is too long.`);

    const out = { state: item.state, text: item.text.trim() };

    if (typeof item.note === "string" && item.note.trim()) {
      if (item.note.length > MAX_CHARS) throw new Error(`Item ${n}'s note is too long.`);
      out.note = item.note.trim();
    }
    return out;
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/progress") {
      if (request.method === "GET") {
        const stored = await env.PROGRESS_KV.get(KEY, "json");
        return json(stored ?? []);
      }

      if (request.method === "PUT") {
        if (!env.EDIT_KEY) {
          return json({ error: "No EDIT_KEY secret is set on this Worker." }, 500);
        }
        if (!safeEqual(request.headers.get("X-Edit-Key") ?? "", env.EDIT_KEY)) {
          return json({ error: "Wrong key." }, 401);
        }

        let list;
        try {
          list = clean(await request.json());
        } catch (err) {
          return json({ error: err.message }, 400);
        }

        await env.PROGRESS_KV.put(KEY, JSON.stringify(list));
        return json(list);
      }

      return json({ error: "Use GET or PUT." }, 405);
    }

    return env.ASSETS.fetch(request);
  }
};
