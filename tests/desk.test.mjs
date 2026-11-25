// The desktop worker with everything outside it faked: no YouTube, no Whisper, no Claude, no database.
// Proves the plumbing: which captions are picked, that punctuation can never change a word, that a queued video
// ends up readable with every section's terms, and that translation fills every sentence.
import fs from 'fs';
import os from 'os';
import path from 'path';
process.env.READER_DESK_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-desk-test-'));
const T = await import('../tools/desk/transcript.mjs');
const W = await import('../tools/desk/worker.mjs');
const P = await import('../tools/desk/prompts.mjs');
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };

// --- which captions
const pick = (language, subtitles, auto) => T.pickTrack({ language, subtitles, auto });
assert(pick('en', ['ar', 'en', 'ja'], ['en', 'zh-Hant']).key === 'en' && !pick('en', ['en'], []).auto, 'human captions in the spoken language win');
assert(pick('en', ['ja'], ['en-orig', 'en', 'ja']).key === 'en-orig', 'a human translation is not the transcript');
assert(pick('', [], ['zh-Hant-orig', 'en', 'zh-Hant']).key === 'zh-Hant-orig', 'the original automatic track');
assert(pick('zh', ['zh-Hans', 'zh-TW'], []).key === 'zh-TW', 'Taiwan captions first');
assert(pick('', [], ['en', 'ja', 'zh-Hant']) === null && pick('', [], []) === null, 'machine-translated tracks alone mean: listen instead');
console.log('tracks ok');

// --- caption file -> lines
const lines0 = T.parseJson3({ events: [{ tStartMs: 0, segs: [{ utf8: '[Music]' }] }, { tStartMs: 1200, segs: [{ utf8: 'i am honored' }, { utf8: ' to be with you' }] }, { tStartMs: 1300, aAppend: 1, segs: [{ utf8: '\n' }] },
  { tStartMs: 4000, segs: [{ utf8: '>> today at your\ncommencement' }] }, { tStartMs: 4000, segs: [{ utf8: 'today at your commencement' }] }] });
assert(JSON.stringify(lines0) === JSON.stringify([{ t: 1, text: 'i am honored to be with you' }, { t: 4, text: 'today at your commencement' }]), 'json3 ' + JSON.stringify(lines0));

// --- punctuation: only lines whose words are untouched are accepted
const raw = Array.from({ length: 230 }, (_, i) => ({ t: i * 3, text: i % 2 ? 'never graduated from high school she' : 'from college and that my father had' }));
assert(T.needsTidy(raw, false) && !T.needsTidy([{ t: 0, text: 'This is fine. It has commas, and stops.' }], false), 'needsTidy');
let tidyCalls = 0;
const tidyAsk = async ({ prompt }) => { tidyCalls++;
  const part = prompt.split('<lines>\n')[1].split('\n</lines>')[0].split('\n');
  if (tidyCalls === 3) return 'Sorry, here is a summary instead.';                                 // a whole chunk goes wrong
  return part.map((l, i) => i === 4 ? l.replace('father', 'dad') : l.replace(/\] (.)/, (_, c) => '] ' + c.toUpperCase()) + (i % 2 ? '.' : ',')).join('\n'); };
const tidied = await T.tidy(raw, false, { ask: tidyAsk, model: 'x' });
assert(tidied.lines.length === raw.length && tidied.lines.every((l, i) => l.t === raw[i].t), 'tidy keeps every line and time');
assert(tidied.lines.every((l, i) => l.text.toLowerCase().replace(/[^a-z]/g, '') === raw[i].text.replace(/[^a-z]/g, '')), 'tidy never changes a word');
assert(tidied.lines[0].text === 'From college and that my father had,' && tidied.lines[4].text === raw[4].text && tidied.kept === 32, 'changed lines fall back: kept ' + tidied.kept);
const turns = T.toTurns(tidied.lines, false);
assert(turns.length > 5 && turns.every((t, i) => !i || t.t > turns[i - 1].t) && turns.map((t) => t.text).join(' ') === tidied.lines.map((l) => l.text).join(' '), 'turns keep every word, in order');
assert(T.toTurns([{ t: 0, text: '第一句。' }, { t: 3, text: '第二句' }], true)[0].text === '第一句。第二句', 'Chinese joins without spaces');
assert(T.isCJK('這是一段中文的逐字稿') && !T.isCJK('this is english with 一 char'), 'isCJK');
console.log('tidy ok: calls', tidyCalls, '| fixed', tidied.fixed, '| kept', tidied.kept, '| turns', turns.length);

// --- the prompt carries her text unchanged, then the additions
const her = fs.readFileSync(new URL('./fixtures/owner-prompt.txt', import.meta.url), 'utf8'), owner = her.slice(0, her.indexOf('\n\n# 逐字稿'));
const prompt = P.analysisPrompt({ title: 'T', channel: 'C', turns: [{ t: 0, speaker: '講者', text: 'Hello.' }, { t: 30, speaker: '講者', text: 'World.' }] });
assert(prompt.startsWith(owner), 'her prompt comes first, word for word');
assert(prompt.includes(P.SECTION_EXTRA) && prompt.includes('[0] Hello.\n[30] World.'), 'additions and transcript, no made-up speaker label');
assert(P.analysisPrompt({ turns: [{ t: 0, speaker: 'Lex', text: 'Hi.' }] }).includes('[0] Lex: Hi.'), 'real speakers are kept');

// --- a queued video, start to finish
const saved = []; let asks = { tidy: 0, analysis: 0, translate: 0 }, listened = 0;
const capLines = Array.from({ length: 120 }, (_, i) => ({ t: i * 5, text: `this is line ${i} of the talk and it goes on` }));
const given = { lang: 'en', headline: '標題。第二句。', principle: '原理。', groups: [{ title: '起點', points: ['甲：一。'] }], reminder: '提醒。',
  check: { solid: ['穩'], assumptions: [], evidence: [], contradictions: [] },
  sections: [{ t: 0, title: '開場', body: '第一段。\n\n- a\n- b', principle: '這一段靠甲成立。', terms: [{ term: 'conatus', note: '延續自身的驅力。' }, { term: '', note: 'x' }] },
    { t: 301, title: '第二段', body: '第二段。', principle: '', terms: [] }] };
const deps = {
  info: async () => ({ title: 'A Talk', channel: 'Chan', duration: 600, language: 'en', subtitles: ['en'], auto: [] }),
  captions: async () => capLines,
  whisper: async () => { listened++; return { lines: capLines, language: 'en' }; },
  ask: async ({ prompt, schema }) => {
    if (!schema) { asks.tidy++; return prompt.split('<lines>\n')[1].split('\n</lines>')[0].split('\n').map((l) => l + '.').join('\n'); }
    if (schema === P.ANALYSIS_SCHEMA) { asks.analysis++; return given; }
    asks.translate++; const n = prompt.split('\n').filter((l) => /^\d+\. /.test(l)).length;
    return { zh: asks.translate === 1 ? ['少一句'] : Array.from({ length: n }, (_, i) => '譯' + i) };   // the first answer is short: asked again
  },
  save: async (vid, patch) => { saved.push(JSON.parse(JSON.stringify(patch))); },
};
const row = await W.processRow({ video_id: 'AAAAAAAAAAA', url: 'u', title: '', status: 'desk', work: { phase: 'desk', req: '1' }, content: null }, deps);
const phases = saved.map((p) => p.progress && p.progress.phase).filter(Boolean);
assert(phases.join(',').startsWith('desk-transcript,desk-tidy,desk-analysis,translate'), 'progress the reader shows: ' + phases.join(','));
const ready = saved.find((p) => p.status === 'ready'), c = row.content;
assert(ready && ready.work.phase === 'desk-translate' && ready.work.by === 'claude' && ready.work.source === 'captions', 'readable before translation; never a phase the backend would pick up');
assert(c.title === 'A Talk' && c.channel === 'Chan' && c.thesis === '標題。第二句。' && c.brief.principle === '原理。' && c.segs.length === 2, 'overview and sections');
assert(c.segs[0].body.startsWith('第一段') && !('principle' in c.segs[0]) && c.segs[0].terms.length === 1 && c.segs[0].terms[0].term === 'conatus', 'section terms; a principle the model adds anyway is not kept');
assert(!('terms' in c.segs[1]) && c.segs[1].t === 300, 'empty extras are left out; section snapped to a real line');
const sents = c.segs.flatMap((g) => g.turns.flatMap((tu) => tu.s));
assert(sents.length > 100 && sents.every((p) => p[1] && p[1].startsWith('譯')), 'every sentence translated');
const end = saved[saved.length - 1];
assert(end.work.phase === 'ready' && end.progress.phase === 'ready' && end.lock_until === null && listened === 0, 'finished, lock released, never listened when captions exist');
console.log('queue ok: saves', saved.length, '| asks', JSON.stringify(asks), '| sentences', sents.length);

// --- no captions -> listen; and a second try reuses what the first one finished
const deps2 = { ...deps, info: async () => ({ title: '中文課', channel: 'NTU', duration: 600, language: '', subtitles: [], auto: [] }), captions: async () => { throw new Error('must not be called'); },
  whisper: async () => { listened++; return { lines: [{ t: 0, text: '今天我們講供給和需求。' }, { t: 40, text: '價格上升，需求量就下降。' }], language: 'zh' }; },
  ask: async ({ schema }) => { assert(schema === P.ANALYSIS_SCHEMA, 'punctuated Chinese needs no tidy or translation'); asks.analysis++; if (asks.analysis === 2) throw new Error('Claude 沒有回應'); return { ...given, lang: 'zh-TW', sections: [{ t: 0, title: '供需', body: '整理。', principle: '價格是訊號。', terms: [] }] }; } };
const zrow = { video_id: 'BBBBBBBBBBB', url: 'u', title: '', status: 'desk', work: { phase: 'desk', req: '7' }, content: null };
let failed = ''; try { await W.processRow(zrow, deps2); } catch (e) { failed = e.message; }
assert(failed === 'Claude 沒有回應' && listened === 1, 'first try fails after listening');
const z = await W.processRow(zrow, deps2);
assert(listened === 1 && z.status === 'ready' && z.work.phase === 'ready' && z.work.source === 'whisper' && z.content.lang === 'zh-TW', 'second try does not listen again; Chinese is finished without translation');
assert(z.content.segs[0].turns[0].s.every((p) => p[1] === p[0]), 'Chinese shown as it is');
console.log('whisper path ok');

// --- re-run on a video that already has a transcript keeps every sentence (so highlights still line up)
const ids = (cc) => cc.segs.flatMap((g) => g.turns.flatMap((tu) => tu.s.map((p, i) => tu.t + '-' + i + ':' + p[0])));
const before = ids(c);
const again = await W.processRow({ video_id: 'AAAAAAAAAAA', url: 'u', title: 'A Talk', status: 'desk', work: { phase: 'desk', req: '2', redo: 'text' }, content: c },
  { ...deps, info: async () => { throw new Error('must not fetch again'); }, ask: async ({ schema }) => { assert(schema === P.ANALYSIS_SCHEMA, 'translations are kept'); return { ...given, sections: [{ ...given.sections[0], title: '全部' }] }; } });
assert(again.content.segs.length === 1 && JSON.stringify(ids(again.content)) === JSON.stringify(before) && again.work.phase === 'ready', 're-run keeps sentences and translations');
console.log('re-run ok');
fs.rmSync(process.env.READER_DESK_CACHE, { recursive: true, force: true });
console.log('all desk tests passed');
