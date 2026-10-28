import { AuthService } from './services/auth.js';
import { CareGroupService } from './services/groups.js';
import { CareEventService, ScheduleService } from './services/care.js';
import { HandoffService } from './services/handoff.js';
import { ApprovalService } from './services/approvals.js';
import { LocalAnalysisService } from './services/bedrock.js';
import { LocalSttService } from './adapters/stt.js';
import { createCarebridgeClient } from './adapters/carebridge.js';
import { CarebridgeService } from './services/carebridge.js';
import { WorkspaceService } from './services/workspaces.js';
import { EventEmitter } from 'node:events';
import { fail, fields, text, base64Audio, dayInSeoul, dateScope, sortBy } from './domain.js';
import { CareGroupRepository, UserRepository } from './repositories/index.js';

const MAX_AUDIO_BYTES = Number(process.env.AUDIO_MAX_BYTES) || 4 * 1024 * 1024;

export function createApp(store, { clock = () => new Date().toISOString(), ai = new LocalAnalysisService(), stt = new LocalSttService(), auth: suppliedAuth, carebridge = createCarebridgeClient(), workspacePolicy = {} } = {}) {
  const auth = suppliedAuth ?? new AuthService(store, clock);
  const bridge = new CarebridgeService(store, clock, carebridge);
  const workspaces = new WorkspaceService(store, clock, carebridge, workspacePolicy);
  const notifications = new EventEmitter();
  notifications.setMaxListeners(0);
  const answerQuestion = async (userId, groupId, question) => store.transaction(async tx => {
    const { group } = await new CareGroupRepository(tx).forMember(groupId, userId);
    if (/취소|변경|안\s*갈/.test(question)) return { mode: 'database', answer: '일정을 선택해 승인 요청을 등록해주세요.', sources: [], requiresApproval: true };
    if (/담당|보호자/.test(question)) {
      const profile = await new UserRepository(tx).findById(group.primaryCaregiverId);
      return { mode: 'database', answer: `현재 담당 보호자는 ${profile?.name ?? '등록된 보호자'}입니다.`, sources: [{ groupId: group.id }] };
    }
    const type = /병원|진료/.test(question) ? 'hospital' : /약|복약/.test(question) ? 'medication' : /누가|방문/.test(question) ? 'visit' : null;
    const now = clock(), scope = dateScope(question, now);
    if (!type && !(scope && /일정/.test(question))) return { mode: 'database', answer: '병원·복약·방문·일정(오늘·내일·이번 주·다음 주) 또는 담당 보호자를 질문해주세요.', sources: [] };
    const inScope = s => !scope || (dayInSeoul(s.scheduledAt) >= scope.from && dayInSeoul(s.scheduledAt) <= scope.to);
    const found = group.schedules.filter(s => !s.deletedAt && s.status === 'scheduled' && (!type || s.type === type) && s.scheduledAt >= now && inScope(s)).sort(sortBy('scheduledAt'));
    const none = scope ? `${scope.label} 예정된 일정이 없습니다.` : '조건에 맞는 예정 일정이 없습니다.';
    return { mode: 'database', answer: found.length ? found.slice(0, 5).map(s => `${s.title}: ${new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'full', timeStyle: 'short' }).format(new Date(s.scheduledAt))}`).join('\n') : none, sources: found.slice(0, 5).map(s => ({ scheduleId: s.id })) };
  });
  const groups = new CareGroupService(store, clock), events = new CareEventService(store, clock, ai), schedules = new ScheduleService(store, clock), handoffs = new HandoffService(store, clock, ai), approvals = new ApprovalService(store, clock);
  const handle = async function ({ method, path, token, body = {} }) {
    try {
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'JSON 객체가 필요합니다.');
      const url = new URL(path, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      let result, status = 200;
      if (url.pathname === '/health' && method === 'GET') return { status: 200, body: { status: 'ok', carebridge: { schema: 'carebridge.workflow.v1', aiConfigured: Boolean(carebridge.enabled) } } };
      if (url.pathname === '/workspace-auth/register' && method === 'POST') {
        if (!['author', 'reviewer', 'viewer'].includes(body.role)) fail(400, '가입 역할을 선택해 주세요.');
        return { status: 201, body: await auth.register(body) };
      }
      if (parts[0] === 'auth' && parts.length === 2 && method === 'POST' && ['register', 'login', 'confirm', 'resend-confirmation'].includes(parts[1])) {
        if (parts[1] === 'confirm' && !auth.confirm) fail(404, '로컬 인증은 별도 확인 코드가 없습니다.');
        if (parts[1] === 'resend-confirmation' && !auth.resend) fail(400, '로컬 인증은 이메일을 발송하지 않습니다.', 'EMAIL_VERIFICATION_NOT_SUPPORTED');
        result = await auth[parts[1] === 'resend-confirmation' ? 'resend' : parts[1]](body); status = parts[1] === 'register' ? 201 : 200;
      } else {
        const userId = await auth.authenticate(token);
        if (parts[0] === 'workspaces') {
          const response = await workspaces.handle(userId, method, parts.slice(1), body, url.searchParams);
          if (method !== 'GET') notifications.emit('invalidate', parts[1]);
          return response;
        }
        const workspaceAccount = await store.transaction(tx => tx.get(`user#${userId}`));
        if (workspaceAccount?.workspaceRole && !['/me', '/auth/logout'].includes(url.pathname)) fail(403, '기관 계정은 작업 그룹 API를 사용해 주세요.');
        if (url.pathname === '/auth/logout' && method === 'POST') { fields(body, []); result = await auth.logout(token); notifications.emit('invalidate', null); }
        else if (url.pathname === '/me' && ['GET', 'PATCH'].includes(method)) result = await auth.profile(userId, method, body, token);
        else if (url.pathname === '/invitations/accept' && method === 'POST') result = await groups.accept(userId, body);
        else if (parts[0] === 'groups' && parts[2] === 'carebridge') return await bridge.handle(userId, parts[1], method, parts.slice(3), body, url.searchParams);
        else if (parts[0] === 'groups' && parts.length <= 5) {
          const [, groupId, resource, id, action] = parts;
          if (parts.length === 1 && ['GET', 'POST'].includes(method)) { result = await groups.execute(userId, method, null, null, null, body); status = method === 'POST' ? 201 : 200; }
          else if (!groupId) fail(404, '경로를 찾을 수 없습니다.');
          else if (resource === 'events' && action === 'analyze' && id && method === 'POST') result = await events.analyze(userId, groupId, id, body);
          else if (resource === 'events' && id === 'analyze' && !action && method === 'POST') result = await events.analyze(userId, groupId, null, body);
          else if (resource === 'events' && !action) { result = await events.execute(userId, groupId, method, id, body, url.searchParams); status = method === 'POST' ? 201 : 200; }
          else if (resource === 'schedules' && !action) { result = await schedules.execute(userId, groupId, method, id, body, url.searchParams); status = method === 'POST' ? 201 : 200; }
          else if (resource === 'handoffs') { result = await handoffs.execute(userId, groupId, method, id, action, body); status = method === 'POST' && action !== 'acknowledge' ? 201 : 200; }
          else if (resource === 'handover' && !id && method === 'POST') result = await handoffs.handover(userId, groupId, body);
          else if (resource === 'approvals' && !action) { result = await approvals.execute(userId, groupId, method, id, body); status = method === 'POST' ? 201 : 200; }
          else if (resource === 'assistant' && !id && method === 'POST') {
            fields(body, ['question']); const question = text(body.question, 'question', 500);
            result = await answerQuestion(userId, groupId, question);
          } else if (resource === 'assistant' && id === 'voice' && !action && method === 'POST') {
            fields(body, ['audioBase64', 'mimeType']);
            await store.transaction(tx => new CareGroupRepository(tx).forMember(groupId, userId));
            const audio = base64Audio(body.audioBase64, MAX_AUDIO_BYTES);
            const mimeType = body.mimeType === undefined ? undefined : text(body.mimeType, 'mimeType', 100);
            const transcript = text(await stt.transcribe(audio, mimeType), 'question', 500);
            result = { transcript, ...await answerQuestion(userId, groupId, transcript) };
          } else if (!action) { result = await groups.execute(userId, method, groupId, resource, id, body); status = method === 'POST' && ['elder', 'invitations'].includes(resource) ? 201 : 200; }
          else fail(404, '경로를 찾을 수 없습니다.');
        } else fail(404, '경로를 찾을 수 없습니다.');
      }
      return { status, body: result };
    } catch (error) {
      return { status: error.status ?? 500, body: { error: error.status ? error.message : '서버 오류가 발생했습니다.', code: error.status ? error.code ?? 'REQUEST_ERROR' : 'INTERNAL_ERROR', ...(error.details ? { details: error.details } : {}) } };
    }
  };
  // Local HTTP SSE subscribers receive only invalidation signals, never record content.
  handle.subscribeWorkspace = (workspaceId, listener) => {
    const callback = changedId => { if (!changedId || changedId === workspaceId) listener(); };
    notifications.on('invalidate', callback);
    return () => notifications.off('invalidate', callback);
  };
  return handle;
}
