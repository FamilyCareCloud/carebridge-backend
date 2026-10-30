# 심사용 일반 계정 준비 도구

이 도구는 운영자가 Cognito·DynamoDB에 접근하여 고정 역할 계정 3개와 심사용 기관 1개를 준비한다. 배포 Lambda에서 자동 실행하지 않는다. 기존 admin 계정과 기관을 재사용하지 않으며 공개 가입·로그인·권한 정책은 변경하지 않는다.

## 현재 구현 범위

- 이메일 인증 상태를 관리자가 사전에 설정한 Cognito 계정 3개.
- 역할별 DB 연결과 일반 권한의 기관 생성·참여 요청·승인.
- 동일 계정·기관을 재사용하는 manifest `judge-demo#v1`.
- 5개 샘플 원문·언어·목표 상태의 계획 출력.

계정 준비 도구는 샘플을 만들지 않는다. 별도 `seed-judge-samples.mjs`가 정상 API로 대상자 등록·AI 초안 생성·제출·검토·공개를 수행한다. 샘플 계획을 실제 생성 기록으로 보고하지 않는다.

## 샘플 준비

아래 명령은 준비된 기관 ID와 AWS 계정·DB를 고정 확인하며 기존 비밀번호 파일로 일반 계정 로그인을 한다. 기록을 DB에 직접 주입하거나 AI 응답을 꾸며내지 않는다. 진행 정보만 기존 manifest의 `seed`에 저장한다. 동시에 실행하지 않는다.

```sh
node scripts/seed-judge-samples.mjs --generate "$HOME/carebridge-judge-private.json"
# 출력된 원문과 한국어 초안을 대조하여 검토한 뒤 실행
node scripts/seed-judge-samples.mjs --finalize "$HOME/carebridge-judge-private.json"
node scripts/seed-judge-samples.mjs --verify "$HOME/carebridge-judge-private.json"
```

가상 대상자 가온·나래 2명에 한국어·베트남어 검토 대기 2건, 한국어 보류 1건, 영어 원문의 검토 완료 비공개 1건, 한국어 공개 1건을 준비한다. 확정할 기록은 AI 최종 QA의 모든 검사가 통과하고 보류 이슈가 없어야 한다. 공개 수신자는 심사 열람자 1명만 지정한다. AI 오류·보류 결과는 임의로 통과시키지 않는다.

동일 제출 requestId와 생성 ID를 재사용하여 재실행 시 중복을 방지한다. 기존 대상자·원문·초안 변경이나 차단·철회한 공개 기록은 덮어쓰거나 자동 재공개하지 않는다. 운영자는 `--generate` 출력 내용을 직접 대조한 후에만 `--finalize`를 실행한다. 실제 심사가 시작된 이후 초기화 목적으로 재실행하지 않는다.

## 사전 확인

AWS 계정 `055047416353`, 서울 리전, 지정 UserPool 및 DB만 허용한다. AWS CLI가 연결된 운영자 환경(예: CloudShell)에서 실행한다. Cognito 사용자 생성·조회·영구 비밀번호 설정과 해당 DB 읽기·쓰기가 가능한 운영자 권한이 필요하다. GitHub 배포 역할에 새 권한을 부여하지 않는다.

계정 ID는 `judge-reviewer@carebridge.invalid`, `judge-author@carebridge.invalid`, `judge-reader@carebridge.invalid`이다. 수신함이 없는 테스트 주소이며 인증메일을 발송하지 않는다. 표시 이름은 심사 검토자·작성자·열람자다. 테스트 주소의 비밀번호 복구는 운영자가 담당한다.

```sh
node scripts/prepare-judge-demo.mjs --plan
```

계획 출력은 AWS 쓰기를 하지 않는다. Node.js 22 이상과 저장소 의존성을 준비한 뒤 실행한다.

## 적용 승인 후 운영자 실행

저장소 밖의 개인 파일을 명시한다. 다음 예시의 경로는 CloudShell용이다. 비밀번호는 계정별 난수로 생성하며 화면에 출력하거나 명령줄 인수에 넣지 않는다.

```sh
node scripts/prepare-judge-demo.mjs --new-credentials "$HOME/carebridge-judge-private.json"
export AWS_REGION=ap-northeast-2
export COGNITO_USER_POOL_ID=ap-northeast-2_ge6F8vYbo
export DYNAMODB_TABLE=fcc-backend-dev-Database-1O0VMLVB2JYCH
node scripts/prepare-judge-demo.mjs --apply "$HOME/carebridge-judge-private.json"
```

개인 파일에는 reviewer/author/viewer 비밀번호만 저장하며 생성 시 `wx`·권한 600을 사용한다. 기존 파일을 덮어쓰지 않는다. 제출 담당자에게만 안전하게 전달하고 Git·로그·공개 문서에는 포함하지 않는다.

## 재실행과 중단

- 기존 영구 비밀번호와 수정된 기록을 재설정하지 않는다.
- 기존 manifest 없이 동명 Cognito 계정이 있으면 중단한다.
- sub·역할·기관 이름·소유자·소속 불일치 또는 퇴출된 멤버가 있으면 중단한다.
- 계정 생성 직후 manifest 저장 실패 등 부분 실패는 운영자가 상태를 조회해 복구한다. 임의 인수·비밀번호 재설정을 하지 않는다.
- 동일 준비 작업을 동시에 실행하지 않는다.
- 이 준비는 기존 샘플·심사자가 생성한 기록을 삭제하거나 초기화하지 않는다.

실제 적용 후에는 웹사이트 로그인, 추가 인증 요구 없음, 기관 연결, 역할별 권한을 검수해야 한다. 심사 종료 후에는 정확한 심사 계정 sub를 확인해 세 계정을 비활성화하고 기존 인증을 종료한다. 기관·기록은 자동 삭제하지 않는다.

## 검증

`node --test tests/judge-demo.test.js`는 모의 Cognito와 메모리 저장소를 사용한다. 정상 연결·재실행·변경 보존·동명 계정·역할 변경·퇴출·sub 변경·중단된 비밀번호 설정 보호를 검사한다. 실제 AWS 계정 생성이나 모델 호출 검증을 의미하지 않는다.
