# 회원가입·이메일 인증 API 계약

이번 변경을 Lambda와 Cognito User Pool에 함께 배포해야 합니다. 로컬 테스트 통과가 실제 이메일 배달 성공을 의미하지는 않습니다.

## 비밀번호

8자 이상, 특수문자 최소 1개. 대문자·소문자·숫자는 필수가 아닙니다. 공백은 허용하지 않습니다. 특수문자는 ASCII 문장부호(예: ! @ # $ % ^ & * _ - + =)입니다. 정확한 프론트 검사 예:

```js
const validPassword = value => typeof value === 'string'
  && value.length >= 8 && value.length <= 128
  && !/\s/.test(value)
  && /[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/.test(value);
```

예: `abcdefg!`, `1234567!`, `ABCDEFG!` 허용. 로그인에는 새 비밀번호 정책을 다시 적용하지 않으므로 기존 비밀번호로 로그인할 수 있습니다.

## 요청

인증 토큰 없이 POST, Content-Type: application/json:

| 경로 | 본문 | 성공 |
|---|---|---|
| /auth/register | `{ "email":"user@example.com", "name":"사용자", "password":"abcdefg!" }` | 201, 인증 대기 및 발송 접수 정보 |
| /auth/login | `{ "email":"user@example.com", "password":"abcdefg!" }` | 200, 기존 accessToken 응답 |
| /auth/confirm | `{ "email":"user@example.com", "code":"123456" }` | 200, confirmed:true, status:CONFIRMED, nextAction:LOGIN |
| /auth/resend-confirmation | `{ "email":"user@example.com" }` | 200, 인증 대기 및 발송 접수 정보 |

가입/재전송의 일반 성공 응답:

```json
{
  "status": "UNCONFIRMED",
  "confirmationRequired": true,
  "nextAction": "CONFIRM_EMAIL",
  "email": "user@example.com",
  "deliveryStatus": "accepted",
  "destination": "u***@e***.com",
  "deliveryMedium": "EMAIL",
  "codeValiditySeconds": 86400,
  "codeExpiresAt": "2026-09-21T00:00:00.000Z",
  "resendCooldownSeconds": 60,
  "resendLimit": 5,
  "resendWindowSeconds": 3600,
  "remainingAttempts": 4,
  "retryAfterSeconds": 60,
  "resendAvailableAt": "2026-09-20T00:01:00.000Z",
  "message": "인증메일 발송 요청이 접수되었습니다. 메일함과 스팸함을 확인해주세요."
}
```

신규 가입 응답은 userId도 포함합니다. Cognito가 자동 확인한 계정은 status:CONFIRMED, confirmationRequired:false, deliveryStatus:not_required이며 발송 안내를 띄우지 않습니다. 로컬 개발 인증은 이메일을 발송하지 않으며 기존 가입 응답을 유지합니다. 로컬 재전송은 EMAIL_VERIFICATION_NOT_SUPPORTED로 거절합니다.

## 미인증 계정 복귀

- 재가입: 409 EMAIL_NOT_VERIFIED. 기존 비밀번호나 이름을 변경하지 않고 인증 화면으로 연결합니다.
- 로그인: Cognito UserNotConfirmedException일 때 403 EMAIL_NOT_VERIFIED.
- 위 두 경로는 메일을 자동으로 다시 보내지 않습니다. 재전송 버튼을 눌러 별도 API를 호출하세요.
- 오류의 details에 status:UNCONFIRMED, confirmationRequired:true, nextAction:CONFIRM_EMAIL, email 및 재전송 제한 정보가 들어갑니다.
- status는 인증 완료 증거가 아닙니다. ConfirmSignUp이 성공하기 전에는 로그인을 허용하지 않습니다. 자격 증명이 잘못되어 Cognito가 INVALID_CREDENTIALS를 반환하면 인증 대기로 임의 전환하지 않습니다.

## 오류 응답과 UI 처리

오류는 `{ "error":"한국어 안내", "code":"안정적인 코드", "details":{...} }`입니다. details는 관련 정보가 있는 오류에서만 포함합니다. 프론트는 error 문구를 비교하지 말고 code로 분기하세요.

| HTTP | code | 프론트 처리 |
|---|---|---|
| 400 | PASSWORD_POLICY_VIOLATION | 비밀번호 조건 안내 |
| 400 | CONFIRMATION_CODE_INVALID | 6자리 숫자 입력 안내 |
| 400 | CONFIRMATION_CODE_MISMATCH | 코드 불일치 안내, 재입력 |
| 400 | CONFIRMATION_CODE_EXPIRED | 만료 안내, 재전송 버튼 |
| 403/409 | EMAIL_NOT_VERIFIED | 입력한 이메일로 인증 화면 이동 |
| 401 | INVALID_CREDENTIALS | 이메일·비밀번호 또는 만료 토큰 확인 |
| 401 | ADDITIONAL_AUTH_REQUIRED | 추가 인증 필요 안내 |
| 409 | ACCOUNT_ALREADY_EXISTS | 로그인 화면 안내 |
| 409 | ACCOUNT_ALREADY_CONFIRMED | 이미 인증됨, 로그인 화면 안내 |
| 404 | ACCOUNT_NOT_FOUND | 가입 화면 안내 |
| 403 | ACCOUNT_DISABLED | 사용 중지 안내 |
| 429 | CONFIRMATION_COOLDOWN | details.retryAfterSeconds 동안 재전송 비활성화 |
| 429 | CONFIRMATION_SEND_LIMIT | details.resendAvailableAt까지 제한 |
| 429 | AUTH_PROVIDER_THROTTLED | AWS 요청 제한 안내 |
| 429 | AUTH_PROVIDER_LIMIT | AWS 시도/발송 한도 안내 |
| 502 | CONFIRMATION_DELIVERY_FAILED | 발송 실패 안내, 성공 문구 금지 |
| 502 | CONFIRMATION_DELIVERY_UNCONFIRMED | 접수 확인 불가 안내, 성공 문구 금지 |
| 503 | EMAIL_CONFIGURATION_ERROR | 관리자 문의 안내 |
| 503 | AUTH_CONFIGURATION_ERROR | 풀 ID 등 서버 구성 확인 |
| 503 | AUTH_SERVICE_UNAVAILABLE | 서비스 연결 실패, 나중에 재시도 |
| 403 | AUTH_REQUEST_BLOCKED | AWS 보안 정책 차단 |
| 400 | AUTH_INVALID_PARAMETER | 기타 인증 입력 오류 |
| 400 | EMAIL_VERIFICATION_NOT_SUPPORTED | 로컬 개발 모드는 메일 미지원 |

발송 오류에는 details.deliveryStatus:failed와 재시도 정보가 포함됩니다. 통신 불확실성 때문에 계정이 실제 생성됐을 수 있으므로 실패했다고 계정이 없다고 가정하지 마세요. 재가입 또는 재전송으로 복구할 수 있습니다. 발송을 시도하지 못한 상태 조회 오류에는 details가 없을 수 있습니다.

## 코드 유효시간·재전송 기준

- Cognito 가입 확인 코드는 **24시간** 유효합니다. 자체 3분/5분 만료를 추가하지 않았습니다.
- codeExpiresAt은 서버가 발송 접수 응답을 받은 시각을 기준으로 계산한 표시용 예상 시각입니다. 최종 만료 판정은 Cognito가 수행합니다. 기존 요청 기록이 없으면 null입니다.
- 이메일 정규화(소문자) 후 SHA-256 키로 제한을 저장합니다. Lambda 인스턴스가 달라도 DynamoDB를 통해 공유합니다.
- **최초 가입 발송도 포함해 최근 1시간 최대 5회 요청**, 각 요청 사이 60초 대기입니다. 실패 요청도 포함합니다. 공급자 호출 전에 횟수를 예약합니다.
- 재가입/로그인으로 인증 상태만 확인하는 요청은 발송 횟수를 소모하지 않습니다.
- 429에서 재시도 정보가 있으면 HTTP Retry-After도 제공합니다. 프론트는 details 값을 사용해 카운트다운할 수 있습니다.
- AWS 자체 제한은 별도입니다. resendAvailableAt은 앱 제한상 가장 빠른 시각이며 AWS 한도 해제를 보장하지 않습니다.
- DynamoDB에서 동시에 횟수를 예약하면 한 요청만 성공하고 나머지는 409 CONCURRENT_UPDATE 또는 재조회 시 429로 거절됩니다. 409는 성공 안내 없이 짧게 기다린 뒤 재시도하세요.

## 발송 진단

성공 응답의 accepted는 Cognito CodeDeliveryDetails를 확인했다는 뜻이며 수신함 도착 확인이 아닙니다. 가짜 성공 응답을 방지하기 위해 재전송 전 실제 계정 상태를 AdminGetUser로 확인합니다. Cognito는 사용자 존재 은닉 설정에서 없는 사용자에게도 유사한 발송 응답을 반환할 수 있습니다.

서버 로그는 `cognito_error`(operation/providerCode/requestId), `confirmation_delivery_accepted`를 남깁니다. 세션 오류에는 `reason` 열거값(expired/revoked/invalid/refresh_rejected/credentials_rejected)만 추가합니다. 이메일·비밀번호·인증코드·토큰·원문 오류 메시지는 로그에 넣지 않습니다. 발송 요청의 SDK 자동 재시도는 꺼 두어 의도하지 않은 중복 발송을 피합니다.

`POST /auth/login`은 Cognito의 `refreshToken`과 `expiresAt`도 반환합니다. `POST /auth/refresh`에 `{refreshToken}`을 전송하면 `REFRESH_TOKEN_AUTH`로 갱신하고, 새 access token도 GetUser로 확인한 뒤 동일한 세션 응답을 반환합니다. 만료된 access token을 요구하지 않는 공개 인증 경로이며, refresh credential 자체로 Cognito가 인증합니다. 로컬 비밀번호 인증 환경에는 이 기능이 없습니다.

GetUser가 거절하면 `SESSION_EXPIRED`, `SESSION_REVOKED`, `SESSION_INVALID`(각 401)로 구분합니다. 비밀번호 로그인 실패는 기존 `INVALID_CREDENTIALS`를 유지합니다. 프론트는 세션 정보를 메모리에만 보관하고 30초 이내 만료 예정이면 한 번 갱신합니다. 동시에 들어온 요청은 같은 갱신을 기다립니다. 명시적 SESSION_EXPIRED만 한 차례 재시도하며, 폐기·권한 거절·네트워크 실패를 재전송하지 않습니다. 로그아웃은 진행 중인 갱신을 끝낸 뒤 GlobalSignOut으로 새 토큰까지 폐기합니다. 기존 계정·기관·역할 검증과 실시간 접근 확인은 유지됩니다.

현재 SAM 클라이언트는 refresh token 1일, access token 1시간이며 refresh token rotation 없이 ALLOW_REFRESH_TOKEN_AUTH를 허용합니다. Rotation을 도입할 때는 [AWS 공식 갱신 안내](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-refresh-token.html)에 따라 API도 변경해야 합니다. 갱신은 원래 refresh token의 유효기간을 연장하지 않습니다.

읽기 전용 구성 확인:

```powershell
$env:AWS_REGION = 'ap-northeast-2'
$env:COGNITO_USER_POOL_ID = '<배포된 풀 ID>'
node scripts/check-auth-config.js
```

이 스크립트는 DescribeUserPool 권한이 있는 운영자 계정으로 실행합니다. 앱 역할에는 이 진단용 권한을 추가하지 않았습니다. 실제 운영에서는 다음을 확인하세요.

1. 스크립트 출력의 비밀번호 정책이 새 정책과 같은지, email 자동 검증인지 확인합니다.
2. CloudWatch에서 위 오류 로그와 AWS requestId를 확인합니다.
3. COGNITO_DEFAULT 발송 한도, 또는 SES 사용 시 리전·발신자 검증·샌드박스·발송 한도·반송/차단 목록을 확인합니다.
4. SES 이벤트 구성이 있으면 배달/반송 이벤트를 확인하고 실제 수신함·스팸함을 점검합니다. API 200만으로 배달 완료라고 표시하지 않습니다.

현재 작업에서는 실제 AWS 계정 발송 로그나 SES 배달 결과를 확인하지 않았습니다. 운영 원인을 확정한 상태는 아닙니다.

## 배포 변경

SAM 템플릿에 MinimumLength:8, RequireSymbols:true, 나머지 조합 false를 반영했습니다. Lambda에 COGNITO_USER_POOL_ID와 해당 풀의 cognito-idp:AdminGetUser 권한이 추가됩니다. 백엔드만 배포하면 기존 풀의 정책이 남을 수 있으므로 스택을 함께 업데이트하세요.

참고: [Cognito 가입 및 확인, 24시간 유효기간](https://docs.aws.amazon.com/cognito/latest/developerguide/signing-up-users-in-your-app.html), [재전송 API와 발송 오류](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_ResendConfirmationCode.html), [존재 은닉과 모의 발송 응답](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pool-managing-errors.html).
