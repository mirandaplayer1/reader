// Desktop mode in the real page: a pasted URL is only put in line (no backend call), the list says what the desktop
// is doing, and once the desktop has written the video the reading page shows each section's first principle and terms.
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
process.env.READER_DESK_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-desk-ui-'));
const W = await import('../tools/desk/worker.mjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const D = ROOT + '/tests/shots'; fs.mkdirSync(D, { recursive: true });
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };

const rows = new Map(); let backendCalls = 0;
const SB_STUB = `window.supabase={createClient(){const j=(p,b)=>fetch('https://stub.test'+p,{method:'POST',body:JSON.stringify(b||{})}).then(r=>r.json());
  const user={id:'u1',email:'me@example.com'};
  return {auth:{getSession:async()=>({data:{session:{user,access_token:'t'}}}),onAuthStateChange(){},signOut:async()=>({})},
    from(t){const q={t,f:{}};const api={select(c){q.c=c;return api},insert(row){return j('/db/insert',{t,row}).then(()=>({error:null}))},
      update(v){return {eq:(k,val)=>j('/db/update',{t,v,f:{[k]:val}}).then(()=>({error:null}))}},eq(k,v){q.f[k]=v;return api},order(){return j('/db/list',q).then(data=>({data,error:null}))},
      maybeSingle(){return j('/db/one',q).then(data=>({data,error:null}))},upsert(row){return j('/db/upsert',{t,row}).then(()=>({error:null}))}};return api}}}};`;
const html = fs.readFileSync(ROOT + '/index.html', 'utf8').replace(/const CFG=\{[^}]*\};/, 'const CFG={"supabaseUrl":"https://proj.test","supabaseAnonKey":"anon","ingest":"desk"};');
assert(html.includes('"ingest":"desk"'), 'config injected');

const b = await chromium.launch(); const errs = [];
const ctx = await b.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 1 });
const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(String(e)));
await p.route('**/*', async (route) => {
  const u = route.request().url();
  if (u.startsWith('https://app.test/')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
  if (u.includes('supabase-js')) return route.fulfill({ contentType: 'text/javascript', body: SB_STUB });
  if (u.startsWith('https://proj.test/functions/')) { backendCalls++; return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"the backend must not be called in desktop mode"}' }); }
  if (u.startsWith('https://stub.test/db/')) { const q = JSON.parse(route.request().postData()); let out = null;
    if (u.endsWith('/list')) out = q.t === 'videos' ? [...rows.values()].map((r) => ({ video_id: r.video_id, title: r.title, status: r.status, progress: r.progress, error: r.error, list: null, seq: null })) : [];
    else if (u.endsWith('/insert')) { rows.set(q.row.video_id, { ...q.row }); out = {}; }
    else if (u.endsWith('/update')) { const r = rows.get(q.f.video_id); if (r) Object.assign(r, q.v); out = {}; }
    else if (u.endsWith('/one')) { const r = rows.get(q.f.video_id); out = q.t !== 'videos' || !r ? null : /work/.test(q.c) ? { work: r.work, had: r.content ? r.content.vid : null } : /content/.test(q.c) ? { content: r.content } : { video_id: r.video_id, title: r.title, status: r.status, progress: r.progress, error: r.error }; }
    else out = {};
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(out) }); }
  return route.abort();
});
await p.goto('https://app.test/'); await p.waitForTimeout(800);

// 1. paste a URL: it is put in line for the desktop, nothing is sent to the backend
await p.fill('#add-url', 'https://youtu.be/AAAAAAAAAAA?si=abc'); await p.click('#add button'); await p.waitForTimeout(500);
const row = rows.get('AAAAAAAAAAA');
assert(row && row.status === 'desk' && row.work.phase === 'desk' && row.work.req && backendCalls === 0, 'queued for the desktop only');
const waitText = await p.textContent('.item-row:nth-child(2) small');
assert(/等桌機接手/.test(waitText), 'waiting text: ' + waitText);
await p.click('.item-row:nth-child(2) .item'); await p.waitForTimeout(200);
assert(await p.locator('#home').isVisible(), 'a waiting video does not open');
console.log('queued ->', waitText);

// 2. the desktop reports progress; the list follows without a reload
Object.assign(row, { progress: { phase: 'desk-analysis', done: 0, total: null } });
await p.waitForFunction(() => /Claude 正在寫分析/.test(document.querySelector('.item-row:nth-child(2) small')?.textContent || ''), null, { timeout: 25000 });
console.log('progress ->', await p.textContent('.item-row:nth-child(2) small'));

// 3. the desktop finishes (the real assembling code, fed a written analysis)
const turns = Array.from({ length: 12 }, (_, i) => ({ t: i * 30, speaker: '講者', text: `第 ${i + 1} 段的第一句。這是第二句，講供給和需求。` }));
const given = { lang: 'zh-TW', headline: '價格是協調所有人的訊號。看懂它，就能預測市場怎麼動。', principle: '資源有限，所以每個選擇都有代價。', groups: [{ title: '起點', points: ['稀少性：資源不夠分，才需要選擇。'] }], reminder: '下次看到漲價，先問是誰的成本變了。',
  check: { solid: [], assumptions: [], evidence: [], contradictions: [] },
  sections: [{ t: 0, title: '稀少性', body: '這一段先定義問題。\n\n**心智模型：** 把價格想成紅綠燈。\n\n- 一\n- 二', principle: '因為資源不夠分，選了一個就得放棄另一個。', terms: [{ term: 'opportunity cost', note: '機會成本；為了得到一樣東西而放棄的最好替代品。' }, { term: 'Adam Smith', note: '十八世紀蘇格蘭經濟學家，《國富論》作者。' }] },
    { t: 180, title: '供給與需求', body: '第二段的整理。', principle: '', terms: [] }] };
const patch = await W.assemble({ vid: 'AAAAAAAAAAA', title: '經濟學第一堂', channel: 'NTU', duration: 360, turns, given, source: 'whisper' });
Object.assign(row, patch);
await p.waitForFunction(() => document.querySelector('.item-row:nth-child(2) .item')?.dataset.status === 'ready', null, { timeout: 25000 });
console.log('ready ->', await p.textContent('.item-row:nth-child(2) .item b'));

// 4. open it: overview as before, and the reading page shows the two new things under the section
await p.click('.item-row:nth-child(2) .item'); await p.waitForTimeout(500);
assert((await p.textContent('.thesis')).startsWith('價格是協調'), 'overview headline');
await p.click('[data-tab="read"]').catch(() => {}); await p.waitForTimeout(300);
const seg = p.locator('#seg-c0 .absorb');
assert((await seg.locator('.core').textContent()) === '因為資源不夠分，選了一個就得放棄另一個。', 'section first principle');
assert((await seg.locator('.terms dt').allTextContents()).join('|') === 'opportunity cost|Adam Smith', 'terms');
assert((await p.locator('#seg-c1 .absorb .terms').count()) === 0 && (await p.locator('#seg-c1 .absorb .core').count()) === 0, 'a section without extras shows none');
await seg.scrollIntoViewIfNeeded(); await p.screenshot({ path: D + '/desk-read-phone.png' });
await p.setViewportSize({ width: 1280, height: 800 }); await p.waitForTimeout(300); await seg.scrollIntoViewIfNeeded(); await p.screenshot({ path: D + '/desk-read-desktop.png' });
console.log('reading page ok | backend calls', backendCalls, '| page errors', JSON.stringify(errs));
assert(!errs.length && backendCalls === 0, 'no page errors, backend untouched');
await b.close();
fs.rmSync(process.env.READER_DESK_CACHE, { recursive: true, force: true });
