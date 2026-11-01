"use strict";
const app = document.getElementById("app");
const STAGES = [["converting", "Convert"], ["transcribing", "Transcribe"], ["writing", "Write"], ["verifying", "Verify"], ["done", "Done"]];
const STATUS = { queued: "Queued", converting: "Converting", transcribing: "Transcribing", writing: "Writing", verifying: "Verifying", done: "Done", failed: "Failed" };
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
  if (response.status === 401) { location.replace("/login.html"); return new Promise(() => {}); }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || "Server error");
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
  if (seconds == null) return "estimating time";
  if (seconds < 60) return "under a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  return `about ${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}

function formatDate(ts) {
  return new Date(ts * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

/* ---------- İlerleme ---------- */
function progressView(lesson) {
  const box = el("div", { class: "progress", "data-testid": "progress" });
  if (lesson.status === "queued") {
    box.append(el("div", { class: "muted", "data-testid": "stage-text" }, (lesson.queue_position > 1 ? `Queued, position ${lesson.queue_position}.` : "Queued. Starting soon.")));
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
    box.append(el("div", { class: "muted", "data-testid": "stage-text" }, percent < 5 ? `${percent.toLocaleString("en-US")}% · estimating time` : `${percent.toLocaleString("en-US")}% · ${formatEta(lesson.eta_seconds)}`));
  } else if (lesson.status === "converting" || lesson.status === "writing" || lesson.status === "verifying") {
    box.append(el("div", { class: "bar indeterminate" }, el("div")));
    const text = { writing: "Writing the note.", verifying: "Checking the note against the sources." }[lesson.status] || "Preparing audio.";
    box.append(el("div", { class: "muted", "data-testid": "stage-text" }, text));
  }
  return box;
}

function errorView(lesson, onRetry) {
  if (lesson.status !== "failed") return null;
  return el("div", { class: "error", "data-testid": "error" },
    el("div", {}, lesson.error || "Unknown error"),
    lesson.error_detail ? el("details", {}, el("summary", {}, "Details"), el("pre", {}, lesson.error_detail)) : null,
    el("div", { style: "margin-top:8px" }, el("button", { "data-testid": "retry", onclick: onRetry }, "Retry")));
}

async function retryLesson(id) {
  try {
    await apiJson(`/api/lessons/${id}/retry`, { method: "POST" });
    toast("Queued again.");
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
    if (!kind) { toast(`Unsupported file: ${file.name}`); continue; }
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
    el("div", { class: "drop-text" }, el("strong", {}, "Drop a recording here"),
      el("span", { class: "muted" }, "Audio: m4a, mp3, wav · Slides (optional): PDF, PPTX")),
    el("span", { class: "drop-link" }, "Choose file"));
  zone.addEventListener("dragenter", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); acceptFiles(e.dataTransfer.files); });

  const row = (kind, label) => draft[kind] && el("div", { class: "file", "data-testid": `file-${kind}` },
    el("span", {}, `${label}: ${draft[kind].name}`),
    el("button", { title: "Remove", onclick: () => { draft[kind] = null; renderUploadForm(); } }, "×"));

  const status = el("div", { class: "muted", "data-testid": "upload-status" });
  const submit = el("button", { class: "primary", "data-testid": "submit", disabled: !draft.audio, onclick: () => upload(submit, status) }, "Add to queue");
  const chosen = Boolean(draft.audio || draft.slides);
  host.classList.toggle("chosen", chosen);
  host.replaceChildren(zone, input,
    el("div", { class: "files" }, row("audio", "Audio"), row("slides", "Slides")),
    el("div", { class: "upload-fields", hidden: !chosen },
      el("label", { class: "field" }, "Title", el("input", { type: "text", value: draft.title, "data-testid": "title", placeholder: "e.g. Week 3: Bisection", oninput: (e) => { draft.title = e.target.value; } })),
      el("label", { class: "field" }, "Course", el("input", { type: "text", value: draft.course, "data-testid": "course", list: "course-list", placeholder: "Choose or type a course", oninput: (e) => { draft.course = e.target.value; } }))),
    el("datalist", { id: "course-list" }),
    el("div", { class: "upload-send", hidden: !chosen }, submit), status);
  refreshCourseOptions();
}

let knownCourses = [];
function refreshCourseOptions() {
  const list = document.getElementById("course-list");
  if (list) list.replaceChildren(...knownCourses.map((course) => el("option", { value: course })));
}

let authReady = Promise.resolve();
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
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) status.textContent = `Uploading ${label.toLowerCase()} ${Math.round(e.loaded / e.total * 100)}%`; };
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error("Upload failed.")));
    xhr.onerror = () => reject(new Error("Could not reach storage."));
    xhr.send(file);
  });
}

async function uploadDirect(button, status) {
  button.disabled = true;
  try {
    const created = await sendJson("/api/lessons", "POST", { title: draft.title, course: draft.course, audio_name: draft.audio.name, slides_name: draft.slides ? draft.slides.name : null });
    await putFile(created.audio_url, draft.audio, status, "Audio");
    if (draft.slides) await putFile(created.slides_url, draft.slides, status, "Slides");
    await apiJson(`/api/lessons/${created.id}/ready`, { method: "POST" });
    afterUpload();
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
}

async function upload(button, status) {
  // Sayfa yeni acildiysa yukleme yolu henuz bilinmiyor olabilir: once ogrenilir.
  button.disabled = true;
  await authReady;
  if (directUpload) return uploadDirect(button, status);
  const form = new FormData();
  form.append("audio", draft.audio);
  if (draft.slides) form.append("slides", draft.slides);
  form.append("title", draft.title);
  form.append("course", draft.course);
  button.disabled = true;
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/lessons");
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) status.textContent = `Uploading ${Math.round(e.loaded / e.total * 100)}%`; };
  xhr.onload = () => {
    if (xhr.status === 200) {
      afterUpload();
    } else {
      let message = "Upload failed.";
      try { message = JSON.parse(xhr.responseText).detail || message; } catch (_) { /* düz metin */ }
      status.textContent = message;
      button.disabled = false;
    }
  };
  xhr.onerror = () => { status.textContent = "Could not reach the server."; button.disabled = false; };
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
    const title = parts.find((section) => section.t === start)?.title || "Intro";
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
      el("a", { class: "lesson-main", href: `#/lesson/${lesson.id}` },
        el("span", { class: "lesson-title" }, lesson.title),
        el("span", { class: "lesson-meta" }, el("span", { class: "course-tag" }, lesson.course), el("span", {}, formatDate(lesson.created)),
          timeline?.dur ? el("span", {}, clock(timeline.dur)) : null,
          unclear ? el("span", { class: "meta-unclear" }, `${unclear} unclear`) : null)),
      el("div", { class: "lesson-actions" },
        lesson.status === "done" ? [
          el("a", { class: "btn", href: `#/lesson/${lesson.id}` }, "Note"),
          el("a", { class: "btn", href: `#/lesson/${lesson.id}/analysis`, "data-testid": "open-map" }, "Analysis"),
          el("a", { class: "btn", href: `#/lesson/${lesson.id}/pdf`, "data-testid": "open-pdf" }, "PDF"),
        ] : status)),
    timeline?.dur ? el("a", { class: "ribbon-link", href: `#/lesson/${lesson.id}`, "aria-label": `Open ${lesson.title}` }, ribbonView(timeline)) : null);
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
    select.replaceChildren(el("option", { value: "" }, "All courses"), ...data.courses.map((course) => el("option", { value: course }, course)));
    select.value = current;
  }
  const offline = document.getElementById("worker-note");
  if (offline) offline.hidden = !(data.worker_online === false && data.lessons.some((lesson) => lesson.status === "queued"));
  const open = host.querySelector("details[open]") !== null;
  renderBand(data.lessons);
  renderShowcase(data.lessons).catch(() => {});
  const filtered = Boolean(filters.q || filters.course);
  const visible = filtered || showAllLessons ? data.lessons : data.lessons.slice(0, LESSON_LIMIT);
  const groups = new Map();
  for (const lesson of visible) groups.set(lesson.course, [...(groups.get(lesson.course) || []), lesson]);
  const summary = document.getElementById("library-summary");
  if (summary) {
    const total = data.lessons.reduce((sum, lesson) => sum + (lesson.timeline?.dur || 0), 0);
    summary.textContent = data.lessons.length ? `${data.lessons.length} ${data.lessons.length === 1 ? "lecture" : "lectures"}${total ? ` · ${Math.round(total / 60)} min` : ""}` : "";
  }
  host.replaceChildren(...(data.lessons.length
    ? [...[...groups].map(([course, lessons]) => el("section", { class: "shelf" }, el("h2", { class: "shelf-title" }, course), lessons.map(lessonRow))),
      visible.length < data.lessons.length ? el("button", { class: "show-all", "data-testid": "show-all", onclick: () => { showAllLessons = true; refreshList(); } }, `Show all ${data.lessons.length}`) : null].filter(Boolean)
    : [el("div", { class: "empty" }, filtered ? "No matching lectures." : "No lectures yet. Upload a recording to start.")]));
  if (open) host.querySelector(".error details")?.setAttribute("open", "");
}

/* ---------- Ana sayfa bandı: yalnızca ölçülmüş değerler ---------- */
let bandKey = "";
const LESSON_LIMIT = 8;
let showAllLessons = false;

function bandTile(value, label, note) {
  return el("div", { class: "tile" }, el("div", { class: "tile-value" }, value), el("div", { class: "tile-label" }, label), note ? el("div", { class: "tile-note" }, note) : null);
}

function sparkline(share) {
  const W = 240, H = 34;
  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "spark", role: "img", "aria-label": "Low-confidence word share per minute" });
  const step = W / share.length;
  share.forEach((value, minute) => {
    const height = Math.max((value ?? 0) * (H - 2), value ? 1 : 0);
    chart.append(hint(svg("g", { class: "spark-mark" }, svg("rect", { x: minute * step, y: 0, width: step, height: H, fill: "transparent" }),
      height ? svg("rect", { x: minute * step + 0.5, y: H - height, width: Math.max(step - 1, 1), height, rx: 1, fill: "#3987e5" }) : null),
      value == null ? `Minute ${minute}: no speech` : `Minute ${minute}: ${Math.round(value * 100)}% low confidence`));
  });
  return chart;
}

/* ---------- Ana sayfa grafikleri ---------- */
function neuralChartView(lesson) {
  const data = lesson.analysis?.support;
  if (!data?.points?.length) return null;
  const card = el("section", { class: "viz-card wide", "data-testid": "chart-neural" }, el("h2", {}, "Neural score per sentence"),
    el("p", { class: "viz-lead" }, `${data.points.length} sentences by lecture time. A low score is a prompt to check, not proof of error.`));
  const W = 1000, H = 300, L = 44, R = 12, T = 12, B = 34;
  const end = Math.max(...data.points.map((p) => p.t), 60);
  const ys = data.points.map((p) => p.score);
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const sx = (t) => L + 8 + t / end * (W - L - R - 16);
  const sy = (v) => H - B - 8 - (v - y0) / ((y1 - y0) || 1) * (H - T - B - 16);
  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "viz-svg", role: "img", "aria-label": "Neural score per sentence" });
  for (let tick = Math.ceil(y0); tick <= y1; tick += Math.max(1, Math.round((y1 - y0) / 4))) {
    const label = svg("text", { x: L - 8, y: sy(tick) + 4, class: "axis-text", "text-anchor": "end" }); label.textContent = tick;
    chart.append(svg("line", { x1: L, x2: W - R, y1: sy(tick), y2: sy(tick), class: "grid-line" }), label);
  }
  for (let minute = 0; minute * 60 <= end; minute += 10) {
    const label = svg("text", { x: sx(minute * 60), y: H - 10, class: "axis-text", "text-anchor": "middle" }); label.textContent = `${minute} min`;
    chart.append(label);
  }
  const cutLabel = svg("text", { x: W - R, y: sy(data.cutoff) - 6, class: "flag-text", "text-anchor": "end" }); cutLabel.textContent = "⚠ Check line";
  chart.append(svg("line", { x1: L, x2: W - R, y1: sy(data.cutoff), y2: sy(data.cutoff), class: "cut-line" }), cutLabel);
  for (const point of data.points) {
    const low = point.score <= data.cutoff;
    chart.append(hint(svg("g", { "data-seek": point.t, class: "viz-mark" },
      svg("circle", { cx: sx(point.t), cy: sy(point.score), r: 11, fill: "transparent" }),
      svg("circle", { cx: sx(point.t), cy: sy(point.score), r: low ? 6.5 : 4.5, fill: low ? "#b56a00" : "#2a78d6", stroke: "#fff", "stroke-width": 2 })),
      `${clock(point.t)} · puan ${point.score.toLocaleString("en-US")}: ${point.text}`));
  }
  card.append(chart, el("ul", { class: "viz-legend inline" },
    el("li", {}, el("span", { class: "dot", style: "background:#2a78d6" }), "Sentence"),
    el("li", {}, el("span", { class: "dot", style: "background:#b56a00" }), "⚠ Flagged for checking")));
  return card;
}

/* ---------- Tuval çizimleri ---------- */
function makeCanvas(W, H, testid, label) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = el("canvas", { class: "viz-canvas", width: W * ratio, height: H * ratio, "data-testid": testid, "aria-label": label, role: "img" });
  canvas.style.aspectRatio = `${W} / ${H}`;
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  const at = (event) => { const box = canvas.getBoundingClientRect(); return [(event.clientX - box.left) / box.width * W, (event.clientY - box.top) / box.height * H]; };
  return { canvas, ctx, at, ratio };
}

function animate(canvas, draw) {
  // Ekran disindayken ve hareket azaltma aciksa bosuna calismaz.
  const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  let visible = true, last = 0;
  const observer = window.IntersectionObserver ? new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }) : null;
  observer?.observe(canvas);
  const loop = (now) => {
    if (!canvas.isConnected) { observer?.disconnect(); return; }
    if (visible) draw(now, now - last);
    last = now;
    if (!calm) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  if (calm) draw(0, 16);
}

const nnListeners = [];

function denseNetView(lesson) {
  const data = lesson.analysis?.support;
  if (!data?.models) return null;
  const embed = data.models.gomme, nli = data.models.nli;
  const SHOW = 18;
  const columns = [{ name: "Text", n: 7, note: "input" }];
  for (let i = 1; i <= (embed.katman || 6); i += 1) columns.push({ name: `MiniLM ${i}`, n: SHOW, note: `${embed.boyut}` });
  for (let i = 1; i <= (nli.katman || 6); i += 1) columns.push({ name: `DeBERTa ${i}`, n: SHOW, note: `${nli.boyut}` });
  columns.push({ name: "Output", n: 3, note: "NLI", out: true }, { name: "Score", n: 1, note: "neuron", out: true });
  const W = 1240, H = 560, top = 58, bottom = H - 24;
  const { canvas, ctx } = makeCanvas(W, H, "chart-dense", "Neural network layers");
  const X = (i) => 46 + i * (W - 92) / (columns.length - 1);
  const pos = columns.map((col, i) => Array.from({ length: col.n }, (_, k) => [X(i), col.n === 1 ? (top + bottom) / 2 : (top + bottom) / 2 + (k - (col.n - 1) / 2) * Math.min((bottom - top) / (col.n - 1), col.n < 8 ? 34 : 99)]));
  const ratio = canvas.width / W;
  const backing = document.createElement("canvas");
  backing.width = canvas.width; backing.height = canvas.height;
  const b = backing.getContext("2d");
  b.scale(ratio, ratio);
  let edgeCount = 0;
  b.lineWidth = 0.55;
  b.strokeStyle = "rgba(28,34,48,.24)";
  b.beginPath();
  for (let i = 0; i < pos.length - 1; i += 1) for (const a of pos[i]) for (const c of pos[i + 1]) { b.moveTo(a[0], a[1]); b.lineTo(c[0], c[1]); edgeCount += 1; }
  b.stroke();
  columns.forEach((col, i) => {
    b.fillStyle = "#1c2230"; b.textAlign = "center"; b.font = "600 11px -apple-system,sans-serif";
    const words = col.name.split(" ");
    b.fillText(words[0], X(i), 16);
    b.font = "11px -apple-system,sans-serif"; b.fillStyle = "#6c7280";
    b.fillText(words[1] ? `${words[1]} · ${col.note}` : col.note, X(i), 30);
    pos[i].forEach(([x, y], k) => {
      b.beginPath(); b.arc(x, y, col.out ? 10 : 8, 0, 7); b.fillStyle = "#1c2230"; b.fill();
      b.fillStyle = "#fff"; b.font = "600 8.5px -apple-system,sans-serif"; b.fillText(String(k + 1), x, y + 3);
    });
  });
  canvas.dataset.edges = edgeCount;
  let current = null;
  const seed = Array.from({ length: 70 }, (_, i) => ({ col: i % (pos.length - 1), a: (i * 13) % 97, c: (i * 29) % 89, p: (i * 0.137) % 1 }));
  const OUT = pos.length - 2, SCORE = pos.length - 1;
  nnListeners.push((point) => { current = point; });
  animate(canvas, (now) => {
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(backing, 0, 0, W, H);
    ctx.lineWidth = 1.4;
    for (const pulse of seed) {
      const t = (now / 1700 + pulse.p) % 1;
      const from = pos[pulse.col][pulse.a % pos[pulse.col].length], to = pos[pulse.col + 1][pulse.c % pos[pulse.col + 1].length];
      const x = from[0] + (to[0] - from[0]) * t, y = from[1] + (to[1] - from[1]) * t;
      ctx.strokeStyle = "rgba(42,120,214,.28)";
      ctx.beginPath(); ctx.moveTo(from[0], from[1]); ctx.lineTo(to[0], to[1]); ctx.stroke();
      ctx.fillStyle = "#2a78d6";
      ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
    }
    if (current) {
      const values = [current.contra, current.ent, current.neutral];
      const names = ["Contradiction", "Entailment", "Neutral"];
      pos[OUT].forEach(([x, y], k) => {
        ctx.beginPath(); ctx.arc(x, y, 7 + (values[k] || 0) * 9, 0, 7); ctx.fillStyle = k === 0 ? "#eb6834" : k === 1 ? "#1baf7a" : "#2a78d6"; ctx.fill();
        const tag = `${names[k]} ${(values[k] || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
        ctx.font = "600 11px -apple-system,sans-serif"; ctx.textAlign = "right";
        const width = ctx.measureText(tag).width;
        ctx.fillStyle = "rgba(255,255,255,.94)"; ctx.fillRect(x - 24 - width, y - 9, width + 6, 18);
        ctx.fillStyle = "#1c2230"; ctx.fillText(tag, x - 21, y + 4);
      });
      const [sx, sy] = pos[SCORE][0];
      const low = current.score <= data.cutoff;
      ctx.beginPath(); ctx.arc(sx, sy, 17, 0, 7); ctx.fillStyle = low ? "#b56a00" : "#1c5cab"; ctx.fill();
      ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.font = "600 11px -apple-system,sans-serif";
      ctx.fillText(current.score.toLocaleString("en-US", { maximumFractionDigits: 1 }), sx, sy + 4);
    }
  });
  return el("section", { class: "viz-card wide", "data-testid": "card-dense" }, el("h2", {}, "Neural network layers"),
    el("p", { class: "viz-lead" }, `Real layers. ${SHOW} of ${embed.boyut} and ${nli.boyut} neurons drawn; lines show structure, not weights. Outputs are real for the selected sentence.`), canvas);
}

function graphView(lesson) {
  const data = lesson.analysis?.support?.graph;
  if (!data?.nodes?.length) return null;
  const W = 1240, H = 720;
  const { canvas, ctx, at } = makeCanvas(W, H, "chart-graph", "Network of sentences and lecture minutes");
  const degree = new Array(data.nodes.length).fill(0);
  for (const [a, b] of data.edges) { degree[a] += 1; degree[b] += 1; }
  const maxDegree = Math.max(...degree, 1);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const nodes = data.nodes.map((node, i) => ({ ...node, deg: degree[i], x: W / 2 + (rnd() - 0.5) * 500, y: H / 2 + (rnd() - 0.5) * 400, vx: 0, vy: 0 }));
  const ramp = ["#1f35c9", "#1f7fb8", "#1baf7a", "#8fd14f", "#f4d03f"];
  const colorOf = (node) => {
    if (node.flag) return "#e5352b";
    const place = Math.min(node.deg / maxDegree, 0.999) * (ramp.length - 1);
    return mix(ramp[Math.floor(place)], ramp[Math.floor(place) + 1], place - Math.floor(place));
  };
  let heat = 1, hover = null, drag = null;
  const step = () => {
    const repel = 1500, spring = 0.012, rest = 62;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
        const d2 = Math.max(dx * dx + dy * dy, 25);
        const f = repel / d2 * heat;
        const d = Math.sqrt(d2);
        nodes[i].vx += dx / d * f; nodes[i].vy += dy / d * f; nodes[j].vx -= dx / d * f; nodes[j].vy -= dy / d * f;
      }
    }
    for (const [a, b] of data.edges) {
      const dx = nodes[b].x - nodes[a].x, dy = nodes[b].y - nodes[a].y;
      const d = Math.max(Math.hypot(dx, dy), 1);
      const f = (d - rest) * spring * heat;
      nodes[a].vx += dx / d * f; nodes[a].vy += dy / d * f; nodes[b].vx -= dx / d * f; nodes[b].vy -= dy / d * f;
    }
    for (const node of nodes) {
      if (node === drag) continue;
      node.vx += (W / 2 - node.x) * 0.004 * heat; node.vy += (H / 2 - node.y) * 0.006 * heat;
      node.vx *= 0.82; node.vy *= 0.82;
      node.x = Math.max(12, Math.min(W - 12, node.x + node.vx)); node.y = Math.max(12, Math.min(H - 12, node.y + node.vy));
    }
    heat = Math.max(heat * 0.994, 0.04);
  };
  for (let i = 0; i < 120; i += 1) step();
  const radius = (node) => (node.flag ? 7 : node.kind === "minute" ? 4 : 3 + node.deg / maxDegree * 4);
  const pick = (x, y) => nodes.reduce((best, node) => { const d = Math.hypot(node.x - x, node.y - y); return d < 12 && (!best || d < best.d) ? { node, d } : best; }, null)?.node || null;
  canvas.addEventListener("pointermove", (event) => {
    const [x, y] = at(event);
    if (drag) { drag.x = x; drag.y = y; heat = Math.max(heat, 0.4); return; }
    hover = pick(x, y);
    canvas.style.cursor = hover ? "pointer" : "default";
    const box = hintBox();
    if (hover) {
      box.textContent = `${hover.kind === "minute" ? "Lecture minute" : hover.flag ? "⚠ Flagged sentence" : "Note sentence"} · ${clock(hover.t)} · ${hover.deg} links: ${hover.text}`;
      box.hidden = false;
      box.style.left = `${Math.min(event.clientX + 14, innerWidth - box.offsetWidth - 8)}px`;
      box.style.top = `${Math.max(event.clientY - box.offsetHeight - 10, 8)}px`;
    } else box.hidden = true;
  });
  canvas.addEventListener("pointerdown", (event) => { const [x, y] = at(event); drag = pick(x, y); if (drag) canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener("pointerup", () => { drag = null; });
  canvas.addEventListener("pointerleave", () => { hover = null; hideHint(); });
  canvas.dataset.nodes = nodes.length;
  canvas.dataset.edges = data.edges.length;
  animate(canvas, () => {
    step();
    ctx.clearRect(0, 0, W, H);
    for (const [a, b] of data.edges) {
      const on = hover && (nodes[a] === hover || nodes[b] === hover);
      ctx.strokeStyle = on ? "rgba(28,34,48,.9)" : "rgba(28,34,48,.3)";
      ctx.lineWidth = on ? 1.2 : 0.7;
      ctx.beginPath(); ctx.moveTo(nodes[a].x, nodes[a].y); ctx.lineTo(nodes[b].x, nodes[b].y); ctx.stroke();
    }
    for (const node of nodes) {
      ctx.fillStyle = colorOf(node);
      ctx.beginPath();
      if (node.kind === "minute") ctx.rect(node.x - 4, node.y - 4, 8, 8); else ctx.arc(node.x, node.y, radius(node), 0, 7);
      ctx.fill();
      if (node === hover) { ctx.strokeStyle = "#1c2230"; ctx.lineWidth = 2; ctx.stroke(); }
    }
  });
  return el("section", { class: "viz-card wide", "data-testid": "card-graph" }, el("h2", {}, "Meaning network"),
    el("p", { class: "viz-lead" }, `${data.nodes.filter((n) => n.kind === "sentence").length} sentences and ${data.nodes.filter((n) => n.kind === "minute").length} minutes, linked by neural similarity. Drag to explore.`),
    canvas,
    el("ul", { class: "viz-legend inline" },
      el("li", {}, el("span", { class: "time-ramp graph-ramp" }), "Fewer → more links"),
      el("li", {}, el("span", { class: "dot", style: "background:#e5352b" }), "Flagged sentence"),
      el("li", {}, el("span", { class: "square" }), "Square: minute · Circle: sentence")));
}

function surfaceView(lesson) {
  const data = lesson.analysis?.topics;
  if (!data?.windows?.length) return null;
  const W = 1000, H = 640, N = 36;
  const { canvas, ctx, at } = makeCanvas(W, H, "chart-surface", "Density of lecture minutes on two PCA components");
  const xs = data.windows.map((w) => w.x), ys = data.windows.map((w) => w.y);
  const spread = (v) => { const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(v.length - 1, 1)) || 1; };
  // Silverman bant genisligi: elle ayarlanmaz.
  const hx = spread(xs) * Math.pow(xs.length, -1 / 6), hy = spread(ys) * Math.pow(ys.length, -1 / 6);
  const [x0, x1, y0, y1] = [Math.min(...xs) - 2 * hx, Math.max(...xs) + 2 * hx, Math.min(...ys) - 2 * hy, Math.max(...ys) + 2 * hy];
  const grid = [];
  let peak = 0, mass = 0;
  for (let i = 0; i <= N; i += 1) {
    grid.push([]);
    for (let j = 0; j <= N; j += 1) {
      const gx = x0 + (x1 - x0) * i / N, gy = y0 + (y1 - y0) * j / N;
      let z = 0;
      for (let k = 0; k < xs.length; k += 1) z += Math.exp(-0.5 * (((gx - xs[k]) / hx) ** 2 + ((gy - ys[k]) / hy) ** 2));
      z /= xs.length * 2 * Math.PI * hx * hy;
      grid[i].push(z); peak = Math.max(peak, z); mass += z * ((x1 - x0) / N) * ((y1 - y0) / N);
    }
  }
  canvas.dataset.mass = mass.toFixed(3);
  let yaw = -0.72, pitch = 0.62, dragging = null, idle = true;
  const project = (u, v, h) => {
    const x = (u - 0.5) * 1.5, y = (v - 0.5) * 1.5, z = h;
    const cx = x * Math.cos(yaw) - y * Math.sin(yaw), cy = x * Math.sin(yaw) + y * Math.cos(yaw);
    const py = cy * Math.sin(pitch) - z * Math.cos(pitch);
    const depth = cy * Math.cos(pitch) + z * Math.sin(pitch);
    const scale = 300 / (1 + depth * 0.18);
    return [W / 2 + cx * scale, H * 0.62 + py * scale, depth];
  };
  canvas.addEventListener("pointerdown", (event) => { dragging = at(event); idle = false; canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const [x, y] = at(event);
    yaw += (x - dragging[0]) * 0.008; pitch = Math.max(0.15, Math.min(1.35, pitch + (y - dragging[1]) * 0.006));
    dragging = [x, y];
  });
  canvas.addEventListener("pointerup", () => { dragging = null; });
  const arrow = (from, to, color, label) => {
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(from[0], from[1]); ctx.lineTo(to[0], to[1]); ctx.stroke();
    const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
    ctx.beginPath(); ctx.moveTo(to[0], to[1]); ctx.lineTo(to[0] - 12 * Math.cos(angle - 0.4), to[1] - 12 * Math.sin(angle - 0.4)); ctx.lineTo(to[0] - 12 * Math.cos(angle + 0.4), to[1] - 12 * Math.sin(angle + 0.4)); ctx.fill();
    ctx.fillStyle = "#1c2230"; ctx.font = "italic 17px 'Iowan Old Style',Georgia,serif"; ctx.textAlign = "center";
    ctx.fillText(label, to[0] + 18 * Math.cos(angle), to[1] + 18 * Math.sin(angle) + 5);
  };
  animate(canvas, (_, dt) => {
    if (idle) yaw += Math.min(dt, 50) * 0.00016;
    ctx.clearRect(0, 0, W, H);
    const cells = [];
    for (let i = 0; i < N; i += 1) for (let j = 0; j < N; j += 1) {
      const corners = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]].map(([a, b]) => project(a / N, b / N, grid[a][b] / peak * 0.9));
      cells.push({ corners, depth: corners.reduce((sum, c) => sum + c[2], 0) / 4 });
    }
    cells.sort((a, b) => b.depth - a.depth);
    ctx.lineWidth = 0.7;
    for (const { corners } of cells) {
      ctx.beginPath();
      corners.forEach((c, k) => (k ? ctx.lineTo(c[0], c[1]) : ctx.moveTo(c[0], c[1])));
      ctx.closePath();
      ctx.fillStyle = "#ffffff"; ctx.fill();
      ctx.strokeStyle = "#5a606c"; ctx.stroke();
    }
    const origin = project(0, 0, 0);
    arrow(origin, project(0, 0, 1.05), "#5a606c", "p(PC1, PC2)");
    arrow(origin, project(1.12, 0, 0), "#e0a100", "PC1");
    arrow(origin, project(0, 1.12, 0), "#d9402f", "PC2");
  });
  return el("section", { class: "viz-card wide surface-card", "data-testid": "card-surface" }, el("h2", {}, "Density surface"),
    el("p", { class: "viz-lead" }, `Kernel density of lecture minutes. Drag to rotate. These axes capture only ${Math.round(data.explained.reduce((a, b) => a + b, 0) * 100)}% of word variance.`), canvas);
}

/* Sinir ağının canlı çizimi: değerler gerçek modelden gelir, burada yalnızca son katman yeniden hesaplanır. */
function networkView(lesson) {
  const data = lesson.analysis?.support;
  if (!data?.points?.length || !data.stack) return null;
  const points = [...data.points].sort((a, b) => a.t - b.t);
  let index = points.reduce((best, point, i) => (point.score < points[best].score ? i : best), 0);
  let timer = null;
  const W = 1000, H = 430;
  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "viz-svg nn-svg", role: "img", "aria-label": "Neural network activations for the selected sentence" });
  const text = (x, y, value, cls = "nn-label", anchor = "middle") => { const node = svg("text", { x, y, class: cls, "text-anchor": anchor }); node.textContent = value; chart.append(node); return node; };
  const edge = (x1, y1, x2, y2, width = 1.5, color = "#9aa6ba") => { const line = svg("path", { d: `M${x1} ${y1} C${(x1 + x2) / 2} ${y1} ${(x1 + x2) / 2} ${y2} ${x2} ${y2}`, class: "nn-edge", fill: "none", stroke: color, "stroke-width": width }); chart.append(line); return line; };
  const layerStack = (x, y, count, label, sub) => {
    const n = Math.min(count || 6, 12);
    for (let i = 0; i < n; i += 1) chart.append(svg("rect", { x: x + i * 11, y, width: 8, height: 150, rx: 2, class: "nn-layer", style: `animation-delay:${i * 90}ms` }));
    text(x + n * 5.5, y - 26, label, "nn-title");
    text(x + n * 5.5, y - 9, sub, "nn-sub");
    return { left: x, right: x + n * 11 - 3, mid: y + 75 };
  };
  const models = data.models || {};
  const embed = models.gomme || {}, nli = models.nli || {};
  chart.append(svg("rect", { x: 14, y: 100, width: 112, height: 44, rx: 4, class: "nn-box" }), svg("rect", { x: 14, y: 310, width: 112, height: 44, rx: 4, class: "nn-box" }));
  text(70, 127, "Note sentence", "nn-title"); text(70, 337, "Lecture text", "nn-title");
  const miniStack = layerStack(190, 130, embed.katman, embed.ad || "Embedding model", `${embed.katman ?? "?"} layers, ${embed.boyut ?? "?"} dim`);
  const nliStack = layerStack(440, 130, nli.katman, nli.ad || "NLI model", `${nli.katman ?? "?"} layers, ${nli.boyut ?? "?"} dim`);
  const flow = [edge(126, 122, miniStack.left, miniStack.mid), edge(126, 332, miniStack.left, miniStack.mid), edge(miniStack.right, miniStack.mid, nliStack.left, nliStack.mid)];
  const simValue = text((miniStack.right + nliStack.left) / 2, miniStack.mid - 10, "", "nn-value");
  text((miniStack.right + nliStack.left) / 2, miniStack.mid + 22, "top 3 passages", "nn-sub");
  const beta = data.stack.beta, mean = data.stack.mean, sd = data.stack.sd;
  const nodes = [
    { key: "overlap", label: "Word overlap", y: 340, weight: beta[1], m: mean[0], s: sd[0], from: [126, 332] },
    { key: "ent", label: "Entailment", y: 150, weight: beta[2], m: mean[1], s: sd[1], from: [nliStack.right, nliStack.mid] },
    { key: "neutral", label: "Neutral", y: 245, weight: beta[3], m: mean[2], s: sd[2], from: [nliStack.right, nliStack.mid] },
  ];
  const NX = 690, OX = 880, OY = 225;
  const contraEdge = edge(nliStack.right, nliStack.mid, NX - 16, 60, 1, "#cfc9ba");
  contraEdge.classList.add("nn-off");
  chart.append(svg("circle", { cx: NX, cy: 60, r: 16, class: "nn-node nn-off" }));
  const contraValue = text(NX, 64, "", "nn-node-value");
  text(NX, 34, "Contradiction (dropped by BIC)", "nn-sub");
  for (const node of nodes) {
    flow.push(edge(node.from[0], node.from[1], NX - 16, node.y));
    node.edge = edge(NX + 16, node.y, OX - 26, OY, Math.max(1.5, Math.abs(node.weight) * 2.6), node.weight >= 0 ? "#2a78d6" : "#eb6834");
    flow.push(node.edge);
    node.circle = svg("circle", { cx: NX, cy: node.y, r: 16, class: "nn-node" });
    chart.append(node.circle);
    node.value = text(NX, node.y + 4, "", "nn-node-value");
    text(NX, node.y - 24, node.label, "nn-sub");
    node.contribution = text((NX + OX) / 2, (node.y + OY) / 2 - 8, "", "nn-value");
  }
  const output = svg("circle", { cx: OX, cy: OY, r: 26, class: "nn-node nn-output" });
  chart.append(output);
  const outputValue = text(OX, OY + 5, "", "nn-output-value");
  text(OX, OY - 38, "Logistic neuron", "nn-title");
  const verdict = text(OX, OY + 50, "", "nn-sub");
  const formula = text(OX, OY + 68, `intercept ${beta[0].toLocaleString("en-US")}`, "nn-sub");
  formula.setAttribute("data-testid", "nn-formula");

  const sentence = el("div", { class: "nn-sentence", "data-testid": "nn-sentence" });
  const slider = el("input", { type: "range", min: 0, max: points.length - 1, value: index, class: "nn-slider", "data-testid": "nn-slider", "aria-label": "Select sentence", oninput: (e) => { stop(); show(Number(e.target.value)); } });
  const play = el("button", { type: "button", "data-testid": "nn-play", onclick: () => (timer ? stop() : start()) }, "Play");
  const worst = el("button", { type: "button", "data-testid": "nn-worst", onclick: () => { stop(); show(points.reduce((best, point, i) => (point.score < points[best].score ? i : best), 0)); } }, "Lowest score");

  function show(i) {
    index = i;
    const point = points[i];
    slider.value = i;
    let total = beta[0];
    for (const node of nodes) {
      const value = point[node.key];
      const part = node.weight * (value - node.m) / node.s;
      total += part;
      node.value.textContent = value.toLocaleString("en-US", { maximumFractionDigits: 2 });
      node.circle.style.fill = `rgba(42,120,214,${0.08 + value * 0.72})`;
      node.contribution.textContent = `${part >= 0 ? "+" : ""}${part.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    }
    contraValue.textContent = (point.contra ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
    simValue.textContent = `similarity ${(point.sim ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    const low = point.score <= data.cutoff;
    outputValue.textContent = total.toLocaleString("en-US", { maximumFractionDigits: 2 });
    outputValue.dataset.total = total;
    outputValue.dataset.stored = point.score;
    output.classList.toggle("nn-flag", low);
    verdict.textContent = low ? "⚠ Flagged" : "Not flagged";
    sentence.replaceChildren(el("span", { class: "nn-when" }, `${i + 1}/${points.length} · ${clock(point.t)}`), el("span", {}, point.text));
    for (const listener of nnListeners) listener(point);
    for (const line of flow) { line.classList.remove("nn-pulse"); void line.getBoundingClientRect(); line.classList.add("nn-pulse"); }
  }
  function start() {
    play.textContent = "Pause";
    chart.classList.add("nn-running");
    timer = setInterval(() => {
      if (!document.body.contains(chart)) return stop();
      show((index + 1) % points.length);
    }, 1400);
  }
  function stop() { clearInterval(timer); timer = null; play.textContent = "Play"; chart.classList.remove("nn-running"); }
  show(index);
  return el("section", { class: "viz-card wide nn-card", "data-testid": "chart-network" },
    el("h2", {}, "Live scoring network"),
    el("p", { class: "viz-lead" }, `Final neuron with its real weights, scored live. Line width shows weight; numbers show this sentence's contribution.`),
    el("div", { class: "nn-controls" }, play, worst, slider), sentence, chart);
}

function mlpView(lesson) {
  const data = lesson.analysis?.coverage_models?.mlp;
  if (!data) return null;
  const [w, b, v, b2] = [data.w.slice(0, data.hidden), data.w.slice(data.hidden, data.hidden * 2), data.w.slice(data.hidden * 2, data.hidden * 3), data.w[data.hidden * 3]];
  const W = 620, H = 300, X = [90, 310, 530], YH = data.hidden === 1 ? [150] : Array.from({ length: data.hidden }, (_, i) => 70 + i * (160 / Math.max(data.hidden - 1, 1)));
  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "viz-svg nn-svg", role: "img", "aria-label": "All neurons of the regression network" });
  const text = (x, y, value, cls = "nn-label") => { const node = svg("text", { x, y, class: cls, "text-anchor": "middle" }); node.textContent = value; chart.append(node); return node; };
  const colorOf = (value) => (value >= 0 ? "#2a78d6" : "#eb6834");
  const fmt = (value) => value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  YH.forEach((y, i) => {
    chart.append(svg("line", { x1: X[0], y1: 150, x2: X[1], y2: y, stroke: colorOf(w[i]), "stroke-width": Math.min(1 + Math.abs(w[i]) * 2, 8), class: "nn-edge nn-pulse" }),
      svg("line", { x1: X[1], y1: y, x2: X[2], y2: 150, stroke: colorOf(v[i]), "stroke-width": Math.min(1 + Math.abs(v[i]) * 2, 8), class: "nn-edge nn-pulse" }));
    text((X[0] + X[1]) / 2, (150 + y) / 2 - 8, fmt(w[i]), "nn-value");
    text((X[1] + X[2]) / 2, (150 + y) / 2 - 8, fmt(v[i]), "nn-value");
  });
  const inputNode = svg("circle", { cx: X[0], cy: 150, r: 24, class: "nn-node" });
  const inputValue = (chart.append(inputNode), text(X[0], 155, "", "nn-node-value"));
  text(X[0], 112, "Input: log(words)", "nn-sub");
  const hidden = YH.map((y, i) => {
    const circle = svg("circle", { cx: X[1], cy: y, r: 24, class: "nn-node" });
    chart.append(circle);
    const value = text(X[1], y + 5, "", "nn-node-value");
    text(X[1], y + 42, `tanh, bias ${fmt(b[i])}`, "nn-sub");
    return { circle, value };
  });
  const outNode = svg("circle", { cx: X[2], cy: 150, r: 24, class: "nn-node nn-output" });
  chart.append(outNode);
  const outValue = text(X[2], 155, "", "nn-output-value");
  text(X[2], 112, `Output, bias ${fmt(b2)}`, "nn-sub");
  const readout = el("div", { class: "nn-sentence", "data-testid": "mlp-readout" });
  const slider = el("input", { type: "range", min: Math.log(data.xmin), max: Math.log(data.xmax), step: 0.01, value: Math.log((data.xmin + data.xmax) / 2), class: "nn-slider", "data-testid": "mlp-slider", "aria-label": "Words spoken", oninput: () => update() });
  function update() {
    const lx = Number(slider.value);
    const z = (lx - data.mu) / data.sd;
    let y = b2;
    hidden.forEach((node, i) => {
      const a = Math.tanh(z * w[i] + b[i]);
      y += a * v[i];
      node.value.textContent = fmt(a);
      node.circle.style.fill = a >= 0 ? `rgba(42,120,214,${0.08 + Math.abs(a) * 0.6})` : `rgba(235,104,52,${0.08 + Math.abs(a) * 0.6})`;
    });
    inputValue.textContent = fmt(lx);
    outValue.textContent = fmt(y);
    readout.dataset.words = Math.exp(lx);
    readout.dataset.predicted = Math.exp(y);
    readout.textContent = `${Math.round(Math.exp(lx))} words spoken → about ${Math.round(Math.exp(y))} words in the note.`;
  }
  update();
  return el("section", { class: "viz-card nn-card", "data-testid": "chart-mlp" }, el("h2", {}, "Regression network"),
    el("p", { class: "viz-lead" }, `All ${data.w.length} weights, trained on this lecture. ${data.daicc == null ? "Too few sections for AICc." : `ΔAICc ${data.daicc.toLocaleString("en-US")} against the best model.`}`),
    el("div", { class: "nn-controls" }, slider), readout, chart);
}

function regressionView(lesson) {
  const data = lesson.analysis?.coverage;
  const models = lesson.analysis?.coverage_models;
  if (!data || !models?.curves?.length) return null;
  const card = el("section", { class: "viz-card wide", "data-testid": "chart-regression" }, el("h2", {}, "Regression models"),
    el("p", { class: "viz-lead" }, `Each point is a note section. Best fit: ${modelName(models.best)}. ΔAICc under 2 is not a meaningful difference.`));
  const W = 1000, H = 380, L = 56, R = 16, T = 14, B = 46;
  const points = data.sections.map((s) => [s.lecture_words, Math.max(s.note_words, 1)]);
  const all = [...points, ...models.curves.flatMap((c) => c.points)];
  const lx = (v) => Math.log(Math.max(v, 1));
  const [x0, x1] = [Math.min(...all.map((p) => lx(p[0]))), Math.max(...all.map((p) => lx(p[0])))];
  const [y0, y1] = [Math.min(...all.map((p) => lx(p[1]))), Math.max(...all.map((p) => lx(p[1])))];
  const sx = (v) => L + 10 + (lx(v) - x0) / ((x1 - x0) || 1) * (W - L - R - 20);
  const sy = (v) => H - B - 10 - (lx(v) - y0) / ((y1 - y0) || 1) * (H - T - B - 20);
  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "viz-svg", role: "img", "aria-label": "Regression model comparison" });
  for (const tick of [5, 10, 20, 50, 100, 200, 500, 1000, 2000]) {
    if (lx(tick) >= x0 && lx(tick) <= x1) { const label = svg("text", { x: sx(tick), y: H - B + 20, class: "axis-text", "text-anchor": "middle" }); label.textContent = tick; chart.append(svg("line", { x1: sx(tick), x2: sx(tick), y1: T, y2: H - B, class: "grid-line" }), label); }
    if (lx(tick) >= y0 && lx(tick) <= y1) { const label = svg("text", { x: L - 8, y: sy(tick) + 4, class: "axis-text", "text-anchor": "end" }); label.textContent = tick; chart.append(svg("line", { x1: L, x2: W - R, y1: sy(tick), y2: sy(tick), class: "grid-line" }), label); }
  }
  const xTitle = svg("text", { x: (L + W - R) / 2, y: H - 6, class: "axis-text", "text-anchor": "middle" }); xTitle.textContent = "Words spoken (log scale)";
  const yTitle = svg("text", { x: 14, y: (T + H - B) / 2, class: "axis-text", "text-anchor": "middle", transform: `rotate(-90 14 ${(T + H - B) / 2})` }); yTitle.textContent = "Words in note (log scale)";
  chart.append(xTitle, yTitle);
  models.curves.forEach((curve, index) => chart.append(svg("polyline", { points: curve.points.map((p) => `${sx(p[0])},${sy(p[1])}`).join(" "), fill: "none", stroke: TOPIC_COLORS[index % TOPIC_COLORS.length], "stroke-width": 2 })));
  for (const section of data.sections) {
    const cx = sx(section.lecture_words), cy = sy(Math.max(section.note_words, 1));
    chart.append(hint(svg("g", { "data-seek": section.t, class: "viz-mark" }, svg("circle", { cx, cy, r: 11, fill: "transparent" }),
      svg("circle", { cx, cy, r: section.short ? 7 : 5, fill: section.short ? "#b56a00" : "#1c2230", stroke: "#fff", "stroke-width": 2 })),
      `${clock(section.t)} · ${section.title}: ${section.lecture_words} spoken, ${section.note_words} in note${section.short ? " · looks short" : ""}`));
  }
  const short = data.sections.filter((section) => section.short);
  if (short.length) card.append(el("ul", { class: "viz-list", "data-testid": "short-sections" }, short.map((section) => el("li", {}, stampButton(clock(section.t), clock(section.t), true), ` ${section.title} looks short. Compare with the audio; this is not proof of an error.`))));
  card.append(chart, el("ul", { class: "viz-legend inline" }, models.curves.map((curve, index) => el("li", {},
    el("span", { class: "key-swatch", style: `background:${TOPIC_COLORS[index % TOPIC_COLORS.length]}` }), `${modelName(curve.name)}`, el("span", { class: "muted" }, curve.daicc == null ? " ΔAICc n/a" : ` ΔAICc ${curve.daicc.toLocaleString("en-US")}`)))));
  card.append(tableView("Model comparison", ["Model", "ΔAICc", "ΔBIC", "LOO error"], models.table.map((row) => [modelName(row.model), row.aicc == null ? "n/a" : String(row.aicc), row.bic == null ? "n/a" : String(row.bic), row.loo == null ? "n/a" : String(row.loo)])));
  return card;
}

/* Her ders kendi verisinden uretilen ayni kart seti. */
function analysisCards(lesson) {
  if (!lesson.analysis) return [];
  nnListeners.length = 0;
  const dense = denseNetView(lesson);
  return [lesson.analysis.support ? supportView(lesson) : null, dense, networkView(lesson), graphView(lesson), surfaceView(lesson), neuralChartView(lesson),
    lesson.analysis.topics ? topicsView(lesson) : null, regressionView(lesson), mlpView(lesson), lesson.analysis.topics ? pcaView(lesson) : null,
    lesson.analysis.minutes ? minutesView(lesson) : null].filter(Boolean);
}

let showcaseKey = "";
let showcaseId = null;
let pendingSeek = null;

async function renderShowcase(lessons) {
  const host = document.getElementById("showcase");
  if (!host) return;
  const done = lessons.filter((lesson) => lesson.status === "done" && lesson.quality);
  if (!done.length) { host.hidden = true; showcaseKey = ""; return; }
  const chosen = done.find((lesson) => lesson.id === showcaseId) || done[0];
  showcaseId = chosen.id;
  const key = `${chosen.id}:${chosen.finished}:${chosen.quality.neural}:${chosen.quality.spark?.length || 0}:${done.length}`;
  if (key === showcaseKey) return;
  showcaseKey = key;
  const lesson = await apiJson(`/api/lessons/${chosen.id}`);
  if (key !== showcaseKey || !document.getElementById("showcase")) return;
  const cards = analysisCards(lesson);
  host.hidden = !cards.length;
  const picker = done.length > 1 ? el("select", { class: "showcase-pick", "data-testid": "showcase-pick", "aria-label": "Lecture", onchange: (e) => { showcaseId = Number(e.target.value); showcaseKey = ""; renderShowcase(lessons); } },
    done.map((item) => el("option", { value: item.id, selected: item.id === chosen.id }, item.title))) : null;
  host.replaceChildren(
    el("div", { class: "showcase-head" }, el("div", {}, el("h2", {}, "Analysis"), el("span", { class: "muted", "data-testid": "showcase-title" }, `${lesson.title} · Signals, not proof of accuracy.`)), picker),
    el("div", { class: "map-grid", onclick: (event) => {
      const target = event.target.closest("[data-seek]");
      if (!target) return;
      pendingSeek = Number(target.dataset.seek);
      location.hash = `#/lesson/${lesson.id}`;
    } }, cards));
}

function renderBand(lessons) {
  const host = document.getElementById("quality-band");
  if (!host) return;
  const done = lessons.filter((lesson) => lesson.status === "done" && lesson.timeline?.dur);
  const key = JSON.stringify(done.map((l) => [l.id, l.timeline, l.quality]));
  if (key === bandKey && host.childElementCount) return;
  bandKey = key;
  host.hidden = !done.length;
  if (!done.length) { host.replaceChildren(); return; }
  const minutes = done.reduce((sum, l) => sum + l.timeline.dur, 0) / 60;
  const unclear = done.reduce((sum, l) => sum + (l.timeline.unc?.length || 0), 0);
  const weighted = done.filter((l) => l.quality?.low_share != null);
  const lowShare = weighted.length ? weighted.reduce((sum, l) => sum + l.quality.low_share * l.timeline.dur, 0) / weighted.reduce((sum, l) => sum + l.timeline.dur, 0) : null;
  const checks = done.reduce((sum, l) => sum + (l.quality?.check_sentences || 0), 0);
  const tiles = [bandTile(String(done.length), done.length === 1 ? "lecture" : "lectures"), bandTile(String(Math.round(minutes)), "minutes"), bandTile(String(unclear), "unclear passages")];
  if (lowShare != null) tiles.push(bandTile(`${Math.round(lowShare * 100)}%`, "low-confidence speech", "Whisper estimate, not error rate"));
  else if (checks) tiles.push(bandTile(String(checks), "to check"));
  const rows = done.slice(0, 5).map((lesson) => el("a", { class: "health", href: `#/lesson/${lesson.id}/analysis`, "data-testid": "health-row" },
    el("span", { class: "health-name" }, lesson.title),
    lesson.quality?.spark?.length ? sparkline(lesson.quality.spark) : el("span", { class: "spark-empty" }, lesson.quality ? "Analyzing" : ""),
    el("span", { class: "health-meta" }, [lesson.quality?.low_share != null ? `${Math.round(lesson.quality.low_share * 100)}% low confidence` : null,
      lesson.quality?.short_sections ? `${lesson.quality.short_sections} short` : null, lesson.quality?.check_sentences ? `${lesson.quality.check_sentences} to check` : null].filter(Boolean).join(" · "))));
  const neural = done.filter((lesson) => lesson.quality?.neural);
  const flagged = neural.reduce((sum, lesson) => sum + lesson.quality.check_sentences, 0);
  const neuralRows = neural.flatMap((lesson) => lesson.quality.neural_top.map((item) => el("a", { class: "neural-item", href: `#/lesson/${lesson.id}/analysis`, "data-testid": "neural-item" },
    el("span", { class: "neural-where" }, `${lesson.title} · ${clock(item.t)}`), el("span", { class: "neural-text" }, item.text))));
  const neuralBox = el("div", { class: "band-neural", "data-testid": "neural-panel" },
    el("div", { class: "neural-head" }, el("h2", {}, "Check first"),
      el("span", { class: "neural-count" }, neural.length ? `${flagged} flagged` : "Analyzing")),
    neural.length ? el("div", { class: "neural-grid" }, neuralRows) : null,
    neural.length ? el("p", { class: "band-note neural-note" }, "Flagged does not mean wrong. Compare with the audio.") : null);
  // Site tarafinda bu ozetler yok: bos bolum veya sonsuz "hazirlaniyor" gosterilmez.
  const hasQuality = done.some((lesson) => lesson.quality);
  host.classList.toggle("tiles-only", !hasQuality);
  host.replaceChildren(...[
    el("div", { class: "band-tiles" }, tiles),
    hasQuality ? el("div", { class: "band-col band-health" }, el("h2", {}, "Transcription confidence"), rows) : null,
    hasQuality ? neuralBox : null].filter(Boolean));
}

function renderHome() {
  document.title = "Lecture Notes";
  let searchTimer;
  app.replaceChildren(el("div", { class: "home" },
    el("header", { class: "home-head" }, el("h1", {}, "Library"), el("span", { id: "library-summary", class: "muted" })),
    el("section", { id: "quality-band", class: "band", "data-testid": "quality-band", hidden: true }),
    el("section", { class: "upload-card" }, el("div", { id: "upload-host" })),
    el("div", { class: "filters" },
      el("input", { type: "search", placeholder: "Search titles, notes and transcripts", value: filters.q, "data-testid": "search", oninput: (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { filters.q = e.target.value; refreshList(); }, 250); } }),
      el("select", { id: "course-filter", "data-testid": "course-filter", onchange: (e) => { filters.course = e.target.value; refreshList(); } })),
    el("div", { id: "worker-note", class: "warn", "data-testid": "worker-note", hidden: true }, "The processing Mac is offline. Queued lectures will run when it is back."),
    el("div", { id: "lesson-list", "data-testid": "lesson-list" }),
    el("section", { id: "showcase", class: "showcase", "data-testid": "showcase", hidden: true })));
  renderUploadForm();
  bandKey = "";
  showcaseKey = "";
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
  return el("button", { class: `ts${unclear ? " unclear" : ""}`, type: "button", "data-seek": toSeconds(stamp), title: "Play from here" }, label);
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
  const box = el("aside", { class: "card side", "data-testid": "checklist" }, el("h2", { class: "section" }, `Unclear passages (${lesson.unclear.length})`));
  if (!lesson.unclear.length) box.append(el("div", { class: "muted" }, "No unclear passages."));
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
        verified ? el("span", { class: "check-tag" }, "Unverified") : null,
        el("span", { class: "check-text", title: "Click to expand", onclick: (e) => { e.preventDefault(); e.currentTarget.classList.toggle("open"); } }, text)));
    box.append(row);
  }
  return box;
}

function transcriptView(lesson) {
  const box = el("div", { class: "card", "data-testid": "transcript" });
  const lines = lesson.transcript.split("\n").filter((line) => line.trim());
  if (!lines.length) box.append(el("div", { class: "muted" }, "Transcript not ready."));
  for (const line of lines) {
    const match = /^\[(\d+:\d\d)\]( ⚠)? (.*)$/.exec(line);
    if (!match) continue;
    box.append(el("div", { class: `transcript-line${match[2] ? " low" : ""}`, "data-testid": match[2] ? "low-line" : "line" },
      stampButton(match[1], match[1], false), match[2] ? el("span", { class: "flag" }, "⚠") : null, el("span", {}, match[3])));
  }
  return box;
}

async function download(lesson, format, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Analyzing";
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
  const box = el("div", { class: "pdf-box", "data-testid": "pdf-view" }, el("div", { class: "muted pdf-wait" }, "Preparing PDF."));
  // Once sunucu derlesin: hata olursa tarayicinin bos PDF cercevesi yerine anlasilir mesaj gorunur.
  api(url).then(() => {
    box.replaceChildren(
      el("iframe", { class: "pdf-frame", src: url, title: `${lesson.title} PDF`, "data-testid": "pdf-frame" }),
      el("a", { class: "pdf-open", href: url, target: "_blank", rel: "noopener" }, "Open in a new tab"));
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
  const nav = el("nav", { class: "rail", "data-testid": "rail", "aria-label": "Lecture sections" });
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
      unclear ? el("span", { class: "rail-mark", title: `${unclear} unclear` }, `? ${unclear}`) : null,
      shortAt.has(section.t) ? el("span", { class: "rail-short", title: "Short for its speaking time. Compare with the audio." }, "short") : null);
    nav.append(item);
    reader.rail.push({ item, start: section.t, end: next });
    reader.headings.push(heading || null);
  });
  return nav;
}

function dockView(lesson, timeline) {
  const audio = el("audio", { id: "player", preload: "metadata", src: `/api/lessons/${lesson.id}/audio` });
  const playIcon = el("span", { "aria-hidden": "true" }, "▶");
  const play = el("button", { class: "dock-play", type: "button", "data-testid": "dock-play", "aria-label": "Play", onclick: () => (audio.paused ? audio.play().catch(() => {}) : audio.pause()) }, playIcon);
  const time = el("span", { class: "dock-time", "data-testid": "dock-time" }, `0:00 / ${clock(timeline.dur)}`);
  const ribbon = ribbonView(timeline, { large: true, all: true, testid: "dock-ribbon" });
  const head = el("span", { class: "ribbon-head" });
  ribbon.append(head);
  const speeds = [1, 1.25, 1.5, 1.75, 2];
  const speed = el("button", { class: "dock-btn", type: "button", "data-testid": "dock-speed", title: "Playback speed", onclick: () => {
    const next = speeds[(speeds.indexOf(audio.playbackRate) + 1) % speeds.length] || 1;
    audio.playbackRate = next;
    speed.textContent = `${next.toLocaleString("en-US")}×`;
  } }, "1×");
  const follow = el("button", { class: "dock-btn", type: "button", "data-testid": "dock-follow", "aria-pressed": "false", title: "Keep the playing section in view", onclick: () => {
    reader.follow = !reader.follow;
    follow.setAttribute("aria-pressed", String(reader.follow));
    reader.current = -1;
    sync();
  } }, "Follow");
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
  audio.addEventListener("loadedmetadata", () => {
    if (pendingSeek != null) { audio.currentTime = pendingSeek; pendingSeek = null; }
    sync();
  });
  audio.addEventListener("play", () => { playIcon.textContent = "❚❚"; play.setAttribute("aria-label", "Pause"); });
  audio.addEventListener("pause", () => { playIcon.textContent = "▶"; play.setAttribute("aria-label", "Play"); });
  ribbon.addEventListener("click", (event) => {
    const box = ribbon.getBoundingClientRect();
    audio.currentTime = Math.max(0, Math.min((event.clientX - box.left) / box.width, 1)) * (timeline.dur || total());
    sync();
  });
  const jump = (seconds, label) => el("button", { class: "dock-btn", type: "button", title: `${seconds < 0 ? "Back" : "Forward"} ${Math.abs(seconds)} seconds`, onclick: () => { audio.currentTime = Math.max(0, audio.currentTime + seconds); sync(); } }, label);
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
  const card = el("section", { class: "viz-card", "data-testid": "map-topics" }, el("h2", {}, "Topic flow (K-means)"));
  if (!data) { card.append(el("p", { class: "muted" }, "Too short for topic analysis.")); return card; }
  card.append(el("p", { class: "viz-lead" }, `Minutes grouped into ${data.k} word clusters. Clusters are for navigation and were not validated against note sections.`));
  const duration = data.windows[data.windows.length - 1].t + 60;
  const strip = svg("svg", { viewBox: "0 0 1000 54", class: "topic-strip", role: "img", "aria-label": "Topic clusters by minute" });
  const windows = data.windows;
  windows.forEach((win, index) => {
    const x = win.t / duration * 1000;
    const width = Math.max(((windows[index + 1]?.t ?? duration) - win.t) / duration * 1000 - 2, 1);
    const group = svg("g", { "data-seek": win.t, class: "viz-mark" }, svg("rect", { x, y: 2, width, height: 28, rx: 2, fill: TOPIC_COLORS[win.c] }));
    if (width > 15) { const label = svg("text", { x: x + width / 2, y: 21, class: "strip-label" }); label.textContent = win.c + 1; group.append(label); }
    strip.append(hint(group, `${clock(win.t)} · Cluster ${win.c + 1}: ${data.clusters[win.c].terms.join(", ")}`));
  });
  for (let minute = 0; minute <= duration / 60; minute += 10) {
    const label = svg("text", { x: Math.min(minute * 60 / duration * 1000, 980), y: 51, class: "strip-axis" }); label.textContent = `${minute} min`;
    strip.append(label);
  }
  for (const section of timelineFrom(lesson).sec.filter((item) => item.level === 2)) {
    strip.append(hint(svg("path", { d: `M${section.t / duration * 1000 - 4} 36 l4 -5 l4 5 z`, class: "strip-head" }), `${clock(section.t)} · ${section.title}`));
  }
  const boundary = lesson.analysis.boundary;
  card.append(strip, boundary ? el("p", { class: "muted", "data-testid": "boundary-note" }, boundary.difference < 0 && boundary.p < 0.05
    ? `▲ Main note sections. Word similarity drops at these boundaries (p = ${boundary.p.toLocaleString("en-US")}).`
    : `▲ Main note sections. No clear match with similarity drops (p = ${boundary.p.toLocaleString("en-US")}).`) : el("p", { class: "muted" }, "▲ Main note sections."), el("ul", { class: "viz-legend" }, data.clusters.map((cluster) => el("li", {},
    el("span", { class: "swatch", style: `background:${TOPIC_COLORS[cluster.id]}` }, String(cluster.id + 1)),
    el("span", {}, cluster.terms.join(", ")), el("span", { class: "muted" }, `${cluster.minutes} min`)))));
  card.append(tableView("View as table", ["Minute", "Cluster", "Top words"], windows.map((win) => [clock(win.t), String(win.c + 1), data.clusters[win.c].terms.join(", ")])));
  return card;
}

function pcaView(lesson) {
  const data = lesson.analysis?.topics;
  const card = el("section", { class: "viz-card", "data-testid": "map-pca" }, el("h2", {}, "Word map (PCA)"));
  if (!data) { card.append(el("p", { class: "muted" }, "Too short for this chart.")); return card; }
  const explained = data.explained.reduce((sum, value) => sum + value, 0);
  card.append(el("p", { class: "viz-lead" }, `Each dot is a minute. These axes capture only ${Math.round(explained * 100)}% of word variance.`));
  const W = 560, H = 340, P = 26;
  const xs = data.windows.map((w) => w.x), ys = data.windows.map((w) => w.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sx = (v) => P + (v - x0) / ((x1 - x0) || 1) * (W - 2 * P);
  const sy = (v) => H - P - (v - y0) / ((y1 - y0) || 1) * (H - 2 * P);
  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "viz-svg", role: "img", "aria-label": "Lecture minutes on two PCA components" });
  chart.append(svg("polyline", { points: data.windows.map((w) => `${sx(w.x)},${sy(w.y)}`).join(" "), class: "pca-path" }));
  const last = data.windows[data.windows.length - 1].t || 1;
  for (const win of data.windows) {
    chart.append(hint(svg("g", { "data-seek": win.t, class: "viz-mark" },
      svg("circle", { cx: sx(win.x), cy: sy(win.y), r: 12, fill: "transparent" }),
      svg("circle", { cx: sx(win.x), cy: sy(win.y), r: 5.5, fill: timeColor(win.t / last), stroke: "#fff", "stroke-width": 2 })),
      `${clock(win.t)} · Cluster ${win.c + 1}: ${data.clusters[win.c].terms.join(", ")}`));
  }
  card.append(chart, el("div", { class: "time-legend" }, el("span", {}, "Start"), el("span", { class: "time-ramp", style: `background:linear-gradient(90deg,${TIME_RAMP.join(",")})` }), el("span", {}, "End")));
  return card;
}

const MODEL_NAMES = { "us (log-log)": "power law", dogrusal: "linear", oransal: "proportional", doyumlu: "saturating", "karesel log": "log quadratic", "neural network (MLP)": "neural network (MLP)" };
const modelName = (name) => MODEL_NAMES[name] || name;

function supportView(lesson) {
  const data = lesson.analysis?.support;
  const card = el("section", { class: "viz-card wide", "data-testid": "map-support" }, el("h2", {}, "Check first"));
  if (!data) { card.append(el("p", { class: "muted" }, "Too short for sentence checks.")); return card; }
  card.append(el("p", { class: "viz-lead" }, data.neural
    ? `Lowest-scoring ${data.low.length} of ${data.sentences} sentences. Flagged does not mean wrong; the model can misjudge correct sentences. Compare with the audio.`
    : `Least similar to the lecture among ${data.sentences} sentences. Flagged does not mean wrong.`));
  card.append(el("ol", { class: "support-list" }, data.low.map((item) => el("li", { "data-testid": "support-item" },
    stampButton(clock(item.t), clock(item.t), false),
    el("div", { class: "support-body" }, el("span", {}, item.text),
      item.passage ? el("details", { class: "support-source" }, el("summary", {}, "Closest lecture passage"), el("blockquote", {}, item.passage)) : null)))));
  return card;
}

function modelSentence(model, subject) {
  if (!model) return "";
  if (!model.persistent) return `${subject}: minutes look independent (best model ${model.best}).`;
  const half = model.half_life ? `, AR(1) half-life ${model.half_life.toLocaleString("en-US")} min` : "";
  return `${subject}: persists across minutes (best model ${model.best}${half}).`;
}

function minutesView(lesson) {
  const data = lesson.analysis?.minutes;
  const card = el("section", { class: "viz-card wide", "data-testid": "map-minutes" }, el("h2", {}, "Confidence by minute"));
  if (!data) { card.append(el("p", { class: "muted" }, lesson.analysis?.deep ? "Needs at least 20 minutes." : "Analyzing.")); return card; }
  card.append(el("p", { class: "viz-lead" }, "Share of words Whisper transcribed with low confidence. Check names and numbers in tall bars."));
  const W = 1000, H = 150, L = 40, B = 24, T = 8;
  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "viz-svg", role: "img", "aria-label": "Low-confidence word share per minute" });
  for (const tick of [0, 50, 100]) {
    const y = H - B - tick / 100 * (H - T - B);
    const label = svg("text", { x: L - 8, y: y + 4, class: "axis-text", "text-anchor": "end" }); label.textContent = `${tick}%`;
    chart.append(svg("line", { x1: L, x2: W, y1: y, y2: y, class: "grid-line" }), label);
  }
  const step = (W - L) / data.share.length;
  data.share.forEach((value, minute) => {
    const height = (value ?? 0) * (H - T - B);
    const group = svg("g", { "data-seek": minute * 60, class: "viz-mark" }, svg("rect", { x: L + minute * step, y: T, width: step, height: H - T - B, fill: "transparent" }));
    if (value != null && height > 0) group.append(svg("rect", { x: L + minute * step + 1, y: H - B - height, width: Math.max(step - 2, 1), height, rx: Math.min(2, height / 2), fill: "#2a78d6" }));
    chart.append(hint(group, value == null ? `Minute ${minute}: no speech` : `Minute ${minute}: ${Math.round(value * 100)}% low confidence`));
    if (minute % 10 === 0) { const label = svg("text", { x: L + minute * step, y: H - 6, class: "axis-text" }); label.textContent = `${minute} min`; chart.append(label); }
  });
  card.append(chart);
  const rows = [["Low confidence", data.share_model], ["Words per minute", data.speech_model], ["Topic continuity", data.topic_model]].filter(([, model]) => model);
  card.append(el("ul", { class: "viz-list" }, rows.map(([name, model]) => el("li", {}, modelSentence(model, name)))));
  card.append(tableView("Time series models (AR, MA, AIC)", ["Series", "Best", "AR(1) φ", "MA(1) θ", "AR(∞) approx.", "MA(∞) ψ1–ψ4", "AR(∞) π1–π3 of MA(1)", "Ljung-Box p"],
    rows.map(([name, model]) => [name, model.best, String(model.phi), String(model.theta), model.ar_inf_order ? `AR(${model.ar_inf_order})` : "none", model.ma_inf.join(", "), model.ma1_ar_inf.join(", "), String(model.ljung_box_p)])));
  card.append(tableView("All models (ΔAICc, ΔBIC)", ["Series", "Model", "ΔAICc", "ΔBIC"], rows.flatMap(([name, model]) => model.table.map((row) => [name, row.model, String(row.aicc), String(row.bic)]))));
  return card;
}

function mapView(lesson) {
  const box = el("div", { class: "map", "data-testid": "map" });
  if (!lesson.analysis) { box.append(el("div", { class: "card", "data-testid": "map-empty" }, "Analysis not ready yet.")); return box; }
  const cards = analysisCards(lesson);
  box.append(el("p", { class: "map-note", "data-testid": "map-caveat" }, "Signals, not proof of accuracy. Statistics do not read meaning, and neural checks can be wrong on faulty transcripts. Verify with the audio."),
    cards.length ? el("div", { class: "map-grid" }, cards) : el("div", { class: "card muted", "data-testid": "map-empty" }, "This recording is too short for analysis."));
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
          toast("Note saved.");
          show("note");
        } catch (error) { toast(error.message); save.disabled = false; }
      } }, "Save");
      panel.replaceChildren(el("div", { class: "card" }, area, el("div", { class: "row", style: "margin-top:10px" }, save, el("span", { class: "muted" }, "Markdown and $LaTeX$ are supported."))));
    }
  };
  for (const [key, label] of [["note", "Note"], ["map", "Analysis"], ["pdf", "PDF"], ["edit", "Edit"], ["transcript", "Transcript"]]) {
    tabs.append(el("button", { "data-tab": key, "data-testid": `tab-${key}`, onclick: () => show(key) }, label));
  }
  host.replaceChildren(tabs, panel, dock.node);
  show(currentTab);
}

async function renderLesson(id, tab) {
  currentTab = tab === "analysis" ? "map" : tab || "note";
  const head = el("div", { class: "detail-head" });
  const notices = el("div");
  const body = el("div");
  app.replaceChildren(head, notices, body);
  let shownStatus = null;
  const refresh = async () => {
    const lesson = await apiJson(`/api/lessons/${id}`);
    document.title = `${lesson.title} · Lecture Notes`;
    const actions = el("div", { class: "row" });
    if (lesson.status === "done") {
      for (const format of ["docx", "pdf"]) {
        const button = el("button", { "data-testid": `export-${format}`, onclick: () => download(lesson, format, button) }, `Download ${format.toUpperCase()}`);
        actions.append(button);
      }
      actions.append(el("button", { "data-testid": "regenerate", onclick: async () => {
        if (!confirm("Rewrite this note? Manual edits will not carry over. The current note is backed up.")) return;
        try {
          await apiJson(`/api/lessons/${id}/regenerate`, { method: "POST" });
          shownStatus = null;
          await refresh();
        } catch (error) { toast(error.message); }
      } }, "Rewrite note"));
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
  const match = /^#\/lesson\/(\d+)(?:\/(pdf|analysis))?/.exec(location.hash);
  if (match) renderLesson(Number(match[1]), match[2]);
  else renderHome();
}

window.addEventListener("hashchange", route);
route();

authReady = fetch("/api/auth/status").then((r) => r.json()).then(({ enabled, direct_upload }) => {
  directUpload = Boolean(direct_upload);
  const button = document.getElementById("logout");
  button.hidden = !enabled;
  button.onclick = () => fetch("/api/auth/logout", { method: "POST" }).then(() => location.replace("/login.html"));
}).catch(() => {});
