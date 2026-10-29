import { randomBytes, randomUUID } from 'node:crypto';
import { fail, fields, text, choice } from '../domain.js';
import { hash, evidenceSegments, validateDraft, validateReview } from '../carebridge-contract.js';
import { requireDeployedAdmin } from './deployed-admin.js';

export const workspaceRoles = ['author', 'reviewer', 'viewer'];
const key = id => `workspace#${id}`;
const indexKey = id => `workspace-user#${id}`;
const notFound = () => fail(404, '자료를 찾을 수 없습니다.');
const version = (expected, actual) => {
  if (!Number.isSafeInteger(expected) || expected < 1) fail(400, 'expectedVersion이 필요합니다.');
  if (expected !== actual) fail(409, '내용이 변경됐습니다. 다시 조회해 주세요.', 'STALE_VERSION');
};
const source = value => {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > 4000 || evidenceSegments(value).length > 40) fail(400, '원문은 4,000자·40구간 이내여야 합니다.');
  return value;
};
const summary = s => ({ submissionId: s.submissionId, threadId: s.threadId, parentSubmissionId: s.parentSubmissionId, subject: s.subject, authorId: s.authorId, authorNameAtSubmission: s.authorNameAtSubmission ?? null, submittedAt: s.submittedAt, status: s.status, version: s.version });

// Separate namespace: legacy family roles and approved notes never grant workspace access.
export class WorkspaceService {
  constructor(store, clock, ai, policy = {}) { Object.assign(this, { store, clock, ai, policy }); }
  async user(tx, userId) {
    const user = await tx.get(`user#${userId}`);
    if (!user) fail(401, '로그인이 필요합니다.');
    if (user.deployedTestAdmin) return requireDeployedAdmin(tx, user);
    if (!workspaceRoles.includes(user.workspaceRole) && !user.isTestAdmin) fail(403, '기존 계정 역할 배정이 필요합니다.', 'ROLE_ASSIGNMENT_REQUIRED');
    return user;
  }
  async access(tx, userId, id, roles) {
    const user = await this.user(tx, userId), w = await tx.get(key(id));
    if (user.deployedTestAdmin && !user.qaWorkspaceIds.includes(id)) notFound();
    if (!w) notFound();
    const member = w.members.find(m => m.userId === userId && m.status === 'active');
    const testRole = user.isTestAdmin && user.qaWorkspaceIds?.includes(id) ? user.qaRole : null;
    const role = testRole ?? (w.ownerReviewerId === userId ? 'reviewer' : member?.role);
    if (!role) notFound();
    if (roles && !roles.includes(role)) fail(403, '이 작업에 필요한 역할이 아닙니다.');
    return { w, user, role };
  }
  async save(tx, w, actor, action, resourceId) {
    w.revision++;
    const target = w.submissions.find(s => s.submissionId === resourceId) ?? w.publications.find(p => p.publicationId === resourceId) ?? w.requests.find(r => r.requestId === resourceId) ?? w.transfers?.find(t => t.transferId === resourceId) ?? w.members.find(m => m.userId === resourceId);
    const resourceType = w.submissions.some(s => s.submissionId === resourceId) ? 'submission' : w.publications.some(p => p.publicationId === resourceId) ? 'publication' : w.requests.some(r => r.requestId === resourceId) ? 'join-request' : w.transfers?.some(t => t.transferId === resourceId) ? 'transfer' : action === 'register-subject' ? 'subject' : 'membership';
    w.audit.push({ eventId: randomUUID(), actorId: actor.userId, actorNameAtEvent: actor.name, role: actor.isTestAdmin ? actor.qaRole : actor.workspaceRole, action, resourceType, resourceId, result: target?.status ?? 'completed', reason: target?.reviews?.at(-1)?.reason ?? null, at: this.clock(), revision: w.revision });
    await tx.set(key(w.workspaceId), w);
  }
  async assertSingleWorkspace(tx, userId, desiredId, claim = false) {
    const slotKey = `workspace-active#${userId}`, slot = await tx.get(slotKey);
    if (slot && slot.workspaceId !== desiredId) fail(409, '이미 다른 기관에 소속되어 있습니다.', 'SINGLE_WORKSPACE_REQUIRED');
    const index = await tx.get(indexKey(userId));
    for (const other of index?.workspaceIds ?? []) {
      if (other === desiredId) continue;
      const w = await tx.get(key(other));
      if (w && (w.ownerReviewerId === userId || w.members.some(m => m.userId === userId && m.status === 'active'))) fail(409, '이미 다른 기관에 소속되어 있습니다.', 'SINGLE_WORKSPACE_REQUIRED');
    }
    if (claim) await tx.set(slotKey, { workspaceId: desiredId });
  }
  async display(tx, record, w) {
    const user = await tx.get(`user#${record.authorId}`);
    const memberName = w.members.find(m => m.userId === record.authorId)?.name;
    return { ...record, authorNameAtSubmission: record.authorNameAtSubmission ?? null, authorCurrentName: user?.name ?? memberName ?? null };
  }
  async addIndex(tx, userId, id) {
    const index = await tx.get(indexKey(userId)) ?? { workspaceIds: [] };
    if (!index.workspaceIds.includes(id)) index.workspaceIds.push(id);
    await tx.set(indexKey(userId), index);
  }
  async handle(userId, method, path, body, query) {
    if (path.length === 0) {
      if (method === 'POST') return { status: 201, body: await this.create(userId, body) };
      if (method === 'GET') return { status: 200, body: await this.mine(userId) };
    }
    if (path.length === 1 && path[0] === 'join-requests' && method === 'POST') return { status: 201, body: await this.join(userId, body) };
    const [id, resource, itemId, action] = path;
    if (path.length > 4) notFound();
    if (resource === 'transfers' && itemId && action === 'accept' && method === 'POST') return { status: 200, body: await this.acceptTransfer(userId, id, itemId, body) };
    if (resource === 'drafts' && !itemId && method === 'POST') return { status: 201, body: await this.generate(userId, id, body) };
    if (resource === 'transcriptions' && !itemId && method === 'POST') return { status: 200, body: await this.transcribe(userId, id, body) };
    if (resource === 'submissions' && itemId && action === 'check' && method === 'POST') return { status: 200, body: await this.checkReview(userId, id, itemId, body) };
    return { status: 200, body: await this.store.transaction(async tx => {
      const a = await this.access(tx, userId, id), { w, user, role } = a;
      const reviewer = () => { if (role !== 'reviewer') fail(403, '검토자 권한이 필요합니다.'); };
      const author = () => { if (role !== 'author') fail(403, '작성자 권한이 필요합니다.'); };
      if (!resource && method === 'GET') return { workspaceId: id, name: w.name, ownerReviewerId: w.ownerReviewerId, role, revision: w.revision, ...(role === 'reviewer' ? { inviteCode: w.inviteCode } : {}) };
      if (resource === 'access' && !itemId && method === 'GET') return { workspaceId: id, revision: w.revision, role, testAccess: Boolean(user.isTestAdmin), revalidateRequired: true };
      if (resource === 'audit' && !itemId && method === 'GET') {
        reviewer();
        const limit = Number(query.get('limit') ?? 20), cursor = query.get('cursor');
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail(400, 'limit는 1~50이어야 합니다.');
        let events = w.audit.map((e, i) => ({ ...e, eventId: e.eventId ?? `legacy-${id}-${e.revision}-${i}` })).sort((a,b) => b.revision - a.revision || b.eventId.localeCompare(a.eventId));
        if (cursor) { const i = events.findIndex(e => e.eventId === cursor); if (i < 0) fail(400, '유효하지 않은 cursor입니다.'); events = events.slice(i + 1); }
        const items = [];
        for (const e of events.slice(0, limit)) {
          const actor = await tx.get(`user#${e.actorId}`);
          items.push({ ...e, actorNameAtEvent: e.actorNameAtEvent ?? null, actorCurrentName: actor?.name ?? w.members.find(m => m.userId === e.actorId)?.name ?? null });
        }
        return { items, nextCursor: events.length > limit ? items.at(-1).eventId : null };
      }
      if (resource === 'transfers') {
        if (this.policy.transferEnabled !== true) fail(409, '관리 권한 이전 방식 D04 설정이 필요합니다.', 'POLICY_REQUIRED');
        w.transfers ??= [];
        if (method === 'GET' && !action) {
          reviewer();
          const result = [];
          for (const t of w.transfers.filter(t => !itemId || t.transferId === itemId)) {
            const target = await tx.get(`user#${t.targetUserId}`);
            result.push({ ...t, targetNameAtRequest: t.targetNameAtRequest ?? null, targetCurrentName: target?.name ?? null, updatedAt: t.completedAt ?? t.cancelledAt ?? t.startedAt });
          }
          return itemId ? result[0] ?? notFound() : result;
        }
        if (!itemId && method === 'POST') {
          reviewer(); fields(body, ['expectedVersion', 'targetUserId']); version(body.expectedVersion, w.revision);
          if (user.isTestAdmin || w.ownerReviewerId !== userId) fail(403, '정식 담당자만 이전을 시작할 수 있습니다.');
          const target = await this.user(tx, body.targetUserId);
          await this.assertSingleWorkspace(tx, target.userId, id);
          if (target.workspaceRole !== 'reviewer' || target.userId === userId || target.isTestAdmin) fail(400, '다른 2그룹 계정을 지정해 주세요.');
          if (w.transfers.some(t => t.status === 'pending')) fail(409, '진행 중인 이전이 있습니다.');
          const t = { transferId: randomUUID(), fromUserId: userId, targetUserId: target.userId, targetNameAtRequest: target.name, status: 'pending', startedAt: this.clock(), version: 1 };
          w.transfers.push(t); await this.addIndex(tx, target.userId, id); await this.save(tx, w, user, 'start-transfer', t.transferId); return t;
        }
        const t = w.transfers.find(t => t.transferId === itemId) ?? notFound();
        if (action === 'cancel' && method === 'POST') {
          reviewer(); fields(body, ['expectedVersion']); version(body.expectedVersion, t.version);
          if (t.fromUserId !== userId || t.status !== 'pending') fail(409, '취소할 수 없는 이전입니다.');
          t.status = 'cancelled'; t.cancelledAt = this.clock(); t.version++; await this.save(tx, w, user, 'cancel-transfer', itemId); return t;
        }
      }
      if (resource === 'join-requests') {
        reviewer();
        if (!itemId && method === 'GET') return w.requests;
        if (itemId && ['approve', 'reject'].includes(action) && method === 'POST') {
          fields(body, ['expectedVersion']);
          const r = w.requests.find(r => r.requestId === itemId) ?? notFound();
          version(body.expectedVersion, r.version);
          if (r.status !== 'pending') fail(409, '이미 처리된 요청입니다.');
          r.status = action === 'approve' ? 'approved' : 'rejected'; r.version++; r.decidedBy = userId; r.decidedAt = this.clock();
          if (action === 'approve') {
            const target = await this.user(tx, r.userId);
            if (target.workspaceRole !== r.role) fail(409, '신청자의 역할이 변경됐습니다.');
            if (w.members.some(m => m.userId === r.userId)) fail(409, '재가입 정책 결정이 필요합니다.', 'POLICY_REQUIRED');
            await this.assertSingleWorkspace(tx, r.userId, id, true);
            w.members.push({ userId: r.userId, name: target.name, role: r.role, status: 'active', joinedAt: this.clock() });
          }
          await this.save(tx, w, user, action, itemId); return r;
        }
      }
      if (resource === 'members') {
        reviewer();
        if (!itemId && method === 'GET') {
          const members = w.members.filter(m => m.status === 'active');
          for (const qaId of w.qaRecipientIds ?? []) {
            const qaUser = await tx.get(`user#${qaId}`);
            if (qaUser?.isTestAdmin && qaUser.qaWorkspaceIds?.includes(id)) members.push({userId:qaId,name:qaUser.name,role:'viewer',status:'active',testAccess:true});
          }
          return members;
        }
        if (itemId && !action && method === 'DELETE') {
          fields(body, ['expectedVersion']); version(body.expectedVersion, w.revision);
          const m = w.members.find(m => m.userId === itemId && m.status === 'active') ?? notFound();
          m.status = 'removed'; m.removedAt = this.clock();
          const slot = await tx.get(`workspace-active#${itemId}`);
          if (slot?.workspaceId === id) await tx.delete(`workspace-active#${itemId}`);
          for (const p of w.publications) {
            if (p.recipients.includes(itemId)) p.history.push({ action: 'recipient-removed', recipientId: itemId, actorId: userId, at: this.clock(), version: p.version });
            p.recipients = p.recipients.filter(r => r !== itemId);
          }
          await this.save(tx, w, user, 'remove-member', itemId); return { removed: true, revision: w.revision };
        }
      }
      if (resource === 'subjects' && !action) {
        if (!['author', 'reviewer'].includes(role)) fail(403, '대상자 목록 접근 권한이 없습니다.');
        if (method === 'GET') {
          const q = query.get('q') ?? '';
          const items = w.subjects.filter(s => (!itemId || s.subjectId === itemId) && s.name.includes(q));
          return role === 'author' ? items.map(({ subjectId, name, managementNumber }) => ({ subjectId, name, managementNumber })) : items;
        }
        if (method === 'POST' && !itemId) {
          reviewer(); fields(body, ['name', 'memo']);
          const s = { subjectId: randomUUID(), name: text(body.name, 'name', 100), memo: body.memo === undefined ? '' : text(body.memo, 'memo', 1000), managementNumber: ++w.subjectSequence, registeredBy: userId, registeredAt: this.clock() };
          w.subjects.push(s); await this.save(tx, w, user, 'register-subject', s.subjectId); return s;
        }
      }
      if (resource === 'submissions') {
        if (!['author', 'reviewer'].includes(role)) fail(403, '제출 기록 접근 권한이 없습니다.');
        if (!itemId && method === 'POST') { author(); return this.submit(tx, a, body); }
        if (!itemId && method === 'GET') return Promise.all(w.submissions.filter(s => role === 'reviewer' || s.authorId === userId).map(s => this.display(tx, summary(s), w)));
        const s = w.submissions.find(s => s.submissionId === itemId) ?? notFound();
        if (role === 'author' && s.authorId !== userId) notFound();
        const saved = await tx.get(`workspace-submission#${id}#${itemId}`);
        if (!action && method === 'GET') {
          const result = await this.display(tx, { ...saved, ...s }, w);
          result.reviews = await Promise.all(s.reviews.map(async r => ({ ...r, actorNameAtEvent: r.actorNameAtEvent ?? null, actorCurrentName: (await tx.get(`user#${r.actorId}`))?.name ?? null })));
          return result;
        }
        if (action === 'review' && method === 'POST') {
          reviewer(); fields(body, ['expectedVersion', 'decision', 'content', 'reason', 'confirmSource', 'confirmChecks']);
          version(body.expectedVersion, s.version);
          const decision = choice(body.decision, ['edit', 'hold', 'confirm'], 'decision');
          if (s.authorId === userId && !user.isTestAdmin) fail(403, '본인 제출은 확정·검토할 수 없습니다.');
          if (s.status === 'confirmed') fail(409, '확정 기록은 직접 덮어쓸 수 없습니다.');
          if (decision === 'confirm') {
            if (body.confirmSource !== true || body.confirmChecks !== true) fail(400, '원문과 확인사항을 확인해 주세요.');
            if (this.policy.confirmationEnabled !== true) fail(409, '편집본 QA 및 확정 차단 정책 D10 설정이 필요합니다.', 'POLICY_REQUIRED');
            const finalContent = body.content === undefined ? (s.reviewContent ?? saved.authorDraft) : text(body.content, 'content', 8000);
            if (!s.finalQa || s.finalQa.contentHash !== hash(finalContent) || s.finalQa.version !== s.version) fail(409, '현재 최종 검토본의 유효한 QA 결과가 필요합니다.', 'FINAL_QA_REQUIRED');
          }
          const content = body.content === undefined ? (s.reviewContent ?? saved.authorDraft) : text(body.content, 'content', 8000);
          const reason = decision === 'hold' ? text(body.reason, 'reason', 2000) : (body.reason === undefined ? '' : text(body.reason, 'reason', 2000));
          s.reviewContent = content; s.status = decision === 'confirm' ? 'confirmed' : decision === 'hold' ? 'held' : s.status;
          s.version++; s.reviews.push({ decision, content, reason, actorId: userId, actorNameAtEvent: user.name, at: this.clock(), version: s.version, qaResult: s.finalQa ? structuredClone(s.finalQa) : null });
          if (decision === 'confirm') { s.confirmedBy = userId; s.confirmedAt = this.clock(); }
          await this.save(tx, w, user, `review-${decision}`, itemId); return s;
        }
      }
      if (resource === 'publications') {
        const viewerShape = p => ({ publicationId: p.publicationId, version: p.version, subject: p.subject, content: p.content, publishedAt: p.publishedAt });
        if (role === 'author') fail(403, '공개 기록 접근 권한이 없습니다.');
        const visible = p => p.status === 'published' && p.recipients.includes(userId);
        if (method === 'GET') {
          const items = w.publications.filter(p => role === 'reviewer' || visible(p));
          const p = itemId ? items.find(p => p.publicationId === itemId) ?? notFound() : null;
          return itemId ? (role === 'viewer' ? viewerShape(p) : p) : items.map(p => role === 'viewer' ? viewerShape(p) : p);
        }
        reviewer();
        if (!itemId && method === 'POST') {
          fields(body, ['submissionId', 'expectedVersion', 'content', 'recipientIds']);
          const s = w.submissions.find(s => s.submissionId === body.submissionId) ?? notFound();
          version(body.expectedVersion, s.version);
          if (s.status !== 'confirmed') fail(409, '확정된 제출만 공개 준비할 수 있습니다.');
          const p = { publicationId: randomUUID(), submissionId: s.submissionId, confirmedVersion: s.version, subject: s.subject, content: text(body.content, 'content', 8000), recipientIds: this.recipients(w, body.recipientIds), recipients: [], status: 'unpublished', version: 1, history: [] };
          w.publications.push(p); await this.save(tx, w, user, 'prepare-publication', p.publicationId); return p;
        }
        const p = w.publications.find(p => p.publicationId === itemId) ?? notFound();
        fields(body, ['expectedVersion', ...(method === 'PATCH' ? ['content', 'recipientIds'] : [])]); version(body.expectedVersion, p.version);
        p.history.push({ content: p.content, recipientIds: [...p.recipientIds], recipients: [...p.recipients], version: p.version, status: p.status, at: this.clock(), actorId: userId });
        if (!action && method === 'PATCH') {
          if (body.content === undefined && body.recipientIds === undefined) fail(400, '변경 내용이 필요합니다.');
          if (body.recipientIds !== undefined && p.status === 'published' && !['block_all', 'retain'].includes(this.policy.recipientChange)) fail(409, '수신자 변경 정책 D06 설정이 필요합니다.', 'POLICY_REQUIRED');
          if (body.recipientIds !== undefined) {
            p.recipientIds = this.recipients(w, body.recipientIds);
            p.recipients = this.policy.recipientChange === 'retain' ? p.recipients.filter(r => p.recipientIds.includes(r)) : [];
          }
          if (body.content !== undefined) { p.content = text(body.content, 'content', 8000); p.recipients = []; }
          if (!p.recipients.length) p.status = 'blocked';
        } else if (action === 'publish' && method === 'POST') {
          const s = w.submissions.find(s => s.submissionId === p.submissionId);
          if (s?.status !== 'confirmed' || s.version !== p.confirmedVersion) fail(409, '확정 버전이 변경됐습니다.');
          p.recipients = this.recipients(w, p.recipientIds); p.status = 'published'; p.publishedAt = this.clock();
        } else if (action === 'revoke' && method === 'POST') { p.status = 'revoked'; p.recipients = []; }
        else notFound();
        p.version++; p.history.push({ action: action ?? 'correct', actorId: userId, at: this.clock(), version: p.version });
        await this.save(tx, w, user, action ?? 'correct-publication', itemId); return p;
      }
      notFound();
    }, { validateReads: true }) };
  }
  recipients(w, ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length) fail(400, '수신자를 명시적으로 선택해 주세요.');
    if (ids.some(id => !w.members.some(m => m.userId === id && m.role === 'viewer' && m.status === 'active') && !w.qaRecipientIds?.includes(id))) fail(409, '활성 열람자만 수신자로 선택할 수 있습니다.');
    return [...ids];
  }
  async create(userId, body) {
    fields(body, ['name']); const name = text(body.name, 'name', 100);
    return this.store.transaction(async tx => {
      const user = await this.user(tx, userId);
      if (user.workspaceRole !== 'reviewer') fail(403, '2그룹만 작업 그룹을 생성할 수 있습니다.');
      const workspaceId = randomUUID();
      await this.assertSingleWorkspace(tx, userId, workspaceId, true);
      let inviteCode;
      do { inviteCode = randomBytes(9).toString('base64url'); } while (await tx.get(`workspace-code#${inviteCode}`));
      const w = { workspaceId, name, ownerReviewerId: userId, inviteCode, revision: 1, createdAt: this.clock(), members: [], requests: [], subjects: [], subjectSequence: 0, submissions: [], publications: [], audit: [{eventId:randomUUID(),actorId:userId,actorNameAtEvent:user.name,role:'reviewer',action:'create-workspace',resourceType:'workspace',resourceId:workspaceId,result:'active',at:this.clock(),revision:1}] };
      await tx.set(key(w.workspaceId), w); await tx.set(`workspace-code#${inviteCode}`, { workspaceId: w.workspaceId }); await this.addIndex(tx, userId, w.workspaceId);
      return { workspaceId: w.workspaceId, name, ownerReviewerId: userId, inviteCode, revision: 1 };
    });
  }
  async mine(userId) {
    return this.store.transaction(async tx => {
      const user = await this.user(tx, userId), index = await tx.get(indexKey(userId));
      const items = [];
      for (const id of new Set([...(index?.workspaceIds ?? []), ...(user.isTestAdmin ? user.qaWorkspaceIds ?? [] : [])])) {
        if (user.deployedTestAdmin && !user.qaWorkspaceIds.includes(id)) continue;
        const w = await tx.get(key(id)); if (!w) continue;
        const member = w.members.find(m => m.userId === userId), request = w.requests.filter(r => r.userId === userId).at(-1);
        const transfers = w.transfers?.filter(t => t.targetUserId === userId && t.status === 'pending') ?? [];
        const qaAccess = Boolean(user.isTestAdmin && user.qaWorkspaceIds?.includes(id));
        items.push({ workspaceId: id, name: w.name, status: qaAccess || w.ownerReviewerId === userId ? 'active' : member?.status ?? request?.status ?? (transfers.length ? 'transfer_pending' : 'inactive'), role: qaAccess ? user.qaRole : w.ownerReviewerId === userId ? 'reviewer' : member?.role ?? user.workspaceRole, testAccess: qaAccess, request, transfers });
      }
      return items;
    });
  }
  async join(userId, body) {
    fields(body, ['code']); const code = text(body.code, 'code', 100);
    return this.store.transaction(async tx => {
      const user = await this.user(tx, userId);
      if (!['author', 'viewer'].includes(user.workspaceRole)) fail(403, '1·3그룹만 참여 요청할 수 있습니다.');
      const match = await tx.get(`workspace-code#${code}`);
      if (!match) fail(400, '유효하지 않은 코드입니다.');
      const w = await tx.get(key(match.workspaceId));
      if (w.members.some(m => m.userId === userId)) fail(409, '이미 참여했거나 재가입 정책 결정이 필요합니다.');
      const pending = w.requests.find(r => r.userId === userId && r.status === 'pending');
      if (pending) return pending;
      await this.assertSingleWorkspace(tx, userId, w.workspaceId);
      const r = { requestId: randomUUID(), workspaceId: w.workspaceId, userId, name: user.name, role: user.workspaceRole, status: 'pending', requestedAt: this.clock(), version: 1 };
      w.requests.push(r); await this.addIndex(tx, userId, w.workspaceId); await this.save(tx, w, user, 'request-join', r.requestId); return r;
    });
  }
  async acceptTransfer(userId, id, transferId, body) {
    fields(body, ['expectedVersion']);
    if (this.policy.transferEnabled !== true) fail(409, '관리 권한 이전 방식 D04 설정이 필요합니다.', 'POLICY_REQUIRED');
    return this.store.transaction(async tx => {
      const user = await this.user(tx, userId), w = await tx.get(key(id));
      const t = w?.transfers?.find(t => t.transferId === transferId) ?? notFound();
      if (t.targetUserId !== userId || user.workspaceRole !== 'reviewer' || user.isTestAdmin) notFound();
      version(body.expectedVersion, t.version);
      if (t.status !== 'pending' || w.ownerReviewerId !== t.fromUserId) fail(409, '유효하지 않은 이전입니다.');
      await this.assertSingleWorkspace(tx, userId, id, true);
      const previousSlot = await tx.get(`workspace-active#${t.fromUserId}`);
      if (previousSlot?.workspaceId === id) await tx.delete(`workspace-active#${t.fromUserId}`);
      w.ownerReviewerId = userId; t.status = 'completed'; t.completedAt = this.clock(); t.version++;
      await this.save(tx, w, user, 'complete-transfer', transferId); return t;
    });
  }
  async generate(userId, id, body) {
    fields(body, ['memo', 'sourceLanguage', 'dataUse']);
    if (body.dataUse !== 'synthetic_deidentified') fail(400, '현재 AI는 합성 비식별 입력만 지원합니다.');
    const memo = source(body.memo), language = body.sourceLanguage ?? 'ko';
    if (!['auto', 'ko', 'en', 'vi', 'id', 'th', 'tl', 'zh', 'ja', 'ne', 'uz', 'ru'].includes(language)) fail(400, '지원하지 않는 언어입니다.');
    await this.store.transaction(tx => this.access(tx, userId, id, ['author']));
    let draft;
    try { draft = validateDraft(await this.ai.draft({ memo, source_language: language, data_use: body.dataUse }), memo); }
    catch (error) { if (error.status) throw error; fail(502, 'AI 초안 생성에 실패했습니다.', 'CAREBRIDGE_AI_FAILED'); }
    return this.store.transaction(async tx => {
      await this.access(tx, userId, id, ['author']);
      const result = { generationId: randomUUID(), workspaceId: id, authorId: userId, sourceHash: hash(memo), generatedAt: this.clock(), draft };
      await tx.set(`workspace-generation#${id}#${result.generationId}`, result); return result;
    });
  }
  async transcribe(userId, id, body) {
    fields(body, ['audioBase64', 'sourceLanguage', 'dataUse']);
    if (body.dataUse !== 'synthetic_deidentified') fail(400, '합성 비식별 음성만 지원합니다.');
    const language = choice(body.sourceLanguage ?? 'auto', ['auto','ko','en','vi','id','th','tl','zh','ja','ne','uz','ru'], 'sourceLanguage');
    if (typeof body.audioBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.audioBase64)) fail(400, 'base64 음성이 필요합니다.');
    const audio = Buffer.from(body.audioBase64, 'base64');
    if (!audio.length || audio.length > 3 * 1024 * 1024 - 1024) fail(413, '음성 크기를 확인해 주세요.');
    await this.store.transaction(tx => this.access(tx, userId, id, ['author']));
    let result;
    try { result = await this.ai.transcribe(audio, language); }
    catch (error) { if (error.status) throw error; fail(502, '전사에 실패했습니다.', 'CAREBRIDGE_AI_FAILED'); }
    if (typeof result?.text !== 'string' || !result.text.trim() || result.text.length > 4000 || result.requires_transcript_review !== true) fail(502, '전사 응답이 올바르지 않습니다.', 'CAREBRIDGE_BAD_RESPONSE');
    await this.store.transaction(tx => this.access(tx, userId, id, ['author']));
    return { text: result.text, requiresTranscriptReview: true };
  }
  async checkReview(userId, id, submissionId, body) {
    fields(body, ['expectedVersion']);
    const snapshot = await this.store.transaction(async tx => {
      const a = await this.access(tx, userId, id, ['reviewer']);
      const s = a.w.submissions.find(s => s.submissionId === submissionId) ?? notFound();
      version(body.expectedVersion, s.version);
      if (s.authorId === userId && !a.user.isTestAdmin) fail(403, '본인 제출은 검토할 수 없습니다.');
      if (s.status === 'confirmed') fail(409, '이미 확정된 제출입니다.');
      const saved = await tx.get(`workspace-submission#${id}#${submissionId}`);
      const content = s.reviewContent ?? saved.authorDraft;
      const candidate = structuredClone(saved.generatedDraft), lines = content.split(/\r?\n/).filter(line => line.trim());
      if (lines.length !== candidate.translation.segments.length) fail(422, '근거 구간 수가 변경된 편집본의 QA 계약 D10 결정이 필요합니다.', 'EDITED_EVIDENCE_REQUIRED');
      candidate.translation.segments.forEach((segment, i) => { segment.text = lines[i]; candidate.observations[i].text = lines[i]; });
      candidate.translation.text = lines.join('\n');
      return { candidate, contentHash: hash(content), version: s.version };
    }, { validateReads: true });
    let qa;
    try { qa = validateReview(await this.ai.qa(snapshot.candidate)); }
    catch (error) { if (error.status) throw error; fail(502, '최종본 QA에 실패했습니다.', 'CAREBRIDGE_AI_FAILED'); }
    return this.store.transaction(async tx => {
      const { w, user } = await this.access(tx, userId, id, ['reviewer']);
      const s = w.submissions.find(s => s.submissionId === submissionId) ?? notFound();
      version(snapshot.version, s.version);
      s.finalQa = { qa, contentHash: snapshot.contentHash, version: s.version, checkedAt: this.clock(), checkedBy: userId };
      await this.save(tx, w, user, 'check-review', submissionId); return s.finalQa;
    });
  }
  async submit(tx, { w, user }, body) {
    fields(body, ['requestId', 'subjectId', 'generationId', 'memo', 'authorDraft', 'confirmSource', 'parentSubmissionId']);
    const requestId = text(body.requestId, 'requestId', 100);
    const fingerprint = hash(JSON.stringify(['subjectId','generationId','memo','authorDraft','confirmSource','parentSubmissionId'].map(field => body[field] ?? null)));
    const requestKey = `workspace-submit#${w.workspaceId}#${user.userId}#${requestId}`;
    const old = await tx.get(requestKey);
    if (old) {
      if (old.fingerprint !== fingerprint) fail(409, '같은 요청 ID의 내용이 다릅니다.');
      return old.result;
    }
    const subject = w.subjects.find(s => s.subjectId === body.subjectId) ?? notFound();
    const generation = await tx.get(`workspace-generation#${w.workspaceId}#${body.generationId}`);
    const memo = source(body.memo);
    if (!generation || generation.authorId !== user.userId || generation.sourceHash !== hash(memo)) fail(409, '현재 원문에 연결된 생성본이 필요합니다.', 'STALE_SOURCE');
    if (body.confirmSource !== true) fail(400, '초안을 확인한 뒤 제출해 주세요.');
    const parent = body.parentSubmissionId ? w.submissions.find(s => s.submissionId === body.parentSubmissionId && s.authorId === user.userId && s.subject.subjectId === subject.subjectId) ?? notFound() : null;
    const s = { submissionId: randomUUID(), threadId: parent?.threadId ?? randomUUID(), parentSubmissionId: parent?.submissionId ?? null, authorId: user.userId, authorNameAtSubmission: user.name, subject: { subjectId: subject.subjectId, name: subject.name, managementNumber: subject.managementNumber }, submittedAt: this.clock(), status: 'review_pending', version: 1, reviews: [] };
    await tx.set(`workspace-submission#${w.workspaceId}#${s.submissionId}`, { ...s, memo, sourceHash: generation.sourceHash, generationId: generation.generationId, generatedDraft: generation.draft, authorDraft: text(body.authorDraft, 'authorDraft', 8000) });
    w.submissions.push(s); await this.save(tx, w, user, 'submit', s.submissionId);
    await tx.set(requestKey, { fingerprint, result: s }); return s;
  }
}
