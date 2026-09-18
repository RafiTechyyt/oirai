// Host configuration for "Obviously, I'm Right".
// One source of truth, set once by the owner and served to every visitor:
// default AI provider, default accent, the Firebase URL for two-device rooms,
// and (optionally) the provider API keys — all stored in a Netlify Blob.
//
//   GET  /.netlify/functions/config?ping=1  ->  {ok:true}  (health check)
//   GET  /.netlify/functions/config          ->  public config (no keys, only "hasKeys" flags)
//   POST /.netlify/functions/config          ->  admin save. Requires header:
//         x-admin-token: <the ADMIN_TOKEN Netlify env var>
//         body: { provider?, accent?, firebaseUrl?, title?, keys?:{groq?,openai?,gemini?}, clear?:{groq?|openai?|gemini?} }
//
// ADMIN_TOKEN must be set in Netlify (Site configuration -> Environment variables).
// The /ai function reads keys from this same blob first, env vars as fallback.
import { getStore } from "@netlify/blobs";

const BLOB_STORE = { name: "oir-setup", consistency: "strong" };
const PROVIDERS = ["groq", "openai", "gemini"];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Accept, x-admin-token",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS"
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS }
  });

/* the public view of the config — never includes the keys themselves */
function publicView(cfg) {
  const keys = (cfg && cfg.keys && typeof cfg.keys === "object") ? cfg.keys : {};
  const hasEnv = (p) => !!process.env[`${p.toUpperCase()}_API_KEY`];
  const has = (p) => !!(keys[p] && String(keys[p]).trim()) || hasEnv(p);
  return {
    ok: true,
    adminSet: !!cfg,
    provider: (cfg && cfg.provider) || "groq",
    accent: (cfg && cfg.accent) || "auto",
    firebaseUrl: (cfg && cfg.firebaseUrl) ? String(cfg.firebaseUrl) : "",
    title: (cfg && cfg.title) || "",
    revision: (cfg && cfg.revision) || 0,
    hasKeys: { groq: has("groq"), openai: has("openai"), gemini: has("gemini") },
    keysFrom: cfg && (keys.groq || keys.openai || keys.gemini) ? "cloud-config" : "netlify-env"
  };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  let store = null;
  try { store = getStore(BLOB_STORE); } catch (e) {}

  if (req.method === "GET") {
    if (url.searchParams.get("ping")) return json({ ok: true, name: "oir-config" });
    let cfg = null;
    if (store) { try { cfg = await store.get("setup", { type: "json" }); } catch (e) {} }
    return json(publicView(cfg));
  }

  if (req.method === "POST" || req.method === "PUT") {
    if (!store) return json({ ok: false, error: "storage_offline", message: "Blob storage isn't available here." }, 500);
    const expected = process.env.ADMIN_TOKEN;
    if (!expected || req.headers.get("x-admin-token") !== expected) {
      return json({ ok: false, error: "admin", message: "Wrong or missing host password (set ADMIN_TOKEN in Netlify)." }, 401);
    }
    let body;
    try { body = await req.json(); } catch (e) { return json({ ok: false, error: "json", message: "Body must be JSON." }, 400); }
    if (!body || typeof body !== "object") return json({ ok: false, error: "json", message: "Body must be an object." }, 400);

    let cfg = null;
    try { cfg = await store.get("setup", { type: "json" }); } catch (e) {}
    cfg = cfg && typeof cfg === "object" ? cfg : {};

    const keys = Object.assign({}, (cfg.keys && typeof cfg.keys === "object") ? cfg.keys : {});
    const clear = (body.clear && typeof body.clear === "object") ? body.clear : {};
    PROVIDERS.forEach((p) => {
      if (clear[p]) { delete keys[p]; return; }
      const v = (body.keys && body.keys[p] && String(body.keys[p]).trim()) || "";
      if (v) keys[p] = v;
    });

    const next = {
      provider: PROVIDERS.includes(body.provider) ? body.provider : cfg.provider || "groq",
      accent: typeof body.accent === "string" && body.accent.trim() ? body.accent.trim() : cfg.accent || "auto",
      firebaseUrl: typeof body.firebaseUrl === "string" ? body.firebaseUrl.trim().replace(/\/+$/, "") : cfg.firebaseUrl || "",
      title: typeof body.title === "string" ? body.title.trim() : cfg.title || "",
      keys,
      revision: (cfg.revision || 0) + 1,
      updatedAt: new Date().toISOString()
    };
    await store.setJSON("setup", next);
    return json({ saved: true, ...publicView(next) });
  }

  return json({ ok: false, error: "method", message: `${req.method} is not supported here.` }, 405);
};

export const config = {
  rateLimit: {
    action: "rate_limit",
    aggregateBy: "ip",
    windowSize: 60,
    windowLimit: 90
  }
};