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
import { createHash } from "node:crypto";

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
   otherwise it falls back to the free Google Translate voice for the same
   language. Audio is cached in the blob store so repeats cost nothing. */
const AZURE_VOICES = {
  "ml-IN": ["ml-IN-SobhanaNeural", "ml-IN-MidhunNeural"],
  "hi-IN": ["hi-IN-MadhurNeural", "hi-IN-SwaraNeural", "hi-IN-AaravNeural"]
};
const GT_LANG = { "ml-IN": "ml", "hi-IN": "hi" };
const escXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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
    const audio = (await azureSpeak(text, lang)) || (await googleSpeak(text, lang));
    if (!audio) return json({ error: "TTS backend unavailable — set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION for reliable cloud voices" }, 502);
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