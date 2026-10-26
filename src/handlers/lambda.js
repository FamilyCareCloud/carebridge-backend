import { createApp } from '../app.js';
import { createDynamoStore } from '../adapters/dynamodb.js';
import { createCognitoAuth } from '../adapters/cognito.js';
import { createAnalysisService } from '../services/bedrock.js';
import { createCarebridgeClient } from '../adapters/carebridge.js';
import { createSttService } from '../adapters/stt.js';

const MAX_BODY = 65536;
const MAX_CAREBRIDGE_BODY = 262144;
const MAX_VOICE_BODY = Number(process.env.AUDIO_MAX_BYTES) || 4 * 1024 * 1024; // base64 오디오는 원본보다 커서 별도 상한 적용
const isVoicePath = path => /^\/groups\/[^/]+\/(?:assistant\/voice|carebridge\/transcriptions)$/.test(path);
export function createLambdaHandler(app) {
  return async event => {
    if (event.requestContext?.http?.method === 'OPTIONS') return { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };
    let response;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '';
      if (Buffer.byteLength(raw) > (isVoicePath(event.rawPath ?? '') ? MAX_VOICE_BODY : (event.rawPath ?? '').includes('/carebridge/') ? MAX_CAREBRIDGE_BODY : MAX_BODY)) return { statusCode: 413, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: '요청이 너무 큽니다.' }) };
      const authorization = event.headers?.authorization ?? event.headers?.Authorization ?? '';
      response = await app({ method: event.requestContext?.http?.method, path: `${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`, token: authorization.startsWith('Bearer ') ? authorization.slice(7) : null, body: raw ? JSON.parse(raw) : {} });
    } catch { response = { status: 400, body: { error: '올바른 JSON 요청이 필요합니다.' } }; }
    return { statusCode: response.status, headers: { ...(response.status === 429 && response.body?.details?.retryAfterSeconds ? { 'Retry-After': String(response.body.details.retryAfterSeconds) } : {}), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, body: JSON.stringify(response.body) };
  };
}
let appPromise;
export async function handler(event) {
  appPromise ??= (async () => {
    const store = await createDynamoStore(), clock = () => new Date().toISOString();
    return createApp(store, { clock, auth: await createCognitoAuth(store, clock), ai: await createAnalysisService(), stt: createSttService(), carebridge: createCarebridgeClient() });
  })().catch(error => { appPromise = null; throw error; });
  try { return await createLambdaHandler(await appPromise)(event); }
  catch { return { statusCode: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: '서비스 초기화에 실패했습니다.' }) }; }
}
