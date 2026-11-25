#!/bin/sh
# One-time setup of the Mac that does Reader's analysis. Safe to run again.
#   sh tools/desk/setup.sh           install what is missing, sign in to Reader, start the schedule
#   sh tools/desk/setup.sh --check   only report what is missing; changes nothing
set -e
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK=0; [ "$1" = "--check" ] && CHECK=1
have() { command -v "$1" >/dev/null 2>&1; }
ok() { echo "  有  $1"; }
miss() { echo "  缺  $1"; MISSING=1; }
MISSING=0

echo "1. 這台電腦"
[ "$(uname -m)" = "arm64" ] && ok "Apple Silicon" || { miss "Apple Silicon（聽寫用的 mlx_whisper 只能在 M 系列晶片上跑）"; }

echo "2. 工具"
if ! have brew; then miss "Homebrew：到 https://brew.sh 照第一行指令安裝，再重跑這支"; [ $CHECK = 1 ] || exit 1; fi
for p in node yt-dlp ffmpeg uv; do
  if have $p; then ok $p; elif [ $CHECK = 1 ]; then miss $p; else echo "  安裝 $p…"; brew install $p; fi
done
if have mlx_whisper; then ok mlx_whisper; elif [ $CHECK = 1 ]; then miss mlx_whisper; else echo "  安裝 mlx_whisper…"; uv tool install mlx-whisper; fi

echo "3. Claude"
CLAUDE="$HOME/.local/bin/claude"; [ -x "$CLAUDE" ] || CLAUDE="$(command -v claude || true)"
if [ -z "$CLAUDE" ]; then
  miss "claude 指令：先安裝 Claude Code（https://claude.com/claude-code），執行一次 claude 並登入"
  [ $CHECK = 1 ] || exit 1
else
  mkdir -p "$HOME/.cache/reader-desk/neutral"
  if (cd "$HOME/.cache/reader-desk/neutral" && echo 'Reply with the single word: pong' | "$CLAUDE" -p --setting-sources "" --system-prompt "You are a text function." --tools "" --strict-mcp-config --no-session-persistence --model sonnet 2>/dev/null | grep -qi pong); then
    ok "claude 已登入，可以在背景呼叫"
  else
    miss "claude 還沒登入：執行 claude，在裡面打 /login，再重跑這支"
    [ $CHECK = 1 ] || exit 1
  fi
fi

echo "4. Reader 登入"
if [ -f "$HOME/.config/reader-desk/session.json" ]; then ok "已登入"; elif [ $CHECK = 1 ]; then miss "還沒登入（setup 會問信箱和密碼）"; else node "$ROOT/tools/desk/login.mjs"; fi

echo "5. 排程"
if [ $CHECK = 1 ]; then
  launchctl print "gui/$(id -u)/com.reader.desk" >/dev/null 2>&1 && ok "已安裝" || miss "還沒安裝"
  [ $MISSING = 0 ] && echo "都好了。" || echo "有缺的。執行 sh tools/desk/setup.sh 補齊。"
  exit 0
fi
sh "$ROOT/tools/desk/install.sh"

echo "6. 不要讓這台睡著（睡著就不會接手）"
echo "  目前設定：$(pmset -g | awk '/^ sleep/{print $2}') 分鐘後睡眠（0 = 不睡）"
echo "  要改成不睡：sudo pmset -a sleep 0"
echo
echo "完成。第一次遇到沒字幕的影片會先下載聽寫模型（約 1.6 GB），會慢幾分鐘。"
echo "看紀錄：tail -f ~/Library/Logs/reader-desk.log"
