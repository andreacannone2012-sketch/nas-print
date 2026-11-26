(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  // Icone dallo sprite SVG della pagina (stringhe fisse, nessun dato utente)
  const ic = (name, cls) => {
    const w = document.createElement("span");
    w.innerHTML = `<svg class="ic${cls ? " " + cls : ""}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
    return w.firstChild;
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* storage non disponibile */ } },
  };

  const MAX_BYTES = Number(document.body.dataset.maxMb) * 1024 * 1024;
  const ALLOWED = new Set(document.body.dataset.exts.split(","));
  const RANGE_RE = /^\s*\d+(-\d+)?(\s*,\s*\d+(-\d+)?)*\s*$/;

  const form = $("#print-form");
  const dropzone = $("#dropzone");
  const fileInput = $("#file-input");
  const fileList = $("#file-list");
  const submitBtn = $("#submit");
  const submitLabel = $("#submit-label");
  const results = $("#results");
  const copies = $("#copies");
  const collate = $("#collate");
  const pageRanges = $("#page-ranges");
  const summaryEl = $("#summary");
  const presetsEl = $("#presets");
  const jobsList = $("#jobs");
  const cancelAllBtn = $("#cancel-all");

  let files = [];
  let busy = false;

  const fmtSize = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
  const extOf = (n) => (n.includes(".") ? n.split(".").pop().toLowerCase() : "");
  const clamp = (v) => Math.min(99, Math.max(1, Number.isFinite(v) ? v : 1));

  // ------------------------------------------------------------ impostazioni
  const BUILTIN = [
    { name: "Standard", s: { copies: 1, sides: "one-sided", orientation: "auto", number_up: "1", collate: true } },
    { name: "Fronte/retro", s: { copies: 1, sides: "two-sided-long-edge", orientation: "auto", number_up: "1", collate: true } },
    { name: "Dispensa", s: { copies: 1, sides: "two-sided-long-edge", orientation: "auto", number_up: "2", collate: true } },
    { name: "Slide", s: { copies: 1, sides: "one-sided", orientation: "auto", number_up: "4", collate: true } },
  ];
  const radio = (n) => (form.querySelector(`input[name="${n}"]:checked`) || {}).value;
  const getSettings = () => ({
    copies: clamp(parseInt(copies.value, 10)),
    sides: radio("sides"),
    orientation: radio("orientation"),
    number_up: radio("number_up"),
    collate: collate.checked,
  });
  const sameSettings = (a, b) => Object.keys(a).every((k) => String(a[k]) === String(b[k]));

  function applySettings(s) {
    copies.value = clamp(Number(s.copies));
    ["sides", "orientation", "number_up"].forEach((n) => {
      const r = form.querySelector(`input[name="${n}"][value="${s[n]}"]`);
      if (r) r.checked = true;
    });
    collate.checked = !!s.collate;
    settingsChanged();
  }

  function summary(s) {
    const sides = { "one-sided": "solo fronte", "two-sided-long-edge": "fronte/retro sul lato lungo", "two-sided-short-edge": "fronte/retro sul lato corto" };
    const orient = { portrait: "in verticale", landscape: "in orizzontale" };
    const parts = [`${s.copies} ${s.copies === 1 ? "copia" : "copie"}${s.copies > 1 ? (s.collate ? " fascicolate" : " non fascicolate") : ""}`];
    parts.push(sides[s.sides]);
    if (Number(s.number_up) > 1) parts.push(`${s.number_up} pagine per foglio`);
    if (orient[s.orientation]) parts.push(orient[s.orientation]);
    const pr = pageRanges.value.trim();
    parts.push(pr ? `solo le pagine ${pr.replace(/\s+/g, "")}` : "tutte le pagine");
    return `Stampo ${parts.join(", ")}.`;
  }

  function renderPresets() {
    const user = store.get("np:presets", []);
    const cur = getSettings();
    presetsEl.replaceChildren();
    [...BUILTIN.map((p) => ({ ...p, own: false })), ...user.map((p) => ({ ...p, own: true }))].forEach((p) => {
      const on = sameSettings(cur, p.s);
      const wrap = el("span", "cw" + (on ? " on" : ""));
      const b = el("button", "st");
      b.type = "button";
      b.setAttribute("aria-pressed", on ? "true" : "false");
      if (on) b.appendChild(ic("check"));
      b.appendChild(document.createTextNode(p.name));
      b.addEventListener("click", () => applySettings(p.s));
      wrap.appendChild(b);
      if (p.own) {
        const x = el("button", "cx st");
        x.type = "button";
        x.setAttribute("aria-label", `Elimina il profilo ${p.name}`);
        x.appendChild(ic("close"));
        x.addEventListener("click", () => {
          store.set("np:presets", store.get("np:presets", []).filter((q) => q.name !== p.name));
          renderPresets();
        });
        wrap.appendChild(x);
      }
      presetsEl.appendChild(wrap);
    });
  }

  function settingsChanged() {
    store.set("np:last", getSettings());
    summaryEl.textContent = summary(getSettings());
    renderPresets();
  }

  form.addEventListener("change", settingsChanged);
  pageRanges.addEventListener("input", () => (summaryEl.textContent = summary(getSettings())));
  copies.addEventListener("input", () => { if (copies.value !== "") settingsChanged(); });
  copies.addEventListener("blur", () => { copies.value = clamp(parseInt(copies.value, 10)); settingsChanged(); });
  document.querySelectorAll("[data-step]").forEach((b) =>
    b.addEventListener("click", () => {
      copies.value = clamp((parseInt(copies.value, 10) || 1) + Number(b.dataset.step));
      settingsChanged();
    })
  );

  // salvataggio profilo
  const saveRow = $("#save-row");
  const saveName = $("#save-name");
  $("#save-toggle").addEventListener("click", () => {
    saveRow.hidden = !saveRow.hidden;
    if (!saveRow.hidden) saveName.focus();
  });
  const saveProfile = () => {
    const name = saveName.value.trim();
    if (!name) { saveName.focus(); return; }
    const list = store.get("np:presets", []).filter((p) => p.name.toLowerCase() !== name.toLowerCase());
    list.push({ name, s: getSettings() });
    store.set("np:presets", list);
    saveName.value = "";
    saveRow.hidden = true;
    renderPresets();
  };
  $("#save-go").addEventListener("click", saveProfile);
  saveName.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveProfile(); } });

  // ---------------------------------------------------------------- esiti
  function showResults(items) {
    results.replaceChildren();
    items.forEach((r) => {
      const box = el("div", `banner ${r.ok ? "ok" : "err"}`);
      box.setAttribute("role", r.ok ? "status" : "alert");
      const txt = el("div");
      txt.appendChild(el("strong", null, r.filename || "Errore"));
      txt.appendChild(el("span", null, r.ok ? r.message : r.error));
      if (r.ok && r.warning) txt.appendChild(el("span", "warn", r.warning));
      box.append(ic(r.ok ? "ok" : "err"), txt);
      results.appendChild(box);
    });
    results.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ------------------------------------------------------------ lista file
  function renderFiles() {
    fileList.replaceChildren();
    files.forEach((f, i) => {
      const li = el("li", "item");
      const lead = el("span", "lead");
      lead.appendChild(ic("doc"));
      const txt = el("div", "txt");
      txt.append(el("div", "hl", f.name), el("div", "sp", fmtSize(f.size)));
      const rm = el("button", "icon-btn st");
      rm.type = "button";
      rm.setAttribute("aria-label", `Rimuovi ${f.name}`);
      rm.appendChild(ic("close"));
      rm.addEventListener("click", () => { files.splice(i, 1); renderFiles(); });
      li.append(lead, txt, rm);
      fileList.appendChild(li);
    });
    submitBtn.disabled = busy || files.length === 0;
    submitBtn.classList.toggle("busy", busy);
    submitLabel.textContent = busy ? "Invio in corso" : files.length > 1 ? `Stampa ${files.length} file` : "Stampa";
  }

  function addFiles(list) {
    const rejected = [];
    Array.from(list).forEach((f) => {
      const ext = extOf(f.name);
      if (!ALLOWED.has(ext)) rejected.push({ ok: false, filename: f.name, error: `Formato \u201c.${ext || "?"}\u201d non supportato.` });
      else if (f.size > MAX_BYTES) rejected.push({ ok: false, filename: f.name, error: `Il file supera il limite di ${fmtSize(MAX_BYTES)}.` });
      else if (f.size === 0) rejected.push({ ok: false, filename: f.name, error: "Il file è vuoto." });
      else if (!files.some((x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified)) files.push(f);
    });
    if (rejected.length) showResults(rejected); else results.replaceChildren();
    renderFiles();
  }

  // drag & drop, selezione, incolla
  ["dragenter", "dragover"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("drag"); }));
  dropzone.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
  ["dragover", "drop"].forEach((ev) => window.addEventListener(ev, (e) => e.preventDefault()));
  dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; });
  document.addEventListener("paste", (e) => {
    const pasted = Array.from((e.clipboardData && e.clipboardData.files) || []);
    if (!pasted.length) return;
    e.preventDefault();
    addFiles(pasted.map((f) => {
      if (f.name && f.name !== "image.png") return f;
      const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
      return new File([f], `incollato-${Date.now()}.${ext}`, { type: f.type });
    }));
  });

  // ---------------------------------------------------------------- invio
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy || files.length === 0) return;
    const pr = pageRanges.value.trim();
    if (pr && !RANGE_RE.test(pr)) {
      showResults([{ ok: false, filename: "Pagine", error: "Intervallo non valido. Esempio corretto: 1-3, 5" }]);
      pageRanges.focus();
      return;
    }
    const s = getSettings();
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f, f.name));
    fd.append("copies", s.copies);
    fd.append("sides", s.sides);
    fd.append("orientation", s.orientation);
    fd.append("number_up", s.number_up);
    fd.append("page_ranges", pr);
    fd.append("collate", s.collate ? "true" : "false");

    busy = true;
    renderFiles();
    try {
      const res = await fetch("/api/print", { method: "POST", body: fd });
      let data = null;
      try { data = await res.json(); } catch (_) { /* risposta non JSON */ }
      if (!data) throw new Error(`risposta non valida dal server (HTTP ${res.status})`);
      if (!data.results) {
        showResults([{ ok: false, filename: "Stampa non avviata", error: data.error || `Errore HTTP ${res.status}` }]);
      } else {
        showResults(data.results);
        files = files.filter((_, i) => !(data.results[i] && data.results[i].ok)); // restano solo i file falliti
      }
    } catch (err) {
      showResults([{ ok: false, filename: "Connessione", error: `Impossibile contattare il server: ${err.message}` }]);
    } finally {
      busy = false;
      renderFiles();
      refreshStatus();
    }
  });

  // ------------------------------------------------------- stato, toner, coda
  function setStatus(p) {
    const map = { idle: "ok", printing: "busy", disabled: "warn", offline: "err", unconfigured: "warn", "cups-down": "err" };
    $("#sq").className = `dot ${map[p.state] || "warn"}`;
    $("#status-text").textContent = p.label + (p.alerts ? ` (${p.alerts})` : "");
    const t = $("#toner");
    if (typeof p.toner === "number") {
      t.hidden = false;
      $("#toner-fill").style.width = `${p.toner}%`;
      $("#toner-fill").className = p.toner <= 10 ? "low" : "";
      $("#toner-val").textContent = `${p.toner}%`;
    } else {
      t.hidden = true;
    }
  }

  function renderJobs(jobs) {
    jobsList.replaceChildren();
    jobs.forEach((j) => {
      const li = el("li", "item");
      const lead = el("span", "lead");
      lead.appendChild(ic("print"));
      const txt = el("div", "txt");
      txt.append(el("div", "hl", j.id), el("div", "sp", `${fmtSize(j.size)}, ${j.when}`));
      const btn = el("button", "text-btn st err", "Annulla");
      btn.type = "button";
      btn.addEventListener("click", () => cancelJob(j.id));
      li.append(lead, txt, btn);
      jobsList.appendChild(li);
    });
    cancelAllBtn.hidden = jobs.length < 2;
  }

  async function refreshStatus() {
    try {
      const data = await (await fetch("/api/status", { cache: "no-store" })).json();
      setStatus(data.printer);
      renderJobs(data.jobs || []);
    } catch (_) {
      $("#sq").className = "dot err";
      $("#status-text").textContent = "Server non raggiungibile";
    }
  }

  async function cancelJob(id) {
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        showResults([{ ok: false, filename: id, error: d.error || "Annullamento non riuscito." }]);
      }
    } finally { refreshStatus(); }
  }
  cancelAllBtn.addEventListener("click", async () => {
    try { await fetch("/api/jobs", { method: "DELETE" }); } finally { refreshStatus(); }
  });
  $("#refresh").addEventListener("click", refreshStatus);
  setInterval(() => { if (document.visibilityState === "visible") refreshStatus(); }, 10000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshStatus(); });

  // ------------------------------------------------------------------ avvio
  const last = store.get("np:last", null);
  if (last) applySettings(last); else settingsChanged();
  renderFiles();
  refreshStatus();
})();
