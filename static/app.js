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
  const RANGE_RE = /^\d+(-\d+)?(,\d+(-\d+)?)*$/;
  const LARGE_JOB = 30;   // oltre questo numero di fogli chiede conferma
  const PV_STEP = 48;     // quante facciate/pagine mostrare prima di "Mostra tutte"

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
  const rangeHelp = $("#range-help");
  const summaryEl = $("#summary");
  const presetsEl = $("#presets");
  const jobsList = $("#jobs");
  const cancelAllBtn = $("#cancel-all");
  const previewCard = $("#preview");
  const pvFiles = $("#pv-files");
  const pvInfo = $("#pv-info");
  const pvTools = $("#pv-tools");
  const pvBody = $("#pv-body");
  const pvNote = $("#pv-note");

  let files = [];          // { id, file, name, size, status, error, token, pages, sizes, range }
  let activeId = null;     // file mostrato nell'anteprima (e a cui si riferisce "Pagine da stampare")
  let nextId = 1;
  let busy = false;
  let mode = store.get("np:pvmode", "sheets") === "pages" ? "pages" : "sheets";
  let lastClicked = null;
  let pvLimit = PV_STEP;
  let pvSig = "";

  const fmtSize = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
  const extOf = (n) => (n.includes(".") ? n.split(".").pop().toLowerCase() : "");
  const clamp = (v) => Math.min(99, Math.max(1, Number.isFinite(v) ? v : 1));
  const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const allPages = (n) => Array.from({ length: n }, (_, i) => i + 1);
  const activeFile = () => files.find((f) => f.id === activeId) || files[0] || null;

  // ------------------------------------------------------------ pagine scelte
  // Ritorna { pages: [..] | null (= tutte), error: null | "format" | "over" }
  function parseRange(str, total) {
    const v = (str || "").replace(/\s+/g, "");
    if (!v) return { pages: null, error: null };
    if (!RANGE_RE.test(v)) return { pages: null, error: "format" };
    const set = new Set();
    let over = false;
    for (const part of v.split(",")) {
      const [a, b] = part.split("-");
      const s = Number(a);
      const e = b === undefined ? s : Number(b);
      if (s < 1 || e < s) return { pages: null, error: "format" };
      if (total && e > total) over = true;
      if (total) for (let p = s; p <= Math.min(e, total); p++) set.add(p);
    }
    if (over) return { pages: null, error: "over" };
    return { pages: total ? [...set].sort((x, y) => x - y) : null, error: null };
  }

  function selectedPages(f) {
    if (!f.pages) return [];
    const r = parseRange(f.range, f.pages);
    return r.pages && !r.error ? r.pages : allPages(f.pages); // vuoto o non valido = tutte
  }

  function toRange(sorted, total) {
    if (sorted.length === total) return "";
    const runs = [];
    sorted.forEach((p) => {
      const last = runs[runs.length - 1];
      if (last && p === last[1] + 1) last[1] = p; else runs.push([p, p]);
    });
    return runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(",");
  }

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

  // Fogli necessari per un file con le impostazioni correnti (stessa formula del server)
  function sheetsOf(f, s) {
    const sel = selectedPages(f).length;
    if (!sel) return 0;
    const faces = Math.ceil(sel / Number(s.number_up));
    return (s.sides === "one-sided" ? faces : Math.ceil(faces / 2)) * s.copies;
  }
  const readyFiles = () => files.filter((f) => f.status === "ready");
  const totalSheets = (s) => readyFiles().reduce((a, f) => a + sheetsOf(f, s), 0);

  function summary(s) {
    const sides = { "one-sided": "solo fronte", "two-sided-long-edge": "fronte/retro sul lato lungo", "two-sided-short-edge": "fronte/retro sul lato corto" };
    const orient = { portrait: "in verticale", landscape: "in orizzontale" };
    const parts = [`${s.copies} ${s.copies === 1 ? "copia" : "copie"}${s.copies > 1 ? (s.collate ? " fascicolate" : " non fascicolate") : ""}`];
    parts.push(sides[s.sides]);
    if (Number(s.number_up) > 1) parts.push(`${s.number_up} pagine per foglio`);
    if (orient[s.orientation]) parts.push(orient[s.orientation]);
    const custom = files.filter((f) => f.range.trim());
    if (!custom.length) parts.push("tutte le pagine");
    else if (files.length === 1) parts.push(`solo le pagine ${custom[0].range.replace(/\s+/g, "")}`);
    else parts.push(`pagine scelte per ${pl(custom.length, "file", "file")}`);
    const total = totalSheets(s);
    return `Stampo ${parts.join(", ")}.${total ? ` In tutto ${pl(total, "foglio", "fogli")}.` : ""}`;
  }
  const updateSummary = () => { summaryEl.textContent = summary(getSettings()); };

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
    updateSummary();
    renderPresets();
    schedulePreview();
    updateSubmit();
  }

  form.addEventListener("change", (e) => {
    if (e.target.name === "pvmode") {
      mode = e.target.value === "pages" ? "pages" : "sheets";
      store.set("np:pvmode", mode);
      pvLimit = PV_STEP;
      renderPreview();
      return;
    }
    settingsChanged();
  });
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

  // ------------------------------------------------- campo "Pagine da stampare"
  let helpTimer = 0;
  function updateRangeHelp() {
    const f = activeFile();
    pageRanges.disabled = !f;
    let text = "Aggiungi un file per scegliere le pagine";
    let bad = false;
    if (f) {
      text = files.length > 1
        ? `Vale solo per \u201c${f.name}\u201d. Vuoto per tutte.`
        : "Vuoto per tutte, oppure 1-3, 5 (o tocca le pagine in anteprima)";
      const r = parseRange(f.range, f.pages);
      if (r.error === "format") { text = "Formato non valido. Esempio: 1-3, 5"; bad = true; }
      else if (r.error === "over") { text = `Il documento ha ${pl(f.pages, "pagina", "pagine")}`; bad = true; }
    }
    rangeHelp.textContent = text;
    rangeHelp.classList.toggle("bad", bad);
    pageRanges.setAttribute("aria-invalid", bad ? "true" : "false");
  }
  function flashHelp(msg) {
    rangeHelp.textContent = msg;
    rangeHelp.classList.add("bad");
    clearTimeout(helpTimer);
    helpTimer = setTimeout(updateRangeHelp, 2500);
  }
  function rangeChanged() {
    updateRangeHelp();
    updateSummary();
    schedulePreview();
    updateSubmit();
  }
  pageRanges.addEventListener("input", () => {
    const f = activeFile();
    if (!f) return;
    f.range = pageRanges.value;
    lastClicked = null;
    rangeChanged();
  });

  function setSelection(f, sorted) {
    if (!sorted.length) { flashHelp("Serve almeno una pagina."); return; }
    f.range = toRange(sorted, f.pages);
    if (f === activeFile()) pageRanges.value = f.range;
    rangeChanged();
  }
  function togglePage(f, p, shift) {
    const cur = new Set(selectedPages(f));
    if (shift && lastClicked) {
      const [a, b] = [Math.min(lastClicked, p), Math.max(lastClicked, p)];
      const add = !cur.has(p);
      for (let i = a; i <= b; i++) { if (add) cur.add(i); else cur.delete(i); }
    } else if (cur.has(p)) cur.delete(p); else cur.add(p);
    lastClicked = p;
    setSelection(f, [...cur].sort((x, y) => x - y));
  }
  pvTools.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sel]");
    const f = activeFile();
    if (!b || !f || !f.pages) return;
    const all = allPages(f.pages);
    const pick = { all, odd: all.filter((p) => p % 2 === 1), even: all.filter((p) => p % 2 === 0) }[b.dataset.sel];
    lastClicked = null;
    setSelection(f, pick);
  });

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

  // ------------------------------------------------- anteprime (lato server)
  const pageUrl = (f, p, size) => `/api/preview/${f.token}/page/${p}.jpg?s=${size}`;
  function pageImg(f, p, size) {
    const img = new Image();
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "";
    img.draggable = false;
    img.addEventListener("error", () => img.classList.add("broken"));
    img.src = pageUrl(f, p, size);
    return img;
  }
  const deletePreview = (token) => { fetch(`/api/preview/${token}`, { method: "DELETE", keepalive: true }).catch(() => {}); };

  // Una conversione alla volta: il server serializza comunque LibreOffice
  let pumping = false;
  async function pumpPreviews() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const f = files.find((x) => x.status === "queued");
        if (!f) break;
        f.status = "loading";
        refresh();
        let data = null;
        let failure = null;
        try {
          const fd = new FormData();
          fd.append("file", f.file, f.name);
          const res = await fetch("/api/preview", { method: "POST", body: fd });
          try { data = await res.json(); } catch (_) { /* risposta non JSON */ }
          if (!res.ok || !data || !data.token) failure = (data && data.error) || `Errore HTTP ${res.status}`;
        } catch (err) {
          failure = `Impossibile contattare il server: ${err.message}`;
        }
        if (!files.includes(f)) { if (!failure) deletePreview(data.token); continue; } // rimosso nel frattempo
        if (failure) { f.status = "error"; f.error = failure; }
        else Object.assign(f, { status: "ready", token: data.token, pages: data.pages, sizes: data.sizes, error: null });
        refresh();
      }
    } finally {
      pumping = false;
    }
  }

  // ------------------------------------------------------------ lista file
  function setActive(id) {
    activeId = id;
    const f = activeFile();
    pageRanges.value = f ? f.range : "";
    lastClicked = null;
    pvLimit = PV_STEP;
    refresh();
  }

  function removeFile(f) {
    files = files.filter((x) => x !== f);
    if (f.token) deletePreview(f.token);
    if (activeId === f.id) activeId = files[0] ? files[0].id : null;
    const a = activeFile();
    pageRanges.value = a ? a.range : "";
    pvLimit = PV_STEP;
    refresh();
  }

  function renderFiles() {
    fileList.replaceChildren();
    files.forEach((f) => {
      const li = el("li", "item" + (files.length > 1 && f === activeFile() ? " active" : ""));
      const main = el("button", "item-main");
      main.type = "button";
      main.addEventListener("click", () => setActive(f.id));
      let lead;
      if (f.status === "ready") {
        lead = el("span", "lead thumb");
        lead.appendChild(pageImg(f, 1, "s"));
      } else {
        lead = el("span", "lead" + (f.status === "error" ? " bad" : ""));
        lead.appendChild(f.status === "error" ? ic("err") : ic("refresh", "spin"));
      }
      const txt = el("div", "txt");
      let sub = fmtSize(f.size);
      if (f.status === "ready") sub += ` \u00b7 ${pl(f.pages, "pagina", "pagine")}`;
      else if (f.status === "loading") sub = "Preparo l\u2019anteprima\u2026";
      else if (f.status === "queued") sub += " \u00b7 in attesa";
      txt.append(el("div", "hl", f.name), el("div", "sp" + (f.status === "error" ? " err" : ""), f.status === "error" ? f.error : sub));
      main.append(lead, txt);
      li.appendChild(main);
      if (f.status === "error") {
        const retry = el("button", "text-btn st", "Riprova");
        retry.type = "button";
        retry.addEventListener("click", () => { f.status = "queued"; f.error = null; refresh(); pumpPreviews(); });
        li.appendChild(retry);
      }
      const rm = el("button", "icon-btn st");
      rm.type = "button";
      rm.setAttribute("aria-label", `Rimuovi ${f.name}`);
      rm.appendChild(ic("close"));
      rm.addEventListener("click", () => removeFile(f));
      li.appendChild(rm);
      fileList.appendChild(li);
    });
  }

  function updateSubmit() {
    const ready = readyFiles();
    const pending = files.some((f) => f.status === "queued" || f.status === "loading");
    submitBtn.disabled = busy || pending || ready.length === 0;
    submitBtn.classList.toggle("busy", busy || pending);
    if (busy) submitLabel.textContent = "Invio in corso";
    else if (pending) submitLabel.textContent = "Preparo l\u2019anteprima";
    else {
      const sheets = totalSheets(getSettings());
      submitLabel.textContent = (ready.length > 1 ? `Stampa ${ready.length} file` : "Stampa") + (sheets ? ` \u00b7 ${pl(sheets, "foglio", "fogli")}` : "");
    }
  }

  function addFiles(list) {
    const rejected = [];
    Array.from(list).forEach((f) => {
      const ext = extOf(f.name);
      if (!ALLOWED.has(ext)) rejected.push({ ok: false, filename: f.name, error: `Formato \u201c.${ext || "?"}\u201d non supportato.` });
      else if (f.size > MAX_BYTES) rejected.push({ ok: false, filename: f.name, error: `Il file supera il limite di ${fmtSize(MAX_BYTES)}.` });
      else if (f.size === 0) rejected.push({ ok: false, filename: f.name, error: "Il file \u00e8 vuoto." });
      else if (!files.some((x) => x.file.name === f.name && x.file.size === f.size && x.file.lastModified === f.lastModified)) {
        files.push({ id: nextId++, file: f, name: f.name, size: f.size, status: "queued", error: null, token: null, pages: 0, sizes: [], range: "" });
      }
    });
    if (rejected.length) showResults(rejected); else results.replaceChildren();
    if (!activeId && files.length) setActive(files[0].id);
    refresh();
    pumpPreviews();
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

  // ------------------------------------------------------- anteprima: disegno
  let pvQueued = false;
  function schedulePreview() {
    if (pvQueued) return;
    pvQueued = true;
    requestAnimationFrame(() => { pvQueued = false; renderPreview(); });
  }

  // Foglio come verra' stampato: orientamento, griglia (1/2/4 pagine) e pagine contenute senza deformarle.
  // La posizione esatta con piu' pagine per foglio e' indicativa (la decide il filtro CUPS).
  function renderSheet(f, face, s, size) {
    const n = Number(s.number_up);
    const dims = (p) => f.sizes[p - 1] || [595, 842];
    const pageLand = (p) => dims(p)[0] > dims(p)[1];
    const land = s.orientation === "landscape" ? true
      : s.orientation === "portrait" ? false
      : (n === 2 ? !pageLand(face[0]) : pageLand(face[0]));
    const cols = n === 1 ? 1 : n === 4 ? 2 : (land ? 2 : 1);
    const rows = n === 1 ? 1 : n === 4 ? 2 : (land ? 1 : 2);
    const sheet = el("div", `sheet ${land ? "land" : "port"}${size === "l" ? " big" : ""}`);
    sheet.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    sheet.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    for (let i = 0; i < cols * rows; i++) {
      const cell = el("div", "cell");
      const p = face[i];
      if (p) {
        const [w, h] = dims(p);
        const pg = el("div", "pg");
        pg.style.setProperty("--ar", (w / h).toFixed(4));
        pg.appendChild(pageImg(f, p, size));
        cell.appendChild(pg);
      }
      sheet.appendChild(cell);
    }
    return sheet;
  }

  const faceLabel = (i, duplex) => (duplex ? `Foglio ${Math.floor(i / 2) + 1} \u00b7 ${i % 2 ? "retro" : "fronte"}` : `Foglio ${i + 1}`);
  const facePages = (face) => (face.length === 1 ? `Pagina ${face[0]}` : `Pagine ${face.join(", ")}`);

  function sheetsView(f, s, sel) {
    const duplex = s.sides !== "one-sided";
    const faces = [];
    for (let i = 0; i < sel.length; i += Number(s.number_up)) faces.push(sel.slice(i, i + Number(s.number_up)));
    const shown = Math.min(faces.length, pvLimit);
    const caption = (i, face) => ({ title: faceLabel(i, duplex), sub: facePages(face) });
    const figs = faces.slice(0, shown).map((face, i) => {
      const b = el("button", "fig");
      b.type = "button";
      b.setAttribute("aria-label", `Ingrandisci: ${faceLabel(i, duplex)}, ${facePages(face).toLowerCase()}`);
      b.append(renderSheet(f, face, s, "s"), el("span", "cap", duplex ? `${Math.floor(i / 2) + 1} \u00b7 ${i % 2 ? "retro" : "fronte"}` : `${i + 1}`));
      b.addEventListener("click", () => openLightbox({ f, s, faces, index: i, caption }));
      return b;
    });
    const wrap = el("div", "sheets");
    if (!duplex) wrap.append(...figs);
    else {
      for (let i = 0; i < figs.length; i += 2) {
        const leaf = el("div", "leaf");
        leaf.appendChild(figs[i]);
        if (figs[i + 1]) leaf.appendChild(figs[i + 1]);
        else if (i + 1 === faces.length) { // ultima facciata dispari: il retro resta bianco
          const front = figs[i].firstChild;
          const blank = el("div", "fig static");
          blank.append(el("div", `sheet blank ${front.classList.contains("land") ? "land" : "port"}`), el("span", "cap", `${Math.floor(i / 2) + 1} \u00b7 retro vuoto`));
          leaf.appendChild(blank);
        }
        wrap.appendChild(leaf);
      }
    }
    return { node: wrap, total: faces.length, shown, faces, duplex };
  }

  function pagesView(f, sel) {
    const on = new Set(sel);
    const shown = Math.min(f.pages, pvLimit);
    const grid = el("div", "pgrid");
    const caption = (i, face) => ({ title: `Pagina ${face[0]} di ${f.pages}`, sub: on.has(face[0]) ? "Inclusa nella stampa" : "Esclusa dalla stampa" });
    const solo = allPages(f.pages).map((p) => [p]);
    for (let p = 1; p <= shown; p++) {
      const [w, h] = f.sizes[p - 1] || [595, 842];
      const tile = el("div", "pt" + (on.has(p) ? "" : " off"));
      tile.style.setProperty("--ar", (w / h).toFixed(4));
      const b = el("button", "pg");
      b.type = "button";
      b.setAttribute("aria-pressed", on.has(p) ? "true" : "false");
      b.setAttribute("aria-label", `Pagina ${p}`);
      const mark = el("span", "mark");
      mark.appendChild(ic("check"));
      b.append(pageImg(f, p, "s"), mark);
      b.addEventListener("click", (e) => togglePage(f, p, e.shiftKey));
      const z = el("button", "zoom");
      z.type = "button";
      z.setAttribute("aria-label", `Ingrandisci la pagina ${p}`);
      z.appendChild(ic("zoom"));
      z.addEventListener("click", () => openLightbox({ f, s: { number_up: "1", orientation: "auto", sides: "one-sided" }, faces: solo, index: p - 1, caption }));
      tile.append(b, z, el("span", "n", String(p)));
      grid.appendChild(tile);
    }
    return { node: grid, total: f.pages, shown };
  }

  function updateInfo(f, s, sel) {
    const duplex = s.sides !== "one-sided";
    let t = pl(f.pages, "pagina", "pagine");
    if (sel.length !== f.pages) t += `, ${sel.length} selezionate`;
    if (mode === "sheets") {
      const faces = Math.ceil(sel.length / Number(s.number_up));
      const leaves = duplex ? Math.ceil(faces / 2) : faces;
      t += ` \u2192 ${pl(leaves, "foglio", "fogli")}`;
      if (duplex) t += ` (${pl(faces, "facciata", "facciate")})`;
      if (s.copies > 1) t += ` \u00d7 ${s.copies} copie`;
    }
    pvInfo.textContent = t;
  }

  function renderPreview() {
    const f = activeFile();
    previewCard.hidden = !f;
    if (!f) { pvSig = ""; return; }
    const s = getSettings();
    const sel = f.status === "ready" ? selectedPages(f) : [];
    if (f.status === "ready") updateInfo(f, s, sel);

    // Se cambiano solo copie o fascicolazione non serve ridisegnare le miniature
    const sig = [
      files.map((x) => `${x.id}:${x.status}`).join(","), f.id, f.token, mode, s.number_up, s.sides, s.orientation,
      sel.length, sel[0], sel[sel.length - 1], f.range.replace(/\s+/g, ""), pvLimit,
    ].join("|");
    if (sig === pvSig) return;
    pvSig = sig;

    pvFiles.hidden = files.length < 2;
    pvFiles.replaceChildren();
    if (files.length > 1) {
      files.forEach((x) => {
        const wrap = el("span", "cw" + (x === f ? " on" : ""));
        const b = el("button", "st");
        b.type = "button";
        b.setAttribute("aria-pressed", x === f ? "true" : "false");
        if (x.status === "loading" || x.status === "queued") b.appendChild(ic("refresh", "spin"));
        else if (x.status === "error") b.appendChild(ic("err"));
        else if (x === f) b.appendChild(ic("check"));
        b.appendChild(el("span", "t", x.name));
        b.addEventListener("click", () => setActive(x.id));
        wrap.appendChild(b);
        pvFiles.appendChild(wrap);
      });
    }

    pvBody.replaceChildren();
    pvNote.hidden = true;
    pvTools.hidden = true;
    if (f.status === "queued" || f.status === "loading") {
      pvInfo.textContent = "";
      const w = el("div", "pv-wait");
      w.append(ic("refresh", "spin"), el("span", null, f.status === "queued" ? "In attesa di essere preparato\u2026" : "Converto il documento in PDF\u2026"));
      pvBody.appendChild(w);
      return;
    }
    if (f.status === "error") {
      pvInfo.textContent = "";
      const box = el("div", "banner err");
      box.append(ic("err"), el("span", null, f.error));
      pvBody.appendChild(box);
      return;
    }

    pvTools.hidden = mode !== "pages";
    const v = mode === "pages" ? pagesView(f, sel) : sheetsView(f, s, sel);
    pvBody.appendChild(v.node);
    if (v.total > v.shown) {
      const more = el("button", "btn tonal st pv-more", `Mostra tutte (${v.total})`);
      more.type = "button";
      more.addEventListener("click", () => { pvLimit = Infinity; renderPreview(); });
      pvBody.appendChild(more);
    }
    if (mode === "sheets") {
      const notes = ["Il contenuto \u00e8 quello esatto che verr\u00e0 inviato alla stampante."];
      if (Number(s.number_up) > 1 || s.orientation !== "auto") notes.push("La posizione delle pagine sul foglio \u00e8 indicativa.");
      pvNote.textContent = notes.join(" ");
      pvNote.hidden = false;
    }
  }

  // ------------------------------------------------------------ ingrandimento
  const lb = $("#lb");
  const lbBody = $("#lb-body");
  const lbTitle = $("#lb-title");
  const lbSub = $("#lb-sub");
  const lbCount = $("#lb-count");
  const lbPrev = $("#lb-prev");
  const lbNext = $("#lb-next");
  let lbState = null;

  function showLb() {
    const { f, s, faces, index, caption } = lbState;
    const c = caption(index, faces[index]);
    lbTitle.textContent = c.title;
    lbSub.textContent = c.sub || "";
    lbBody.replaceChildren(renderSheet(f, faces[index], s, "l"));
    lbCount.textContent = `${index + 1} / ${faces.length}`;
    lbPrev.disabled = index === 0;
    lbNext.disabled = index === faces.length - 1;
    // precarica le facciate vicine: la navigazione resta fluida
    [index - 1, index + 1].forEach((i) => (faces[i] || []).forEach((p) => { new Image().src = pageUrl(f, p, "l"); }));
  }
  function openLightbox(st) {
    lbState = st;
    showLb();
    if (!lb.open) lb.showModal();
  }
  function lbStep(d) {
    const i = lbState.index + d;
    if (i < 0 || i >= lbState.faces.length) return;
    lbState.index = i;
    showLb();
  }
  lbPrev.addEventListener("click", () => lbStep(-1));
  lbNext.addEventListener("click", () => lbStep(1));
  $("#lb-close").addEventListener("click", () => lb.close());
  lb.addEventListener("click", (e) => { if (e.target === lb) lb.close(); }); // clic fuori dal riquadro
  lb.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); lbStep(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); lbStep(1); }
  });
  lb.addEventListener("close", () => { lbBody.replaceChildren(); lbState = null; });

  // ------------------------------------------------------ ridisegno generale
  function refresh() {
    renderFiles();
    updateRangeHelp();
    updateSummary();
    renderPreview();
    updateSubmit();
  }

  // ---------------------------------------------------------------- invio
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pending = files.some((f) => f.status === "queued" || f.status === "loading");
    const ready = readyFiles();
    if (busy || pending || !ready.length) return;

    for (const f of ready) {
      const r = parseRange(f.range, f.pages);
      if (r.error) {
        if (f !== activeFile()) setActive(f.id);
        showResults([{ ok: false, filename: f.name, error: r.error === "over" ? `Il documento ha ${pl(f.pages, "pagina", "pagine")}.` : "Intervallo non valido. Esempio corretto: 1-3, 5" }]);
        pageRanges.focus();
        return;
      }
    }
    const s = getSettings();
    const total = totalSheets(s);
    if (total >= LARGE_JOB && !window.confirm(`Stai per stampare ${total} fogli. Vuoi continuare?`)) return;

    const fd = new FormData();
    fd.append("jobs", JSON.stringify(ready.map((f) => ({ key: f.id, name: f.name, token: f.token, range: f.range.trim() }))));
    fd.append("copies", s.copies);
    fd.append("sides", s.sides);
    fd.append("orientation", s.orientation);
    fd.append("number_up", s.number_up);
    fd.append("collate", s.collate ? "true" : "false");

    busy = true;
    updateSubmit();
    try {
      const res = await fetch("/api/print", { method: "POST", body: fd });
      let data = null;
      try { data = await res.json(); } catch (_) { /* risposta non JSON */ }
      if (!data) throw new Error(`risposta non valida dal server (HTTP ${res.status})`);
      if (!data.results) {
        showResults([{ ok: false, filename: "Stampa non avviata", error: data.error || `Errore HTTP ${res.status}` }]);
      } else {
        const done = new Set(data.results.filter((r) => r.ok).map((r) => r.key));
        data.results.forEach((r) => {
          if (!r.expired) return;
          const f = files.find((x) => x.id === r.key);
          if (f) { f.status = "queued"; f.token = null; f.pages = 0; f.sizes = []; }
          r.error = "L\u2019anteprima era scaduta: la preparo di nuovo, poi premi Stampa.";
        });
        showResults(data.results);
        files = files.filter((f) => !done.has(f.id)); // restano solo i file falliti
        if (!files.includes(activeFile())) setActive(files[0] ? files[0].id : null);
        pumpPreviews();
      }
    } catch (err) {
      showResults([{ ok: false, filename: "Connessione", error: `Impossibile contattare il server: ${err.message}` }]);
    } finally {
      busy = false;
      refresh();
      refreshStatus();
    }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !lb.open && !submitBtn.disabled) form.requestSubmit();
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
      txt.append(el("div", "hl", j.title || j.id), el("div", "sp", `${j.title ? j.id + ", " : ""}${fmtSize(j.size)}, ${j.when}`));
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
  const modeRadio = form.querySelector(`input[name="pvmode"][value="${mode}"]`);
  if (modeRadio) modeRadio.checked = true;
  const last = store.get("np:last", null);
  if (last) applySettings(last); else settingsChanged();
  refresh();
  refreshStatus();
})();
