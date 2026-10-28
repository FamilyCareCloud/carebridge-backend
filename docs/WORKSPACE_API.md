# CareBridge 기관 업무 API v1

2026-10-29. `CareBridge-기능명세서-v1.0.md` 및 `CareBridge-UseCase-v1.0.md` 기준 로컬 구현.
기준 코드는 `origin/develop@03f667d`. 기존 FCC 데이터와 역할은 자동 이전하지 않는다.
이 문서는 새 `/workspaces` 계약이며 `/groups/{id}/carebridge`의 기존 계약과 구분한다.

## 실행

Node.js 22 이상에서 `pnpm install --frozen-lockfile`, `node --env-file=.env src/server.js`.
`.env.example`을 복사해 `.env`를 준비한다. 별도 프로세스의 실제 AI 서버가 필요하며 미설정 시 생성·QA·전사는 503이다.
현재 저장소에는 프론트엔드나 GPU 모델이 없다. 기존 `/health`의 `aiConfigured`는 주소 설정 여부이고 모델 가동·번역 품질의 보증이 아니다.

새 가입은 `POST /workspace-auth/register`:

```json
{"email":"author@example.com","password":"직접 지정한 비밀번호","name":"작성자","role":"author"}
```

역할은 `author`(1), `reviewer`(2), `viewer`(3). 로그인·내 계정·로그아웃은 `/auth/login`, `/me`, `/auth/logout`을 재사용한다.
새 계정은 응답의 `workspaceRole` 및 `role`에 고정 역할을 갖는다. 프로필 API는 이름만 수정한다.
기존 클라이언트를 위한 `/auth/register`는 역할 없는 기존 가입도 유지하지만, 이런 계정은 기관 API에서 `403 ROLE_ASSIGNMENT_REQUIRED`다(D02). 고정 역할을 가진 계정은 기존 `/groups`와 역할 변경 API에 접근할 수 없다.
Cognito는 가입 성공의 UserSub에 역할을 서버 저장하고, 인증 후 같은 sub에만 연결한다. 가입 이후 역할 저장 실패·발송 응답 유실로 역할 연결이 없는 계정은 자동 매핑하지 않으며 별도 복구가 필요하다.

## 작업 그룹·참여·대상자

모든 업무 요청은 `Authorization: Bearer <accessToken>`이 필요하다. `{w}`는 workspaceId다.

| 메서드·경로 | 입력·결과 |
|---|---|
| POST /workspaces | `{name}` → 그룹·정식 담당자·inviteCode·revision |
| GET /workspaces | 본인의 소속, 최신 참여 요청, 본인 앞으로 온 pending transfers |
| GET /workspaces/{w} | 그룹 정보·본인 역할. 초대코드는 검토자에게만 제공 |
| POST /workspaces/join-requests | `{code}` → pending 요청. 같은 대기 요청은 같은 requestId |
| GET /workspaces/{w}/join-requests | 검토자용 전체 참여 요청 이력 |
| POST /workspaces/{w}/join-requests/{requestId}/approve | `{expectedVersion}` → 신청 당시 고정 역할로 승인 |
| POST /workspaces/{w}/join-requests/{requestId}/reject | `{expectedVersion}` → 거절. 재요청 시 새 요청 ID |
| GET /workspaces/{w}/members | 검토자용 활성 1·3그룹 목록 |
| DELETE /workspaces/{w}/members/{userId} | `{expectedVersion: 그룹 revision}` → 퇴출. 제출·검토 이력 유지 |
| POST /workspaces/{w}/subjects | 검토자 전용 `{name,memo?}` → 서버 순번 managementNumber |
| GET /workspaces/{w}/subjects?q=이름 | 작성자·검토자 목록. 작성자 응답은 ID·이름·번호만 |
| GET /workspaces/{w}/access | 현재 역할·revision. 활성 권한 재검증 |

대기자는 업무 데이터를 읽지 못한다. 열람자는 대상자·참여자·제출·검토 목록을 읽지 못한다.
대상자 번호는 동일 그룹의 원자적 트랜잭션에서 증가한다. 동명이인을 허용한다. 수정·삭제·번호 재사용 API는 D08 결정 전 제공하지 않는다.

## 생성·독립 제출·검토

| 메서드·경로 | 입력·결과 |
|---|---|
| POST /workspaces/{w}/drafts | `{memo,sourceLanguage?,dataUse:"synthetic_deidentified"}` → generationId, sourceHash, 원본 draft |
| POST /workspaces/{w}/transcriptions | `{audioBase64,sourceLanguage?,dataUse:"synthetic_deidentified"}` → text, requiresTranscriptReview:true |
| POST /workspaces/{w}/submissions | 아래 제출 예시. 새 제출 스냅샷 생성 |
| GET /workspaces/{w}/submissions | 작성자는 본인 요약만, 검토자는 전체 요약 |
| GET /workspaces/{w}/submissions/{s} | 불변 원문·생성본·작성자 편집본, 별도 검토본·검토 이력 |
| POST /workspaces/{w}/submissions/{s}/review | `{expectedVersion,decision:"edit"|"hold"|"confirm",content?,reason?,confirmSource?,confirmChecks?}` |
| POST /workspaces/{w}/submissions/{s}/check | `{expectedVersion}` → 저장된 최종 검토본의 의미 QA |

```json
{
  "requestId":"사용자 전송 동작별 고유 ID",
  "subjectId":"대상자 ID",
  "generationId":"현재 원문의 생성 ID",
  "memo":"식사를 절반 드셨습니다.",
  "authorDraft":"식사를 절반 드셨습니다.",
  "confirmSource":true,
  "parentSubmissionId":"재전송일 때만 이전 제출 ID"
}
```

생성은 제출이 아니다. 생성 결과는 원문 해시·작성자·기관에 귀속되며, 원문 변경 후에는 새 생성이 필요하다.
작성자는 authorDraft를 직접 편집해 제출할 수 있다. 전사 결과도 별도로 확인·수정해 drafts에 전송한다. 음성을 바로 제출하지 않는다.
같은 requestId와 동일 본문 재시도는 처음 제출 결과를 반환한다. 다른 내용으로 재사용하면 409다. 재전송은 새 requestId를 사용하고, parentSubmissionId로 같은 threadId에 연결한다. 부모와 자식은 같은 작성자·대상자여야 한다.
제출별 상태는 `review_pending / held / confirmed`이며 이전 제출을 자동 대체하지 않는다.
보류 reason은 필수다. 검토의 content와 이력은 제출 원문·생성본을 덮어쓰지 않는다.

확정은 원문·확인사항 확인 플래그, 최신 version, 최종 내용 해시와 연결된 QA 통과를 모두 요구한다. QA 장애·불완전 응답·hold는 확정하지 않는다. AI 원출력의 QA와 사람이 결정한 status는 별도 필드다.
검토본을 edit로 저장 → check → confirm 순서다. 검사 후 edit하면 다시 검사한다. 본인 제출은 검토할 수 없다.
현재 편집본 QA 연결은 생성 구간 수를 유지한 줄별 편집만 지원한다. 구간 추가·삭제는 `422 EDITED_EVIDENCE_REQUIRED`로 거절하고 D10 계약을 요구한다. 줄과 근거의 의미 대응은 외부 의미 QA가 검사하며, 실제 모델 평가 완료를 뜻하지 않는다. qa.v2 미병합 개선을 적용했다고 주장하지 않는다.

## 별도 공개

| 메서드·경로 | 입력·결과 |
|---|---|
| POST /workspaces/{w}/publications | `{submissionId,expectedVersion: 확정 제출 버전,content,recipientIds:[활성 열람자 ID]}` → unpublished |
| GET /workspaces/{w}/publications | 검토자는 관리 목록, 열람자는 자신에게 공개 중인 기록만 |
| GET /workspaces/{w}/publications/{p} | 관리 상세 또는 허용된 공개 필드만 |
| PATCH /workspaces/{w}/publications/{p} | `{expectedVersion,content?,recipientIds?}` → 내용 정정은 기존 권한 차단 |
| POST /workspaces/{w}/publications/{p}/publish | `{expectedVersion}` → 확정 버전·현재 담당자·활성 수신자 재검증 후 공개 |
| POST /workspaces/{w}/publications/{p}/revoke | `{expectedVersion}` → 전체 열람 차단 |

열람자 응답 허용 필드는 `publicationId, version, subject:{subjectId,name,managementNumber}, content, publishedAt`뿐이다.
확정·공개 준비·내용 정정만으로 공개되지 않는다. 재공개도 명시적 publish가 필요하다. 수신자는 항상 직접 선택하고 자동 가족 연결을 만들지 않는다.
정정·철회·공개 버전 및 행위자 이력을 유지한다. 퇴출 시 활성 수신 권한을 제거하고 과거 제출을 보존한다.

## 열린 화면 차단: 로컬 SSE 계약

`GET /workspaces/{w}/events`에 Bearer 인증을 붙여 fetch 스트림으로 연결한다(브라우저 기본 EventSource는 Authorization 헤더를 지원하지 않음).

| 이벤트 | 프론트 처리 |
|---|---|
| revalidate | 최초 연결. 권한·목록·상세 재조회 완료 전 본문 숨김 |
| invalidate | 기관 데이터 또는 세션 변경. 모든 열린 탭의 본문·미리보기·캐시를 먼저 지우고 재조회 |
| access-revoked | 본문·캐시 제거, 접근 차단 안내. 서버가 연결 종료 |
| 연결 오류·단절 | 본문 숨김, 재연결 후 재검증. 오래된 본문 자동 복원 금지 |

이벤트는 `{}`만 전송하고 업무 내용·타 수신자 ID를 포함하지 않는다. HTTP 서버는 성공한 변경 커밋 후 이벤트를 전달하며, 20초 주기로 세션도 재검증한다. 공개 철회는 변경 직후 이벤트로 알린다.
새 API 조회는 모든 요청에서 권한을 검증하고 HTTP 응답은 no-store다.
프론트의 탭 복귀·뒤로 가기·화면 복원 처리와 실제 화면 숨김은 별도 구현이 필요하다. 브라우저 두 탭 수용 검증이나 지연 SLA는 아직 실행·합의하지 않았다(D07).
이 이벤트 버스는 **단일 프로세스 로컬 HTTP 전용**이다. API Gateway/Lambda에는 SSE 경로를 제공하지 않는다. 다중 인스턴스 배포 전 공유 이벤트 전송 계층이 필요하다. Lambda 환경에 이 구현을 그대로 배포해 실시간 철회가 완성됐다고 판단하지 않는다.

## 관리자 이전·미결정 설정

일반 사용자에게 역할 변경 API를 제공하지 않는다. 정식 담당자는 그룹당 한 명이며 이전은 별도 흐름이다.

1. 현 담당자: `POST /workspaces/{w}/transfers`에 `{expectedVersion:그룹 revision,targetUserId:다른 고정 reviewer}`.
2. 대상자: GET /workspaces의 transfers에서 요청 확인 후 `POST /workspaces/{w}/transfers/{t}/accept`에 `{expectedVersion:이전 요청 버전}`.
3. 이전 완료 전 현 담당자는 `/transfers/{t}/cancel`에 같은 버전 형식으로 취소할 수 있다.

이전 완료는 소유자와 상태를 원자적으로 바꾸며 구 담당자의 관리 접근을 종료한다. 과거 검토 행위자는 바꾸지 않는다.

로컬 `src/server.js`의 opt-in 설정:

| 환경 변수 | 기본값·의미 |
|---|---|
| CAREBRIDGE_MULTIPLE_WORKSPACES | false. 복수 가입·생성은 D03 결정 전 POLICY_REQUIRED |
| CAREBRIDGE_TRANSFER_ENABLED | false. true는 위 지정·수락·취소 방식을 로컬에서 평가할 때 사용(D04) |
| CAREBRIDGE_CONFIRMATION_ENABLED | false. true로 설정해도 최신 최종본 의미 QA 통과가 필수(D10) |
| CAREBRIDGE_RECIPIENT_CHANGE | 미설정. 공개 중 수신자 변경은 POLICY_REQUIRED. `block_all`은 모두 차단 후 재공개, `retain`은 유지 수신자 권한만 유지(D06) |

기능 브랜치에서는 테스트 계정 예외를 제공하지 않는다. `test` 브랜치 전용 구현은 [TEST_ACCOUNT.md](TEST_ACCOUNT.md)를 참고한다.

D01 실제 정보 AI 처리, D02 기존 계정 이전, D08 대상자 변경, D09 자동 저장·복구, D11 퇴출 후 재가입, D12 음성 출시 범위는 미확정이다. 현재 지원하지 않는 동작을 자동 허용하지 않는다. 초안 생성본은 원문 연결용으로 저장하지만 작성 중 자동 저장 완료를 의미하지 않는다. 사용자 역할·원문을 재분류하거나 실데이터를 synthetic으로 속여 전송하지 않는다.

## 검증 및 저장 한계

`node --test`로 기존 회귀 테스트와 `tests/workspaces.test.js`를 함께 실행한다. 새 테스트는 역할·기관 경계, 승인·거절·재요청, 동시 번호 할당, 독립 제출·멱등성·원문 해시, 보류·버전 충돌, 수신자 분리·정정·철회·퇴출, 담당자 이전, AI 장애·권한 변경 경합, 실제 로컬 HTTP SSE를 검증한다.
AI 응답은 합성 모의 데이터다. 실제 GPU 전사·번역·의미 QA 품질, 실운영 Cognito/DynamoDB 연결, PC·모바일 화면은 검증하지 않았다.

로컬 JSON Store와 기존 DynamoStore 트랜잭션 인터페이스를 사용한다. 작업 그룹 메타데이터·목록·검토·공개 이력은 단일 aggregate이며 기존 350KB 한도 도달 시 413으로 전체 변경을 롤백한다. 불변 제출·생성본은 별도 키로 보관한다. 운영 규모 확장에는 인덱스·이력 분할과 페이지네이션이 필요하다. 기존 데이터 초기화·배포·Git push는 실행하지 않는다.
