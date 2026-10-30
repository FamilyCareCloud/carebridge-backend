# CareBridge Backend

다국어 음성·텍스트 기반 돌봄 기록 생성 및 검토 지원 AI **CareBridge**의 기관 업무 API입니다. 인증, 기관 참여, 메모 제출, 담당자 검토, 지정 수신자 공개와 접근 권한을 관리합니다.

- **팀:** 영남대학교 YU42 · 임현승(프론트엔드), 전채영(백엔드), 김우주(AI)
- **서비스:** https://develop.db2l4u9y804jp.amplifyapp.com/
- **API:** https://uwv0zhujxf.execute-api.ap-northeast-2.amazonaws.com
- **제출 코드:** `main` · **AWS 자동 배포:** `develop`

## 업무 흐름

1. 이메일 인증·로그인 후 고정 역할로 기관을 생성하거나 참여를 요청합니다.
2. 검토자가 참여를 승인하고 대상자를 등록합니다.
3. 작성자가 전사문을 확인하거나 텍스트를 입력해 AI 초안을 생성하고 독립된 제출본으로 전송합니다.
4. 검토자가 최종 내용을 저장·검사하고 원문과 확인사항을 확인한 뒤 보류·확정합니다.
5. 확정된 기록의 공개 내용과 수신자를 지정하고 별도로 공개합니다.
6. 열람자는 자신에게 공개된 기록만 조회합니다. 정정·철회·퇴출 시 접근 권한을 다시 확인합니다.

작성자·검토자·열람자의 서버 역할은 각각 `author`, `reviewer`, `viewer`입니다. 일반 계정은 활성 기관 한 곳에만 속하며 가입 역할이 고정됩니다. 관리 권한 이전과 검토 이력을 지원합니다.

확정에는 최신 버전 및 최종 내용에 연결된 유효한 AI 검사 결과가 필요합니다. 유효한 검사에 포함된 경고는 보존하며 사람이 최종 판단합니다. 공개는 확정과 별도 동작이고, 열람자 응답에는 원문 제출·검토 이력·수신자 목록을 포함하지 않습니다. `recordedAt`은 최초 제출 시각, `publishedAt`은 공개 시각이며 재공개해도 원본 기록 시각은 유지합니다.

## 기술 구성

Node.js 22 이상 · JavaScript ES Modules · REST/JSON · AWS Lambda · API Gateway · Cognito · DynamoDB · SAM/CloudFormation을 사용합니다. 로컬은 파일 저장소와 SSE, 배포 환경은 DynamoDB와 WebSocket 접근 재검증을 사용합니다. AI 추론은 별도 AI 서버에 요청하며 서비스 키는 백엔드에서만 전달합니다.

## 로컬 실행

Node.js 22 이상과 pnpm 11.19.0을 준비합니다.

```sh
pnpm install --frozen-lockfile
```

`.env.example`을 `.env`로 복사하고 AI 서버 주소·키를 설정합니다.

```dotenv
PORT=3000
CAREBRIDGE_SERVICE_URL=http://127.0.0.1:8002
CAREBRIDGE_SERVICE_API_KEY=
CAREBRIDGE_CONFIRMATION_ENABLED=true
CAREBRIDGE_TRANSFER_ENABLED=true
```

```sh
node --env-file=.env src/server.js
```

기본 주소는 `http://127.0.0.1:3000`입니다. 로컬 저장 파일 경로는 `DATA_FILE`로 지정합니다. 파일 저장소는 단일 프로세스 개발용입니다. AI 생성·전사·검사에는 별도 실행한 CareBridge AI 서버가 필요하며, `CAREBRIDGE_SERVICE_API_KEY`는 AI 서버의 `FCC_AI_API_KEY`와 일치해야 합니다. 연결 실패를 정상 생성 결과로 대신하지 않습니다.

[로컬 QA 계정 안내](docs/TEST_ACCOUNT.md)의 admin은 명시적으로 활성화하는 테스트 기능입니다. 실제 비밀번호·서비스 키는 저장소에 기록하지 않습니다.

## 주요 API

`{w}`는 기관 ID입니다. 업무 API에는 Bearer 인증과 역할·현재 소속 검증을 적용합니다.

| 경로 | 용도 |
|---|---|
| `/workspace-auth/register`, `/auth/login`, `/auth/refresh`, `/me` | 고정 역할 가입·인증·세션 |
| `/workspaces`, `/workspaces/join-requests` | 기관 생성·소속 조회·참여 요청 |
| `/workspaces/{w}/members`, `/subjects` | 기관 구성원·대상자 |
| `/workspaces/{w}/drafts`, `/transcriptions` | AI 초안 생성·음성 전사 |
| `/workspaces/{w}/submissions` | 독립 제출·검토·최종 검사 |
| `/workspaces/{w}/publications` | 공개 준비·수신자 지정·공개·정정·철회 |
| `/workspaces/{w}/audit`, `/transfers` | 관리 이력·관리 권한 이전 |

각 행의 두 번째 경로는 같은 기관 접두사를 생략한 표기입니다. 상세 메서드·본문·권한·오류는 [기관 업무 API](docs/WORKSPACE_API.md)와 [연동 계약](docs/INTEGRATION_2026-10-29.md)을 확인하세요.

## 검증과 배포

```sh
pnpm test
```

제출 버전 기준 자동 테스트 **113개**가 통과했습니다. 기관 접근 제한, 퇴출·재참여, 공개 수신자 제한, 세션 갱신, 동시 수정, 원본 기록 시각 보존과 API 계약을 검사합니다. 자동 테스트는 실제 기관 도입 효과나 모델의 전체 정확도를 뜻하지 않습니다.

`develop` 변경 시 GitHub Actions가 테스트·SAM 검증 후 `infra/frontend-backend-only.yaml`을 빌드·배포합니다. PR에서는 검증만 수행하며 `main` 반영은 자동 배포 대상이 아닙니다. 배포 후 `/health`, 비인증 요청 차단과 CORS를 검사합니다. `/health`의 `version`은 배포 커밋이며 AI 주소 설정 여부만으로 모델 가동을 판단할 수는 없습니다.

## 구성과 문서

| 경로 | 역할 |
|---|---|
| `src/services/workspaces.js` | 기관·대상자·제출·검토·공개 업무 |
| `src/adapters/carebridge.js` | AI 서버 요청·응답 계약 검증 |
| `src/handlers/` | 로컬 HTTP·Lambda·WebSocket 진입점 |
| `src/adapters/cognito.js`, `dynamodb.js` | 배포 인증·저장소 |
| `tests/` | 도메인·인증·실시간·권한 회귀 검사 |
| `infra/frontend-backend-only.yaml` | 현재 자동 배포 템플릿 |

- [기관 업무 API](docs/WORKSPACE_API.md) · [연동·검증 범위](docs/INTEGRATION_2026-10-29.md)
- [인증 API](docs/AUTH_API.md) · [AI 연결](docs/AI_CONNECTION_2026-10-29.md)
- [배포 설정](docs/DEPLOYMENT.md) · [내용·근거 검사](docs/FIDELITY_V2.md)
- [프론트엔드](https://github.com/FamilyCareCloud/carebridge-frontend) · [AI](https://github.com/FamilyCareCloud/carebridge-ai)

세부 문서에는 작성 당시의 구현 기준과 검증 시점이 함께 기재돼 있습니다. 현재 시제품은 합성·비식별 사례의 기록 검토 보조용이며 공식 기록이나 의료 판단을 자동 확정하지 않습니다.
