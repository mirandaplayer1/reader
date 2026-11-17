# Reader

把看過的影片變成自己的觀點：總覽摘要 → 中英對照逐字稿 → 把畫線連成主張 → 每支影片最多留 3 張觀點卡。

## 結構

- `src/app.html`、`src/style.css`：程式與樣式
- `src/data.js`、`src/chapters.json`：目前內建的一支影片（Lex Fridman Podcast #440）
- `src/config.json`：Supabase 連線設定，空白時資料只存在瀏覽器
- `build.py`：產生 `index.html`（一般網站用）和 `build/artifact.html`（Claude artifact 用）
- `supabase/schema.sql`：同步用的資料表
- `prototypes/`：第一輪的三個概念試作

改完 `src/` 之後執行 `python3 build.py`。

## 貼上網址之後發生什麼

1. 前端呼叫 Supabase 的 `ingest` 函式，一次只做一個單位的工作，做完存檔，再要下一個。任何一步失敗都只重試那一步。
2. 讀影片：把 YouTube 網址交給 Gemini，每 10 分鐘一段，拿回逐字稿和畫面上的文字。有沒有字幕都走這條路。
3. 整理：產生主旨、三個重點、章節摘要和「值不值得細看」。
4. 精讀（按了才做）：程式先斷句，模型只負責翻譯和分析，所以原文不會被改寫。


