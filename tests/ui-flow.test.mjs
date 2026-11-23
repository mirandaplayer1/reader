// Integration test: real frontend + real pipeline.js, with only the database and the Gemini HTTP call stubbed.
import { createRequire } from 'module';
import fs from 'fs';
import { parseVideoId, ingestStep, deepenStep, reprocessPatch } from '../supabase/functions/ingest/pipeline.js';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const S = ROOT + '/tests', D = S + '/shots';
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };

// --- stub model, fed with the first 37 minutes of the real transcript
const segs = JSON.parse(fs.readFileSync(ROOT + '/tests/fixtures/transcript.json', 'utf8'));
const real = []; let sp = 'Lex Fridman';
for (const s of segs) { if (s.sp) sp = s.sp; if (s.t < 2200) real.push({ t: s.t, speaker: sp, text: s.x }); }
let failOnce = true, modelCalls = 0;
const fetchStub = async (url, opt) => {
  modelCalls++;
  if (url.includes('oembed')) return { ok: true, json: async () => ({ title: 'Pieter Levels: Programming, Viral AI Startups', author_name: 'Lex Fridman' }) };
  const parts = JSON.parse(opt.body).contents[0].parts, vm = parts[0].video_metadata; let out;
  if (vm) {
    const a = parseInt(vm.start_offset), b = parseInt(vm.end_offset);
    if (a === 600 && failOnce) { failOnce = false; return { ok: false, status: 503, json: async () => ({ error: { message: 'model overloaded' } }) }; }
    out = { turns: real.filter(t => t.t >= a && t.t < b), visuals: a === 0 ? [{ t: 30, text: 'nomadlist.com' }] : [], reached_end: b > 2200 };
  } else {
    const p = parts[0].text;
    if (p.includes('推論強弱檢查')) out = { lang: 'en', title: 'x', host: 'Lex Fridman', headline: '一個人靠快速上線的小實驗找到會賺錢的產品。', principle: '沒有人能事先知道哪個點子會成，所以要讓每次嘗試都便宜。', groups: [{ title: '起點', points: ['付款驗證：有人刷卡才算數。', '兩週上線。'] }], reminder: '先放一個付款按鈕。', check: { solid: ['付款是有成本的訊號。'], assumptions: ['假設每個產品都能兩週做完。'], evidence: [], contradictions: [] } };
    else if (p.includes('"chapters"')) out = { lang: 'en', title: 'x', host: 'Lex Fridman', thesis: '一個人靠快速上線的小實驗找到會賺錢的產品。', tldr: ['重點一', '重點二', '重點三'],
      chapters: [{ t: 0, en: 'Introduction', zh: '開場', sum: '介紹來賓。', take: '', worth: 1 }, { t: 125, en: 'Startup philosophy', zh: '不募資快速驗證', sum: '兩週上線，付錢才算驗證。', take: '用付款驗證需求。', worth: 3 }, { t: 574, en: 'Low points', zh: '低潮', sum: '月收 500 美元。', take: '先動手。', worth: 2 }, { t: 1195, en: 'Travel', zh: '旅居', sum: '清邁。', take: '', worth: 1 }] };
    else if (p.includes('"zh":[')) out = { zh: p.split('\n').filter(l => /^\d+\. /.test(l)).map(l => '（譯）' + l.replace(/^\d+\. /, '').slice(0, 24)) };
    else out = { role: '這一段提出整場的核心機制：用付款當作驗證。', points: ['付款驗證：有人刷卡才算數，註冊和稱讚不算。', '兩週上線一個小產品。', '多數嘗試會失敗。'], tables: [{ title: '兩種做法', headers: ['做法', '代價'], rows: [{ cells: ['先募資', '時間長'] }, { cells: ['先上線', '兩週'] }] }], key: [4, 5] };
  }
  return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }) };
};
const deps = { fetch: fetchStub, geminiKey: 'k', videoModel: 'm', textModel: 'm' };

// --- stub backend (same decisions as index.ts)
const rows = new Map(); const states = new Map();
async function ingest(body) {
  const sum = r => ({ video_id: r.video_id, title: r.title, status: r.status, progress: r.progress, error: r.error });
  if (body.action === 'start') { const vid = parseVideoId(body.url); if (!vid) return [400, { error: '這不是 YouTube 影片網址。' }];
    if (!rows.has(vid)) rows.set(vid, { video_id: vid, url: body.url, title: '', status: 'queued', work: {}, progress: { phase: 'meta', done: 0, total: null }, error: null, content: null, updated_at: Date.now() });
    return [200, sum(rows.get(vid))]; }
  const row = rows.get(body.video_id); if (!row) return [404, { error: '找不到這支影片。' }];
  if (body.action === 'reprocess') { Object.assign(row, reprocessPatch(row, body.mode === 'all' ? 'all' : 'text')); return [200, sum(row)]; }
  try {
    if (body.action === 'step') { if (row.status === 'ready') return [200, sum(row)]; Object.assign(row, await ingestStep(row, deps), { updated_at: Date.now() }); return [200, sum(row)]; }
    if (body.action === 'deepen') { const out = await deepenStep(row, Number(body.chapter), deps); if (out.content) row.content = out.content; return [200, { video_id: row.video_id, done: out.done, progress: out.progress || null }]; }
  } catch (e) { return [502, { video_id: row.video_id, error: e.message, retryable: true }]; }
  return [400, { error: '未知的動作。' }];
}

const SB_STUB = `window.supabase={createClient(){const j=(p,b)=>fetch('https://stub.test'+p,{method:'POST',body:JSON.stringify(b||{})}).then(r=>r.json());
  const user={id:'u1',email:'me@example.com'};
  return {auth:{getSession:async()=>({data:{session:{user,access_token:'t'}}}),onAuthStateChange(){},signOut:async()=>({})},
    from(t){const q={t,f:{}};const api={select(c){q.c=c;return api},update(v){return {eq:(k,val)=>j('/db/update',{t,v,f:{[k]:val}}).then(()=>({error:null}))}},eq(k,v){q.f[k]=v;return api},order(){return j('/db/list',q).then(data=>({data,error:null}))},
      maybeSingle(){return j('/db/one',q).then(data=>({data,error:null}))},upsert(row){return j('/db/upsert',{t,row}).then(()=>({error:null}))}};return api}}}};`;

const html = fs.readFileSync(ROOT + '/index.html', 'utf8').replace(/const CFG=\{[^}]*\};/, 'const CFG={"supabaseUrl":"https://proj.test","supabaseAnonKey":"anon"};');
assert(html.includes('proj.test'), 'config injected');

const b = await chromium.launch(); const errs = [];
const ctx = await b.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 1 });
const p = await ctx.newPage(); p.on('pageerror', e => errs.push(String(e)));
await p.route('**/*', async route => {
  const u = route.request().url();
  if (u.startsWith('https://app.test/')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
  if (u.includes('supabase-js')) return route.fulfill({ contentType: 'text/javascript', body: SB_STUB });
  if (u.startsWith('https://proj.test/functions/v1/ingest')) { const [status, body] = await ingest(JSON.parse(route.request().postData())); return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }); }
  if (u.startsWith('https://stub.test/db/')) { const q = JSON.parse(route.request().postData()); let out = null;
    if (u.endsWith('/list')) out = [...rows.values()].map(r => ({ video_id: r.video_id, title: r.title, status: r.status, progress: r.progress, error: r.error, list: r.list||null, seq: r.seq||null }));
    else if (u.endsWith('/update')) { [...rows.values()].filter(r => q.f.video_id ? r.video_id === q.f.video_id : r.list === q.f.list).forEach(r => Object.assign(r, q.v)); out = {}; }
    else if (u.endsWith('/one')) { if (q.t === 'videos') { const r = rows.get(q.f.video_id); out = r ? { content: r.content } : null; } else out = states.get(q.f.video_id) || null; }
    else if (u.endsWith('/upsert')) { if (q.t === 'reader_state') states.set(q.row.video_id, { state: q.row.state, at: q.row.at }); out = {}; }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(out) }); }
  return route.abort();
});
await p.goto('https://app.test/'); await p.waitForTimeout(800);
await p.screenshot({ path: D + '/i-home.png' });
console.log('home:', await p.textContent('#sync'), '| items', await p.locator('.item').count(), '| input enabled', await p.isEnabled('#add-url'));

// 1. a bad URL is refused without touching the backend
await p.fill('#add-url', 'https://example.com/video'); await p.click('#add button'); await p.waitForTimeout(200);
console.log('bad url ->', await p.textContent('#add-msg'));
// 2. paste a real YouTube URL and wait for the whole pipeline, including one injected 503
await p.fill('#add-url', 'https://youtu.be/AAAAAAAAAAA?si=abc'); await p.click('#add button');
await p.waitForTimeout(700); await p.screenshot({ path: D + '/i-processing.png' });
console.log('processing ->', await p.textContent('.item-row:nth-child(2) small'));
await p.waitForFunction(() => document.querySelector('.item-row:nth-child(2) .item')?.dataset.status === 'ready', null, { timeout: 60000 });
console.log('ready ->', await p.textContent('.item-row:nth-child(2) .item b'), '|', await p.textContent('.item-row:nth-child(2) small'), '| injected failure consumed:', !failOnce);
await p.screenshot({ path: D + '/i-ready.png' });
// 3. open it: overview from generated content
await p.click('.item-row:nth-child(2) .item'); await p.waitForTimeout(400);
console.log('overview chapters', await p.locator('.ch').count(), '| thesis', (await p.textContent('.thesis')).slice(0, 20), '| deepen buttons', await p.locator('.ch [data-deepen]').count());
await p.screenshot({ path: D + '/i-overview.png' });
// 4. read the raw transcript of a chapter that is not translated yet
await p.click('.ch:nth-child(3) [data-raw]'); await p.waitForTimeout(300);
console.log('raw turns shown', await p.locator('#seg-c2 .turn').count());
await p.screenshot({ path: D + '/i-raw.png' });
// 5. deepen chapter 2 (index 1) from the read tab
await p.click('#seg-c1 [data-deepen]');
await p.waitForFunction(() => !!document.querySelector('#seg-c1 .absorb'), null, { timeout: 60000 });
const zh = await p.textContent('#seg-c1 .turn:nth-of-type(2) .zh'); const en = await p.textContent('#seg-c1 .turn:nth-of-type(2) .en');
console.log('deepened: zh starts', zh.slice(0, 16), '| en starts', en.slice(0, 30), '| core', await p.textContent('#seg-c1 .core'));
await p.evaluate(() => document.querySelector('#seg-c1').scrollIntoView()); await p.screenshot({ path: D + '/i-deep.png' });
// 6. highlight, distill, card on generated content; state goes to the (stub) cloud
await p.click('#seg-c1 .zh .s >> nth=4'); await p.click('#sheet [data-hl=y]'); await p.click('#a-done');
await p.click('[data-tab=points]'); await p.waitForSelector('.pts');
const selAI = q => p.evaluate(q => { const el = document.querySelector(q), r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return el.textContent; }, q);
await p.evaluate(() => setTab('read')); await selAI('#seg-c1 .core'); await p.waitForSelector('#selbar [data-ai-save]'); await p.click('#selbar [data-ai-save]:not([data-note])');
await p.click('[data-tab=points]'); await p.waitForSelector('.pts');
console.log('points: my lines', await p.locator('.pcard.hl').count(), '| AI passages I marked', await p.locator('.pcard.ai').count());
await p.click('#p-pick'); await p.click('.pcard.ai'); await p.click('.pcard.hl'); await p.click('#p-write'); await p.fill('#k-text', '沒有人付錢之前都只是想像'); await p.click('#k-done'); await p.waitForSelector('.zcard'); await p.waitForTimeout(1500);
console.log('cards', await p.locator('#side .zcard').count(), '| synced state saved:', states.has('AAAAAAAAAAA'), '| badge', await p.textContent('#sync'));
await p.screenshot({ path: D + '/i-cards.png' });
// 7. back home, reload: library and the finished video come back from the store
await p.click('#gohome'); await p.reload(); await p.waitForTimeout(900);
console.log('after reload items', await p.locator('.item').count(), '| second status', await p.getAttribute('.item-row:nth-child(2) .item', 'data-status'));
await p.click('.item-row:nth-child(2) .item'); await p.waitForTimeout(400); await p.click('[data-tab=views]');
console.log('cards after reload', await p.locator('#side .zcard').count());
// 7b. reprocess (text only): highlights and translations survive, the back-to-playing button exists
await p.click('[data-tab=read]'); await p.waitForTimeout(300);
const before = await p.evaluate(() => ({ hl: document.querySelectorAll('.zh .s[data-hl="y"]').length, ids: Object.keys(S.hl), zh: document.querySelector('#seg-c1 .turn .zh').textContent.slice(0, 14) }));
await p.click('[data-tab=overview]'); await p.click('.redo summary'); await p.click('[data-redo=text]'); await p.click('#rp-go');
await p.waitForFunction(() => document.querySelector('.item-row:nth-child(2) .item')?.dataset.status === 'ready', null, { timeout: 60000 });
await p.click('.item-row:nth-child(2) .item'); await p.waitForTimeout(500); await p.click('[data-tab=read]'); await p.waitForTimeout(300);
const after = await p.evaluate(() => ({ hl: document.querySelectorAll('.zh .s[data-hl="y"]').length, deep: SEGS[1].deep, zh: document.querySelector('#seg-c1 .turn .zh').textContent.slice(0, 14), btn: document.querySelector('#seg-c1 [data-deepen]')?.textContent, tonow: !!document.querySelector('#tonow') }));
console.log('reprocess: ids', JSON.stringify(before.ids), '| highlights', before.hl, '->', after.hl, '| translation kept:', before.zh === after.zh, '| deep reset:', after.deep === false, '| button:', after.btn, '| tonow button present:', after.tonow);
await p.screenshot({ path: D + '/i-reprocessed.png' });
await p.click('#gohome');
// 8. the bundled sample still opens
await p.click('#gohome'); await p.click('.item:nth-child(1)'); await p.waitForTimeout(300);
console.log('demo chapters', await p.locator('.ch').count(), '| demo read segs', await p.locator('.a-seg').count());
// lists: cards on home, a page per list, everything behind the row's ⋯ button
await p.evaluate(()=>goHome());await p.waitForSelector('.more');
await p.click('.more');await p.fill('#newlist-name','經濟學');await p.click('#newlist button');
await p.waitForSelector('.lcard');
console.log('home: cards', await p.$$eval('.lcard',e=>e.map(x=>x.innerText.replace(/\s+/g,' '))), '| loose videos', await p.locator('.lib .item').count());
await p.setViewportSize({width:390,height:800});await p.screenshot({path:D+'/l2-home-phone.png'});
await p.click('.lcard');await p.waitForSelector('.lpage');
console.log('list page:', (await p.textContent('.lhead')).replace(/\s+/g,' ').trim(), '| rows', await p.locator('.lpage .item').count(), '| button', await p.textContent('#l-go'));
await p.screenshot({path:D+'/l2-list-phone.png'});await p.setViewportSize({width:1280,height:800});await p.screenshot({path:D+'/l2-list.png'});
await p.click('#l-go');await p.waitForFunction(()=>document.querySelector('#root').dataset.view!=='home');
await p.evaluate(()=>goHome());await p.waitForSelector('.lpage');
console.log('back from the video lands on the list:', (await p.textContent('.lhead')).includes('讀過 1 支'), '| button', await p.textContent('#l-go'));
await p.click('#l-more');await p.fill('#rn-name','個體經濟');await p.click('#rn button');await p.waitForFunction(()=>document.querySelector('.lhead h2').textContent==='個體經濟');
await p.reload();await p.waitForSelector('.lcard');console.log('after reload:', await p.$$eval('.lcard b',e=>e.map(x=>x.textContent)));
await p.click('.lcard');await p.click('.lpage .more');await p.screenshot({path:D+'/l2-menu.png'});await p.click('#unlist');
await p.waitForFunction(()=>!document.querySelector('.lpage'));console.log('emptied list is gone: cards', await p.locator('.lcard').count());
console.log('model calls', modelCalls, '| page errors', errs);
await b.close();
assert(!errs.length, 'page errors');
