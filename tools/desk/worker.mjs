#!/usr/bin/env node
// The desktop worker. Videos queued from the web page (status "desk") are picked up here and written with the
// Claude account this machine is signed in to:
//   captions (or, when there are none, the audio through Whisper) -> punctuation -> analysis -> ready -> translation.
//
//   node tools/desk/worker.mjs                 work through whatever is waiting, then exit (what the schedule runs)
//   node tools/desk/worker.mjs --dry <url>     do one video without touching the database; writes the result to a file
//       [--translate] [--out file.json]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ingestStep, parseVideoId, reprocessPatch } from '../../supabase/functions/ingest/pipeline.js';
import { ask as claudeAsk, CACHE } from './claude.mjs';
import * as T from './transcript.mjs';
import { analysisPrompt, translatePrompt, ANALYSIS_SCHEMA, TRANSLATE_SCHEMA, SYSTEM } from './prompts.mjs';

const MAIN = process.env.READER_DESK_MODEL || '';            // '' = whatever the CLI uses by default
const FAST = process.env.READER_DESK_FAST_MODEL || 'sonnet'; // punctuation and translation
const MAX_FAILS = 3;
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);

/* ---------- 1. the words ---------- */
export async function getTranscript(vid, dir, deps, step) {
  const f = path.join(dir, 'transcript.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  await step('desk-transcript');
  const i = await deps.info(vid);
  const track = T.pickTrack(i);
  let lines = track ? await deps.captions(vid, track, dir) : null;
  let source = lines ? (track.auto ? 'captions-auto' : 'captions') : 'whisper';
  if (!lines) {
    await step('desk-listen');
    log(vid, track ? '字幕抓不到，改用聽寫' : '沒有字幕，改用聽寫');
    lines = (await deps.whisper(vid, dir, i.language)).lines;
  }
  const cjk = T.isCJK(lines.map((l) => l.text).join(''));
  let fixed = 0, kept = 0;
  if (T.needsTidy(lines, cjk)) {
    await step('desk-tidy');
    ({ lines, fixed, kept } = await T.tidy(lines, cjk, { ask: deps.ask, model: FAST }));
    log(vid, `補標點：${fixed} 行補好，${kept} 行保留原樣`);
  }
  const turns = T.toTurns(lines, cjk);
  const out = { title: i.title, channel: i.channel, duration: i.duration || (turns.length ? turns[turns.length - 1].t + 30 : 0), source, turns, zh: {}, visuals: [] };
  fs.writeFileSync(f, JSON.stringify(out));
  return out;
}

/* ---------- 2. the analysis ---------- */
export async function analyse(t, dir, deps) {
  const f = path.join(dir, 'analysis.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const given = await deps.ask({ prompt: analysisPrompt(t), system: SYSTEM, schema: ANALYSIS_SCHEMA, model: MAIN, timeoutMs: 40 * 60000 });
  if (!given || !Array.isArray(given.sections) || !given.sections.length || !String(given.headline || '').trim()) throw new Error('分析沒有寫完整（缺標題或分段），請重試。');
  fs.writeFileSync(f, JSON.stringify(given));
  return given;
}

/* ---------- 3. put it in the shape the reader shows ---------- */
// pipeline.js does the assembling, exactly as it does for an analysis written by the backend: sections are snapped to
// the transcript, sentences are split and given their ids. The two fields it does not know are added afterwards.
export async function assemble({ vid, title, channel, duration, turns, given, zh = {}, visuals = [], source = '' }) {
  const row = { video_id: vid, title: title || '', content: null, work: { phase: 'outline', turns, visuals, channel: channel || '', duration, length: duration, given, zh } };
  const patch = await ingestStep(row, {});
  const c = patch.content;
  c.segs.forEach((g) => {
    const m = given.sections.filter((x) => String((x && x.title) || '').trim() === g.title).sort((a, b) => Math.abs(a.t - g.t) - Math.abs(b.t - g.t))[0];
    if (!m) return;
    const p = String(m.principle || '').trim(); if (p) g.principle = p;
    const terms = (Array.isArray(m.terms) ? m.terms : []).map((x) => ({ term: String((x && x.term) || '').trim(), note: String((x && x.note) || '').trim() })).filter((x) => x.term && x.note).slice(0, 6);
    if (terms.length) g.terms = terms;
  });
  const more = patch.work.phase === 'translate';
  return { status: 'ready', title: patch.title, content: c, error: null, progress: patch.progress, work: { phase: more ? 'desk-translate' : 'ready', channel: channel || '', by: 'claude', source } };
}

/* ---------- 4. translation, after the video is already readable ---------- */
export async function translateAll(content, deps, save) {
  const all = [], BATCH = 50, PARALLEL = 3;
  content.segs.forEach((g) => g.turns.forEach((tu) => tu.s.forEach((p) => { if (p) all.push({ p, title: g.title }); })));
  const todo = all.filter((x) => x.p[1] == null), batches = [];
  todo.forEach((x) => { const b = batches[batches.length - 1]; if (b && b.title === x.title && b.list.length < BATCH) b.list.push(x); else batches.push({ title: x.title, list: [x] }); });
  let done = all.length - todo.length;
  const one = async (b) => {
    const src = b.list.map((x) => x.p[0]);
    for (let i = 0; ; i++) {
      const out = await deps.ask({ prompt: translatePrompt(src, b.title), system: SYSTEM, schema: TRANSLATE_SCHEMA, model: FAST, timeoutMs: 10 * 60000 });
      const zh = Array.isArray(out.zh) ? out.zh : [];
      if (zh.length === src.length) { b.list.forEach((x, k) => { x.p[1] = String(zh[k] || '').trim() || x.p[0]; }); done += src.length; return; }
      if (i) throw new Error(`翻譯句數對不上（要 ${src.length} 句，拿到 ${zh.length} 句）`);
    }
  };
  for (let i = 0; i < batches.length; i += PARALLEL) {
    await Promise.all(batches.slice(i, i + PARALLEL).map(one));
    await save(done, all.length);
  }
  return all.length;
}

/* ---------- one video, start to finish ---------- */
export async function processRow(row, deps) {
  const vid = row.video_id, dir = path.join(CACHE, vid), req = String((row.work && row.work.req) || '');
  // Work kept from an earlier try is reused; a new request (a re-run asked for in the reader) starts clean.
  const mark = path.join(dir, 'req.txt');
  if (fs.existsSync(dir) && (!fs.existsSync(mark) || fs.readFileSync(mark, 'utf8') !== req)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(mark, req);
  const step = (phase) => deps.save(vid, { progress: { phase, done: 0, total: null }, lock_until: new Date(Date.now() + 60 * 60000).toISOString() });

  if (row.status === 'desk') {
    let t;
    if (row.work && row.work.redo === 'text' && row.content && Array.isArray(row.content.segs)) {
      const w = reprocessPatch(row, 'text').work;   // the transcript and translations the video already has
      t = { title: row.title || row.content.title, channel: w.channel, duration: w.duration, turns: w.turns, zh: w.zh, visuals: w.visuals, source: (row.work && row.work.source) || 'kept' };
    } else t = await getTranscript(vid, dir, deps, step);
    log(vid, `逐字稿 ${t.turns.length} 段（${t.source}），開始分析`);
    await step('desk-analysis');
    const given = await analyse(t, dir, deps);
    const patch = await assemble({ vid, ...t, given });
    await deps.save(vid, { ...patch, fails: 0, attempt: null, lock_until: patch.work.phase === 'ready' ? null : new Date(Date.now() + 60 * 60000).toISOString() });
    log(vid, `可以閱讀了：${patch.content.segs.length} 段`);
    row = { ...row, ...patch };
  }
  if (row.work && row.work.phase === 'desk-translate' && row.content) {
    const c = row.content;
    const total = await translateAll(c, deps, (done, n) => deps.save(vid, { content: c, progress: { phase: 'translate', done, total: n }, lock_until: new Date(Date.now() + 60 * 60000).toISOString() }));
    await deps.save(vid, { content: c, work: { ...row.work, phase: 'ready' }, progress: { phase: 'ready', done: 1, total: 1 }, fails: 0, lock_until: null });
    log(vid, `翻譯完成：${total} 句`);
  }
  return row;
}

/* ---------- the queue ---------- */
async function queue() {
  const { db, loggedIn } = await import('./supa.mjs');
  if (!loggedIn()) { log('桌機還沒登入 Reader。請執行：node tools/desk/login.mjs'); return; }
  const lock = path.join(CACHE, 'worker.pid'); fs.mkdirSync(CACHE, { recursive: true });
  if (fs.existsSync(lock)) { try { process.kill(+fs.readFileSync(lock, 'utf8'), 0); return; } catch (_) { /* that worker is gone */ } }
  fs.writeFileSync(lock, String(process.pid));
  const deps = { ask: claudeAsk, info: T.info, captions: T.captions, whisper: T.whisper, save: db.save };
  try {
    for (;;) {
      const rows = (await db.waiting()).filter((r) => !r.lock_until || new Date(r.lock_until).getTime() < Date.now());
      if (!rows.length) return;
      const pick = rows[0];
      if (!(await db.claim(pick.video_id, 60))) continue;
      const row = await db.row(pick.video_id);
      if (!row) continue;
      log(row.video_id, '開始', row.title || row.url);
      try { await processRow(row, deps); }
      catch (e) {
        const msg = e instanceof Error ? e.message : String(e), fails = (row.fails || 0) + 1, fresh = (await db.row(row.video_id)) || row;
        const trail = [...(Array.isArray(fresh.trail) ? fresh.trail : []), { at: new Date().toISOString(), phase: (fresh.progress && fresh.progress.phase) || 'desk', error: msg }].slice(-12);
        log(row.video_id, `失敗（第 ${fails} 次）：${msg}`);
        if (fails < MAX_FAILS) await db.save(row.video_id, { fails, trail, lock_until: new Date(Date.now() + 3 * 60000).toISOString() });
        else if (fresh.status === 'ready') await db.save(row.video_id, { fails: 0, trail, lock_until: null, work: { ...fresh.work, phase: 'ready' }, progress: { phase: 'ready', done: 1, total: 1 } });
        else await db.save(row.video_id, { status: 'error', error: `連續 ${MAX_FAILS} 次失敗，已停止：${msg}`, fails, trail, lock_until: null });
      }
    }
  } finally { fs.rmSync(lock, { force: true }); }
}

async function dry(argv) {
  const url = argv[argv.indexOf('--dry') + 1], vid = parseVideoId(url);
  if (!vid) throw new Error('這不是 YouTube 影片網址。');
  const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(CACHE, vid, 'content.json');
  let last = null;
  const deps = { ask: claudeAsk, info: T.info, captions: T.captions, whisper: T.whisper, save: async (_v, patch) => { if (patch.progress) log(vid, '進度', JSON.stringify(patch.progress)); if (patch.content) last = patch; } };
  let row = { video_id: vid, url, title: '', status: 'desk', work: { phase: 'desk', req: 'dry' }, content: null };
  if (!argv.includes('--translate')) { const save = deps.save; deps.save = async (v, p) => { await save(v, p); if (p.work && p.work.phase === 'desk-translate') p.work.phase = 'ready'; }; }
  row = await processRow(row, deps);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify((last && last.content) || row.content, null, 1));
  log(vid, '寫到', out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  (argv.includes('--dry') ? dry(argv) : queue()).catch((e) => { log('停止：', e instanceof Error ? e.message : e); process.exit(1); });
}
