// Run by an AWS operator, never by Lambda or on server startup. No password argument.
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { createDynamoStore } from '../src/adapters/dynamodb.js';
import { WorkspaceService } from '../src/services/workspaces.js';
import { deployedAdminKey } from '../src/services/deployed-admin.js';

if (!process.env.COGNITO_USER_POOL_ID || !process.env.DYNAMODB_TABLE) throw new Error('Explicit COGNITO_USER_POOL_ID and DYNAMODB_TABLE are required');
const store = await createDynamoStore();
const clock = () => new Date().toISOString();
let config = await store.transaction(tx => tx.get(deployedAdminKey));
if (process.argv[2] === '--disable') {
  if (!config) throw new Error('No deployed account has been configured');
  await store.transaction(async tx => {
    const current = await tx.get(deployedAdminKey);
    current.enabled = false;
    await tx.set(deployedAdminKey, current);
    await tx.set(`realtime-revoke#${current.userId}`, { at: Date.now() });
  });
  console.log('Account access disabled; existing realtime connections will be revoked.');
  process.exit(0);
}
if (process.argv[2]) throw new Error('Only --disable is supported; no passwords on the command line');
const client = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION ?? 'ap-northeast-2' });
const UserPoolId = process.env.COGNITO_USER_POOL_ID;
if (!config) {
  const Username = 'carebridge-admin@qa.invalid';
  // SUPPRESS prevents email. Cognito generates an unusable-for-normal-login temporary
  // password; the operator separately chooses a permanent password in a private prompt.
  const created = await client.send(new AdminCreateUserCommand({ UserPoolId, Username, MessageAction: 'SUPPRESS', UserAttributes: [{ Name: 'email', Value: Username }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: '개발 담당자' }] }));
  const userId = created.User.Attributes.find(a => a.Name === 'sub')?.Value;
  if (!userId) throw new Error('Cognito returned no subject');
  config = { version: 1, enabled: false, username: Username, userId, workspaceIds: [] };
  await store.transaction(async tx => {
    if (await tx.get(deployedAdminKey)) throw new Error('Configuration already exists; inspect concurrent setup');
    await tx.set(deployedAdminKey, config);
  });
}
const identity = await client.send(new AdminGetUserCommand({ UserPoolId, Username: config.username }));
if (identity.UserAttributes.find(a => a.Name === 'sub')?.Value !== config.userId) throw new Error('Pinned Cognito identity mismatch');
const ownerId = `deployment-admin-owner-${config.userId}`;
await store.transaction(async tx => {
  if (!await tx.get(`user#${ownerId}`)) await tx.set(`user#${ownerId}`, { userId: ownerId, name: '테스트 그룹 담당자', email: 'workspace-owner@qa.invalid', workspaceRole: 'reviewer', role: 'reviewer', groupIds: [], createdAt: clock() });
});
// This synthetic owner has no Cognito identity and no password/session.
const slot = await store.transaction(tx => tx.get(`workspace-active#${ownerId}`));
const workspaceId = slot?.workspaceId ?? (await new WorkspaceService(store, clock, {}).create(ownerId, { name: 'CareBridge 개발 테스트' })).workspaceId;
await store.transaction(async tx => {
  const current = await tx.get(deployedAdminKey);
  if (current.userId !== config.userId) throw new Error('Configuration changed');
  const w = await tx.get(`workspace#${workspaceId}`);
  if (w?.ownerReviewerId !== ownerId || (current.workspaceIds.length && current.workspaceIds[0] !== workspaceId)) throw new Error('Refusing to grant access to another institution');
  w.qaRecipientIds = [...new Set([...(w.qaRecipientIds ?? []), config.userId])];
  await tx.set(`workspace#${workspaceId}`, w);
  const previous = await tx.get(`user#${config.userId}`);
  await tx.set(`user#${config.userId}`, { userId: config.userId, email: config.username, name: '개발 담당자', createdAt: previous?.createdAt ?? clock(), groupIds: [], isTestAdmin: true, deployedTestAdmin: true, qaRole: previous?.qaRole ?? 'reviewer', qaWorkspaceIds: [workspaceId] });
  await tx.set(deployedAdminKey, { ...current, enabled: true, workspaceIds: [workspaceId] });
});
console.log(JSON.stringify({ configured: true, workspaceId, passwordManagedBy: 'Cognito; set privately by operator' }));
