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
await p.click('#fab-note'); await p.waitForSelector('#n-text'); await p.fill('#n-text', '這一章的想法'); await p.click('#n-done');
assert((await p.$$eval('.segmemo', x => x.map(e => e.textContent))).includes('這一章的想法'), 'a chapter note shows at the end of its chapter');
await p.click('#chap'); await p.waitForSelector('.chaplist [aria-current]'); assert(await p.locator('.chaplist button').count() === await p.evaluate(() => SEGS.length), 'the chapter button lists every chapter'); await p.evaluate(() => closeSheet());
await p.evaluate(() => setTab('points')); await p.waitForSelector('.pts');
await p.click('[data-note-all]'); await p.waitForSelector('#n-text'); await p.fill('#n-text', '整支影片的想法'); await p.click('#n-done');
s = await st(); assert(Object.values(s.memos).some(m => m.text === '這一章的想法' && m.t != null && !m.ids) && Object.values(s.memos).some(m => m.text === '整支影片的想法' && m.t == null && !m.ids), 'chapter note and whole-video note');

// the points page: nothing from the AI is there until I mark it
await p.evaluate(() => setTab('points')); await p.waitForSelector('.pts');
assert(await p.locator('.pcard.ai').count() === 0, 'no AI card appears by itself');
const selAI = q => p.evaluate(q => { const el = document.querySelector(q), r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return el.textContent; }, q);
await p.evaluate(() => setTab('read')); const core = await selAI('.absorb .core'); await p.waitForSelector('#selbar [data-ai-save]'); await p.click('#selbar [data-ai-save]:not([data-note])');
assert(await p.locator('.absorb mark.aim').count() === 1, 'the AI passage I marked is painted where it stands');
await selAI('.absorb li'); await p.waitForSelector('#selbar [data-ai-save][data-note]'); await p.click('#selbar [data-ai-save][data-note]'); await p.waitForSelector('#pt-note'); await p.fill('#pt-note', '對 AI 這句的想法'); await p.click('#pt-done');
await p.evaluate(() => setTab('overview')); await p.waitForSelector('.ov .thesis'); await selAI('.ov .thesis'); await p.waitForSelector('#selbar [data-ai-save]'); await p.click('#selbar [data-ai-save]:not([data-note])');
assert(await p.locator('#side mark.aim').count() === 1, 'a passage of the overview can be marked too');
s = await st(); assert(Object.values(s.aip).length === 3 && Object.values(s.aip).some(a => a.text === core.replace(/\s+/g, ' ').trim() && a.t != null) && Object.values(s.aip).some(a => a.t == null), 'three AI passages saved, with the chapter they came from');
await p.evaluate(() => setTab('points')); await p.waitForSelector('.pts');
const page = await p.evaluate(() => ({ blocks: [...document.querySelectorAll('.pcard.hl')].map(e => e.querySelector('p').textContent.length), ai: document.querySelectorAll('.pcard.ai').length,
  memos: [...document.querySelectorAll('.pcard.note p, .pcard .pn')].map(e => e.textContent), chapters: document.querySelectorAll('.pgroup').length }));
console.log('points page: groups', page.chapters, '| my blocks', page.blocks.length, '| AI passages', page.ai, '| notes shown', page.memos.length);
assert(page.ai === 3, 'each AI passage I marked is a card');
// change the words of a card, then put them back; take a card away
await p.click('.pcard.hl >> nth=0'); await p.waitForSelector('#pt-text'); const before = await p.inputValue('#pt-text'); await p.fill('#pt-text', '我改寫過的這一句'); await p.click('#pt-done');
assert(await p.textContent('.pcard.hl >> nth=0 >> p >> nth=0') === '我改寫過的這一句' && Object.keys((await st()).hl).length === Object.keys(s.hl).length, 'the card shows my wording and the highlight is untouched');
await p.click('.pcard.hl >> nth=0'); await p.click('#pt-reset'); assert(await p.textContent('.pcard.hl >> nth=0 >> p >> nth=0') === before, 'the original words come back');
await p.click('.pcard.ai:has(.pn)'); await p.waitForSelector('#pt-text'); await p.fill('#pt-text', 'AI 這句我改短了'); await p.click('#pt-done');
assert((await p.textContent('.pcard.ai:has(.pn)')).includes('AI 這句我改短了'), 'an AI card can be reworded');
await p.evaluate(() => setTab('read')); assert(await p.locator('.absorb mark.aim').count() === 2, 'a reworded AI passage stays painted in the text');
await p.evaluate(() => setTab('points')); await p.click('.pcard.ai:has(.pn)'); await p.click('#pt-del');
assert(await p.locator('.pcard.ai').count() === 2 && Object.keys((await st()).aip).length === 2, 'deleting an AI card removes it');
assert(page.memos.includes('舊筆記') && page.memos.includes('這三句是整段的重點') && page.memos.includes('這一章的想法') && page.memos.includes('整支影片的想法') && page.memos.includes('舊回答'), 'every note is on the page: ' + page.memos);
assert(page.blocks.length < Object.keys(s.hl).length, 'consecutive sentences are merged into one block');
await p.screenshot({ path: D + '/pt-points.png' });
const md = await p.evaluate(() => pointsMarkdown());
assert(md.includes('（AI 整理）') && md.includes('我的筆記：這三句是整段的重點') && md.includes('整支影片的想法'), 'markdown has the AI passages and my notes');

// pick a few, write a card
const box = () => p.evaluate(() => JSON.parse(JSON.stringify(BOX.cards)));
let cards = await box(); assert(cards.k1 && cards.k1.text === '收錢才能驗證市場' && cards.k1.vid, 'the old claim is in the box as a card');
await p.click('#p-pick'); await p.click('.pcard.ai'); await p.click('.pcard.hl'); await p.screenshot({ path: D + '/pt-pick.png' });
await p.click('#p-write'); await p.waitForSelector('#k-text');
await p.fill('#k-title', '先收到錢再決定要不要做'); await p.fill('#k-text', '有人付錢是唯一不會騙人的訊號。註冊和稱讚都不用成本。');
await p.fill('#k-topic', '找需求'); await p.dispatchEvent('#k-topic', 'change');
await p.click('#k-link'); await p.waitForSelector('[data-pickcard]'); await p.click('[data-pickcard]'); await p.click('#lk-done'); await p.waitForSelector('#k-text');
await p.screenshot({ path: D + '/pt-card.png' }); await p.click('#k-done');
await p.waitForSelector('.zcard'); await p.screenshot({ path: D + '/pt-cards.png' });
cards = await box(); const mine = Object.values(cards).find(c => c.title === '先收到錢再決定要不要做');
assert(mine && mine.quotes.length === 2 && mine.quotes.some(q => q.ai) && mine.topic === '找需求' && mine.links.includes('k1') && mine.vt, 'card saved with its two sources, topic, link and where it came from');
console.log('cards in this video:', await p.$$eval('.zcard b', x => x.map(e => e.textContent)));
// the card it links to shows the link coming back
await p.click('[data-card="k1"]'); await p.waitForSelector('#k-text'); assert((await p.textContent('.linked')).includes('連過來的'), 'backlink shown on the linked card'); await p.click('#k-done');
// the box on the home screen, across videos
await p.click('#v-box'); await p.waitForSelector('.boxpage');
console.log('box:', (await p.textContent('.boxpage .eyebrow')).trim(), '| topics', await p.$$eval('[data-topic]', x => x.map(e => e.textContent)));
await p.click('#bx-new'); await p.waitForSelector('#k-title'); await p.fill('#k-title', '跟影片無關的卡片'); await p.click('#k-done');
await p.fill('#bx-q', '無關'); assert(await p.locator('.boxpage .zcard:not([hidden])').count() === 1, 'search narrows the box'); await p.fill('#bx-q', '');
await p.click('#bx-pick'); await p.click('[data-card="k1"]'); await p.click(`.zcard:has-text("先收到錢再決定要不要做")`); await p.screenshot({ path: D + '/pt-box.png' });
const outline = await p.evaluate(() => boxOutline(ui.bpick));
assert(outline.indexOf('收錢才能驗證市場') < outline.indexOf('先收到錢再決定要不要做') && outline.includes('> '), 'outline follows the order the cards were picked in and carries the sources');
await p.click('#bx-cancel'); await p.click('#bx-back'); assert((await p.textContent('#open-box')).includes('3 張卡片'), 'home shows the box: ' + await p.textContent('#open-box'));
await open();
// removing a line keeps its note visible
await p.evaluate(() => setTab('read')); await p.click(`.s[data-lang="zh"][data-id="s1-0-0"]`); await p.waitForSelector('#a-note');
assert(await p.inputValue('#a-note') === '舊筆記', 'the sentence sheet shows the note that was carried over');
await p.click('#a-clear'); await p.click('#a-done');
await p.evaluate(() => setTab('points')); assert((await p.$$eval('.pcard.note p', x => x.map(e => e.textContent))).includes('舊筆記'), 'a note outlives its highlight');
// deleting a highlighted card removes the highlight itself
const nHl = Object.keys((await st()).hl).length, nCards = await p.locator('.pcard.hl').count();
await p.click('.pcard.hl >> nth=0'); await p.click('#pt-del');
assert(await p.locator('.pcard.hl').count() === nCards - 1 && Object.keys((await st()).hl).length < nHl, 'deleting a card removes its highlight');

await p.waitForTimeout(400); await p.reload(); await open(); s = await st();
cards = await box(); assert(Object.keys(cards).length === 3 && Object.keys(s.memos).length === 5, 'everything survives a reload: cards ' + Object.keys(cards).length + ' memos ' + Object.keys(s.memos).length);
console.log('after reload: highlights', Object.keys(s.hl).length, '| notes', Object.keys(s.memos).length, '| cards', Object.keys(cards).length, '| page errors', errs);

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
const m = await p.evaluate(async () => {
  const remote = { cards: { far: { at: Date.now() + 9000, made: 1, title: '另一台裝置做的卡片', text: 'x', links: [], quotes: [] }, k1: { at: 0, title: '舊的', text: '舊的', links: [], quotes: [] } } }; let wrote = null;
  const q = () => ({ select: () => q(), eq: () => q(), maybeSingle: async () => ({ data: { state: remote, at: 1 }, error: null }), upsert: async row => { wrote = JSON.parse(JSON.stringify(row.state.cards)); return { error: null }; } });
  sb = { from: q }; sbUser = { id: 'u' }; await boxSync();
  return { gotTheirs: !!BOX.cards.far, keptMine: BOX.cards.k1.text === '收錢才能驗證市場', pushed: !!(wrote && wrote.far && wrote.k1.text === '收錢才能驗證市場' && Object.keys(wrote).length === 4) };
});
console.log('box across devices: their card arrived', m.gotTheirs, '| my newer copy kept', m.keptMine, '| both written back', m.pushed);
assert(m.gotTheirs && m.keptMine && m.pushed, 'cards from two devices merge instead of overwriting');
await b.close(); assert(!errs.length, 'page errors');
