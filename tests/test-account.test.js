import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';
import { prepareTestAccount as prepare, testAccount as account } from '../src/services/test-account.js';
import { WorkspaceService } from '../src/services/workspaces.js';
import { seedQa } from '../scripts/seed-qa.js';

const testAccount = {...account,password:'Synthetic!123'};
const prepareTestAccount = (store,clock,env={}) => prepare(store,clock,{CAREBRIDGE_TEST_ADMIN_ENABLED:'true',CAREBRIDGE_TEST_ADMIN_PASSWORD:testAccount.password,...env});
const clock = () => '2026-10-29T00:00:00.000Z';
async function fixture() {
  const store = new Store(), auth = await prepareTestAccount(store, clock, {}), app = createApp(store, {clock,auth});
  const login = await app({method:'POST',path:'/auth/login',body:{loginId:testAccount.loginId,password:testAccount.password}});
  assert.equal(login.status,200);
  const call = (method,path,body={}) => app({method,path,body,token:login.body.accessToken});
  const workspaceId = (await call('GET','/workspaces')).body[0].workspaceId;
  return {store,auth,app,call,workspaceId,userId:login.body.user.userId};
}

test('기존 admin 계정 비밀번호 로그인·세 역할 접근·정식 담당자 보존', async () => {
  const f = await fixture(), prefix = `/workspaces/${f.workspaceId}`;
  const workspace = await f.store.transaction(tx=>tx.get(`workspace#${f.workspaceId}`));
  assert.notEqual(workspace.ownerReviewerId,f.userId);
  for (const role of ['author','reviewer','viewer']) {
    assert.equal((await f.call('POST','/auth/test-role',{role})).status,200);
    assert.equal((await f.call('GET',`${prefix}/access`)).body.role,role);
  }
  await f.call('POST','/auth/test-role',{role:'reviewer'});
  const subject = await f.call('POST',`${prefix}/subjects`,{name:'합성 대상자'}); assert.equal(subject.status,200);
  const saved = await f.store.transaction(tx=>tx.get(`workspace#${f.workspaceId}`));
  assert.equal(saved.ownerReviewerId,workspace.ownerReviewerId);
  assert.equal(saved.audit.at(-1).actorId,f.userId); assert.equal(saved.audit.at(-1).role,'reviewer');
});

test('admin은 지정 기관만 접근하고 일반 가입·이름 변경으로 권한을 얻지 못함', async () => {
  const f = await fixture();
  const other = await f.auth.register({email:'reviewer@example.com',name:'admin',role:'reviewer',password:'Synthetic!123'});
  const workspace = await new WorkspaceService(f.store,clock,{}).create(other.userId,{name:'범위 밖'});
  assert.equal((await f.call('GET',`/workspaces/${workspace.workspaceId}/access`)).status,404);
  const login = await f.app({method:'POST',path:'/auth/login',body:{email:'reviewer@example.com',password:'Synthetic!123'}});
  assert.equal((await f.app({method:'POST',path:'/auth/test-role',token:login.body.accessToken,body:{role:'viewer'}})).status,403);
  await assert.rejects(f.auth.register({email:'qa-admin@local.invalid',name:'위조',password:'Synthetic!123'}),e=>e.status===400);
});

test('재시작은 같은 계정과 QA 기관 재사용, 비활성 설정은 로그인·기존 토큰 모두 차단', async () => {
  const f = await fixture(), auth = await prepareTestAccount(f.store,clock,{});
  const login = await auth.login({loginId:'admin',password:testAccount.password});
  assert.equal(login.user.userId,f.userId);
  assert.deepEqual(login.user.qaWorkspaceIds,[f.workspaceId]);
  const disabled = await prepareTestAccount(f.store,clock,{CAREBRIDGE_TEST_ADMIN_ENABLED:'false'});
  for (const body of [{loginId:'admin',password:testAccount.password},{email:'QA-ADMIN@LOCAL.INVALID',password:testAccount.password}]) await assert.rejects(disabled.login(body),e=>e.status===401);
  await assert.rejects(disabled.authenticate(login.accessToken),e=>e.status===401);
  await assert.rejects(prepareTestAccount(new Store(),clock,{NODE_ENV:'production'}));
});

test('기존 QA 기관 지정 시 범위를 유지하고 잘못된 기관은 계정을 생성하지 않음', async () => {
  const f = await fixture();
  const auth = await prepareTestAccount(f.store,clock,{CAREBRIDGE_QA_WORKSPACE_IDS:f.workspaceId});
  assert.deepEqual((await auth.login({loginId:'admin',password:testAccount.password})).user.qaWorkspaceIds,[f.workspaceId]);
  const store = new Store();
  await assert.rejects(prepareTestAccount(store,clock,{CAREBRIDGE_QA_WORKSPACE_IDS:'missing'}),e=>e.status===400);
  assert.equal(await store.transaction(tx=>tx.get('test-admin#account')),null);
});

test('BE-06 admin 자기 제출 검토·확정 후 지정 QA 공개문 열람, 재실행 시 중복 seed 없음', async()=>{
  const store=new Store(), env={CAREBRIDGE_TEST_ADMIN_ENABLED:'true',CAREBRIDGE_TEST_ADMIN_PASSWORD:testAccount.password};
  const seeded=await seedQa(store,clock,env);assert.equal(seeded.fixture,true);
  assert.deepEqual(await seedQa(store,clock,env),seeded);
  const auth=await prepareTestAccount(store,clock,env), login=await auth.login({loginId:'admin',password:testAccount.password});
  await auth.selectTestRole(login.user.userId,{role:'viewer'});
  const app=createApp(store,{clock,auth});
  const call=path=>app({method:'GET',path,token:login.accessToken});
  const mine=await call('/workspaces');assert.equal(mine.body[0].status,'active');assert.equal(mine.body[0].testAccess,true);assert.equal(mine.body[0].role,'viewer');
  const access=await call(`/workspaces/${seeded.workspaceId}/access`);assert.equal(access.body.role,'viewer');assert.equal(access.body.testAccess,true);
  const published=await call(`/workspaces/${seeded.workspaceId}/publications/${seeded.publicationId}`);assert.equal(published.status,200);assert.match(published.body.content,/합성 QA/);assert.equal(published.body.qa,undefined);
  await assert.rejects(seedQa(new Store(),clock,{CAREBRIDGE_TEST_ADMIN_ENABLED:'false'}));
});
