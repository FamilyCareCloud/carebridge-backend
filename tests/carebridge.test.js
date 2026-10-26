import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { hash, evidenceSegments } from '../src/carebridge-contract.js';
import { CarebridgeClient } from '../src/adapters/carebridge.js';

const codes=['SOURCE_INTEGRITY','SOURCE_COVERAGE','EVIDENCE_PRESERVED','TRANSLATION_CONSISTENCY','OBSERVATION_GROUNDING','NUMERIC_FACTS_PRESERVED','NEGATION_SIGNAL_PRESERVED','UNCERTAINTY_SIGNAL_PRESERVED','FOLLOW_UP_GROUNDING','NO_IDENTIFIERS_DETECTED','NO_MEDICAL_JUDGMENT','NO_INSTRUCTIONS','SHARING_BLOCKED'];
const semantic=['SEMANTIC_NEGATION','SEMANTIC_UNCERTAINTY','SEMANTIC_ADDED_FACTS','SEMANTIC_MEDICAL'];
function qa(hold=false,withSemantic=false) {
  return {checks:[...codes,...(withSemantic?semantic:[])].map(code=>({code,passed:!hold||code!=='NUMERIC_FACTS_PRESERVED'})),issues:[{code:'HUMAN_REVIEW_REQUIRED',severity:'review',message:'사람 검토 필수'},...(hold?[{code:'NUMERIC_FACTS_PRESERVED',severity:'hold',message:'숫자 확인'}]:[])],requires_human_review:true,external_share_allowed:false};
}
export function makeDraft(memo) {
  const refs=evidenceSegments(memo), segments=refs.map(e=>({text:/[가-힣]/u.test(e.quote)?e.quote:'아침 식사를 절반 드셨습니다.',evidence:e}));
  return {schema_version:'carebridge.v1',id:randomUUID(),status:'review_required',label:'검토 전 초안 · 공식기록 아님',mode:/[가-힣]/u.test(memo)?'source_preserving':'model_translation',source:{kind:'text',language:/[가-힣]/u.test(memo)?'ko':'en',text:memo,sha256:hash(memo)},translation:{language:'ko',text:segments.map(t=>t.text).join('\n'),segments},observations:segments.map((t,i)=>({id:'o'+i,category:'meal',text:t.text,evidence:t.evidence})),additional_checks:[],qa:qa()};
}
async function fixture(options={}) {
  const store=new Store(), calls={draft:0,qa:0,transcribe:0};
  const ai={enabled:true,
    draft:async input=>{calls.draft++;return makeDraft(input.memo);},
    qa:async()=>{calls.qa++;return {status:'review_required',model_checked:true,segments:[],qa:qa(false,true)};},
    transcribe:async()=>{calls.transcribe++;return {text:'아침 식사를 절반 드셨습니다.',requires_transcript_review:true};},
    ...options,
  };
  const app=createApp(store,{carebridge:ai});
  const call=(user,method,path,body={})=>app({method,path,body,token:user?.token});
  async function signup(email) {
    const body={name:'교육용 사용자',email,password:'Synthetic!123'};
    const registered=await call(null,'POST','/auth/register',body); assert.equal(registered.status,201);
    const r=await call(null,'POST','/auth/login',{email,password:body.password});
    assert.equal(r.status,200);
    return {id:r.body.user.userId,email,token:r.body.accessToken};
  }
  const reviewer=await signup('reviewer@example.com'), author=await signup('author@example.com'), family=await signup('family@example.com'), stranger=await signup('stranger@example.com');
  const g=(await call(reviewer,'POST','/groups',{name:'교육용 그룹'})).body;
  for (const [u,role] of [[author,'caregiver'],[family,'elder']]) {
    const invitation=await call(reviewer,'POST','/groups/'+g.id+'/invitations',{email:u.email,role});
    assert.equal((await call(u,'POST','/invitations/accept',{token:invitation.body.token})).status,200);
  }
  const p='/groups/'+g.id+'/carebridge';
  const create=(extra={})=>call(author,'POST',p+'/notes',{memo:'  아침 식사를 절반 드셨습니다.\n물을 마셨습니다.  ',sourceLanguage:'ko',dataUse:'synthetic_deidentified',requestId:randomUUID(),...extra});
  const decide=(note,decision='approve',extra={})=>call(reviewer,'POST',p+'/notes/'+note.id+'/review',{expectedVersion:note.version,decision,reason:'원문과 관찰 항목을 대조했습니다.',confirmSource:true,confirmChecks:true,...extra});
  return {store,ai,calls,call,create,decide,p,g,reviewer,author,family,stranger};
}
test('CareBridge 작성→원문 보존→검토자 승인→가족 수동 미리보기, 원본은 가족에게 노출하지 않음',async()=>{
  const f=await fixture(), r=await f.create(); assert.equal(r.status,201,JSON.stringify(r));
  const n=r.body;assert.equal(n.status,'review_required');
  assert.equal(n.source.text,'  아침 식사를 절반 드셨습니다.\n물을 마셨습니다.  ');
  assert.equal((await f.call(f.family,'GET',f.p+'/notes/'+n.id)).status,403);
  assert.equal((await f.call(f.family,'GET',f.p+'/notes/'+n.id+'/preview')).status,409);
  assert.deepEqual((await f.call(f.family,'GET',f.p+'/family')).body.items,[]);
  const approved=await f.decide(n);assert.equal(approved.status,200,JSON.stringify(approved));
  assert.equal(approved.body.status,'approved'); assert.equal(approved.body.approvedVersion,approved.body.version);
  const preview=await f.call(f.family,'GET',f.p+'/notes/'+n.id+'/preview');
  assert.equal(preview.status,200);
  assert.equal(preview.body.manualOnly,true);
  for(const key of ['source','draft','qa','history','createdBy']) assert.equal(preview.body[key],undefined);
  assert.equal((await f.call(f.family,'GET',f.p+'/notes/'+n.id+'/versions/1')).status,403);
  assert.equal((await f.call(f.stranger,'GET',f.p+'/notes/'+n.id+'/preview')).status,404);
  const group=(await f.call(f.family,'GET','/groups/'+f.g.id)).body;
  assert.equal(JSON.stringify(group).includes('아침 식사를 절반'),false);
});
test('승인 후 수정하면 공유 즉시 철회, 과거 승인 버전도 가족 경로로 접근 불가',async()=>{
  const f=await fixture(), created=(await f.create()).body, approved=(await f.decide(created)).body;
  const edits=approved.draft.translation.segments.map((t,i)=>({segmentId:t.evidence.segment_id,text:t.text,category:approved.draft.observations[i].category,needsConfirmation:false}));
  edits[0].text='아침 식사를 일부 드셨습니다.';
  const edit=await f.call(f.author,'PATCH',f.p+'/notes/'+created.id,{expectedVersion:approved.version,reason:'작성자가 표현을 확인했습니다.',segments:edits});
  assert.equal(edit.status,200,JSON.stringify(edit));
  assert.equal(edit.body.status,'review_required');
  assert.equal(edit.body.approvedVersion,null);
  assert.equal((await f.call(f.family,'GET',f.p+'/notes/'+created.id+'/preview')).status,409);
  assert.equal((await f.decide(created)).status,409);
  const history=await f.call(f.reviewer,'GET',f.p+'/notes/'+created.id+'/versions');
  assert.equal(history.body.length,3);
  const first=await f.call(f.author,'GET',f.p+'/notes/'+created.id+'/versions/1');
  assert.equal(first.body.draft.source.text,created.source.text);
  assert.equal(first.body.draft.translation.segments[0].text,created.draft.translation.segments[0].text);
  assert.equal((await f.decide(edit.body)).status,200);
});
test('작성자·가족·자가 승인·권한 승격·원문/QA/상태 위조를 서버에서 차단',async()=>{
  const f=await fixture(), n=(await f.create()).body;
  const review={expectedVersion:n.version,decision:'approve',reason:'확인',confirmSource:true};
  assert.equal((await f.call(f.author,'POST',f.p+'/notes/'+n.id+'/review',review)).status,403);
  assert.equal((await f.call(f.family,'POST',f.p+'/notes',{})).status,403);
  assert.equal((await f.call(f.author,'PATCH',f.p+'/roles',{expectedVersion:1,userId:f.author.id,role:'reviewer'})).status,403);
  for(const extra of [{status:'approved'},{qa:qa()},{source:{text:'변조'}}]) {
    assert.equal((await f.call(f.author,'PATCH',f.p+'/notes/'+n.id,{expectedVersion:n.version,reason:'위조',segments:[],...extra})).status,400);
  }
  const self=(await f.call(f.reviewer,'POST',f.p+'/notes',{memo:'식사를 하셨습니다.',dataUse:'synthetic_deidentified',requestId:randomUUID()})).body;
  assert.equal((await f.decide(self)).status,403);
  assert.equal((await f.call(f.stranger,'GET',f.p+'/roles')).status,404);
});
test('원문 구간·추가필드·AI 승인/공유 우회와 잘린 검사 결과를 차단',async()=>{
  for(const mutate of [
    d=>{d.status='approved';},d=>{d.qa.external_share_allowed=true;},
    d=>{d.source.sha256='forged';},d=>{d.translation.segments[0].evidence.start=0;},
    d=>{d.translation.segments.reverse();},d=>{d.qa.checks=[];},
  ]) {
    const f=await fixture({draft:async({memo})=>{const d=makeDraft(memo);mutate(d);return d;}});
    const r=await f.create();assert.equal(r.status,502,JSON.stringify(r));
    assert.deepEqual((await f.call(f.reviewer,'GET',f.p+'/notes')).body.items,[]);
  }
  const f=await fixture(),n=(await f.create()).body;
  f.ai.qa=async()=>({status:'review_required',model_checked:false,qa:qa(false,true)});
  assert.equal((await f.decide(n)).status,502);
});
test('QA 보류·모델 장애는 승인으로 바뀌지 않으며 수동 보류는 AI 장애 중에도 가능',async()=>{
  const f=await fixture(),n=(await f.create()).body;
  f.ai.qa=async()=>({status:'hold',model_checked:false,qa:qa(true)});
  assert.equal((await f.decide(n)).status,409);
  f.ai.qa=async()=>{throw Object.assign(new Error('장애'),{status:503});};
  assert.equal((await f.decide(n)).status,503);
  const held=await f.decide(n,'hold');assert.equal(held.status,200);assert.equal(held.body.status,'hold');
  assert.equal((await f.call(f.family,'GET',f.p+'/notes/'+n.id+'/preview')).status,409);
});
test('동시 수정과 승인 경쟁은 최신 버전만 성공, 승인 중 역할 철회도 재검사',async()=>{
  const f=await fixture(),n=(await f.create()).body;
  let entered,release;
  const reached=new Promise(r=>entered=r), gate=new Promise(r=>release=r);
  f.ai.qa=async()=>{entered();await gate;return {status:'review_required',model_checked:true,qa:qa(false,true)};};
  const pending=f.decide(n);await reached;
  const held=await f.decide(n,'hold');assert.equal(held.status,200);
  release();assert.equal((await pending).status,409);
  assert.equal((await f.call(f.family,'GET',f.p+'/notes/'+n.id+'/preview')).status,409);
});
test('목록·타 그룹·전사 호출의 접근 통제 및 재시도 멱등성',async()=>{
  const f=await fixture(),requestId=randomUUID();
  const a=await f.create({requestId}), b=await f.create({requestId});
  assert.equal(a.body.id,b.body.id);assert.equal(f.calls.draft,1);
  assert.equal((await f.create({requestId,memo:'다른 메모'})).status,409);
  assert.equal((await f.call(f.family,'GET',f.p+'/notes')).status,403);
  assert.equal((await f.call(f.stranger,'GET',f.p+'/notes')).status,404);
  const audio={audioBase64:Buffer.from('wav').toString('base64'),dataUse:'synthetic_deidentified'};
  assert.equal((await f.call(f.family,'POST',f.p+'/transcriptions',audio)).status,403);
  assert.equal(f.calls.transcribe,0);
  assert.equal((await f.call(f.author,'POST',f.p+'/transcriptions',audio)).body.requiresTranscriptReview,true);
  assert.equal((await f.call(f.author,'POST',f.p+'/transcriptions',{...audio,audioBase64:'!bad'})).status,400);
  assert.equal((await f.call(f.reviewer,'GET',f.p+'/notes?limit=1')).body.items.length,1);
});
test('CareBridge HTTP 아답터: 키는 서버 헤더만, 리다이렉트/타임아웃/응답 상한 실패',async()=>{
  let called=0;
  const client=new CarebridgeClient({baseUrl:'http://127.0.0.1:8002',apiKey:'only-server',fetchImpl:async(url,opts)=>{
    called++;assert.equal(opts.headers['X-API-Key'],'only-server');assert.equal(opts.redirect,'error');
    assert.equal(url,'http://127.0.0.1:8002/carebridge/drafts');
    assert.equal(opts.body.includes('only-server'),false);
    return new Response(JSON.stringify({ok:true}));
  }});
  assert.deepEqual(await client.draft({memo:'가상 메모'}),{ok:true});assert.equal(called,1);
  for(const baseUrl of ['http://external.example','https://user:pass@example.com']) {
    await assert.rejects(new CarebridgeClient({baseUrl,fetchImpl:()=>assert.fail()}).draft({}),e=>e.status===503);
  }
  await assert.rejects(new CarebridgeClient({baseUrl:'https://example.com',fetchImpl:async()=>new Response('x'.repeat(256001))}).draft({}),e=>e.status===502);
});


test('검사 도중 검토자 역할이 철회되면 최종 승인 저장을 거부',async()=>{
  const f=await fixture();
  assert.equal((await f.call(f.reviewer,'PATCH',f.p+'/roles',{expectedVersion:1,userId:f.author.id,role:'reviewer'})).status,200);
  const own=await f.call(f.reviewer,'POST',f.p+'/notes',{memo:'식사를 하셨습니다.',dataUse:'synthetic_deidentified',requestId:randomUUID()});
  let entered,release; const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  f.ai.qa=async()=>{entered();await gate;return {status:'review_required',model_checked:true,qa:qa(false,true)};};
  const pending=f.call(f.author,'POST',f.p+'/notes/'+own.body.id+'/review',{expectedVersion:1,decision:'approve',reason:'원문 대조',confirmSource:true});
  await reached;
  assert.equal((await f.call(f.reviewer,'PATCH',f.p+'/roles',{expectedVersion:2,userId:f.author.id,role:'family'})).status,200);
  release();assert.equal((await pending).status,403);
  assert.equal((await f.call(f.family,'GET',f.p+'/notes/'+own.body.id+'/preview')).status,409);
});


test('보관 버전 한도에서도 승인된 메모의 수동 보류·미리보기 철회는 가능',async()=>{
  const f=await fixture(),created=(await f.create()).body,approved=(await f.decide(created)).body;
  await f.store.transaction(async tx=>{
    const key='carebridge-note#'+f.g.id+'#'+created.id;
    const note=await tx.get(key);
    note.version=500;note.approvedVersion=500;note.history=Array.from({length:500},(_,i)=>({version:i+1,action:'check',reason:'보관 이력',by:f.reviewer.id,at:note.createdAt,status:'review_required'}));
    await tx.set(key,note);
    await tx.set('carebridge-version#'+f.g.id+'#'+created.id+'#500',{draft:approved.draft});
  });
  const held=await f.decide({...approved,version:500},'hold');
  assert.equal(held.status,200);assert.equal(held.body.status,'hold');
  assert.equal((await f.call(f.family,'GET',f.p+'/notes/'+created.id+'/preview')).status,409);
});
