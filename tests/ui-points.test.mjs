// Highlights without a category, notes that need not hang on a sentence, the points page, views, and old state carried over.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const D = ROOT + '/tests/shots'; fs.mkdirSync(D, { recursive: true });
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.route('**/*', r => r.request().url().startsWith('https://app.test/') ? r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : r.abort());

// State written by the previous version: a note on a sentence, an answer under a chapter, a claim with AI evidence.
await p.goto('https://app.test/');
await p.evaluate(() => localStorage.setItem('rd4:' + DEMO.vid, JSON.stringify({ hl: { 's1-0-0': 'y', 's1-1-0': 'p' }, notes: { 's1-0-0': '舊筆記' }, refl: { s2: '舊回答' }, rng: {},
  claims: [{ id: 'k1', text: '收錢才能驗證市場', ev: ['ai-s1', 's1-1-0'] }], cards: [], mode: 'both', at: 1000 })));
await p.reload();
const open = async () => { await p.click('.item[data-demo]'); await p.evaluate(() => setTab('read')); await p.waitForSelector('.s'); };
await open();
const st = () => p.evaluate(() => JSON.parse(JSON.stringify(S)));
let s = await st();
assert(s.at === 1000, 'carrying old state over must not stamp it as a new edit: at=' + s.at);
assert(Object.values(s.memos).some(m => m.text === '舊筆記' && m.ids[0] === 's1-0-0'), 'old note became a memo');
assert(Object.values(s.memos).some(m => m.text === '舊回答' && m.t != null && m.q), 'old chapter answer became a memo tied to the chapter time');
assert(s.views.k1 && s.views.k1.text === '收錢才能驗證市場' && s.views.k1.quotes.length === 2 && s.views.k1.quotes[0].ai, 'old claim became a view with its quotes kept as text');
console.log('carried over: memos', Object.keys(s.memos).length, '| views', Object.keys(s.views).length, '| at untouched');

const select = (i, j, a, bb) => p.evaluate(({ i, j, a, bb }) => { const els = [...document.querySelectorAll('.s[data-lang="zh"]')];
  const node = el => document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode(); const r = document.createRange(); r.setStart(node(els[i]), a); r.setEnd(node(els[j]), bb);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); return els.slice(i, j + 1).map(e => e.dataset.id); }, { i, j, a, bb });

// one tap draws a plain line
console.log('bar:', (await (async () => { await select(5, 5, 2, 8); await p.waitForSelector('#selbar:not([hidden])'); return p.$$eval('#selbar button', x => x.map(e => e.textContent.trim())); })()).join(' | '));
await p.screenshot({ path: D + '/pt-bar.png' });
const [id5] = await select(5, 5, 2, 8); await p.waitForSelector('#selbar:not([hidden])');
await p.click('#selbar [data-k="y"]:not([data-note])');
s = await st(); assert(s.hl[id5] === 'y' && s.rng[id5], 'plain line drawn in one tap');
// a tag is two taps
const [id7] = await select(7, 7, 0, 5); await p.waitForSelector('#selbar:not([hidden])');
await p.click('#selbar [data-tags]'); await p.click('#selbar [data-k="g"]');
s = await st(); assert(s.hl[id7] === 'g', 'tagged 要去做');
// line + note across three sentences
const ids = await select(9, 11, 0, 3); await p.waitForSelector('#selbar:not([hidden])');
await p.click('#selbar [data-note]'); await p.waitForSelector('#n-text');
await p.screenshot({ path: D + '/pt-note.png' });
await p.fill('#n-text', '這三句是整段的重點'); await p.click('#n-done');
s = await st(); const memo = Object.values(s.memos).find(m => m.text === '這三句是整段的重點');
assert(memo && memo.ids.length === 3 && ids.every(i => s.hl[i] === 'y'), 'note tied to all three sentences, all three drawn');
// re-drawing part of a sentence that is already drawn in full keeps it whole
await select(10, 10, 1, 3); await p.waitForSelector('#selbar:not([hidden])'); await p.click('#selbar [data-k="y"]:not([data-note])');
s = await st(); assert(!s.rng[ids[1]], 'a sentence drawn in full stays in full');
// a note for the chapter, and one for the whole video
await p.click('[data-note-t]'); await p.waitForSelector('#n-text'); await p.fill('#n-text', '這一章的想法'); await p.click('#n-done');
await p.evaluate(() => setTab('points')); await p.waitForSelector('.pts');
await p.click('[data-note-all]'); await p.waitForSelector('#n-text'); await p.fill('#n-text', '整支影片的想法'); await p.click('#n-done');
s = await st(); assert(Object.values(s.memos).some(m => m.text === '這一章的想法' && m.t != null && !m.ids) && Object.values(s.memos).some(m => m.text === '整支影片的想法' && m.t == null && !m.ids), 'chapter note and whole-video note');

// the points page
const page = await p.evaluate(() => ({ blocks: [...document.querySelectorAll('.pt:not(.ai)')].map(e => e.querySelector('p').textContent.length), ai: document.querySelectorAll('.pt.ai').length,
  memos: [...document.querySelectorAll('.memo span')].map(e => e.textContent), chapters: document.querySelectorAll('.pch').length }));
console.log('points page: chapters', page.chapters, '| my blocks', page.blocks.length, '| AI first principles', page.ai, '| notes shown', page.memos.length);
assert(page.ai >= 1, 'the AI first principle of each analysed chapter is there without doing anything');
assert(page.memos.includes('舊筆記') && page.memos.includes('這三句是整段的重點') && page.memos.includes('這一章的想法') && page.memos.includes('整支影片的想法') && page.memos.includes('舊回答'), 'every note is on the page: ' + page.memos);
assert(page.blocks.length < Object.keys(s.hl).length, 'consecutive sentences are merged into one block');
await p.screenshot({ path: D + '/pt-points.png' });
const md = await p.evaluate(() => pointsMarkdown());
assert(md.includes('AI 整理的第一性原理') && md.includes('我的筆記：這三句是整段的重點') && md.includes('整支影片的想法'), 'markdown has the AI line and my notes');
await p.click('[data-mine="1"]'); assert(await p.locator('.pt.ai').count() === 0, '只看我的 hides the AI lines');
await p.click('[data-mine="0"]');

// pick a few, write a view
await p.click('#p-pick'); await p.click('.pt.ai'); await p.click('.pt:not(.ai)'); await p.screenshot({ path: D + '/pt-pick.png' });
await p.click('#p-write'); await p.waitForSelector('#v-text'); await p.fill('#v-text', '先收到錢，再決定要不要繼續做。'); await p.screenshot({ path: D + '/pt-view.png' }); await p.click('#v-done');
await p.waitForSelector('.vcard'); await p.screenshot({ path: D + '/pt-views.png' });
s = await st(); const mine = Object.values(s.views).find(v => v.text.startsWith('先收到錢'));
assert(mine && mine.quotes.length === 2 && mine.quotes.some(q => q.ai), 'view saved with the two picked quotes, one of them the AI line');
console.log('views:', await p.$$eval('.vcard .vt', x => x.map(e => e.textContent)));
// a view with no quotes at all is fine
await p.click('#v-new'); await p.waitForSelector('#v-text'); await p.fill('#v-text', '沒有引文的觀點'); await p.click('#v-done');
// removing a line keeps its note visible
await p.evaluate(() => setTab('read')); await p.click(`.s[data-lang="zh"][data-id="s1-0-0"]`); await p.waitForSelector('#a-note');
assert(await p.inputValue('#a-note') === '舊筆記', 'the sentence sheet shows the note that was carried over');
await p.click('.hl-row [data-hl=""]'); await p.click('#a-done');
await p.evaluate(() => setTab('points')); assert((await p.$$eval('.memo span', x => x.map(e => e.textContent))).includes('舊筆記'), 'a note outlives its highlight');

await p.waitForTimeout(400); await p.reload(); await open(); s = await st();
assert(Object.keys(s.views).length === 3 && Object.keys(s.memos).length === 5, 'everything survives a reload: views ' + Object.keys(s.views).length + ' memos ' + Object.keys(s.memos).length);
console.log('after reload: highlights', Object.keys(s.hl).length, '| notes', Object.keys(s.memos).length, '| views', Object.keys(s.views).length, '| page errors', errs);

// two devices: this page must not overwrite something newer it has never seen
const r = await p.evaluate(async () => {
  const remote = { state: JSON.parse(JSON.stringify(S)), at: 0 }; let writes = 0;
  const q = () => ({ select: () => q(), eq: () => q(), maybeSingle: async () => ({ data: remote.at ? { state: remote.state, at: remote.at } : null, error: null }),
    upsert: async row => { writes++; remote.state = JSON.parse(JSON.stringify(row.state)); remote.at = row.at; return { error: null }; } });
  sb = { from: q }; sbUser = { id: 'u' };
  await pull();                                   // first sync: nothing on the server, so this page writes
  const first = writes;
  // the other device adds a note, later than anything this page has seen
  remote.state.memos.other = { at: Date.now() + 5000, text: '另一台裝置寫的' }; remote.at = Date.now() + 5000; remote.state.at = remote.at;
  S.hl['s1-2-0'] = 'y'; commit(); await new Promise(z => setTimeout(z, 1600));   // this page edits without having pulled
  return { first, writes, kept: !!remote.state.memos.other, adopted: !!S.memos.other };
});
console.log('two devices: first sync wrote', r.first, '| stale write blocked:', r.writes === r.first, '| newer note kept on server:', r.kept, '| loaded here:', r.adopted);
assert(r.first === 1 && r.writes === r.first && r.kept && r.adopted, 'a stale page must not overwrite newer state');
await b.close(); assert(!errs.length, 'page errors');
