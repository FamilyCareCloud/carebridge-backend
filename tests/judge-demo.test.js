import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { prepareJudgeDemo, plan, manifestKey } from '../scripts/lib/judge-demo.js';
function fixture() {
  const store=new Store(),users=new Map(); let creates=0,activations=0;
  const identity={find:async email=>users.get(email)??null,create:async a=>{const user={sub:`judge-${a.role}`,verified:true,status:'FORCE_CHANGE_PASSWORD'};users.set(a.email,user);creates++;return user;},activate:async email=>{users.get(email).status='CONFIRMED';activations++;}};
  return {store,users,identity,passwords:{author:'Synthetic!Password123',reviewer:'Synthetic!Password123',viewer:'Synthetic!Password123'},counts:()=>({creates,activations})};
}
test('judge preparation creates ordinary fixed-role accounts and one connected institution; rerun preserves user records',async()=>{
 const f=fixture(),first=await prepareJudgeDemo(f);
 assert.equal(first.accounts.length,3);
 const w=f.store.records[`workspace#${first.workspaceId}`];
 assert.equal(w.name,plan.name);assert.equal(w.members.filter(m=>m.status==='active').length,2);
 assert.deepEqual(f.counts(),{creates:3,activations:3});
 for(const a of plan.accounts){const u=f.store.records[`user#judge-${a.role}`];assert.equal(u.workspaceRole,a.role);assert.equal(u.isTestAdmin,undefined);}
 await f.store.transaction(async tx=>{const current=await tx.get(`workspace#${first.workspaceId}`);current.subjects.push({name:'심사자가 추가한 기록'});await tx.set(`workspace#${first.workspaceId}`,current);});
 const snapshot=structuredClone(f.store.records);
 assert.equal((await prepareJudgeDemo(f)).workspaceId,first.workspaceId);
 assert.deepEqual(f.store.records,snapshot);assert.deepEqual(f.counts(),{creates:3,activations:3});
});
test('judge preparation refuses existing unmanaged Cognito identity',async()=>{
 const f=fixture();f.users.set(plan.accounts[0].email,{sub:'someone-else'});
 await assert.rejects(prepareJudgeDemo(f),/already exists/);assert.equal(f.store.records[manifestKey],undefined);assert.equal(f.counts().creates,0);
});
test('judge preparation refuses role drift without overwriting it',async()=>{
 const f=fixture();await prepareJudgeDemo(f);f.store.records['user#judge-author'].workspaceRole='viewer';
 await assert.rejects(prepareJudgeDemo(f),/role mismatch/);assert.equal(f.store.records['user#judge-author'].workspaceRole,'viewer');
});
test('judge preparation refuses removed membership and does not re-admit',async()=>{
 const f=fixture(),r=await prepareJudgeDemo(f);const w=f.store.records[`workspace#${r.workspaceId}`];w.members[0].status='removed';
 await assert.rejects(prepareJudgeDemo(f),/removed/);assert.equal(w.members[0].status,'removed');
});
test('judge preparation refuses identity replacement',async()=>{
 const f=fixture();await prepareJudgeDemo(f);f.users.get(plan.accounts[0].email).sub='replaced';
 await assert.rejects(prepareJudgeDemo(f),/identity mismatch/);
});
test('judge preparation refuses unexpected existing permanent password after an interrupted activation',async()=>{
 const f=fixture();await prepareJudgeDemo(f);f.store.records[manifestKey].accounts.reviewer.ready=false;
 await assert.rejects(prepareJudgeDemo(f),/permanent password/);assert.equal(f.counts().activations,3);
});