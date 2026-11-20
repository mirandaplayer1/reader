# Regenerates PROMPTS.md from pipeline.js. Run after any prompt change:  python3 tools/prompts_doc.py
import os
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import re
src=open(ROOT+'/supabase/functions/ingest/pipeline.js',encoding='utf8').read()
def const(name):
    m=re.search(r'const '+name+r' = `(.*?)`;',src,re.S);return m.group(1)
STYLE,EXC,EXA,TIT,BRIEF=const('STYLE'),const('EX_CHAPTER'),const('EX_ANALYSIS'),const('TITLES'),const('BRIEF')
F='```'
doc=f'''# Reader：影片分析流程與所有 AI 提示詞

這份文件列出目前每一次呼叫 AI 的地方和完整提示詞。要改的話，直接在這份文件上改，或告訴我「第幾號提示詞要怎麼改」。

- 模型：`gemini-3.8-flash`（讀影片和文字階段都是）
- 程式位置：`supabase/functions/ingest/pipeline.js`
- `{{大括號}}` 是程式會填進去的變數

## 一、流程圖

```mermaid
flowchart TD
    A[貼上 YouTube 網址] --> B[讀取影片資訊<br/>標題、頻道、影片長度<br/>不用 AI 生成]
    B --> C[① 聽寫逐字稿<br/>每 5 分鐘一段，逐段送影片給 AI]
    C -->|還有下一段| C
    C -->|全部聽完| D{{影片超過 1 小時？}}
    D -->|否| E[② 切章節＋整支摘要<br/>一次完成]
    D -->|是| F[③ 每 1 小時逐字稿切一次章節]
    F -->|還有下一小時| F
    F --> S[③b 整點接縫重切<br/>每個整點前後兩章合起來，只照內容重新切]
    S -->|還有下一個整點| S
    S --> G[④ 寫整支影片的總覽<br/>並重新評每章的重要程度]
    E --> H([可以閱讀])
    G --> H
    H --> I{{影片是中文？}}
    I -->|否| J[⑤ 翻譯<br/>每批 50 句，一次送 3 批]
    J -->|還有沒翻的| J
    I -->|是| K
    J --> K[⑥ 每章的摘要＋第一性原理<br/>一次處理 3 章]
    K -->|還有沒做的章| K
    K --> L([全部完成])
```

每一步失敗最多重試 3 次。①到④失敗 3 次，影片標成失敗；⑤⑥失敗 3 次只停掉背景工作，影片仍可閱讀。

| 編號 | 做什麼 | 輸入 | 一支影片呼叫幾次 |
|---|---|---|---|
| ① | 聽寫逐字稿 | 影片本身（5 分鐘片段） | 影片分鐘數 ÷ 5 |
| ② | 切章節＋整支摘要（1 小時內的影片） | 完整逐字稿 | 1 |
| ③ | 切章節（超過 1 小時的影片） | 1 小時的逐字稿 | 影片小時數 |
| ③b | 整點接縫重切（超過 1 小時的影片） | 整點前後兩章的逐字稿 | 影片小時數 − 1 |
| ④ | 整支總覽（超過 1 小時的影片） | 章節清單＋完整逐字稿 | 1 |
| ⑤ | 翻譯成繁體中文 | 50 個句子 | 句數 ÷ 50 |
| ⑥ | 每章摘要＋第一性原理 | 一章的逐字稿 | 章數 |

另外有三個「使用者按了才跑」的提示詞（⑦⑧⑨），列在最後。

## 二、共用的寫法規則

②③④⑥ 都會附上這一段「怎麼寫」。改這裡會同時影響章節標題、摘要、第一性原理。

### 寫法規則（STYLE）

{F}text
{STYLE}
{F}

### 章節用的好壞對照（EX_CHAPTER）— 用在 ②③④

{F}text
{EXC}
{F}

### 第一性原理用的好壞對照（EX_ANALYSIS）— 用在 ⑥

{F}text
{EXA}
{F}

### 標題怎麼下（TITLES）— 用在 ②③③b

這是你提供的標題規則，原文放入。

{F}text
{TIT}
{F}

### 讀者設定 — 用在 ②③④⑥

{F}text
一位正在找 product-market fit 的一人創業者
{F}

## 三、各階段提示詞

### ① 聽寫逐字稿

送出的內容：影片的一個 5 分鐘片段 ＋ 下面這段文字。溫度設為 0（盡量照實聽寫）。

{F}text
Transcribe the speech in this video clip verbatim, in the language spoken. The clip is the part of the video from {{片段開始時間}} to {{片段結束時間}}.
Return JSON only: {{"turns":[{{"ts":"MM:SS","speaker":"name","text":"..."}}],"visuals":[{{"ts":"MM:SS","text":"..."}}],"reached_end":true|false}}
- "ts" is the timestamp in the FULL video (not relative to the clip) where the turn starts, as MM:SS, or H:MM:SS past one hour.
- Start a new turn at every speaker change and at least every 30 seconds.
- Transcribe everything that is said from the first second of the clip to the last. Do not skip, shorten, summarise or translate.
- "speaker": the person's real name if it is said or shown; otherwise "Speaker 1", "Speaker 2". Speakers already identified earlier in this video: {{前面已出現的講者名字}}. Reuse these exact labels for the same people.
- "visuals": text or figures on slides, whiteboards, code or screen recordings that carry information the speech does not say aloud. Empty array if none.
- If a stretch has no speech but shows something (slides, a demo, a scene), add a turn with speaker "On screen" whose text quotes any visible text exactly and then says in one plain sentence what happens.
- "reached_end" is true only if the video itself finishes before {{片段結束時間}}. Reaching the end of this clip is not the end of the video. If the clip lies entirely after the end of the video, return empty arrays and reached_end true.
{F}

### 章節的欄位定義 — 用在 ②③

每一章 AI 要填這些欄位：

{F}text
{{"t":<這一章開始的秒數，必須是逐字稿裡某一行的秒數>,
 "en":"<原文語言的短標題>",
 "zh":"<中文標題，格式是「概念：具體例子」，照下面「標題怎麼下」的規則寫>",
 "sum":"<兩三個短句，75 字內，講者實際說了或做了什麼，帶具體的數字、名稱、做法>",
 "take":"<一句 40 字內可帶走的原則；純閒聊、或內容本身沒有可帶走的道理就留空字串，不要硬湊>",
 "worth":<1 到 3 的整數，3 是核心>}}
{F}

章節的切法規則：

{F}text
- 依講者的論點切換來分段，不要依時間平均切。
- 一段只講一個主要論點，通常是 3 到 10 分鐘的內容。任何一章都不要超過 15 分鐘。
- 講者舉例、離題或回答問題時，如果還在支撐同一個論點，就歸在同一段。
- worth 看的是「這一章對讀者有多少可以帶走的東西」：3 是核心論點或可以直接照做的方法，2 是有用的補充，1 是開場、閒聊、致謝這類可以跳過的。3 分最多佔三分之一。
- 講者是 "On screen" 的段落是畫面描述，照樣整理進章節。

{{標題怎麼下 TITLES}}

{{寫法規則 STYLE}}

{{章節用的好壞對照 EX_CHAPTER}}
{F}

### 整支影片的欄位定義 — 用在 ②④

{F}text
"lang":"<逐字稿語言的 BCP-47 代碼，例如 en、zh-TW、ja>",
"title":"<影片標題，看不出來就寫最貼切的一句>",
"host":"<訪問者或主持人的 speaker 標籤，沒有就寫空字串>",
"headline":"<整支影片最根本的一個道理>",
"principle":"<第一性原理>",
"groups":[{{"title":"<組名>","points":["<要點>"]}}],
"reminder":"<核心提醒>"
{F}

`headline` 是總覽頁最上面那句大字，下面依序是第一性原理、分組要點、核心提醒。這四個欄位怎麼寫，由下面這段規則決定。

### 總覽怎麼寫（BRIEF）— 用在 ②④

範例是你提供的第 2 堂課總覽。

{F}text
@@BRIEF@@

### ② 切章節＋整支摘要（1 小時內的影片）

{F}text
下面是一支影片的完整逐字稿，每一行開頭的方括號是該段開始的秒數。請幫{{讀者設定}}整理這支影片，讓他能很快判斷值不值得細看。

輸出 JSON：
{{{{整支影片的欄位定義}},"chapters":[{{章節的欄位定義}}]}}

規則：
- 第一章從第一行的秒數開始。整支影片最重要的那一章一定要是 3。
{{章節的切法規則}}

{{總覽怎麼寫 BRIEF}}

逐字稿：
{{[秒數] 講者: 內容，一行一段}}

畫面上出現、講者沒有唸出來的文字：
{{[秒數] 文字}}
{F}

### ③ 切章節（超過 1 小時的影片，每小時一次）

{F}text
下面是一支長影片逐字稿的第 {{N}} 部分（共 {{總數}} 部分），每一行開頭的方括號是該段開始的秒數。請幫{{讀者設定}}把這一部分切成章節。

輸出 JSON：{{"chapters":[{{章節的欄位定義}}]}}

規則：
- 只整理這一部分的內容。第一章從這一部分第一行的秒數開始。
{{章節的切法規則}}

逐字稿：
{{這一小時的逐字稿}}

畫面上出現、講者沒有唸出來的文字：
{{[秒數] 文字}}
{F}

### ③b 整點接縫重切（超過 1 小時的影片，每個整點一次）

③ 是每一小時切一次，所以每個整點一定會有一刀。這一步把整點前、後兩章的逐字稿合起來，請 AI 只照內容重切：同一個話題就合成一章，話題真的換了就切在真正換的那一行。

{F}text
下面是一支長影片裡連續的一段逐字稿，每一行開頭的方括號是該段開始的秒數。這一段原本在 [{{整點的秒數}}] 被切成兩章，但那一刀只是因為影片太長、要分批處理才切的，不代表話題在那裡換了。請幫{{讀者設定}}只看內容，把這一段重新切成章節。

輸出 JSON：{{"chapters":[{{章節的欄位定義}}]}}

規則：
- 第一章從這一段第一行的秒數開始。
- 如果整段都在講同一件事，就只給一章。如果話題確實換了，切在話題真正換的那一行，不一定是 [{{整點的秒數}}]。
{{章節的切法規則}}

逐字稿：
{{整點前後兩章的逐字稿}}
{F}

### ④ 整支影片的總覽（超過 1 小時的影片）

{F}text
下面是一支長影片的章節清單（已經整理好）和完整逐字稿。請幫{{讀者設定}}寫出整支影片的總覽。

輸出 JSON：{{{{整支影片的欄位定義}},"worth":[<依章節順序，每一章 1 到 3 的整數>]}}

規則：
- 總覽要看完整支影片再寫，不要只看開頭。
- worth 是把所有章節放在一起重新評：3 是整支影片的核心，最多佔三分之一；1 是可以跳過的。陣列長度必須是 {{章數}}。

{{總覽怎麼寫 BRIEF}}

{{寫法規則 STYLE}}

章節：
{{編號. [時間] 中文標題：摘要 → 可帶走的原則}}

逐字稿：
{{完整逐字稿}}
{F}

### ⑤ 翻譯

{F}text
把下面 {{句數}} 個句子翻成繁體中文（台灣用語）。它們是同一段訪談或演講裡連續的句子。
輸出 JSON：{{"zh":["<第 1 句的翻譯>", ...]}}，陣列長度必須剛好是 {{句數}}，順序一一對應。
規則：
- 忠於原意，不要加原文沒有的內容，不要省略。
- 翻成台灣人講話的樣子，像好的字幕。原文是口語就翻口語，短句就翻短句。
- 不要書面連接詞（透過、藉由、進而、然而、此外），不要把動詞翻成名詞（「進行了討論」寫成「聊了」）。
- 產品名、人名、技術名詞保留原文。「you know」「I mean」這類贅字可以順掉。

這一章的主題：{{章節標題}}

1. {{句子}}
2. {{句子}}
…
{F}

### ⑥ 每章的摘要＋第一性原理

{F}text
下面是影片其中一章的逐字稿，每句前面有編號。請幫一位正在找 product-market fit 的一人創業者讀懂它。

輸出 JSON：
{{"spark":"<14 字內，這一章最值得記住的一句話>",
 "sum":["<這段在說什麼 1>","<2>","<3>"],
 "core":"<第一性原理：這個做法為什麼成立的最根本理由。一到兩個短句>",
 "chain":["<推理第 1 步：最基本的前提>","<第 2 步>","<第 3 步>","<第 4 步：結論>"],
 "ask":"<一個把這個原理換到讀者自己身上的問題>",
 "key":[<最能代表這一章的 1 到 2 個句子編號，要相鄰>],
 "counter":"<站在反方，指出這個結論最弱的一個環節或不適用的情況，用一個問題結尾，100 字內>"}}

規則：
- core 和 chain 要從前提一步步推到結論，每一步都能獨立成立，不要只是換句話重複摘要。
- 照內容本身的道理寫。如果這一章跟創業或做產品無關（例如故事、動畫、純示範），就講它本身的道理，ask 也問一般性的問題，不要硬套到創業上。
- ask 和 counter 本來就要用問句，其他欄位不要。

{{寫法規則 STYLE}}

{{第一性原理用的好壞對照 EX_ANALYSIS}}

這一章的主題：{{章節標題}}

{{編號. 講者: 句子}}
{F}

欄位對應到畫面：

| 欄位 | 畫面上的位置 |
|---|---|
| spark | 淬煉頁「AI 挑的」那張卡 |
| sum | 「這一段在說什麼」 |
| core | 「第一性原理」 |
| chain | 「展開推理鏈」 |
| ask | 「換到你身上」 |
| key | 這一章被標成重點的句子 |
| counter | 淬煉頁的反方提問 |

## 四、使用者按了才跑的提示詞

這三個在 `src/app.html`，只在 Claude 預覽頁（artifact）裡有作用，部署版目前沒有接上。

### ⑦ 請 AI 解釋這句（點句子後的面板）

{F}text
你是陪讀夥伴。讀者的母語是繁體中文，是一位創業者，正在讀一段英文訪談逐字稿。請用繁體中文、最多 90 個字，解釋下面這句話在上下文中的意思，並點出它背後的一個假設。直接講，不要開場白，不要條列。

這段的主題：{{章節標題}}
上下文：{{同一段發言的所有句子}}
要解釋的句子：{{句子原文}}
{F}

### ⑧ 反方挑戰（淬煉頁，針對你寫的主張）

{F}text
你是嚴格但友善的辯論對手。讀者看完一段訪談，用自己的話寫下一個主張。請用繁體中文、最多 100 個字，指出這個主張最弱的一個環節（一個具體反例，或一個沒說出口的假設），最後用一個問題結尾。不要稱讚，不要重述他的話，不要條列。

訪談重點：{{這一章的 sum}}
他引用的證據：{{他選的畫線句子}}
讀者的主張：{{他寫的主張}}
{F}

### ⑨ 整理成貼文（觀點卡頁）

{F}text
把下面這位讀者自己寫的結論整理成一篇繁體中文社群貼文，250 字以內。規則：只能使用他寫的觀點，不能加入新論點；保留他的口吻；不要勵志結尾，不要 hashtag，不要 emoji。

{{他寫的結論}}
{F}
'''
doc=doc.replace('@@BRIEF@@',BRIEF)
open(ROOT+'/PROMPTS.md','w',encoding='utf8').write(doc)
print(len(doc))
