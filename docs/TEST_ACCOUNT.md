# 개발용 계정 운영

## 배포 Cognito 계정

배포 환경은 로컬 비밀번호 인증을 사용하지 않는다. `POST /auth/login`의 `loginId: "admin"`을 운영자가 지정한 Cognito 사용자로 매핑하고 Cognito 비밀번호 인증 및 GetUser로 검증된 sub가 모두 일치해야 권한을 부여한다. 비밀번호는 저장소·설정 레코드·로그에 넣지 않는다. 일반 가입자는 역할 변경이 불가능하다.

AWS 운영자만 실행: 대상 환경의 `AWS_REGION`, `COGNITO_USER_POOL_ID`, `DYNAMODB_TABLE`을 명시하고 `node scripts/provision-deployed-admin.js`를 실행한다. 내부 Cognito 사용자와 빈 개발 테스트 작업 그룹을 만든다. 합성 소유자는 로그인할 수 없으며 실제 기관의 소유자를 대체하지 않는다. 기존 admin 사용자가 있는데 설정이 없는 경우 안전을 위해 자동 인수하지 않고 중단한다. 재실행은 같은 작업 그룹을 재사용하며 비밀번호를 변경하지 않는다.

그다음 운영자가 `python3 scripts/set-deployed-admin-password.py`를 직접 실행해 숨김 입력으로 영구 비밀번호를 지정한다. 비밀번호를 명령줄 인수로 전달하거나 채팅에 보내지 않는다. Cognito 정책을 만족해야 한다. 초기 임시 비밀번호 상태에서는 일반 로그인이 불가능하다.

`deployment-admin#config`는 HTTP API로 수정할 수 없는 운영 레코드다. 고정 sub와 정확히 하나의 개발 테스트 작업 그룹에만 권한을 부여한다. 다른 기관의 멤버십이 잘못 추가되어도 접근·목록 노출을 차단한다. 환경 전체 관리자 권한이 아니다. 새로운 기관 생성·참여·관리 권한 이전은 허용하지 않는다. 개발 그룹에 실제 돌봄 정보를 입력하지 않는다.

배포 화면은 이메일/비밀번호 로그인만 표시한다. 개발자는 이메일 칸에 admin을 입력한다. 인증 후 설정의 사용 역할에서만 1·2·3그룹을 선택한다. 역할 문맥은 계정 전체에 적용되며 사용자 레코드 변경은 DynamoDB Streams를 통해 다른 탭에도 재검증을 요청한다. viewer는 명시적으로 수신 지정된 공개문만 읽을 수 있다. AI 기능이나 검사 결과를 우회하지 않는다.

중지: 같은 환경 변수로 `node scripts/provision-deployed-admin.js --disable`. 이후 로그인·기존 토큰·역할 변경·기관 접근을 거절하고 기존 실시간 연결은 revoke 이벤트로 닫는다. 중지 후 다시 provisioning을 실행하면 동일 계정을 재활성화하므로 운영자가 의도한 경우에만 실행한다. Cognito 자체 비활성화도 별도 가능하다.

## 로컬 QA (기존 개발 환경)

BE-06 로컬 QA 환경은 http://127.0.0.1:3000 이다. 아래 로컬 인증 설정을 배포 Lambda/Cognito에 적용하지 않는다. 배포 계정은 위의 별도 경로를 따른다.
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
