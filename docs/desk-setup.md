# 讓一台 Mac 接手 Reader 的分析

在 Mac mini 的終端機照下面做。約 15 分鐘，大部分是等安裝。

## 現在做

1. 抓程式：

   ```
   git clone https://github.com/mirandaplayer1/reader.git ~/Projects/reader
   cd ~/Projects/reader
   ```

   PR 還沒合併的話，多一行：`git checkout desk-claude-analysis`

2. 一支指令裝好全部：

   ```
   sh tools/desk/setup.sh
   ```

   它會依序：裝工具 → 確認 Claude 已登入 → 問 Reader 的信箱和密碼 → 裝排程。
   中途停下來就照它說的補，然後重跑同一行。

3. 讓這台不要睡著：

   ```
   sudo pmset -a sleep 0
   ```

4. 試一支：在手機或電腦的 Reader 貼一個 YouTube 網址，然後看紀錄。

   ```
   tail -f ~/Library/Logs/reader-desk.log
   ```

   兩分鐘內會出現「開始」，做完會出現「可以閱讀了」。

## 先準備好的兩樣

- **Claude Code 已安裝並登入**（<https://claude.com/claude-code>）。執行 `claude`，在裡面打 `/login`。用的是這個帳號的額度。
- **Reader 有設密碼**。沒有的話：打開 Reader 網頁 → 右上角帳號 →「設定密碼」。

## 之後會用到

| 要做什麼 | 指令 |
|---|---|
| 只檢查，不改東西 | `sh tools/desk/setup.sh --check` |
| 程式更新後 | `cd ~/Projects/reader && git pull` |
| 停掉自動接手 | `sh tools/desk/install.sh --remove` |
| 手動跑一輪 | `node tools/desk/worker.mjs` |
| 不碰資料庫試一支 | `node tools/desk/worker.mjs --dry <網址>` |

## 要知道的

- 一次只能有一台接手。兩台都裝排程不會壞（有鎖），但沒必要。
- 這台必須是 M 系列晶片的 Mac。
- 排程跑的是這個資料夾目前的程式。不要在這個資料夾切到別的分支。
- 登入資料存在 `~/.config/reader-desk/`，做到一半的東西存在 `~/.cache/reader-desk/`。都不在 repo 裡。

## 交給 Mac mini 上的 Claude Code 做

在 Mac mini 的 `~/Projects/reader` 開 Claude Code，貼這句：

> 讀 `HANDOFF.md` 和 `docs/desk-setup.md`，執行 `sh tools/desk/setup.sh --check`，告訴我缺什麼，然後帶我一步一步補齊。
