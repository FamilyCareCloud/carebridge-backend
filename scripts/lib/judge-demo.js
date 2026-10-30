import { randomUUID } from 'node:crypto';
import { WorkspaceService } from '../../src/services/workspaces.js';
import { workspacePolicy } from '../../src/workspace-policy.js';
export const plan = Object.freeze({
  name: 'YU42 심사용 가상 기관',
  accounts: [
    { role:'reviewer', email:'judge-reviewer@carebridge.invalid', name:'심사 검토자' },
    { role:'author', email:'judge-author@carebridge.invalid', name:'심사 작성자' },
    { role:'viewer', email:'judge-reader@carebridge.invalid', name:'심사 열람자' },
  ],
  samples:[
    {key:'ko-pending',subject:0,language:'ko',memo:'점심을 절반 드셨고 무릎이 불편하다고 말씀하셨습니다. 복약 여부는 확인하지 못했습니다.',status:'review_pending'},
    {key:'vi-pending',subject:0,language:'vi',memo:'Đã ăn nửa bữa sáng.',status:'review_pending'},
    {key:'ko-held',subject:0,language:'ko',memo:'산책 시 이동을 도왔습니다. 중간에 쉬고 싶다고 말씀하셨습니다.',status:'held'},
    {key:'en-confirmed',subject:1,language:'en',memo:'Drank water this morning. Walked with help.',status:'confirmed'},
    {key:'ko-published',subject:1,language:'ko',memo:'오후에 책을 읽으셨습니다. 물 한 잔을 드렸습니다.',status:'published'},
  ],
});
export const manifestKey='judge-demo#v1';
const requireThat=(condition,message)=>{if(!condition)throw new Error(message);};
/** Admin-only bootstrap. No change to normal authentication, role or review rules. */
export async function prepareJudgeDemo({store,identity,passwords,clock=()=>new Date().toISOString()}) {
  let manifest=await store.transaction(tx=>tx.get(manifestKey));
  if(!manifest) {
    // Never adopt existing identities, even if the names match our plan.
    for(const account of plan.accounts)requireThat(!await identity.find(account.email),'Identity already exists without a preparation manifest');
    manifest={version:1,accounts:{},samples:{},ownerToken:randomUUID()};
    await store.transaction(async tx=>{requireThat(!await tx.get(manifestKey),'Concurrent preparation');await tx.set(manifestKey,manifest);});
  }
  const update=async fn=>{manifest=await store.transaction(async tx=>{const m=await tx.get(manifestKey);requireThat(m?.ownerToken===manifest.ownerToken,'Manifest changed');await fn(m);await tx.set(manifestKey,m);return m;});};
  for(const account of plan.accounts) {
    let saved=manifest.accounts[account.role];
    let remote=await identity.find(account.email);
    if(!saved) {
      requireThat(!remote,'Untracked existing identity; inspect before resuming');
      requireThat(typeof passwords[account.role]==='string' && passwords[account.role].length>=16,'Private password file required');
      remote=await identity.create(account);
      saved={sub:remote.sub,email:account.email,ready:false};
      await update(m=>{m.accounts[account.role]=saved;});
    }
    requireThat(remote?.sub===saved.sub && saved.email===account.email,'Cognito identity mismatch');
    const user=await store.transaction(tx=>tx.get(`user#${saved.sub}`));
    requireThat(!user || (user.workspaceRole===account.role && user.email===account.email && !user.isTestAdmin),'Existing user role mismatch');
    await store.transaction(async tx=>{
      const key=`workspace-signup#${saved.sub}`,signup=await tx.get(key);
      requireThat(!signup || signup.role===account.role,'Signup role mismatch');
      if(!signup)await tx.set(key,{role:account.role});
      if(!await tx.get(`user#${saved.sub}`))await tx.set(`user#${saved.sub}`,{userId:saved.sub,email:account.email,name:account.name,role:account.role,workspaceRole:account.role,groupIds:[],createdAt:clock()});
    });
    if(!saved.ready) {
      requireThat(remote.status==='FORCE_CHANGE_PASSWORD','Refusing to reset an existing permanent password');
      await identity.activate(account.email,passwords[account.role]);
      await update(m=>{m.accounts[account.role].ready=true;});
    }
    requireThat((await identity.find(account.email))?.verified===true,'Email verification missing');
  }
  const ids=Object.fromEntries(Object.entries(manifest.accounts).map(([role,a])=>[role,a.sub]));
  const service=new WorkspaceService(store,clock,{},workspacePolicy());
  let owned=await service.mine(ids.reviewer);
  requireThat(owned.length<=1,'Reviewer connected to unexpected workspaces');
  let w;
  if(owned.length) {
    w=(await service.handle(ids.reviewer,'GET',[owned[0].workspaceId],{},new URLSearchParams())).body;
    requireThat(w.name===plan.name && w.ownerReviewerId===ids.reviewer,'Unexpected reviewer workspace');
  } else {
    requireThat(!manifest.workspaceId,'Prepared workspace was removed; do not recreate automatically');
    w=await service.create(ids.reviewer,{name:plan.name});
  }
  requireThat(!manifest.workspaceId || manifest.workspaceId===w.workspaceId,'Workspace mismatch');
  await update(m=>{m.workspaceId=w.workspaceId;});
  for(const role of ['author','viewer']) {
    const existing=await service.mine(ids[role]);
    requireThat(existing.every(item=>item.workspaceId===w.workspaceId),'Account connected to another workspace');
    const member=await store.transaction(async tx=>(await tx.get(`workspace#${w.workspaceId}`)).members.find(m=>m.userId===ids[role]));
    if(member?.status==='active'){requireThat(member.role===role,'Membership role mismatch');continue;}
    requireThat(!member,'Prepared member was removed; do not re-admit automatically');
    const request=await service.join(ids[role],{code:w.inviteCode});
    await service.handle(ids.reviewer,'POST',[w.workspaceId,'join-requests',request.requestId,'approve'],{expectedVersion:request.version},new URLSearchParams());
  }
  return {workspaceId:w.workspaceId,accounts:plan.accounts.map(a=>({email:a.email,role:a.role})),samplesPlanned:plan.samples.length};
}