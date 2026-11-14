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
async function llmJSON(deps, prompt, maxTokens = 16000) {
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
  return gemini(deps, deps.textModel, [{ text: prompt }], maxTokens);
}

const STYLE =
  "寫作規則：繁體中文、台灣用語，直接、具體，像一個很懂的朋友寫的筆記。不要用「不是X，而是Y」的對仗句，不要勵志口吻，不要破折號，不要反問句，不要 emoji。產品名、人名、技術名詞保留原文。只能寫內容裡有的事實，不可以編數字或主張。";

/* ---------- ingest: meta -> transcribe (chunk by chunk) -> outline -> ready ---------- */

export async function ingestStep(row, deps) {
  const work = Object.assign({ phase: "meta", next: 0, turns: [], visuals: [] }, row.work || {});
  const url = "https://www.youtube.com/watch?v=" + row.video_id;

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

  if (work.phase === "outline") {
    const lines = work.turns.map((t) => `[${t.t}] ${t.speaker}: ${t.text}`).join("\n");
    const vis = work.visuals.length ? "\n\n畫面上出現、講者沒有唸出來的文字：\n" + work.visuals.map((v) => `[${v.t}] ${v.text}`).join("\n") : "";
    const prompt =
      `下面是一支影片的完整逐字稿，每一行開頭的方括號是該段開始的秒數。請幫一位正在找 product-market fit 的一人創業者整理這支影片，讓他能很快判斷值不值得細看。\n\n` +
      `輸出 JSON：\n{"lang":"<逐字稿語言的 BCP-47 代碼，例如 en、zh-TW、ja>","title":"<影片標題，若逐字稿看不出來就寫最貼切的一句>",` +
      `"host":"<訪問者或主持人的 speaker 標籤，沒有就寫空字串>","thesis":"<一句話講完整支影片的主張，60 字內>",` +
      `"tldr":["<重點 1>","<重點 2>","<重點 3>"],` +
      `"chapters":[{"t":<這一章開始的秒數，必須是逐字稿裡某一行的秒數>,"en":"<原文語言的短標題>","zh":"<10 字內的中文標題，具體講在談什麼>",` +
      `"sum":"<兩句話，75 字內，講者實際說了或做了什麼，帶具體的數字、名稱、做法>","take":"<一句 40 字內可帶走的原則；純閒聊、或內容本身沒有可帶走的道理就留空字串，不要硬湊>","worth":<1 到 3 的整數，3 是核心>}]}\n\n` +
      `規則：\n- 依主題切章，一章只講一件事。20 分鐘以內的影片切 3 到 6 章；更長的影片每章大約 3 到 15 分鐘。第一章從第一行的秒數開始。\n- worth 看的是「這一章對讀者有多少可以帶走的東西」：3 是核心論點或可以直接照做的方法，2 是有用的補充，1 是開場、閒聊、致謝這類可以跳過的。3 分最多佔三分之一，但整支影片最重要的那一章一定要是 3。\n- 講者是 "On screen" 的段落是畫面描述，照樣整理進章節。\n- ${STYLE}\n\n逐字稿：\n${lines}${vis}`;
    const out = await llmJSON(deps, prompt, 16000);
    const starts = work.turns.map((t) => t.t);
    const snap = (t) => starts.reduce((best, s) => (Math.abs(s - t) < Math.abs(best - t) ? s : best), starts[0]);
    let chapters = (Array.isArray(out.chapters) ? out.chapters : [])
      .map((c) => ({ t: snap(Number(c.t) || 0), en: String(c.en || ""), zh: String(c.zh || ""), sum: String(c.sum || ""), take: String(c.take || ""), worth: Math.min(3, Math.max(1, Math.round(Number(c.worth) || 1))) }))
      .sort((x, y) => x.t - y.t)
      .filter((c, i, arr) => i === 0 || c.t > arr[i - 1].t);
    if (!chapters.length) throw new Error("沒有產生章節，請重試。");
    chapters[0].t = starts[0];
    const segs = chapters.map((c, i) => {
      const end = i + 1 < chapters.length ? chapters[i + 1].t : Infinity;
      const turns = work.turns.filter((t) => t.t >= c.t && t.t < end)
        .map((t) => ({ sp: t.speaker, t: t.t, s: splitSentences(t.text).map((x) => [x, null]) }));
      return { id: "c" + i, t: c.t, title: c.zh || c.en, deep: false, turns };
    });
    const content = {
      vid: row.video_id, lang: String(out.lang || "en"), title: row.title || String(out.title || ""), channel: work.channel || "",
      duration: work.duration, host: String(out.host || ""), thesis: String(out.thesis || ""),
      tldr: (Array.isArray(out.tldr) ? out.tldr : []).map(String).slice(0, 3), chapters, segs, visuals: work.visuals,
    };
    return { status: "ready", title: content.title, content, work: { phase: "ready", channel: work.channel }, progress: { phase: "ready", done: 1, total: 1 }, error: null };
  }

  return {};
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
    const prompt =
      `把下面 ${batch.length} 個句子翻成繁體中文（台灣用語）。它們是同一段訪談或演講裡連續的句子。\n` +
      `輸出 JSON：{"zh":["<第 1 句的翻譯>", ...]}，陣列長度必須剛好是 ${batch.length}，順序一一對應。\n` +
      `規則：忠於原意，讀起來像人講的中文；不要加原文沒有的內容，不要省略；產品名、人名、技術名詞保留原文；口語的贅字可以順掉。\n\n` +
      `這一章的主題：${seg.title}\n\n` + batch.map((x, i) => `${i + 1}. ${x.p[0]}`).join("\n");
    const out = await llmJSON(deps, prompt, 12000);
    const zh = Array.isArray(out.zh) ? out.zh : [];
    if (zh.length !== batch.length) throw new Error("翻譯句數對不上（要 " + batch.length + " 句，拿到 " + zh.length + " 句），請重試。");
    batch.forEach((x, i) => { x.p[1] = String(zh[i] || "").trim() || x.p[0]; });
    const left = todo.length - batch.length;
    return { content, done: false, progress: { phase: "translate", done: total - left, total } };
  }

  const numbered = flat.map((x, i) => `${i}. ${seg.turns[x.ti].sp}: ${x.p[0]}`).join("\n");
  const prompt =
    `下面是影片其中一章的逐字稿，每句前面有編號。請幫一位正在找 product-market fit 的一人創業者讀懂它。\n\n` +
    `輸出 JSON：\n{"title":"<8 字內的中文標題，具體、有畫面>","spark":"<14 字內，這一章最值得記住的一句話>",` +
    `"sum":["<這段在說什麼 1>","<2>","<3>"],"core":"<一句話的第一性原理：這個做法為什麼成立的最根本理由>",` +
    `"chain":["<推理第 1 步：最基本的前提>","<第 2 步>","<第 3 步>","<第 4 步：結論>"],` +
    `"ask":"<一個把這個原理換到讀者自己身上的問題>","key":[<最能代表這一章的 1 到 2 個句子編號，要相鄰>],` +
    `"counter":"<站在反方，指出這個結論最弱的一個環節或不適用的情況，用一個問題結尾，100 字內>"}\n\n` +
    `規則：\n- core 和 chain 要從前提一步步推到結論，每一步都能獨立成立，不要只是換句話重複摘要。\n- 照內容本身的道理寫。如果這一章跟創業或做產品無關（例如故事、動畫、純示範），就講它本身的道理，ask 也問一般性的問題，不要硬套到創業上。\n- ${STYLE}\n\n這一章的主題：${seg.title}\n\n${numbered}`;
  const out = await llmJSON(deps, prompt, 6000);
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
