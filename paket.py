#!/usr/bin/env python3
"""Arayuzu ve ortak kodu web/ klasorune kopyalar. Tek kaynak dashboard/ klasorudur."""
import shutil
from pathlib import Path

WEB = Path(__file__).resolve().parent
APP = WEB.parent
public = WEB / "public"
shutil.rmtree(public, ignore_errors=True)
shutil.copytree(APP / "dashboard" / "static", public)
(public / "robots.txt").write_text("User-agent: *\nDisallow: /\n")
shutil.copy(APP / "dashboard" / "notes.py", WEB / "api" / "_notes.py")
print(f"Hazir: {public}")
