// Guarda o progresso no próprio navegador (localStorage) e liga o Professor IA à rota /api/ia.
// Expõe window.AppBackend.use("db" | "sample"), no mesmo formato que o painel já usava no claude.ai.
(function () {
  const STORE = "gmsg:docs";
  const PASS = "gmsg:senha-ia";
  const APP = "painel-gm-sao-goncalo";
  const $ = (s) => document.querySelector(s);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  }

  /* ---------- Banco local: um mapa "colecao/id" -> documento ---------- */
  let storageOk = true;
  try { localStorage.setItem("gmsg:teste", "1"); localStorage.removeItem("gmsg:teste"); } catch { storageOk = false; }

  function readStore() {
    try { const raw = localStorage.getItem(STORE); return new Map(Object.entries(raw ? JSON.parse(raw) : {})); }
    catch { return new Map(); }
  }
  function writeStore() {
    try { localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(cache))); }
    catch { throw { code: "quota_exceeded", message: "O navegador não tem mais espaço para salvar. Baixe um backup e apague registros antigos." }; }
    info();
  }

  const cache = readStore();
  const docListeners = new Map();
  const colListeners = new Map();
  const key = (c, i) => c + "/" + i;
  const split = (path) => { const j = path.indexOf("/"); return [path.slice(0, j), path.slice(j + 1)]; };

  function snapDoc(c, i) {
    const d = cache.get(key(c, i));
    return { id: i, exists: d !== undefined, data: () => d, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function snapCol(c) {
    const docs = [];
    for (const [k, d] of cache) {
      const j = k.indexOf("/");
      if (k.slice(0, j) === c) docs.push({ id: k.slice(j + 1), exists: true, data: () => d });
    }
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function emit(c, i) {
    (docListeners.get(key(c, i)) || []).forEach((fn) => fn(snapDoc(c, i)));
    (colListeners.get(c) || []).forEach((fn) => fn(snapCol(c)));
  }
  function listen(map, k, fn) {
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(fn);
    return () => map.get(k).delete(fn);
  }

  // Outra aba do painel salvou algo: atualiza esta também.
  window.addEventListener("storage", (e) => {
    if (e.key !== STORE) return;
    const next = readStore();
    const changed = new Set();
    for (const [k, d] of next) if (JSON.stringify(cache.get(k)) !== JSON.stringify(d)) changed.add(k);
    for (const k of cache.keys()) if (!next.has(k)) changed.add(k);
    for (const k of changed) {
      if (next.has(k)) cache.set(k, next.get(k)); else cache.delete(k);
      const [c, i] = split(k);
      emit(c, i);
    }
  });

  function docRef(c, i) {
    return {
      id: i,
      path: key(c, i),
      get: async () => snapDoc(c, i),
      set: async (data) => { cache.set(key(c, i), data); writeStore(); emit(c, i); },
      update: async (patch) => {
        const cur = cache.get(key(c, i));
        if (cur === undefined) throw { code: "invalid_argument", message: "documento não existe" };
        cache.set(key(c, i), { ...cur, ...patch }); writeStore(); emit(c, i);
      },
      delete: async () => { cache.delete(key(c, i)); writeStore(); emit(c, i); },
      onSnapshot: (next) => {
        const off = listen(docListeners, key(c, i), next);
        queueMicrotask(() => next(snapDoc(c, i)));
        return off;
      },
    };
  }
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/-/g, "").slice(0, 20);
  const db = {
    doc: (path) => { const [c, i] = split(path); return docRef(c, i); },
    collection: (c) => ({
      path: c,
      doc: (id) => docRef(c, id || newId()),
      add: async (data) => { const ref = docRef(c, newId()); await ref.set(data); return ref; },
      onSnapshot: (next) => {
        const off = listen(colListeners, c, next);
        queueMicrotask(() => next(snapCol(c)));
        return off;
      },
    }),
  };

  /* ---------- Professor IA: /api/claude devolve o texto em linhas JSON ---------- */
  function parseJsonLoose(text) {
    const t = text.trim();
    try { return JSON.parse(t); } catch { /* tenta os outros formatos */ }
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) { try { return JSON.parse(fence[1]); } catch { /* segue */ } }
    const a = t.search(/[\[{]/), b = Math.max(t.lastIndexOf("]"), t.lastIndexOf("}"));
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* segue */ } }
    return undefined;
  }
  function savedPassword() { try { return localStorage.getItem(PASS) || ""; } catch { return ""; } }

  async function sample(input, opts = {}) {
    const messages = typeof input === "string" ? [{ role: "user", content: input }] : input;
    let res;
    try {
      res = await fetch("/api/ia", {
        method: "POST",
        headers: { "content-type": "application/json", "x-app-password": savedPassword() },
        body: JSON.stringify({ messages, tier: opts.modelTier || "default" }),
        signal: opts.signal,
      });
    } catch (e) {
      if (opts.signal && opts.signal.aborted) throw { code: "cancelled" };
      throw { code: "upstream_error", message: String(e) };
    }
    if (!res.ok) {
      let j = {};
      try { j = await res.json(); } catch { /* sem corpo */ }
      const byStatus = { 401: "not_granted", 403: "not_granted", 404: "server_config", 413: "prompt_too_large", 429: "rate_limited" };
      throw { code: j.error === "bad_password" ? "not_granted" : j.error || byStatus[res.status] || "upstream_error", message: j.message || res.statusText };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", text = "", final = null, stop = null, fail = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (typeof ev.t === "string") { text += ev.t; if (opts.onText) opts.onText({ text, delta: ev.t }); }
          else if (ev.done) { stop = ev.stop; final = ev.text; }
          else if (ev.error) fail = ev;
        }
      }
    } catch {
      if (opts.signal && opts.signal.aborted) throw { code: "cancelled", text: text || undefined };
      throw { code: "upstream_error", text: text || undefined };
    }
    if (fail) throw { code: fail.error, message: fail.message || "", text: text || undefined };
    if (stop === "refusal") throw { code: "refused", message: "recusado" };
    const out = typeof final === "string" ? final : text;
    if (!out.trim()) throw { code: "empty_completion", message: "" };
    if (out !== text && opts.onText) opts.onText({ text: out, delta: out });
    return { text: out, truncated: stop === "max_tokens", modelTierApplied: opts.modelTier || "default" };
  }
  sample.json = async (input, opts) => {
    const r = await sample(input, opts);
    const v = parseJsonLoose(r.text);
    if (v === undefined) throw { code: "invalid_json", message: "resposta sem JSON", text: r.text };
    return v;
  };

  window.AppBackend = { use: (name) => Promise.resolve(name === "db" ? (storageOk ? db : null) : name === "sample" ? sample : null) };

  /* ---------- Aba Ajustes: backup e senha da IA ---------- */
  function info() {
    const el = $("#aj-info");
    if (!el) return;
    const kb = Math.ceil(JSON.stringify(Object.fromEntries(cache)).length / 1024);
    el.textContent = `${cache.size} registros · ${kb} KB`;
  }
  function exportBackup() {
    const data = { app: APP, versao: 1, exportado: new Date().toISOString(), docs: Object.fromEntries(cache) };
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `backup-painel-gm-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    const msg = $("#aj-msg");
    msg.className = "form-msg ok";
    msg.textContent = "Backup baixado. Guarde o arquivo na pasta do concurso.";
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (!$("#aj-export")) return;
    info();
    $("#aj-export").addEventListener("click", exportBackup);

    let pending = null;
    $("#aj-import").addEventListener("change", async (ev) => {
      const msg = $("#aj-msg"), file = ev.target.files && ev.target.files[0];
      ev.target.value = "";
      $("#aj-confirm").hidden = true;
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (data.app !== APP || !data.docs || typeof data.docs !== "object") throw new Error("formato");
        pending = data.docs;
        msg.className = "form-msg";
        msg.textContent = `Backup de ${new Date(data.exportado).toLocaleDateString("pt-BR")} com ${Object.keys(data.docs).length} registros. Ele substitui tudo o que está salvo neste navegador.`;
        $("#aj-confirm").hidden = false;
      } catch {
        pending = null;
        msg.className = "form-msg bad";
        msg.textContent = "Esse arquivo não é um backup do painel.";
      }
    });
    $("#aj-confirm").addEventListener("click", () => {
      if (!pending) return;
      cache.clear();
      for (const [k, v] of Object.entries(pending)) cache.set(k, v);
      try { writeStore(); } catch (e) { $("#aj-msg").className = "form-msg bad"; $("#aj-msg").textContent = e.message; return; }
      location.reload();
    });

    const pass = $("#aj-senha");
    pass.value = savedPassword();
    $("#aj-salvar").addEventListener("click", () => {
      try { localStorage.setItem(PASS, pass.value); } catch { /* sem armazenamento */ }
      $("#aj-senha-msg").className = "form-msg ok";
      $("#aj-senha-msg").textContent = pass.value ? "Senha salva neste navegador." : "Senha apagada.";
    });
  });
  window.addEventListener("storage", info);
})();
