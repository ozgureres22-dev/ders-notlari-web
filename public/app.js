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
    el("div", { class: "drop-text" }, el("strong", {}, "Yeni dersi buraya bırak"),
      el("span", { class: "muted" }, "Ses: m4a, mp3, wav · Slayt: PDF, PPTX (isteğe bağlı)")),
    el("span", { class: "drop-link" }, "Dosya seç"));
  zone.addEventListener("dragenter", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); acceptFiles(e.dataTransfer.files); });

  const row = (kind, label) => draft[kind] && el("div", { class: "file", "data-testid": `file-${kind}` },
    el("span", {}, `${label}: ${draft[kind].name}`),
    el("button", { title: "Kaldır", onclick: () => { draft[kind] = null; renderUploadForm(); } }, "×"));

  const status = el("div", { class: "muted", "data-testid": "upload-status" });
  const submit = el("button", { class: "primary", "data-testid": "submit", disabled: !draft.audio, onclick: () => upload(submit, status) }, "Kuyruğa ekle");
  const chosen = Boolean(draft.audio || draft.slides);
  host.classList.toggle("chosen", chosen);
  host.replaceChildren(zone, input,
    el("div", { class: "files" }, row("audio", "Ses"), row("slides", "Slayt")),
    el("div", { class: "upload-fields", hidden: !chosen },
      el("label", { class: "field" }, "Ders adı", el("input", { type: "text", value: draft.title, "data-testid": "title", placeholder: "Örn. Hafta 3: Bisection", oninput: (e) => { draft.title = e.target.value; } })),
      el("label", { class: "field" }, "Hangi derse ait", el("input", { type: "text", value: draft.course, "data-testid": "course", list: "course-list", placeholder: "Listeden seç veya yeni yaz", oninput: (e) => { draft.course = e.target.value; } }))),
    el("datalist", { id: "course-list" }),
    el("div", { class: "upload-send", hidden: !chosen }, submit), status);
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

function clock(total) {
  const value = Math.max(0, Math.floor(total || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = String(value % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/* Zaman şeridi: dersin bölümleri süreleriyle orantılı, belirsiz yerler işaretli. */
function ribbonView(timeline, options = {}) {
  const box = el("div", { class: `ribbon${options.large ? " large" : ""}`, "data-testid": options.testid || "ribbon" });
  const duration = timeline?.dur || 0;
  if (!duration) return box;
  const tops = timeline.sec.filter((section) => section.level === 2);
  const parts = (options.all || !tops.length) ? timeline.sec : tops;
  const starts = [...new Set(parts.map((section) => section.t))].sort((a, b) => a - b);
  if (starts[0] !== 0) starts.unshift(0);
  starts.forEach((start, index) => {
    const end = starts[index + 1] ?? duration;
    const title = parts.find((section) => section.t === start)?.title || "Giriş";
    box.append(el("span", { class: `ribbon-seg${index % 2 ? " alt" : ""}`, style: `left:${start / duration * 100}%;width:${Math.max(end - start, 0) / duration * 100}%`, title: `${clock(start)} · ${title}` }));
  });
  for (const stamp of timeline.unc || []) box.append(el("span", { class: "ribbon-tick", style: `left:${Math.min(stamp / duration, 1) * 100}%` }));
  return box;
}

function lessonRow(lesson) {
  const active = !["done", "failed", "queued"].includes(lesson.status);
  const showProgress = active || lesson.status === "queued";
  const status = el("span", { class: `badge ${lesson.status === "done" ? "done" : lesson.status === "failed" ? "failed" : "active"}`, "data-testid": "status" }, STATUS[lesson.status]);
  const timeline = lesson.status === "done" ? lesson.timeline : null;
  const unclear = timeline?.unc?.length || 0;
  const row = el("div", { class: "lesson-row", "data-testid": "lesson-row", "data-id": lesson.id },
    el("div", { class: "lesson" },
      el("a", { class: "lesson-main", href: `#/ders/${lesson.id}` },
        el("span", { class: "lesson-title" }, lesson.title),
        el("span", { class: "lesson-meta" }, el("span", { class: "course-tag" }, lesson.course), el("span", {}, formatDate(lesson.created)),
          timeline?.dur ? el("span", {}, clock(timeline.dur)) : null,
          unclear ? el("span", { class: "meta-unclear" }, `${unclear} belirsiz yer`) : null)),
      el("div", { class: "lesson-actions" },
        lesson.status === "done" ? [
          el("a", { class: "btn", href: `#/ders/${lesson.id}` }, "Not"),
          el("a", { class: "btn", href: `#/ders/${lesson.id}/harita`, "data-testid": "open-map" }, "Harita"),
          el("a", { class: "btn", href: `#/ders/${lesson.id}/pdf`, "data-testid": "open-pdf" }, "PDF"),
        ] : status)),
    timeline?.dur ? el("a", { class: "ribbon-link", href: `#/ders/${lesson.id}`, "aria-label": `${lesson.title} notunu aç` }, ribbonView(timeline)) : null);
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
  const groups = new Map();
  for (const lesson of data.lessons) groups.set(lesson.course, [...(groups.get(lesson.course) || []), lesson]);
  const summary = document.getElementById("library-summary");
  if (summary) {
    const total = data.lessons.reduce((sum, lesson) => sum + (lesson.timeline?.dur || 0), 0);
    summary.textContent = data.lessons.length ? `${data.lessons.length} ders${total ? ` · ${Math.round(total / 60)} dakika kayıt` : ""}` : "";
  }
  host.replaceChildren(...(data.lessons.length
    ? [...groups].map(([course, lessons]) => el("section", { class: "shelf" }, el("h2", { class: "shelf-title" }, course), lessons.map(lessonRow)))
    : [el("div", { class: "empty" }, filters.q || filters.course ? "Aramayla eşleşen ders yok." : "Henüz ders yok. İlk kaydını yukarı bırak.")]));
  if (open) host.querySelector(".error details")?.setAttribute("open", "");
}

function renderHome() {
  document.title = "Ders Notları";
  let searchTimer;
  app.replaceChildren(el("div", { class: "home" },
    el("header", { class: "home-head" }, el("h1", {}, "Ders arşivi"), el("span", { id: "library-summary", class: "muted" })),
    el("section", { class: "upload-card" }, el("div", { id: "upload-host" })),
    el("div", { class: "filters" },
      el("input", { type: "search", placeholder: "Başlıkta, notta ve transkriptte ara", value: filters.q, "data-testid": "search", oninput: (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { filters.q = e.target.value; refreshList(); }, 250); } }),
      el("select", { id: "course-filter", "data-testid": "course-filter", onchange: (e) => { filters.course = e.target.value; refreshList(); } })),
    el("div", { id: "worker-note", class: "warn", "data-testid": "worker-note", hidden: true }, "İşleyen Mac şu an kapalı. Sıradaki dersler Mac açılınca işlenir."),
    el("div", { id: "lesson-list", "data-testid": "lesson-list" })));
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

/* ---------- Okuyucu: zaman omurgası ve ses çubuğu ---------- */
function timelineFrom(lesson) {
  const sec = [];
  for (const line of lesson.note.split("\n")) {
    const match = /^(#{2,3})\s+(.*?)\s*\[(\d+:\d\d)\]\s*$/.exec(line);
    if (match) sec.push({ level: match[1].length, title: match[2].replace(/[`*_]/g, ""), t: toSeconds(match[3]) });
  }
  const stamps = [...lesson.transcript.matchAll(/^\[(\d+:\d\d)\]/gm)];
  const dur = stamps.length ? toSeconds(stamps[stamps.length - 1][1]) + 5 : (sec.length ? sec[sec.length - 1].t + 60 : 0);
  return { dur, sec, unc: lesson.unclear.map((item) => toSeconds(item.stamp)).filter((value) => !Number.isNaN(value)) };
}

let reader = { rail: [], headings: [], follow: false, current: -1 };

function railView(timeline, lesson, noteBox) {
  const shortAt = new Set((lesson.analysis?.coverage?.sections || []).filter((section) => section.short).map((section) => section.t));
  const nav = el("nav", { class: "rail", "data-testid": "rail", "aria-label": "Dersin bölümleri" });
  reader.rail = []; reader.headings = []; reader.current = -1;
  const heads = [...noteBox.querySelectorAll("h2, h3")];
  timeline.sec.forEach((section, index) => {
    const next = timeline.sec[index + 1]?.t ?? timeline.dur;
    const span = Math.max(next - section.t, 0);
    const heading = heads.find((node) => Number(node.querySelector("button.ts")?.dataset.seek) === section.t && node.textContent.includes(section.title.slice(0, 12)));
    const unclear = (timeline.unc || []).filter((stamp) => stamp >= section.t && stamp < next).length;
    const item = el("button", { type: "button", class: `rail-item level-${section.level}`, style: `flex-grow:${Math.max(span, 1)}`, "data-testid": "rail-item", onclick: () => {
      heading?.scrollIntoView({ behavior: "smooth", block: "start" });
      const audio = document.getElementById("player");
      if (audio) audio.currentTime = section.t;
    } },
      el("span", { class: "rail-time" }, clock(section.t)),
      el("span", { class: "rail-title" }, section.title),
      unclear ? el("span", { class: "rail-mark", title: `${unclear} belirsiz yer` }, `? ${unclear}`) : null,
      shortAt.has(section.t) ? el("span", { class: "rail-short", title: "Bu bölüm konuşma süresine göre kısa görünüyor. Sesi dinleyip karşılaştır." }, "kısa") : null);
    nav.append(item);
    reader.rail.push({ item, start: section.t, end: next });
    reader.headings.push(heading || null);
  });
  return nav;
}

function dockView(lesson, timeline) {
  const audio = el("audio", { id: "player", preload: "metadata", src: `/api/lessons/${lesson.id}/audio` });
  const playIcon = el("span", { "aria-hidden": "true" }, "▶");
  const play = el("button", { class: "dock-play", type: "button", "data-testid": "dock-play", "aria-label": "Oynat", onclick: () => (audio.paused ? audio.play().catch(() => {}) : audio.pause()) }, playIcon);
  const time = el("span", { class: "dock-time", "data-testid": "dock-time" }, `0:00 / ${clock(timeline.dur)}`);
  const ribbon = ribbonView(timeline, { large: true, all: true, testid: "dock-ribbon" });
  const head = el("span", { class: "ribbon-head" });
  ribbon.append(head);
  const speeds = [1, 1.25, 1.5, 1.75, 2];
  const speed = el("button", { class: "dock-btn", type: "button", "data-testid": "dock-speed", title: "Oynatma hızı", onclick: () => {
    const next = speeds[(speeds.indexOf(audio.playbackRate) + 1) % speeds.length] || 1;
    audio.playbackRate = next;
    speed.textContent = `${next.toLocaleString("tr-TR")}×`;
  } }, "1×");
  const follow = el("button", { class: "dock-btn", type: "button", "data-testid": "dock-follow", "aria-pressed": "false", title: "Çalan bölümü notta otomatik göster", onclick: () => {
    reader.follow = !reader.follow;
    follow.setAttribute("aria-pressed", String(reader.follow));
    reader.current = -1;
    sync();
  } }, "Takip et");
  const total = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : timeline.dur);
  function sync() {
    const now = audio.currentTime;
    time.textContent = `${clock(now)} / ${clock(total())}`;
    head.style.left = `${Math.min(now / (timeline.dur || total() || 1), 1) * 100}%`;
    let active = -1;
    reader.rail.forEach((entry, index) => { if (now >= entry.start && now < entry.end) active = index; });
    if (active === reader.current) return;
    reader.rail.forEach((entry, index) => {
      entry.item.classList.toggle("now", index === active);
      entry.item.classList.toggle("past", entry.end <= now);
      reader.headings[index]?.classList.toggle("now", index === active);
    });
    reader.current = active;
    if (active >= 0) {
      reader.rail[active].item.scrollIntoView({ block: "nearest" });
      if (reader.follow) reader.headings[active]?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
  audio.addEventListener("timeupdate", sync);
  audio.addEventListener("loadedmetadata", sync);
  audio.addEventListener("play", () => { playIcon.textContent = "❚❚"; play.setAttribute("aria-label", "Duraklat"); });
  audio.addEventListener("pause", () => { playIcon.textContent = "▶"; play.setAttribute("aria-label", "Oynat"); });
  ribbon.addEventListener("click", (event) => {
    const box = ribbon.getBoundingClientRect();
    audio.currentTime = Math.max(0, Math.min((event.clientX - box.left) / box.width, 1)) * (timeline.dur || total());
    sync();
  });
  const jump = (seconds, label) => el("button", { class: "dock-btn", type: "button", title: `${Math.abs(seconds)} saniye ${seconds < 0 ? "geri" : "ileri"}`, onclick: () => { audio.currentTime = Math.max(0, audio.currentTime + seconds); sync(); } }, label);
  const keys = (event) => {
    if (event.target.closest("input, textarea, select, button, a, iframe, [contenteditable]") && event.key !== "Escape") return;
    if (event.code === "Space") { event.preventDefault(); play.click(); }
    if (event.key === "ArrowLeft") { audio.currentTime = Math.max(0, audio.currentTime - 15); sync(); }
    if (event.key === "ArrowRight") { audio.currentTime += 15; sync(); }
  };
  document.addEventListener("keydown", keys);
  pageCleanup = () => { document.removeEventListener("keydown", keys); audio.pause(); hideHint(); };
  const node = el("div", { class: "dock", "data-testid": "dock" }, audio,
    el("div", { class: "dock-controls" }, jump(-15, "−15"), play, jump(15, "+15"), time), ribbon,
    el("div", { class: "dock-extra" }, speed, follow));
  return { node, refresh: sync };
}

/* ---------- Harita: regresyon, K-means, PCA ---------- */
const NS = "http://www.w3.org/2000/svg";
const TOPIC_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"];
const TIME_RAMP = ["#86b6ef", "#3987e5", "#256abf", "#104281", "#0d366b"];

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
}

function hintBox() {
  let box = document.getElementById("viz-hint");
  if (!box) { box = el("div", { id: "viz-hint", class: "viz-hint", hidden: true }); document.body.append(box); }
  return box;
}
function hideHint() { const box = document.getElementById("viz-hint"); if (box) box.hidden = true; }
function hint(node, text) {
  node.addEventListener("pointerenter", () => { const box = hintBox(); box.textContent = text; box.hidden = false; });
  node.addEventListener("pointermove", (event) => {
    const box = hintBox();
    box.style.left = `${Math.min(event.clientX + 14, innerWidth - box.offsetWidth - 8)}px`;
    box.style.top = `${Math.max(event.clientY - box.offsetHeight - 10, 8)}px`;
  });
  node.addEventListener("pointerleave", hideHint);
  return node;
}

function mix(colorA, colorB, ratio) {
  const parts = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const a = parts(colorA), b = parts(colorB);
  return `#${a.map((v, i) => Math.round(v + (b[i] - v) * ratio).toString(16).padStart(2, "0")).join("")}`;
}
function timeColor(ratio) {
  const place = Math.min(ratio, 0.9999) * (TIME_RAMP.length - 1);
  const index = Math.floor(place);
  return mix(TIME_RAMP[index], TIME_RAMP[index + 1], place - index);
}

function tableView(summary, headers, rows) {
  return el("details", { class: "viz-table" }, el("summary", {}, summary),
    el("div", { class: "viz-table-scroll" }, el("table", {},
      el("thead", {}, el("tr", {}, headers.map((text) => el("th", {}, text)))),
      el("tbody", {}, rows.map((cells) => el("tr", {}, cells.map((cell) => el("td", {}, cell))))))));
}

function topicsView(lesson) {
  const data = lesson.analysis?.topics;
  const card = el("section", { class: "viz-card", "data-testid": "map-topics" }, el("h2", {}, "Dersin konu akışı"));
  if (!data) { card.append(el("p", { class: "muted" }, "Bu kayıt konu analizi için kısa. En az 12 dakika konuşma gerekir.")); return card; }
  card.append(el("p", { class: "viz-lead" }, `Her dakika kullanılan kelimelere göre ${data.k} kümeye ayrıldı (K-means). Şeritte hangi dakikada hangi kelimelerin öne çıktığını görürsün. Şeride tıklayınca ses oraya gider.`));
  const duration = data.windows[data.windows.length - 1].t + 60;
  const strip = svg("svg", { viewBox: "0 0 1000 46", class: "topic-strip", role: "img", "aria-label": "Dakikalara göre konu kümeleri" });
  const windows = data.windows;
  windows.forEach((win, index) => {
    const x = win.t / duration * 1000;
    const width = Math.max(((windows[index + 1]?.t ?? duration) - win.t) / duration * 1000 - 2, 1);
    const group = svg("g", { "data-seek": win.t, class: "viz-mark" }, svg("rect", { x, y: 2, width, height: 28, rx: 2, fill: TOPIC_COLORS[win.c] }));
    if (width > 15) { const label = svg("text", { x: x + width / 2, y: 21, class: "strip-label" }); label.textContent = win.c + 1; group.append(label); }
    strip.append(hint(group, `${clock(win.t)} · Küme ${win.c + 1}: ${data.clusters[win.c].terms.join(", ")}`));
  });
  for (let minute = 0; minute <= duration / 60; minute += 10) {
    const label = svg("text", { x: Math.min(minute * 60 / duration * 1000, 980), y: 44, class: "strip-axis" }); label.textContent = `${minute} dk`;
    strip.append(label);
  }
  card.append(strip, el("ul", { class: "viz-legend" }, data.clusters.map((cluster) => el("li", {},
    el("span", { class: "swatch", style: `background:${TOPIC_COLORS[cluster.id]}` }, String(cluster.id + 1)),
    el("span", {}, cluster.terms.join(", ")), el("span", { class: "muted" }, `${cluster.minutes} dk`)))));
  card.append(tableView("Tablo olarak gör", ["Dakika", "Küme", "Öne çıkan kelimeler"], windows.map((win) => [clock(win.t), String(win.c + 1), data.clusters[win.c].terms.join(", ")])));
  return card;
}

function pcaView(lesson) {
  const data = lesson.analysis?.topics;
  const card = el("section", { class: "viz-card", "data-testid": "map-pca" }, el("h2", {}, "Kelime haritası"));
  if (!data) { card.append(el("p", { class: "muted" }, "Bu kayıt harita için kısa.")); return card; }
  const explained = data.explained.reduce((sum, value) => sum + value, 0);
  card.append(el("p", { class: "viz-lead" }, `Her nokta bir dakika (PCA). Birbirine yakın noktalar benzer kelimelerle anlatılmış. Bu iki eksen kelime çeşitliliğinin yalnızca %${Math.round(explained * 100)} kadarını gösterir, kaba bir özettir.`));
  const W = 560, H = 340, P = 26;
  const xs = data.windows.map((w) => w.x), ys = data.windows.map((w) => w.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sx = (v) => P + (v - x0) / ((x1 - x0) || 1) * (W - 2 * P);
  const sy = (v) => H - P - (v - y0) / ((y1 - y0) || 1) * (H - 2 * P);
  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "viz-svg", role: "img", "aria-label": "Dakikaların kelime benzerliği haritası" });
  chart.append(svg("polyline", { points: data.windows.map((w) => `${sx(w.x)},${sy(w.y)}`).join(" "), class: "pca-path" }));
  const last = data.windows[data.windows.length - 1].t || 1;
  for (const win of data.windows) {
    chart.append(hint(svg("g", { "data-seek": win.t, class: "viz-mark" },
      svg("circle", { cx: sx(win.x), cy: sy(win.y), r: 12, fill: "transparent" }),
      svg("circle", { cx: sx(win.x), cy: sy(win.y), r: 5.5, fill: timeColor(win.t / last), stroke: "#fff", "stroke-width": 2 })),
      `${clock(win.t)} · Küme ${win.c + 1}: ${data.clusters[win.c].terms.join(", ")}`));
  }
  card.append(chart, el("div", { class: "time-legend" }, el("span", {}, "Başlangıç"), el("span", { class: "time-ramp", style: `background:linear-gradient(90deg,${TIME_RAMP.join(",")})` }), el("span", {}, "Son")));
  return card;
}

function coverageView(lesson) {
  const data = lesson.analysis?.coverage;
  const card = el("section", { class: "viz-card", "data-testid": "map-coverage" }, el("h2", {}, "Bölümlerin kapsamı"));
  if (!data) { card.append(el("p", { class: "muted" }, "Bu kayıtta karşılaştırma için en az 8 bölüm gerekir.")); return card; }
  const short = data.sections.filter((section) => section.short);
  card.append(el("p", { class: "viz-lead" }, `Regresyon, notun her bölümünü o bölümde konuşulan kelime sayısıyla karşılaştırır. Çizginin belirgin altında kalan bölüm kısa kalmış olabilir. ${data.sections.length} bölüm, R² = ${data.r2.toLocaleString("tr-TR", { maximumFractionDigits: 2 })}.`));
  const W = 560, H = 320, L = 50, R = 16, T = 14, B = 42;
  const xs = data.sections.map((s) => Math.log(s.lecture_words)), ys = data.sections.map((s) => Math.log(Math.max(s.note_words, 1)));
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const line = (v) => data.intercept + data.slope * v;
  const [y0, y1] = [Math.min(...ys, line(x0), line(x1)), Math.max(...ys, line(x0), line(x1))];
  // Noktalar eksen yazilarina degmesin diye cizim alaninin icinde kalir.
  const sx = (v) => L + 12 + (v - x0) / ((x1 - x0) || 1) * (W - L - R - 24);
  const sy = (v) => H - B - 14 - (v - y0) / ((y1 - y0) || 1) * (H - T - B - 26);
  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "viz-svg", role: "img", "aria-label": "Bölüm başına ders ve not kelime sayısı" });
  for (const tick of [5, 10, 20, 50, 100, 200, 500, 1000]) {
    if (Math.log(tick) >= x0 && Math.log(tick) <= x1) { const label = svg("text", { x: sx(Math.log(tick)), y: H - B + 18, class: "axis-text", "text-anchor": "middle" }); label.textContent = tick; chart.append(svg("line", { x1: sx(Math.log(tick)), x2: sx(Math.log(tick)), y1: T, y2: H - B, class: "grid-line" }), label); }
    if (Math.log(tick) >= y0 && Math.log(tick) <= y1) { const label = svg("text", { x: L - 8, y: sy(Math.log(tick)) + 4, class: "axis-text", "text-anchor": "end" }); label.textContent = tick; chart.append(svg("line", { x1: L, x2: W - R, y1: sy(Math.log(tick)), y2: sy(Math.log(tick)), class: "grid-line" }), label); }
  }
  const xTitle = svg("text", { x: (L + W - R) / 2, y: H - 6, class: "axis-text", "text-anchor": "middle" }); xTitle.textContent = "Derste konuşulan kelime";
  const yTitle = svg("text", { x: 12, y: (T + H - B) / 2, class: "axis-text", "text-anchor": "middle", transform: `rotate(-90 12 ${(T + H - B) / 2})` }); yTitle.textContent = "Nottaki kelime";
  chart.append(xTitle, yTitle, svg("line", { x1: sx(x0), y1: sy(line(x0)), x2: sx(x1), y2: sy(line(x1)), class: "fit-line" }));
  for (const section of data.sections) {
    const cx = sx(Math.log(section.lecture_words)), cy = sy(Math.log(Math.max(section.note_words, 1)));
    chart.append(hint(svg("g", { "data-seek": section.t, class: "viz-mark" },
      svg("circle", { cx, cy, r: 12, fill: "transparent" }),
      svg("circle", { cx, cy, r: section.short ? 7 : 5.5, fill: section.short ? "#b56a00" : "#2a78d6", stroke: "#fff", "stroke-width": 2 })),
      `${clock(section.t)} · ${section.title}: derste ${section.lecture_words}, notta ${section.note_words} kelime`));
    if (section.short) {
      const anchor = cx > W * 0.6 ? "end" : "start";
      const label = svg("text", { x: cx + (anchor === "end" ? -12 : 12), y: cy + 4, class: "flag-text", "text-anchor": anchor }); label.textContent = `⚠ ${section.title}`;
      chart.append(label);
    }
  }
  card.append(chart);
  card.append(short.length
    ? el("ul", { class: "viz-list" }, short.map((section) => el("li", {}, stampButton(clock(section.t), clock(section.t), true), el("span", {}, ` ${section.title}: kısa görünüyor. Sesi dinleyip karşılaştır. Bu kesin bir hata değildir, bazı bölümler az konuşma içerdiği için kısadır.`))))
    : el("p", { class: "muted" }, "Belirgin kısa kalmış bölüm görünmüyor."));
  card.append(tableView("Tablo olarak gör", ["Süre", "Bölüm", "Derste", "Notta"], data.sections.map((s) => [clock(s.t), s.title, String(s.lecture_words), String(s.note_words)])));
  return card;
}

function supportView(lesson) {
  const data = lesson.analysis?.support;
  const card = el("section", { class: "viz-card wide", "data-testid": "map-support" }, el("h2", {}, "Önce bunları kontrol et"));
  if (!data) { card.append(el("p", { class: "muted" }, "Bu kayıt cümle karşılaştırması için kısa.")); return card; }
  card.append(el("p", { class: "viz-lead" }, `${data.sentences} cümle içinde kelimeleri derstekilere en az benzeyenler. Bunlar yanlış demek değildir, çoğu kez yalnızca farklı ifade edilmiştir. Süreye tıklayınca dersin en yakın yeri çalar.`));
  card.append(el("ol", { class: "support-list" }, data.low.map((item) => el("li", { "data-testid": "support-item" },
    stampButton(clock(item.t), clock(item.t), false), el("span", {}, item.text)))));
  return card;
}

function mapView(lesson) {
  const box = el("div", { class: "map", "data-testid": "map" });
  if (!lesson.analysis) {
    box.append(el("div", { class: "card" }, el("p", {}, "Analiz henüz hazır değil. Mac açıkken birkaç dakika içinde gelir, sonra sayfayı yenile.")));
    return box;
  }
  box.append(
    el("p", { class: "map-note", "data-testid": "map-caveat" }, "Bu ekran kelime istatistiğidir, anlamı okumaz. Anlamı ters çevrilmiş bir cümleyi yakalayamaz, yüksek benzerlik doğruluk kanıtı değildir. Asıl kontrol “Belirsiz yerler” listesindedir."),
    el("div", { class: "map-grid" }, topicsView(lesson), supportView(lesson), pcaView(lesson), coverageView(lesson)));
  return box;
}

function renderReady(lesson, host) {
  const panel = el("div");
  const tabs = el("div", { class: "tabs" });
  const dirty = { value: null };
  const timeline = timelineFrom(lesson);
  const dock = dockView(lesson, timeline);
  const show = (tab) => {
    currentTab = tab;
    for (const button of tabs.children) button.classList.toggle("on", button.dataset.tab === tab);
    if (tab === "note") {
      const noteBox = renderNote(lesson.note);
      panel.replaceChildren(el("div", { class: `layout${timeline.sec.length ? "" : " no-rail"}` }, timeline.sec.length ? railView(timeline, lesson, noteBox) : null, el("div", { class: "card note-card" }, noteBox), checklistView(lesson)));
      dock.refresh();
    }
    if (tab === "map") panel.replaceChildren(mapView(lesson));
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
  for (const [key, label] of [["note", "Not"], ["map", "Harita"], ["pdf", "PDF"], ["edit", "Düzenle"], ["transcript", "Ham transkript"]]) {
    tabs.append(el("button", { "data-tab": key, "data-testid": `tab-${key}`, onclick: () => show(key) }, label));
  }
  host.replaceChildren(tabs, panel, dock.node);
  show(currentTab);
}

async function renderLesson(id, tab) {
  currentTab = tab === "harita" ? "map" : tab || "note";
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

let pageCleanup = null;

function route() {
  clearInterval(pollTimer);
  app.removeEventListener("click", seekHandler);
  pageCleanup?.();
  pageCleanup = null;
  reader = { rail: [], headings: [], follow: false, current: -1 };
  window.scrollTo(0, 0);
  const match = /^#\/ders\/(\d+)(?:\/(pdf|harita))?/.exec(location.hash);
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
