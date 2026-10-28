import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { RealtimeService } from '../src/services/realtime.js';
import { createWebsocketHandler } from '../src/handlers/websocket.js';
import { createApp } from '../src/app.js';
import { createLambdaHandler } from '../src/handlers/lambda.js';
import { hash } from '../src/carebridge-contract.js';

async function fixture() {
  const store=new Store(), sent=[], closed=[]; let time=Date.parse('2026-10-29T00:00:00Z');
  const clock=()=>new Date(time).toISOString(), workspaceId='synthetic-workspace';
  await store.transaction(async tx=>{
    for(const [id,role] of [['owner','reviewer'],['viewer','viewer'],['pending','viewer']]){
      await tx.set(`user#${id}`,{userId:id,name:id,workspaceRole:role});
      await tx.set(`session#${hash(id)}`,{userId:id,expiresAtEpoch:Math.floor(time/1000)+3600});
    }
    await tx.set(`workspace#${workspaceId}`,{workspaceId,ownerReviewerId:'owner',name:'합성 QA',revision:1,members:[{userId:'viewer',role:'viewer',status:'active'}],publications:[],submissions:[],requests:[],subjects:[],audit:[]});
  });
  const options={websocketUrl:'wss://example.invalid/live',send:async(id,payload)=>{sent.push({id,...payload});},close:async id=>{closed.push(id);}};
  const httpService=new RealtimeService(store,clock,options), connectionService=new RealtimeService(store,clock,options), publisher=new RealtimeService(store,clock,options);
  const app=createApp(store,{clock,realtime:httpService,auth:{authenticate:async token=>{
    if(!['owner','viewer','pending'].includes(token)){const e=new Error();e.status=401;throw e;} return token;
  },logout:async()=>({loggedOut:true})}});
  const lambda=createLambdaHandler(app), handler=createWebsocketHandler(connectionService,{origins:['https://frontend.example']});
  const ticket=async(user='viewer')=>lambda({rawPath:`/workspaces/${workspaceId}/event-tickets`,headers:{authorization:`Bearer ${user}`},requestContext:{http:{method:'POST'}},body:'{}'});
  async function connect(id,user='viewer') {
    const t=await ticket(user);assert.equal(t.statusCode,200);
    const proof=JSON.parse(t.body);
    const result=await handler({requestContext:{connectionId:id,routeKey:'$connect'},headers:{origin:'https://frontend.example'},queryStringParameters:{ticket:proof.ticket}});
    assert.equal(result.statusCode,200);return proof;
  }
  const stream=()=>createWebsocketHandler(publisher)({Records:[{dynamodb:{Keys:{pk:{S:`workspace#${workspaceId}`}},SequenceNumber:'1'}}]});
  return {store,clock,advance:ms=>{time+=ms;},sent,closed,workspaceId,httpService,connectionService,publisher,lambda,handler,ticket,connect,stream};
}

test('BE-02 HTTP 인증 티켓은 1회성·단기·기관 제한, 허용 Origin만 연결',async()=>{
  const f=await fixture();assert.equal((await f.ticket('pending')).statusCode,404);
  const response=JSON.parse((await f.ticket()).body);
  const event={requestContext:{connectionId:'a',routeKey:'$connect'},headers:{origin:'https://evil.example'},queryStringParameters:{ticket:response.ticket}};
  assert.equal((await f.handler(event)).statusCode,403);
  event.headers.origin='https://frontend.example';assert.equal((await f.handler(event)).statusCode,200);
  event.requestContext.connectionId='replay';assert.equal((await f.handler(event)).statusCode,401);
  const expired=JSON.parse((await f.ticket()).body);f.advance(61000);
  assert.equal((await f.handler({...event,queryStringParameters:{ticket:expired.ticket}})).statusCode,401);
});

test('BE-02 공유 저장소의 다른 인스턴스가 두 세션에 커밋 변경을 전달·퇴출 차단',async()=>{
  const f=await fixture();await f.connect('tab-1');await f.connect('tab-2');
  await f.store.transaction(async tx=>{const w=await tx.get(`workspace#${f.workspaceId}`);w.revision++;await tx.set(`workspace#${f.workspaceId}`,w);});
  assert.deepEqual((await f.stream()).batchItemFailures,[]);
  assert.equal(f.sent.length,2);assert.ok(f.sent.every(e=>e.type==='invalidate'&&e.revision===2));
  assert.equal(JSON.stringify(f.sent).includes('합성 QA'),false);
  await f.store.transaction(async tx=>{const w=await tx.get(`workspace#${f.workspaceId}`);w.members[0].status='removed';await tx.set(`workspace#${f.workspaceId}`,w);});
  await f.stream();assert.deepEqual(f.closed.sort(),['tab-1','tab-2']);assert.ok(f.sent.slice(-2).every(e=>e.type==='access-revoked'));
  assert.equal((await f.ticket()).statusCode,404);
});

test('BE-02 재접속은 최신 revision·권한 확인, 인증 만료·로그아웃도 연결 종료',async()=>{
  const f=await fixture();await f.connect('tab');
  const ticket=JSON.parse((await f.ticket()).body);
  await f.handler({requestContext:{connectionId:'tab',routeKey:'$default'},body:JSON.stringify({action:'revalidate',ticket:ticket.ticket})});
  assert.equal(f.sent.at(-1).type,'revalidate');assert.equal(f.sent.at(-1).revision,1);
  f.advance(61000);await f.publisher.sweep();assert.deepEqual(f.closed,['tab']);
  await f.connect('new-tab');
  await f.lambda({rawPath:'/auth/logout',headers:{authorization:'Bearer viewer'},requestContext:{http:{method:'POST'}},body:'{}'});
  const result=await createWebsocketHandler(f.publisher)({Records:[{dynamodb:{Keys:{pk:{S:'realtime-revoke#viewer'}},SequenceNumber:'2'}}]});
  assert.deepEqual(result.batchItemFailures,[]);assert.equal(f.closed.at(-1),'new-tab');
});

test('BE-02 스트림 전송 실패는 재시도, Gone 연결 정리, 다른 사용자 티켓 거절',async()=>{
  const f=await fixture();await f.connect('tab');
  const other=JSON.parse((await f.ticket('owner')).body);
  assert.equal((await f.handler({requestContext:{connectionId:'tab',routeKey:'$default'},body:JSON.stringify({action:'revalidate',ticket:other.ticket})})).statusCode,403);
  await f.connect('retry-tab');
  f.publisher.send=async()=>{throw new Error('transient delivery');};
  assert.deepEqual((await f.stream()).batchItemFailures,[{itemIdentifier:'1'}]);
  f.publisher.send=async()=>{const e=new Error();e.name='GoneException';throw e;};
  assert.deepEqual((await f.stream()).batchItemFailures,[]);
  assert.equal(await f.store.transaction(tx=>tx.get('realtime-connection#retry-tab')),null);
});

test('BE-02 TTL로 연결 레코드가 먼저 지워져도 locator로 모든 인덱스 정리',async()=>{
  const f=await fixture();await f.connect('ttl-tab');
  await f.store.transaction(tx=>tx.delete('realtime-connection#ttl-tab'));
  await f.publisher.sweep();
  for(const key of ['realtime-all',`realtime-workspace#${f.workspaceId}`,'realtime-user#viewer']) assert.deepEqual((await f.store.transaction(tx=>tx.get(key))).ids,[]);
  assert.equal(await f.store.transaction(tx=>tx.get('realtime-locator#ttl-tab')),null);
});
