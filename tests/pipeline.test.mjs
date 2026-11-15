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
let calls=0;
const mmss=t=>Math.floor(t/3600)+':'+String(Math.floor(t%3600/60)).padStart(2,'0')+':'+String(t%60).padStart(2,'0');
const fetchStub=async(url,opt)=>{calls++;
  if(url.includes(':countTokens')){const vm=JSON.parse(opt.body).contents[0].parts[0].video_metadata;return {ok:true,json:async()=>({promptTokensDetails:[{modality:'AUDIO',tokenCount:vm?60*32:13409*32}]})}}
  if(url.includes('oembed'))return {ok:true,json:async()=>({title:'Pieter Levels',author_name:'Lex Fridman'})};
  const body=JSON.parse(opt.body),parts=body.contents[0].parts,vm=parts[0].video_metadata;let out;
  if(vm){const a=parseInt(vm.start_offset),b=parseInt(vm.end_offset);const turns=real.filter(t=>t.t>=a&&t.t<b);
    // every third chunk answers with clip-relative times, to exercise the offset repair
    const rel=(a/300)%3===2;out={turns:turns.map(t=>({ts:mmss(rel?t.t-a:t.t),speaker:t.speaker,text:t.text})),visuals:[],reached_end:true}}
  else{const p=parts[0].text;
    if(p.includes('"worth":[<'))out={lang:'en',title:'x',host:'Lex Fridman',thesis:'主旨',tldr:['a','b','c'],worth:p.match(/^\d+\. \[/gm).map((_,i)=>i===1?3:1)};
    else if(p.includes('"chapters"')&&p.includes('部分（共'))out={chapters:(()=>{const ts=[...p.matchAll(/^\[(\d+)\]/gm)].map(m=>+m[1]);return [{t:ts[0],en:'A',zh:'甲',sum:'s',take:'',worth:2},{t:ts[Math.floor(ts.length/2)],en:'B',zh:'乙',sum:'s',take:'t',worth:3}]})()};
    else if(p.includes('"chapters"'))out={lang:'en',title:'x',host:'Lex Fridman',thesis:'主旨',tldr:['a','b','c'],chapters:[{t:0,en:'Intro',zh:'開場',sum:'s',take:'',insight:'',worth:1},{t:125,en:'Philosophy',zh:'哲學',sum:'s',take:'t',worth:3},{t:9234,en:'Ship fast',zh:'快速上線',sum:'s',take:'t',worth:3}]};
    else if(p.includes('"zh":['))out={zh:p.split('\n').filter(l=>/^\d+\. /.test(l)).map(l=>'譯:'+l.slice(0,12))};
    else out={title:'標題',spark:'火花',sum:['1','2','3'],core:'核心',chain:['a','b','c','d'],ask:'問?',key:[3,4],counter:'反方?'}}
  return {ok:true,json:async()=>({candidates:[{content:{parts:[{text:'```json\n'+JSON.stringify(out)+'\n```'}]}}]})}};
const deps={fetch:fetchStub,geminiKey:'k',videoModel:'m',textModel:'m'};
let row={video_id:'oFtjKbXKqbg',url:'u',title:'',status:'queued',work:{},content:null};let steps=0;
while(row.status!=='ready'){row={...row,...await ingestStep(row,deps)};steps++;assert(steps<80,'runaway');assert(row.status!=='error',row.error)}
const c=row.content;console.log('ingest ok: steps',steps,'chapters',c.chapters.length,'segs',c.segs.length,'turns',c.segs.reduce((a,g)=>a+g.turns.length,0),'duration',c.duration);
const kept=c.segs.flatMap(g=>g.turns.flatMap(t=>t.s.map(p=>p[0]))).join(' ').replace(/\s+/g,' ');const want=[...real].sort((p,q)=>p.t-q.t).map(t=>t.text).join(' ').replace(/\s+/g,' ');assert(kept===want,'every word kept once, in order');assert(c.duration===13409,'duration from token count');
assert(c.chapters.length===8&&c.chapters[1].worth===3&&c.chapters[0].worth===1,'windowed outline: 4 windows x 2 chapters, re-rated');assert(c.thesis==='主旨','synth');
let d=0,r;do{r=await deepenStep(row,1,deps);if(r.content)row.content=r.content;d++;assert(d<200,'runaway deepen')}while(!r.done);
const g=row.content.segs[1];assert(g.deep&&g.turns.every(t=>t.s.every(p=>p[1])),'translated');assert(g.key.length===2&&g.chain.length===4,'analysis');
console.log('deepen ok: calls',d,'sentences',g.turns.reduce((a,t)=>a+t.s.length,0),'key',JSON.stringify(g.key));
// a failed unit must not lose progress
const bad={...deps,fetch:async()=>({ok:false,status:503,json:async()=>({error:{message:'overloaded'}})})};
let threw=false;try{await deepenStep({...row,content:JSON.parse(JSON.stringify(row.content))},2,bad)}catch(e){threw=e.message==='overloaded'}assert(threw,'error surfaces');
console.log('all pipeline tests passed');
