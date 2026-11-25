# 交接紀錄

每次收工更新這一頁。最新的放最上面，舊的可以刪。規則見 `CLAUDE.md`。

## 2026-11-25：分析搬到桌機，用 Miranda 的 Claude 帳號寫（本機 CLI）

分支 `desk-claude-analysis`，**還沒合併**。合併後網頁才會改走桌機。

還要做的，照順序（**跑分析的是 Miranda 的 Mac mini，不是寫這段程式的那台筆電**）：

1. 在 Mac mini 上照 `docs/desk-setup.md` 做：clone、`git checkout desk-claude-analysis`、`sh tools/desk/setup.sh`。
2. 用一支真影片從頭跑到尾（排隊 → ready → 翻譯完）。到這裡才算驗證過寫資料庫那一段。
   合併前網頁還是舊的，貼網址會走 Gemini。所以這一步要嘛先合併，要嘛在 Mac mini 上手動排一支：請 Mac mini 上的 Claude Code 用 `tools/desk/supa.mjs` 插一列 `status = desk`。
3. 合併 PR。前端才會顯示「等桌機接手」、每段的第一性原理和名詞。
4. Mac mini 上 `git checkout main && git pull`，之後都留在 `main`。

筆電上沒有登入 Reader，也沒有裝排程，只有 `~/.cache/reader-desk/` 裡試跑留下的檔案。

做了什麼：

- 新流程在 `tools/desk/`：抓字幕（`yt-dlp`）→ 沒有字幕才下載聲音用 Whisper 聽寫 → 沒標點就請 Claude 補 → Claude 寫整份分析 → 可以閱讀 → 非中文再翻譯。全文在 `PROMPTS.md` 前半。
- 網頁在桌機模式（`src/config.json` 的 `"ingest":"desk"`）不再呼叫後端的 `start`／`step`／`reprocess`，只把列設成 `status = desk`。
- 每段多兩個欄位：`segs[].principle`（這一段的第一性原理）和 `segs[].terms[{term,note}]`（名詞說明）。顯示在閱讀頁每段整理的下面。這兩段提示詞是新寫的，在 `tools/desk/prompts.mjs` 的 `SECTION_EXTRA`，等她看。
- 「只重做章節和摘要」在桌機模式會保留原本的逐字稿和翻譯，只請 Claude 重寫分析。她舊的 Gemini 影片可以這樣一支一支換成新格式。
- 後端沒有動、沒有部署。`pipeline.js` 只多匯出 `OWNER` 和 `translatePrompt` 給桌機用。

驗證到哪：

- 七組測試全過（原本五組加 `desk.test.mjs`、`ui-desk.test.mjs`）。
- 真的跑過一支：Steve Jobs 史丹佛演講（`UF8uR6Z6KLc`，15 分鐘，有字幕），`--dry` 模式，不到 2 分鐘寫完 8 段。
- 從 macOS 排程裡呼叫 `claude -p` 可以用她的登入（試過一次性的工作）。
- 也真的跑過沒字幕的：經濟學原理第 3 堂（`ch3kP_Xc34M`，90 分鐘，中文），`--dry` 模式，共 13 分鐘（聽寫 6.5、補標點 1.5、分析 4.5），14 段。補標點 2188 行裡 7 行沒過比對、保留原樣。
- Whisper 會聽錯人名（Acemoglu 聽成 Asimoglu、Kenneth Arrow 聽成 Ken Aero）。Miranda 2026-11-25 決定：分析和名詞說明裡寫正確的名字，名詞說明最後註明「逐字稿寫成 ○○」。逐字稿本身不改。同一堂課重跑驗證過，19 個名字更正了。
- **沒試過的**：寫回資料庫（要她先登入）、英文字幕沒標點時的補標點、翻譯跑真的影片。

知道的限制：

- 沒有講者、沒有投影片上的字。
- 桌機關著或睡著就不會動，影片會停在「等桌機接手」。
- worker 跑的是桌機上這個資料夾目前 checkout 的程式。切到別的分支，排程跑的就是那個分支的版本。
- 用的是她 Claude 訂閱的額度。分析用 CLI 的預設模型，補標點和翻譯用 Sonnet（`READER_DESK_MODEL`、`READER_DESK_FAST_MODEL` 可以改）。
- `docs/claude-analysis.md` 那條手動的路（`reader_apply_analysis`）不會存 `principle` 和 `terms`。

## 2026-11-23 晚：分析改由 Claude 寫，分段整理改成自由格式

- Miranda 決定：影片的分析預設由 Claude 寫再寫回資料庫，Gemini 只當備援。做法在 `docs/claude-analysis.md`。
  寫回用資料庫函式 `public.reader_apply_analysis`（定義在 `supabase/schema.sql` 最後，已套用到資料庫）。
- 分段整理 (B) 的格式換了：每段是一塊自由格式的文字 `segs[].body`（段落、粗體、條列、編號、表格），
  不再拆成 `role`／`points`／`tables`。舊格式畫面仍會顯示。總覽的「分段整理」直接列出每段全文。
- **後端沒有重新部署**：repo 的 `pipeline.js` 已經改成要 AI 回 `body`，也多了 `work.given`，但部署的還是第 15 版（回 `role`／`points`）。
  Gemini 的預付額度 2026-11-23 用完了，儲值前部署了也跑不動。儲值後要部署並用測試帳號跑一支真影片。
- 她的影片有哪些已經由 Claude 寫過：`select video_id, work->>'by', content->'segs'->0 ? 'body' from public.videos`。
  `by = claude` 且第一段有 `body` 的是新格式；有 `by` 沒 `body` 的是舊格式，要重寫分段整理（只送 `sections`）。

## 目前狀態（2026-11-23，雲端 agent 交給本機 Claude Code CLI）

Miranda 決定之後由本機的 Claude Code CLI 接手。雲端這邊的每小時排程已停用，不會再自己動 repo 或 Notion。

| | 狀態 |
|---|---|
| 前端 | `main` 是最新，已上線。最後合併的是 PR #26 |
| 後端 | Edge function `ingest` **第 15 版**（2026-11-23，commit `1f36622` 的內容）。repo 裡的 `supabase/functions/ingest/` 就是部署的版本。**第 15 版還沒用真的 AI 跑過**，見下面 |
| 資料庫 | 跟 `supabase/schema.sql` 一致，沒有待套用的變更 |
| 後端（更新） | 見上面一節：repo 比部署的第 15 版新 |
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

- 她的原文拆成 `pipeline.js` 的 `RULES`／`DECOMPOSE`／`BRIEF`／`SECTION`／`CHECK_SPEC`／`SELF_CHECK`，**跟她的原文一字不差，不要改**。她明確要求過「不要做修改」。原文存在 `tests/fixtures/owner-prompt.txt`，`pipeline.test.mjs` 會逐字比對。欄位對應寫在每次呼叫的「# 輸出」段，不放進她的文字。
- 第 14 版另外拿掉了章節的 `take`（總覽每章下面那行「→ …」，她說分段摘要不需要洞見）。總覽的章節清單在該章分析完成後顯示 `role`，還沒完成或舊影片顯示 `sum`。每章的 `key` 也不再產生。
- 流程：每支影片都是「切章節 → 總覽」兩步（以前一小時內的影片是一次做完）。總覽那一步（`synth`）寫 A 和 C；每章那一步（`deepenStep`）寫 B，會把總覽的標題和第一性原理附給它，讓它寫「這段在整體論證中的作用」。
- 新的資料格式：`content.brief.check = {solid, assumptions, evidence, contradictions}`；每章 `seg.role`、`seg.points`、`seg.tables[{title,headers,rows[][]}]`、`seg.key`。舊欄位（`sum`／`core`／`chain`／`ask`／`counter`／`spark`）在新分析寫入時刪掉。
- 前端兩種格式都能顯示：有 `role` 或 `points` 就用新版面，否則照舊。舊的「換到你身上」提問在新格式裡沒有了，她以前寫的回答還在（存成筆記，顯示在章末和畫線頁）。
- 切章節、標題（`TITLES`、`STYLE`、`EX_CHAPTER`）和「讀者設定」沒動，只用在切章節。
- 章節的 `worth` 還會產生但畫面不用了。
- **她自己的影片都還是舊格式。** 要變成新格式得用 `reprocess`（mode `text`，不重新聽寫），36 支都要花 API 費用，而且章節會重切。等她決定要重跑哪些。
- 用測試帳號的經濟學第三堂（`ch3kP_Xc34M`）跑過真的 AI，格式正確。

### 第 15 版：整份分析一次送出（2026-11-23 深夜，雲端 agent）

**先看這個：Gemini 的預付額度在 2026-11-23 13:40 UTC 用完了。** 之後每次呼叫都回 `Your prepayment credits are depleted`。Miranda 要到 AI Studio 加值才能繼續。在那之前新增或重跑影片都會失敗 3 次後停下。

Miranda 的三個要求，這一版一起做：
1. 分段摘要要用她的提示詞、一字不改。
2. 章節標題不要「概念：例子」那個格式（她的新提示詞沒有這條）。
3. 不要先分章節再分開送，**整份逐字稿一次送，讓 AI 自己判斷分段**。重跑不該花十幾分鐘。

現在的流程（`pipeline.js` 的 `outline` 階段）：
- `OWNER` 常數是她的提示詞全文，到「# 逐字稿」之前為止，**一字不差，不要改**（`tests/fixtures/owner-prompt.txt` 是她的原文，測試逐字比對）。
- 100 分鐘以內的影片：一次呼叫。`OWNER` ＋「# 輸出」（哪個標題放哪個 JSON 欄位）＋ 整份帶時間的逐字稿。回來的 `sections[]`（`t`、`title`、`role`、`points`、`tables`）直接變成章節，全部 `deep: true`，影片一變成 `ready` 分析就都在了。
- 超過 100 分鐘：同一步裡同時送出「(A)+(C) 看整份」和「每小時一份 (B)」。原因是平台 150 秒上限，一次寫不完。代價是每個整點一定有一個分段點（舊的 seams 重切拿掉了）。
- `TITLES`、`STYLE`、`EX_CHAPTER`、讀者設定、章節的 `sum`／`take`／`worth` 評分、`seams` 和 `synth` 階段都刪了。`analyse` 階段還在，但只有舊資料或手動重寫單一段才會用到。
- 英文影片：分析寫完後背景只剩翻譯（`translate`）。
- `index.ts`：背景 worker 壽命用完而還有工作時，會自己叫一個新的 worker（`relay()`，每個 worker 最多一次、沒做事的不叫），不用等下一分鐘的排程。
- 前端：章節清單不再有「精讀這一章／看原文」和灰掉的章節；打開的影片每 10 秒看一次背景進度（`watchNotes`）。

**沒驗證的事（額度回來後要做）：**
- 用測試帳號各跑一支短的（`UF8uR6Z6KLc`，15 分鐘）和一支 90 分鐘的（`ch3kP_Xc34M`），看：一次呼叫要幾秒、會不會超過 150 秒、`sections` 的 `t` 有沒有對到逐字稿的行、分段數合不合理。這兩支現在卡在 `processing`／失敗狀態，重跑即可。
- `ONE_REQUEST = 100 分鐘` 是估的，沒有量過。如果 90 分鐘的影片單次呼叫超過 ~115 秒，要把門檻調低，或把 `NEED.outline` 以外的東西再檢查一次。
- 長影片那條路（同時 5 個呼叫）有沒有撞到 Gemini 的速率限制。
- Miranda 的 Garry Tan（`eRrc1pUY5oU`）在第 14 版重跑到一半額度用完，現在是舊標題格式、11 章只有 4 章有整理。額度回來後請她再按一次「只重做章節和摘要」。

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
