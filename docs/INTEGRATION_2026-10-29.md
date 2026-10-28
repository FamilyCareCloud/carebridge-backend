# 백엔드 연동 수정 회신 — 2026-10-29

기준: develop@c9a78cb 이후 BE-01~07 구현. 코드·모의 검증과 실제 AWS·브라우저 검증을 구분한다.
기존 API는 `https://uwv0zhujxf.execute-api.ap-northeast-2.amazonaws.com`, 배포 버전과 WebSocket 주소는 `/health`의 `version`, `carebridge.websocketUrl`에서 확인한다. CloudFormation 출력은 ApiUrl/WebSocketUrl이고 Actions 배포 요약에도 표시한다.

## 요청별 회신

| ID | 구현·검증 | 남은 외부 검증·결정 |
|---|---|---|
| BE-01 | 로컬·Lambda 공통 정책, 템플릿 정책 주입, 단일 기관 슬롯의 원자적 변경 | 실제 Cognito 계정으로 배포 API 종단 검증 |
| BE-02 | WebSocket + DynamoDB Streams, 공유 registry, 단기 일회용 티켓, 재인증·만료 정리 | 배포 권한·AWS 생성 확인, 두 브라우저 수신 지연 측정 |
| BE-03 | audit의 고유 이벤트 ID, 안정 정렬, cursor 페이지, 행위자 이름 | 프론트 화면 연동 |
| BE-04 | 발신 이전 목록·상세·이름·updatedAt·version | P-04 대상 지정 UI. 기존 userId 방식 유지 |
| BE-05 | 기록 시점 이름과 현재 이름을 각각 제공, 퇴출 후 식별 유지 | P-05 최종 표시 기준 |
| BE-06 | 로컬 QA admin active/testAccess/qaRole 정합성, 자기 검토, 합성 공개문 seed | 로컬 프론트 연동. Cognito admin 미활성화 |
| BE-07 | 유효한 hold·미통과 경고가 있어도 제출·확정 허용, 경고 보존 | P-03b 장애·미실행 결정 및 실제 AI 계약 검증 |

## 정책·원자성

`src/workspace-policy.js`를 로컬과 Lambda가 사용한다. multipleWorkspaces=false, recipientChange=block_all을 강제하고 confirmationEnabled/transferEnabled는 기본 true다. 배포 템플릿에도 같은 값을 전달한다. 확정·이전만 환경변수 false로 명시 중단할 수 있다.
생성·참여 승인·이전 수락은 `workspace-active#{userId}`와 기관 변경을 한 트랜잭션에 쓴다. 기존 계정은 index의 실제 owner/active membership도 확인한다. 대기·거절 이력은 활성 소속이 아니다. 두 기관에서 동시에 승인해도 같은 슬롯의 버전 조건으로 한 건만 성공한다.
중복 소속은 `409 SINGLE_WORKSPACE_REQUIRED`, DynamoDB 경합은 `409 CONCURRENT_UPDATE`. 퇴출·관리 이전 시 과거 슬롯을 해제한다. 재가입 정책은 별도다.
수신자 변경과 정정은 기존 공개를 모두 차단하고 publish 전까지 새 내용·추가 수신자에게 공개하지 않는다.

## 추가·보완 API

모든 요청은 기존 Bearer 인증을 사용한다.

| 메서드·경로 | 응답·권한 |
|---|---|
| GET /workspaces/{w}/audit?limit=20&cursor={eventId} | 현 reviewer만 `{items,nextCursor}`. limit 1~50, revision 내림차순·eventId 내림차순 |
| GET /workspaces/{w}/transfers | 현 reviewer의 이전 목록. pending/completed/cancelled 보존 |
| GET /workspaces/{w}/transfers/{t} | 현 reviewer의 이전 상세. 없으면 404 |
| GET /workspaces/{w}/submissions | author 본인만, reviewer 전체. authorNameAtSubmission/authorCurrentName 추가 |
| GET /workspaces/{w}/submissions/{s} | 제출 원문·생성본·작성자 편집본·별도 검토본, 검토 행위자 이름·QA 연결 정보 |

audit 필드: eventId, at, revision, action, actorId, actorNameAtEvent, actorCurrentName, role, resourceType, resourceId, result, reason. 생성, 참여 요청·승인·거절·퇴출, 대상 등록, 제출·검토·보류·확정·검사, 공개 준비·실행·정정·철회, 이전 시작·수락·취소를 기록한다. 메모 본문은 목록에 넣지 않는다. 과거 이벤트는 stable legacy ID로 페이지 이동하며 새 이벤트가 앞에 추가돼도 cursor 이후의 같은 이벤트가 중복되지 않는다.
이전 응답: targetUserId, targetNameAtRequest, targetCurrentName, status, startedAt, updatedAt, version. 기존 cancel에 필요한 ID·version을 복구한다. 수락과 취소 경합은 같은 기관·요청 버전을 검증한다. 이전 완료 후 구 관리자는 전체 관리 자료에 접근하지 못한다.
이름 스냅샷이 없던 과거 데이터는 null로 반환하고 현재 이름을 별도로 제공한다. 최종 UI 표시 선택은 P-05 결정 전 임의 확정하지 않는다. reviewer의 퇴출 작성자 표시에도 두 이름 필드를 제공한다. viewer 공개 응답에는 내부 이름·검토·QA 필드를 추가하지 않는다.

## AI 경고와 확정

초안 경고는 제출 상세 `generatedDraft.qa`에 보존하며 generationId/sourceHash에 연결한다. 최종 검사는 `finalQa:{qa,contentHash,version,checkedAt,checkedBy}`, 검토 이력은 당시 qaResult를 저장한다.
유효한 응답의 hold/checks[].passed=false/issues[]를 삭제하거나 통과로 바꾸지 않는다. 경고가 있어도 사람이 확정할 수 있고 확정만으로 공개하지 않는다. 업무상 held 상태는 별도 decision=hold와 필수 reason으로만 결정한다.
현재 내용 해시·버전에 연결된 유효한 QA가 없으면 `409 FINAL_QA_REQUIRED`, 형식 불량은 502, 권한·원문 연결·버전 검증은 기존 403/409다. 검사 장애·미실행·생성 실패를 가짜 성공으로 대체하지 않는다(P-03b).
자유 편집·제출은 가능하다. 구간 추가·삭제된 편집본의 QA 연결은 기존 `422 EDITED_EVIDENCE_REQUIRED`이며 AI 모델 자체의 제약으로 주장하지 않는다. 이 경우의 최종 확정은 P-03b와 AI 입력 계약 확인이 필요하다. 운영 경로에서 fixture나 미검사를 통과 결과로 대체하지 않는다.

## WebSocket 프론트 계약

로컬 SSE와 별개로 배포에서는 API Gateway WebSocket을 사용한다. `/health` 또는 인증된 `GET /workspaces/{w}/events`에서 transport=websocket, websocketUrl, ticketPath를 확인한다.

1. Bearer 인증으로 `POST /workspaces/{w}/event-tickets`에 `{}`. 활성 권한 검증 후 `{ticket,websocketUrl,expiresInSeconds:60,heartbeatSeconds:20,proofValidSeconds:60,revision}`를 받는다.
2. `new WebSocket(websocketUrl + '?ticket=' + encodeURIComponent(ticket))`. AccessToken은 URL로 보내지 않는다. Origin은 배포 FrontendOrigin과 정확히 일치해야 한다. 티켓은 1회 사용이며 연결 URL을 로그에 기록하지 않는다.
3. onopen만으로 본문을 표시하지 않는다. 새 HTTP 티켓을 받아 소켓으로 `{"action":"revalidate","ticket":"새 티켓"}`을 보낸다. 서버 revalidate 뒤 권한·목록·상세를 재조회한다.
4. 20초마다 새 티켓으로 재검증한다. revalidate의 validUntil(Unix seconds)까지 갱신 응답이 없으면 즉시 본문을 숨긴다. heartbeat는 유효기간을 연장하지 않는다.

```json
{"type":"revalidate","workspaceId":"w","revision":12,"role":"viewer","validUntil":1793232060}
```

```json
{"type":"invalidate","workspaceId":"w","revision":13,"role":"viewer"}
```

```json
{"type":"access-revoked","workspaceId":"w"}
```

invalidate는 정정·수신자 변경·철회·구성원 변경·관리 이전·QA 역할 변경 시 전송한다. workspace 단위 신호이며 본문·타 사용자 ID·다른 기관 정보를 포함하지 않는다. 승인 대기자는 구독할 수 없다.
프론트는 신호를 받으면 모든 열린 탭의 내용·미리보기·캐시를 먼저 지우고 재조회한다. 권한이 없거나 세션이 만료되면 access-revoked를 보내 연결을 종료한다. 각 탭의 별도 연결에 전달한다. 늦게 도착한 이전 API 응답은 버린다. 연결 상실·탭 복귀·뒤로 가기에도 숨김→재연결→재인증→최신 조회 순서다.
공유 구조: `workspace/user/revoke 커밋 → DynamoDB Streams → Realtime Lambda → API Gateway @connections`. 실패는 stream partial-batch 재시도, Gone 연결은 registry 정리. 로컬 EventEmitter로 배포 전달을 대신하지 않는다.
만료 정리 sweeper는 1분 주기이고 정상 연결에 heartbeat를 보낸다. 프론트 60초 유효기간 타이머가 정리 스케줄보다 먼저 본문을 숨겨야 한다. API Gateway idle 10분·최대 2시간 이후에도 재접속한다([AWS 제한](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-execution-service-websocket-limits-table.html)).
registry 한도: 사용자 20개, 기관 100개, 환경 1,000개 연결. 초과 시 429다. disconnect/sweep가 인덱스를 정리한다. 운영 규모 확장에는 연결별 인덱스 분할이 필요하다.
스트림 batching window=0이며 지연 SLA는 미합의다. 실제 배포에서 커밋→브라우저 수신 지연을 측정해야 한다. 0ms나 실제 화면 숨김 검증 완료를 주장하지 않는다.

## QA·배포·검증 범위

admin은 [TEST_ACCOUNT.md](TEST_ACCOUNT.md)의 로컬 환경에서 제공한다. QA 기관 목록·access·/me 역할을 일치시키고 자기 제출 검토·확정과 자신에게 지정한 합성 공개문 열람을 지원한다. 프론트는 로컬 프록시를 사용한다. 실서버 Cognito에 admin을 활성화하지 않는다.
신규 SAM 리소스: WebSocket API, Realtime Lambda, DB stream, event source mapping, 만료 정리 Schedule, runtime IAM 권한. Actions는 AppVersion에 SHA를 주입한다. 기존 제한된 deploy role에 신규 리소스 생성 권한이 필요할 수 있다. `infra/enable-realtime-deployment.py`는 관리자가 검토 후 CloudShell에서 적용할 준비 스크립트다. 로컬에는 AWS 자격증명이 없어 IAM을 변경하지 않았다.
기존 배포 CORS는 FrontendOrigin(`https://develop.db2l4u9y804jp.amplifyapp.com`)과 Authorization/Content-Type을 허용한다. 로컬 프론트는 동일 출처 프록시를 사용한다. Cognito AccessToken 1시간·401 재로그인 정책은 기존 인증 계약을 유지한다.
실행 검증: node --test, 두 SAM 템플릿 cfn-lint. 업무 API와 Lambda 변환, 독립 서비스 인스턴스의 두 연결 전달, 재접속·만료·로그아웃·Origin·티켓 재사용 거절, admin 작성→자기 확정→공개 fixture를 확인한다. 실제 신규 AWS 리소스·Cognito 업무 종단·두 브라우저·GPU 품질 검증은 별도이며 미실행을 통과로 표기하지 않는다.
