// Roda o painel no seu Mac: serve a pasta public/ e o Professor IA em /api/claude.
// Uso: npm start  (ou dois cliques em "Abrir painel.command")
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { POST as claudePost } from "./api/claude.js";

const root = fileURLToPath(new URL("./public/", import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

async function handleClaude(req, res, url) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === "string"));
  const response = await claudePost(new Request(url, { method: "POST", headers, body: Buffer.concat(chunks), signal: abort.signal }));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) for await (const chunk of response.body) res.write(chunk);
  res.end();
}

async function handleStatic(res, url) {
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(root, path));
  if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Não encontrado");
  }
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    try {
      if (url.pathname === "/api/claude" && req.method === "POST") await handleClaude(req, res, url);
      else if (req.method === "GET" || req.method === "HEAD") await handleStatic(res, url);
      else res.writeHead(405).end();
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Erro no servidor local");
    }
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`Painel rodando em http://localhost:${PORT}`);
    console.log(process.env.ANTHROPIC_API_KEY ? "Professor IA: ligado" : "Professor IA: desligado (falta a chave no arquivo .env)");
    console.log("Para fechar, feche esta janela ou aperte Ctrl+C.");
  });
