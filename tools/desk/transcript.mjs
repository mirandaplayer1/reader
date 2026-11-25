// Gets the words of a video onto this machine. Captions first (seconds, free); when a video has none, the audio is
// downloaded and transcribed here with Whisper. Either way the result is a list of { t: seconds, text } lines.
import fs from 'fs';
import path from 'path';
import { run } from './claude.mjs';
import { tidyPrompt, SYSTEM } from './prompts.mjs';

const YT = process.env.READER_DESK_YTDLP || 'yt-dlp';
const WHISPER = process.env.READER_DESK_WHISPER || 'mlx_whisper';
const WHISPER_MODEL = process.env.READER_DESK_WHISPER_MODEL || 'mlx-community/whisper-large-v3-turbo';
const link = (vid) => 'https://www.youtube.com/watch?v=' + vid;
const last = (s) => String(s || '').trim().split('\n').pop().slice(0, 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function info(vid) {
  const { code, out, err } = await run(YT, ['-J', '--skip-download', '--no-warnings', '--no-playlist', link(vid)], { timeoutMs: 180000 });
  if (code !== 0) throw new Error('讀不到這支影片：' + last(err));
  const j = JSON.parse(out);
  return {
    title: j.title || '', channel: j.channel || j.uploader || '', duration: Math.round(j.duration || 0), language: j.language || '',
    subtitles: Object.keys(j.subtitles || {}).filter((k) => k !== 'live_chat'), auto: Object.keys(j.automatic_captions || {}),
  };
}

// The captions in the language that is actually spoken. A human-made track wins over the automatic one.
// Automatic tracks also come machine-translated into a hundred languages; those are never picked.
const base = (k) => String(k).toLowerCase().split('-')[0];
const ZH = ['zh-TW', 'zh-Hant', 'zh-HK', 'zh', 'zh-Hans', 'zh-CN'];
export function pickTrack(i) {
  const orig = i.auto.find((k) => /-orig$/.test(k));
  const want = base(i.language || '') || (orig ? base(orig) : '');
  const made = want ? i.subtitles.filter((k) => base(k) === want) : i.subtitles.length === 1 ? i.subtitles : [];
  if (made.length) return { key: ZH.find((k) => made.includes(k)) || made.find((k) => k === i.language) || made[0], auto: false };
  if (orig) return { key: orig, auto: true };
  const same = want && (i.auto.find((k) => k === i.language) || i.auto.find((k) => k.toLowerCase() === want));
  return same ? { key: same, auto: true } : null;
}

export function parseJson3(j) {
  const lines = [];
  for (const e of (j && j.events) || []) {
    if (!e.segs) continue;
    const text = e.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').replace(/^>>+\s*/, '').trim();
    if (!text || /^[\[(（【][^\])）】]*[\])）】]$/.test(text)) continue;   // "[Music]", "(applause)"
    const t = Math.max(0, Math.round((e.tStartMs || 0) / 1000));
    if (lines.length && lines[lines.length - 1].text === text) continue;
    lines.push({ t, text });
  }
  return lines;
}

export async function captions(vid, track, dir) {
  for (let i = 0; i < 2; i++) {
    fs.readdirSync(dir).filter((f) => f.endsWith('.json3')).forEach((f) => fs.rmSync(path.join(dir, f)));
    await run(YT, ['--skip-download', '--no-warnings', '--no-playlist', track.auto ? '--write-auto-subs' : '--write-subs',
      '--sub-langs', track.key, '--sub-format', 'json3', '-o', path.join(dir, 'cap'), link(vid)], { timeoutMs: 180000 });
    const f = fs.readdirSync(dir).find((x) => x.endsWith('.json3'));
    if (f) { const lines = parseJson3(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); if (lines.length > 5) return lines; }
    if (!i) await sleep(20000);   // YouTube answers "too many requests" now and then
  }
  return null;
}

export async function whisper(vid, dir, language) {
  fs.readdirSync(dir).filter((f) => f.startsWith('audio.')).forEach((f) => fs.rmSync(path.join(dir, f)));
  const dl = await run(YT, ['-f', 'bestaudio[ext=m4a]/bestaudio/best', '--no-playlist', '--no-warnings', '-o', path.join(dir, 'audio.%(ext)s'), link(vid)], { timeoutMs: 45 * 60000 });
  const audio = fs.readdirSync(dir).find((f) => f.startsWith('audio.'));
  if (!audio) throw new Error('下載不到聲音：' + last(dl.err));
  const lang = base(language || '');
  const args = [path.join(dir, audio), '--model', WHISPER_MODEL, '--output-format', 'json', '--output-dir', dir, '--output-name', 'whisper', '--verbose', 'False'];
  if (lang) args.push('--language', lang);
  if (lang === 'zh') args.push('--initial-prompt', '以下是繁體中文的逐字稿，有標點符號。');
  const w = await run(WHISPER, args, { timeoutMs: 4 * 3600000 });
  const out = path.join(dir, 'whisper.json');
  if (!fs.existsSync(out)) throw new Error('聽寫沒有完成：' + last(w.err));
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.rmSync(path.join(dir, audio));
  const lines = (j.segments || []).map((s) => ({ t: Math.max(0, Math.round(s.start || 0)), text: String(s.text || '').trim() })).filter((l) => l.text);
  if (!lines.length) throw new Error('這支影片沒有偵測到任何語音內容。');
  return { lines, language: j.language || lang };
}

export const isCJK = (text) => { const s = String(text).slice(0, 6000); return (s.match(/[぀-ヿ㐀-鿿]/g) || []).length > s.length * 0.2; };
const SIMPLIFIED = /[这们说时会对为过还个来国学经发问题样点关开间实应动种机]/g;
export function needsTidy(lines, cjk) {
  const text = lines.map((l) => l.text).join(' ');
  const marks = (text.match(/[.?!,;:。？！，；：、]/g) || []).length;
  if (cjk) return marks < text.length * 0.02 || (text.match(SIMPLIFIED) || []).length > text.length * 0.01;
  return marks < text.split(/\s+/).length * 0.04;
}

// Adds punctuation with Claude, a hundred lines at a time. Every returned line is checked against the original:
// if a single word was added, dropped or changed, the original line is kept instead.
const letters = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export async function tidy(lines, cjk, { ask, model, onProgress }) {
  const SIZE = 100, PARALLEL = 3, out = lines.map((l) => ({ ...l }));
  const chunks = []; for (let i = 0; i < lines.length; i += SIZE) chunks.push([i, lines.slice(i, i + SIZE)]);
  let fixed = 0, kept = 0, done = 0;
  const one = async ([at, part]) => {
    let text = '';
    try { text = await ask({ prompt: tidyPrompt(part, cjk), system: SYSTEM, model, timeoutMs: 10 * 60000 }); } catch (_) { /* this chunk stays as it was */ }
    const got = String(text).split('\n').map((l) => /^\s*\[(\d+)\]\s?(.*)$/.exec(l)).filter(Boolean).map((m) => m[2].trim());
    part.forEach((l, k) => {
      const g = got.length === part.length ? got[k] : '';
      const ok = g && (cjk ? letters(g).length === letters(l.text).length : letters(g) === letters(l.text));
      if (ok) { out[at + k].text = g; fixed++; } else kept++;
    });
    if (onProgress) onProgress(++done, chunks.length);
  };
  for (let i = 0; i < chunks.length; i += PARALLEL) await Promise.all(chunks.slice(i, i + PARALLEL).map(one));
  return { lines: out, fixed, kept };
}

// Caption lines are a few words each. Reading needs longer turns that end where a sentence ends.
const END = /[.!?。！？…]["”’」』)）]*$/;
export function toTurns(lines, cjk, speaker = '講者') {
  const out = []; let cur = null;
  lines.forEach((l, i) => {
    if (!cur) cur = { t: l.t, speaker, text: l.text }; else cur.text += (cjk ? '' : ' ') + l.text;
    const next = lines[i + 1], span = (next ? next.t : l.t) - cur.t;
    if (!next || (span >= 25 && END.test(cur.text)) || span >= 75) { out.push(cur); cur = null; }
  });
  return out;   // each turn starts at least 25 seconds after the one before, so start times never repeat
}
