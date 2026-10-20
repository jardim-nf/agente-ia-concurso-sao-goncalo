// Ponte entre o painel e a API do Claude, usada pelo server.js (no Mac) e pela Vercel (site publicado).
// A chave da API fica só no servidor (variável ANTHROPIC_API_KEY); o navegador recebe o texto em streaming.
import Anthropic from "@anthropic-ai/sdk";
import { createHash, timingSafeEqual } from "node:crypto";

let client; // criado no primeiro pedido, depois que as variáveis de ambiente já foram lidas

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const EFFORT = { quick: "low", default: "medium", complex: "high" };
const MAX_BODY_BYTES = 400_000;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// No Mac (server.js) a IA fica aberta só para o próprio computador.
// Publicado na Vercel, exige a senha APP_PASSWORD, para ninguém mais gastar a sua chave.
function checkPassword(request) {
  const expected = process.env.APP_PASSWORD || "";
  if (!expected) {
    return process.env.VERCEL ? { status: 500, error: "server_config", message: "Defina APP_PASSWORD nas variáveis da Vercel." } : null;
  }
  const given = request.headers.get("x-app-password") || "";
  const digest = (s) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(given), digest(expected)) ? null : { status: 401, error: "bad_password" };
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
  if (!process.env.ANTHROPIC_API_KEY) {
    return json(500, { error: "server_config", message: "Falta a chave ANTHROPIC_API_KEY." });
  }
  const denied = checkPassword(request);
  if (denied) return json(denied.status, { error: denied.error, message: denied.message });
  client ??= new Anthropic(); // lê ANTHROPIC_API_KEY do ambiente

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
