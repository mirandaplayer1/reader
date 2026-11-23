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
const CHECK = OBJ({ solid: LIST(STR), assumptions: LIST(STR), evidence: LIST(STR), contradictions: LIST(STR) });
const META = { lang: STR, title: STR, host: STR, headline: STR, principle: STR, groups: LIST(OBJ({ title: STR, points: LIST(STR) })), reminder: STR, check: CHECK };
const TABLES = LIST(OBJ({ title: STR, headers: LIST(STR), rows: LIST(OBJ({ cells: LIST(STR) })) }));
const SECTION_ITEM = OBJ({ t: INT, title: STR, role: STR, points: LIST(STR), tables: TABLES });
const SCHEMA = {
  full: OBJ({ ...META, sections: LIST(SECTION_ITEM) }),
  sections: OBJ({ sections: LIST(SECTION_ITEM) }),
  synth: OBJ(META),
  translate: OBJ({ zh: LIST(STR) }),
  analysis: OBJ({ role: STR, points: LIST(STR), tables: TABLES }),
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

// The owner's prompt (2026-11-23), whole and WORD FOR WORD, up to where the transcript is pasted in. Do not edit it:
// tests compare it with tests/fixtures/owner-prompt.txt. It goes out once with the whole transcript, and the model
// decides where the sections are. What the app adds comes after it: which heading goes into which JSON field.
const OWNER = `# 任務
分析下方的逐字稿，產出兩份成果：(A) 第一性原理摘要，(B) 分段整理。最後附上 (C) 推論強弱檢查。

# 寫作規範
- 使用繁體中文，句子要完整、流暢。不要用箭頭、破折號串接的片段或電報式縮寫；靠清楚的結構維持資訊密度，不要靠壓縮。
- 避免 AI 腔：不用「這不是 X，而是 Y」的對仗句，不寫勵志式結尾，不把原文換句話說再倒回來。
- 忠於原文：轉述講者主張時，強度、範圍和條件都要與原文一致，不可放大或縮小。特別注意：
  - 實踐步驟要照原文的起手份量寫。講者說「從一個資料夾開始」，就不能寫成「匯出五年紀錄」。
  - 講者明說的限制、例外與自我警告要保留。
  - 不要寫成講者沒有宣稱過的絕對說法，例如「永遠不會過時」。
- 術語一致：同一個詞在全文只能指同一件事。若講者用兩個相近的詞指不同東西（例如知識庫與資料庫），要分清楚。
- 數字、人名、案例要和逐字稿一致，不可補充原文沒有的資訊。

# 步驟一：先拆解（不輸出，作為內部工作）
1. 找出講者整場論證的最終結論，一句話就要能說完。
2. 往回推：要讓這個結論成立，至少需要哪些不可再化約的前提？只保留真正承擔邏輯負荷的前提，通常是 2 到 4 個。
3. 把前提到結論之間的推論步驟排成一條鏈，檢查每一步都能從上一步推得。如果某個關鍵前提只在標題或口號裡出現、沒有進入推論，就把它放回推論鏈。
4. 區分三種內容：承擔推論的主張、用來佐證的案例或數據、只提供情感或修辭作用的故事與隱喻。
5. 找出講者架構裡最核心的那個「瓶頸」或「關鍵機制」，並確認你對它的理解沒有和原文相反。

# 步驟二：輸出 (A) 第一性原理摘要
格式如下：

**標題**：兩句話。第一句講核心判斷，第二句講這帶來什麼能力或結果。

**第一性原理**：一段完整的散文，4 到 6 句，依序寫出前提、瓶頸、機制、複利或後果，讓讀者讀完就能自己重建整條推論。

接著依講者內容分成 3 到 5 個主題區塊（例如：起點、核心架構、實踐步驟、產權與防禦），每個區塊 2 到 5 個條列。每個條列寫成完整句子，格式為「概念：一句說明」。凡是講者提出的「機制」，都要寫出它怎麼運作，不能只寫名稱。

**核心提醒**：一句可以立即執行的行動。

# 步驟三：輸出 (B) 分段整理
- 依逐字稿的原始段落（含時間戳）逐段整理。若原文沒有分段，就依主題轉折自行分段並標註。
- 每段先寫一兩句說明這段在整體論證中的作用，再整理重點。
- 遇到核心概念時，先給心智模型或類比，再講細節。
- 適合比較的內容（例如講者回應的質疑、兩種對照情境）用表格呈現。
- 引用原文要短，盡量轉述。

# 步驟四：輸出 (C) 推論強弱檢查
針對步驟一的推論鏈，逐環標出：
- 哪幾環邏輯最穩，為什麼。
- 哪幾環藏有未說明的假設。
- 哪些證據來自講者本人或其利益相關機構、只能證明相關性，或無法歸因。
- 講者的主張和他自己的做法或其他段落之間，有沒有矛盾。
直接點出問題，不需要迴避或平衡措辭。

# 最後自我檢查（不輸出）
逐條比對 (A) 和 (B) 的每個條列與逐字稿：是否有誇大、誤讀、遺漏講者的限制條件，或術語前後不一致？發現問題就修正後再輸出。`;
// For the cases that cannot be one request (a very long video, or one section written again), her own parts are reused.
const part = (name) => OWNER.split(/\n\n(?=# )/).find((x) => x.startsWith("# " + name));
const RULES = part("寫作規範"), DECOMPOSE = part("步驟一"), BRIEF = part("步驟二"), SECTION = part("步驟三"), CHECK_SPEC = part("步驟四"), SELF_CHECK = part("最後自我檢查");

const tidyTables = (list) => (Array.isArray(list) ? list : []).map((t) => {
  const headers = (Array.isArray(t && t.headers) ? t.headers : []).map(String).slice(0, 5);
  const rows = (Array.isArray(t && t.rows) ? t.rows : []).map((r) => (Array.isArray(r && r.cells) ? r.cells : []).map(String).slice(0, headers.length)).filter((r) => r.length === headers.length && r.some(Boolean)).slice(0, 8);
  return { title: String((t && t.title) || ""), headers, rows };
}).filter((t) => t.headers.length >= 2 && t.rows.length >= 2).slice(0, 3);
const tidyPoints = (list) => (Array.isArray(list) ? list : []).map(String).filter(Boolean).slice(0, 12);

/* ---------- ingest: meta -> transcribe (chunk by chunk) -> outline (the whole analysis, one request) -> ready (-> translate, in the background) ---------- */

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

  // The whole analysis is one request: her prompt, then the whole transcript. The model finds the sections itself.
  const WINDOW = 3600, ONE_REQUEST = 100 * 60;   // a longer video cannot be answered inside the platform's time limit in one go
  const META_SPEC =
    `"lang":"<逐字稿語言的 BCP-47 代碼，例如 en、zh-TW、ja>","title":"<影片標題，看不出來就寫最貼切的一句>",` +
    `"host":"<訪問者或主持人的 speaker 標籤，沒有就寫空字串>",` +
    `"headline":"<(A) 的標題>","principle":"<(A) 的第一性原理>","groups":[{"title":"<主題區塊的名稱>","points":["<條列>"]}],"reminder":"<(A) 的核心提醒>",` +
    `"check":{"solid":["<邏輯最穩的一環和原因>"],"assumptions":["<未說明的假設>"],"evidence":["<證據的問題>"],"contradictions":["<矛盾>"]}`;
  const SECTION_SPEC =
    `{"t":<這一段開始的秒數，必須是逐字稿裡某一行開頭方括號裡的數字>,"title":"<你為這一段標註的標題>","role":"<這段在整體論證中的作用>","points":["<重點>"],` +
    `"tables":[{"title":"<表格標題>","headers":["<欄名>"],"rows":[{"cells":["<儲存格>"]}]}]}`;
  const OUT_A = `(A) 的標題放 headline，第一性原理放 principle，主題區塊放 groups（每個區塊的名稱放 title，條列放 points），核心提醒放 reminder。`;
  const OUT_B = `(B) 的每一段是 sections 裡的一項，照時間順序，第一段從逐字稿第一行開始，整份逐字稿都要分到：t 是這一段開始的秒數，title 是這一段的標題，這段的作用放 role，重點放 points（條列），表格放 tables（每個表格有 title、headers、rows，rows 的每一列是 cells）；這一段沒有表格就給空陣列。`;
  const OUT_C = `(C) 的四項依序放 check 的 solid、assumptions、evidence、contradictions，每一項都是條列；哪一項沒有內容就給空陣列。`;
  const STAMP = `每一行開頭的方括號是那一行開始的秒數，這就是時間戳。`;
  const lines = (turns) => turns.map((t) => `[${t.t}] ${t.speaker}: ${t.text}`).join("\n");
  const visLines = (a, b) => { const v = work.visuals.filter((x) => x.t >= a && x.t < b); return v.length ? "\n\n畫面上出現、講者沒有唸出來的文字：\n" + v.map((x) => `[${x.t}] ${x.text}`).join("\n") : ""; };

  const finish = (meta, list) => {
    const starts = work.turns.map((t) => t.t);
    const snap = (t) => starts.reduce((best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best), starts[0]);
    const sections = (Array.isArray(list) ? list : [])
      .map((x) => ({ t: snap(Number(x && x.t) || 0), title: String((x && x.title) || "").trim(), role: String((x && x.role) || ""), points: tidyPoints(x && x.points), tables: tidyTables(x && x.tables) }))
      .filter((x) => x.title).sort((x, y) => x.t - y.t).filter((x, i, arr) => i === 0 || x.t > arr[i - 1].t);
    if (!sections.length) throw new Error("沒有產生分段，請重試。");
    sections[0].t = starts[0];
    const chapters = sections.map((x) => ({ t: x.t, en: "", zh: x.title, sum: x.role, take: "", worth: 2 }));
    const segs = sections.map((x, i) => {
      const end = i + 1 < sections.length ? sections[i + 1].t : Infinity;
      const turns = work.turns.filter((t) => t.t >= x.t && t.t < end)
        .map((t) => ({ sp: t.speaker, t: t.t, s: splitSentences(t.text).map((y) => [y, (work.zh && work.zh[y]) || null]) }));
      return { id: "c" + i, t: x.t, title: x.title, deep: true, role: x.role, points: x.points, tables: x.tables, turns };
    });
    const content = {
      vid: row.video_id, lang: String(meta.lang || "en"), title: row.title || String(meta.title || ""), channel: work.channel || "",
      duration: work.duration, host: String(meta.host || ""), thesis: String(meta.headline || ""), tldr: [],
      brief: {
        principle: String(meta.principle || ""), reminder: String(meta.reminder || ""),
        groups: (Array.isArray(meta.groups) ? meta.groups : []).slice(0, 6)
          .map((g) => ({ title: String((g && g.title) || ""), points: (Array.isArray(g && g.points) ? g.points : []).map(String).filter(Boolean).slice(0, 6) }))
          .filter((g) => g.points.length),
        check: Object.fromEntries(["solid", "assumptions", "evidence", "contradictions"].map((k) => [k, (Array.isArray(meta.check && meta.check[k]) ? meta.check[k] : []).map(String).filter(Boolean).slice(0, 8)])),
      },
      chapters, segs, visuals: work.visuals,
    };
    // Everything is written. What can still follow, in the background, is the translation of an English transcript.
    const same = /^zh/i.test(content.lang);
    let total = 0, have = 0;
    segs.forEach((g) => g.turns.forEach((tu) => tu.s.forEach((p) => { if (same && p[1] == null) p[1] = p[0]; total++; if (p[1] != null) have++; })));
    const more = !same && have < total;
    return { status: "ready", title: content.title, content, work: { phase: more ? "translate" : "ready", channel: work.channel },
      progress: more ? { phase: "translate", done: have, total } : { phase: "ready", done: 1, total: 1 }, error: null };
  };

  if (work.phase === "outline" || work.phase === "seams" || work.phase === "synth") {
    // An analysis written outside (work.given, in the same shape the model returns) is used as it is: no request is made.
    // It can be put on a finished video directly; the transcript is then taken from what the video already has.
    if (!work.turns.length && row.content) Object.assign(work, reprocessPatch(row, "text").work, { given: work.given });
    if (work.given && Array.isArray(work.given.sections)) return finish(work.given, work.given.sections);
    const first = work.turns[0].t, last = work.turns[work.turns.length - 1].t;
    if (last - first <= ONE_REQUEST) {
      const prompt =
        `${OWNER}\n\n# 輸出\n把三份成果放進下面這個 JSON。${OUT_A}${OUT_B}${OUT_C}\nJSON：{${META_SPEC},"sections":[${SECTION_SPEC}]}\n\n` +
        `# 逐字稿\n${STAMP}\n<transcript>\n${lines(work.turns)}${visLines(0, Infinity)}\n</transcript>`;
      const out = await llmJSON(deps, prompt, 32768, SCHEMA.full);
      return finish(out, out.sections);
    }
    // Too long for one answer: (A) and (C) are written from the whole transcript, (B) an hour at a time, all at the same moment.
    const windows = Math.ceil((last - first + 1) / WINDOW);
    const overview = llmJSON(deps,
      `# 任務\n分析下方的逐字稿，產出兩份成果：(A) 第一性原理摘要，(C) 推論強弱檢查。這份逐字稿很長，(B) 分段整理另外處理，這一次不用寫。\n\n` +
      `${RULES}\n\n${DECOMPOSE}\n\n${BRIEF}\n\n${CHECK_SPEC}\n\n${SELF_CHECK}\n\n# 輸出\n把成果放進下面這個 JSON。${OUT_A}${OUT_C}\nJSON：{${META_SPEC}}\n\n` +
      `# 逐字稿\n<transcript>\n${work.turns.map((t) => `${t.speaker}: ${t.text}`).join("\n").slice(0, 600000)}\n</transcript>`, 16000, SCHEMA.synth);
    const cuts = Array.from({ length: windows }, (_, w) => {
      const a = first + w * WINDOW, b = a + WINDOW, some = work.turns.filter((t) => t.t >= a && t.t < b);
      if (!some.length) return Promise.resolve({ sections: [] });
      return llmJSON(deps,
        `# 任務\n分析下方的逐字稿，產出 (B) 分段整理。這是一支長影片逐字稿的第 ${w + 1} 部分（共 ${windows} 部分），這一次只整理這一部分。\n\n` +
        `${RULES}\n\n${SECTION}\n\n${SELF_CHECK}\n\n# 輸出\n把成果放進下面這個 JSON。${OUT_B}\nJSON：{"sections":[${SECTION_SPEC}]}\n\n` +
        `# 逐字稿\n${STAMP}\n<transcript>\n${lines(some)}${visLines(a, b)}\n</transcript>`, 24000, SCHEMA.sections);
    });
    const [meta, ...parts] = await Promise.all([overview, ...cuts]);
    return finish(meta, parts.flatMap((x) => (Array.isArray(x.sections) ? x.sections : [])));
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

const NOTES_PARALLEL = 8;   // chapter notes written at the same time, once nothing is left to translate
const sameLangOf = (c) => /^zh/i.test(c.lang || "") || c.segs.every((g) => g.turns.every((tu) => tu.s.every((p) => p[1] != null)));
const CHAPTER_TRIES = 3;   // a chapter that keeps failing is left for the button in the reader

async function analyseStep(row, work, deps) {
  const content = row.content, channel = work.channel || "";
  const finished = { work: { phase: "ready", channel }, progress: { phase: "ready", done: 1, total: 1 } };
  if (!content || !Array.isArray(content.segs)) return finished;
  const tries = Object.assign({}, work.tries);
  const open = content.segs.map((g, i) => (g.deep === false && (tries[i] || 0) < CHAPTER_TRIES ? i : -1)).filter((i) => i >= 0);
  if (!open.length) return finished;
  // Chapters tried least go first, so one that keeps failing cannot hold up the ones after it.
  const ks = open.sort((x, y) => (tries[x] || 0) - (tries[y] || 0) || x - y).slice(0, sameLangOf(content) ? NOTES_PARALLEL : PARALLEL);
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
  const brief = content.brief || {};
  const prompt =
    `# 任務\n分析下方的逐字稿，產出 (B) 分段整理。這份逐字稿是一支影片依主題轉折分好的其中一段，這一次只整理這一段。整支影片的 (A) 第一性原理摘要已經寫好，附在下面，讓你知道整體論證。\n\n` +
    `${RULES}\n\n${SECTION}\n\n${SELF_CHECK}\n\n` +
    `# 輸出\n這段在整體論證中的作用放 role，重點放 points（條列），表格放 tables（每個表格有 title、headers、rows，rows 的每一列是 cells）；沒有表格就給空陣列。\n` +
    `JSON：{"role":"<這段在整體論證中的作用>","points":["<重點>"],"tables":[{"title":"<表格標題>","headers":["<欄名>"],"rows":[{"cells":["<儲存格>"]}]}]}\n\n` +
    `# 整支影片的 (A) 第一性原理摘要\n${content.thesis || ""}\n${brief.principle || ""}\n\n這一章的主題：${seg.title}\n這一段開始的時間：${clock(seg.t)}\n\n# 逐字稿\n<transcript>\n${numbered}\n</transcript>`;
  const out = await llmJSON(deps, prompt, 8000, SCHEMA.analysis);
  ["spark", "sum", "core", "chain", "ask", "counter", "key"].forEach((k) => { delete seg[k]; });   // the shape this replaced
  Object.assign(seg, { deep: true, role: String(out.role || ""), points: tidyPoints(out.points), tables: tidyTables(out.tables) });
  const ch = (content.chapters || []).find((c) => c.t === seg.t); if (ch) ch.sum = seg.role;
  if (sameLang) seg.turns.forEach((tu) => tu.s.forEach((p) => { if (p[1] == null) p[1] = p[0]; }));
  return { content, done: true, progress: { phase: "ready", done: total, total } };
}
