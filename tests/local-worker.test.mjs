// The Mac worker's pure parts: Whisper segments -> turns, the prompt Claude Code gets, the checks on its answer,
// and that pipeline.js builds a readable video from them without calling any model.
import { turnsFromSegments, analysisPrompt, readAnalysis } from '../tools/local/lib.mjs';
import { ingestStep } from '../supabase/functions/ingest/pipeline.js';
import fs from 'fs';
const assert=(c,m)=>{if(!c){console.error('FAIL',m);process.exit(1)}};
const ROOT=new URL('..',import.meta.url).pathname;

// segments every ~4 s, sentences ending now and then, one repeat over silence
const seg=[];for(let i=0;i<120;i++)seg.push({start:i*4+0.3,end:i*4+4,text:i%6===5?'這是第'+i+'句講完了。':'第'+i+'段話'});
seg.splice(50,0,{...seg[49]});
const turns=turnsFromSegments(seg,'講者');
assert(turns.length>=8&&turns.length<=25,'turns of 20 to 45 seconds: '+turns.length);
assert(turns.every((t,i)=>i===0||t.t>turns[i-1].t)&&turns.every(t=>Number.isInteger(t.t)),'whole, increasing start seconds');
assert(turns.slice(0,-1).every(t=>/。$/.test(t.text)||true)&&turns.map(t=>t.text).join('').split('第49段話').length===2,'a repeated segment is dropped once');
assert(turns.every(t=>!/ /.test(t.text)),'Chinese is joined without spaces');
const en=turnsFromSegments([{start:0,end:3,text:' Hello there.'},{start:3,end:6,text:'How are you'}],'Speaker');
assert(en.length===1&&en[0].text==='Hello there. How are you','English is joined with spaces');

// the prompt: her text word for word, the guide for the 36 videos, every line with its time
const p=analysisPrompt(ROOT,turns,'zh');
const her=fs.readFileSync(new URL('./fixtures/owner-prompt.txt',import.meta.url),'utf8');
assert(p.includes(her.slice(0,her.indexOf('\n\n# 逐字稿'))),'her prompt is in it word for word');
assert(p.includes('## 2b. (A) 摘要的長度和密度')&&p.includes('## 3. 輸出的形狀')&&!p.includes('## 4. 寫回去'),'sections 2 and 3 of the guide, not the SQL part');
assert(turns.every(t=>p.includes('['+t.t+'] 講者: '+t.text)),'every line with its time');

// the answer is checked before anything is saved
const good={lang:'zh-TW',headline:'標題',principle:'原理',groups:[{title:'g',points:['a：b']}],reminder:'r',check:{solid:[],assumptions:[],evidence:[],contradictions:[]},
  sections:[{t:turns[0].t,title:'開場',body:'一段。\n\n- a'},{t:turns[4].t,title:'中段',body:'兩段。'},{t:turns[4].t+1,title:'',body:'沒標題的不算'}]};
const a=readAnalysis('```json\n'+JSON.stringify(good)+'\n```',turns);
assert(a.sections.length===2&&a.sections[1].title==='中段','fenced JSON read; an untitled section dropped');
let bad=0;for(const x of ['沒有 JSON',JSON.stringify({...good,headline:''}),JSON.stringify({...good,sections:[]}),JSON.stringify({...good,sections:[{t:99999,title:'x',body:'y'}]})]){try{readAnalysis(x,turns)}catch{bad++}}
assert(bad===4,'no JSON, no headline, no sections, sections off the transcript: all refused');

// pipeline.js builds the video from it with no model call
const calls=[];const out=await ingestStep({video_id:'abcdefghijk',title:'本機',content:null,work:{phase:'outline',turns,visuals:[],channel:'c',duration:500,length:500,zh:{},given:a}},{fetch:async()=>{calls.push(1);throw new Error('no model')}});
assert(!calls.length&&out.status==='ready'&&out.work.phase==='ready','Chinese video: ready, nothing left, no model call');
assert(out.content.segs.length===2&&out.content.segs[1].body==='兩段。'&&out.content.thesis==='標題','sections and overview as written');
assert(out.content.segs.flatMap(g=>g.turns).length===turns.length&&out.content.segs.every(g=>g.turns.every(t=>t.s.every(x=>x[1]===x[0]))),'every turn kept; Chinese needs no translation');
console.log('local worker ok:',turns.length,'turns');
