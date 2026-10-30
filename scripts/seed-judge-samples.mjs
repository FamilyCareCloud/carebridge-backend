import { readFileSync, statSync } from 'node:fs';
import { resolve,isAbsolute,relative,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createDynamoStore } from '../src/adapters/dynamodb.js';
import { plan,manifestKey } from './lib/judge-demo.js';
import { seedJudgeSamples } from './lib/judge-samples.js';

const base='https://uwv0zhujxf.execute-api.ap-northeast-2.amazonaws.com';
const workspaceId='cd27e64a-6765-4985-adb4-042af8e3d288';
const modes={'--generate':'generate','--finalize':'finalize'};
try {
  const [flag,file,...extra]=process.argv.slice(2),mode=modes[flag];
  if(!mode||!file||extra.length||!isAbsolute(file))throw new Error('Use --generate or --finalize with an absolute private credential path');
  const repo=resolve(fileURLToPath(new URL('..',import.meta.url))),rel=relative(repo,resolve(file));
  if(rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep)))throw new Error('Credentials must be outside Git');
  if(process.platform!=='win32'&&(statSync(file).mode&0o077))throw new Error('Credential file must be mode 600');
  for(const [key,value] of Object.entries({AWS_REGION:'ap-northeast-2',DYNAMODB_TABLE:'fcc-backend-dev-Database-1O0VMLVB2JYCH'}))if(process.env[key]!==value)throw new Error('Environment mismatch');
  if(execFileSync('aws',['sts','get-caller-identity','--query','Account','--output','text'],{encoding:'utf8'}).trim()!=='055047416353')throw new Error('AWS account mismatch');
  const store=await createDynamoStore();
  const manifest=await store.transaction(tx=>tx.get(manifestKey));
  if(manifest?.workspaceId!==workspaceId)throw new Error('Prepared workspace mismatch');
  const passwords=JSON.parse(readFileSync(file,'utf8')),tokens={};
  async function request(method,path,body,token) {
    const r=await fetch(base+path,{method,signal:AbortSignal.timeout(90000),headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const result=await r.json();
    if(!r.ok)throw new Error('API '+r.status+' '+(result.code??result.error?.code??'request failed'));
    return result;
  }
  for(const a of plan.accounts) {
    const session=await request('POST','/auth/login',{email:a.email,password:passwords[a.role]});
    if(!session.accessToken||session.user?.workspaceRole!==a.role||session.user?.isTestAdmin||session.user?.userId!==manifest.accounts[a.role].sub)throw new Error('Identity mismatch');
    tokens[a.role]=session.accessToken;
    const mine=await request('GET','/workspaces',null,tokens[a.role]);
    if(mine.length!==1||mine[0].workspaceId!==workspaceId||mine[0].status!=='active')throw new Error('Membership mismatch');
  }
  const call=(role,method,path,body)=>request(method,'/workspaces/'+workspaceId+'/'+path,body,tokens[role]);
  const workspace=await call('reviewer','GET','');
  if(workspace.name!==plan.name||workspace.ownerReviewerId!==manifest.accounts.reviewer.sub)throw new Error('Institution mismatch');
  const progress=structuredClone(manifest.seed??{subjects:[],samples:{},viewerId:manifest.accounts.viewer.sub});
  if(progress.viewerId!==manifest.accounts.viewer.sub)throw new Error('Recipient mismatch');
  const save=async value=>store.transaction(async tx=>{
    const current=await tx.get(manifestKey);
    if(current.ownerToken!==manifest.ownerToken||current.workspaceId!==workspaceId)throw new Error('Manifest changed');
    current.seed=structuredClone(value);await tx.set(manifestKey,current);
  });
  await seedJudgeSamples({call,progress,save,mode,onResult:r=>console.log(JSON.stringify(r))});
  const submissions=await call('reviewer','GET','submissions');
  const visible=await call('viewer','GET','publications');
  console.log(JSON.stringify({mode,subjects:progress.subjects.length,submissions:submissions.length,viewerPublications:visible.length,visible:visible.map(p=>({subject:p.subject.name,content:p.content,recordedAt:p.recordedAt,publishedAt:p.publishedAt}))}));
}catch(error){console.error('Sample preparation stopped: '+error.message);process.exitCode=1;}
