#!/usr/bin/env node
// Runs on Miranda's Mac, started every two minutes by launchd (see tools/local/setup.sh).
// A video pasted on the page waits in phase "local". This picks it up and does everything the cloud used to:
//   1. downloads the audio (yt-dlp) and transcribes it with Whisper, on this machine
//   2. has Claude Code (`claude -p`, her subscription) write the analysis, the same way the 36 videos were written
//      (docs/claude-analysis.md and her prompt in tests/fixtures/owner-prompt.txt)
//   3. builds the content with the same code the edge function uses (pipeline.js), and saves it as her
//   4. English videos: translates the transcript with Claude Code in the background, after the video is readable
// Nothing here needs a Gemini or Anthropic API key. It signs in as her (password from the macOS Keychain),
// so row-level security applies exactly as on the page.
//
//   node tools/local/worker.mjs            one round: every waiting video, then exit
//   node tools/local/worker.mjs --check    only checks that the tools and the sign-in work
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ingestStep, reprocessPatch, TRANSLATE_BATCH } from "../../supabase/functions/ingest/pipeline.js";
import { turnsFromSegments, analysisPrompt, readAnalysis, toTraditional } from "./lib.mjs";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "src/config.json"), "utf8"));
const HOME = os.homedir();
// ~/.reader-worker.json: {"email": "...", "whisper": "mlx|cpp|openai", "model": "...", "claudeModel": "...", "translate": true}
const SETTINGS = Object.assign({ email: "", whisper: "", model: "", claudeModel: "", translate: true },
  (() => { try { return JSON.parse(fs.readFileSync(path.join(HOME, ".reader-worker.json"), "utf8")); } catch { return {}; } })());
const WORK = path.join(HOME, "Library/Caches/reader-worker");
const TRIES = 3;
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------- Supabase, signed in as her ---------- */

let token = "";
async function signIn() {
  const { stdout } = await run("security", ["find-generic-password", "-s", "reader-worker", "-a", SETTINGS.email, "-w"]);
  const r = await fetch(CFG.supabaseUrl + "/auth/v1/token?grant_type=password", {
    method: "POST", headers: { apikey: CFG.supabaseAnonKey, "content-type": "application/json" },
    body: JSON.stringify({ email: SETTINGS.email, password: stdout.trim() }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("登入失敗：" + (j.error_description || j.msg || r.status));
  token = j.access_token;
}
async function rest(method, query, body) {
  const r = await fetch(CFG.supabaseUrl + "/rest/v1/videos?" + query, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { apikey: CFG.supabaseAnonKey, Authorization: "Bearer " + token, "content-type": "application/json", Prefer: "return=minimal" },
  });
  if (!r.ok) throw new Error("資料庫 " + method + " " + r.status + "：" + (await r.text()).slice(0, 300));
  return method === "GET" ? r.json() : null;
}
const save = (vid, patch) => rest("PATCH", "video_id=eq." + encodeURIComponent(vid), { ...patch, updated_at: new Date().toISOString() });

/* ---------- tools on this machine ---------- */

async function has(cmd) { try { await run("/bin/sh", ["-c", "command -v " + cmd]); return true; } catch { return false; } }
async function whisperKind() {
  if (SETTINGS.whisper) return SETTINGS.whisper;
  for (const [k, cmd] of [["mlx", "mlx_whisper"], ["cpp", "whisper-cli"], ["openai", "whisper"]]) if (await has(cmd)) return k;
  throw new Error("找不到 Whisper（mlx_whisper、whisper-cli 或 whisper）。");
}

// Long jobs print as they go, so the log shows where a slow run is.
function sh(cmd, args, opts = {}) {
  return new Promise((ok, bad) => {
    const p = spawn(cmd, args, { ...opts, stdio: [opts.input != null ? "pipe" : "ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; if (opts.echo) process.stderr.write(d); });
    if (opts.input != null) { p.stdin.write(opts.input); p.stdin.end(); }
    p.on("error", bad);
    p.on("close", (code) => (code === 0 ? ok(out) : bad(new Error(cmd + " 結束碼 " + code + "：" + err.slice(-600)))));
  });
}

async function download(vid, dir) {
  const out = path.join(dir, "audio.%(ext)s");
  await sh("yt-dlp", ["-f", "bestaudio", "-x", "--audio-format", "mp3", "--audio-quality", "5", "-o", out, "--no-playlist", "--quiet",
    "https://www.youtube.com/watch?v=" + vid]);
  const meta = JSON.parse(await sh("yt-dlp", ["-J", "--no-playlist", "--skip-download", "https://www.youtube.com/watch?v=" + vid]));
  return { file: path.join(dir, "audio.mp3"), title: meta.title || "", channel: meta.channel || meta.uploader || "", duration: Math.round(meta.duration || 0), lang: meta.language || "" };
}

// Whisper's own segments, as [{start, end, text}] in seconds, and the language it heard.
async function transcribe(file, dir, hint) {
  const kind = await whisperKind();
  const prompt = /^zh/i.test(hint || "") ? "以下是繁體中文的演講逐字稿，有標點符號。" : "";
  if (kind === "mlx") {
    await sh("mlx_whisper", [file, "--model", SETTINGS.model || "mlx-community/whisper-large-v3-turbo", "--output-format", "json", "--output-dir", dir,
      ...(prompt ? ["--initial-prompt", prompt] : []), "--condition-on-previous-text", "False"], { echo: true });
    const j = JSON.parse(fs.readFileSync(path.join(dir, "audio.json"), "utf8"));
    return { lang: j.language || hint, segments: j.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })) };
  }
  if (kind === "openai") {
    await sh("whisper", [file, "--model", SETTINGS.model || "turbo", "--output_format", "json", "--output_dir", dir,
      ...(prompt ? ["--initial_prompt", prompt] : []), "--condition_on_previous_text", "False"], { echo: true });
    const j = JSON.parse(fs.readFileSync(path.join(dir, "audio.json"), "utf8"));
    return { lang: j.language || hint, segments: j.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })) };
  }
  // whisper.cpp wants 16 kHz mono wav and a model file.
  const wav = path.join(dir, "audio.wav");
  await sh("ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-ar", "16000", "-ac", "1", wav]);
  const model = SETTINGS.model || path.join(HOME, ".cache/whisper/ggml-large-v3-turbo.bin");
  await sh("whisper-cli", ["-m", model, "-f", wav, "-l", "auto", "-oj", "-of", path.join(dir, "audio"), ...(prompt ? ["--prompt", prompt] : [])], { echo: true });
  const j = JSON.parse(fs.readFileSync(path.join(dir, "audio.json"), "utf8"));
  return { lang: (j.result && j.result.language) || hint,
    segments: j.transcription.map((s) => ({ start: s.offsets.from / 1000, end: s.offsets.to / 1000, text: s.text })) };
}

// One answer from Claude Code. No tools are allowed: everything it needs is in the prompt, and it only answers.
async function claude(prompt) {
  const args = ["-p", "--output-format", "json", "--disallowedTools", "Bash,Edit,Write,WebFetch,WebSearch,NotebookEdit"];
  if (SETTINGS.claudeModel) args.push("--model", SETTINGS.claudeModel);
  const out = JSON.parse(await sh("claude", args, { input: prompt, cwd: WORK }));
  if (out.is_error) throw new Error("Claude Code：" + String(out.result || out.subtype).slice(0, 300));
  return String(out.result || "");
}

// pipeline.js talks to Gemini through deps.fetch. Here that one call is answered by Claude Code instead,
// so the translation step runs unchanged: same prompt, same batches, same checks.
const viaClaude = {
  fetch: async (url, opt) => {
    const text = JSON.parse(opt.body).contents[0].parts.map((p) => p.text || "").join("");
    try {
      const answer = await claude(text + "\n\n只輸出 JSON，不要加任何說明或程式碼框。");
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: answer }] } }] }) };
    } catch (e) {
      return { ok: false, status: 503, json: async () => ({ error: { message: e.message } }) };
    }
  },
  geminiKey: "local", videoModel: "local", textModel: "local",
};

/* ---------- one video ---------- */

async function analyse(row) {
  const vid = row.video_id, dir = path.join(WORK, vid);
  fs.mkdirSync(dir, { recursive: true });
  const work = row.work || {};
  let base;   // what pipeline.js needs to build the content: turns, visuals, channel, duration, existing translations
  if (work.redo === "text" && row.content && Array.isArray(row.content.segs)) {
    base = { ...reprocessPatch(row, "text").work, title: row.title, lang: row.content.lang };
  } else {
    await save(vid, { progress: { phase: "listen", done: 0, total: null } });
    const a = await download(vid, dir);
    log(vid, "audio", a.duration + "s", a.title);
    await save(vid, { title: a.title || row.title || "", progress: { phase: "listen", done: 0, total: null } });
    const heard = await transcribe(a.file, dir, a.lang);
    let segments = heard.segments;
    if (/^zh/i.test(heard.lang)) segments = await toTraditional(segments);
    const turns = turnsFromSegments(segments, /^zh|^ja/i.test(heard.lang) ? "講者" : "Speaker");
    if (!turns.length) throw new Error("Whisper 沒有聽到任何內容。");
    base = { phase: "outline", turns, visuals: [], channel: a.channel, duration: a.duration || Math.ceil(segments[segments.length - 1].end),
      length: a.duration, zh: {}, title: a.title || row.title || "", lang: heard.lang };
    fs.writeFileSync(path.join(dir, "turns.json"), JSON.stringify(turns));
  }
  log(vid, "transcript", base.turns.length, "turns, language", base.lang);

  await save(vid, { title: base.title, progress: { phase: "write", done: 0, total: null } });
  const prompt = analysisPrompt(ROOT, base.turns, base.lang);
  let given, last;
  for (let i = 0; i < 2 && !given; i++) {
    try { given = readAnalysis(await claude(prompt), base.turns); } catch (e) { last = e; log(vid, "analysis try", i + 1, e.message); }
  }
  if (!given) throw last;
  given.lang = given.lang || base.lang;
  fs.writeFileSync(path.join(dir, "analysis.json"), JSON.stringify(given, null, 1));

  const { title, lang, ...w } = base;
  const built = await ingestStep({ video_id: vid, title, content: null, work: { ...w, phase: "outline", given } }, {});
  const english = built.work.phase === "translate";
  await save(vid, {
    title: built.title, status: "ready", content: built.content, error: null, fails: 0, lock_until: null,
    work: { phase: english && SETTINGS.translate ? "local_translate" : "ready", channel: built.work.channel || "", by: "claude", whisper: true },
    progress: english && SETTINGS.translate ? built.progress : { phase: "ready", done: 1, total: 1 },
  });
  log(vid, "ready:", built.content.segs.length, "sections");
  return english && SETTINGS.translate ? { ...row, title: built.title, status: "ready", content: built.content, work: { phase: "translate" } } : null;
}

async function translate(row) {
  let cur = row;
  for (let n = 0; n < 400; n++) {
    const patch = await ingestStep({ ...cur, work: { ...cur.work, phase: "translate" } }, viaClaude);
    cur = { ...cur, ...patch };
    const more = patch.work && patch.work.phase === "translate";
    await save(row.video_id, { content: cur.content, work: { phase: more ? "local_translate" : "ready", channel: cur.work.channel || "", by: "claude", whisper: true },
      progress: more ? patch.progress : { phase: "ready", done: 1, total: 1 } });
    log(row.video_id, "translated", patch.progress && patch.progress.done, "/", patch.progress && patch.progress.total);
    if (!more) return;
  }
}

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  if (!SETTINGS.email) throw new Error("~/.reader-worker.json 裡沒有 email。先跑 tools/local/setup.sh。");
  await signIn();
  if (process.argv.includes("--check")) {
    for (const c of ["yt-dlp", "ffmpeg", "claude"]) log(c, (await has(c)) ? "ok" : "缺少");
    log("whisper", await whisperKind().catch((e) => e.message));
    log("signed in as", SETTINGS.email);
    return;
  }
  const rows = await rest("GET", "select=video_id,url,title,status,work,content&or=(work->>phase.eq.local,work->>phase.eq.local_translate)&status=neq.error&order=updated_at");
  for (const row of rows) {
    const work = row.work || {};
    try {
      if (work.phase === "local_translate") { await translate(row); continue; }
      const tries = (work.tries || 0) + 1;
      await save(row.video_id, { work: { ...work, tries }, status: "processing" });
      log(row.video_id, "start, try", tries);
      const next = await analyse({ ...row, work: { ...work, tries } });
      if (next) await translate(next);
    } catch (e) {
      const tries = (work.tries || 0) + 1;
      log(row.video_id, "failed:", e.message);
      // Up to three rounds, then it stops and the page shows why. Tapping the video on the page starts it again.
      await save(row.video_id, tries >= TRIES && work.phase === "local"
        ? { status: "error", error: "你的 Mac 處理了 " + TRIES + " 次都沒有完成：" + e.message.slice(0, 300), work: { ...work, tries: 0 } }
        : { work: { ...work, tries } }).catch(() => {});
    }
  }
}

main().catch((e) => { log("worker:", e.message); process.exit(1); });
