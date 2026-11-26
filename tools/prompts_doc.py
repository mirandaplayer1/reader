# Regenerates PROMPTS.md from pipeline.js. Run after any prompt change:  python3 tools/prompts_doc.py
import os, re
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(ROOT + '/supabase/functions/ingest/pipeline.js', encoding='utf8').read()
OWNER = re.search(r'const OWNER = `(.*?)`;', src, re.S).group(1)
def line(name):
    m = re.search(r'const ' + name + r' =\s*\n?\s*((?:`[^`]*`(?:\s*\+\s*\n\s*)?)+);', src)
    return ''.join(re.findall(r'`([^`]*)`', m.group(1)))
OUT_A, OUT_PLAN, OUT_C, STAMP, META, PLAN, BODY = (line(n) for n in ('OUT_A', 'OUT_PLAN', 'OUT_C', 'STAMP', 'META_SPEC', 'PLAN_SPEC', 'BODY'))
SPAN = int(re.search(r'WRITE_SPAN = (\d+) \* 60', src).group(1))
MAX = re.search(r'WRITE_MAX = (\d+)', src).group(1)
PAR = re.search(r'const WRITE_PARALLEL = (\d+)', src).group(1)
F = '```'
doc = f'''# Reader：影片分析流程與所有 AI 提示詞

這份文件由 `python3 tools/prompts_doc.py` 從程式產生，列出每一次呼叫 AI 的地方和完整提示詞。要改就告訴我「哪一段要怎麼改」。

## 一、流程

```mermaid
flowchart TD
    A[貼上 YouTube 網址] --> B[讀取影片資訊<br/>標題、頻道、長度，不用 AI]
    B --> C[① 聽寫逐字稿<br/>每 5 分鐘一段]
    C -->|還有下一段| C
    C -->|全部聽完| D[② 分段和總覽<br/>你的提示詞＋整份逐字稿，一次送出<br/>AI 自己分段，回 A、C 和每段的標題]
    D --> E[②b 寫每一段的整理<br/>幾段一批，同時送出]
    E -->|還有沒寫的段| E
    E --> H([可以閱讀，分析都在了])
    H --> I{{影片是中文？}}
    I -->|否| J[③ 翻譯逐字稿<br/>每批 50 句，背景進行]
    J -->|還有沒翻的| J
    I -->|是| L([完成])
    J --> L
```

| 編號 | 做什麼 | 輸入 | 一支影片呼叫幾次 |
|---|---|---|---|
| ① | 聽寫逐字稿 | 影片本身（5 分鐘片段） | 影片分鐘數 ÷ 5 |
| ② | 分段和總覽：(A) 第一性原理摘要、(C) 推論強弱檢查、(B) 每段從哪裡開始和標題 | 整份逐字稿 | 1 |
| ②b | (B) 每一段的整理全文 | 那幾段的逐字稿，加上 (A) 和全部的分段 | 段數 ÷ 2 左右 |
| ③ | 翻譯成繁體中文（只有非中文影片） | 50 個句子 | 句數 ÷ 50 |

每一步失敗最多重試 3 次。

**為什麼 (B) 分開寫。** 平台限制每次執行 150 秒。一支一小時的影片，三份成果全部寫出來大約一萬個 token，一次寫完會超過時間。所以第一次只讓 AI 讀整份逐字稿、決定怎麼分段、寫 (A) 和 (C)；每段的整理接著分批寫，每批最多 {MAX} 段、{SPAN} 分鐘逐字稿，一次同時送 {PAR} 批。分段仍然是 AI 看過整份逐字稿後照你的步驟三決定的，不管影片多長都一樣。某一批一直失敗時，其他段照樣寫好、影片照樣可以讀，那一段之後在背景用「重寫單一段」補上。

## 二、② 分段和總覽

下面第一塊是你 2026-11-23 給的提示詞，程式裡一字不差（`tests/fixtures/owner-prompt.txt` 存了你的原文，測試會逐字比對）。

{F}text
{OWNER}
{F}

你的原文到「# 逐字稿」之前為止。程式在後面接上這一段，告訴 AI 這一次交哪些、怎麼放進資料庫要的欄位，然後才是逐字稿：

{F}text
# 輸出
這一次先交 (A)、(C) 和 (B) 的分段。(B) 每一段的整理全文下一步才寫，這一次每段只要開始的秒數和標題，但分段要照步驟三的判斷切好。{OUT_A}{OUT_PLAN}{OUT_C}
JSON：{{{META},"sections":[{PLAN}]}}

# 逐字稿
{STAMP}
<transcript>
{{[秒數] 講者: 內容，一行一段}}
</transcript>
{F}

分幾段、切在哪、每段叫什麼，都由 AI 依你的步驟三決定。程式沒有另外給分段或標題的規則。

欄位對應到畫面：

| 欄位 | 畫面上的位置 |
|---|---|
| headline | 總覽最上面的大字 |
| principle | 總覽「第一性原理」 |
| groups | 總覽的各個主題區塊 |
| reminder | 總覽「核心提醒」 |
| check | 總覽「推論強弱檢查」的四類 |
| sections[].title | 章節標題 |
| sections[].body | 每段的整理全文（下一步 ②b 寫）。顯示在總覽的「分段整理」和閱讀頁每段逐字稿下面 |

### ②b 每一段的整理

用的是你原文裡的寫作規範、步驟三和最後自我檢查，一字不改，加上已經寫好的 (A) 標題和第一性原理、整支影片的分段清單，和這一批那幾段的逐字稿：

{F}text
# 任務
分析下方的逐字稿，產出 (B) 分段整理。整支影片已經依主題轉折分好段，(A) 第一性原理摘要也寫好了，都附在下面，讓你知道整體論證。這一次只寫指定的 {{段數}} 段，分段和標題照給定的，不要改。

{{你的「# 寫作規範」}}

{{你的「# 步驟三」}}

{{你的「# 最後自我檢查」}}

# 輸出
每一段是 sections 裡的一項，t 照抄給定的秒數，{BODY}
JSON：{{"sections":[{{"t":<這一段給定的秒數>,"body":"<這一段的整理全文>"}}]}}

# 整支影片的 (A) 第一性原理摘要
{{headline}}
{{principle}}

# 整支影片的分段
1. [秒數] 標題
…

# 這一次要寫的逐字稿
{STAMP}
<transcript>
## 第 N 段（t = 秒數）：標題
{{[秒數] 講者: 內容，一行一段}}
</transcript>
{F}

### 誰寫

Supabase 有設 `ANTHROPIC_API_KEY` 時，② 和 ②b（還有翻譯）由 Claude 寫，模型預設 `claude-sonnet-5-5`，可以用 `CLAUDE_MODEL` 換。沒有設就由 Gemini 寫。聽寫 ① 一律是 Gemini，因為只有它能直接看 YouTube 影片。

## 三、① 聽寫逐字稿

{F}text
Transcribe the speech in this video clip verbatim, in the language spoken. The clip is the part of the video from {{開始}} to {{結束}}.
Return JSON only: {{"turns":[{{"ts":"MM:SS","speaker":"name","text":"..."}}],"visuals":[{{"ts":"MM:SS","text":"..."}}],"reached_end":true|false}}
- "ts" is the timestamp in the FULL video (not relative to the clip) where the turn starts, as MM:SS, or H:MM:SS past one hour.
- Start a new turn at every speaker change and at least every 30 seconds.
- Transcribe everything that is said from the first second of the clip to the last. Do not skip, shorten, summarise or translate.
- "speaker": the person's real name if it is said or shown; otherwise "Speaker 1", "Speaker 2".
- "visuals": text or figures on slides, whiteboards, code or screen recordings that carry information the speech does not say aloud. Empty array if none.
- If a stretch has no speech but shows something (slides, a demo, a scene), add a turn with speaker "On screen" whose text quotes any visible text exactly and then says in one plain sentence what happens.
- "reached_end" is true only if the video itself finishes before {{結束}}.
{F}

## 四、③ 翻譯

{F}text
把下面 {{句數}} 個句子翻成繁體中文（台灣用語）。它們是同一段訪談或演講裡連續的句子。
輸出 JSON：{{"zh":["<第 1 句的翻譯>", ...]}}，陣列長度必須剛好是 {{句數}}，順序一一對應。
規則：
- 忠於原意，不要加原文沒有的內容，不要省略。
- 翻成台灣人講話的樣子，像好的字幕。原文是口語就翻口語，短句就翻短句。
- 不要書面連接詞（透過、藉由、進而、然而、此外），不要把動詞翻成名詞（「進行了討論」寫成「聊了」）。
- 產品名、人名、技術名詞保留原文。「you know」「I mean」這類贅字可以順掉。

這一章的主題：{{分段標題}}

1. {{句子}}
…
{F}

## 五、不在自動流程裡的

- **重寫單一段**：某一段的整理失敗或你想重寫時，閱讀頁會出現「整理這一段」。它送出你的寫作規範、步驟三和最後自我檢查，加上那一段的逐字稿，回來的一樣是那一段的整理全文。
- **請 AI 解釋這句**（點句子後的面板）：只在 Claude 預覽頁有作用，部署版沒有接上。
'''
open(ROOT + '/PROMPTS.md', 'w', encoding='utf8').write(doc)
print(len(doc))
