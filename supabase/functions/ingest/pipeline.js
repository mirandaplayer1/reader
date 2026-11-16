// Reader ingest pipeline. Pure logic: no Deno or Node APIs, so the same file runs in the
// Supabase edge function and in local tests. Every call does ONE unit of work and returns
// the new row, so a failed unit is retried on its own and a long video never hits a timeout.

export const CHUNK_SECONDS = 300;      // video is read five minutes at a time: longer clips lose words and drift in time
export const MAX_CHUNKS = 96;          // hard stop at eight hours
export const TRANSLATE_BATCH = 50;     // sentences per translation call

const GEMINI = "https://generativelanguage.googleapis.com/v1beta";

export function parseVideoId(url) {
  const s = String(url || "").trim();
  const m =
    s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/) ||
    s.match(/^([A-Za-z0-9_-]{11})$/);
  return m ? m[1] : null;
}

// Deterministic sentence splitter. The original text is never re-typed by a model,
// so what the reader sees as "原文" is exactly what was transcribed.
export function splitSentences(text) {
  const src = String(text || "").replace(/\s+/g, " ").trim();
  if (!src) return [];
  // Cut after sentence-ending punctuation (plus any closing quote) that is followed by a space,
  // or directly after CJK full stops. Slicing by position keeps every character.
  const re = /(?:[.!?]+["'”’)\]]*\s+|[。！？]+[」』”’]*\s*)/g;
  const abbr = /(?:^|[\s(])(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|No|e\.g|i\.e|U\.S)\.\s+$/;
  const raw = [];
  let from = 0, m;
  while ((m = re.exec(src))) {
    const piece = src.slice(from, re.lastIndex);
    if (abbr.test(piece)) continue;            // "Dr. Smith" is not a sentence break
    raw.push(piece); from = re.lastIndex;
  }
  if (from < src.length) raw.push(src.slice(from));
  // Fold fragments ("Yeah.", "Right?") into a neighbour so each unit is worth highlighting.
  const tooShort = (p) => { const t = p.trim(); return t.length < (/[\u3040-\u30ff\u4e00-\u9fff]/.test(t) ? 7 : 18); };
  const out = [];
  for (const p of raw) {
    if (out.length && (tooShort(p) || tooShort(out[out.length - 1]))) out[out.length - 1] += p;
    else out.push(p);
  }
  return out.map((p) => p.trim()).filter(Boolean);
}

const clock = (t) => {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s).padStart(2, "0");
};

function parseJSON(text) {
  let s = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const a = s.search(/[\[{]/);
  if (a > 0) s = s.slice(a);
  return JSON.parse(s);
}

// "12:34" or "1:02:03" -> seconds. Models report clock times far more accurately than raw second counts.
export function clockToSeconds(v) {
  if (typeof v === "number") return Math.round(v);
  const p = String(v || "").trim().split(":").map((x) => Number(x));
  if (!p.length || p.some((x) => !Number.isFinite(x))) return NaN;
  return Math.round(p.reduce((a, x) => a * 60 + x, 0));
}

// Exact video length without downloading anything: token counting is free, and audio is a fixed number of tokens per second.
async function videoLength(deps, url) {
  const count = async (meta) => {
    const part = { file_data: { file_uri: url } };
    if (meta) part.video_metadata = meta;
    const res = await deps.fetch(`${GEMINI}/models/${deps.videoModel}:countTokens`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": deps.geminiKey },
      body: JSON.stringify({ contents: [{ role: "user", parts: [part] }] }),
    });
    if (!res.ok) return 0;
    const j = await res.json();
    const a = (j.promptTokensDetails || []).find((d) => d.modality === "AUDIO");
    return a ? Number(a.tokenCount) || 0 : 0;
  };
  const sample = await count({ start_offset: "0s", end_offset: "60s" });
  const all = await count(null);
  if (!sample || !all) return 0;
  const perSecond = sample / 60;
  return all <= sample ? Math.round(all / 32) : Math.round(all / perSecond);
}

// Forces the transcript into a fixed shape, so a malformed reply cannot happen.
const TRANSCRIPT_SCHEMA = {
  type: "OBJECT",
  properties: {
    turns: { type: "ARRAY", items: { type: "OBJECT", properties: { ts: { type: "STRING" }, speaker: { type: "STRING" }, text: { type: "STRING" } }, required: ["ts", "speaker", "text"] } },
    visuals: { type: "ARRAY", items: { type: "OBJECT", properties: { ts: { type: "STRING" }, text: { type: "STRING" } }, required: ["ts", "text"] } },
    reached_end: { type: "BOOLEAN" },
  },
  required: ["turns", "visuals", "reached_end"],
};

const STR = { type: "STRING" }, INT = { type: "INTEGER" };
const LIST = (items) => ({ type: "ARRAY", items });
const OBJ = (properties) => ({ type: "OBJECT", properties, required: Object.keys(properties) });
const CHAPTER_ITEM = OBJ({ t: INT, en: STR, zh: STR, sum: STR, take: STR, worth: INT });
const META = { lang: STR, title: STR, host: STR, thesis: STR, tldr: LIST(STR) };
const SCHEMA = {
  outline: OBJ({ ...META, chapters: LIST(CHAPTER_ITEM) }),
  window: OBJ({ chapters: LIST(CHAPTER_ITEM) }),
  synth: OBJ({ ...META, worth: LIST(INT) }),
  translate: OBJ({ zh: LIST(STR) }),
  analysis: OBJ({ title: STR, spark: STR, sum: LIST(STR), core: STR, chain: LIST(STR), ask: STR, key: LIST(INT), counter: STR }),
};

async function gemini(deps, model, parts, maxTokens = 32768, schema = null) {
  const res = await deps.fetch(`${GEMINI}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": deps.geminiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: Object.assign({ responseMimeType: "application/json", temperature: deps.temperature ?? 0.2, maxOutputTokens: maxTokens }, schema ? { responseSchema: schema } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error((body.error && body.error.message) || "Gemini request failed (" + res.status + ")");
    e.status = res.status;
    throw e;
  }
  const cand = body.candidates && body.candidates[0];
  const text = cand && cand.content && cand.content.parts ? cand.content.parts.map((p) => p.text || "").join("") : "";
  if (!text) throw new Error("Gemini returned no text" + (cand && cand.finishReason ? " (" + cand.finishReason + ")" : ""));
  return parseJSON(text);
}

// Text-only stages. Claude is used when an Anthropic key is configured, otherwise Gemini.
async function llmJSON(deps, prompt, maxTokens = 16000, schema = null) {
  if (deps.anthropicKey) {
    const res = await deps.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": deps.anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: deps.claudeModel || "claude-sonnet-5-5",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt + "\n\n只輸出 JSON，不要加任何說明或程式碼框。" }],
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body.error && body.error.message) || "Claude request failed (" + res.status + ")");
    return parseJSON((body.content || []).map((b) => b.text || "").join(""));
  }
  return gemini(deps, deps.textModel, [{ text: prompt }], maxTokens, schema);
}

// The voice every generated line is held to. Written as concrete do / don't pairs because a bare
// "write naturally" does nothing: the examples are what move the output.
const STYLE = `怎麼寫（這一段最重要，寫完請逐句對照）：
- 像你看完影片後講給朋友聽。用台灣人平常講話的字。短句，一句只講一件事。一句裡的逗號超過兩個就拆成兩句。
- 不要想用一句話把所有重點講完。寧可只講最重要的一件，講清楚。
- 先講具體的事：誰、做了什麼、數字多少。道理放後面，而且用講者自己的例子講。
- 用動詞講，不要把動作變成名詞。寫「他兩週就上線」，不要寫「進行快速的產品驗證」。
- 這些詞不要用：透過、藉由、進而、從而、打造、賦能、極致、極簡、核心、關鍵、本質、痛點、心法、迷思、哲學、思維、底層邏輯、最大化、優化、落地、聚焦、洞察、驅動、建構、形塑、彰顯。
- 少用「度、性、化」結尾的抽象名詞（自由度、可能性、最佳化）。「自動化」這種本來就是日常用詞的可以。
- 不要四個字四個字地排，不要成語連發。不要用「並」「且」「並且」把好幾件事串成一句，也不要一次並列三樣東西。
- 口語，但不要網路用語和火星文（免費仔、寫扣、鎂、神器、狂、超扯）。
- 不要「不是 X，而是 Y」，不要勵志口吻，不要破折號，不要 emoji，不要在句尾補一句總結。除了本來就要你提問的欄位，不要用問句。
- 產品名、人名、技術名詞保留原文。只能寫內容裡有的事實，不可以編數字或主張。`;

const EX_CHAPTER = `寫法對照：
標題　好：「先收錢，再相信」「鏟沙」「不想當 CEO」「一個月的牆」「兩分鐘修好」
　　　不好：「極簡創業與付費驗證」「潛意識醞釀與極簡記錄」（兩個抽象名詞用「與」並列，沒有畫面）
sum　 好：「他不拿創投，設計、程式、logo 全部自己來。點子兩週內上線，有人刷卡才算數。」
　　　不好：「分享不拿創投的獨立開發模式，將點子做成微型產品並在兩週內上線，直接用用戶刷卡付款驗證需求。」
take　好：「卡住的時候，給自己一個每月要上線一次的期限。」
　　　不好：「陷入停滯時設定固定週期的上線挑戰，用強制發布逼迫自己持續產出。」
thesis 好：「Pieter Levels 一個人做了 70 幾個產品，賺錢的只有 4 個。他不募資，想到就做，兩週內上線，有人刷卡才繼續。」
　　　不好：「一個人不募資，靠很多次兩週就上線的小實驗，找出有人願意付錢的那一個，再用自動化讓它不必變成一家公司。」（一個長句塞四件事，沒有人、沒有數字，像機器寫的摘要）
　　　不好：「一人創業者應捨棄募資與複雜架構，透過市場付費訊號快速驗證點子。」
　　　不好：「他主張人必須相信當下的直覺，做自己真心熱愛的事，並用死亡的必然性甩開旁人的眼光。」（並列三件事，還有「必然性」這種抽象名詞）
　　　改成：「他每天早上照鏡子問自己：如果今天是最後一天，我還想做今天要做的事嗎？」
tldr　好：「怎麼知道點子行不行：看有沒有陌生人付錢。註冊、按讚都不算。」
　　　不好：「打造微型產品並在兩週內串接 Stripe 收費，以信用卡實際付款作為驗證需求的唯一標準。」`;

const EX_ANALYSIS = `寫法對照：
title　好：「先收錢，再相信」「鏟沙」「不想當 CEO」　不好：「被蘋果開除後歸零」「連續轉型與純手動驗證」
spark　好：「有人掏信用卡，才算驗證」「難的是決定不做什麼」
sum　　好：「判斷標準是有人付錢。註冊和稱讚都不算。」
　　　 不好：「意識到自己依然熱愛這份工作，於是卸下成功包袱創辦了 NeXT 與 Pixar。」
core　 好：「動機是行動的副產品。等有動機才行動，順序反了。」
　　　 好：「流程存在的理由是降低出錯的代價。出錯的代價本來就低的時候，流程只剩下成本。」
　　　 不好：「失去既有成功的沉重包袱，能讓人重獲初學者的自由度去探索高創造力的全新嘗試。」
chain　好：「沒有人能事先知道哪個點子會成。他自己也說多數失敗。」
　　　 好：「註冊和稱讚不花對方任何成本，所以幾乎不帶資訊。付錢要花成本，所以是誠實的訊號。」
　　　 不好：「維持既有成功需要承擔維護現狀的沉重負擔，限制了冒險空間。」
ask　　好：「你手上哪個點子，其實兩週內就能放上一個付款按鈕？你一直沒放，是在保護什麼？」
　　　 不好：「你現在緊抓不放的既有想法或微小成果，是否正阻礙你像初學者一樣靈活探索新方向？」
counter 好：「壞了再修只在錯誤可逆時成立。金流算錯、資料外洩，兩分鐘修不回來。你的產品裡哪些地方不可逆？」`;

/* ---------- ingest: meta -> transcribe (chunk by chunk) -> outline -> ready (-> translate -> analyse, in the background) ---------- */

export async function ingestStep(row, deps) {
  const work = Object.assign({ phase: "meta", next: 0, turns: [], visuals: [] }, row.work || {});
  const url = "https://www.youtube.com/watch?v=" + row.video_id;
  if (work.phase === "translate") return translateStep(row, work, deps);
  if (work.phase === "analyse") return analyseStep(row, work, deps);

  if (work.phase === "meta") {
    let title = row.title || "", channel = "";
    try {
      const r = await deps.fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(url));
      if (r.ok) { const j = await r.json(); title = j.title || title; channel = j.author_name || ""; }
    } catch (_) { /* title is filled in by the outline step if this is blocked */ }
    try { work.length = await videoLength(deps, url); } catch (_) { work.length = 0; }
    if (!work.length) delete work.length;      // unknown: the end is then detected from the clips
    work.channel = channel;
    work.phase = "transcribe";
    return { title, status: "processing", work, progress: { phase: "transcribe", done: 0, total: work.length ? Math.ceil(work.length / CHUNK_SECONDS) : null } };
  }

  if (work.phase === "transcribe") {
    const i = work.next, a = i * CHUNK_SECONDS, b = a + CHUNK_SECONDS;
    const known = [...new Set(work.turns.map((t) => t.speaker))].slice(0, 8);
    const prompt =
      `Transcribe the speech in this video clip verbatim, in the language spoken. The clip is the part of the video from ${clock(a)} to ${clock(b)}.\n` +
      `Return JSON only: {"turns":[{"ts":"MM:SS","speaker":"name","text":"..."}],"visuals":[{"ts":"MM:SS","text":"..."}],"reached_end":true|false}\n` +
      `- "ts" is the timestamp in the FULL video (not relative to the clip) where the turn starts, as MM:SS, or H:MM:SS past one hour.\n` +
      `- Start a new turn at every speaker change and at least every 30 seconds.\n` +
      `- Transcribe everything that is said from the first second of the clip to the last. Do not skip, shorten, summarise or translate.\n` +
      `- "speaker": the person's real name if it is said or shown; otherwise "Speaker 1", "Speaker 2". ` +
      (known.length ? `Speakers already identified earlier in this video: ${known.join(", ")}. Reuse these exact labels for the same people.\n` : `\n`) +
      `- "visuals": text or figures on slides, whiteboards, code or screen recordings that carry information the speech does not say aloud. Empty array if none.\n` +
      `- If a stretch has no speech but shows something (slides, a demo, a scene), add a turn with speaker "On screen" whose text quotes any visible text exactly and then says in one plain sentence what happens.\n` +
      `- "reached_end" is true only if the video itself finishes before ${clock(b)}. Reaching the end of this clip is not the end of the video. If the clip lies entirely after the end of the video, return empty arrays and reached_end true.`;
    const saved = deps.temperature; deps.temperature = 0;
    let out;
    try {
      out = await gemini(deps, deps.videoModel, [
        { file_data: { file_uri: url }, video_metadata: { start_offset: a + "s", end_offset: b + "s" } },
        { text: prompt },
      ], 32768, TRANSCRIPT_SCHEMA);
    } finally { deps.temperature = saved; }
    let turns = (Array.isArray(out.turns) ? out.turns : [])
      .map((t) => ({ t: clockToSeconds(t.ts ?? t.t), speaker: String(t.speaker || "Speaker 1").trim(), text: String(t.text || "").trim() }))
      .filter((t) => t.text && Number.isFinite(t.t))
      .map((t) => ({ ...t, t: Math.max(0, t.t) }));
    // Some responses give times relative to the clip. If every timestamp falls before the clip, shift them.
    if (turns.length && a > 0 && Math.max(...turns.map((t) => t.t)) < a) turns = turns.map((t) => ({ ...t, t: t.t + a }));
    turns = turns.filter((t) => t.t < b + 30).sort((x, y) => x.t - y.t);
    const visuals = (Array.isArray(out.visuals) ? out.visuals : [])
      .map((v) => { const t = clockToSeconds(v.ts ?? v.t); return { t: Number.isFinite(t) ? t : a, text: String(v.text || "").trim() }; }).filter((v) => v.text);
    // A clip boundary can cut a sentence in two. Join it back onto the previous turn when the same person is still talking.
    const prev = work.turns[work.turns.length - 1];
    if (prev && turns.length && turns[0].speaker === prev.speaker && !/[.!?。！？…"”’)]$/.test(prev.text)) {
      // "…impossible to con-" + "connect the dots…": drop the cut-off fragment only when the next clip repeats the word.
      const frag = prev.text.match(/(\S+)-$/);
      const head = frag && turns[0].text.toLowerCase().startsWith(frag[1].toLowerCase()) ? prev.text.slice(0, frag.index).trim() : prev.text;
      prev.text = (head + " " + turns[0].text).trim();
      turns = turns.slice(1);
    }
    work.turns = work.turns.concat(turns);
    work.visuals = work.visuals.concat(visuals);
    work.next = i + 1;
    const lastT = turns.length ? turns[turns.length - 1].t : a;
    const ended = work.length
      ? b >= work.length                                              // exact length known
      : (turns.length === 0 && !prev) || (turns.length === 0 && i > 0) || (out.reached_end === true && lastT < b - 60) || work.next >= MAX_CHUNKS;
    if (ended) {
      if (!work.turns.length) return { status: "error", error: "這支影片沒有偵測到任何語音內容。", work };
      work.phase = "outline";
      work.duration = work.length || work.turns[work.turns.length - 1].t + 30;
    }
    return { status: "processing", work, progress: { phase: ended ? "outline" : "transcribe", done: work.next, total: ended ? work.next : (work.length ? Math.ceil(work.length / CHUNK_SECONDS) : null) } };
  }

  // Chapters are cut one hour of transcript at a time, so no single request grows with the length of the video.
  const CHAPTER_SPEC =
    `{"t":<這一章開始的秒數，必須是逐字稿裡某一行的秒數>,"en":"<原文語言的短標題>","zh":"<10 字內的中文標題，像人會講的一句話，有畫面>",` +
    `"sum":"<兩三個短句，75 字內，講者實際說了或做了什麼，帶具體的數字、名稱、做法>","take":"<一句 40 字內可帶走的原則；純閒聊、或內容本身沒有可帶走的道理就留空字串，不要硬湊>","worth":<1 到 3 的整數，3 是核心>}`;
  const CHAPTER_RULES =
    `- 依主題切章，一章只講一件事。20 分鐘以內的影片切 3 到 6 章；更長的影片每章大約 3 到 15 分鐘，任何一章都不要超過 15 分鐘，話題換了就切。\n` +
    `- worth 看的是「這一章對讀者有多少可以帶走的東西」：3 是核心論點或可以直接照做的方法，2 是有用的補充，1 是開場、閒聊、致謝這類可以跳過的。3 分最多佔三分之一。\n` +
    `- 講者是 "On screen" 的段落是畫面描述，照樣整理進章節。\n\n${STYLE}\n\n${EX_CHAPTER}`;
  const READER = `一位正在找 product-market fit 的一人創業者`;
  const WINDOW = 3600;
  const cleanChapters = (list, starts) => {
    const snap = (t) => starts.reduce((best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best), starts[0]);
    return (Array.isArray(list) ? list : [])
      .map((c) => ({ t: snap(Number(c.t) || 0), en: String(c.en || ""), zh: String(c.zh || ""), sum: String(c.sum || ""), take: String(c.take || ""), worth: Math.min(3, Math.max(1, Math.round(Number(c.worth) || 1))) }))
      .sort((x, y) => x.t - y.t);
  };
  const finish = (meta, chapters) => {
    const starts = work.turns.map((t) => t.t);
    chapters = chapters.sort((x, y) => x.t - y.t).filter((c, i, arr) => i === 0 || c.t > arr[i - 1].t);
    if (!chapters.length) throw new Error("沒有產生章節，請重試。");
    chapters[0].t = starts[0];
    const segs = chapters.map((c, i) => {
      const end = i + 1 < chapters.length ? chapters[i + 1].t : Infinity;
      const turns = work.turns.filter((t) => t.t >= c.t && t.t < end)
        .map((t) => ({ sp: t.speaker, t: t.t, s: splitSentences(t.text).map((x) => [x, (work.zh && work.zh[x]) || null]) }));
      return { id: "c" + i, t: c.t, title: c.zh || c.en, deep: false, turns };
    });
    const content = {
      vid: row.video_id, lang: String(meta.lang || "en"), title: row.title || String(meta.title || ""), channel: work.channel || "",
      duration: work.duration, host: String(meta.host || ""), thesis: String(meta.thesis || ""),
      tldr: (Array.isArray(meta.tldr) ? meta.tldr : []).map(String).slice(0, 3), chapters, segs, visuals: work.visuals,
    };
    // Readable from here on. In the background: translation (unless the video is already in Chinese), then the
    // summary and first-principles notes for every chapter.
    let total = 0, have = 0;
    segs.forEach((g) => g.turns.forEach((tu) => tu.s.forEach((p) => { total++; if (p[1] != null) have++; })));
    const more = !/^zh/i.test(content.lang) && have < total;
    return { status: "ready", title: content.title, content, work: { phase: more ? "translate" : "analyse", channel: work.channel },
      progress: more ? { phase: "translate", done: have, total } : { phase: "analyse", done: 0, total: segs.length }, error: null };
  };
  const META_SPEC =
    `"lang":"<逐字稿語言的 BCP-47 代碼，例如 en、zh-TW、ja>","title":"<影片標題，看不出來就寫最貼切的一句>",` +
    `"host":"<訪問者或主持人的 speaker 標籤，沒有就寫空字串>","thesis":"<兩到三個短句，70 字內。第一句講這個人是誰、做了什麼讓人想聽他講，要有具體的數字或事實。後面只講他最主要的「一個」做法或主張，用他自己的例子講，不要並列好幾個>","tldr":["<重點 1，一到兩個短句>","<重點 2>","<重點 3>"]`;

  if (work.phase === "outline") {
    const first = work.turns[0].t, last = work.turns[work.turns.length - 1].t;
    const windows = Math.max(1, Math.ceil((last - first + 1) / WINDOW));
    const visLines = (a, b) => { const v = work.visuals.filter((x) => x.t >= a && x.t < b); return v.length ? "\n\n畫面上出現、講者沒有唸出來的文字：\n" + v.map((x) => `[${x.t}] ${x.text}`).join("\n") : ""; };

    if (windows === 1) {
      const lines = work.turns.map((t) => `[${t.t}] ${t.speaker}: ${t.text}`).join("\n");
      const prompt =
        `下面是一支影片的完整逐字稿，每一行開頭的方括號是該段開始的秒數。請幫${READER}整理這支影片，讓他能很快判斷值不值得細看。\n\n` +
        `輸出 JSON：\n{${META_SPEC},"chapters":[${CHAPTER_SPEC}]}\n\n規則：\n- 第一章從第一行的秒數開始。整支影片最重要的那一章一定要是 3。\n${CHAPTER_RULES}\n\n逐字稿：\n${lines}${visLines(0, Infinity)}`;
      const out = await llmJSON(deps, prompt, 16000, SCHEMA.outline);
      return finish(out, cleanChapters(out.chapters, work.turns.map((t) => t.t)));
    }

    const w = work.ow || 0, a = first + w * WINDOW, b = a + WINDOW;
    const part = work.turns.filter((t) => t.t >= a && t.t < b);
    if (part.length) {
      const lines = part.map((t) => `[${t.t}] ${t.speaker}: ${t.text}`).join("\n");
      const prompt =
        `下面是一支長影片逐字稿的第 ${w + 1} 部分（共 ${windows} 部分），每一行開頭的方括號是該段開始的秒數。請幫${READER}把這一部分切成章節。\n\n` +
        `輸出 JSON：{"chapters":[${CHAPTER_SPEC}]}\n\n規則：\n- 只整理這一部分的內容。第一章從這一部分第一行的秒數開始。\n${CHAPTER_RULES}\n\n逐字稿：\n${lines}${visLines(a, b)}`;
      const out = await llmJSON(deps, prompt, 12000, SCHEMA.window);
      work.chapters = (work.chapters || []).concat(cleanChapters(out.chapters, part.map((t) => t.t)));
    }
    work.ow = w + 1;
    if (work.ow >= windows) work.phase = "synth";
    return { status: "processing", work, progress: { phase: "outline", done: work.ow, total: windows } };
  }

  if (work.phase === "synth") {
    const chapters = work.chapters || [];
    const list = chapters.map((c, i) => `${i}. [${clock(c.t)}] ${c.zh}（${c.en}）：${c.sum}${c.take ? " → " + c.take : ""}`).join("\n");
    const opening = work.turns.slice(0, 12).map((t) => `${t.speaker}: ${t.text}`).join("\n").slice(0, 3000);
    const prompt =
      `下面是一支長影片的章節清單（已經整理好），以及影片開頭的一小段逐字稿。請幫${READER}寫出整支影片的總覽。\n\n` +
      `輸出 JSON：{${META_SPEC},"worth":[<依章節順序，每一章 1 到 3 的整數>]}\n\n` +
      `規則：\n- thesis 和 tldr 要從整支影片挑最重要的講，不要只看開頭，也不要每一章都點到。\n- worth 是把所有章節放在一起重新評：3 是整支影片的核心，最多佔三分之一；1 是可以跳過的。陣列長度必須是 ${chapters.length}。\n\n${STYLE}\n\n${EX_CHAPTER}\n\n章節：\n${list}\n\n開頭逐字稿：\n${opening}`;
    const out = await llmJSON(deps, prompt, 4000, SCHEMA.synth);
    if (Array.isArray(out.worth) && out.worth.length === chapters.length)
      chapters.forEach((c, i) => { c.worth = Math.min(3, Math.max(1, Math.round(Number(out.worth[i]) || c.worth))); });
    return finish(out, chapters);
  }

  return {};
}

/* ---------- reprocess: run a finished video again ---------- */

// mode "text": keep the transcript and any translations, redo chapters, summaries and analysis.
// mode "all":  start over from the video itself.
export function reprocessPatch(row, mode) {
  const c = row.content;
  if (mode === "all" || !c || !Array.isArray(c.segs)) {
    return { status: "queued", work: {}, progress: { phase: "meta", done: 0, total: null }, error: null };
  }
  const cjk = /^zh|^ja/i.test(c.lang || "");
  const zh = {};
  const turns = c.segs.flatMap((g) => g.turns.map((t) => {
    t.s.forEach((p) => { if (p && p[1] && p[1] !== p[0]) zh[p[0]] = p[1]; });
    const text = t.s.map((p) => p[0]).join(cjk ? "" : " ");
    return { t: t.t, speaker: t.sp, text };
  }));
  return {
    status: "processing", error: null,
    work: { phase: "outline", turns, visuals: c.visuals || [], channel: c.channel || "", duration: c.duration, length: c.duration, zh },
    progress: { phase: "outline", done: 0, total: null },
  };
}

// Translates a list of consecutive sentences. Returns one translation per sentence, in order.
async function translateList(deps, list, title) {
  const prompt =
    `把下面 ${list.length} 個句子翻成繁體中文（台灣用語）。它們是同一段訪談或演講裡連續的句子。\n` +
    `輸出 JSON：{"zh":["<第 1 句的翻譯>", ...]}，陣列長度必須剛好是 ${list.length}，順序一一對應。\n` +
    `規則：\n- 忠於原意，不要加原文沒有的內容，不要省略。\n- 翻成台灣人講話的樣子，像好的字幕。原文是口語就翻口語，短句就翻短句。\n- 不要書面連接詞（透過、藉由、進而、然而、此外），不要把動詞翻成名詞（「進行了討論」寫成「聊了」）。\n- 產品名、人名、技術名詞保留原文。「you know」「I mean」這類贅字可以順掉。\n\n` +
    `這一章的主題：${title}\n\n` + list.map((x, i) => `${i + 1}. ${x}`).join("\n");
  const out = await llmJSON(deps, prompt, 12000, SCHEMA.translate);
  const zh = Array.isArray(out.zh) ? out.zh : [];
  if (zh.length !== list.length) throw new Error("翻譯句數對不上（要 " + list.length + " 句，拿到 " + zh.length + " 句），請重試。");
  return zh.map((z, i) => String(z || "").trim() || list[i]);
}

/* ---------- translate the whole video in the background, after it is already readable ---------- */

const PARALLEL = 3;   // translation requests per step

async function translateStep(row, work, deps) {
  const content = row.content;
  const chapters = content && Array.isArray(content.segs) ? content.segs.length : 0;
  const finished = { work: { phase: "analyse", channel: work.channel || "" }, progress: { phase: "analyse", done: 0, total: chapters } };
  if (!content || !Array.isArray(content.segs) || /^zh/i.test(content.lang || "")) return finished;
  const todo = []; let total = 0;
  content.segs.forEach((g) => g.turns.forEach((tu) => tu.s.forEach((p) => { total++; if (p[1] == null) todo.push({ p, title: g.title }); })));
  if (!todo.length) return finished;
  const batches = [];
  for (let i = 0; i < PARALLEL && i * TRANSLATE_BATCH < todo.length; i++) batches.push(todo.slice(i * TRANSLATE_BATCH, (i + 1) * TRANSLATE_BATCH));
  const res = await Promise.allSettled(batches.map((b) => translateList(deps, b.map((x) => x.p[0]), b[0].title)));
  let ok = 0;
  res.forEach((r, i) => { if (r.status === "fulfilled") { batches[i].forEach((x, j) => { x.p[1] = r.value[j]; }); ok += batches[i].length; } });
  if (!ok) throw res[0].reason;            // keep whatever succeeded; fail the step only when nothing did
  const left = todo.length - ok;
  if (!left) return { content, ...finished };
  return { content, work: { phase: "translate", channel: work.channel || "" }, progress: { phase: "translate", done: total - left, total } };
}

/* ---------- summary and first-principles notes for every chapter, in the background ---------- */

const CHAPTER_TRIES = 3;   // a chapter that keeps failing is left for the button in the reader

async function analyseStep(row, work, deps) {
  const content = row.content, channel = work.channel || "";
  const finished = { work: { phase: "ready", channel }, progress: { phase: "ready", done: 1, total: 1 } };
  if (!content || !Array.isArray(content.segs)) return finished;
  const tries = Object.assign({}, work.tries);
  const open = content.segs.map((g, i) => (g.deep === false && (tries[i] || 0) < CHAPTER_TRIES ? i : -1)).filter((i) => i >= 0);
  if (!open.length) return finished;
  // Chapters tried least go first, so one that keeps failing cannot hold up the ones after it.
  const ks = open.sort((x, y) => (tries[x] || 0) - (tries[y] || 0) || x - y).slice(0, PARALLEL);
  ks.forEach((k) => { tries[k] = (tries[k] || 0) + 1; });
  const res = await Promise.allSettled(ks.map((k) => deepenStep(row, k, deps)));
  if (!res.some((r) => r.status === "fulfilled")) throw res[0].reason;
  // A chapter that still had sentences to translate only moved forward: that try does not count against it.
  res.forEach((r, i) => { if (r.status === "fulfilled" && !r.value.done) tries[ks[i]]--; });
  const total = content.segs.length, done = content.segs.filter((g) => g.deep !== false).length;
  const left = content.segs.some((g, i) => g.deep === false && (tries[i] || 0) < CHAPTER_TRIES);
  if (!left) return { content, ...finished };
  return { content, work: { phase: "analyse", channel, tries }, progress: { phase: "analyse", done, total } };
}

/* ---------- deepen one chapter on demand: translate in batches, then analyse ---------- */

export async function deepenStep(row, k, deps) {
  const content = row.content;
  const seg = content && content.segs && content.segs[k];
  if (!seg) throw new Error("找不到這一章。");
  if (seg.deep) return { done: true };
  const flat = [];
  seg.turns.forEach((tu, ti) => tu.s.forEach((p, si) => flat.push({ ti, si, p })));
  const total = flat.length;
  const sameLang = /^zh/i.test(content.lang || "");

  const todo = sameLang ? [] : flat.filter((x) => x.p[1] == null);
  if (todo.length) {
    const batch = todo.slice(0, TRANSLATE_BATCH);
    const zh = await translateList(deps, batch.map((x) => x.p[0]), seg.title);
    batch.forEach((x, i) => { x.p[1] = zh[i]; });
    const left = todo.length - batch.length;
    return { content, done: false, progress: { phase: "translate", done: total - left, total } };
  }

  const numbered = flat.map((x, i) => `${i}. ${seg.turns[x.ti].sp}: ${x.p[0]}`).join("\n");
  const prompt =
    `下面是影片其中一章的逐字稿，每句前面有編號。請幫一位正在找 product-market fit 的一人創業者讀懂它。\n\n` +
    `輸出 JSON：\n{"title":"<8 字內的中文標題，具體、有畫面>","spark":"<14 字內，這一章最值得記住的一句話>",` +
    `"sum":["<這段在說什麼 1>","<2>","<3>"],"core":"<第一性原理：這個做法為什麼成立的最根本理由。一到兩個短句>",` +
    `"chain":["<推理第 1 步：最基本的前提>","<第 2 步>","<第 3 步>","<第 4 步：結論>"],` +
    `"ask":"<一個把這個原理換到讀者自己身上的問題>","key":[<最能代表這一章的 1 到 2 個句子編號，要相鄰>],` +
    `"counter":"<站在反方，指出這個結論最弱的一個環節或不適用的情況，用一個問題結尾，100 字內>"}\n\n` +
    `規則：\n- core 和 chain 要從前提一步步推到結論，每一步都能獨立成立，不要只是換句話重複摘要。\n- 照內容本身的道理寫。如果這一章跟創業或做產品無關（例如故事、動畫、純示範），就講它本身的道理，ask 也問一般性的問題，不要硬套到創業上。\n- ask 和 counter 本來就要用問句，其他欄位不要。\n\n${STYLE}\n\n${EX_ANALYSIS}\n\n這一章的主題：${seg.title}\n\n${numbered}`;
  const out = await llmJSON(deps, prompt, 6000, SCHEMA.analysis);
  const keyIdx = (Array.isArray(out.key) ? out.key : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < total).slice(0, 2);
  const key = (keyIdx.length ? keyIdx : [0]).map((n) => [flat[n].ti, flat[n].si]);
  Object.assign(seg, {
    deep: true, title: String(out.title || seg.title), spark: String(out.spark || seg.title),
    sum: (Array.isArray(out.sum) ? out.sum : []).map(String).slice(0, 4), core: String(out.core || ""),
    chain: (Array.isArray(out.chain) ? out.chain : []).map(String).slice(0, 5), ask: String(out.ask || ""),
    key, counter: String(out.counter || ""),
  });
  if (sameLang) seg.turns.forEach((tu) => tu.s.forEach((p) => { if (p[1] == null) p[1] = p[0]; }));
  return { content, done: true, progress: { phase: "ready", done: total, total } };
}
