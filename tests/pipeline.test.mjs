import {parseVideoId,splitSentences,ingestStep,deepenStep} from '../supabase/functions/ingest/pipeline.js';
import fs from 'fs';
const assert=(c,m)=>{if(!c){console.error('FAIL',m);process.exit(1)}};
// parse
for(const [u,e] of [['https://www.youtube.com/watch?v=oFtjKbXKqbg','oFtjKbXKqbg'],['https://youtu.be/oFtjKbXKqbg?t=3','oFtjKbXKqbg'],['https://www.youtube.com/shorts/oFtjKbXKqbg','oFtjKbXKqbg'],['https://m.youtube.com/watch?feature=x&v=oFtjKbXKqbg','oFtjKbXKqbg'],['https://example.com/x',null]]) assert(parseVideoId(u)===e,u);
// split: lossless on the real transcript
const segs=JSON.parse(fs.readFileSync(new URL('./fixtures/transcript.json',import.meta.url),'utf8'));
let n=0;for(const s of segs){const parts=splitSentences(s.x);assert(parts.join(' ')===s.x.replace(/\s+/g,' ').trim(),'lossless '+s.t);n+=parts.length}
console.log('split ok:',segs.length,'turns ->',n,'sentences');
// state machine with a stubbed model, fed the real transcript in 10-minute chunks
const real=[];let sp='Lex Fridman';for(const s of segs){if(s.sp)sp=s.sp;real.push({t:s.t,speaker:sp,text:s.x})}
let calls=0,fullCalls=0,partCalls=0,overviewCalls=0;
const mmss=t=>Math.floor(t/3600)+':'+String(Math.floor(t%3600/60)).padStart(2,'0')+':'+String(t%60).padStart(2,'0');
const fetchStub=async(url,opt)=>{calls++;
  if(url.includes(':countTokens')){const vm=JSON.parse(opt.body).contents[0].parts[0].video_metadata;return {ok:true,json:async()=>({promptTokensDetails:[{modality:'AUDIO',tokenCount:vm?60*32:13409*32}]})}}
  if(url.includes('oembed'))return {ok:true,json:async()=>({title:'Pieter Levels',author_name:'Lex Fridman'})};
  const body=JSON.parse(opt.body),parts=body.contents[0].parts,vm=parts[0].video_metadata;let out;
  if(vm){const a=parseInt(vm.start_offset),b=parseInt(vm.end_offset);const turns=real.filter(t=>t.t>=a&&t.t<b);
    // every third chunk answers with clip-relative times, to exercise the offset repair
    const rel=(a/300)%3===2;out={turns:turns.map(t=>({ts:mmss(rel?t.t-a:t.t),speaker:t.speaker,text:t.text})),visuals:[],reached_end:true}}
  else{const p=parts[0].text,ts=[...p.matchAll(/^\[(\d+)\]/gm)].map(m=>+m[1]);
    const meta={lang:'en',title:'x',host:'Lex Fridman',headline:'主旨',principle:'原理',groups:[{title:'起點',points:['甲：一','二']},{title:'空',points:[]}],reminder:'提醒',check:{solid:['穩'],assumptions:['假設一','假設二'],evidence:[],contradictions:['矛盾']}};
    const sec=(t,title)=>({t,title,role:'作用'+title,points:['a','b','c','d'],tables:[{title:'對照',headers:['質疑','回應'],rows:[{cells:['一','二']},{cells:['三','四']},{cells:['壞掉的列']}]},{title:'太小',headers:['只有一欄'],rows:[]}]});
    if(p.includes('"sections"')){fullCalls+=p.includes('"headline"')?1:0;partCalls+=p.includes('"headline"')?0:1;
      const sections=[sec(ts[0]+1,'甲'),sec(ts[Math.floor(ts.length/2)],'乙'),sec(ts[Math.floor(ts.length/2)],'重複的時間'),{t:ts[3],title:'',role:'',points:[],tables:[]}];
      out=p.includes('"headline"')?{...meta,sections}:{sections}}
    else if(p.includes('推論強弱檢查')){overviewCalls++;out=meta}
    else if(p.includes('"zh":['))out={zh:p.split('\n').filter(l=>/^\d+\. /.test(l)).map(l=>'譯:'+l.slice(0,12))};
    else out={role:'作用',points:['a','b','c','d'],tables:[]}}
  return {ok:true,json:async()=>({candidates:[{content:{parts:[{text:'```json\n'+JSON.stringify(out)+'\n```'}]}}]})}};
const deps={fetch:fetchStub,geminiKey:'k',videoModel:'m',textModel:'m'};
let row={video_id:'oFtjKbXKqbg',url:'u',title:'',status:'queued',work:{},content:null};let steps=0;
while(row.status!=='ready'){row={...row,...await ingestStep(row,deps)};steps++;assert(steps<80,'runaway');assert(row.status!=='error',row.error)}
const c=row.content;console.log('ingest ok: steps',steps,'chapters',c.chapters.length,'segs',c.segs.length,'turns',c.segs.reduce((a,g)=>a+g.turns.length,0),'duration',c.duration);
const kept=c.segs.flatMap(g=>g.turns.flatMap(t=>t.s.map(p=>p[0]))).join(' ').replace(/\s+/g,' ');const want=[...real].sort((p,q)=>p.t-q.t).map(t=>t.text).join(' ').replace(/\s+/g,' ');assert(kept===want,'every word kept once, in order');assert(c.duration===13409,'duration from token count');
// a video too long for one answer: (A)+(C) from the whole transcript and (B) an hour at a time, all in the same step
assert(fullCalls===0&&overviewCalls===1&&partCalls===4,'long video: one overview and one request per hour: '+[fullCalls,overviewCalls,partCalls]);
assert(c.chapters.length===8&&c.segs.every(g=>g.deep===true&&g.role&&g.points.length===4&&g.tables.length===1&&g.tables[0].rows.length===2),'every section arrives written, tables tidied: '+c.chapters.length);
assert(c.chapters[0].t===c.segs[0].turns[0].t&&c.chapters.every((x,i)=>x.zh===c.segs[i].title&&x.sum===c.segs[i].role&&x.take===''),'sections start at the first line; the list shows what her prompt wrote');
assert(c.thesis==='主旨'&&c.brief.principle==='原理'&&c.brief.reminder==='提醒'&&c.brief.groups.length===1&&c.brief.groups[0].points.length===2,'overview: headline, principle, groups without empty ones, reminder');
assert(c.brief.check.solid.length===1&&c.brief.check.assumptions.length===2&&c.brief.check.evidence.length===0&&c.brief.check.contradictions[0]==='矛盾','overview keeps the reasoning check');
// a video that fits: ONE request carries her whole prompt and the whole transcript, and the model decides the sections
{const short=real.filter(t=>t.t<1500);let r2={video_id:'shortshort1',url:'u',title:'',status:'processing',content:null,work:{phase:'outline',turns:short,visuals:[],channel:'',duration:1500,length:1500}},k=0,seen='';
 const spy={...deps,fetch:async(u,o)=>{const b=JSON.parse(o.body);seen=b.contents[0].parts[0].text||'';return fetchStub(u,o)}};const before=calls;
 while(r2.status!=='ready'){r2={...r2,...await ingestStep(r2,spy)};k++;assert(k<5,'runaway short')}
 const her=fs.readFileSync(new URL('./fixtures/owner-prompt.txt',import.meta.url),'utf8');
 assert(k===1&&calls-before===1&&fullCalls===1,'short video: one step, one request');
 assert(seen.startsWith(her.slice(0,her.indexOf('\n\n# 逐字稿')))&&seen.includes('['+short[0].t+'] ')&&seen.includes(short[short.length-1].text),'that request starts with her prompt word for word and carries the whole transcript with its times');
 assert(r2.content.segs.length===2&&r2.content.segs[1].title==='乙'&&r2.work.phase==='translate','sections as the model cut them; only translation is left')}
// background translation: starts once readable, does every sentence, keeps going when one of three parallel requests fails
assert(row.work.phase==='translate'&&row.progress.phase==='translate','translation queued once readable');
{const snap=JSON.stringify(row);let tr=JSON.parse(snap),k=0,flaky=0;
 const flakyDeps={...deps,fetch:async(u,o)=>{if(++flaky%4===0)return {ok:false,status:503,json:async()=>({error:{message:'overloaded'}})};return fetchStub(u,o)}};
 while(tr.work.phase==='translate'){tr={...tr,...await ingestStep(tr,flakyDeps)};k++;assert(k<200,'runaway translate');assert(tr.status==='ready','stays readable')}
 const all=tr.content.segs.flatMap(g=>g.turns.flatMap(t=>t.s));assert(all.every(p=>p[1]&&p[1].startsWith('譯:')),'every sentence translated');
 assert(all.every(p=>p[0].startsWith(p[1].slice(2).replace(/^\d+\. /,''))),'each translation sits on its own sentence');
 const dead={...deps,fetch:async()=>({ok:false,status:503,json:async()=>({error:{message:'overloaded'}})})};let t2=false;try{await ingestStep(JSON.parse(snap),dead)}catch(e){t2=e.message==='overloaded'}assert(t2,'all requests failing fails the step');
 console.log('translate ok: steps',k,'sentences',all.length);
 tr={...tr,...await ingestStep(tr,deps)};assert(tr.work.phase==='ready'&&tr.status==='ready','nothing left after translation: the sections were written with the overview')}
// one section written again from the reader
row.content.segs[1].deep=false;row.content.segs[1].turns.forEach(tu=>tu.s.forEach(p=>{p[1]=null}));
let d=0,r;do{r=await deepenStep(row,1,deps);if(r.content)row.content=r.content;d++;assert(d<200,'runaway deepen')}while(!r.done);
const g=row.content.segs[1];assert(g.deep&&g.turns.every(t=>t.s.every(p=>p[1])),'translated');assert(g.points.length===4&&g.role==='作用'&&row.content.chapters[1].sum==='作用','one section rewritten, and the list follows');
console.log('deepen ok: calls',d,'sentences',g.turns.reduce((a,t)=>a+t.s.length,0));
// the owner's prompt reaches the model word for word
{const her=fs.readFileSync(new URL('./fixtures/owner-prompt.txt',import.meta.url),'utf8');const src=fs.readFileSync(new URL('../supabase/functions/ingest/pipeline.js',import.meta.url),'utf8');
 const mine=src.match(/const OWNER = `([\s\S]*?)`;/)[1];assert(mine===her.slice(0,her.indexOf('\n\n# 逐字稿')),'OWNER is no longer the owner\'s text word for word');
 console.log('owner prompt ok: identical to her text')}
// a failed unit must not lose progress
const bad={...deps,fetch:async()=>({ok:false,status:503,json:async()=>({error:{message:'overloaded'}})})};
let threw=false;try{const cp=JSON.parse(JSON.stringify(row.content));cp.segs[2].deep=false;cp.lang='zh-TW';await deepenStep({...row,content:cp},2,bad)}catch(e){threw=e.message==='overloaded'}assert(threw,'error surfaces');
console.log('all pipeline tests passed');
