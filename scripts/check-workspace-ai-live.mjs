// Real frontend adapter -> loopback HTTP backend -> real loopback GPU service.
// Synthetic in-memory accounts only; never connects to Cognito or deployment DBs.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { createHttpServer } from '../src/handlers/http.js';
import { CarebridgeClient } from '../src/adapters/carebridge.js';
import { workspacePolicy } from '../src/workspace-policy.js';

const target = new URL(process.env.CAREBRIDGE_SERVICE_URL || 'http://127.0.0.1:8014');
if (target.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(target.hostname)) throw new Error('Offline loopback GPU service required');
if (!process.env.CAREBRIDGE_SERVICE_API_KEY) throw new Error('Service key must be provided through the environment');
const bundle = resolve(process.env.CAREBRIDGE_FRONTEND_BUNDLE || '../carebridge-frontend/.local/live-gateway/gateway.js');
const output = resolve(process.env.CAREBRIDGE_LIVE_REPORT || 'data/workspace-ai-v14.json');
if (existsSync(output)) throw new Error('Refusing to overwrite live evidence');
const { HttpGateway } = await import(pathToFileURL(bundle).href);
const report = { startedAt:new Date().toISOString(), scope:'Synthetic local HTTP/SSE and real GPU; actual compiled frontend adapter; not AWS/Cognito or visual browser acceptance',
  backendRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  frontendBundleSha256:createHash('sha256').update(readFileSync(bundle)).digest('hex'),
  scriptSha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),checks:[],gpuResponses:[] };
class RecordingClient extends CarebridgeClient {
  async request(...args) { const value=await super.request(...args); report.gpuResponses.push({path:args[0],response:value}); return value; }
}
const carebridge = new RecordingClient({baseUrl:target.href.replace(/\/$/,''),apiKey:process.env.CAREBRIDGE_SERVICE_API_KEY});
const server = createHttpServer(createApp(new Store(),{carebridge,workspacePolicy:workspacePolicy({})}));
const stops=[];
const check=name=>{report.checks.push(name);console.log('PASS '+name);};
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const reviewerApi=new HttpGateway(base),authorApi=new HttpGateway(base),viewerApi=new HttpGateway(base);
  const password='Synthetic!Workspace26';
  const reviewer=await reviewerApi.register('합성 검토자','reviewer@example.test',password,'reviewer');
  const author=await authorApi.register('합성 작성자','author@example.test',password,'author');
  const viewer=await viewerApi.register('합성 수신자','viewer@example.test',password,'reader');
  await reviewerApi.execute(reviewer,'reviewer',{type:'createWorkspace',name:'AI 연결 합성 기관'});
  const workspace=(await reviewerApi.request('/workspaces',undefined,reviewer))[0];
  const root='/workspaces/'+encodeURIComponent(workspace.workspaceId);
  const details=await reviewerApi.request(root,undefined,reviewer);
  for(const [api,session] of [[authorApi,author],[viewerApi,viewer]]) {
    const request=await api.request('/workspaces/join-requests',{code:details.inviteCode},session);
    await reviewerApi.request(root+'/join-requests/'+request.requestId+'/approve',{expectedVersion:request.version},reviewer);
  }
  async function connect(api,session,role) {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('SSE proof timeout')),5000);
      const stop=api.subscribe(session,()=>{},message=>{clearTimeout(timer);reject(new Error(message));},()=>{clearTimeout(timer);resolve();});
      stops.push(stop);
    });
    return api.snapshot(session,role);
  }
  await connect(reviewerApi,reviewer,'reviewer');
  await reviewerApi.execute(reviewer,'reviewer',{type:'subject',name:'합성 대상자',memo:''});
  const authorData=await connect(authorApi,author,'author');
  await connect(viewerApi,viewer,'reader');
  check('actual frontend login, membership, subject and SSE access proof');
  const source='Nói rằng: "Tôi có thể đã uống nước ép."';
  const generation=await authorApi.generate(author,'author',source,'vi');
  assert.match(generation.text,/주스/);assert.doesNotMatch(generation.text,/수프|스프/);
  assert.match(generation.text,/수도|가능|아마/);assert.equal(generation.source,source);assert.ok(generation.generationId);
  report.translation={source,text:generation.text};
  check('real GPU juice correction retains uncertainty, attribution and source-bound generation ID');
  await authorApi.execute(author,'author',{type:'submit',subjectId:authorData.subjects[0].id,source,generated:generation.text,final:generation.text,language:'vi',requestId:randomUUID(),generationId:generation.generationId});
  let note=(await reviewerApi.snapshot(reviewer,'reviewer')).submissions[0];
  assert.equal(note.generationId,generation.generationId);
  const wrong=await reviewerApi.checkReview(reviewer,'reviewer',note.id,note.version,generation.text.replace('주스','수프'),'대상 오역 대조');
  assert.equal(wrong.status,'hold');assert.ok(wrong.warnings.length);
  const wrongQa=report.gpuResponses.at(-1).response;
  assert.equal(wrongQa.model_checked,false);assert.equal(wrongQa.status,'hold');
  check('actual semantic preflight holds an edited wrong object through backend and frontend');
  const fixed=await reviewerApi.checkReview(reviewer,'reviewer',note.id,wrong.version,generation.text,'원문 대상 복구');
  assert.equal(fixed.status,'review_required');
  await reviewerApi.execute(reviewer,'reviewer',{type:'review',id:note.id,version:fixed.version,content:generation.text,reason:'원문과 경고 확인',status:'confirmed'});
  assert.equal((await viewerApi.snapshot(viewer,'reader')).publications.length,0);
  check('real GPU final QA uses saved version and confirmation does not publish');
  note=(await reviewerApi.snapshot(reviewer,'reviewer')).submissions[0];
  await reviewerApi.execute(reviewer,'reviewer',{type:'publish',submissionId:note.id,version:note.version,content:'합성 검증용 공개문',recipients:[viewer.user.id]});
  const published=(await viewerApi.snapshot(viewer,'reader')).publications;
  assert.equal(published.length,1);assert.equal(published[0].content,'합성 검증용 공개문');assert.equal(published[0].source,undefined);
  const pub=(await reviewerApi.snapshot(reviewer,'reviewer')).publications[0];
  await reviewerApi.execute(reviewer,'reviewer',{type:'revoke',id:pub.id,version:pub.version});
  assert.equal((await viewerApi.snapshot(viewer,'reader')).publications.length,0);
  check('separate recipient publication and revocation through actual frontend adapter');
  const audio=readFileSync('../carebridge-ai/evaluation/spec-synthetic-english.wav').toString('base64');
  const transcript=await authorApi.transcribe(author,'author',audio,'en');
  assert.equal(transcript.requiresTranscriptReview,true);assert.ok(transcript.text.trim());
  report.transcript=transcript;
  check('real Whisper GPU transcription returns editable review-required text');
  report.allPassed=true;
} catch(error) {
  report.allPassed=false;report.error={name:error.name,message:error.message};process.exitCode=1;console.error(error.message);
} finally {
  for(const stop of stops)stop();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  report.finishedAt=new Date().toISOString();
  writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log('Evidence: '+output);
}
