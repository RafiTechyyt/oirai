// AI proxy for "Obviously, I'm Right".
// Keeps the provider API keys server-side. Keys are read from the host
// config blob (saved by the admin panel through /config) first, then from
// Netlify environment variables as a fallback. Keys are never shipped to
// browsers.
//
//   GET  /.netlify/functions/ai?ping=1  ->  {ok:true}  (health check, used by the client)
//   POST /.netlify/functions/ai?tts=1
//        body: {text, lang:"ml-IN"|"hi-IN"}    ->  audio/mpeg (cloud voice, cached)
import { getStore } from "@netlify/blobs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import https from "node:https";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS }
  });

/* keys saved by the host admin panel (blob) take priority over env vars */
let cachedKeys = null;
async function adminKeys() {
  if (cachedKeys) return cachedKeys;
  try {
    const store = getStore({ name: "oir-setup", consistency: "strong" });
    const cfg = await store.get("setup", { type: "json", consistency: "strong" });
    cachedKeys = (cfg && cfg.keys && typeof cfg.keys === "object") ? cfg.keys : {};
  } catch (e) {
    cachedKeys = {};
  }
  return cachedKeys;
}
const keyFor = (name) => {
  const k = (cachedKeys || {})[name];
  return (k && String(k).trim()) || process.env[`${name.toUpperCase()}_API_KEY`] || "";
};

const PROVIDERS = {
  groq: {
    endpoint: () => "https://api.groq.com/openai/v1/chat/completions",
    key: () => keyFor("groq"),
    build: (turns, tier, wantJson) => {
      const body = {
        model: tier === "complex" ? "openai/gpt-oss-120b" : "openai/gpt-oss-20b",
        messages: turns.map((t) => ({ role: t.role === "assistant" ? "assistant" : "user", content: t.content })),
        temperature: 0.75,
        max_tokens: 3000,
        stream: true
      };
      if (wantJson) body.response_format = { type: "json_object" };
      return body;
    }
  },
  openai: {
    endpoint: () => "https://api.openai.com/v1/chat/completions",
    key: () => keyFor("openai"),
    build: (turns, tier, wantJson) => {
      const body = {
        model: "gpt-6-astra",
        messages: turns.map((t) => ({ role: t.role === "assistant" ? "assistant" : "user", content: t.content })),
        reasoning_effort: tier === "complex" ? "high" : tier === "quick" ? "low" : "medium",
        max_completion_tokens: tier === "quick" ? 1024 : 8000,
        stream: true
      };
      if (wantJson) body.response_format = { type: "json_object" };
      return body;
    }
  },
  gemini: {
    endpoint: (tier) => {
      const model = tier === "complex" ? "gemini-pro-latest" : "gemini-flash-latest";
      return `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
    },
    key: () => keyFor("gemini"),
    build: (turns, tier, wantJson) => {
      const body = {
        contents: turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] })),
        generationConfig: { temperature: 0.75, maxOutputTokens: 3000 }
      };
      if (wantJson) body.generationConfig.responseMimeType = "application/json";
      return body;
    }
  }
};

/* extract the next bit of generated text from any provider's chunk */
function delta(j) {
  const a = j.choices?.[0]?.delta?.content;
  if (a) return a;
  const b = j.choices?.[0]?.message?.content;
  if (b) return b;
  return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
}

/* ---- cloud text-to-speech so Malayalam/Hindi replies are actually spoken ----
   Azure Speech is used when AZURE_SPEECH_KEY + AZURE_SPEECH_REGION are set;
   otherwise a real neural voice (the same Sobhana/Madhur neural voices Azure
   uses) is synthesized through the free Edge read-aloud service; Google's
   Translate voice is only a last resort. Audio is cached in the blob store so
   repeats cost nothing. */
const AZURE_VOICES = {
  "ml-IN": ["ml-IN-SobhanaNeural", "ml-IN-MidhunNeural"],
  "hi-IN": ["hi-IN-MadhurNeural", "hi-IN-SwaraNeural", "hi-IN-AaravNeural"]
};
const GT_LANG = { "ml-IN": "ml", "hi-IN": "hi" };
const escXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* Sec-MS-GEC: HMAC-style token over the 5-minute Windows-filetime window.
   Must be exact integer math (ticks exceed 2^53). "1-<full chromium>"
   must match the User-Agent, and the version needs the FULL Chromium string —
   a short "1-143" is rejected by the WAF. */
const EDGE_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_VERSION = "143.0.3650.75";
const edgeSecMsGec = () => {
  const s = Math.floor(Date.now() / 1000) + 11644473600
  const s5 = s - (s % 300);
  const ticks = BigInt(s5) * 10000000n;
  return createHash("sha256").update(ticks.toString() + EDGE_TOKEN).digest("hex").toUpperCase();
};
const edgeNow = () => {
  const d = new Date();
  const D = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"], M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"], p = (n) => String(n).padStart(2, "0");
  return `${D[d.getUTCDay()]} ${M[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
};
const uuidHex = () => randomUUID().replace(/-/g, "");
const maskFrame = (payload) => {
  const mask = randomBytes(4);
  const masked = payload.map((b, i) => b ^ mask[i % 4]);
  const len = payload.length;
  const h = len < 126
    ? Buffer.from([0x81, 0x80 | len])
    : Buffer.concat([Buffer.from([0x81, 0x80 | 126]), Buffer.from([(len >> 8) & 0xff, len & 0xff])]);
  return Buffer.concat([h, mask, masked]);
};

/* synthesize with the free Edge neural voice over a raw WebSocket (no deps) */
async function edgeSpeak(text, lang) {
  const voices = AZURE_VOICES[lang];
  if (!voices || !voices.length) return null;
  return await new Promise((resolve) => {
    let sock = null;
    const chunks = [];
    let pending = Buffer.alloc(0);
    let settled = false;
    let pieces = [];
    let sayNext = null;

    const finish = (buf) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { if (sock) sock.destroy(); } catch (e) {}
      resolve(buf);
    };
    const timeout = setTimeout(() => finish(null), 20000);

    const req = https.request({
      host: "speech.platform.bing.com",
      port: 443,
      method: "GET",
      path: `/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TOKEN}&Sec-MS-GEC=${edgeSecMsGec()}&Sec-MS-GEC-Version=1-${EDGE_VERSION}&ConnectionId=${uuidHex()}`,
      headers: {
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${EDGE_VERSION.split(".")[0]}.0.0.0 Safari/537.36 Edg/${EDGE_VERSION.split(".")[0]}.0.0.0`,
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Cookie": `muid=${randomBytes(16).toString("hex").toUpperCase()};`,
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64")
      }
    });

    /* incremental frame parser: server frames are unmasked, we just peel them */
    const parse = (data) => {
      pending = Buffer.concat([pending, data]);
      while (true) {
        if (pending.length < 2) break;
        const b0 = pending[0], b1 = pending[1];
        const l = b1 & 0x7f;
        let off = 2, fl = l;
        if (l === 126) { if (pending.length < 4) break; fl = pending.readUInt16BE(2); off = 4; }
        else if (l === 127) { if (pending.length < 10) break; const hi = pending.readUInt32BE(2), lo = pending.readUInt32BE(6); if (hi) break; fl = lo; off = 10; }
        if (pending.length < off + fl) break;
        const payload = pending.slice(off, off + fl);
        pending = pending.slice(off + fl);
        const op = b0 & 0x0f;
        if (op === 1) {
          if (/Path:turn\.end/.test(payload.toString("utf8")) && sayNext) sayNext();
        } else if (op === 2 && payload.length >= 2) {
          const hl = payload.readUInt16BE(0);
          if (hl <= payload.length) {
            const d = payload.slice(2 + hl);
            if (d.length) chunks.push(d);
          }
        }
      }
    };

    req.on("upgrade", (res, sock) => {
      sock.on("data", parse);
      sock.on("close", () => { const total = chunks.reduce((a, b) => a + b.length, 0); finish(total > 1000 ? Buffer.concat(chunks) : null); });
      sock.on("error", () => {});
      const now = edgeNow();
      const send = (t) => { if (sock.writable) sock.write(maskFrame(Buffer.from(t, "utf8"))); };

      send(`X-Timestamp:${now}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" }, outputFormat: "audio-24khz-48kbitrate-mono-mp3" } } } })}\r\n`);

      /* split long text so no SSML chunk exceeds ~1500 chars */
      let rest = escXml(text);
      while (rest.length > 1500) {
        let cut = rest.lastIndexOf(" ", 1500);
        if (cut < 200) cut = 1500;
        pieces.push(rest.slice(0, cut));
        rest = rest.slice(cut).trim();
      }
      if (rest) pieces.push(rest);
      if (!pieces.length) pieces.push("");

      sayNext = () => {
        if (settled) return;
        const piece = pieces.shift();
        if (piece === undefined) { try { sock.end(); } catch (e) {} return; }
        const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'><voice name='${voices[0]}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${piece}</prosody></voice></speak>`;
        send(`X-RequestId:${uuidHex()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${now}Z\r\nPath:ssml\r\n\r\n${ssml}`);
      };
      sayNext();
    });
    req.on("response", (res) => { res.resume(); finish(null); });
    req.on("error", () => finish(null));
    req.end();
  });
}

async function azureSpeak(text, lang) {
  const region = process.env.AZURE_SPEECH_REGION, key = process.env.AZURE_SPEECH_KEY;
  const voices = AZURE_VOICES[lang];
  if (!region || !key || !voices || !voices.length) return null;
  const ssml = `<speak version='1.0' xml:lang='${lang}'><voice name='${voices[0]}'>${escXml(text)}</voice></speak>`;
  const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1/text-to-speech`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
      "User-Agent": "oir-ai-proxy",
      "X-Search-AppId": "00000000000000000000000000000000",
      "X-Search-ClientID": "00000000000000000000000000000000"
    },
    body: ssml
  });
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}

async function googleSpeak(text, lang) {
  const tl = GT_LANG[lang];
  if (!tl) return null;
  const q = encodeURIComponent(text.slice(0, 150));
  const r = await fetch(`https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${tl}&q=${q}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Referer": "https://translate.google.com/"
    }
  });
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}

const audioResp = (buf) =>
  new Response(buf, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "public, max-age=86400",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Accept"
    }
  });

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (req.method === "GET") return json({ ok: true, name: "oir-ai-proxy" });

  const url = new URL(req.url);
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "body must be JSON" }, 400);

  /* cloud voice for Malayalam/Hindi (and any later language) */
  if (url.searchParams.get("tts")) {
    const text = String(body.text || "").trim();
    const lang = String(body.lang || "");
    if (!text) return json({ error: "text is required" }, 400);
    if (!AZURE_VOICES[lang] && !GT_LANG[lang]) return json({ error: `no cloud voice for ${lang}` }, 400);
    const hash = createHash("sha1").update(lang + "|" + text).digest("hex");
    try {
      const store = getStore({ name: "oir-setup", consistency: "strong" });
      const cached = await store.get("tts:" + hash);
      if (cached) return audioResp(await cached.arrayBuffer());
    } catch (e) {}
    const audio = (await azureSpeak(text, lang)) || (await edgeSpeak(text, lang)) || (await googleSpeak(text, lang));
    if (!audio) return json({ error: "TTS backend unavailable — set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION for the most reliable cloud voices" }, 502);
    try {
      const store = getStore({ name: "oir-setup", consistency: "strong" });
      await store.set("tts:" + hash, new Blob([audio]));
    } catch (e) {}
    return audioResp(audio);
  }

  const provider = body.provider;
  const turns = body.turns;
  const wantJson = !!body.json;
  const tier = body.tier || "default";

  const conf = PROVIDERS[provider];
  if (!conf) return json({ error: `unknown provider: ${provider}` }, 400);
  if (!Array.isArray(turns) || !turns.length) return json({ error: "turns is required" }, 400);

  await adminKeys();
  const key = conf.key();
  if (!key) return json({ error: `${provider.toUpperCase()}_API_KEY is not set on this server` }, 500);

  const upstream = await fetch(conf.endpoint(tier), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(conf.build(turns, tier, wantJson))
  });
  if (!upstream.ok) {
    let msg = `HTTP ${upstream.status}`;
    try {
      const j = await upstream.json();
      msg = j.error?.message || j.message || msg;
    } catch (e) {}
    return json({ error: `${provider} upstream ${upstream.status}: ${msg}` }, upstream.status);
  }

  /* some providers stop streaming mid-flight — serve the buffered answer as one event */
  if (!upstream.body) {
    const j = await upstream.json().catch(() => ({}));
    const text =
      j.choices?.[0]?.message?.content ||
      (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("") ||
      "";
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...CORS }
      }
    );
  }

  /* normalise whatever the provider emits into one OpenAI-style SSE shape */
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const ln of lines) {
            const line = ln.trim();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            let j;
            try { j = JSON.parse(data); } catch (e) { continue; }
            const d = delta(j);
            if (d) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`));
          }
        }
      } catch (e) {
        console.error("oir proxy stream failed:", e);
      } finally {
        try { controller.close(); } catch (e) {}
      }
    }
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...CORS }
  });
};