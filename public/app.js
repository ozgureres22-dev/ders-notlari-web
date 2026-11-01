"use strict";
const app = document.getElementById("app");
const STAGES = [["converting", "Dönüştürme"], ["transcribing", "Yazıya dökme"], ["writing", "Not yazma"], ["verifying", "Doğrulama"], ["done", "Bitti"]];
const STATUS = { queued: "Sırada", converting: "Dönüştürülüyor", transcribing: "Yazıya dökülüyor", writing: "Not yazılıyor", verifying: "Doğrulanıyor", done: "Bitti", failed: "Hata" };
const AUDIO_EXT = ["m4a", "mp3", "wav", "aac", "flac", "ogg", "opus", "aiff", "wma", "mp4", "mov", "webm"];
const SLIDE_EXT = ["pdf", "pptx"];
let pollTimer = null;
let draft = { audio: null, slides: null, title: "", course: "" };
let filters = { q: "", course: "" };

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key in node && key !== "list") node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  // Sayfa giriş ekranına gidiyor: bekleyen iş hata göstermesin.
  if (response.status === 401) { location.replace("/giris.html"); return new Promise(() => {}); }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || "Sunucu hatası");
  }
  return response;
}
const apiJson = async (path, options) => (await api(path, options)).json();
const sendJson = (path, method, body) => apiJson(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function toast(message) {
  const box = document.getElementById("toast");
  box.textContent = message;
  box.hidden = false;
  clearTimeout(box.timer);
  box.timer = setTimeout(() => { box.hidden = true; }, 4000);
}

function formatEta(seconds) {
  if (seconds == null) return "süre hesaplanıyor";
  if (seconds < 60) return "1 dakikadan az kaldı";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `yaklaşık ${minutes} dk kaldı`;
  return `yaklaşık ${Math.floor(minutes / 60)} sa ${minutes % 60} dk kaldı`;
}

function formatDate(ts) {
  return new Date(ts * 1000).toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" });
}

/* ---------- İlerleme ---------- */
function progressView(lesson) {
  const box = el("div", { class: "progress", "data-testid": "progress" });
  if (lesson.status === "queued") {
    box.append(el("div", { class: "muted", "data-testid": "stage-text" }, (lesson.queue_position > 1 ? `Sırada, ${lesson.queue_position}. iş. Önündeki iş bitince başlayacak.` : "Sırada. Birazdan başlayacak.")));
    return box;
  }
  const failedAt = lesson.status === "failed";
  const currentIndex = STAGES.findIndex(([key]) => key === lesson.status);
  box.append(el("div", { class: "stages" }, STAGES.map(([key, label], index) => {
    let cls = "stage";
    if (!failedAt && index < currentIndex) cls += " past";
    if (index === currentIndex) cls += key === "done" ? " past" : " current";
    return el("div", { class: cls, "data-stage": key }, label);
  })));
  if (lesson.status === "transcribing") {
    const percent = lesson.percent ?? 0;
    box.append(el("div", { class: "bar" }, el("div", { style: `width:${percent}%` })));
    box.append(el("div", { class: "muted", "data-testid": "stage-text" }, percent < 5 ? `%${percent.toLocaleString("tr-TR")} · süre hesaplanıyor` : `%${percent.toLocaleString("tr-TR")} · ${formatEta(lesson.eta_seconds)}`));
  } else if (lesson.status === "converting" || lesson.status === "writing" || lesson.status === "verifying") {
    box.append(el("div", { class: "bar indeterminate" }, el("div")));
    const text = { writing: "Claude notu yazıyor. Uzun derslerde birkaç dakika sürebilir.", verifying: "Not, ayrı bir Claude oturumunda kaynaklarla karşılaştırılıyor." }[lesson.status] || "Ses hazırlanıyor.";
    box.append(el("div", { class: "muted", "data-testid": "stage-text" }, text));
  }
  return box;
}

function errorView(lesson, onRetry) {
  if (lesson.status !== "failed") return null;
  return el("div", { class: "error", "data-testid": "error" },
    el("div", {}, lesson.error || "Bilinmeyen hata"),
    lesson.error_detail ? el("details", {}, el("summary", {}, "Ayrıntı"), el("pre", {}, lesson.error_detail)) : null,
    el("div", { style: "margin-top:8px" }, el("button", { "data-testid": "retry", onclick: onRetry }, "Tekrar dene")));
}

async function retryLesson(id) {
  try {
    await apiJson(`/api/lessons/${id}/retry`, { method: "POST" });
    toast("İş yeniden kuyruğa alındı.");
  } catch (error) { toast(error.message); }
}

/* ---------- Ana sayfa ---------- */
function classify(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (AUDIO_EXT.includes(ext)) return "audio";
  if (SLIDE_EXT.includes(ext)) return "slides";
  return null;
}

function acceptFiles(fileList) {
  for (const file of fileList) {
    const kind = classify(file);
    if (!kind) { toast(`Desteklenmeyen dosya: ${file.name}`); continue; }
    draft[kind] = file;
    if (kind === "audio" && !draft.title) draft.title = file.name.replace(/\.[^.]+$/, "");
  }
  renderUploadForm();
}

function renderUploadForm() {
  const host = document.getElementById("upload-host");
  if (!host) return;
  const input = el("input", { type: "file", multiple: true, hidden: true, "data-testid": "file-input", onchange: (e) => acceptFiles(e.target.files) });
  const zone = el("div", { class: "dropzone", "data-testid": "dropzone", onclick: () => input.click() },
    el("div", { class: "drop-icon", "aria-hidden": "true" }, "↑"),
    el("strong", {}, "Ses ve slaydı buraya sürükle"),
    el("span", { class: "muted" }, "m4a, mp3, wav · slayt için PDF, PPTX"),
    el("span", { class: "drop-link" }, "veya dosya seç"));
  zone.addEventListener("dragenter", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); acceptFiles(e.dataTransfer.files); });

  const row = (kind, label) => draft[kind] && el("div", { class: "file", "data-testid": `file-${kind}` },
    el("span", {}, `${label}: ${draft[kind].name}`),
    el("button", { title: "Kaldır", onclick: () => { draft[kind] = null; renderUploadForm(); } }, "×"));

  const status = el("div", { class: "muted", "data-testid": "upload-status" });
  const submit = el("button", { class: "primary", "data-testid": "submit", disabled: !draft.audio, onclick: () => upload(submit, status) }, "Kuyruğa ekle");
  host.replaceChildren(zone, input,
    el("div", { class: "files" }, row("audio", "Ses"), row("slides", "Slayt")),
    el("div", { class: "upload-fields" },
      el("label", { class: "field" }, "Ders adı", el("input", { type: "text", value: draft.title, "data-testid": "title", placeholder: "Örn. Hafta 3: Bisection", oninput: (e) => { draft.title = e.target.value; } })),
      el("label", { class: "field" }, "Hangi derse ait", el("input", { type: "text", value: draft.course, "data-testid": "course", list: "course-list", placeholder: "Listeden seç veya yeni yaz", oninput: (e) => { draft.course = e.target.value; } }))),
    el("datalist", { id: "course-list" }),
    submit, status);
  refreshCourseOptions();
}

let knownCourses = [];
function refreshCourseOptions() {
  const list = document.getElementById("course-list");
  if (list) list.replaceChildren(...knownCourses.map((course) => el("option", { value: course })));
}

let directUpload = false; // Sitede dosyalar sunucudan gecmeden depolamaya gider.

function afterUpload() {
  draft = { audio: null, slides: null, title: "", course: "" };
  // Yeni ders süzgece takılıp gizli kalmasın.
  filters = { q: "", course: "" };
  const search = document.querySelector("[data-testid=search]");
  if (search) search.value = "";
  renderUploadForm();
  refreshList();
}

function putFile(url, file, status, label) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) status.textContent = `${label} yükleniyor %${Math.round(e.loaded / e.total * 100)}`; };
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error("Yükleme başarısız.")));
    xhr.onerror = () => reject(new Error("Depolamaya ulaşılamadı."));
    xhr.send(file);
  });
}

async function uploadDirect(button, status) {
  button.disabled = true;
  try {
    const created = await sendJson("/api/lessons", "POST", { title: draft.title, course: draft.course, audio_name: draft.audio.name, slides_name: draft.slides ? draft.slides.name : null });
    await putFile(created.audio_url, draft.audio, status, "Ses");
    if (draft.slides) await putFile(created.slides_url, draft.slides, status, "Slayt");
    await apiJson(`/api/lessons/${created.id}/ready`, { method: "POST" });
    afterUpload();
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
}

function upload(button, status) {
  if (directUpload) return uploadDirect(button, status);
  const form = new FormData();
  form.append("audio", draft.audio);
  if (draft.slides) form.append("slides", draft.slides);
  form.append("title", draft.title);
  form.append("course", draft.course);
  button.disabled = true;
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/lessons");
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) status.textContent = `Yükleniyor %${Math.round(e.loaded / e.total * 100)}`; };
  xhr.onload = () => {
    if (xhr.status === 200) {
      afterUpload();
    } else {
      let message = "Yükleme başarısız.";
      try { message = JSON.parse(xhr.responseText).detail || message; } catch (_) { /* düz metin */ }
      status.textContent = message;
      button.disabled = false;
    }
  };
  xhr.onerror = () => { status.textContent = "Sunucuya ulaşılamadı."; button.disabled = false; };
  xhr.send(form);
}

function lessonRow(lesson) {
  const active = !["done", "failed", "queued"].includes(lesson.status);
  const showProgress = active || lesson.status === "queued";
  const status = el("span", { class: `badge ${lesson.status === "done" ? "done" : lesson.status === "failed" ? "failed" : "active"}`, "data-testid": "status" }, STATUS[lesson.status]);
  const row = el("div", { class: "lesson-row", "data-testid": "lesson-row", "data-id": lesson.id },
    el("div", { class: "lesson" },
      el("a", { class: "lesson-main", href: `#/ders/${lesson.id}` },
        el("span", { class: "lesson-title" }, lesson.title),
        el("span", { class: "lesson-meta" }, el("span", { class: "badge course" }, lesson.course), el("span", { class: "muted" }, formatDate(lesson.created)))),
      el("div", { class: "lesson-actions" },
        lesson.status === "done" ? [
          el("a", { class: "btn", href: `#/ders/${lesson.id}` }, "Not"),
          el("a", { class: "btn", href: `#/ders/${lesson.id}/pdf`, "data-testid": "open-pdf" }, "PDF"),
        ] : status)));
  if (showProgress) row.append(progressView(lesson));
  const error = errorView(lesson, () => retryLesson(lesson.id));
  if (error) row.append(error);
  return row;
}

async function refreshList() {
  const host = document.getElementById("lesson-list");
  if (!host) return;
  const params = new URLSearchParams(filters);
  const data = await apiJson(`/api/lessons?${params}`);
  if (!document.getElementById("lesson-list")) return;
  knownCourses = data.courses;
  refreshCourseOptions();
  const select = document.getElementById("course-filter");
  if (select) {
    const current = filters.course;
    select.replaceChildren(el("option", { value: "" }, "Tüm dersler"), ...data.courses.map((course) => el("option", { value: course }, course)));
    select.value = current;
  }
  const offline = document.getElementById("worker-note");
  if (offline) offline.hidden = !(data.worker_online === false && data.lessons.some((lesson) => lesson.status === "queued"));
  const open = host.querySelector("details[open]") !== null;
  host.replaceChildren(...(data.lessons.length ? data.lessons.map(lessonRow) : [el("div", { class: "empty" }, filters.q || filters.course ? "Aramayla eşleşen ders yok." : "Henüz ders yok. İlk kaydını soldan yükle.")]));
  if (open) host.querySelector(".error details")?.setAttribute("open", "");
}

function renderHome() {
  document.title = "Ders Notları";
  let searchTimer;
  app.replaceChildren(el("div", { class: "home" },
    el("section", { class: "card upload-card" }, el("h2", { class: "section" }, "Yeni ders"), el("div", { id: "upload-host" })),
    el("section", { class: "card lessons-card" },
      el("h2", { class: "section" }, "Dersler"),
      el("div", { class: "filters" },
        el("input", { type: "search", placeholder: "Başlıkta, notta ve transkriptte ara", value: filters.q, "data-testid": "search", oninput: (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { filters.q = e.target.value; refreshList(); }, 250); } }),
        el("select", { id: "course-filter", "data-testid": "course-filter", onchange: (e) => { filters.course = e.target.value; refreshList(); } })),
      el("div", { id: "worker-note", class: "warn", "data-testid": "worker-note", hidden: true }, "İşleyen Mac şu an kapalı. Sıradaki dersler Mac açılınca işlenir."),
      el("div", { id: "lesson-list", "data-testid": "lesson-list" }))));
  renderUploadForm();
  refreshList();
  pollTimer = setInterval(() => refreshList().catch(() => {}), 2000);
}

/* ---------- Markdown + LaTeX ---------- */
function renderMath(tex, displayMode) {
  try { return katex.renderToString(tex, { displayMode, throwOnError: false, output: "html" }); }
  catch (_) { return `<code>${tex.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</code>`; }
}

marked.use({
  extensions: [
    {
      name: "mathBlock", level: "block",
      start: (src) => src.match(/\$\$|\\\[/)?.index,
      tokenizer(src) {
        const match = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/.exec(src);
        if (match) return { type: "mathBlock", raw: match[0], tex: match[1] ?? match[2] };
      },
      renderer: (token) => renderMath(token.tex, true),
    },
    {
      name: "mathInline", level: "inline",
      start: (src) => src.match(/\$|\\\(/)?.index,
      tokenizer(src) {
        const match = /^\$\$([^$]+?)\$\$/.exec(src) || /^\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)/.exec(src) || /^\\\(([\s\S]+?)\\\)/.exec(src);
        if (match) return { type: "mathInline", raw: match[0], tex: match[1], display: src.startsWith("$$") };
      },
      renderer: (token) => renderMath(token.tex, token.display),
    },
  ],
});

const STAMP = /\[UNCLEAR @ (\d+:\d\d)\]|\[(\d+:\d\d)\]/g;

function toSeconds(stamp) {
  const [minutes, seconds] = stamp.split(":").map(Number);
  return minutes * 60 + seconds;
}

function stampButton(stamp, label, unclear) {
  return el("button", { class: `ts${unclear ? " unclear" : ""}`, type: "button", "data-seek": toSeconds(stamp), title: "Sesi buradan çal" }, label);
}

function linkStamps(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement.closest(".katex, code, pre, button") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    STAMP.lastIndex = 0;
    if (!STAMP.test(text)) continue;
    STAMP.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(STAMP)) {
      fragment.append(text.slice(last, match.index));
      fragment.append(stampButton(match[1] || match[2], match[1] ? `? ${match[1]}` : match[2], Boolean(match[1])));
      last = match.index + match[0].length;
    }
    fragment.append(text.slice(last));
    node.replaceWith(fragment);
  }
}

function renderNote(markdown) {
  const box = el("article", { class: "note", "data-testid": "note" });
  box.innerHTML = DOMPurify.sanitize(marked.parse(markdown));
  linkStamps(box);
  return box;
}

/* ---------- Ders sayfası ---------- */
function seek(seconds) {
  const audio = document.getElementById("player");
  if (!audio) return;
  audio.currentTime = seconds;
  audio.play().catch(() => {});
}

function checklistView(lesson) {
  const box = el("aside", { class: "card side", "data-testid": "checklist" }, el("h2", { class: "section" }, `Belirsiz yerler (${lesson.unclear.length})`));
  if (!lesson.unclear.length) box.append(el("div", { class: "muted" }, "Belirsiz yer yok."));
  for (const item of lesson.unclear) {
    const row = el("label", { class: `check${item.checked ? " done" : ""}`, "data-testid": "check-item" });
    const verified = item.text.startsWith("Not confirmed by the sources");
    const text = verified ? item.text.replace(/^Not confirmed by the sources \([^)]*\)[^:]*:\s*/, "") : item.text;
    row.append(
      el("input", { type: "checkbox", checked: item.checked, onchange: async (e) => {
        item.checked = e.target.checked;
        row.classList.toggle("done", item.checked);
        try { await sendJson(`/api/lessons/${lesson.id}/checks`, "PUT", { stamp: item.stamp, checked: item.checked }); }
        catch (error) { toast(error.message); }
      } }),
      el("span", { class: "check-body" }, stampButton(item.stamp, item.stamp, true),
        verified ? el("span", { class: "check-tag" }, "Doğrulanamadı") : null,
        el("span", { class: "check-text", title: "Tamamını görmek için tıkla", onclick: (e) => { e.preventDefault(); e.currentTarget.classList.toggle("open"); } }, text)));
    box.append(row);
  }
  return box;
}

function transcriptView(lesson) {
  const box = el("div", { class: "card", "data-testid": "transcript" });
  const lines = lesson.transcript.split("\n").filter((line) => line.trim());
  if (!lines.length) box.append(el("div", { class: "muted" }, "Transkript henüz hazır değil."));
  for (const line of lines) {
    const match = /^\[(\d+:\d\d)\]( ⚠)? (.*)$/.exec(line);
    if (!match) { box.append(el("div", { class: "muted" }, line.replace(/^# /, ""))); continue; }
    box.append(el("div", { class: `transcript-line${match[2] ? " low" : ""}`, "data-testid": match[2] ? "low-line" : "line" },
      stampButton(match[1], match[1], false), match[2] ? el("span", { class: "flag" }, "⚠") : null, el("span", {}, match[3])));
  }
  return box;
}

async function download(lesson, format, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Hazırlanıyor";
  try {
    const response = await api(`/api/lessons/${lesson.id}/export/${format}`);
    const url = URL.createObjectURL(await response.blob());
    const link = el("a", { href: url, download: `${lesson.title}.${format}` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (error) { toast(error.message); }
  button.disabled = false;
  button.textContent = original;
}

let currentTab = "note";

function pdfView(lesson) {
  const url = `/api/lessons/${lesson.id}/export/pdf?inline=true&v=${Date.now()}`;
  const box = el("div", { class: "pdf-box", "data-testid": "pdf-view" }, el("div", { class: "muted pdf-wait" }, "PDF hazırlanıyor. İlk açılışta birkaç saniye sürer."));
  // Once sunucu derlesin: hata olursa tarayicinin bos PDF cercevesi yerine anlasilir mesaj gorunur.
  api(url).then(() => {
    box.replaceChildren(
      el("iframe", { class: "pdf-frame", src: url, title: `${lesson.title} PDF`, "data-testid": "pdf-frame" }),
      el("a", { class: "pdf-open", href: url, target: "_blank", rel: "noopener" }, "Görünmüyorsa yeni sekmede aç"));
  }).catch((error) => { box.replaceChildren(el("div", { class: "error" }, error.message)); });
  return box;
}

function renderReady(lesson, host) {
  const panel = el("div");
  const tabs = el("div", { class: "tabs" });
  const dirty = { value: null };
  const show = (tab) => {
    currentTab = tab;
    for (const button of tabs.children) button.classList.toggle("on", button.dataset.tab === tab);
    if (tab === "note") panel.replaceChildren(el("div", { class: "layout" }, el("div", { class: "card" }, renderNote(lesson.note)), checklistView(lesson)));
    if (tab === "transcript") panel.replaceChildren(transcriptView(lesson));
    if (tab === "pdf") panel.replaceChildren(pdfView(lesson));
    if (tab === "edit") {
      const area = el("textarea", { class: "editor", "data-testid": "editor", value: dirty.value ?? lesson.note, oninput: (e) => { dirty.value = e.target.value; } });
      const save = el("button", { class: "primary", "data-testid": "save", onclick: async () => {
        save.disabled = true;
        try {
          const updated = await sendJson(`/api/lessons/${lesson.id}/note`, "PUT", { note: area.value });
          Object.assign(lesson, updated);
          dirty.value = null;
          toast("Not kaydedildi.");
          show("note");
        } catch (error) { toast(error.message); save.disabled = false; }
      } }, "Kaydet");
      panel.replaceChildren(el("div", { class: "card" }, area, el("div", { class: "row", style: "margin-top:10px" }, save, el("span", { class: "muted" }, "Markdown ve $LaTeX$ kullanabilirsin."))));
    }
  };
  for (const [key, label] of [["note", "Not"], ["pdf", "PDF"], ["edit", "Düzenle"], ["transcript", "Ham transkript"]]) {
    tabs.append(el("button", { "data-tab": key, "data-testid": `tab-${key}`, onclick: () => show(key) }, label));
  }
  host.replaceChildren(
    el("div", { class: "player" }, el("audio", { id: "player", controls: true, preload: "metadata", src: `/api/lessons/${lesson.id}/audio` })),
    tabs, panel);
  show(currentTab);
}

async function renderLesson(id, tab) {
  currentTab = tab || "note";
  const head = el("div", { class: "detail-head" });
  const notices = el("div");
  const body = el("div");
  app.replaceChildren(head, notices, body);
  let shownStatus = null;
  const refresh = async () => {
    const lesson = await apiJson(`/api/lessons/${id}`);
    document.title = `${lesson.title} · Ders Notları`;
    const actions = el("div", { class: "row" });
    if (lesson.status === "done") {
      for (const format of ["docx", "pdf"]) {
        const button = el("button", { "data-testid": `export-${format}`, onclick: () => download(lesson, format, button) }, `${format.toUpperCase()} indir`);
        actions.append(button);
      }
      actions.append(el("button", { "data-testid": "regenerate", onclick: async () => {
        if (!confirm("Not yeniden yazılsın mı? Elle yaptığın düzenlemeler yeni nota geçmez, eski not yedeklenir. Ses yalnızca eski yöntemle yazıya döküldüyse yeniden işlenir.")) return;
        try {
          await apiJson(`/api/lessons/${id}/regenerate`, { method: "POST" });
          shownStatus = null;
          await refresh();
        } catch (error) { toast(error.message); }
      } }, "Notu yeniden yaz"));
    }
    if (shownStatus !== "done" || lesson.status !== "done") {
      head.replaceChildren(el("div", {}, el("h1", { "data-testid": "lesson-title" }, lesson.title), el("div", { class: "muted" }, `${lesson.course} · ${formatDate(lesson.created)}`)), el("span", { class: "spacer" }), actions);
    }
    notices.replaceChildren(...lesson.warnings.map((text) => el("div", { class: "warn", "data-testid": "warning" }, text)));
    if (lesson.status === "done") {
      if (shownStatus !== "done") renderReady(lesson, body);
    } else {
      const open = body.querySelector("details[open]") !== null;
      body.replaceChildren(el("div", { class: "card" }, progressView(lesson), errorView(lesson, () => retryLesson(id).then(refresh))));
      if (open) body.querySelector("details")?.setAttribute("open", "");
    }
    shownStatus = lesson.status;
  };
  app.addEventListener("click", seekHandler);
  await refresh().catch((error) => { body.replaceChildren(el("div", { class: "error" }, error.message)); });
  pollTimer = setInterval(() => { if (shownStatus !== "done") refresh().catch(() => {}); }, 2000);
}

function seekHandler(event) {
  const target = event.target.closest("[data-seek]");
  if (!target) return;
  event.preventDefault();
  seek(Number(target.dataset.seek));
}

function route() {
  clearInterval(pollTimer);
  app.removeEventListener("click", seekHandler);
  const match = /^#\/ders\/(\d+)(?:\/(pdf))?/.exec(location.hash);
  if (match) renderLesson(Number(match[1]), match[2]);
  else renderHome();
}

window.addEventListener("hashchange", route);
route();

fetch("/api/auth/status").then((r) => r.json()).then(({ enabled, direct_upload }) => {
  directUpload = Boolean(direct_upload);
  const button = document.getElementById("logout");
  button.hidden = !enabled;
  button.onclick = () => fetch("/api/auth/logout", { method: "POST" }).then(() => location.replace("/giris.html"));
}).catch(() => {});
