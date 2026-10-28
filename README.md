# CareBridge backend

CareBridge 기능의 구현 기준 브랜치는 `develop`입니다.
[사실 누락 검사·승인 검증·이관 후 실행 안내](docs/FIDELITY_V2.md)를 참고하세요.

2026-09-10 설계서 v1.00의 보호자 중심 MVP 백엔드입니다. 가입 → 그룹 생성 → 고령자 등록 → 가족 초대/참여 → 기록 작성 → 일정 관리 → 교대/인수인계 → 인수 확인 흐름을 제공합니다.

## 백엔드 구현 개요

백엔드는 가족 구성원이 고령자의 돌봄 기록과 일정을 공유하고, 보호자가 교대할 때 이전 돌봄 상황을 이어받을 수 있도록 API와 데이터 관리 기능을 제공합니다. 이 절에서는 모델 학습, 음성 인식, 요약 생성 알고리즘을 제외한 백엔드 구현을 설명합니다. 인수인계 기능은 결과 저장·조회·확인과 교대 상태 관리에 초점을 맞춥니다.

주요 사용자 흐름은 회원가입·로그인, 가족 그룹 생성, 고령자 등록, 가족 초대·참여, 돌봄 기록 작성, 일정 관리, 담당 보호자 교대, 인수인계 확인 순서입니다.

### 기술 구성

| 구분 | 사용 기술 및 역할 |
|---|---|
| 언어·실행 환경 | JavaScript ES Modules, Node.js 22 이상 |
| API | Node.js HTTP 서버, REST 방식의 JSON 요청·응답 |
| 클라우드 요청 처리 | API Gateway HTTP API, AWS Lambda 핸들러 |
| 인증 | 로컬 계정·세션 인증, AWS Cognito 어댑터 |
| 인증메일 | Cognito 이메일 인증, SES 연동 시 HTML 메일·발신자 이름 설정 |
| 저장소 | 로컬 JSON 파일, AWS DynamoDB 어댑터 |
| 인프라 정의 | AWS SAM / CloudFormation 템플릿 |
| 테스트 | Node.js 기본 테스트 러너 `node:test`, `node:assert/strict` |

### 패키지 구조

별도 웹 프레임워크 없이 요청 처리, 업무 로직, 데이터 접근, 외부 서비스 연결을 디렉터리별로 분리했습니다. 아래 트리는 AI 관련 모듈을 생략한 백엔드 주요 구조입니다.

```text
fcc-backend/
├── src/
│   ├── server.js                 # 로컬 서버 시작 및 의존성 구성
│   ├── app.js                    # API 라우팅·인증 진입·공통 오류 응답
│   ├── domain.js                 # 입력값·날짜·유형 검증, 공통 오류 정의
│   ├── store.js                  # 로컬 트랜잭션과 JSON 파일 저장
│   ├── handlers/
│   │   ├── http.js               # HTTP 요청/응답 변환
│   │   └── lambda.js             # API Gateway 이벤트/Lambda 응답 변환
│   ├── services/
│   │   ├── auth.js               # 로컬 가입·로그인·세션·프로필
│   │   ├── verification.js       # 비밀번호 정책·인증메일 재전송 제한
│   │   ├── groups.js             # 가족 그룹·초대·고령자·담당자 관리
│   │   ├── care.js               # 돌봄 기록과 일정 관리
│   │   ├── handoff.js            # 교대·인수인계 결과와 확인 이력 관리
│   │   └── approvals.js          # 일정 변경 요청·승인·거절
│   ├── repositories/
│   │   └── index.js              # 도메인별 데이터 접근 객체
│   └── adapters/
│       ├── cognito.js            # Cognito 인증·이메일 확인 API 연결
│       └── dynamodb.js           # DynamoDB 조회·조건부 트랜잭션 저장
├── infra/
│   └── template.yaml            # DB·인증·API·Lambda 리소스 정의
├── scripts/
│   └── check-auth-config.js      # Cognito 설정 읽기 전용 진단
├── tests/
│   ├── app.test.js               # 도메인 흐름·HTTP 통합 테스트
│   ├── adapters.test.js          # 외부 서비스 어댑터 모의 테스트
│   └── auth-verification.test.js # 가입 정책·인증 재개·재전송 테스트
└── docs/                         # 설계·API·DB·인증 계약 문서
```

### 계층별 역할과 요청 처리

| 계층 | 담당 역할 |
|---|---|
| Handler | 요청 본문과 Bearer 토큰을 읽고 애플리케이션에 전달합니다. 처리 결과를 HTTP 상태 코드와 JSON으로 변환합니다. |
| Application | `app.js`에서 요청 경로와 메서드에 맞는 서비스를 선택하고 인증을 수행합니다. 예외를 공통 오류 응답으로 변환합니다. |
| Service | 그룹 가입 여부, 작성자 권한, 담당 보호자, 일정 상태 등 도메인 규칙을 검사하고 변경을 수행합니다. |
| Repository | 사용자·그룹·기록·일정·인수인계 등 도메인별 조회와 저장 동작을 제공합니다. |
| Store / Adapter | 실제 데이터를 파일이나 DynamoDB에 반영하고, 관련 변경을 하나의 트랜잭션으로 처리합니다. |

예를 들어 `POST /groups/{groupId}/events`로 식사 기록을 작성하면, 다음 과정으로 처리합니다.

1. Handler가 JSON과 인증 토큰을 읽습니다.
2. 애플리케이션이 사용자를 인증하고 `CareEventService`로 요청을 전달합니다.
3. 서비스가 해당 그룹의 보호자인지, 고령자가 등록되어 있는지 확인합니다.
4. 내용·유형·발생 시간을 검증하고 서버가 작성자와 ID를 지정합니다.
5. Repository가 그룹에 기록을 추가하고 저장소가 변경을 반영합니다.
6. 생성된 기록과 `201 Created`를 반환합니다.

### 도메인별 기능

#### 회원·인증

담당 파일: [auth.js](src/services/auth.js), [cognito.js](src/adapters/cognito.js), [verification.js](src/services/verification.js)

- 회원가입·로그인·로그아웃과 내 프로필 조회·이름 수정을 제공합니다.
- 로컬 비밀번호는 무작위 salt와 scrypt 해시로 저장하며 원문을 보관하지 않습니다.
- 로컬 로그인 토큰도 해시로 저장합니다. 세션은 8시간 후 만료되며 로그아웃 시 해당 세션을 폐기합니다.
- AWS 인증에서는 Cognito의 가입·이메일 코드 확인·로그인·GetUser 토큰 검증·GlobalSignOut을 사용합니다. Cognito 로그아웃은 전체 세션에 적용됩니다.
- 가입 비밀번호는 공백 없이 8자 이상, 특수문자 1개 이상입니다. 대문자·소문자·숫자의 포함은 필수가 아닙니다. 사용자 안내와 오류 문구에는 최소 길이만 표시하며, 최대 입력 길이는 안내하지 않습니다. 서버 내부의 최대 길이 검증은 유지합니다.
- 미인증 사용자가 가입 또는 로그인을 다시 시도하면 `EMAIL_NOT_VERIFIED`와 인증 재개 정보를 반환합니다.
- 인증메일 요청은 이메일별로 60초 대기, 최근 1시간 최대 5회로 제한합니다. 최초 발송과 실패 요청도 횟수에 포함합니다.
- 비밀번호 조건 위반, 코드 불일치·만료, 발송 실패·한도 초과를 각각 다른 오류 코드로 구분합니다.

Cognito 가입 인증코드는 24시간 유효합니다. 발송 응답의 `accepted`는 공급자가 요청을 접수했다는 뜻이며 실제 수신함 도착을 보장하지 않습니다. 로컬 인증에서는 이메일을 발송하지 않습니다. 세부 계약은 [AUTH_API.md](docs/AUTH_API.md)를 참고하세요.

#### 가족 그룹·고령자

담당 파일: [groups.js](src/services/groups.js)

- Care Group을 생성하고 사용자가 참여한 그룹 목록을 조회합니다.
- 그룹당 고령자 한 명을 연결하고 이름·생년월일·기본 특이사항을 등록·수정합니다.
- 그룹 소유자가 대상 이메일과 역할을 지정해 48시간 유효한 6자리 숫자 일회용 초대 코드를 생성합니다.
- 초대 이메일과 로그인 계정의 이메일이 일치해야 참여할 수 있습니다. 초대 코드는 사용자가 공유하며 자동 초대메일 발송 기능은 없습니다.
- 코드는 `012345`처럼 선행 0을 포함할 수 있으므로 문자열로 전달합니다. 생성 응답의 `code`와 호환용 `token`은 같은 값이며, 수락 요청은 `{ "code": "012345" }` 형식입니다. 기존 긴 초대 토큰도 `token` 필드로 만료 전까지 사용할 수 있습니다.
- 초대 수락은 로그인 사용자당 최근 15분 동안 최대 5회로 제한하며 성공·실패 모두 횟수에 포함합니다. 초과 시 `429 INVITATION_ATTEMPT_LIMIT`와 `details.retryAfterSeconds`, `details.retryAvailableAt`를 반환합니다.
- 구성원 조회, 소유권 이전, 그룹 탈퇴를 지원합니다.
- 현재/다음 담당자이거나 예정 일정에 배정된 구성원은 배정을 먼저 변경해야 탈퇴할 수 있습니다. 소유자는 소유권 이전 후 탈퇴할 수 있습니다.

역할은 `owner`, `caregiver`, `elder`로 구분합니다. 그룹 소유자가 초대와 소유권을 관리하고, 보호자가 돌봄 기록·일정을 작성합니다. 현재 담당자만 교대와 승인 처리를 수행합니다.

#### 돌봄 기록·Care Timeline

담당 파일: [care.js](src/services/care.js)의 `CareEventService`

- 병원·복약·식사·생활·일정·특이사항 기록을 작성하고 상세 조회·수정·삭제합니다.
- 발생 시간순으로 정렬하며 기간과 유형으로 필터링할 수 있습니다.
- 실제 발생 시각인 `timestamp`와 시스템 등록 시각인 `createdAt`을 별도로 저장합니다.
- 작성자 ID는 요청 본문이 아닌 인증된 사용자 정보로 지정합니다.
- 기록 작성자만 수정·삭제할 수 있으며 시스템이 생성한 변경 이력은 직접 수정하거나 삭제할 수 없습니다.
- 빈 내용, 지원하지 않는 유형, 잘못된 날짜와 미래 발생 시간을 거절합니다.
- 수정 요청에 `version`을 전달하면 조회 이후 다른 변경이 있었는지 검사합니다.

#### 일정

담당 파일: [care.js](src/services/care.js)의 `ScheduleService`

- 병원·검사·방문·돌봄센터·복약·기타 일정의 등록·조회·수정·삭제를 지원합니다.
- 제목, 예정 시간, 담당 보호자와 `scheduled / completed / cancelled` 상태를 관리합니다.
- 보호자는 일반 일정을 직접 완료·취소할 수 있습니다. 별도 승인 요청은 확장 흐름입니다.
- 취소된 일정은 목록에 남습니다. 삭제는 `deletedAt`을 기록하는 소프트 삭제이며 일반 조회에서 제외합니다.
- 일정 삭제 시 관련 대기 승인 요청을 종료합니다.
- `view=today`는 한국 시간 기준 당일 일정, `view=next`는 현재 이후 가장 가까운 예정 일정 한 건을 반환합니다.
- 담당자는 같은 그룹의 보호자 중에서 선택하며, 선택적 `version` 필드로 오래된 수정 요청을 거절할 수 있습니다.

#### 보호자 교대·인수인계 상태 관리

담당 파일: [handoff.js](src/services/handoff.js), [groups.js](src/services/groups.js)

- 현재 담당자와 다음 담당자를 지정하고 교대 시작·종료 시각을 이력으로 관리합니다.
- 다른 그룹의 사용자나 고령자 역할을 담당 보호자로 지정할 수 없습니다.
- 교대 시 담당자 변경, 교대 이력, 인수인계 결과 저장을 하나의 흐름으로 처리합니다.
- 선택 기간에 돌봄 기록이 없으면 인수인계를 생성하지 않고 담당자만 변경합니다.
- 인수인계 생성 과정에서 오류가 발생하면 교대를 반영하지 않고 기존 담당자와 기록을 유지합니다.
- 생성 결과의 상세·최신·이력 조회를 지원하며 재생성은 기존 결과를 덮어쓰지 않고 새 이력으로 저장합니다.
- 생성 당시 원문과 일정 스냅샷을 보존합니다. 이후 원문을 수정·삭제해도 과거 인수인계 근거는 남습니다.
- 지정된 인수 보호자가 확인하면 확인자와 시각을 저장하고 중복 확인은 한 번만 기록합니다.

이 부분은 인수인계 결과의 생명주기와 교대 업무를 관리하는 백엔드 기능입니다. 실제 요약 생성 방식은 별도 모듈의 책임입니다.

#### 중요 요청·승인

담당 파일: [approvals.js](src/services/approvals.js)

- 일정 취소·시간 변경 요청을 생성하고 `pending / approved / rejected` 상태로 관리합니다.
- 요청을 만들 때 일정을 즉시 변경하지 않고 현재 담당 보호자의 판단을 기다립니다.
- 승인 시에만 일정에 변경을 반영하며 거절 시 기존 일정을 유지합니다.
- 동일 일정의 중복 대기 요청과 이미 처리한 요청의 재승인을 거절합니다.
- 요청 이후 일정 버전이나 상태가 달라지면 승인을 차단합니다.
- 교대 시 대기 요청을 새로운 담당 보호자에게 이관합니다.
- `call` 처리는 연락 필요 시각을 남기는 기능이며 전화·메시지를 실제 발송하지 않습니다.

### 인증메일 디자인 및 발신자 설정

가입·재전송 인증메일은 `Family Care Cloud` 브랜드 제목, 테두리 카드, 크게 표시한 인증코드, 유효시간과 보안 안내로 구성합니다. [메일 미리보기](docs/auth-email-preview.html)에서 예시를 확인할 수 있습니다. 실제 코드는 Cognito가 템플릿의 `{####}`를 치환하며 24시간 유효합니다. 가족 초대 코드의 유효기간인 48시간과는 별개입니다.

새 디자인과 발신자 표시명 `Family Care Cloud`를 적용하려면 SES에서 발신 이메일 또는 도메인을 인증하고, SAM 배포 시 다음 파라미터를 함께 지정해야 합니다.

| 배포 파라미터 | 설정값 |
|---|---|
| `SesIdentityArn` | 인증한 SES 발신 이메일 또는 도메인의 identity ARN |
| `AuthFromEmail` | 해당 identity로 발송할 이메일 주소 |

템플릿의 발신자 형식은 `Family Care Cloud <발신주소>`입니다. 두 파라미터를 생략하면 기존 Cognito 기본 발송이 유지되어 새 디자인과 표시명이 적용되지 않습니다. SES 샌드박스에서는 수신자도 인증해야 하므로 일반 사용자 대상 발송 전 프로덕션 액세스와 발송 한도를 확인해야 합니다.

실제 AWS 배포와 메일 수신은 별도 확인이 필요합니다. 설정 절차는 [EMAIL_SETUP.md](docs/EMAIL_SETUP.md)를 참고하세요. 프론트에서는 비밀번호 안내 문구와 6자리 초대 코드 입력·재시도 안내를 이 계약에 맞춰 연결해야 합니다.

### 데이터 모델과 저장 방식

| 도메인 | 주요 정보 |
|---|---|
| User | 사용자 ID, 이름, 이메일, 역할, 참여 그룹 목록 |
| CareGroup / Member | 그룹 ID, 구성원 역할·참여일, 현재·다음 담당자 |
| Elder | 고령자 ID, 이름, 생년월일, 기본 특이사항 |
| CareEvent | 내용, 유형, 발생 시간, 작성자, 등록 시간, 버전 |
| Schedule | 제목, 예정 시간, 담당자, 상태, 버전, 삭제 시각 |
| CareHandoff | 인계·인수 보호자, 대상 기간, 결과, 원문 스냅샷, 확인 이력 |
| CaregiverHistory | 담당자, 담당 시작·종료 시각, 연결된 인수인계 |
| Approval | 대상 일정·버전, 요청자, 처리 담당자, 요청 내용·처리 결과 |

논리적인 도메인 모델과 실제 저장 항목은 구분됩니다. 현재는 기록·일정·인수인계·교대 이력을 그룹 내부에 포함하고, DynamoDB의 `group#{groupId}` 항목에 함께 저장합니다. 사용자와 초대, 인증메일 발송 제한 및 초대 수락 시도 제한 상태는 별도 키로 저장합니다.

로컬 `Store`는 변경할 데이터를 복사한 뒤 작업이 성공한 경우에만 파일과 메모리에 반영합니다. 트랜잭션은 한 프로세스 안에서 순차 처리하며 임시 파일 저장 후 이름 변경으로 기존 파일을 교체합니다.

DynamoDB 어댑터는 강한 일관성 조회와 `TransactWrite`를 사용합니다. 읽은 항목의 버전을 조건으로 검사하므로, 다른 요청이 먼저 변경했다면 `409 CONCURRENT_UPDATE`를 반환합니다. 예를 들어 그룹 참여 시 사용자 측 그룹 목록과 그룹 측 구성원 목록을 함께 저장합니다.

현재 구조는 그룹당 350 KB를 상한으로 하는 소규모 MVP입니다. 한도를 넘으면 기존 데이터를 보존하고 413을 반환합니다. 장기간 기록 축적에는 개별 기록·인수인계 항목 분리와 페이지네이션이 필요합니다.

### 주요 API

`{g}`는 그룹 ID, `{id}`는 해당 도메인의 리소스 ID입니다.

| 도메인 | 대표 경로 |
|---|---|
| 인증 | `POST /auth/register`, `/auth/login`, `/auth/logout`, `/auth/confirm`, `/auth/resend-confirmation` |
| 프로필 | `GET/PATCH /me` |
| 그룹 | `GET/POST /groups`, `GET /groups/{g}`, `GET /groups/{g}/members` |
| 초대·참여·탈퇴 | `POST /groups/{g}/invitations`, `/invitations/accept`, `/groups/{g}/leave` |
| 고령자 | `GET/POST/PATCH /groups/{g}/elder` |
| 기록 | `GET/POST /groups/{g}/events`, `GET/PATCH/DELETE /groups/{g}/events/{id}` |
| 일정 | `GET/POST /groups/{g}/schedules`, `GET/PATCH/DELETE /groups/{g}/schedules/{id}` |
| 담당자·교대 | `GET/PATCH /groups/{g}/assignment`, `POST /groups/{g}/handover` |
| 인수인계 | `GET/POST /groups/{g}/handoffs`, `GET /groups/{g}/handoffs/latest`, `POST /groups/{g}/handoffs/{id}/acknowledge` |
| 승인 | `GET/POST /groups/{g}/approvals`, `PATCH /groups/{g}/approvals/{id}` |

상세 입력·응답은 [API 명세](docs/API.md)에서 확인할 수 있습니다. 일반 애플리케이션 오류는 `{error, code}` 형식이며, 인증 재시도 정보 등이 있으면 `details`를 추가합니다. 데이터 응답에는 `Cache-Control: no-store`를 적용합니다.

### 테스트 범위와 확인된 한계

도메인 테스트에서는 가입·초대·기록·일정·교대 흐름과 그룹 접근 제한, 작성자 권한, 중복 요청, 버전 충돌, 저장 실패 시 롤백을 검증합니다. HTTP 및 Lambda 요청 변환 테스트와 모의 AWS 클라이언트를 이용한 어댑터 테스트도 포함합니다. 모의 테스트 통과는 실제 AWS 배포·메일 수신 검증을 대신하지 않습니다.

추가 로컬 품질 테스트에서는 그룹 상세를 통한 인수인계 조회 권한 우회와 Cognito 이메일 변경 동기화 문제가 확인됐으며 아직 수정되지 않았습니다. 따라서 전체 권한·인증 품질 검증이 완료됐다고 볼 수는 없습니다. 실제 알림 발송과 장기 데이터 저장 구조 확장도 후속 작업입니다.

## 실행

Node.js 22 이상, pnpm을 사용합니다.

```powershell
pnpm install --frozen-lockfile
pnpm start
```

주소: `http://127.0.0.1:3000`. `.env.example`은 참고용이며 자동으로 읽지 않습니다. 기본 DB는 `data/fcc-v2.json`, AI는 **로컬 규칙/원문 추출 모드**입니다. 로컬은 실제 이메일 인증 없이 개발 계정을 생성합니다. 운영 Lambda는 Cognito 인증과 DynamoDB를 사용합니다.

```powershell
$env:PORT = '3000'
$env:DATA_FILE = './data/fcc-v2.json'
$env:AI_PROVIDER = 'local'
$env:STT_SERVICE_URL = 'http://127.0.0.1:8000'  # fcc-ai(feature/stt-service)를 별도로 실행 중일 때만 필요
pnpm start
```

다른 터미널에서:

```powershell
$base = 'http://127.0.0.1:3000'
$account = @{ email = 'caregiver@example.com'; password = 'LocalCare!12345'; name = '보호자' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$base/auth/register" -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($account))
$session = Invoke-RestMethod -Method Post -Uri "$base/auth/login" -ContentType 'application/json' -Body '{"email":"caregiver@example.com","password":"LocalCare!12345"}'
$headers = @{ Authorization = "Bearer $($session.accessToken)" }
Invoke-RestMethod -Uri "$base/me" -Headers $headers
```

## 구현 기능

- 로컬 가입·로그인·로그아웃, 이름 수정, 비밀번호 scrypt 해시, 세션 만료·폐기
- AWS Cognito 가입·이메일 확인·로그인·토큰 검증·로그아웃 어댑터
- SES 연동 시 가입·재전송 인증메일 HTML 디자인 및 `Family Care Cloud` 발신자 표시명
- 그룹 생성, 고령자 별도 등록/수정, 이메일 대상 6자리 일회용 초대 코드·수락 횟수 제한, 참여/탈퇴, 소유권 이전
- 기록 작성/상세/기간·유형 조회/수정/삭제, 자동 분석과 수동 유형 선택
- 일정 등록/수정/삭제, 보호자의 직접 완료·취소, 오늘/다음 일정 조회
- 담당자 지정·교대 이력, 교대 시 인수인계 생성, 기록 없으면 교대만 처리
- 기간별 인수인계 생성/상세/최신/이력/재생성/인수 확인, 생성 당시 원문 근거 보존
- Bedrock Converse 연동, 응답 JSON·근거 ID·원문 인용 검증, AI 실패 시 롤백/오류 안내
- DynamoDB 저장 어댑터와 동시 변경 조건 검사, AWS SAM 인프라 템플릿
- [fcc-ai](https://github.com/FamilyCareCloud/fcc-ai)(GPU STT, `feature/stt-service`) 연동: `/groups/{g}/assistant/voice`가 오디오를 fcc-ai `/transcribe`로 전사한 뒤 기존 텍스트 질문과 동일한 DB 근거 답변으로 응답

확장 기능인 승인 요청과 제한된 텍스트 일정 질문, GPU STT 연동 음성 질문은 유지했습니다. 실제 알림 발송, 음성 합성(TTS), 위치 감지는 이번 MVP 범위 밖입니다. 별도 `fcc-frontend` 저장소의 화면은 이 작업에서 수정하지 않았습니다.

### 음성 질문(fcc-ai 연동)

`fcc-ai`의 `feature/stt-service` 브랜치를 별도 GPU 환경에서 실행한 뒤(`uvicorn app.main:app --host 0.0.0.0 --port 8000`), 백엔드에 `STT_SERVICE_URL`만 지정하면 연결됩니다. 미설정 시 음성 질문 API는 항상 **503**을 반환하고, 텍스트 질문(`/groups/{g}/assistant`)에는 영향이 없습니다.

```powershell
$body = @{ audioBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes('sample.wav')); mimeType = 'audio/wav' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$base/groups/$($group.id)/assistant/voice" -Headers $headers -ContentType 'application/json' -Body $body
```

## 검증

```powershell
pnpm test
```

로컬 도메인/HTTP/Lambda 변환 및 실제 SDK 명령을 사용하는 모의 AWS 어댑터 테스트가 포함됩니다. 실제 AWS 계정 배포와 실제 Bedrock 모델 호출은 별도 통합 검증이 필요합니다. 계정이나 모델이 없을 때 `mode: extractive` / `local-rules`로 표시하며 AI 결과로 가장하지 않습니다.

## 문서

- `develop`에 푸시하거나 PR을 병합하면 GitHub Actions가 테스트 후 AWS 백엔드를 자동 배포합니다. PR 자체는 검증만 수행합니다.
- [첫 배포 주소·설정·재배포 방법](docs/DEPLOYMENT.md)
- [최신 설계 원문](docs/FCC.md)
- [API 계약](docs/API.md)
- [비밀번호·인증 재전송·프론트 응답 계약](docs/AUTH_API.md)
- [인증메일·발신자 설정 및 초대 코드 연동](docs/EMAIL_SETUP.md)
- [인증메일 디자인 미리보기](docs/auth-email-preview.html)
- [설계 대비 구현 현황](docs/IMPLEMENTATION_PLAN.md)
- [DB 구성 및 AWS 배포](docs/DATABASE.md)
- [v0.1 변경/데이터 이전](docs/MIGRATION.md)

로컬 파일 DB는 단일 프로세스용입니다. 현재 DB 구조는 그룹 단위 원자적 저장을 우선한 소규모 MVP로, 한 그룹 레코드는 350 KB까지입니다. 한도 초과는 413으로 거절하며 기존 데이터는 유지합니다. 장기 운영 전 기록/인수인계의 개별 항목 분리와 페이지네이션이 필요합니다.

회원가입 관련 변경은 Cognito 설정과 Lambda를 함께 업데이트해야 합니다.

## 케어브릿지

메모 작성·다국어 전사/번역·담당자 승인/수정/보류·승인된 가족 미리보기 전체 흐름은 [CAREBRIDGE.md](docs/CAREBRIDGE.md)에 정리했습니다.
