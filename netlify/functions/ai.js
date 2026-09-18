// AI proxy for "Obviously, I'm Right".
// Keeps the provider API keys in Netlify environment variables instead of the
// client bundle. The page calls this instead of the providers directly when the
// proxy is reachable; keys are never shipped to browsers.
//
//   GET  /.netlify/functions/ai?ping=1  ->  {ok:true}  (health check, used by the client)
//   POST /.netlify/functions/ai
//        body: {provider:"groq"|"openai"|"gemini", turns:[{role,content}], json:bool, tier:"quick"|"default"|"complex"}
//        -> streams an OpenAI-style SSE response (data: {"choices":[{"delta":{"content":"..."}}]})
//
// Environment variables to set in Netlify (Site configuration -> Environment variables):
//   GROQ_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY
// A provider without its env var is skipped and returns a clear error.

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

const PROVIDERS = {
  groq: {
    endpoint: () => "https://api.groq.com/openai/v1/chat/completions",
    key: () => process.env.GROQ_API_KEY,
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
    key: () => process.env.OPENAI_API_KEY,
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
    key: () => process.env.GEMINI_API_KEY,
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

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (req.method === "GET") return json({ ok: true, name: "oir-ai-proxy" });

  const body = await req.json().catch(() => null);
  const provider = body?.provider;
  const turns = body?.turns;
  const wantJson = !!body?.json;
  const tier = body?.tier || "default";

  const conf = PROVIDERS[provider];
  if (!conf) return json({ error: `unknown provider: ${provider}` }, 400);
  if (!Array.isArray(turns) || !turns.length) return json({ error: "turns is required" }, 400);

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