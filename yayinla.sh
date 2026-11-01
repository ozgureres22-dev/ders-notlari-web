#!/bin/zsh
# web/ klasorunu GitHub'a gonderir. Kullanim: yayinla.sh https://github.com/KULLANICI/DEPO.git
cd "$(dirname "$0")" || exit 1
../.venv/bin/python paket.py || exit 1
[[ -d .git ]] || git init -q -b main
if [[ -n "$1" ]]; then
  git remote remove origin 2>/dev/null
  git remote add origin "$1"
fi
if ! git remote get-url origin >/dev/null 2>&1; then
  echo "HATA: Depo adresi yok. Kullanim: web/yayinla.sh https://github.com/KULLANICI/DEPO.git"; exit 1
fi
# Git'te ad tanimli degilse yalnizca bu depo icin bir ad kullanilir.
git config user.name >/dev/null || git config user.name "Ders Notlari"
git config user.email >/dev/null || git config user.email "ders-notlari@users.noreply.github.com"
git add -A
if git diff --cached --quiet; then
  echo "Yeni degisiklik yok."
else
  git commit -q -m "Ders Notlari sitesini guncelle

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" || { echo "HATA: Commit yapilamadi."; exit 1; }
fi
git push -u origin main && echo "GitHub'a gonderildi."
