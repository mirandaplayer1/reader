---
description: 看 Notion 的 Dev backlog，把 Miranda 核准的項目做完
---

照 `CLAUDE.md` 的「Backlog」和「開工前、收工後」兩節跑一輪：

1. `git fetch origin && git status`，落後 `origin/main` 就先對齊。讀 `HANDOFF.md`。
2. 用 Notion 連接器查 Dev 資料庫裡 `Project = reader` 的每一列，列出 Status。沒有 Notion 連接器就停下來，請 Miranda 把要做的項目貼給你。
3. `Status = Not started` 而且是待辦的列：改成 In progress，依 `P` 編號順序實作。讀那一頁的全文和留言，她可能改過內容。
4. 每一項：改 `src/` → `python3 build.py` → 跑全部測試 → 手機和桌機截圖確認 → commit → push → 開 PR 合併到 `main`。動到 `supabase/functions/ingest/` 要另外部署，而且先部署後端再合併前端。
5. 做完把該列改成 Done，在頁面最後加一段「做了什麼、怎麼驗證」。更新 `HANDOFF.md`。
6. 沒有 Not started 的項目就回一行「沒有待辦」，不要自己找事做。有想到的建議照 `CLAUDE.md` 開成 To Be Approved 的列。

不要改既有提示詞的寫法、不要重跑她的影片、不要刪她的資料。

$ARGUMENTS
