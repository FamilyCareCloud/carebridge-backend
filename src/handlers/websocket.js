import { createDynamoStore } from '../adapters/dynamodb.js';
import { RealtimeService } from '../services/realtime.js';

export function createWebsocketHandler(realtime, { origins = [] } = {}) {
  return async event => {
    if (event.Records) {
      const failures = [];
      for (const record of event.Records) {
        try {
          const key = record.dynamodb?.Keys?.pk?.S ?? '';
          if (key.startsWith('workspace#')) await realtime.notifyWorkspace(key.slice('workspace#'.length));
          else if (key.startsWith('user#')) await realtime.notifyUser(key.slice('user#'.length));
          else if (key.startsWith('realtime-revoke#')) await realtime.notifyUser(key.slice('realtime-revoke#'.length));
        } catch { failures.push({itemIdentifier:record.dynamodb.SequenceNumber}); }
      }
      return { batchItemFailures: failures };
    }
    if (event.source === 'aws.events') { await realtime.sweep(); return {statusCode:200}; }
    const { connectionId, routeKey } = event.requestContext ?? {};
    try {
      if (!connectionId) return {statusCode:400,body:'Invalid connection'};
      if (routeKey === '$connect') {
        const origin = event.headers?.origin ?? event.headers?.Origin;
        if (!origins.includes(origin)) return {statusCode:403,body:'Origin denied'};
        await realtime.connect(connectionId,event.queryStringParameters?.ticket);
      } else if (routeKey === '$disconnect') await realtime.disconnect(connectionId);
      else {
        if (Buffer.byteLength(event.body ?? '') > 1024) return {statusCode:413,body:'Message too large'};
        const body = JSON.parse(event.body ?? '{}');
        if (body.action !== 'revalidate') return {statusCode:400,body:'Fresh ticket required'};
        await realtime.revalidate(connectionId,body.ticket);
      }
      return {statusCode:200,body:'ok'};
    } catch (error) {
      if (routeKey !== '$connect' && routeKey !== '$disconnect' && [401,403,404].includes(error.status)) {
        try { await realtime.deliver(connectionId,{type:'access-revoked'}); await realtime.close(connectionId); } catch { /* cleanup below */ }
        await realtime.disconnect(connectionId);
      }
      return {statusCode:error.status ?? 503,body:'Connection unavailable'};
    }
  };
}

let handlerPromise;
export async function handler(event) {
  handlerPromise ??= (async () => {
    const {ApiGatewayManagementApiClient,PostToConnectionCommand,DeleteConnectionCommand} = await import('@aws-sdk/client-apigatewaymanagementapi');
    const client = new ApiGatewayManagementApiClient({endpoint:process.env.WEBSOCKET_MANAGEMENT_URL,maxAttempts:3});
    const realtime = new RealtimeService(await createDynamoStore(),()=>new Date().toISOString(),{
      send:(id,payload)=>client.send(new PostToConnectionCommand({ConnectionId:id,Data:Buffer.from(JSON.stringify(payload))})),
      close:id=>client.send(new DeleteConnectionCommand({ConnectionId:id})),
    });
    return createWebsocketHandler(realtime,{origins:(process.env.FRONTEND_ORIGIN ?? '').split(',').filter(Boolean)});
  })().catch(e=>{handlerPromise=null;throw e;});
  return (await handlerPromise)(event);
}
