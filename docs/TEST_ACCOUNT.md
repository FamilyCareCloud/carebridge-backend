# 로컬 QA admin

BE-06 QA 환경은 http://127.0.0.1:3000 이다. 배포 Lambda/Cognito에 admin을 활성화하지 않는다.
ID는 admin이며 기존 별도 전달 비밀번호를 .env의 CAREBRIDGE_TEST_ADMIN_PASSWORD로 지정한다. 새 요청서에 따라 저장소의 비밀번호 파일을 제거했다. 이전 Git 이력까지 삭제한 것은 아니다.

## 준비

.env에 CAREBRIDGE_TEST_ADMIN_ENABLED=true, CAREBRIDGE_TEST_ADMIN_PASSWORD=담당자_지정값을 설정한다. CAREBRIDGE_QA_WORKSPACE_IDS를 지정하면 해당 로컬 기관만 허용한다. 미지정 시 합성 기관과 별도 정식 담당자를 만들고 재사용한다.

실행 순서:

1. pnpm install --frozen-lockfile
2. node --env-file=.env scripts/seed-qa.js
3. node --env-file=.env src/server.js

seed-qa는 명시적인 로컬 QA 모드에서만 합성 대상자·생성·제출·검사·자기 검토·확정·별도 공개를 실행한다. AI 생성·검사는 fixture이며 실제 모델 호출·품질 검증이 아니다. 정상 서버는 fixture를 호출하지 않는다. 재실행은 중복 생성하지 않고, 사용자가 철회한 공개를 자동 복구하지 않는다. 출력된 기관·제출·공개 ID로 화면을 확인한다.

## 인증·역할·공개문

POST /auth/login: {"loginId":"admin","password":"별도 전달한 값"}. 응답의 Bearer accessToken을 사용한다.
POST /auth/test-role: {"role":"author"}, reviewer, viewer 중 하나.
/me의 qaRole, /workspaces의 role/testAccess/status, /workspaces/{id}/access의 role/testAccess에서 실효 권한을 확인한다. QA 기관은 active/testAccess=true다.
역할 문맥은 계정 전체에 적용된다. 다른 탭도 이벤트 직후 내용·캐시를 비우고 재조회한다. 로컬 SSE는 GET /workspaces/{id}/events에 Bearer fetch 스트림으로 연결한다.

로컬 프론트의 동일 출처 프록시에서 /auth, /me, /workspace-auth, /workspaces를 http://127.0.0.1:3000 으로 전달한다. 배포 프론트가 공유 API에 연결된 상태에서는 로컬 admin을 사용할 수 없다.

지정 QA 기관에서 admin의 자기 제출 검토·확정을 허용한다. reviewer로 members 조회 시 QA 수신 후보 admin을 role=viewer, testAccess=true로 제공한다. 명시적으로 지정한 공개문만 viewer 역할에서 열람한다. 정식 소유자나 일반 멤버십을 교체하지 않는다. 일반 사용자는 역할 전환을 사용할 수 없다.
원문 연결·버전·현재 내용에 연결된 유효 QA 결과를 검증하며 경고는 보존하면서 진행한다. 실제 actor와 사용 역할을 audit에 기록한다.
활성 설정을 해제하면 admin 로그인·기존 토큰이 거절된다. NODE_ENV=production인 로컬 서버는 실행을 거절한다.
