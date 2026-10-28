import test from 'node:test';
import assert from 'node:assert/strict';
import * as commands from '@aws-sdk/client-cognito-identity-provider';
import { Store } from '../src/store.js';
import { CognitoAuthService } from '../src/adapters/cognito.js';
import { WorkspaceService } from '../src/services/workspaces.js';
import { RealtimeService } from '../src/services/realtime.js';
import { deployedAdminKey } from '../src/services/deployed-admin.js';

const clock = () => '2026-10-29T00:00:00.000Z';
async function fixture() {
  const store = new Store(), calls = [];
  const config = { version: 1, enabled: true, username: 'internal@qa.invalid', userId: 'pinned-sub', workspaceIds: ['qa'] };
  await store.transaction(async tx => {
    await tx.set(deployedAdminKey, config);
    for (const id of ['qa', 'real']) await tx.set(`workspace#${id}`, { workspaceId: id, name: id, ownerReviewerId: 'owner', members: [{ userId: 'pinned-sub', role: 'reviewer', status: 'active' }], requests: [], revision: 1 });
    await tx.set('workspace-user#pinned-sub', { workspaceIds: ['real'] });
  });
  const auth = new CognitoAuthService({ store, clock, commands, clientId: 'client', logger: () => {}, client: { send: async command => {
    calls.push(command);
    if (command instanceof commands.InitiateAuthCommand) {
      if (command.input.AuthParameters.PASSWORD !== 'correct-test-password') { const e = new Error(); e.name = 'NotAuthorizedException'; throw e; }
      return { AuthenticationResult: { AccessToken: 'pinned-sub', ExpiresIn: 3600 } };
    }
    if (command instanceof commands.GetUserCommand) return { UserAttributes: [
      { Name: 'sub', Value: command.input.AccessToken }, { Name: 'email', Value: config.username },
      { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: 'admin' },
    ] };
    return {};
  } } });
  return { store, auth, calls, config, workspaces: new WorkspaceService(store, clock, {}) };
}
test('deployed admin alias still requires a successful Cognito password and pinned subject', async () => {
  const f = await fixture();
  await assert.rejects(f.auth.login({ loginId: 'admin', password: 'wrong' }), e => e.code === 'INVALID_CREDENTIALS');
  const result = await f.auth.login({ loginId: 'admin', password: 'correct-test-password' });
  assert.equal(result.user.isTestAdmin, true);
  assert.equal(result.user.qaRole, 'reviewer');
  assert.equal(f.calls[0].input.AuthParameters.USERNAME, f.config.username);
  assert.equal(JSON.stringify(await f.store.transaction(tx => tx.get('user#pinned-sub'))).includes('password'), false);
  await f.store.transaction(tx => tx.set(deployedAdminKey, { ...f.config, userId: 'another-sub' }));
  await assert.rejects(f.auth.login({ loginId: 'admin', password: 'correct-test-password' }));
});
test('email/name matches and client role fields cannot grant admin or switch ordinary roles', async () => {
  const f = await fixture();
  await f.store.transaction(tx => tx.set('workspace-signup#ordinary', { role: 'author' }));
  await f.auth.authenticate('ordinary');
  assert.equal((await f.auth.profile('ordinary', 'GET')).workspaceRole, 'author');
  assert.equal((await f.auth.profile('ordinary', 'GET')).isTestAdmin, undefined);
  await assert.rejects(f.auth.selectTestRole('ordinary', { role: 'reviewer' }), e => e.status === 403);
  await assert.rejects(f.auth.register({ email: 'a@b.com', name: 'admin', password: 'Secret123!', role: 'author', isTestAdmin: true }), e => e.status === 400);
  await assert.rejects(f.auth.login({ email: 'a@b.com', loginId: 'admin', password: 'x' }), e => e.status === 400);
  await assert.rejects(f.auth.login({ loginId: 'other', password: 'x' }), e => e.status === 401);
});
test('role persists across authentication; outside membership never expands deployed admin scope', async () => {
  const f = await fixture(); await f.auth.authenticate('pinned-sub');
  for (const role of ['author', 'reviewer', 'viewer']) {
    await f.auth.selectTestRole('pinned-sub', { role });
    await f.auth.authenticate('pinned-sub');
    const items = await f.workspaces.mine('pinned-sub');
    assert.deepEqual(items.map(w => [w.workspaceId, w.role]), [['qa', role]]);
    assert.equal((await f.store.transaction(tx => f.workspaces.access(tx, 'pinned-sub', 'qa'))).role, role);
    await assert.rejects(f.store.transaction(tx => f.workspaces.access(tx, 'pinned-sub', 'real')), e => e.status === 404);
  }
  await assert.rejects(f.workspaces.create('pinned-sub', { name: 'other' }), e => e.status === 403);
  await assert.rejects(f.workspaces.join('pinned-sub', { code: 'other' }), e => e.status === 403);
});
test('disabled or deleted config blocks existing tokens, role changes, HTTP scope and open realtime sessions', async () => {
  const f = await fixture(); await f.auth.authenticate('pinned-sub');
  const sent = [], closed = [];
  const realtime = new RealtimeService(f.store, clock, { websocketUrl: 'wss://example.test/live', send: async (id, payload) => sent.push(payload), close: async id => closed.push(id) });
  const ticket = await realtime.ticket('pinned-sub', 'qa', 'opaque-authenticated-token');
  await realtime.connect('open-tab', ticket.ticket);
  await f.store.transaction(tx => tx.set(deployedAdminKey, { ...f.config, enabled: false }));
  await assert.rejects(f.auth.authenticate('pinned-sub'), e => e.status === 401);
  await assert.rejects(f.auth.login({ loginId: 'admin', password: 'correct-test-password' }), e => e.status === 401);
  await assert.rejects(f.auth.selectTestRole('pinned-sub', { role: 'reviewer' }), e => e.status === 403);
  await assert.rejects(f.workspaces.mine('pinned-sub'), e => e.status === 403);
  await realtime.notifyUser('pinned-sub');
  assert.deepEqual(closed, ['open-tab']);
  assert.equal(sent.at(-1).type, 'access-revoked');
  await f.store.transaction(tx => tx.delete(deployedAdminKey));
  await assert.rejects(f.auth.authenticate('pinned-sub'), e => e.status === 401);
});
