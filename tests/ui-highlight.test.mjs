// Range highlights on the demo video: part of one sentence, across sentences, tap-to-sheet, reload.
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
const ctx = await b.newContext({ viewport: { width: 390, height: 800 } });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.route('**/*', r => r.request().url().startsWith('https://app.test/') ? r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : r.abort());
await p.goto('https://app.test/');
await p.click('.item[data-demo]');
await p.evaluate(()=>setTab('read'));
await p.waitForSelector('.s');
const langs = await p.$$eval('.s', els => [...new Set(els.map(e => e.dataset.lang))]);
console.log('langs', langs, '| sentences', await p.locator('.s').count());

// 1. part of one sentence (characters 3..10 of the first zh sentence)
const pick = (sel) => p.evaluate(({ a, b, i, j, lang }) => {
  const els = [...document.querySelectorAll(`.s[data-lang="${lang}"]`)];
  const node = el => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); return w.nextNode(); };
  const r = document.createRange(); r.setStart(node(els[i]), a); r.setEnd(node(els[j]), b);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  return [els[i].dataset.id, els[j].dataset.id, s.toString()];
}, sel);
let [id1, , text1] = await pick({ lang: 'zh', i: 0, j: 0, a: 3, b: 10 });
await p.waitForSelector('#selbar:not([hidden])');
await p.screenshot({ path: S + '/shots/sel-bar.png' });
await p.click('#selbar [data-k="y"]');
const m1 = await p.$eval(`.s[data-lang="zh"][data-id="${id1}"] mark`, e => e.textContent);
const soft = await p.$eval(`.s[data-lang="en"][data-id="${id1}"]`, e => e.dataset.soft).catch(() => 'n/a');
console.log('part:', JSON.stringify(text1), '->', JSON.stringify(m1), m1 === text1 ? 'OK' : 'MISMATCH', '| other language underline:', soft, '| bar hidden:', await p.$eval('#selbar', e => e.hidden));

// 2. across three sentences: from char 5 of sentence 2 to char 4 of sentence 4
const [ia, ib, text2] = await pick({ lang: 'zh', i: 2, j: 4, a: 5, b: 4 });
await p.waitForSelector('#selbar:not([hidden])');
await p.click('#selbar [data-k="g"]');
const st = await p.evaluate(() => ({ hl: S.hl, rng: S.rng }));
console.log('across:', JSON.stringify(text2.slice(0, 40)), '| hl', JSON.stringify(st.hl), '| rng', JSON.stringify(st.rng));
const mids = await p.$$eval('.s[data-lang="zh"]', els => els.slice(2, 5).map(e => [e.dataset.hl, e.querySelector('mark') ? e.querySelector('mark').textContent.length : 0, e.textContent.length]));
console.log('sentences 2-4 [whole colour, marked chars, total chars]', JSON.stringify(mids));
await p.screenshot({ path: S + '/shots/sel-done.png' });

// 3. a tap still opens the sheet, and shows the picked part; 改成整句 widens it
await p.click(`.s[data-lang="zh"][data-id="${id1}"]`);
await p.waitForSelector('#a-part');
console.log('sheet:', (await p.textContent('#a-part')).trim().slice(0, 40));
await p.click('#a-whole'); await p.click('#a-done');
console.log('after 改成整句: whole colour', await p.$eval(`.s[data-lang="zh"][data-id="${id1}"]`, e => e.dataset.hl), '| marks', await p.locator(`.s[data-id="${id1}"] mark`).count());

// 4. survives a reload
await p.waitForTimeout(600); await p.reload(); await p.click('.item[data-demo]'); await p.evaluate(()=>setTab('read')); await p.waitForSelector('.s');
console.log('after reload: marks', await p.locator('.s mark').count(), '| page errors', errs);
await b.close();
if (errs.length || m1 !== text1) process.exit(1);
