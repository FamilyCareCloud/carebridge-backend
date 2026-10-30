import test from 'node:test';
import assert from 'node:assert/strict';
import * as commands from '@aws-sdk/client-cognito-identity-provider';
import { CognitoAuthService } from '../src/adapters/cognito.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';

function fixture(reject) {
  const calls = [], logs = [];
  const auth = new CognitoAuthService({ store: new Store(), clock: () => '2026-10-29T00:00:00Z', commands, clientId: 'client', logger: e => logs.push(e), client: { send: async command => {
    calls.push(command);
    if (reject) throw Object.assign(new Error(reject.message), { name: reject.name ?? 'NotAuthorizedException' });
    if (command instanceof commands.InitiateAuthCommand) return { AuthenticationResult: { AccessToken: 'fresh-access', ExpiresIn: 3600, ...(command.input.AuthFlow === 'USER_PASSWORD_AUTH' ? { RefreshToken: 'private-refresh' } : {}) } };
    if (command instanceof commands.GetUserCommand) return { UserAttributes: [{ Name: 'sub', Value: 'u' }, { Name: 'email', Value: 'u@example.test' }, { Name: 'email_verified', Value: 'true' }] };
    return {};
  } } });
  return { auth, calls, logs };
}

test('login returns provider refresh token, refresh verifies fresh access with GetUser', async () => {
  const { auth, calls } = fixture();
  const login = await auth.login({ email: 'u@example.test', password: 'private-password' });
  assert.equal(login.refreshToken, 'private-refresh');
  const refreshed = await auth.refresh({ refreshToken: login.refreshToken });
  assert.equal(refreshed.user.userId, 'u');
  assert.equal(refreshed.expiresAt, '2026-10-29T01:00:00.000Z');
  assert.deepEqual(calls.at(-2).input, { ClientId: 'client', AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: 'private-refresh' } });
  assert.ok(calls.at(-1) instanceof commands.GetUserCommand);
  assert.equal('refreshToken' in refreshed, false);
});

test('refresh route accepts refresh credential without requiring the expired access token', async () => {
  const { auth } = fixture();
  const app = createApp(new Store(), { auth });
  const response = await app({ method: 'POST', path: '/auth/refresh', body: { refreshToken: 'private-refresh' } });
  assert.equal(response.status, 200);
  assert.equal(response.body.accessToken, 'fresh-access');
  for (const body of [{}, { refreshToken: '' }, { refreshToken: 'x'.repeat(16385) }, { refreshToken: 'x', userId: 'other' }]) {
    assert.equal((await app({ method: 'POST', path: '/auth/refresh', body })).status, 400);
  }
});

for (const [message, code, reason] of [
  ['Access Token has expired', 'SESSION_EXPIRED', 'expired'],
  ['Access Token has been revoked', 'SESSION_REVOKED', 'revoked'],
  ['Invalid Access Token', 'SESSION_INVALID', 'invalid']
]) test(`GetUser distinguishes ${reason} without logging secrets or raw provider messages`, async () => {
  const { auth, logs } = fixture({ message });
  await assert.rejects(auth.authenticate('private-access'), e => e.status === 401 && e.code === code);
  assert.equal(logs[0].reason, reason);
  assert.ok(!JSON.stringify(logs).includes(message));
  assert.ok(!JSON.stringify(logs).includes('private-access'));
});

test('revoked refresh is rejected; password failures remain INVALID_CREDENTIALS', async () => {
  const { auth, logs } = fixture({ message: 'Refresh Token has been revoked' });
  await assert.rejects(auth.refresh({ refreshToken: 'private-refresh' }), e => e.code === 'SESSION_INVALID');
  await assert.rejects(auth.login({ email: 'u@example.test', password: 'private-password' }), e => e.code === 'INVALID_CREDENTIALS');
  assert.deepEqual(logs.map(e => e.reason), ['refresh_rejected', 'credentials_rejected']);
  assert.ok(!JSON.stringify(logs).includes('private-'));
});
