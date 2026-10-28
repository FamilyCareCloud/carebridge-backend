import { randomBytes } from 'node:crypto';
import { hash } from '../carebridge-contract.js';
import { fail } from '../domain.js';
import { WorkspaceService } from './workspaces.js';

const connectionKey = id => `realtime-connection#${id}`;
const workspaceKey = id => `realtime-workspace#${id}`;
const userKey = id => `realtime-user#${id}`;
const allKey = 'realtime-all';

// Shared persistent connection registry. Workspace changes are delivered by DynamoDB Streams.
export class RealtimeService {
  constructor(store, clock, { websocketUrl = '', send, close } = {}) {
    Object.assign(this, { store, clock, websocketUrl, send, close });
    this.workspaces = new WorkspaceService(store, clock, {});
  }
  now() { return Math.floor(Date.parse(this.clock()) / 1000); }
  async ticket(userId, workspaceId, token) {
    if (!this.websocketUrl) fail(503, 'WebSocket 배포 설정이 필요합니다.', 'REALTIME_UNAVAILABLE');
    return this.store.transaction(async tx => {
      const { w } = await this.workspaces.access(tx, userId, workspaceId);
      const ticket = randomBytes(32).toString('base64url'), now = this.now();
      const localSession = await tx.get(`session#${hash(token)}`);
      // Token was authenticated by the HTTP entry point. Never use this parse to grant access.
      let jwtExpiry;
      try { jwtExpiry = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).exp; } catch { /* opaque local session */ }
      const sessionExpiresAt = Math.min(localSession?.expiresAtEpoch ?? (Number.isSafeInteger(jwtExpiry) ? jwtExpiry : now + 300), now + 8 * 3600);
      if (sessionExpiresAt <= now) fail(401, '로그인이 만료되었습니다.');
      await tx.set(`realtime-ticket#${hash(ticket)}`, { userId, workspaceId, issuedAt: Date.parse(this.clock()), sessionExpiresAt, expiresAtEpoch: Math.min(now + 60, sessionExpiresAt) });
      return { ticket, websocketUrl: this.websocketUrl, expiresInSeconds: 60, heartbeatSeconds: 20, proofValidSeconds: 60, revision: w.revision };
    });
  }
  async consume(tx, ticket) {
    if (typeof ticket !== 'string' || ticket.length > 100) fail(401, '연결 티켓이 필요합니다.');
    const key = `realtime-ticket#${hash(ticket)}`, proof = await tx.get(key);
    if (!proof || proof.expiresAtEpoch <= this.now()) fail(401, '연결 티켓이 만료되었습니다.');
    const revoked = await tx.get(`realtime-revoke#${proof.userId}`);
    if (revoked && proof.issuedAt <= revoked.at) fail(401, '세션을 다시 인증해 주세요.');
    await tx.delete(key); return proof;
  }
  async index(tx, key, id, add, limit = 100) {
    const index = await tx.get(key) ?? { ids: [] };
    index.ids = index.ids.filter(value => value !== id);
    if (add) { if (index.ids.length >= limit) fail(429, '실시간 연결 한도를 초과했습니다.'); index.ids.push(id); }
    await tx.set(key, index);
  }
  async connect(connectionId, ticket) {
    return this.store.transaction(async tx => {
      const proof = await this.consume(tx, ticket);
      await this.workspaces.access(tx, proof.userId, proof.workspaceId);
      const c = { connectionId, ...proof, proofAt: this.now(), expiresAtEpoch: proof.sessionExpiresAt };
      await tx.set(connectionKey(connectionId), c);
      await tx.set(`realtime-locator#${connectionId}`, { userId:c.userId, workspaceId:c.workspaceId });
      await this.index(tx, workspaceKey(c.workspaceId), connectionId, true, 100);
      await this.index(tx, userKey(c.userId), connectionId, true, 20);
      await this.index(tx, allKey, connectionId, true, 1000);
      return c;
    });
  }
  async disconnect(connectionId) {
    await this.store.transaction(async tx => {
      const c = await tx.get(connectionKey(connectionId)) ?? await tx.get(`realtime-locator#${connectionId}`);
      if (c) {
        await this.index(tx, workspaceKey(c.workspaceId), connectionId, false);
        await this.index(tx, userKey(c.userId), connectionId, false);
      }
      await this.index(tx, allKey, connectionId, false);
      await tx.delete(connectionKey(connectionId));
      await tx.delete(`realtime-locator#${connectionId}`);
    });
  }
  async revalidate(connectionId, ticket) {
    const payload = await this.store.transaction(async tx => {
      const c = await tx.get(connectionKey(connectionId));
      if (!c) fail(401, '연결을 다시 시작해 주세요.');
      const proof = await this.consume(tx, ticket);
      if (c.userId !== proof.userId || c.workspaceId !== proof.workspaceId) fail(403, '다른 연결의 티켓입니다.');
      const { w, role } = await this.workspaces.access(tx, c.userId, c.workspaceId);
      c.proofAt = this.now(); c.issuedAt = proof.issuedAt; c.sessionExpiresAt = proof.sessionExpiresAt; c.expiresAtEpoch = proof.sessionExpiresAt;
      await tx.set(connectionKey(connectionId), c);
      return { type: 'revalidate', workspaceId: c.workspaceId, revision: w.revision, role, validUntil: Math.min(c.proofAt + 60, c.sessionExpiresAt) };
    });
    await this.deliver(connectionId, payload); return payload;
  }
  async deliver(id, payload) {
    try { await this.send(id, payload); }
    catch (error) { if (error.$metadata?.httpStatusCode === 410 || error.name === 'GoneException') { await this.disconnect(id); return; } throw error; }
  }
  async notify(connectionId, sweep = false) {
    const result = await this.store.transaction(async tx => {
      const c = await tx.get(connectionKey(connectionId)); if (!c) return null;
      const revoked = await tx.get(`realtime-revoke#${c.userId}`);
      if (c.sessionExpiresAt <= this.now() || c.proofAt + 60 <= this.now() || (revoked && c.issuedAt <= revoked.at)) return { type: 'access-revoked', workspaceId: c.workspaceId };
      try {
        const { w, role } = await this.workspaces.access(tx, c.userId, c.workspaceId);
        return { type: sweep ? 'heartbeat' : 'invalidate', workspaceId: c.workspaceId, revision: w.revision, role };
      } catch (error) {
        if (![401,403,404].includes(error.status)) throw error;
        return { type: 'access-revoked', workspaceId: c.workspaceId };
      }
    }, { validateReads: true });
    if (!result) { await this.disconnect(connectionId); return; }
    await this.deliver(connectionId, result);
    if (result.type === 'access-revoked') {
      try { await this.close(connectionId); } catch (e) { if (e.$metadata?.httpStatusCode !== 410 && e.name !== 'GoneException') throw e; }
      await this.disconnect(connectionId);
    }
  }
  async notifyIndex(key, sweep = false) {
    const index = await this.store.transaction(tx => tx.get(key));
    // Deliberately bounded batches: retries preserve stream ordering per workspace.
    for (let i = 0; i < (index?.ids.length ?? 0); i += 10) await Promise.all(index.ids.slice(i,i+10).map(id => this.notify(id,sweep)));
  }
  notifyWorkspace(id) { return this.notifyIndex(workspaceKey(id)); }
  notifyUser(id) { return this.notifyIndex(userKey(id)); }
  async sweep() { await this.notifyIndex(allKey,true); }
  async revokeUser(userId) {
    await this.store.transaction(tx => tx.set(`realtime-revoke#${userId}`, { userId, at: Date.parse(this.clock()), nonce: randomBytes(8).toString('hex'), expiresAtEpoch: this.now() + 86400 }));
  }
}
