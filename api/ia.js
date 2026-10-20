// Ponte entre o painel e a IA, usada pelo server.js (no Mac) e pela Vercel (site publicado).
// Usa a OpenAI (OPENAI_API_KEY) ou o Claude (ANTHROPIC_API_KEY); AI_PROVIDER escolhe quando houver as duas.
// A chave fica só no servidor; o navegador recebe o texto em streaming, uma linha JSON por pedaço.
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { createHash, timingSafeEqual } from "node:crypto";

const MAX_BODY_BYTES = 400_000;
let openai; // clientes criados no primeiro pedido, depois que as variáveis de ambiente já foram lidas
let anthropic;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function provider() {
  const want = (process.env.AI_PROVIDER || "").toLowerCase();
  if (want === "openai" && process.env.OPENAI_API_KEY) return "openai";
  if (want === "claude" && process.env.ANTHROPIC_API_KEY) return "claude";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "claude";
  return null;
}

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

/* ---------- OpenAI ---------- */
async function streamOpenAI(messages, send, signal) {
  openai ??= new OpenAI(); // lê OPENAI_API_KEY do ambiente
  const stream = await openai.chat.completions.create(
    {
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages,
      stream: true,
      max_completion_tokens: 16000,
    },
    { signal }
  );
  let text = "";
  let finish = null;
  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    if (!choice) continue;
    const delta = choice.delta && choice.delta.content;
    if (delta) { text += delta; send({ t: delta }); }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  const stop = finish === "length" ? "max_tokens" : finish === "content_filter" ? "refusal" : "end_turn";
  return { stop, text };
}

function openaiError(err) {
  if (err instanceof OpenAI.APIError) {
    if (err.code === "insufficient_quota") return "no_credit";
    if (err.status === 429) return "rate_limited";
    if (err.status === 401 || err.status === 403 || err.status === 404) return "server_config";
    if (err.status === 400 && /context_length|maximum context|too long/i.test(err.message)) return "prompt_too_large";
    if (err.status === 400) return "invalid_request";
  }
  return null;
}

/* ---------- Claude ---------- */
const CLAUDE_EFFORT = { quick: "low", default: "medium", complex: "high" };

async function streamClaude(messages, tier, send, signal) {
  anthropic ??= new Anthropic(); // lê ANTHROPIC_API_KEY do ambiente
  const model = process.env.CLAUDE_MODEL || "claude-opus-5-5";
  const params = { model, max_tokens: 64000, output_config: { effort: CLAUDE_EFFORT[tier] || "medium" }, messages };
  // Se o modelo recusar por política, a API tenta de novo no modelo recomendado (Haiku não tem fallback).
  if (!model.startsWith("claude-haiku")) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  const stream = anthropic.beta.messages.stream(params, { signal });
  stream.on("text", (delta) => send({ t: delta }));
  const msg = await stream.finalMessage();
  // Se houve troca de modelo no meio, o texto válido é o que vem depois do último bloco de fallback.
  let start = 0;
  msg.content.forEach((b, i) => { if (b.type === "fallback") start = i + 1; });
  const text = msg.content.slice(start).filter((b) => b.type === "text").map((b) => b.text).join("");
  return { stop: msg.stop_reason, text };
}

function claudeError(err) {
  if (err instanceof Anthropic.APIError) {
    if (err.status === 429 || err.status === 529) return "rate_limited";
    if (err.status === 401 || err.status === 403) return "server_config";
    if (err.status === 400 && /credit balance/i.test(err.message)) return "no_credit";
    if (err.status === 400 && /too long|too large|context/i.test(err.message)) return "prompt_too_large";
    if (err.status === 400) return "invalid_request";
  }
  return null;
}

/* ---------- Rota ---------- */
export async function POST(request) {
  const which = provider();
  if (!which) return json(500, { error: "server_config", message: "Falta a chave da IA (OPENAI_API_KEY ou ANTHROPIC_API_KEY)." });
  const denied = checkPassword(request);
  if (denied) return json(denied.status, { error: denied.error, message: denied.message });

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: "prompt_too_large" });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: "invalid_request" }); }
  const messages = cleanMessages(body.messages);
  if (!messages) return json(400, { error: "invalid_request" });

  const encoder = new TextEncoder();
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort());

  const out = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const result = which === "openai"
          ? await streamOpenAI(messages, send, abort.signal)
          : await streamClaude(messages, body.tier, send, abort.signal);
        send({ done: true, stop: result.stop, text: result.text });
      } catch (err) {
        const code = (which === "openai" ? openaiError(err) : claudeError(err)) || (abort.signal.aborted ? "cancelled" : "upstream_error");
        send({ error: code, message: err && err.message ? String(err.message).slice(0, 300) : "" });
      } finally {
        controller.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(out, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
