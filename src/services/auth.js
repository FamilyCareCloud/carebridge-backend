import { validatePassword } from './verification.js';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { email, text, fields, fail, choice } from '../domain.js';
import { UserRepository } from '../repositories/index.js';
const scrypt = promisify(scryptCallback);
export const digest = token => createHash('sha256').update(token).digest('hex');
export const publicUser = ({ passwordHash, salt, groupIds, ...user }) => user;
export class AuthService {
  constructor(store, clock) { this.store = store; this.clock = clock; }
  async register(body) {
    fields(body, ['email', 'password', 'name', 'role']);
    const workspaceRole = body.role === undefined ? null : choice(body.role, ['author', 'reviewer', 'viewer'], 'role');
    const address = email(body.email), name = text(body.name, 'name', 100);
    validatePassword(body.password);
    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await scrypt(body.password, salt, 64)).toString('hex');
    return this.store.transaction(async tx => {
      if (await tx.get(`email#${address}`)) fail(409, '이미 가입된 이메일입니다.');
      const user = { userId: randomUUID(), name, email: address, role: 'caregiver', createdAt: this.clock(), groupIds: [], salt, passwordHash };
      if (workspaceRole) { user.workspaceRole = workspaceRole; user.role = workspaceRole; }
      await new UserRepository(tx).save(user);
      await tx.set(`email#${address}`, { userId: user.userId });
      return publicUser(user);
    });
  }
  async login(body) {
    fields(body, ['email', 'password']);
    const address = email(body.email);
    if (typeof body.password !== 'string' || body.password.length > 128) fail(400, '비밀번호가 필요합니다.');
    // Failed attempts must commit, rather than being rolled back with an exception.
    const result = await this.store.transaction(async tx => {
      const key = `login#${digest(address)}`, now = this.clock();
      const saved = await tx.get(key);
      const attempts = saved && saved.until > now ? saved : { count: 0, until: new Date(Date.parse(now) + 15 * 60000).toISOString() };
      if (attempts.count >= 5) return { blocked: true };
      const index = await tx.get(`email#${address}`);
      const user = index && await new UserRepository(tx).findById(index.userId);
      const candidate = await scrypt(body.password, user?.salt ?? 'invalid-user-salt', 64);
      if (!user?.passwordHash || !timingSafeEqual(candidate, Buffer.from(user.passwordHash, 'hex'))) {
        attempts.count++; await tx.set(key, attempts); return { invalid: true };
      }
      await tx.delete(key);
      const accessToken = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.parse(now) + 8 * 3600000).toISOString();
      await tx.set(`session#${digest(accessToken)}`, { userId: user.userId, expiresAt, expiresAtEpoch: Math.floor(Date.parse(expiresAt) / 1000) });
      return { accessToken, tokenType: 'Bearer', expiresAt, user: publicUser(user) };
    });
    if (result.blocked) fail(429, '로그인 시도가 많습니다. 15분 후 다시 시도하세요.');
    if (result.invalid) fail(401, '이메일 또는 비밀번호가 올바르지 않습니다.');
    return result;
  }
  async authenticate(token) {
    if (!token || token.length > 4096) fail(401, '로그인이 필요합니다.');
    return this.store.transaction(async tx => {
      const session = await tx.get(`session#${digest(token)}`);
      if (!session || session.expiresAt <= this.clock()) fail(401, '로그인이 만료되었습니다.');
      const user = await new UserRepository(tx).findById(session.userId);
      if (!user) fail(401, '사용자를 찾을 수 없습니다.');
      return user.userId;
    });
  }
  async logout(token) { await this.store.transaction(tx => tx.delete(`session#${digest(token)}`)); return { loggedOut: true }; }
  async profile(userId, method, body) {
    return this.store.transaction(async tx => {
      const repo = new UserRepository(tx), user = await repo.findById(userId);
      if (!user) fail(401, '사용자를 찾을 수 없습니다.');
      if (method === 'PATCH') {
        fields(body, ['name']); user.name = text(body.name, 'name', 100);
        await repo.save(user);
      }
      return publicUser(user);
    });
  }
}
