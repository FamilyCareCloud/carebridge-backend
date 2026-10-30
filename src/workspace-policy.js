export function workspacePolicy(env = process.env) {
  return {
    multipleWorkspaces: false,
    confirmationEnabled: env.CAREBRIDGE_CONFIRMATION_ENABLED !== 'false',
    transferEnabled: env.CAREBRIDGE_TRANSFER_ENABLED !== 'false',
    recipientChange: 'block_all',
  };
}
