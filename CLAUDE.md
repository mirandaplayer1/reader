# Reader：給在這個 repo 工作的 agent

Miranda 的個人工具：貼 YouTube 網址 → AI 聽寫、切章節、寫總覽和每章的第一性原理 → 她畫重點、寫筆記、整理成觀點卡。
回覆她用繁體中文，直接、簡潔，不要 AI 腔。

這個 repo 同時有兩個 agent 在改：雲端的 Claude Code（claude.ai/code）和她本機的 Claude Code CLI。
兩邊各有自己的資料夾，**唯一的共用點是 GitHub**。下面的規則是為了讓兩邊不互相蓋掉。

## 開工前、收工後

1. 開工前：`git fetch origin && git status`。落後 `origin/main` 就先 `git pull --rebase origin main`。
2. 讀 `HANDOFF.md`。上一個 agent 做到哪、什麼還沒部署，都寫在那裡。
3. 在自己的分支上做，不要直接推 `main`。合併走 PR。
4. 收工前：跑測試 → commit → push → 更新 `HANDOFF.md`（做了什麼、什麼沒做完、後端部署到哪個 commit）。
   沒推上去的東西，另一個 agent 看不到。

## 產生出來的檔案不要手改

| 檔案 | 來源 | 怎麼重建 |
|---|---|---|
| `index.html`、`build/artifact.html` | `src/app.html`、`src/style.css`、`src/data.js`、`src/chapters.json`、`src/config.json` | `python3 build.py` |
| `PROMPTS.md` | `supabase/functions/ingest/pipeline.js` 裡的提示詞 | `python3 tools/prompts_doc.py` |

這三個檔案合併衝突時不要手動解：解完來源檔的衝突後重建一次。
改了 `src/` 一定要重建並把 `index.html` 一起 commit，GitHub Pages 是直接發佈 `main` 根目錄的 `index.html`。

## 結構

```
src/app.html, src/style.css     前端（單一檔案 app，沒有框架）
build.py                        把 src/ 組成 index.html 和 build/artifact.html
supabase/functions/ingest/
  pipeline.js                   分析流程和所有提示詞。純邏輯，不依賴 Deno，測試直接 import
  index.ts                      Edge function：驗證、鎖、重試、每分鐘的背景排程
supabase/schema.sql             資料表、權限、排程的定義（文件用途，實際變更要另外套用到資料庫）
tools/local/                    Miranda 的 Mac 上跑的處理程式：yt-dlp＋Whisper 聽寫、Claude Code 寫分析、寫回資料庫（launchd 每兩分鐘）
tests/                          測試
tools/prompts_doc.py            重建 PROMPTS.md
PROMPTS.md                      流程圖和每個提示詞的說明，給 Miranda 讀和改
```

## 測試

```bash
node tests/pipeline.test.mjs        # 流程邏輯，AI 是假的。改 pipeline.js 必跑
node tests/ui-flow.test.mjs         # 整個前端流程，後端是假的。需要 Playwright
node tests/ui-highlight.test.mjs    # 選取文字畫重點
node tests/ui-points.test.mjs       # 畫線、筆記、重點頁、觀點、舊資料轉換、兩台裝置不互相覆蓋
node tests/ui-transcript.test.mjs   # 中文影片和未翻譯影片的逐字稿顯示
node tests/local-worker.test.mjs    # Mac 處理程式的純邏輯：Whisper 段落轉 turn、給 Claude Code 的提示詞、回答的檢查
```

UI 測試讀的是建好的 `index.html`，所以先 `python3 build.py`。
這些測試裡的 AI 都是假的，只能證明程式照 AI 的回答正確組裝；提示詞寫得好不好要用真影片跑才知道。

## 部署

- **前端**：合併到 `main` 就上線（GitHub Pages，約一分鐘）。https://mirandaplayer1.github.io/reader/
- **後端**：Supabase 專案 `azgtjxznqdppistljerl`，Edge function `ingest`。**不會跟著 git 自動部署**。
  改了 `supabase/functions/ingest/` 之後要另外部署，兩個檔案（`index.ts`、`pipeline.js`）要一起送：
  `supabase functions deploy ingest --project-ref azgtjxznqdppistljerl`（CLI），或用 Supabase MCP 的 deploy 工具。
  部署完在 `HANDOFF.md` 記下部署的 commit。
- **資料庫**：改欄位或排程要在 Supabase 上執行 SQL，並同步更新 `schema.sql`。

前端和後端有相依時（例如新欄位），先部署後端和資料庫，再合併前端。

## Backlog

Miranda 用 Notion 的 **Dev** 資料庫管要做的事（在她的 Notion：Miranda Home / Dev / Dev，只看 `Project = reader` 的列）。
她用 `Status` 表達決定，不用留言：

| Status | 意思 | 你該做什麼 |
|---|---|---|
| Not started | 她核准了 | 做。開工時改成 In progress |
| To Be Approved | 等她看 | 不要動 |
| In progress | 正在做 | |
| Done | 做完 | 做完改成這個，並在該頁最後加一段「做了什麼、怎麼驗證」 |
| Closed (Not approved) | 她不要 | 不要做，也不要再提 |

- 依標題的 `P` 編號順序做。`Type` 是 `Epic (PRD)` 的列和標題是 `Goal:` 開頭的列是說明，不是待辦。
- 她會自己開新的列寫「設計不好的地方」（截圖加幾條描述，像 `improvement` 那頁）。這種列留在 Not started 就是要做。
- 你自己想到的建議：開新列，`Type = Backlog`、`Project = reader`、`Status = To Be Approved`，寫清楚現在的問題、要改什麼、工作量、取捨。不要直接做。
- 需要新的提示詞：把草稿寫在該頁，`Status` 設 To Be Approved，等她改回 Not started。
- 她判斷建議的標準：一個人能維護、不增加她的操作步驟。會增加步驟的要明講，並設計成不用就不存在。

CLI 裡打 `/backlog` 會照這個流程跑一輪（`.claude/commands/backlog.md`）。

## 不要做的事

- 不要把金鑰寫進 repo 或貼進對話。Gemini 金鑰只存在 Supabase 的 function secret `GEMINI_API_KEY`。
  `src/config.json` 裡的 anon key 是公開的，可以留在 repo。不要使用或要求 service_role key。
- 不要沒問過就重跑 Miranda 的影片。重跑會重做章節和分析、花 API 費用，處理期間影片打不開。
  要驗證提示詞，把逐字稿複製到測試帳號 `e2e-test@reader.invalid` 重跑。
- 不要改 `pipeline.js` 裡的 `OWNER`。那是她自己寫的提示詞，要求一字不差（原文在 `tests/fixtures/owner-prompt.txt`，測試會比對）。
  分段、標題、摘要都由這份提示詞決定，不要另外加規則。要動任何提示詞先問她。
- 不要刪她的資料。

## 幾個容易踩到的地方

- **Edge function 開機 150 秒後會被平台強制關掉**，而且一個 worker 會連續服務好幾個請求。
  所以 `index.ts` 用 `BOOT` 算 worker 的年齡，剩餘時間不夠就不開始新的一步。新增更慢的步驟要調 `NEED`。
- **每一步最多試 3 次**（`MAX_FAILS`），在開始前就計數，被強制關掉的也算。失敗原因記在 `videos.trail`。
- **重試不能造成重複花費**：每一步做完才存檔，重試是重做同一步，不會從頭來。
- **使用者的資料（`reader_state.state`）是整份覆蓋、時間新的贏。** 所以：資料格式的轉換（`upgrade()`、`migrateIds()`）只能在記憶體裡做，
  不可以呼叫 `commit()` 或改 `S.at`，否則一台很久沒開的裝置一打開就會把別台的新內容蓋掉。`push()` 寫入前會先看伺服器上有沒有沒看過的版本。
- 存進使用者資料的鍵不要用章節序號（`c3`）。章節重切後序號會變。用秒數。
- 句子的 id 是 `t{秒數}-{句序}`，使用者的畫線和筆記靠它對應。改切句邏輯（`splitSentences`）會讓既有的畫線對不上。
- 中文影片不翻譯；英文影片先可讀（分析都在了）、再背景翻譯。影片在 `status=ready` 之後 `work.phase` 可能還是 `translate`。

## 查問題

```sql
-- 某支影片卡在哪、失敗過什麼
select status, work->>'phase' as phase, progress, fails, error, attempt, trail, updated_at
from public.videos where video_id = '<id>';
```

Edge function 的紀錄在 Supabase 的 `function_logs`。失敗會印一行 JSON（影片、步驟、花了幾秒、錯誤）。
`Shutdown` 事件的 `reason` 是 `WallClockTime` 就代表被 150 秒上限關掉。
