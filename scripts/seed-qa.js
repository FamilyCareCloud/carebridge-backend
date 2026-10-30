import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { prepareTestAccount } from '../src/services/test-account.js';
import { createApp } from '../src/app.js';
import { workspacePolicy } from '../src/workspace-policy.js';
import { fixtureAi } from '../src/testing/fixture-ai.js';

export async function seedQa(store, clock, env) {
  if (env.NODE_ENV === 'production' || env.CAREBRIDGE_TEST_ADMIN_ENABLED !== 'true') throw new Error('Explicit local QA mode is required');
  const auth = await prepareTestAccount(store,clock,env);
  const app = createApp(store,{clock,auth,workspacePolicy:workspacePolicy(env),carebridge:fixtureAi});
  const login = await auth.login({loginId:'admin',password:env.CAREBRIDGE_TEST_ADMIN_PASSWORD});
  const userId = login.user.userId, workspaceId = login.user.qaWorkspaceIds[0];
  const call = async(method,path,body={}) => {
    const result = await app({method,path,body,token:login.accessToken});
    if(result.status>=400) throw new Error(`QA step failed: ${result.status} ${result.body.code}`);
    return result.body;
  };
  try {
    const existing = await store.transaction(tx=>tx.get(`qa-seed#${workspaceId}`));
    if(existing) { await auth.selectTestRole(userId,{role:'viewer'}); return existing; }
    const p=`/workspaces/${workspaceId}`;
    await call('POST','/auth/test-role',{role:'reviewer'});
    const subject=await call('POST',`${p}/subjects`,{name:'합성 대상자',memo:'로컬 QA fixture'});
    await call('POST','/auth/test-role',{role:'author'});
    const memo='합성 QA 기록: 아침 식사를 절반 드셨습니다.';
    const generation=await call('POST',`${p}/drafts`,{memo,sourceLanguage:'ko',dataUse:'synthetic_deidentified'});
    const submission=await call('POST',`${p}/submissions`,{requestId:randomUUID(),subjectId:subject.subjectId,generationId:generation.generationId,memo,authorDraft:memo,confirmSource:true});
    await call('POST','/auth/test-role',{role:'reviewer'});
    await call('POST',`${p}/submissions/${submission.submissionId}/check`,{expectedVersion:1});
    const confirmed=await call('POST',`${p}/submissions/${submission.submissionId}/review`,{expectedVersion:1,decision:'confirm',confirmSource:true,confirmChecks:true});
    const publication=await call('POST',`${p}/publications`,{submissionId:submission.submissionId,expectedVersion:confirmed.version,content:'합성 QA 공개문: 아침 식사를 절반 드셨습니다. 실제 돌봄 기록이 아닙니다.',recipientIds:[userId]});
    await call('POST',`${p}/publications/${publication.publicationId}/publish`,{expectedVersion:publication.version});
    await call('POST','/auth/test-role',{role:'viewer'});
    const result={workspaceId,submissionId:submission.submissionId,publicationId:publication.publicationId,fixture:true};
    await store.transaction(tx=>tx.set(`qa-seed#${workspaceId}`,result)); return result;
  } finally { await auth.logout(login.accessToken); }
}

if (process.argv[1]?.replaceAll('\\','/').endsWith('/scripts/seed-qa.js')) {
  console.log(JSON.stringify(await seedQa(new Store(process.env.DATA_FILE ?? './data/fcc-v2.json'),()=>new Date().toISOString(),process.env)));
}
