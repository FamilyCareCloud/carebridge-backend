import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { AuthService, publicUser } from './auth.js';
import { fail, fields, choice } from '../domain.js';
import { validatePassword } from './verification.js';

// Local QA only. Production authentication never imports or enables this adapter.
export class TestAuthService extends AuthService {
  constructor(store, clock, { enabled = false } = {}) { super(store, clock); this.enabled = enabled; }
  async register(body) {
    if (typeof body.email === 'string' && body.email.trim().toLowerCase() === 'qa-admin@local.invalid') fail(400, '테스트 계정 전용 주소입니다.');
    return super.register(body);
  }
  async provision(password, workspaceIds) {
    if (!this.enabled) fail(403, '테스트 계정이 비활성 상태입니다.');
    validatePassword(password);
    if (!Array.isArray(workspaceIds) || !workspaceIds.length || workspaceIds.some(id => typeof id !== 'string' || !id.trim())) fail(400, 'QA 작업 그룹을 지정해 주세요.');
    const salt = randomBytes(16).toString('hex'), passwordHash = scryptSync(password, salt, 64).toString('hex');
    await this.store.transaction(async tx => {
      for (const id of workspaceIds) if (!await tx.get(`workspace#${id}`)) fail(400, 'QA 작업 그룹이 존재하지 않습니다.');
      const old = await tx.get('test-admin#account');
      const previous = old && await tx.get(`user#${old.userId}`);
      const user = { userId: old?.userId ?? randomUUID(), name: 'QA admin', email: 'admin', loginId: 'admin', isTestAdmin: true, qaWorkspaceIds: [...new Set(workspaceIds)], qaRole: 'author', groupIds: [], salt, passwordHash, createdAt: this.clock() };
      for (const id of previous?.qaWorkspaceIds ?? []) {
        if (workspaceIds.includes(id)) continue;
        const w = await tx.get(`workspace#${id}`);
        if (w) {
          w.qaRecipientIds = (w.qaRecipientIds ?? []).filter(id => id !== user.userId);
          for (const p of w.publications) p.recipients = p.recipients.filter(id => id !== user.userId);
          await tx.set(`workspace#${id}`, w);
        }
      }
      await tx.set(`user#${user.userId}`, user);
      await tx.set('test-admin#account', { userId: user.userId });
      // Private alias used by the inherited password/session implementation.
      await tx.set('email#qa-admin@local.invalid', { userId: user.userId });
      for (const id of workspaceIds) {
        const w = await tx.get(`workspace#${id}`);
        w.qaRecipientIds = [...new Set([...(w.qaRecipientIds ?? []), user.userId])];
        await tx.set(`workspace#${id}`, w);
      }
    });
  }
  async login(body) {
    const address = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const isAdmin = body.loginId === 'admin' || address === 'admin' || address === 'qa-admin@local.invalid';
    if (!isAdmin) return super.login(body);
    fields(body, ['email', 'loginId', 'password']);
    if (!this.enabled) fail(401, '테스트 계정이 비활성 상태입니다.');
    if (body.loginId !== undefined && body.email !== undefined) fail(400, '로그인 ID를 확인해 주세요.');
    return super.login({ email: 'qa-admin@local.invalid', password: body.password });
  }
  async authenticate(token) {
    const id = await super.authenticate(token);
    const user = await this.store.transaction(tx => tx.get(`user#${id}`));
    if (user.isTestAdmin && !this.enabled) fail(401, '테스트 계정이 비활성 상태입니다.');
    return id;
  }
  async selectTestRole(userId, body) {
    fields(body, ['role']); const role = choice(body.role, ['author', 'reviewer', 'viewer'], 'role');
    return this.store.transaction(async tx => {
      const user = await tx.get(`user#${userId}`);
      if (!this.enabled || !user?.isTestAdmin) fail(403, '테스트 관리자만 역할을 선택할 수 있습니다.');
      user.qaRole = role; await tx.set(`user#${userId}`, user); return publicUser(user);
    });
  }
}
