# Regenerates PROMPTS.md from pipeline.js. Run after any prompt change:  python3 tools/prompts_doc.py
import os, re
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(ROOT + '/supabase/functions/ingest/pipeline.js', encoding='utf8').read()
OWNER = re.search(r'const OWNER = `(.*?)`;', src, re.S).group(1)
def line(name):
    m = re.search(r'const ' + name + r' =\s*\n?\s*((?:`[^`]*`(?:\s*\+\s*\n\s*)?)+);', src)
    return ''.join(re.findall(r'`([^`]*)`', m.group(1)))
OUT_A, OUT_B, OUT_C, STAMP, META, SECTION = (line(n) for n in ('OUT_A', 'OUT_B', 'OUT_C', 'STAMP', 'META_SPEC', 'SECTION_SPEC'))
F = '```'
doc = f'''# Reader：影片分析流程與所有 AI 提示詞

這份文件由 `python3 tools/prompts_doc.py` 從程式產生，列出每一次呼叫 AI 的地方和完整提示詞。要改就告訴我「哪一段要怎麼改」。

## 一、流程

```mermaid
flowchart TD
    A[貼上 YouTube 網址] --> B[讀取影片資訊<br/>標題、頻道、長度，不用 AI]
    B --> C[① 聽寫逐字稿<br/>每 5 分鐘一段]
    C -->|還有下一段| C
    C -->|全部聽完| D[② 整份分析<br/>你的提示詞＋整份逐字稿，一次送出<br/>AI 自己分段，回 A、B、C]
    D --> H([可以閱讀，分析都在了])
    H --> I{{影片是中文？}}
    I -->|否| J[③ 翻譯逐字稿<br/>每批 50 句，背景進行]
    J -->|還有沒翻的| J
    I -->|是| L([完成])
    J --> L
```

| 編號 | 做什麼 | 輸入 | 一支影片呼叫幾次 |
|---|---|---|---|
| ① | 聽寫逐字稿 | 影片本身（5 分鐘片段） | 影片分鐘數 ÷ 5 |
| ② | 整份分析：(A) 第一性原理摘要、(B) 分段整理、(C) 推論強弱檢查 | 整份逐字稿 | 1 |
| ③ | 翻譯成繁體中文（只有非中文影片） | 50 個句子 | 句數 ÷ 50 |

每一步失敗最多重試 3 次。

**超過 100 分鐘的影片例外。** 平台限制每次執行 150 秒，這麼長的影片一次寫不完三份成果。這時改成同時送出：一次寫 (A) 和 (C)（看整份逐字稿），另外每一小時的逐字稿各一次寫 (B)。用的仍然是你的原文，只是每次只附需要的段落。代價是每個整點一定會有一個分段點。

## 二、② 整份分析

下面第一塊是你 2026-11-23 給的提示詞，程式裡一字不差（`tests/fixtures/owner-prompt.txt` 存了你的原文，測試會逐字比對）。

{F}text
{OWNER}
{F}

你的原文到「# 逐字稿」之前為止。程式在後面接上這一段，告訴 AI 怎麼把三份成果放進資料庫要的欄位，然後才是逐字稿：

{F}text
# 輸出
把三份成果放進下面這個 JSON。{OUT_A}{OUT_B}{OUT_C}
JSON：{{{META},"sections":[{SECTION}]}}

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
| sections[].role | 閱讀頁每段的「這一段的作用」，也顯示在總覽的章節清單 |
| sections[].points | 閱讀頁每段的「重點」 |
| sections[].tables | 重點下面的表格 |

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

- **重寫單一段**：某一段的整理失敗或你想重寫時，閱讀頁會出現「整理這一段」。它送出你的寫作規範、步驟三和最後自我檢查，加上那一段的逐字稿。
- **請 AI 解釋這句**（點句子後的面板）：只在 Claude 預覽頁有作用，部署版沒有接上。
'''
open(ROOT + '/PROMPTS.md', 'w', encoding='utf8').write(doc)
print(len(doc))
