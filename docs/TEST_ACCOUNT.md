# test 브랜치 로컬 QA 계정

이 브랜치는 `feature/chaeyeong-workspace-features`에 테스트 계정 전용 구현을 추가한다.
기능 브랜치에는 테스트 계정 코드가 없다. 실제 로컬 데이터와 `.env`는 커밋하지 않는다.

## 실행·로그인

```powershell
pnpm install --frozen-lockfile
node --env-file-if-exists=.env src/server.js
```

기존에 전달한 `admin` 아이디와 비밀번호를 그대로 사용한다. 사용자 요청에 따라 해당 테스트 비밀번호를 [config/test-account.json](../config/test-account.json)에 포함했다. 다른 사용처의 비밀번호를 재사용하지 않는다.
로그인은 `POST /auth/login`에 `{ "loginId": "admin", "password": "config/test-account.json의 password 값" }`를 보낸다.

`test` 브랜치 로컬 서버에서는 기본 활성화하며, `CAREBRIDGE_TEST_ADMIN_ENABLED=false`로 끌 수 있다. 비활성 시 기존 admin 토큰과 로그인도 차단한다. 생산 환경의 로컬 서버 실행은 거절하고 Lambda의 Cognito 인증에는 테스트 어댑터를 연결하지 않는다.

`CAREBRIDGE_QA_WORKSPACE_IDS`를 쉼표로 지정하면 해당 로컬 기관만 허용한다. 기존 `.env`의 허용 기관을 재사용한다. 지정하지 않으면 합성 QA 기관과 별도 정식 담당자를 만들고 재시작 시 재사용한다. 실제 비밀번호는 파일의 값으로 프로비저닝하며 기존 `.env`의 이전 비밀번호 항목은 사용하지 않는다.

## 역할 전환

1. 로그인 응답의 Bearer 토큰을 사용한다.
2. `POST /auth/test-role`에 `{ "role": "author" }`, `reviewer`, `viewer` 중 하나를 보낸다.
3. `GET /workspaces`로 허용 기관을 확인하고 `/workspaces/{id}/access`에서 선택 역할을 확인한다.

1·2·3 역할 화면과 허용 기관 API 접근을 제공한다. 역할 문맥은 계정 전체에 적용하므로 변경 시 열린 모든 탭을 재검증한다. 정식 소유자를 admin으로 교체하지 않는다. 실제 actor와 선택 역할을 감사 이력에 함께 기록한다.
일반 계정은 역할 전환 API를 사용할 수 없다. admin도 본인 제출 검토·확정은 할 수 없고, 공개 수신자로 자동 지정되지 않는다. 미확정 정책과 최종본 QA 검사는 계속 적용한다.

## 검증

`node --test`는 기능 회귀 테스트와 `tests/test-account.test.js`의 계정 생성·동일 비밀번호 로그인·기관 범위·역할 전환·재시작·비활성 차단을 검증한다. 실제 GPU 품질과 프론트 화면 검증은 별도다.
