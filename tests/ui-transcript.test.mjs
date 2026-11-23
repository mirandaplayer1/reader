// A Chinese video (no translation needed) and an untranslated English one must both show their transcript.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const S = ROOT + '/tests';
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 390, height: 800 } })).newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.route('**/*', r => r.request().url().startsWith('https://app.test/') ? r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : r.abort());
await p.goto('https://app.test/');
const make = (lang, a, b2) => ({ vid: 'x'.repeat(11), lang, title: 'T', channel: '', duration: 600, host: '', thesis: 't', tldr: [],
  chapters: [{ t: 0, en: 'A', zh: '甲', sum: 's', take: '', worth: 2 }], visuals: [],
  segs: [{ id: 'c0', t: 0, title: '甲', deep: false, turns: [{ sp: '講者', t: 0, s: [[a, null], [b2, null]] }] }] });
for (const [name, c] of [['zh', make('zh-TW', '第二個故事是為什麼要擁有核子武器。', '稀少性指的是資源有限。')], ['en', make('en', 'I think my philosophy is very different.', 'Most people raise money first.')]]) {
  await p.evaluate(c => { openVideo(c); setTab('read'); }, c);
  await p.waitForSelector('.turn');
  const vis = await p.$$eval('.turn p', ps => ps.filter(e => e.offsetParent !== null).map(e => e.innerText));
  console.log(name, '| visible lines', JSON.stringify(vis), '| button', (await p.textContent('[data-deepen]')).trim());
  await p.screenshot({ path: `${S}/shots/mono-${name}.png` });
  if (vis.length !== 1) { console.error('FAIL: expected exactly one visible line'); process.exit(1); }
  await p.evaluate(() => goHome());
}
// turns cut mid-sentence are shown as paragraphs that end where a sentence ends, also across a chapter boundary; ids do not change
const cut = { vid: 'CUTCUTCUT01', lang: 'zh-TW', title: '切段', duration: 120, chapters: [{ t: 0, zh: '甲', en: '', sum: '', worth: 2 }, { t: 60, zh: '乙', en: '', sum: '', worth: 2 }],
  segs: [{ id: 'c0', t: 0, title: '甲', deep: false, turns: [{ sp: '講者', t: 0, s: [['第一句講完了。', null], ['第二句講到一半，', null]] }, { sp: '講者', t: 20, s: [['這是第二句的後半。', null], ['第三句又被', null]] }] },
    { id: 'c1', t: 60, title: '乙', deep: false, turns: [{ sp: '講者', t: 60, s: [['章節切斷了。', null], ['新章節的第一句。', null]] }] }] };
await p.evaluate(c => { openVideo(c); setTab('read'); }, cut); await p.waitForSelector('.turn');
const paras = await p.$$eval('.a-seg', ss => ss.map(sec => [...sec.querySelectorAll('.turn .zh')].map(e => e.textContent)));
const ids = await p.$$eval('.zh .s', x => x.map(e => e.dataset.id));
console.log('paragraphs', JSON.stringify(paras));
if (JSON.stringify(paras) !== JSON.stringify([['第一句講完了。', '第二句講到一半，這是第二句的後半。', '第三句又被章節切斷了。'], ['新章節的第一句。']])) { console.error('FAIL: paragraphs should end at sentence ends'); process.exit(1); }
if (ids.length !== 6 || new Set(ids).size !== 6 || ids.join() !== await p.evaluate(() => Object.keys(SENT).join())) { console.error('FAIL: every sentence once, ids unchanged', ids); process.exit(1); }
console.log('page errors', errs); await b.close(); if (errs.length) process.exit(1);
