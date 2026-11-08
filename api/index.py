"""Vercel'de calisan site arka yuzu. Ses islemez: dersleri R2'ye koyar, Mac'teki web_isci.py isler."""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import parse_qsl, quote, urlencode, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.responses import JSONResponse, RedirectResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402

import _notes as notes  # noqa: E402
from _r2 import R2  # noqa: E402

AUDIO_EXT = {".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".opus", ".aiff", ".wma", ".mp4", ".mov", ".webm"}
SLIDE_EXT = {".pdf", ".pptx"}
ACTIVE = ("converting", "transcribing", "writing", "verifying")
COOKIE = "ders_oturum"
SESSION_SECONDS = 30 * 24 * 3600
WORKER_TIMEOUT = int(os.environ.get("DERS_WEB_WORKER_TIMEOUT", "150"))
PUBLIC_PATHS = {"/api/health", "/api/auth/status", "/api/auth/login", "/api/auth/logout"}
REQUIRED_ENV = ("R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY", "R2_SECRET_KEY", "SESSION_SECRET", "SIFRE_OZETLERI")

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


def configured():
    return all(os.environ.get(name) for name in REQUIRED_ENV)


def store():
    return R2(os.environ["R2_ENDPOINT"], os.environ["R2_BUCKET"], os.environ["R2_ACCESS_KEY"], os.environ["R2_SECRET_KEY"])


def normalize(password):
    # Dosyadan satirin tamami ("3. abcd-...") kopyalansa da calissin.
    text = re.sub(r"^\s*\d+[.)]\s*", "", str(password or ""))
    return re.sub(r"[\s\-]", "", text).lower()


def entries():
    return json.loads(os.environ["SIFRE_OZETLERI"])


def make_session(entry):
    payload = f"{entry}.{int(time.time()) + SESSION_SECONDS}"
    return f"{payload}.{hmac.new(os.environ['SESSION_SECRET'].encode(), payload.encode(), hashlib.sha256).hexdigest()}"


def session_valid(token):
    """Oturum imzali cerezdedir. Sifre listeden cikarilinca onunla acilan oturum da biter."""
    try:
        entry, expires, signature = str(token).split(".")
        expected = hmac.new(os.environ["SESSION_SECRET"].encode(), f"{entry}.{expires}".encode(), hashlib.sha256).hexdigest()
        return (hmac.compare_digest(signature, expected) and int(expires) > time.time()
                and any(e["salt"] == entry for e in entries()))
    except (ValueError, KeyError, TypeError):
        return False


# Site sahibinin istegiyle gecici olarak kapali. Acmak icin False yap veya bu commit'i geri al.
SITE_CLOSED = True


@app.middleware("http")
async def guard(request: Request, call_next):
    if SITE_CLOSED:
        return JSONResponse({"detail": "Error 404 :(((("}, status_code=404, headers={"Cache-Control": "no-store"})
    path = request.url.path
    host = request.headers.get("host")
    origin = request.headers.get("origin")
    if request.method not in ("GET", "HEAD") and origin and urlsplit(origin).netloc != host:
        return JSONResponse({"detail": "Bu kaynaktan istek kabul edilmiyor."}, status_code=403)
    if path.startswith("/api/") and path not in PUBLIC_PATHS:
        # Ayar eksikse site korumasiz acilmaz.
        if not configured():
            return JSONResponse({"detail": "Site is not configured."}, status_code=503)
        if not session_valid(request.cookies.get(COOKIE)):
            return JSONResponse({"detail": "Sign in required."}, status_code=401)
    response = await call_next(request)
    response.headers["X-Robots-Tag"] = "noindex, nofollow"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "no-store"
    return response


class RestoreRoute:
    """Vercel her istegi /api/index olarak iletir, asil yol __route parametresinde gelir (bkz. vercel.json).
    Yol, oturum kontrolunden once geri yazilir: kontrol her zaman gercek yola bakar."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            pairs = parse_qsl(scope.get("query_string", b"").decode(), keep_blank_values=True)
            route = next((v for k, v in pairs if k == "__route"), None)
            if route is not None:
                path = "/api/" + route.lstrip("/")
                scope = {**scope, "path": path, "raw_path": quote(path).encode(),
                         "query_string": urlencode([(k, v) for k, v in pairs if k != "__route"]).encode()}
        await self.inner(scope, receive, send)


app.add_middleware(RestoreRoute)


class LoginBody(BaseModel):
    password: str


@app.get("/api/health")
def health():
    return {"app": "ders-notlari", "configured": configured()}


@app.get("/api/auth/status")
def auth_status(request: Request):
    return {"enabled": True, "direct_upload": True, "logged_in": configured() and session_valid(request.cookies.get(COOKIE))}


@app.post("/api/auth/login")
def login(body: LoginBody, request: Request):
    if not configured():
        raise HTTPException(503, "Site is not configured.")
    # Ilk eslesmede durulmaz: sure hangi sifreye yakin olundugunu belli etmesin.
    matched = None
    text = normalize(body.password).encode()
    for entry in entries():
        digest = hashlib.scrypt(text, salt=bytes.fromhex(entry["salt"]), n=2 ** 14, r=8, p=1).hex()
        if hmac.compare_digest(digest, entry["hash"]):
            matched = entry
    if not matched:
        raise HTTPException(401, "Incorrect password.")
    response = JSONResponse({"ok": True})
    response.set_cookie(COOKIE, make_session(matched["salt"]), max_age=SESSION_SECONDS, httponly=True, samesite="lax",
                        secure=not (request.headers.get("host") or "").startswith(("127.0.0.1", "localhost")))
    return response


@app.post("/api/auth/logout")
def logout():
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE)
    return response


def key(lesson_id, name):
    return f"lessons/{lesson_id}/{name}"


def read_meta(r2, lesson_id):
    data = r2.get(key(lesson_id, "meta.json"))
    return json.loads(data) if data else None


def write_meta(r2, meta):
    r2.put(key(meta["id"], "meta.json"), json.dumps(meta, ensure_ascii=False), "application/json")


def get_lesson(r2, lesson_id):
    meta = read_meta(r2, lesson_id)
    if not meta:
        raise HTTPException(404, "Lecture not found.")
    return meta


def all_lessons(r2):
    _, prefixes = r2.list("lessons/", "/")
    ids = [p.split("/")[1] for p in prefixes if p.split("/")[1].isdigit()]
    with ThreadPoolExecutor(12) as pool:
        metas = list(pool.map(lambda i: read_meta(r2, i), ids))
    return [m for m in metas if m and m["status"] != "uploading"]


def worker_online(r2):
    data = r2.get("worker.json")
    return bool(data) and time.time() - json.loads(data)["seen"] < WORKER_TIMEOUT


def positions(lessons):
    waiting = sorted((m for m in lessons if m["status"] == "queued"), key=lambda m: m["created"])
    busy = any(m["status"] in ACTIVE for m in lessons)
    return {m["id"]: i + 1 + busy for i, m in enumerate(waiting)}


def public(meta, ranks=None):
    fields = ("id", "slug", "title", "course", "status", "percent", "eta_seconds", "stage_started", "error",
              "error_detail", "created", "finished", "warnings")
    return {**{f: meta.get(f) for f in fields}, "warnings": [notes.english_message(w) for w in meta.get("warnings") or []],
            "error": notes.english_message(meta.get("error")), "quality": meta.get("quality"),
            "has_slides": bool(meta.get("slides")), "queue_position": (ranks or {}).get(meta["id"]),
            "timeline": meta.get("timeline")}


@app.get("/api/lessons")
def list_lessons(course: str = "", q: str = ""):
    r2 = store()
    lessons = all_lessons(r2)
    ranks = positions(lessons)
    courses = sorted({m["course"] for m in lessons})
    shown = [m for m in lessons if not course or m["course"] == course]
    query = q.strip().lower()
    if query:
        def matches(meta):
            if query in meta["title"].lower() or query in meta["course"].lower():
                return True
            return (query in r2.get_text(key(meta["id"], "note.md")).lower()
                    or query in r2.get_text(key(meta["id"], "transcript.txt")).lower())
        with ThreadPoolExecutor(12) as pool:
            shown = [m for m, ok in zip(shown, pool.map(matches, shown)) if ok]
    shown.sort(key=lambda m: m["created"], reverse=True)
    return {"lessons": [public(m, ranks) for m in shown], "courses": courses, "worker_online": worker_online(r2)}


class NewLesson(BaseModel):
    title: str = ""
    course: str = ""
    audio_name: str
    slides_name: str | None = None


@app.post("/api/lessons")
def create_lesson(body: NewLesson):
    audio_ext = Path(body.audio_name).suffix.lower()
    if audio_ext not in AUDIO_EXT:
        raise HTTPException(400, f"Unsupported audio format: {audio_ext or 'unknown'}")
    slide_ext = Path(body.slides_name).suffix.lower() if body.slides_name else ""
    if slide_ext and slide_ext not in SLIDE_EXT:
        raise HTTPException(400, "Slides must be PDF or PPTX.")
    r2 = store()
    lesson_id = int(time.time() * 1000) + secrets.randbelow(1000)
    meta = {"id": lesson_id, "slug": str(lesson_id), "title": body.title.strip() or Path(body.audio_name).stem,
            "course": body.course.strip() or "General", "audio": f"audio{audio_ext}", "slides": f"slides{slide_ext}" if slide_ext else None,
            "status": "uploading", "warnings": [], "created": time.time()}
    write_meta(r2, meta)
    urls = {"id": lesson_id, "audio_url": r2.presign("PUT", key(lesson_id, meta["audio"]), expires=6 * 3600)}
    if slide_ext:
        urls["slides_url"] = r2.presign("PUT", key(lesson_id, meta["slides"]), expires=6 * 3600)
    return urls


@app.post("/api/lessons/{lesson_id}/ready")
def lesson_ready(lesson_id: int):
    r2 = store()
    meta = get_lesson(r2, lesson_id)
    if meta["status"] != "uploading":
        raise HTTPException(409, "This lecture is already queued.")
    if not r2.exists(key(lesson_id, meta["audio"])):
        raise HTTPException(400, "Audio file was not uploaded.")
    meta["status"] = "queued"
    write_meta(r2, meta)
    return public(meta)


def finite(value):
    """Eski analizlerdeki NaN ve sonsuz degerler yanitin JSON'unu bozmasin."""
    if isinstance(value, float):
        return value if value == value and abs(value) != float("inf") else None
    if isinstance(value, dict):
        return {k: finite(v) for k, v in value.items()}
    if isinstance(value, list):
        return [finite(v) for v in value]
    return value


@app.get("/api/lessons/{lesson_id}")
def lesson_detail(lesson_id: int):
    r2 = store()
    meta = get_lesson(r2, lesson_id)
    note = r2.get_text(key(lesson_id, "note.md"))
    checks = json.loads(r2.get_text(key(lesson_id, "checks.json"), "{}"))
    items = [{**item, "checked": bool(checks.get(item["stamp"]))} for item in notes.unclear_items(note)]
    ranks = positions(all_lessons(r2)) if meta["status"] == "queued" else {}
    analysis = r2.get_text(key(lesson_id, "analysis.json"))
    return {**public(meta, ranks), "note": note, "unclear": items, "transcript": r2.get_text(key(lesson_id, "transcript.txt")),
            "analysis": finite(json.loads(analysis)) if analysis else None, "worker_online": worker_online(r2)}


class NoteBody(BaseModel):
    note: str


@app.put("/api/lessons/{lesson_id}/note")
def save_note(lesson_id: int, body: NoteBody):
    r2 = store()
    meta = get_lesson(r2, lesson_id)
    if meta["status"] != "done":
        raise HTTPException(409, "Note not ready.")
    r2.put(key(lesson_id, "note.md"), body.note, "text/markdown; charset=utf-8")
    # PDF ve DOCX'i Mac yeniden uretir. O zamana kadar eski dosya gosterilmez.
    for name in ("note.pdf", "note.docx"):
        r2.delete(key(lesson_id, name))
    meta["needs_export"] = True
    write_meta(r2, meta)
    return lesson_detail(lesson_id)


class CheckBody(BaseModel):
    stamp: str
    checked: bool


@app.put("/api/lessons/{lesson_id}/checks")
def save_check(lesson_id: int, body: CheckBody):
    r2 = store()
    checks = json.loads(r2.get_text(key(lesson_id, "checks.json"), "{}"))
    checks[body.stamp] = body.checked
    r2.put(key(lesson_id, "checks.json"), json.dumps(checks), "application/json")
    return {"ok": True}


@app.post("/api/lessons/{lesson_id}/retry")
def retry(lesson_id: int):
    r2 = store()
    meta = get_lesson(r2, lesson_id)
    if meta["status"] != "failed":
        raise HTTPException(409, "Only failed jobs can be retried.")
    meta.update(status="queued", error=None, error_detail=None)
    write_meta(r2, meta)
    return public(meta)


@app.post("/api/lessons/{lesson_id}/regenerate")
def regenerate(lesson_id: int):
    r2 = store()
    meta = get_lesson(r2, lesson_id)
    if meta["status"] not in ("done", "failed"):
        raise HTTPException(409, "This lecture is being processed.")
    old = r2.get(key(lesson_id, "note.md"))
    if old:
        r2.put(key(lesson_id, f"eski/{int(time.time())}.md"), old, "text/markdown; charset=utf-8")
    r2.put(key(lesson_id, "checks.json"), "{}", "application/json")
    meta.update(status="queued", error=None, error_detail=None, needs_export=False,
                warnings=[w for w in meta.get("warnings", []) if not w.startswith(notes.NOTE_WARNING_PREFIXES)])
    write_meta(r2, meta)
    return public(meta)


@app.get("/api/lessons/{lesson_id}/audio")
def lesson_audio(lesson_id: int):
    r2 = store()
    if not r2.exists(key(lesson_id, "player.mp3")):
        raise HTTPException(404, "Audio not ready.")
    return RedirectResponse(r2.presign("GET", key(lesson_id, "player.mp3")), status_code=307)


@app.get("/api/lessons/{lesson_id}/export/{fmt}")
def export(lesson_id: int, fmt: str, inline: bool = False):
    if fmt not in ("docx", "pdf"):
        raise HTTPException(404, "Unknown format.")
    r2 = store()
    meta = get_lesson(r2, lesson_id)
    if not r2.exists(key(lesson_id, f"note.{fmt}")):
        raise HTTPException(409, f"{fmt.upper()} not ready yet. It is rebuilt after edits when the Mac is online.")
    kind = "inline" if inline else "attachment"
    types = {"pdf": "application/pdf", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
    return RedirectResponse(r2.presign("GET", key(lesson_id, f"note.{fmt}"),
                                       response_content_disposition=f"{kind}; filename*=UTF-8''{quote(meta['title'])}.{fmt}",
                                       response_content_type=types[fmt]), status_code=307)


# Vercel'de public/ klasorunu platform sunar. Bu blok yalnizca yerel testler icindir.
if os.environ.get("DERS_WEB_STATIC"):
    app.mount("/", StaticFiles(directory=os.environ["DERS_WEB_STATIC"], html=True), name="static")
