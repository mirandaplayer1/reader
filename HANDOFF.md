# 交接紀錄

每次收工更新這一頁。最新的放最上面，舊的可以刪。規則見 `CLAUDE.md`。

## 目前狀態（2026-11-23，雲端 agent 交給本機 Claude Code CLI）

Miranda 決定之後由本機的 Claude Code CLI 接手。雲端這邊的每小時排程已停用，不會再自己動 repo 或 Notion。

| | 狀態 |
|---|---|
| 前端 | `main` 是最新，已上線。最後合併的是 PR #26 |
| 後端 | Edge function `ingest` **第 13 版**（2026-11-23，commit `02d209c` 的內容）。repo 裡的 `supabase/functions/ingest/` 就是部署的版本 |
| 資料庫 | 跟 `supabase/schema.sql` 一致，沒有待套用的變更 |
| 測試 | 五組全過（見 `CLAUDE.md` 的測試一節） |
| 沒推上去的東西 | 沒有 |

### 本機第一次開工要準備的

1. `git clone` 後 `git pull`，在自己的分支上做（不要用 `claude/adoring-archimedes-j4jyrr`，那是雲端的分支）。
2. UI 測試要 Playwright：`npm i -D playwright && npx playwright install chromium`（雲端環境是預裝的，repo 裡沒有 `package.json`）。
3. 要部署後端才需要 Supabase CLI：`supabase login`，之後照 `CLAUDE.md` 的部署指令。只改前端不用。
4. 要讀寫 Notion backlog 需要 Notion 的 MCP 連接器。沒有的話請 Miranda 把要做的項目貼給你。
5. 測試帳號 `e2e-test@reader.invalid` 的密碼不在 repo 裡。要用真影片驗證提示詞時，請 Miranda 在 Supabase 後台重設一組，自己存在本機，不要 commit。

### Backlog 在 Notion

流程寫在 `CLAUDE.md` 的「Backlog」一節。在 CLI 裡打 `/backlog` 會照那個流程跑一輪。

目前各項的狀態：

| 項目 | Status | 說明 |
|---|---|---|
| P0 設計檢查（12 條） | Done | PR #25 |
| P1 章節目錄、拿掉「第 N 段，共 M 段」 | Done | PR #25 |
| P2 筆記入口跟著閱讀位置 | Done | PR #25 |
| P3 記住讀到哪、清單顯示進度 | Done | PR #25 |
| P4 行寬、講者名 | Done | PR #25 |
| **P5 把口語畫線整理成一句話** | **To Be Approved** | **唯一的待辦。等 Miranda 看提示詞草稿** |
| P6 相近的舊卡片 | Done | PR #25 |
| P7 回顧舊卡片、P8 先想再看 | Closed | 她不要 |

### P5 要怎麼做（她把 Status 改回 Not started 之後）

提示詞草稿在 Notion 的 P5 頁，以她在那頁改過的版本為準。做法：

1. `supabase/functions/ingest/pipeline.js` 加一個常數放提示詞、一個函式（輸入章節標題和畫線文字，回一句話）。
2. `index.ts` 加一個 action（例如 `tidy`），要驗證登入，只吃文字、不讀寫 `videos`。這一步很短，不用動 `NEED`。
3. 前端 `pointSheet()`（`src/app.html`）加一顆「整理成一句話」，結果填進 `#pt-text`，走原本的 `S.edit` 存法，所以「還原原文」已經能用。AI 畫線的卡片（`S.aip`）不需要這顆。
4. `tests/pipeline.test.mjs` 加一個假 AI 的測試；`python3 tools/prompts_doc.py` 重建 `PROMPTS.md`。
5. 先部署後端，再合併前端。部署完在這頁記下 commit 和版本號。

### 最近這幾輪改了什麼（接手時要知道的資料格式）

使用者資料 `reader_state.state`（每人每支影片一列）現在有這些欄位：

| 欄位 | 內容 |
|---|---|
| `hl` | 句子 id → 標記。`y` 畫線、`i` 洞見、`p` 疑問、`g` 要去做 |
| `rng` | 只畫了句子的一部分時的字元範圍，分語言 |
| `memos` | 筆記。`{at,text,ids?,t?,q?}`：有 `ids` 是跟著句子，有 `t` 是跟著章節（秒數），都沒有是整支影片 |
| `aip` | 在 AI 文字上畫的線。`{at,text,src?,note?,t}`，`t` 是章節秒數，總覽的是 `null`。`src` 是改寫前的原文，`paintAI()` 靠它在畫面上標色 |
| `edit` | 逐字稿重點卡片改寫過的文字，鍵是 `"h-"+第一句的 id`。原本的畫線不動 |
| `pos` | 讀到哪。`{t,i,n}`：`t` 是章節秒數（真正的鍵），`i`、`n` 只拿來顯示「3 / 13」 |

卡片盒是另外一列，`video_id="__box__"`，逐張合併同步。

畫面上的名稱：分頁是「總覽／閱讀／畫線／我的卡片」。程式裡仍叫 `points`（畫線頁）和 `views`（卡片頁），沒有改名。

### 逐字稿分段（2026-11-23 稍晚，雲端 agent，Miranda 直接在雲端提的）

AI 聽寫回來的 turn 大約每 20–30 秒切一刀，四成切在句子中間，章節邊界也會。現在**只在顯示時**重組（`paragraphs()`、`leads()`，`src/app.html`）：
段落一律結束在句尾；turn 尾巴沒講完的那句移到下一段開頭；章節尾巴沒講完的句子，把下一章開頭那一句顯示在這一章結尾。
資料和句子 id 都沒動，畫線和筆記不受影響。DOM 上一段可能含好幾個 turn，所以用 `data-turns`（空白分隔）找播放位置。
根本原因在聽寫的提示詞沒有要求 turn 結束在句尾，沒有改（改提示詞要先問她）。

閱讀畫面上方多了「複製逐字稿」（`transcriptText()`）：章節標題加時間，段落跟畫面一樣，語言跟著畫面上的中／中英／EN。畫面描述不複製。

### 總覽和每章分析換成她的新提示詞（2026-11-23 稍晚，雲端 agent，後端第 13 版）

Miranda 給了一份完整的提示詞：(A) 第一性原理摘要、(B) 分段整理、(C) 推論強弱檢查。全文在 `PROMPTS.md`。

- 她的原文拆成 `pipeline.js` 的 `RULES`／`DECOMPOSE`／`BRIEF`／`SECTION`／`CHECK_SPEC`／`SELF_CHECK`，**字句是她的，不要沒問過就改**。我加的只有括號裡的欄位名稱。
- 流程：每支影片都是「切章節 → 總覽」兩步（以前一小時內的影片是一次做完）。總覽那一步（`synth`）寫 A 和 C；每章那一步（`deepenStep`）寫 B，會把總覽的標題和第一性原理附給它，讓它寫「這段在整體論證中的作用」。
- 新的資料格式：`content.brief.check = {solid, assumptions, evidence, contradictions}`；每章 `seg.role`、`seg.points`、`seg.tables[{title,headers,rows[][]}]`、`seg.key`。舊欄位（`sum`／`core`／`chain`／`ask`／`counter`／`spark`）在新分析寫入時刪掉。
- 前端兩種格式都能顯示：有 `role` 或 `points` 就用新版面，否則照舊。舊的「換到你身上」提問在新格式裡沒有了，她以前寫的回答還在（存成筆記，顯示在章末和畫線頁）。
- 切章節、標題（`TITLES`、`STYLE`、`EX_CHAPTER`）和「讀者設定」沒動，只用在切章節。
- 章節的 `worth` 還會產生但畫面不用了。
- **她自己的影片都還是舊格式。** 要變成新格式得用 `reprocess`（mode `text`，不重新聽寫），36 支都要花 API 費用，而且章節會重切。等她決定要重跑哪些。
- 用測試帳號的經濟學第三堂（`ch3kP_Xc34M`）跑過真的 AI，格式正確。

### 已知的問題和還沒做的

- **相近卡片（`nearCards`）只用假資料驗證過。** 用字元 bigram 算重疊，真實卡片多了之後準不準沒看過。門檻在 `src/app.html` 的 `nearCards()`（`n>=3`、`score>=.08`）。
- **讀到哪只在使用者捲動後才寫入。** 舊影片要再打開捲一次才有進度。
- **兩台裝置同時改**：後寫的那台會被要求載入較新的版本，它自己剛改的那一下會被丟掉（會跳提示）。沒有做逐欄合併。`pos` 也走同一條路，所以兩台同時讀同一支影片時，位置會以後寫的為準。
- **新提示詞寫出來的總覽用字偏書面、句子長**（例如「帕雷托最適」「讓渡」）。這是照她的規範寫的結果，要調得改她的原文，先問。
- 經濟學原理第 3–5 堂是舊版分析（沒有新的總覽格式）。重跑要先問她。
- 她原本一則章節回答和一個主張是用舊的章節序號存的，轉換時是猜的，可能對到別章。
- 舊的淬煉和觀點卡的 CSS、`ui.coreOnly`、章節的 `worth` 分級在程式裡還有殘留，畫面上已經不用。可以清。
- `style.css` 後半是一層層疊上去的主題（Paper and wood → Editorial → Stationery → Round 1），後面的蓋前面的。要改外觀從檔案最後面往前找。
- 測試帳號底下有幾列驗證時留下的影片，可以刪，不影響她的資料。
- 研究引用的文獻（Notion 各頁的「依據」）是憑記憶寫的，沒有逐篇上網核對。

### 她的資料現況

- 帳號裡有：經濟學原理（林明仁）5 支、NTU Web Programming 2025 共 28 支（2026-11-23 加入，全部 `ready`）、另外 3 支單獨的影片。
- 不要沒問過就重跑、不要刪。
