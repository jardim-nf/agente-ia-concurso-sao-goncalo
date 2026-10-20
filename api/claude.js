// Função da Vercel que faz a ponte entre o painel e a API do Claude.
// A chave da API fica só aqui no servidor (variável ANTHROPIC_API_KEY);
// o navegador manda o token de login do Supabase e recebe o texto em streaming.
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic(); // lê ANTHROPIC_API_KEY do ambiente da Vercel

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const EFFORT = { quick: "low", default: "medium", complex: "high" };
const MAX_BODY_BYTES = 400_000;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// Confere o login no Supabase e, se ALLOWED_EMAILS estiver definido, se o e-mail está na lista.
async function checkUser(request) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return { status: 401, error: "session_expired" };
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: process.env.SUPABASE_ANON_KEY },
  });
  if (!res.ok) return { status: 401, error: "session_expired" };
  const user = await res.json();
  const allowed = (process.env.ALLOWED_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length && !allowed.includes(String(user.email || "").toLowerCase())) {
    return { status: 403, error: "not_allowed" };
  }
  return { user };
}

// Junta turnos seguidos do mesmo papel e garante que a conversa começa e termina no usuário.
function cleanMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const m of raw) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content.trim()) return null;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  if (!out.length || out[0].role !== "user" || out[out.length - 1].role !== "user") return null;
  return out;
}

function errorCode(err) {
  if (err instanceof Anthropic.APIError) {
    if (err.status === 429 || err.status === 529) return "rate_limited";
    if (err.status === 401 || err.status === 403) return "server_config";
    if (err.status === 400 && /too long|too large|context/i.test(err.message)) return "prompt_too_large";
    if (err.status === 400) return "invalid_request";
  }
  if (err && err.name === "AbortError") return "cancelled";
  return "upstream_error";
}

export async function POST(request) {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return json(500, { error: "server_config", message: "Faltam variáveis de ambiente na Vercel." });
  }
  const auth = await checkUser(request);
  if (auth.error) return json(auth.status, { error: auth.error });

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: "prompt_too_large" });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: "invalid_request" }); }
  const messages = cleanMessages(body.messages);
  if (!messages) return json(400, { error: "invalid_request" });
  const effort = EFFORT[body.tier] || EFFORT.default;

  const params = {
    model: MODEL,
    max_tokens: 64000,
    output_config: { effort },
    messages,
  };
  // Se o modelo recusar por política, a API tenta de novo no modelo recomendado (Haiku não tem fallback).
  if (!MODEL.startsWith("claude-haiku")) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }

  const stream = client.beta.messages.stream(params, { signal: request.signal });
  const encoder = new TextEncoder();

  const out = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      stream.on("text", (delta) => send({ t: delta }));
      try {
        const msg = await stream.finalMessage();
        // Se houve troca de modelo no meio, o texto válido é o que vem depois do último bloco de fallback.
        let start = 0;
        msg.content.forEach((b, i) => { if (b.type === "fallback") start = i + 1; });
        const text = msg.content.slice(start).filter((b) => b.type === "text").map((b) => b.text).join("");
        send({ done: true, stop: msg.stop_reason, text });
      } catch (err) {
        send({ error: errorCode(err), message: err && err.message ? String(err.message).slice(0, 300) : "" });
      } finally {
        controller.close();
      }
    },
    cancel() {
      stream.abort();
    },
  });

  return new Response(out, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
