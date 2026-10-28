import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { AuthService } from '../src/services/auth.js';
import { createHttpServer } from '../src/handlers/http.js';
import { evidenceSegments, hash } from '../src/carebridge-contract.js';
import { CognitoAuthService } from '../src/adapters/cognito.js';
import { workspacePolicy } from '../src/workspace-policy.js';
import { createLambdaHandler } from '../src/handlers/lambda.js';

const password = 'Synthetic!123';
const memo = '식사를 절반 드셨습니다.';
const clock = () => '2026-10-29T00:00:00.000Z';
function draft(value) {
  const checks = ['SOURCE_INTEGRITY','SOURCE_COVERAGE','EVIDENCE_PRESERVED','TRANSLATION_CONSISTENCY','OBSERVATION_GROUNDING','NUMERIC_FACTS_PRESERVED','NEGATION_SIGNAL_PRESERVED','UNCERTAINTY_SIGNAL_PRESERVED','FOLLOW_UP_GROUNDING','NO_IDENTIFIERS_DETECTED','NO_MEDICAL_JUDGMENT','NO_INSTRUCTIONS','SHARING_BLOCKED'];
  const segments = evidenceSegments(value).map(evidence => ({ text: evidence.quote, evidence }));
  return { schema_version: 'carebridge.v1', id: randomUUID(), status: 'review_required', label: '검토 전 초안 · 공식기록 아님', mode: 'source_preserving', source: {kind:'text',text:value,language:'ko',sha256:hash(value)}, translation:{language:'ko',text:value,segments}, observations:segments.map((s,i)=>({id:`o${i}`,category:'meal',...s})),additional_checks:[],qa:{checks:checks.map(code=>({code,passed:true})),issues:[{code:'HUMAN_REVIEW_REQUIRED',severity:'review',message:'검토 필수'}],requires_human_review:true,external_share_allowed:false} };
}
async function fixture(policy = {}, overrides = {}) {
  const store = new Store(), ai = { enabled: true, draft: async input => draft(input.memo), qa: async candidate => ({status:'review_required',model_checked:true,qa:{...candidate.qa,checks:[...candidate.qa.checks,...['SEMANTIC_NEGATION','SEMANTIC_UNCERTAINTY','SEMANTIC_ADDED_FACTS','SEMANTIC_MEDICAL'].map(code=>({code,passed:true}))]}}), transcribe:async()=>({text:memo,requires_transcript_review:true}), ...overrides };
  const auth = new AuthService(store, clock);
  const app = createApp(store, { clock, auth, carebridge: ai, workspacePolicy: { confirmationEnabled: true, transferEnabled: true, recipientChange: 'block_all', ...policy } });
  const call = (u, method, path, body = {}) => app({ token: u?.token, method, path, body });
  let serial = 0;
  async function signup(role) {
    const email = `user${serial++}@example.com`;
    const r = await call(null, 'POST', '/workspace-auth/register', {email, name:role, password, role}); assert.equal(r.status, 201, JSON.stringify(r));
    const login = await call(null, 'POST', '/auth/login', {email,password}); assert.equal(login.status, 200);
    return {userId:r.body.userId,token:login.body.accessToken};
  }
  const reviewer = await signup('reviewer'), author = await signup('author'), viewer = await signup('viewer');
  const created = await call(reviewer,'POST','/workspaces',{name:'합성 QA 기관'}); assert.equal(created.status,201);
  const w = created.body, p = `/workspaces/${w.workspaceId}`;
  async function admit(u) {
    const r = await call(u,'POST','/workspaces/join-requests',{code:w.inviteCode}); assert.equal(r.status,201);
    assert.equal((await call(reviewer,'POST',`${p}/join-requests/${r.body.requestId}/approve`,{expectedVersion:1})).status,200);
  }
  await admit(author); await admit(viewer);
  const subject = (await call(reviewer,'POST',`${p}/subjects`,{name:'합성 대상자'})).body;
  async function submit(extra = {}) {
    const g = await call(author,'POST',`${p}/drafts`,{memo,sourceLanguage:'ko',dataUse:'synthetic_deidentified'}); assert.equal(g.status,201,JSON.stringify(g));
    const body = {requestId:randomUUID(),subjectId:subject.subjectId,generationId:g.body.generationId,memo,authorDraft:memo,confirmSource:true,...extra};
    return {response:await call(author,'POST',`${p}/submissions`,body), body};
  }
  async function publication() {
    const {response:s} = await submit(); assert.equal(s.status,200);
    assert.equal((await call(reviewer,'POST',`${p}/submissions/${s.body.submissionId}/check`,{expectedVersion:1})).status,200);
    const r = await call(reviewer,'POST',`${p}/submissions/${s.body.submissionId}/review`,{expectedVersion:1,decision:'confirm',confirmSource:true,confirmChecks:true}); assert.equal(r.status,200,JSON.stringify(r));
    const p1 = await call(reviewer,'POST',`${p}/publications`,{submissionId:s.body.submissionId,expectedVersion:2,content:'선별한 공개 내용',recipientIds:[viewer.userId]}); assert.equal(p1.status,200);
    return p1.body;
  }
  return {store,app,ai,auth,call,signup,admit,reviewer,author,viewer,w,p,subject,submit,publication};
}

test('가입 역할 고정, 기존 계정 자동 매핑 금지 및 기존 API 우회 차단', async () => {
  const f = await fixture();
  assert.equal((await f.call(null,'POST','/workspace-auth/register',{name:'누락',email:'missing@example.com',password})).status,400);
  assert.equal((await f.call(f.author,'PATCH','/me',{role:'reviewer'})).status,400);
  assert.equal((await f.call(f.viewer,'POST','/groups',{name:'우회'})).status,403);
  assert.equal((await f.call(f.viewer,'POST','/workspaces',{name:'우회'})).status,403);
  assert.equal((await f.call(f.viewer,'GET',`${f.p}/subjects`)).status,403);
  assert.equal((await f.call(f.author,'POST','/auth/test-role',{role:'reviewer'})).status,403);
  const old = await f.call(null,'POST','/auth/register',{name:'기존',email:'legacy@example.com',password}); assert.equal(old.status,201);
  const login = await f.call(null,'POST','/auth/login',{email:'legacy@example.com',password});
  const r = await f.call({token:login.body.accessToken},'GET','/workspaces'); assert.equal(r.body.code,'ROLE_ASSIGNMENT_REQUIRED');
});

test('코드만으로 접근 불가, 중복 대기 멱등, 거절 후 별도 요청', async () => {
  const f = await fixture(), outsider = await f.signup('author');
  const r1 = await f.call(outsider,'POST','/workspaces/join-requests',{code:f.w.inviteCode});
  const r2 = await f.call(outsider,'POST','/workspaces/join-requests',{code:f.w.inviteCode});
  assert.equal(r1.body.requestId,r2.body.requestId);
  assert.equal((await f.call(outsider,'GET',`${f.p}/subjects`)).status,404);
  assert.equal((await f.call(f.reviewer,'POST',`${f.p}/join-requests/${r1.body.requestId}/reject`,{expectedVersion:1})).status,200);
  const r3 = await f.call(outsider,'POST','/workspaces/join-requests',{code:f.w.inviteCode});
  assert.notEqual(r1.body.requestId,r3.body.requestId);
  await f.admit(outsider);
  assert.equal((await f.call(outsider,'GET',`${f.p}/subjects`)).status,200);
});

test('동명이인 동시 등록에도 관리번호 유일, 작성자 목록에서 내부 메모 제외', async () => {
  const f = await fixture();
  const rs = await Promise.all(Array.from({length:6},()=>f.call(f.reviewer,'POST',`${f.p}/subjects`,{name:'같은 이름',memo:'내부용'})));
  assert.ok(rs.every(r=>r.status===200)); assert.equal(new Set(rs.map(r=>r.body.managementNumber)).size,6);
  const list = await f.call(f.author,'GET',`${f.p}/subjects?q=같은`); assert.equal(list.body.length,6); assert.equal(JSON.stringify(list).includes('내부용'),false);
});

test('생성과 제출 분리, 같은 전송 재시도 한 건·의도적 재전송 독립 스냅샷', async () => {
  const f = await fixture(), first = await f.submit(); assert.equal(first.response.status,200);
  const retry = await f.call(f.author,'POST',`${f.p}/submissions`,first.body); assert.equal(retry.body.submissionId,first.response.body.submissionId);
  const reordered = Object.fromEntries(Object.entries(first.body).reverse());
  assert.equal((await f.call(f.author,'POST',`${f.p}/submissions`,reordered)).body.submissionId,first.response.body.submissionId);
  assert.equal((await f.call(f.author,'POST',`${f.p}/submissions`,{...first.body,authorDraft:'다른 내용'})).status,409);
  assert.equal((await f.call(f.author,'POST',`${f.p}/submissions`,{...first.body,requestId:randomUUID(),memo:'변경된 원문'})).body.code,'STALE_SOURCE');
  const second = await f.submit({parentSubmissionId:first.response.body.submissionId});
  const third = await f.submit({parentSubmissionId:second.response.body.submissionId});
  assert.equal(third.response.body.threadId,first.response.body.threadId);
  const list = await f.call(f.reviewer,'GET',`${f.p}/submissions`); assert.equal(list.body.length,3); assert.ok(list.body.every(s=>s.status==='review_pending'));
  const other = await f.signup('author'); await f.admit(other);
  assert.equal((await f.call(other,'GET',`${f.p}/submissions/${first.response.body.submissionId}`)).status,404);
  const detail = await f.call(f.author,'GET',`${f.p}/submissions/${first.response.body.submissionId}`);
  assert.equal(detail.body.memo,memo); assert.equal(detail.body.generatedDraft.source.text,memo);
});

test('보류 사유 필수·이력 보존 및 동시 검토 오래된 버전 차단', async () => {
  const f = await fixture(), {response:s} = await f.submit(), path = `${f.p}/submissions/${s.body.submissionId}/review`;
  assert.equal((await f.call(f.reviewer,'POST',path,{expectedVersion:1,decision:'hold',reason:''})).status,400);
  const held = await f.call(f.reviewer,'POST',path,{expectedVersion:1,decision:'hold',reason:'섭취량 확인 필요'}); assert.equal(held.status,200);
  assert.equal((await f.call(f.reviewer,'POST',path,{expectedVersion:1,decision:'edit',content:'오래된 내용'})).status,409);
  const detail = await f.call(f.author,'GET',`${f.p}/submissions/${s.body.submissionId}`); assert.equal(detail.body.reviews[0].reason,'섭취량 확인 필요');
  const next = await f.submit({parentSubmissionId:s.body.submissionId}); assert.equal(next.response.body.status,'review_pending');
  assert.equal((await f.call(f.author,'GET',`${f.p}/submissions/${s.body.submissionId}`)).body.status,'held');
});

test('확정과 별도 공개, 지정 수신자만 선별 내용 열람·정정 후 재공개·철회', async () => {
  const f = await fixture(), pub = await f.publication(), path = `${f.p}/publications/${pub.publicationId}`;
  assert.deepEqual((await f.call(f.viewer,'GET',`${f.p}/publications`)).body,[]);
  assert.equal((await f.call(f.reviewer,'POST',`${path}/publish`,{expectedVersion:1})).status,200);
  const read = await f.call(f.viewer,'GET',path); assert.equal(read.body.content,'선별한 공개 내용');
  assert.deepEqual(Object.keys(read.body).sort(),['publicationId','version','subject','content','publishedAt'].sort());
  const other = await f.signup('viewer'); await f.admit(other); assert.equal((await f.call(other,'GET',path)).status,404);
  assert.equal((await f.call(f.reviewer,'PATCH',path,{expectedVersion:2,content:'정정된 내용'})).status,200);
  assert.equal((await f.call(f.viewer,'GET',path)).status,404);
  assert.equal((await f.call(f.reviewer,'POST',`${path}/publish`,{expectedVersion:3})).status,200);
  assert.equal((await f.call(f.viewer,'GET',path)).body.content,'정정된 내용');
  assert.equal((await f.call(f.reviewer,'POST',`${path}/revoke`,{expectedVersion:4})).status,200);
  assert.equal((await f.call(f.viewer,'GET',path)).status,404);
});

test('수신자 변경에서 추가자는 재공개 전 차단, 퇴출 후 서버 접근 차단·기록 보존', async () => {
  const f = await fixture(), pub = await f.publication(), path = `${f.p}/publications/${pub.publicationId}`;
  await f.call(f.reviewer,'POST',`${path}/publish`,{expectedVersion:1});
  const other = await f.signup('viewer'); await f.admit(other);
  assert.equal((await f.call(f.reviewer,'PATCH',path,{expectedVersion:2,recipientIds:[other.userId]})).status,200);
  assert.equal((await f.call(f.viewer,'GET',path)).status,404); assert.equal((await f.call(other,'GET',path)).status,404);
  await f.call(f.reviewer,'POST',`${path}/publish`,{expectedVersion:3});
  assert.equal((await f.call(other,'GET',path)).status,200);
  for (const u of [other,f.author]) {
    const access = await f.call(f.reviewer,'GET',`${f.p}/access`);
    assert.equal((await f.call(f.reviewer,'DELETE',`${f.p}/members/${u.userId}`,{expectedVersion:access.body.revision})).status,200);
    assert.equal((await f.call(u,'GET',`${f.p}/submissions`)).status,404);
  }
  assert.equal((await f.call(f.reviewer,'GET',`${f.p}/submissions`)).body.length,1);
  assert.equal((await f.call(other,'GET',path)).status,404);
});

test('담당자 지정·수락 원자적 이전, 이전 담당자 접근 종료·검토 이력 유지', async () => {
  const f = await fixture(), pub = await f.publication(), next = await f.signup('reviewer');
  const access = await f.call(f.reviewer,'GET',`${f.p}/access`);
  const t = await f.call(f.reviewer,'POST',`${f.p}/transfers`,{expectedVersion:access.body.revision,targetUserId:next.userId}); assert.equal(t.status,200,JSON.stringify(t));
  const path = `${f.p}/transfers/${t.body.transferId}/accept`;
  assert.equal((await f.call(f.author,'POST',path,{expectedVersion:1})).status,404);
  assert.equal((await f.call(next,'POST',path,{expectedVersion:1})).status,200);
  assert.equal((await f.call(f.reviewer,'GET',`${f.p}/submissions`)).status,404);
  assert.equal((await f.call(next,'GET',`${f.p}/publications/${pub.publicationId}`)).status,200);
  const detail = await f.call(next,'GET',`${f.p}/submissions/${pub.submissionId}`); assert.equal(detail.body.confirmedBy,f.reviewer.userId);
});

test('미결정 확정 정책 기본 차단, AI 실패 무저장·생성 중 퇴출 시 커밋 차단', async () => {
  const f = await fixture({confirmationEnabled:false}), {response:s} = await f.submit();
  const r = await f.call(f.reviewer,'POST',`${f.p}/submissions/${s.body.submissionId}/review`,{expectedVersion:1,decision:'confirm',confirmSource:true,confirmChecks:true}); assert.equal(r.body.code,'POLICY_REQUIRED');
  f.ai.draft = async () => { throw new Error('offline'); };
  assert.equal((await f.call(f.author,'POST',`${f.p}/drafts`,{memo,dataUse:'synthetic_deidentified'})).status,502);
  let entered, resume; const start = new Promise(resolve => {entered=resolve;}); const wait = new Promise(resolve=>{resume=resolve;});
  f.ai.draft = async input => {entered(); await wait; return draft(input.memo);};
  const pending = f.call(f.author,'POST',`${f.p}/drafts`,{memo,dataUse:'synthetic_deidentified'}); await start;
  const state = await f.call(f.reviewer,'GET',`${f.p}/access`);
  await f.call(f.reviewer,'DELETE',`${f.p}/members/${f.author.userId}`,{expectedVersion:state.body.revision}); resume();
  assert.equal((await pending).status,404);
});


test('최종본 QA 없이는 확정 불가, 편집 후 재검사·잘린 QA·보류 및 검사 중 수정 차단', async () => {
  const f = await fixture(), {response:s} = await f.submit(), path = `${f.p}/submissions/${s.body.submissionId}`;
  const confirm = expectedVersion => f.call(f.reviewer,'POST',`${path}/review`,{expectedVersion,decision:'confirm',confirmSource:true,confirmChecks:true});
  assert.equal((await confirm(1)).body.code,'FINAL_QA_REQUIRED');
  assert.equal((await f.call(f.reviewer,'POST',`${path}/check`,{expectedVersion:1})).status,200);
  assert.equal((await f.call(f.reviewer,'POST',`${path}/review`,{expectedVersion:1,decision:'edit',content:'식사를 조금 남기셨습니다.'})).status,200);
  assert.equal((await confirm(2)).body.code,'FINAL_QA_REQUIRED');
  const normalQa = f.ai.qa;
  f.ai.qa = async candidate => { const result = await normalQa(candidate); result.qa.checks.pop(); return result; };
  assert.equal((await f.call(f.reviewer,'POST',`${path}/check`,{expectedVersion:2})).status,502);
  f.ai.qa = async candidate => { const result = await normalQa(candidate); result.status = 'hold'; result.qa.checks[0].passed = false; return result; };
  assert.equal((await f.call(f.reviewer,'POST',`${path}/check`,{expectedVersion:2})).status,200);
  assert.equal((await f.call(f.reviewer,'GET',path)).body.finalQa.qa.checks[0].passed,false);
  let entered, resume; const start = new Promise(resolve=>{entered=resolve;}); const wait = new Promise(resolve=>{resume=resolve;});
  f.ai.qa = async candidate => { entered(); await wait; return normalQa(candidate); };
  const pending = f.call(f.reviewer,'POST',`${path}/check`,{expectedVersion:2}); await start;
  await f.call(f.reviewer,'POST',`${path}/review`,{expectedVersion:2,decision:'edit',content:'새로운 검토본'}); resume();
  assert.equal((await pending).status,409);
  await f.call(f.reviewer,'POST',`${path}/review`,{expectedVersion:3,decision:'edit',content:'첫째 줄\n둘째 줄'});
  assert.equal((await f.call(f.reviewer,'POST',`${path}/check`,{expectedVersion:4})).body.code,'EDITED_EVIDENCE_REQUIRED');
});

test('전사는 확인용 텍스트만 반환, 지원 언어·입력 형식·작성자 권한 검증', async () => {
  const f = await fixture(), body = {audioBase64:Buffer.from('synthetic audio').toString('base64'),dataUse:'synthetic_deidentified',sourceLanguage:'ko'};
  assert.equal((await f.call(f.author,'POST',`${f.p}/transcriptions`,body)).body.requiresTranscriptReview,true);
  assert.deepEqual((await f.call(f.reviewer,'GET',`${f.p}/submissions`)).body,[]);
  assert.equal((await f.call(f.viewer,'POST',`${f.p}/transcriptions`,body)).status,403);
  assert.equal((await f.call(f.author,'POST',`${f.p}/transcriptions`,{...body,sourceLanguage:'unsupported'})).status,400);
  assert.equal((await f.call(f.author,'POST',`${f.p}/transcriptions`,{...body,audioBase64:'bad!'})).status,400);
  f.ai.transcribe = async () => ({text:'미확인',requires_transcript_review:false});
  assert.equal((await f.call(f.author,'POST',`${f.p}/transcriptions`,body)).status,502);
});

test('BE-07 유효한 AI 경고는 제출·확정·별도 공개를 막지 않고 그대로 보존', async () => {
  const f = await fixture(), generate = f.ai.draft;
  f.ai.draft = async input => {
    const d = await generate(input); d.status='hold'; d.qa.checks[0].passed=false;
    d.qa.issues.push({code:'SOURCE_INTEGRITY',severity:'hold',message:'원문 확인 경고'}); return d;
  };
  const {response:s} = await f.submit(); assert.equal(s.status,200);
  const path = `${f.p}/submissions/${s.body.submissionId}`;
  assert.equal((await f.call(f.reviewer,'POST',`${path}/check`,{expectedVersion:1})).status,502);
  f.ai.qa = async candidate => ({status:'hold',model_checked:true,qa:candidate.qa});
  assert.equal((await f.call(f.reviewer,'POST',`${path}/check`,{expectedVersion:1})).status,200);
  const confirmed = await f.call(f.reviewer,'POST',`${path}/review`,{expectedVersion:1,decision:'confirm',confirmSource:true,confirmChecks:true});
  assert.equal(confirmed.status,200,JSON.stringify(confirmed)); assert.equal(confirmed.body.status,'confirmed');
  const detail = await f.call(f.author,'GET',path);
  assert.equal(detail.body.generatedDraft.status,'hold'); assert.equal(detail.body.finalQa.qa.checks[0].passed,false);
  assert.equal(detail.body.reviews[0].qaResult.qa.issues.at(-1).message,'원문 확인 경고');
  assert.deepEqual((await f.call(f.viewer,'GET',`${f.p}/publications`)).body,[]);
  const pub = await f.call(f.reviewer,'POST',`${f.p}/publications`,{submissionId:s.body.submissionId,expectedVersion:2,content:'선별한 내용',recipientIds:[f.viewer.userId]});
  assert.equal(pub.status,200);
  assert.equal((await f.call(f.reviewer,'POST',`${f.p}/publications/${pub.body.publicationId}/publish`,{expectedVersion:1})).status,200);
});

test('BE-01 승인 경합·기관 생성·이전 수락에서도 계정당 활성 기관 한 개', async () => {
  const f = await fixture(), secondOwner = await f.signup('reviewer');
  const second = (await f.call(secondOwner,'POST','/workspaces',{name:'두 번째 기관'})).body;
  assert.equal((await f.call(f.reviewer,'POST','/workspaces',{name:'중복 기관'})).body.code,'SINGLE_WORKSPACE_REQUIRED');
  const author = await f.signup('author');
  const r1 = await f.call(author,'POST','/workspaces/join-requests',{code:f.w.inviteCode});
  const r2 = await f.call(author,'POST','/workspaces/join-requests',{code:second.inviteCode});
  assert.equal(r1.status,201);assert.equal(r2.status,201);
  const outcomes = await Promise.all([
    f.call(f.reviewer,'POST',`${f.p}/join-requests/${r1.body.requestId}/approve`,{expectedVersion:1}),
    f.call(secondOwner,'POST',`/workspaces/${second.workspaceId}/join-requests/${r2.body.requestId}/approve`,{expectedVersion:1}),
  ]);
  assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,409]);
  const target = await f.signup('reviewer');
  const access = await f.call(f.reviewer,'GET',`${f.p}/access`);
  const transfer = await f.call(f.reviewer,'POST',`${f.p}/transfers`,{expectedVersion:access.body.revision,targetUserId:target.userId}); assert.equal(transfer.status,200);
  const created = await f.call(target,'POST','/workspaces',{name:'대상자의 다른 기관'});assert.equal(created.status,201);
  const accept = await f.call(target,'POST',`${f.p}/transfers/${transfer.body.transferId}/accept`,{expectedVersion:1});assert.equal(accept.body.code,'SINGLE_WORKSPACE_REQUIRED');
});

test('BE-03~05 발신 이전 요청 복구·관리 이력 페이지·퇴출된 작성자 표시', async () => {
  const f = await fixture(), {response:s} = await f.submit(), next = await f.signup('reviewer');
  let access = await f.call(f.reviewer,'GET',`${f.p}/access`);
  const t = await f.call(f.reviewer,'POST',`${f.p}/transfers`,{expectedVersion:access.body.revision,targetUserId:next.userId});
  const list = await f.call(f.reviewer,'GET',`${f.p}/transfers`); assert.equal(list.body[0].transferId,t.body.transferId);assert.equal(list.body[0].targetNameAtRequest,'reviewer');
  assert.equal((await f.call(f.reviewer,'GET',`${f.p}/transfers/${t.body.transferId}`)).body.version,1);
  access = await f.call(f.reviewer,'GET',`${f.p}/access`);
  await f.call(f.reviewer,'DELETE',`${f.p}/members/${f.author.userId}`,{expectedVersion:access.body.revision});
  await f.store.transaction(async tx=>{const u=await tx.get(`user#${f.author.userId}`);u.name='변경 이름';await tx.set(`user#${u.userId}`,u);});
  const submission = await f.call(f.reviewer,'GET',`${f.p}/submissions/${s.body.submissionId}`);
  assert.equal(submission.body.authorNameAtSubmission,'author');assert.equal(submission.body.authorCurrentName,'변경 이름');
  const seen = new Set(); let cursor = '';
  do {
    const page = await f.call(f.reviewer,'GET',`${f.p}/audit?limit=2${cursor?'&cursor='+cursor:''}`);assert.equal(page.status,200);
    for(const e of page.body.items){assert.equal(seen.has(e.eventId),false);seen.add(e.eventId);assert.ok(e.actorId);assert.ok(e.actorCurrentName);}
    cursor=page.body.nextCursor;
  } while(cursor);
  const stored = await f.store.transaction(tx=>tx.get(`workspace#${f.w.workspaceId}`));assert.equal(seen.size,stored.audit.length);
  assert.equal((await f.call(f.viewer,'GET',`${f.p}/audit`)).status,403);
  assert.equal((await f.call(f.author,'GET',`${f.p}/audit`)).status,404);
});

test('BE-01 Lambda 경로에서도 동일 정책을 적용하고 AI 경고 확정 가능', async () => {
  assert.deepEqual(workspacePolicy({CAREBRIDGE_MULTIPLE_WORKSPACES:'true',CAREBRIDGE_RECIPIENT_CHANGE:'retain'}),{multipleWorkspaces:false,confirmationEnabled:true,transferEnabled:true,recipientChange:'block_all'});
  const f = await fixture(workspacePolicy({})), {response:s} = await f.submit();
  f.ai.qa=async candidate=>{const qa=structuredClone(candidate.qa);qa.checks[0].passed=false;return {status:'hold',model_checked:true,qa};};
  await f.call(f.reviewer,'POST',`${f.p}/submissions/${s.body.submissionId}/check`,{expectedVersion:1});
  const result = await createLambdaHandler(f.app)({rawPath:`${f.p}/submissions/${s.body.submissionId}/review`,requestContext:{http:{method:'POST'}},headers:{authorization:`Bearer ${f.reviewer.token}`},body:JSON.stringify({expectedVersion:1,decision:'confirm',confirmSource:true,confirmChecks:true})});
  assert.equal(result.statusCode,200);assert.equal(JSON.parse(result.body).status,'confirmed');
});

test('Cognito 가입 역할은 검증된 sub에 연결하고 기존 계정에는 자동 매핑하지 않음', async () => {
  const store = new Store(), sub = randomUUID();
  const commands = Object.fromEntries(['AdminGetUserCommand','SignUpCommand','GetUserCommand'].map(operation => [operation,class {constructor(input){this.operation=operation;this.input=input;}}]));
  const client = {send:async command=>{
    if (command.operation === 'AdminGetUserCommand') { const error = new Error(); error.name='UserNotFoundException'; throw error; }
    if (command.operation === 'SignUpCommand') return {UserSub:sub,UserConfirmed:false,CodeDeliveryDetails:{DeliveryMedium:'EMAIL',Destination:'u***@example.com'}};
    if (command.operation === 'GetUserCommand') return {UserAttributes:[{Name:'sub',Value:command.input.AccessToken==='new'?sub:'existing-sub'},{Name:'email',Value:'user@example.com'},{Name:'email_verified',Value:'true'}]};
    throw new Error('Unexpected command');
  }};
  const auth = new CognitoAuthService({store,clock,client,commands,clientId:'local-mock',userPoolId:'local-mock',logger:()=>{}});
  await auth.register({email:'user@example.com',name:'합성',password,role:'viewer'});
  await auth.authenticate('new');
  assert.equal((await auth.profile(sub,'GET')).workspaceRole,'viewer');
  await auth.authenticate('existing');
  assert.equal((await auth.profile('existing-sub','GET')).workspaceRole,undefined);
  await assert.rejects(auth.register({email:'invalid@example.com',name:'합성',password,role:'admin'}),error=>error.status===400);
});

test('로컬 HTTP SSE는 철회 시 내용 없는 무효화 신호와 퇴출 종료 이벤트 전송', async t => {
  const f = await fixture(), server = createHttpServer(f.app);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const abort = new AbortController();
  t.after(async()=>{abort.abort();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const response = await fetch(`http://127.0.0.1:${server.address().port}${f.p}/events`,{headers:{Authorization:`Bearer ${f.viewer.token}`},signal:abort.signal});
  assert.equal(response.status,200); assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  assert.match(decoder.decode((await reader.read()).value),/event: revalidate/);
  const pub = await f.publication();
  const chunk = decoder.decode((await reader.read()).value); assert.match(chunk,/event: invalidate/); assert.equal(chunk.includes('선별한'),false);
  const state = await f.call(f.reviewer,'GET',`${f.p}/access`);
  await f.call(f.reviewer,'DELETE',`${f.p}/members/${f.viewer.userId}`,{expectedVersion:state.body.revision});
  let all = ''; while (!all.includes('event: access-revoked')) { const next = await reader.read(); if (next.done) break; all += decoder.decode(next.value); }
  assert.match(all,/event: access-revoked/); assert.equal((await f.call(f.viewer,'GET',`${f.p}/publications/${pub.publicationId}`)).status,404);
});
