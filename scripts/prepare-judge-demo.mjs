// Operator-only tool. Default execution prints the plan and performs no AWS writes.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as cognito from '@aws-sdk/client-cognito-identity-provider';
import { createDynamoStore } from '../src/adapters/dynamodb.js';
import { plan, prepareJudgeDemo } from './lib/judge-demo.js';
const args=process.argv.slice(2), mode=args[0] ?? '--plan';
const expected={AWS_REGION:'ap-northeast-2',COGNITO_USER_POOL_ID:'ap-northeast-2_ge6F8vYbo',DYNAMODB_TABLE:'fcc-backend-dev-Database-1O0VMLVB2JYCH'};
const repo=resolve(fileURLToPath(new URL('..',import.meta.url)));
function credentialPath(value) {
  if(!value || !isAbsolute(value))throw new Error('Specify an absolute private credential file path outside the repository');
  const path=resolve(value), rel=relative(repo,path);
  if(rel==='' || (!isAbsolute(rel) && rel!=='..' && !rel.startsWith('..'+sep)))throw new Error('Credential file must be outside the repository');
  return path;
}
try {
  if(mode==='--plan' && args.length<=1) {console.log(JSON.stringify({environment:expected,...plan},null,2));}
  else if(mode==='--new-credentials' && args.length===2) {
    const path=credentialPath(args[1]);
    const passwords=Object.fromEntries(plan.accounts.map(a=>[a.role,'J9!'+randomBytes(24).toString('base64url')]));
    writeFileSync(path,JSON.stringify(passwords,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log('Private credential file created; contents are not printed. Keep it outside Git.');
  } else if(mode==='--apply' && args.length===2) {
    for(const [name,value] of Object.entries(expected))if(process.env[name]!==value)throw new Error(`Explicit ${name} must match the approved environment`);
    const account=execFileSync('aws',['sts','get-caller-identity','--query','Account','--output','text'],{encoding:'utf8'}).trim();
    if(account!=='055047416353')throw new Error('AWS account mismatch');
    const path=credentialPath(args[1]);
    if(process.platform!=='win32' && (statSync(path).mode & 0o077))throw new Error('Credential file must have mode 600');
    const passwords=JSON.parse(readFileSync(path,'utf8'));
    const client=new cognito.CognitoIdentityProviderClient({region:expected.AWS_REGION});
    const send=(name,input)=>client.send(new cognito[name]({UserPoolId:expected.COGNITO_USER_POOL_ID,...input}));
    const shape=user=>({sub:user.UserAttributes.find(a=>a.Name==='sub')?.Value,verified:user.UserAttributes.some(a=>a.Name==='email_verified' && a.Value==='true'),status:user.UserStatus});
    const identity={
      find:async email=>{try{return shape(await send('AdminGetUserCommand',{Username:email}));}catch(e){if(e.name==='UserNotFoundException')return null;throw e;}},
      create:async a=>{await send('AdminCreateUserCommand',{Username:a.email,MessageAction:'SUPPRESS',UserAttributes:[{Name:'email',Value:a.email},{Name:'email_verified',Value:'true'},{Name:'name',Value:a.name}]});return identity.find(a.email);},
      activate:async(email,password)=>send('AdminSetUserPasswordCommand',{Username:email,Password:password,Permanent:true}),
    };
    console.log(JSON.stringify(await prepareJudgeDemo({store:await createDynamoStore(),identity,passwords}),null,2));
  } else throw new Error('Use --plan, --new-credentials <private-file>, or --apply <private-file>');
} catch {console.error('Preparation stopped. No credentials are printed. Inspect the manifest and resource state before retrying; existing permanent passwords are never reset automatically.');process.exitCode=1;}