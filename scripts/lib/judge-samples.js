import { plan } from './judge-demo.js';

export const demoSubjects = [
  {name:'가상 대상자 가온',memo:'심사용 합성 대상자입니다. 실제 인물·건강정보가 아닙니다. 식사·이동 관찰 예시.'},
  {name:'가상 대상자 나래',memo:'심사용 합성 대상자입니다. 실제 인물·건강정보가 아닙니다. 수분 섭취·일상 활동 관찰 예시.'},
];
const ensure=(value,message)=>{if(!value)throw new Error(message);};

// All domain changes go through ordinary authenticated APIs; checkpoint only tracks progress.
export async function seedJudgeSamples({call,progress,save,mode,onResult=()=>{}}) {
  ensure(['generate','finalize'].includes(mode),'Invalid sample mode');
  progress.subjects ??= [];
  progress.samples ??= {};
  const subjects=await call('reviewer','GET','subjects');
  for(let i=0;i<demoSubjects.length;i++) {
    const spec=demoSubjects[i],matches=subjects.filter(s=>s.name===spec.name);
    ensure(matches.length<=1,'Duplicate demo subject; inspect before resuming');
    let subject=matches[0];
    if(progress.subjects[i])ensure(subject?.subjectId===progress.subjects[i],'Tracked subject changed');
    if(!subject) {
      ensure(mode==='generate','Subjects must be generated first');
      subject=await call('reviewer','POST','subjects',spec);
    }
    ensure(subject.memo===spec.memo,'Unexpected existing subject');
    progress.subjects[i]=subject.subjectId;
    await save(progress);
  }
  for(const spec of plan.samples) {
    const saved=progress.samples[spec.key] ??= {};
    if(!saved.generationId) {
      ensure(mode==='generate','Generate all samples before finalizing');
      const generation=await call('author','POST','drafts',{memo:spec.memo,sourceLanguage:spec.language,dataUse:'synthetic_deidentified'});
      saved.generationId=generation.generationId;
      saved.authorDraft=generation.draft.translation.text;
      await save(progress);
    }
    if(!saved.submissionId) {
      ensure(mode==='generate','Missing submitted sample');
      const submission=await call('author','POST','submissions',{
        requestId:'judge-demo-v1-'+spec.key,subjectId:progress.subjects[spec.subject],
        generationId:saved.generationId,memo:spec.memo,authorDraft:saved.authorDraft,confirmSource:true,
      });
      saved.submissionId=submission.submissionId;
      await save(progress);
    }
    let detail=await call('reviewer','GET','submissions/'+saved.submissionId);
    ensure(detail.memo===spec.memo && detail.authorDraft===saved.authorDraft && detail.subject.subjectId===progress.subjects[spec.subject],'Sample content changed; inspect before resuming');
    if(mode==='finalize') {
      if(spec.status==='held' && detail.status==='review_pending') {
        detail=await call('reviewer','POST','submissions/'+saved.submissionId+'/review',{
          expectedVersion:detail.version,decision:'hold',reason:'휴식을 요청한 시점을 원문 작성자에게 확인해 주세요.',
        });
      }
      if(['confirmed','published'].includes(spec.status) && detail.status==='review_pending') {
        const qa=await call('reviewer','POST','submissions/'+saved.submissionId+'/check',{expectedVersion:detail.version});
        ensure(qa.qa.checks.every(c=>c.passed) && !qa.qa.issues.some(i=>i.severity==='hold'),'AI QA requires hold; do not confirm');
        detail=await call('reviewer','POST','submissions/'+saved.submissionId+'/review',{
          expectedVersion:detail.version,decision:'confirm',confirmSource:true,confirmChecks:true,
        });
      }
      ensure(detail.status===(spec.status==='published'?'confirmed':spec.status),'Unexpected sample status');
      if(spec.status==='published') {
        let publications=await call('reviewer','GET','publications');
        const found=publications.filter(p=>p.submissionId===saved.submissionId);
        ensure(found.length<=1,'Duplicate publication');
        let publication=found[0];
        if(!publication) publication=await call('reviewer','POST','publications',{
          submissionId:saved.submissionId,expectedVersion:detail.version,content:saved.authorDraft,recipientIds:[progress.viewerId],
        });
        ensure(publication.content===saved.authorDraft && publication.recipientIds.length===1 && publication.recipientIds[0]===progress.viewerId,'Publication changed');
        if(publication.status==='unpublished')publication=await call('reviewer','POST','publications/'+publication.publicationId+'/publish',{expectedVersion:publication.version});
        ensure(publication.status==='published','Publication blocked or revoked; do not republish automatically');
        saved.publicationId=publication.publicationId;
        await save(progress);
      }
    }
    onResult({key:spec.key,submissionId:saved.submissionId,status:detail.status,source:spec.memo,content:saved.authorDraft,publicationId:saved.publicationId??null});
  }
  return progress;
}
