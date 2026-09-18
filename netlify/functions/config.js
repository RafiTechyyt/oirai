// Host configuration for "Obviously, I'm Right".
// One source of truth, set once by the owner and served to every visitor:
// default AI provider, default accent, the Firebase URL for two-device rooms,
// and (optionally) the provider API keys — all stored in a Netlify Blob.
//
//   GET  /.netlify/functions/config?ping=1  ->  {ok:true}  (health check)
//   GET  /.netlify/functions/config?auth=1   ->  {ok:true, authed:true|false}
//                                                (checks the oir_admin session cookie
//                                                 OR the x-admin-token header)
//   POST /.netlify/functions/config?login=1  ->  {password}. Sets a 1-hour httpOnly
//                                                session cookie on success.
//   POST /.netlify/functions/config?logout=1 ->  clears the session cookie
//   GET  /.netlify/functions/config          ->  public config (no keys, only "hasKeys" flags)
//   POST /.netlify/functions/config          ->  admin save. Requires a valid session
//                                                (cookie or x-admin-token header):
//         body: { provider?, accent?, firebaseUrl?, title?, keys?:{groq?,openai?,gemini?}, clear?:{groq|openai|gemini} }
//
// ADMIN_TOKEN must be set in Netlify (Site configuration -> Environment variables).
// The /ai function reads keys from this same blob first, env vars as fallback.
import { getStore } from "@netlify/blobs";
import { createHmac, timingSafeEqual } from "node:crypto";

const BLOB_STORE = { name: "oir-setup", consistency: "strong" };
const PROVIDERS = ["groq", "openai", "gemini"];
const SESSION = "oir_admin";
const SESSION_MS = 60 * 60 * 1000; // 1 hour
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Accept, x-admin-token",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS"
};

const b64u = (s) => Buffer.from(s, "utf8").toString("base64url");
const b64ud = (s) => Buffer.from(s, "base64url").toString("utf8");
const sign = (payload, secret) => {
  const p = b64u(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(p).digest("base64url");
  return `${p}.${sig}`;
};
function verifySession(tok, secret) {
  if (!tok || typeof tok !== "string") return null;
  const i = tok.lastIndexOf(".");
  if (i <= 0) return null;
  const p = tok.slice(0, i), sig = tok.slice(i + 1);
  const expect = createHmac("sha256", secret).update(p).digest("base64url");
  const a = Buffer.from(expect, "base64url"), b = Buffer.from(sig, "base64url");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const pl = JSON.parse(b64ud(p));
    if (pl && pl.admin && pl.exp && Date.now() < pl.exp) return pl;
  } catch (e) {}
  return null;
}
function readCookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const kv = part.trim().split("=");
    if (kv[0] === name) return decodeURIComponent(kv.slice(1).join("=") || "");
  }
  return null;
}
const cookieSet  = () => `${SESSION}=${sign({ admin: 1, exp: Date.now() + SESSION_MS }, process.env.ADMIN_TOKEN || "")}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`;
const cookieClear = () => `${SESSION}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

/* is this request an authenticated admin? session cookie OR x-admin-token header */
function isAdmin(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const session = verifySession(readCookie(req, SESSION), expected);
  if (session) return true;
  const hdr = req.headers.get("x-admin-token");
  return !!hdr && hdr.length === expected.length && timingSafeEqual(Buffer.from(hdr), Buffer.from(expected));
}

function respond(obj, status, sc) {
  const headers = { "Content-Type": "application/json", ...CORS };
  if (sc) headers["Set-Cookie"] = sc;
  return new Response(JSON.stringify(obj), { status, headers });
}

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
  const expected = process.env.ADMIN_TOKEN;
  let store = null;
  try { store = getStore(BLOB_STORE); } catch (e) {}

  if (req.method === "GET") {
    if (url.searchParams.get("ping")) return respond({ ok: true, name: "oir-config" });
    if (url.searchParams.get("auth")) return respond({ ok: true, authed: isAdmin(req) });
    let cfg = null;
    if (store) { try { cfg = await store.get("setup", { type: "json" }); } catch (e) {} }
    return respond(publicView(cfg));
  }

  if (req.method === "POST" || req.method === "PUT") {
    /* login / logout are auth actions, not storage actions */
    if (url.searchParams.get("login")) {
      if (!expected) return respond({ ok: false, error: "admin", message: "ADMIN_TOKEN isn't set on the server yet." }, 401);
      let body;
      try { body = await req.json(); } catch (e) { return respond({ ok: false, error: "json", message: "Body must be JSON." }, 400); }
      const pass = String(body && body.password || "");
      const ok = pass.length === expected.length && timingSafeEqual(Buffer.from(pass), Buffer.from(expected));
      return ok
        ? respond({ ok: true, name: "oir-config", authed: true }, 200, cookieSet())
        : respond({ ok: false, error: "admin", message: "Wrong host password." }, 401);
    }
    if (url.searchParams.get("logout")) return respond({ ok: true }, 200, cookieClear());

    if (!isAdmin(req)) return respond({ ok: false, error: "admin", message: "Log in first (wrong or missing host password)." }, 401);
    if (!store) return respond({ ok: false, error: "storage_offline", message: "Blob storage isn't available here." }, 500);
    let body;
    try { body = await req.json(); } catch (e) { return respond({ ok: false, error: "json", message: "Body must be JSON." }, 400); }
    if (!body || typeof body !== "object") return respond({ ok: false, error: "json", message: "Body must be an object." }, 400);

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
    return respond({ saved: true, ...publicView(next) });
  }

  return respond({ ok: false, error: "method", message: `${req.method} is not supported here.` }, 405);
};

export const config = {
  rateLimit: {
    action: "rate_limit",
    aggregateBy: "ip",
    windowSize: 60,
    windowLimit: 90
  }
};