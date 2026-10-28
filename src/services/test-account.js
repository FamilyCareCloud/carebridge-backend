import { randomBytes } from 'node:crypto';
import { TestAuthService } from './test-auth.js';
import { WorkspaceService } from './workspaces.js';
import { validatePassword } from './verification.js';

export const testAccount = { loginId: 'admin' };

export async function prepareTestAccount(store, clock, env = process.env) {
  const enabled = env.CAREBRIDGE_TEST_ADMIN_ENABLED === 'true';
  if (enabled && env.NODE_ENV === 'production') throw new Error('Test accounts are local-only');
  const auth = new TestAuthService(store, clock, { enabled });
  if (!enabled) return auth;
  validatePassword(env.CAREBRIDGE_TEST_ADMIN_PASSWORD);
  let workspaceIds = (env.CAREBRIDGE_QA_WORKSPACE_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean);
  if (!workspaceIds.length) {
    const saved = await store.transaction(tx => tx.get('test-qa-workspace'));
    if (saved) workspaceIds = [saved.workspaceId];
    else {
      const owner = await auth.register({ email: `qa-owner-${randomBytes(8).toString('hex')}@example.invalid`, name: '로컬 QA 담당자', password: randomBytes(24).toString('base64url') + '!7', role: 'reviewer' });
      const workspace = await new WorkspaceService(store, clock, {}).create(owner.userId, { name: 'CareBridge 로컬 QA' });
      await store.transaction(tx => tx.set('test-qa-workspace', { workspaceId: workspace.workspaceId }));
      workspaceIds = [workspace.workspaceId];
    }
  }
  await auth.provision(env.CAREBRIDGE_TEST_ADMIN_PASSWORD, workspaceIds);
  return auth;
}
