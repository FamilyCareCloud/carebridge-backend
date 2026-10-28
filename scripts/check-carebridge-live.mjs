import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

const base=process.env.CAREBRIDGE_TEST_BASE ?? 'http://127.0.0.1:3002';
if (!['localhost','127.0.0.1'].includes(new URL(base).hostname)) throw new Error('이 합성 계정 검증은 로컬 서버에서만 실행합니다.');
const password='CareBridge!Demo26';
async function send(actor,method,path,body,expected=200){
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(actor?{Authorization:'Bearer '+actor.accessToken}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json();
  assert.equal(response.status,expected,method+' '+path+': '+JSON.stringify(value));
  return value;
}
async function user(email,name){
  const response=await fetch(base+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,name,password})});
  assert.ok([201,409].includes(response.status));
  return send(null,'POST','/auth/login',{email,password});
}
const reviewer=await user('reviewer@example.test','교육용 검토자');
const author=await user('author@example.test','교육용 작성자');
const family=await user('family@example.test','교육용 가족');
const groups=await send(reviewer,'GET','/groups');
const group=groups.find(g=>g.name==='케어브릿지 교육용 데모') ?? await send(reviewer,'POST','/groups',{name:'케어브릿지 교육용 데모'},201);
let members=await send(reviewer,'GET','/groups/'+group.id+'/members');
for(const [actor,role] of [[author,'caregiver'],[family,'elder']]){
  if(members.some(m=>m.userId===actor.user.userId))continue;
  const invitation=await send(reviewer,'POST','/groups/'+group.id+'/invitations',{email:actor.user.email,role},201);
  await send(actor,'POST','/invitations/accept',{token:invitation.token});
}
members=await send(reviewer,'GET','/groups/'+group.id+'/members');
const root='/groups/'+group.id+'/carebridge';
const report={runAt:new Date().toISOString(),scope:'local synthetic end-to-end, real GPU, not clinical evaluation',checks:[]};
const check=(name)=>{report.checks.push(name);console.log('PASS '+name);};
const created=await send(author,'POST',root+'/notes',{memo:'Ate half the breakfast.',sourceLanguage:'en',dataUse:'synthetic_deidentified',requestId:randomUUID()},201);
assert.equal(created.draft.source.text,'Ate half the breakfast.');check('real GPU translation and immutable source');
await send(family,'GET',root+'/notes/'+created.id,undefined,403);
await send(family,'GET',root+'/notes/'+created.id+'/preview',undefined,409);check('family blocked before approval');
await send(author,'POST',root+'/notes/'+created.id+'/review',{expectedVersion:created.version,decision:'approve',reason:'권한 차단 검증',confirmSource:true},403);check('author cannot approve');
const approved=await send(reviewer,'POST',root+'/notes/'+created.id+'/review',{expectedVersion:created.version,decision:'approve',reason:'원문과 번역, 근거를 대조했습니다.',confirmSource:true,confirmChecks:true});
assert.equal(approved.status,'approved');
const preview=await send(family,'GET',root+'/notes/'+created.id+'/preview');
assert.equal(preview.source,undefined);assert.equal(preview.draft,undefined);check('reviewer approval and redacted manual family preview');
const segments=approved.draft.translation.segments.map((t,i)=>({segmentId:t.evidence.segment_id,text:t.text,category:approved.draft.observations[i].category,needsConfirmation:false}));
segments[0].text='아침 식사를 절반 드셨습니다.';
const edited=await send(author,'PATCH',root+'/notes/'+created.id,{expectedVersion:approved.version,reason:'한국어 표현을 원문과 대조해 다듬었습니다.',segments});
assert.equal(edited.status,'review_required');
await send(family,'GET',root+'/notes/'+created.id+'/preview',undefined,409);
await send(reviewer,'POST',root+'/notes/'+created.id+'/review',{expectedVersion:approved.version,decision:'approve',reason:'오래된 버전 차단',confirmSource:true},409);check('editing revokes preview and stale approval is rejected');
const held=await send(reviewer,'POST',root+'/notes/'+created.id+'/review',{expectedVersion:edited.version,decision:'hold',reason:'추가 확인을 위해 보류합니다.'});
assert.equal(held.status,'hold');check('reviewer can hold without a model decision');
const final=await send(reviewer,'POST',root+'/notes/'+created.id+'/review',{expectedVersion:held.version,decision:'approve',reason:'추가확인을 마치고 원문과 다시 대조했습니다.',confirmSource:true,confirmChecks:true});
assert.equal(final.status,'approved');check('held note can be rechecked and explicitly reapproved');
const versions=await send(reviewer,'GET',root+'/notes/'+created.id+'/versions');
assert.equal(versions.length,5);
const original=await send(author,'GET',root+'/notes/'+created.id+'/versions/1');
assert.equal(original.draft.source.text,created.source.text);
await send(family,'GET',root+'/notes/'+created.id+'/versions/1',undefined,403);check('immutable version history remains private');
const audioPath=resolve(process.env.CAREBRIDGE_TEST_AUDIO ?? (existsSync('../carebridge-ai')?'../carebridge-ai/evaluation/synthetic-english.wav':'../fcc-ai/evaluation/synthetic-english.wav'));
const transcript=await send(author,'POST',root+'/transcriptions',{audioBase64:readFileSync(audioPath).toString('base64'),sourceLanguage:'en',dataUse:'synthetic_deidentified'});
assert.equal(transcript.requiresTranscriptReview,true);check('real multilingual STT returns an editable transcript');
report.noteId=created.id;report.groupId=group.id;report.allPassed=true;
mkdirSync('data',{recursive:true});writeFileSync('data/carebridge-live-report.json',JSON.stringify(report,null,2));
if(process.argv.includes('--visual-fixture')){
  const full=await send(reviewer,'GET','/groups/'+group.id);
  const fixture={group:full,members,users:{reviewer,author,family}};
  mkdirSync('../fcc-frontend/.local',{recursive:true});
  writeFileSync('../fcc-frontend/.local/fixture.json',JSON.stringify(fixture));
}
console.log('Report: data/carebridge-live-report.json');
