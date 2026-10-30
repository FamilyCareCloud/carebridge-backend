import test from 'node:test';
import assert from 'node:assert/strict';
import { seedJudgeSamples } from '../scripts/lib/judge-samples.js';

function fixture() {
  const subjects=[],submissions=[],publications=[],generations=new Map(),requests=new Map();
  let generated=0,failAfterSubmit=false,qaHold=false;
  const progress={viewerId:'judge-viewer'},saved=[];
  const call=async(role,method,path,body)=>{
    if(path==='subjects') {
      assert.equal(role,'reviewer');
      if(method==='GET')return structuredClone(subjects);
      const s={...body,subjectId:'subject-'+subjects.length};subjects.push(s);return s;
    }
    if(path==='drafts') {
      assert.equal(role,'author');generated++;
      const g={generationId:'generation-'+generated,draft:{translation:{text:'번역: '+body.memo}}};generations.set(g.generationId,g);return g;
    }
    if(path==='submissions') {
      assert.equal(role,'author');
      if(requests.has(body.requestId))return requests.get(body.requestId);
      const s={...body,submissionId:'submission-'+submissions.length,subject:{subjectId:body.subjectId},status:'review_pending',version:1};submissions.push(s);requests.set(body.requestId,s);
      if(failAfterSubmit){failAfterSubmit=false;throw new Error('network interruption after commit');}return s;
    }
    if(path.startsWith('submissions/')) {
      assert.equal(role,'reviewer');const [,id,action]=path.split('/'),s=submissions.find(s=>s.submissionId===id);
      if(method==='GET')return structuredClone(s);
      assert.equal(body.expectedVersion,s.version);
      if(action==='check')return {qa:{checks:[{passed:!qaHold}],issues:qaHold?[{severity:'hold'}]:[]}};
      s.status=body.decision==='hold'?'held':'confirmed';s.version++;return s;
    }
    if(path==='publications') {
      assert.equal(role,'reviewer');if(method==='GET')return structuredClone(publications);
      const p={...body,publicationId:'publication-0',version:1,status:'unpublished'};publications.push(p);return p;
    }
    if(path.endsWith('/publish')){assert.equal(role,'reviewer');publications[0].status='published';return publications[0];}
    throw new Error('Unexpected path '+path);
  };
  return {call,progress,save:async p=>saved.push(structuredClone(p)),subjects,submissions,publications,generated:()=>generated,interrupt:()=>{failAfterSubmit=true;},hold:()=>{qaHold=true;}};
}
test('sample workflow creates two subjects and five real-flow submissions; finalizes states and reruns without duplication',async()=>{
  const f=fixture();await seedJudgeSamples({...f,mode:'generate'});
  assert.equal(f.subjects.length,2);assert.equal(f.submissions.length,5);assert.equal(f.publications.length,0);
  assert.ok(f.submissions.every(s=>s.status==='review_pending'));
  await seedJudgeSamples({...f,mode:'finalize'});
  assert.deepEqual(f.submissions.map(s=>s.status),['review_pending','review_pending','held','confirmed','confirmed']);
  assert.equal(f.publications[0].status,'published');assert.deepEqual(f.publications[0].recipientIds,['judge-viewer']);
  await seedJudgeSamples({...f,mode:'generate'});await seedJudgeSamples({...f,mode:'finalize'});
  assert.equal(f.generated(),5);assert.equal(f.submissions.length,5);assert.equal(f.publications.length,1);
});
test('interrupted submission resumes via same request ID without duplicate AI generation or submission',async()=>{
  const f=fixture();f.interrupt();await assert.rejects(seedJudgeSamples({...f,mode:'generate'}),/interruption/);
  await seedJudgeSamples({...f,mode:'generate'});assert.equal(f.generated(),5);assert.equal(f.submissions.length,5);
});
test('hold QA prevents confirmation and publication',async()=>{
  const f=fixture();await seedJudgeSamples({...f,mode:'generate'});f.hold();
  await assert.rejects(seedJudgeSamples({...f,mode:'finalize'}),/QA requires hold/);
  assert.equal(f.submissions[3].status,'review_pending');assert.equal(f.publications.length,0);
});
test('changed sample is not overwritten',async()=>{
  const f=fixture();await seedJudgeSamples({...f,mode:'generate'});f.submissions[0].authorDraft='사용자가 수정함';
  await assert.rejects(seedJudgeSamples({...f,mode:'finalize'}),/content changed/);assert.equal(f.publications.length,0);
});
