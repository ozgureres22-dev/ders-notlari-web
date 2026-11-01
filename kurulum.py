#!/usr/bin/env python3
"""Site kurulumu. Once ../web_ayar.json dosyasini doldur (bkz. README).
  kurulum.py                 R2'yi sinar, CORS ayarlar, mevcut dersleri aktarir, Vercel ayarlarini masaustune yazar
  kurulum.py https://x.vercel.app   Yuklemeyi yalnizca bu site adresine acar"""
import json
import os
import secrets
import sqlite3
import sys
import urllib.error
from pathlib import Path

WEB = Path(__file__).resolve().parent
APP = WEB.parent
sys.path.insert(0, str(WEB / "api"))
from _r2 import R2  # noqa: E402

CONFIG = Path(os.environ.get("DERS_WEB_AYAR") or APP / "web_ayar.json")
OUT = Path(os.environ.get("DERS_WEB_CIKTI") or Path.home() / "Desktop" / "Vercel Ayarları.txt")
ROOT = Path(os.environ.get("DERS_NOTLARI_ROOT") or APP)
PASSWORDS = Path(os.environ.get("DERS_GUVENLIK_DOSYA") or APP / "dashboard" / "guvenlik.json")


def write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(path, 0o600)


def import_local(r2):
    """Bu Mac'te bitmis dersleri siteye aktarir. Daha once aktarilanlara dokunmaz."""
    db = ROOT / "dersler.db"
    if not db.exists():
        return 0
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    count = 0
    for row in conn.execute("SELECT * FROM lessons WHERE status='done'"):
        lesson_id = 10_000_000 + row["id"]  # Sitede uretilen numaralarla cakismaz
        base = f"lessons/{lesson_id}/"
        if r2.exists(base + "meta.json"):
            continue
        slug = row["slug"]
        suffix = Path(row["audio"]).suffix
        files = [(ROOT / "kayitlar" / row["audio"], f"audio{suffix}", "application/octet-stream"),
                 (ROOT / "kayitlar" / ".oynatici" / f"{slug}.mp3", "player.mp3", "audio/mpeg"),
                 (ROOT / "transkriptler" / f"{slug}.txt", "transcript.txt", "text/plain; charset=utf-8"),
                 (ROOT / "transkriptler" / f"{slug}.slaytlar.txt", "slaytlar.txt", "text/plain; charset=utf-8"),
                 (ROOT / "notlar" / f"{slug}.md", "note.md", "text/markdown; charset=utf-8"),
                 (ROOT / "notlar" / f"{slug}.pdf", "note.pdf", "application/pdf"),
                 (ROOT / "notlar" / f"{slug}.docx", "note.docx", "application/octet-stream")]
        for path, name, content_type in files:
            if path.exists():
                r2.put_file(base + name, path, content_type)
        missing_export = not (ROOT / "notlar" / f"{slug}.pdf").exists() or not (ROOT / "notlar" / f"{slug}.docx").exists()
        r2.put(base + "checks.json", row["checks"] or "{}", "application/json")
        meta = {"id": lesson_id, "slug": str(lesson_id), "title": row["title"], "course": row["course"], "audio": f"audio{suffix}",
                "slides": None, "status": "done", "warnings": json.loads(row["warnings"]), "created": row["created"],
                "finished": row["finished"], "needs_export": missing_export}
        r2.put(base + "meta.json", json.dumps(meta, ensure_ascii=False), "application/json")
        count += 1
    return count


def main():
    if not CONFIG.exists():
        write_private(CONFIG, json.dumps({"r2_endpoint": "", "r2_bucket": "", "r2_access_key": "", "r2_secret_key": ""}, indent=1))
        sys.exit(f"Bos ayar dosyasi olusturuldu, doldurup tekrar calistir: {CONFIG}")
    c = json.loads(CONFIG.read_text(encoding="utf-8"))
    if not all(c.get(k) for k in ("r2_endpoint", "r2_bucket", "r2_access_key", "r2_secret_key")):
        sys.exit(f"Ayar dosyasi eksik: {CONFIG}")
    if not PASSWORDS.exists():
        sys.exit("Sifre yok. Once: .venv/bin/python dashboard/sifre_uret.py")
    os.chmod(CONFIG, 0o600)
    r2 = R2(c["r2_endpoint"], c["r2_bucket"], c["r2_access_key"], c["r2_secret_key"])
    probe = f"kurulum-denemesi-{secrets.token_hex(4)}"
    r2.put(probe, "ok", "text/plain")
    assert r2.get_text(probe) == "ok", "R2 yazilan veriyi geri vermedi"
    r2.delete(probe)
    print("R2 baglantisi calisiyor.")
    site = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else None
    try:
        r2.set_cors([site] if site else ["*"])
        print("CORS ayarlandi:", site or "tum adresler. Site adresi belli olunca bu komutu adresle tekrar calistir.")
    except urllib.error.HTTPError as exc:
        if exc.code != 403:
            raise
        # Yalnizca dosya yetkili anahtar kova ayarini degistiremez. Daha guclu anahtar vermek gerekmez.
        policy = [{"AllowedOrigins": [site or "https://ADRESIN.vercel.app"], "AllowedMethods": ["GET", "PUT"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 3600}]
        print("CORS elle ayarlanacak. Site adresi belli olunca Cloudflare > kova > Settings > CORS Policy bolumune sunu yaz:")
        print(json.dumps(policy))
    print("Aktarilan ders:", import_local(r2))
    previous = {}
    if OUT.exists():
        previous = dict(line.split("=", 1) for line in OUT.read_text(encoding="utf-8").splitlines() if "=" in line and line[0].isupper())
    entries = json.loads(PASSWORDS.read_text(encoding="utf-8"))["sifreler"]
    values = {"R2_ENDPOINT": c["r2_endpoint"], "R2_BUCKET": c["r2_bucket"], "R2_ACCESS_KEY": c["r2_access_key"], "R2_SECRET_KEY": c["r2_secret_key"],
              # Ayni oturum anahtari korunur: kurulumu tekrar calistirmak girisleri dusurmesin.
              "SESSION_SECRET": previous.get("SESSION_SECRET") or secrets.token_hex(32),
              "SIFRE_OZETLERI": json.dumps([{"salt": e["salt"], "hash": e["hash"]} for e in entries], separators=(",", ":"))}
    write_private(OUT, "# Vercel > Settings > Environment Variables. Bu dosyayi kimseyle paylasma.\n"
                  + "".join(f"{k}={v}\n" for k, v in values.items()))
    print(f"Vercel ayarlari yazildi: {OUT}")


if __name__ == "__main__":
    main()
