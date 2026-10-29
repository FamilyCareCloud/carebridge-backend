import { fields, email, text, fail, choice } from '../domain.js';
import { isDeepStrictEqual } from 'node:util';
import { UserRepository } from '../repositories/index.js';
import { publicUser } from '../services/auth.js';
import { validatePassword, authError, VerificationDelivery } from '../services/verification.js';
import { deployedAdminKey, validAdminConfig, requireDeployedAdmin, adminRoles } from '../services/deployed-admin.js';
const ERRORS = {
  NotAuthorizedException: [401, 'INVALID_CREDENTIALS', '이메일 또는 비밀번호가 올바르지 않거나 로그인이 만료되었습니다.'],
  UserNotFoundException: [404, 'ACCOUNT_NOT_FOUND', '가입된 계정을 찾을 수 없습니다.'],
  UsernameExistsException: [409, 'ACCOUNT_ALREADY_EXISTS', '이미 가입된 이메일입니다. 로그인해주세요.'],
  InvalidPasswordException: [400, 'PASSWORD_POLICY_VIOLATION', '비밀번호는 8자 이상이며 특수문자를 1개 이상 포함해야 합니다.'],
  InvalidParameterException: [400, 'AUTH_INVALID_PARAMETER', '인증 요청의 입력값을 확인해주세요.'],
  CodeMismatchException: [400, 'CONFIRMATION_CODE_MISMATCH', '인증코드가 일치하지 않습니다. 다시 확인해주세요.'],
  ExpiredCodeException: [400, 'CONFIRMATION_CODE_EXPIRED', '인증코드가 만료되었습니다. 새 코드를 요청해주세요.'],
  UserNotConfirmedException: [403, 'EMAIL_NOT_VERIFIED', '이메일 인증을 완료해주세요.'],
  CodeDeliveryFailureException: [502, 'CONFIRMATION_DELIVERY_FAILED', '인증메일 발송에 실패했습니다. 잠시 후 재전송해주세요.'],
  InvalidEmailRoleAccessPolicyException: [503, 'EMAIL_CONFIGURATION_ERROR', '메일 발송 설정 오류입니다. 관리자에게 문의해주세요.'],
  TooManyRequestsException: [429, 'AUTH_PROVIDER_THROTTLED', '인증 서비스 요청이 많습니다. 잠시 후 다시 시도해주세요.'],
  LimitExceededException: [429, 'AUTH_PROVIDER_LIMIT', '인증 서비스 발송 또는 시도 한도에 도달했습니다. 잠시 후 다시 시도해주세요.'],
  ForbiddenException: [403, 'AUTH_REQUEST_BLOCKED', '인증 요청이 보안 정책에 의해 차단되었습니다.']
};
export class CognitoAuthService {
  constructor({ store, clock, client, commands, clientId, userPoolId, logger = entry => console.warn(JSON.stringify(entry)) }) {
    Object.assign(this, { store, clock, client, commands, clientId, userPoolId, logger });
    this.delivery = new VerificationDelivery(store, clock);
  }
  async send(name, input) {
    try { return await this.client.send(new this.commands[name](input), { abortSignal: AbortSignal.timeout(15000) }); }
    catch (error) {
      this.logger({ event: 'cognito_error', operation: name, providerCode: error.name, requestId: error.$metadata?.requestId ?? null });
      const [status, code, message] = ERRORS[error.name] ?? [503, 'AUTH_SERVICE_UNAVAILABLE', '인증 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.'];
      throw authError(status, code, message);
    }
  }
  async account(address) {
    if (!this.userPoolId) throw authError(503, 'AUTH_CONFIGURATION_ERROR', '인증 서비스 설정을 확인해주세요.');
    try { return await this.send('AdminGetUserCommand', { UserPoolId: this.userPoolId, Username: address }); }
    catch (error) { if (error.code === 'ACCOUNT_NOT_FOUND') return null; throw error; }
  }
  async pending(address) {
    return { status: 'UNCONFIRMED', confirmationRequired: true, nextAction: 'CONFIRM_EMAIL', email: address, ...await this.delivery.info(address) };
  }
  async deliver(address, operation, input) {
    await this.delivery.reserve(address);
    try {
      const result = await this.send(operation, input);
      if (result.UserConfirmed === true) {
        await this.delivery.finish(address, 'not_required');
        return { userId: result.UserSub, status: 'CONFIRMED', confirmationRequired: false, deliveryStatus: 'not_required' };
      }
      const details = result.CodeDeliveryDetails;
      if (!details || details.DeliveryMedium !== 'EMAIL' || !details.Destination) throw authError(502, 'CONFIRMATION_DELIVERY_UNCONFIRMED', '인증메일 발송 접수 여부를 확인하지 못했습니다. 잠시 후 재전송해주세요.');
      const info = await this.delivery.finish(address, 'accepted');
      this.logger({ event: 'confirmation_delivery_accepted', operation, requestId: result.$metadata?.requestId ?? null });
      return { ...(result.UserSub ? { userId: result.UserSub } : {}), status: 'UNCONFIRMED', confirmationRequired: true, nextAction: 'CONFIRM_EMAIL', email: address, ...info, destination: details.Destination, deliveryMedium: 'EMAIL', message: '인증메일 발송 요청이 접수되었습니다. 메일함과 스팸함을 확인해주세요.' };
    } catch (error) {
      const info = await this.delivery.finish(address, 'failed');
      error.details = { ...error.details, ...info, confirmationRequired: true, nextAction: 'RESEND_CONFIRMATION', email: address };
      throw error;
    }
  }
  async register(body) {
    fields(body, ['name', 'email', 'password', 'role']);
    const workspaceRole = body.role === undefined ? null : choice(body.role, ['author', 'reviewer', 'viewer'], 'role');
    const address = email(body.email), name = text(body.name, 'name', 100);
    validatePassword(body.password);
    const existing = await this.account(address);
    if (existing) {
      if (existing.UserStatus === 'UNCONFIRMED' && existing.Enabled !== false) throw authError(409, 'EMAIL_NOT_VERIFIED', '가입된 계정의 이메일 인증을 이어서 진행해주세요.', await this.pending(address));
      throw authError(409, 'ACCOUNT_ALREADY_EXISTS', '이미 가입된 이메일입니다. 로그인해주세요.');
    }
    try {
      const result = await this.deliver(address, 'SignUpCommand', { ClientId: this.clientId, Username: address, Password: body.password, UserAttributes: [{ Name: 'name', Value: name }, { Name: 'email', Value: address }] });
      if (workspaceRole && result.userId) await this.store.transaction(tx => tx.set(`workspace-signup#${result.userId}`, { role: workspaceRole }));
      return result;
    } catch (error) {
      if (error.code === 'ACCOUNT_ALREADY_EXISTS') {
        const account = await this.account(address);
        if (account?.UserStatus === 'UNCONFIRMED' && account.Enabled !== false) throw authError(409, 'EMAIL_NOT_VERIFIED', '이메일 인증을 이어서 진행해주세요.', await this.pending(address));
      }
      throw error;
    }
  }
  async resend(body) {
    fields(body, ['email']); const address = email(body.email);
    const account = await this.account(address);
    if (!account) throw authError(404, 'ACCOUNT_NOT_FOUND', '가입된 계정을 찾을 수 없습니다.');
    if (account.Enabled === false) throw authError(403, 'ACCOUNT_DISABLED', '사용 중지된 계정입니다.');
    if (account.UserStatus !== 'UNCONFIRMED') throw authError(409, 'ACCOUNT_ALREADY_CONFIRMED', '이미 인증된 계정입니다. 로그인해주세요.');
    return this.deliver(address, 'ResendConfirmationCodeCommand', { ClientId: this.clientId, Username: address });
  }
  async confirm(body) {
    fields(body, ['email', 'code']);
    const address = email(body.email);
    if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) throw authError(400, 'CONFIRMATION_CODE_INVALID', '6자리 숫자 인증코드를 입력해주세요.');
    await this.send('ConfirmSignUpCommand', { ClientId: this.clientId, Username: address, ConfirmationCode: body.code });
    return { confirmed: true, status: 'CONFIRMED', nextAction: 'LOGIN' };
  }
  async login(body) {
    fields(body, ['email', 'loginId', 'password']);
    if (body.email !== undefined && body.loginId !== undefined) fail(400, '로그인 정보를 확인해 주세요.');
    let address, expectedAdminId;
    if (body.loginId !== undefined) {
      const config = await this.store.transaction(tx => tx.get(deployedAdminKey));
      if (body.loginId !== 'admin' || !validAdminConfig(config)) throw authError(401, 'INVALID_CREDENTIALS', '이메일 또는 비밀번호가 올바르지 않습니다.');
      address = config.username;
      expectedAdminId = config.userId;
    } else address = email(body.email);
    if (typeof body.password !== 'string' || body.password.length > 128 || !body.password.length) fail(400, '비밀번호가 필요합니다.');
    let response;
    try { response = await this.send('InitiateAuthCommand', { ClientId: this.clientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: address, PASSWORD: body.password } }); }
    catch (error) {
      if (error.code === 'EMAIL_NOT_VERIFIED') error.details = await this.pending(address);
      throw error;
    }
    if (!response.AuthenticationResult?.AccessToken) throw authError(401, 'ADDITIONAL_AUTH_REQUIRED', '추가 인증이 필요합니다.');
    const accessToken = response.AuthenticationResult.AccessToken;
    const userId = await this.authenticate(accessToken);
    if (expectedAdminId && userId !== expectedAdminId) throw authError(401, 'INVALID_CREDENTIALS', '이메일 또는 비밀번호가 올바르지 않습니다.');
    return { accessToken, tokenType: 'Bearer', expiresAt: new Date(Date.parse(this.clock()) + response.AuthenticationResult.ExpiresIn * 1000).toISOString(), user: await this.profile(userId, 'GET') };
  }
  async authenticate(token) {
    if (!token || token.length > 8192) fail(401, '로그인이 필요합니다.');
    const result = await this.send('GetUserCommand', { AccessToken: token });
    const attributes = Object.fromEntries(result.UserAttributes.map(a => [a.Name, a.Value]));
    if (!attributes.sub || attributes.email_verified !== 'true') fail(403, '이메일 인증이 필요합니다.', 'EMAIL_NOT_VERIFIED');
    await this.store.transaction(async tx => {
      const repo = new UserRepository(tx), existing = await repo.findById(attributes.sub);
      const config = await tx.get(deployedAdminKey);
      if ((existing?.deployedTestAdmin || existing?.isTestAdmin) && (!validAdminConfig(config) || config.userId !== attributes.sub)) fail(401, '로그인이 필요합니다.');
      if (validAdminConfig(config) && config.userId === attributes.sub) {
        const user = { userId: attributes.sub, email: attributes.email.toLowerCase(), name: attributes.name ?? '개발 담당자', createdAt: existing?.createdAt ?? this.clock(), groupIds: [], isTestAdmin: true, deployedTestAdmin: true, qaRole: adminRoles.includes(existing?.qaRole) ? existing.qaRole : 'reviewer', qaWorkspaceIds: [...config.workspaceIds] };
        if (!isDeepStrictEqual(existing, user)) await repo.save(user);
      } else if (!existing) {
        const signup = await tx.get(`workspace-signup#${attributes.sub}`);
        await repo.save({ userId: attributes.sub, email: attributes.email.toLowerCase(), name: attributes.name ?? attributes.email, role: signup?.role ?? 'caregiver', ...(signup ? { workspaceRole: signup.role } : {}), createdAt: this.clock(), groupIds: [] });
      }
    });
    return attributes.sub;
  }
  async selectTestRole(userId, body) {
    fields(body, ['role']); const role = choice(body.role, adminRoles, 'role');
    return this.store.transaction(async tx => {
      const stored = await tx.get(`user#${userId}`);
      const user = await requireDeployedAdmin(tx, stored);
      delete user.workspaceRole;
      user.qaRole = role;
      await tx.set(`user#${userId}`, user);
      return publicUser(user);
    });
  }
  async logout(token) { await this.send('GlobalSignOutCommand', { AccessToken: token }); return { loggedOut: true }; }
  async profile(userId, method, body, token) {
    if (method === 'PATCH') {
      fields(body, ['name']);
      await this.send('UpdateUserAttributesCommand', { AccessToken: token, UserAttributes: [{ Name: 'name', Value: text(body.name, 'name', 100) }] });
    }
    return this.store.transaction(async tx => {
      const repo = new UserRepository(tx), user = await repo.findById(userId);
      if (!user) fail(401, '사용자를 찾을 수 없습니다.');
      if (method === 'PATCH') { user.name = text(body.name, 'name', 100); await repo.save(user); }
      return publicUser(user);
    });
  }
}
export async function createCognitoAuth(store, clock, env = process.env) {
  if (!env.COGNITO_CLIENT_ID || !env.COGNITO_USER_POOL_ID) throw new Error('COGNITO_CLIENT_ID and COGNITO_USER_POOL_ID are required');
  const commands = await import('@aws-sdk/client-cognito-identity-provider');
  return new CognitoAuthService({ store, clock, client: new commands.CognitoIdentityProviderClient({ region: env.AWS_REGION ?? 'ap-northeast-2', maxAttempts: 1 }), commands, clientId: env.COGNITO_CLIENT_ID, userPoolId: env.COGNITO_USER_POOL_ID });
}
