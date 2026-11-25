#!/bin/sh
# Makes this Mac look for queued Reader videos every two minutes while it is on (a per-user launchd job).
#   sh tools/desk/install.sh             install or update
#   sh tools/desk/install.sh --remove    stop and remove
# Log: ~/Library/Logs/reader-desk.log
set -e
LABEL=com.reader.desk
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [ "$1" = "--remove" ]; then rm -f "$PLIST"; echo "已移除，桌機不會再自動接手。"; exit 0; fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "找不到 $1，請先安裝。"; exit 1; }; }
need node; need yt-dlp; need ffmpeg; need mlx_whisper
NODE="$(command -v node)"
CLAUDE="$HOME/.local/bin/claude"; [ -x "$CLAUDE" ] || CLAUDE="$(command -v claude)"
[ -x "$CLAUDE" ] || { echo "找不到 claude 指令。"; exit 1; }
BIN="$(dirname "$(command -v yt-dlp)"):$(dirname "$(command -v mlx_whisper)"):$(dirname "$(command -v ffmpeg)"):$(dirname "$NODE")"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$ROOT/tools/desk/worker.mjs</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartInterval</key><integer>120</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$BIN:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <key>READER_DESK_CLAUDE</key><string>$CLAUDE</string>
  </dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/reader-desk.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/reader-desk.log</string>
</dict></plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "裝好了。桌機開著時每 2 分鐘看一次有沒有新影片。"
echo "紀錄：$HOME/Library/Logs/reader-desk.log"
[ -f "$HOME/.config/reader-desk/session.json" ] || echo "還沒登入：請執行 node tools/desk/login.mjs"
