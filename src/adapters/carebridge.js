import { fail } from '../domain.js';

export class CarebridgeClient {
  constructor({ baseUrl, apiKey, timeoutMs = 22000, fetchImpl = fetch }) {
    this.baseUrl = baseUrl?.replace(/\/$/,'') || '';
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.enabled = Boolean(this.baseUrl);
  }
  async request(path, body, multipart = false) {
    if (!this.enabled) fail(503,'케어브릿지 AI 연결이 설정되지 않았습니다.','CAREBRIDGE_UNAVAILABLE');
    let url;
    try { url = new URL(this.baseUrl); } catch { fail(503,'케어브릿지 AI 주소 설정을 확인해 주세요.','CAREBRIDGE_UNAVAILABLE'); }
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) fail(503,'케어브릿지 AI 주소 설정을 확인해 주세요.','CAREBRIDGE_UNAVAILABLE');
    let response;
    try {
      response = await this.fetch(this.baseUrl + path, {
        method:'POST', redirect:'error', signal:AbortSignal.timeout(this.timeoutMs),
        headers:{ ...(this.apiKey ? {'X-API-Key':this.apiKey} : {}), ...(!multipart ? {'Content-Type':'application/json'} : {}) },
        body: multipart ? body : JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if ([400,413,422].includes(response.status)) fail(response.status,'입력 내용을 확인해 주세요. 가상·비식별 메모와 30초 이하 음성만 사용할 수 있습니다.','CAREBRIDGE_INPUT_REJECTED');
        if (response.status === 503) fail(503,'AI 서버를 잠시 사용할 수 없습니다. 메모를 보존하고 다시 시도해 주세요.','CAREBRIDGE_UNAVAILABLE');
        fail(502,'AI 처리 또는 검사에 실패했습니다. 승인되지 않았습니다.','CAREBRIDGE_AI_FAILED');
      }
      const reader = response.body?.getReader();
      if (!reader) fail(502,'AI 응답을 읽지 못했습니다.','CAREBRIDGE_BAD_RESPONSE');
      const chunks = []; let size = 0;
      try {
        for (;;) {
          const {done,value} = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 256000) { await reader.cancel(); fail(502,'AI 응답이 너무 큽니다.','CAREBRIDGE_BAD_RESPONSE'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error.status) throw error;
      fail(502,'AI 서버에 연결하지 못했습니다. 메모를 보존하고 다시 시도해 주세요.','CAREBRIDGE_AI_FAILED');
    }
  }
  draft(input) { return this.request('/carebridge/drafts',input); }
  qa(draft) { return this.request('/carebridge/qa/semantic',draft); }
  transcribe(buffer, language) {
    const body = new FormData();
    body.append('file',new Blob([buffer],{type:'audio/wav'}),'observation.wav');
    body.append('source_language',language);
    body.append('data_use','synthetic_deidentified');
    return this.request('/carebridge/transcriptions',body,true);
  }
}
export function createCarebridgeClient(env = process.env) {
  return new CarebridgeClient({baseUrl:env.CAREBRIDGE_SERVICE_URL,apiKey:env.CAREBRIDGE_SERVICE_API_KEY,timeoutMs:Number(env.CAREBRIDGE_TIMEOUT_MS)||22000});
}
