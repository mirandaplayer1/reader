#!/bin/bash
# One-time setup on Miranda's Mac. Run from the repo:  bash tools/local/setup.sh
# 1. asks for the email and password she signs in to the reader with, and keeps the password in the macOS Keychain
# 2. writes ~/.reader-worker.json
# 3. installs a launchd job that runs tools/local/worker.mjs every two minutes while the Mac is awake
# Undo:  launchctl unload ~/Library/LaunchAgents/com.reader.worker.plist && rm ~/Library/LaunchAgents/com.reader.worker.plist
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.reader.worker.plist"
LOG="$HOME/Library/Logs/reader-worker.log"

for c in node yt-dlp ffmpeg claude; do command -v "$c" >/dev/null || { echo "缺少 $c，先裝好再跑一次。"; exit 1; }; done

if [ ! -f "$HOME/.reader-worker.json" ]; then
  read -r -p "登入 Reader 用的 email：" EMAIL
  printf '{"email": "%s", "translate": true}\n' "$EMAIL" > "$HOME/.reader-worker.json"
else
  EMAIL="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).email)' "$HOME/.reader-worker.json")"
fi
read -r -s -p "Reader 的密碼（存進鑰匙圈，不會寫進檔案）：" PW; echo
security add-generic-password -U -s reader-worker -a "$EMAIL" -w "$PW"
unset PW

node "$REPO/tools/local/worker.mjs" --check

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.reader.worker</string>
  <key>ProgramArguments</key><array><string>$(command -v node)</string><string>$REPO/tools/local/worker.mjs</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH</string></dict>
  <key>StartInterval</key><integer>120</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "裝好了。每兩分鐘檢查一次新影片。紀錄在 $LOG"
