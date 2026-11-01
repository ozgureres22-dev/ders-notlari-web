#!/bin/zsh
# Isciyi Mac her acildiginda arka planda calisacak sekilde kurar. Kaldirmak icin: isci_kur.sh --kaldir
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.dersnotlari.isci"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
if [[ "$1" == "--kaldir" ]]; then rm -f "$PLIST"; echo "Isci kaldirildi."; exit 0; fi
[[ -f "$APP_DIR/web_ayar.json" ]] || { echo "HATA: web_ayar.json yok. Once web/kurulum.py"; exit 1; }
mkdir -p "$APP_DIR/dashboard/logs" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$APP_DIR/.venv/bin/python</string><string>$APP_DIR/web_isci.py</string></array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$APP_DIR/dashboard/logs/isci.log</string>
  <key>StandardErrorPath</key><string>$APP_DIR/dashboard/logs/isci.log</string>
</dict></plist>
PLISTEOF
launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "Isci kuruldu ve calisiyor. Gunluk: dashboard/logs/isci.log"
