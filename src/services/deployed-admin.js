import { fail } from '../domain.js';

// Operator-managed record. No HTTP endpoint may create or edit this configuration.
export const deployedAdminKey = 'deployment-admin#config';
export const adminRoles = ['author', 'reviewer', 'viewer'];
export const validAdminConfig = c => c?.enabled === true && c.version === 1 &&
  typeof c.userId === 'string' && !!c.userId && typeof c.username === 'string' && !!c.username &&
  Array.isArray(c.workspaceIds) && c.workspaceIds.length === 1 &&
  typeof c.workspaceIds[0] === 'string' && !!c.workspaceIds[0];

export async function requireDeployedAdmin(tx, user) {
  const config = await tx.get(deployedAdminKey);
  if (!user?.deployedTestAdmin || !validAdminConfig(config) || config.userId !== user.userId) {
    fail(403, '이 작업을 수행할 권한이 없습니다.');
  }
  if (!adminRoles.includes(user.qaRole)) fail(403, '사용 역할을 확인해 주세요.');
  // Always read the current scope, including for existing WebSocket connections.
  return { ...user, isTestAdmin: true, qaWorkspaceIds: [...config.workspaceIds], workspaceRole: undefined };
}
