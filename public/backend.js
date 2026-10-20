// Liga o painel ao Supabase (login + dados sincronizados) e à função /api/claude (Professor IA).
// Expõe window.AppBackend.use("db" | "sample"), no mesmo formato que o painel já usava no claude.ai.
(function () {
  const cfg = window.APP_CONFIG || {};
  const configured = Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey);
  const $ = (s) => document.querySelector(s);

  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  window.AppBackend = { use: (name) => ready.then((api) => (api ? api[name] || null : null)) };

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  }

  if (!configured || !window.supabase) {
    showAuth("O site ainda não foi configurado: faltam as variáveis SUPABASE_URL e SUPABASE_ANON_KEY na Vercel.");
    resolveReady(null);
    return;
  }

  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });

  /* ---------- Banco: um documento por linha da tabela docs (col + id) ---------- */
  let uid = null;
  const cache = new Map(); // "col/id" -> data
  const docListeners = new Map();
  const colListeners = new Map();
  const key = (c, i) => c + "/" + i;
  const split = (path) => { const j = path.indexOf("/"); return [path.slice(0, j), path.slice(j + 1)]; };
  const toErr = (e) => ({ code: e && e.code === "42501" ? "invalid_argument" : "unavailable", message: (e && e.message) || "" });

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

  async function fetchAll() {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("docs").select("col,id,data").eq("user_id", uid).range(from, from + 999);
      if (error) throw toErr(error);
      rows.push(...data);
      if (data.length < 1000) break;
    }
    return rows;
  }
  async function refreshAll() {
    let rows;
    try { rows = await fetchAll(); } catch { return; }
    const next = new Map(rows.map((r) => [key(r.col, r.id), r.data]));
    const changed = new Set();
    for (const [k, d] of next) if (JSON.stringify(cache.get(k)) !== JSON.stringify(d)) changed.add(k);
    for (const k of cache.keys()) if (!next.has(k)) changed.add(k);
    for (const k of changed) {
      if (next.has(k)) cache.set(k, next.get(k)); else cache.delete(k);
      const [c, i] = split(k);
      emit(c, i);
    }
  }

  function docRef(c, i) {
    return {
      id: i,
      path: key(c, i),
      get: async () => snapDoc(c, i),
      set: async (data) => {
        cache.set(key(c, i), data);
        emit(c, i);
        const { error } = await sb.from("docs").upsert({ user_id: uid, col: c, id: i, data, updated_at: new Date().toISOString() });
        if (error) throw toErr(error);
      },
      update: async (patch) => {
        const cur = cache.get(key(c, i));
        if (cur === undefined) throw { code: "invalid_argument", message: "documento não existe" };
        return docRef(c, i).set({ ...cur, ...patch });
      },
      delete: async () => {
        cache.delete(key(c, i));
        emit(c, i);
        const { error } = await sb.from("docs").delete().match({ user_id: uid, col: c, id: i });
        if (error) throw toErr(error);
      },
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
  async function sample(input, opts = {}) {
    const messages = typeof input === "string" ? [{ role: "user", content: input }] : input;
    const { data } = await sb.auth.getSession();
    const token = data.session && data.session.access_token;
    if (!token) throw { code: "session_expired", message: "sem sessão" };
    let res;
    try {
      res = await fetch("/api/claude", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
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
      const byStatus = { 401: "session_expired", 403: "not_granted", 413: "prompt_too_large", 429: "rate_limited" };
      throw { code: j.error === "not_allowed" ? "not_granted" : j.error || byStatus[res.status] || "upstream_error", message: j.message || res.statusText };
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

  /* ---------- Login ---------- */
  function showAuth(msg) {
    if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", () => showAuth(msg)); return; }
    const box = $("#auth");
    if (!box) return;
    box.hidden = false;
    if (msg) { $("#auth-msg").textContent = msg; $("#auth-msg").className = "form-msg bad"; }
  }
  async function start(session) {
    uid = session.user.id;
    $("#auth").hidden = true;
    $("#logout").hidden = false;
    try {
      const rows = await fetchAll();
      for (const r of rows) cache.set(key(r.col, r.id), r.data);
    } catch (e) {
      const n = $("#db-notice");
      if (n) { n.textContent = "Não foi possível carregar seus dados. Confira a conexão e recarregue."; n.hidden = false; }
    }
    sb.channel("docs-" + uid)
      .on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: "user_id=eq." + uid }, (p) => {
        if (p.eventType === "DELETE") {
          const o = p.old || {};
          if (o.col && (!o.user_id || o.user_id === uid) && cache.has(key(o.col, o.id))) { cache.delete(key(o.col, o.id)); emit(o.col, o.id); }
        } else if (p.new && p.new.col) {
          const k = key(p.new.col, p.new.id);
          if (JSON.stringify(cache.get(k)) !== JSON.stringify(p.new.data)) { cache.set(k, p.new.data); emit(p.new.col, p.new.id); }
        }
      })
      .subscribe();
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshAll(); });
    resolveReady({ db, sample });
  }

  document.addEventListener("DOMContentLoaded", () => {
    const form = $("#f-auth"), msg = $("#auth-msg");
    const go = async (mode) => {
      const email = $("#auth-email").value.trim(), password = $("#auth-pass").value;
      if (!email || password.length < 6) { msg.className = "form-msg bad"; msg.textContent = "Informe o e-mail e uma senha com pelo menos 6 caracteres."; return; }
      msg.className = "form-msg"; msg.textContent = mode === "up" ? "Criando a conta…" : "Entrando…";
      const r = mode === "up" ? await sb.auth.signUp({ email, password }) : await sb.auth.signInWithPassword({ email, password });
      if (r.error) {
        msg.className = "form-msg bad";
        msg.textContent = /invalid login/i.test(r.error.message) ? "E-mail ou senha incorretos."
          : /not allowed|disabled/i.test(r.error.message) ? "Novos cadastros estão desativados neste site."
          : "Não deu certo: " + r.error.message;
        return;
      }
      if (mode === "up" && !r.data.session) { msg.className = "form-msg ok"; msg.textContent = "Conta criada. Confirme pelo link que chegou no seu e-mail e depois entre."; return; }
    };
    form.addEventListener("submit", (ev) => { ev.preventDefault(); go("in"); });
    $("#auth-signup").addEventListener("click", () => go("up"));
    $("#logout").addEventListener("click", async () => { await sb.auth.signOut(); location.reload(); });
  });

  let started = false;
  sb.auth.onAuthStateChange((_event, session) => {
    if (session && !started) { started = true; start(session); }
  });
  sb.auth.getSession().then(({ data }) => {
    if (data.session) { if (!started) { started = true; start(data.session); } }
    else showAuth();
  });
})();
