# API 계약 v0.2

`Authorization: Bearer <accessToken>` 인증. `/health`, `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/confirm`, `/auth/resend-confirmation`은 공개 경로이며 refresh에는 별도 Cognito refresh credential이 필요합니다. 기존 DEV_TOKEN 및 userId 헤더 방식은 제거했습니다. 요청은 JSON 객체, 오류는 `{error, code}`입니다. 작성자·소유자·생성 ID를 요청에서 위조할 수 없습니다.

로컬 로그인 토큰은 8시간, Cognito는 템플릿 기준 1시간 유효합니다. 로그아웃은 로컬 현재 세션 폐기, Cognito 계정의 전체 세션 로그아웃입니다. Cognito에서는 가입 후 이메일 코드 확인이 필요합니다. 로컬 confirm은 사용하지 않습니다.

## 회원·가족·고령자

| 메서드 | 경로 | 본문/설명 |
|---|---|---|
| GET | /health | 상태 확인 |
| POST | /auth/register | email, password(8자 이상, 특수문자 최소 1개), name → 201 |
| POST | /auth/confirm | email, code; Cognito 이메일 확인 |
| POST | /auth/login | email, password → accessToken, tokenType, expiresAt, user, refreshToken(Cognito) |
| POST | /auth/refresh | refreshToken → 새 accessToken, expiresAt, user; Cognito 전용 공개 인증 경로 |
| POST | /auth/logout | 빈 객체 |
| GET/PATCH | /me | 프로필 조회/수정; 수정은 name |
| GET/POST | /groups | 내 그룹 목록/생성; name, 선택 elderName |
| GET | /groups/{g} | 그룹 상세, 현재/다음 담당자와 이력 포함 |
| GET | /groups/{g}/members | 구성원 ID·이름·역할·가입일 |
| POST | /groups/{g}/invitations | email, role(caregiver/elder, 기본 caregiver); 소유자만 |
| POST | /invitations/accept | code(6자리 숫자 문자열), 기존 token도 지원; 초대 이메일과 로그인 계정이 일치해야 함 |
| POST | /groups/{g}/leave | 탈퇴; 담당자·예정 일정 배정을 먼저 해제 |
| PATCH | /groups/{g}/ownership | userId; 소유자만 다른 보호자에게 이전 |
| POST | /groups/{g}/elder | name, 선택 birthDate(YYYY-MM-DD/null), note |
| GET/PATCH | /groups/{g}/elder | 고령자 조회/수정; 수정은 name/birthDate/note |
| GET/PATCH | /groups/{g}/assignment | 담당자/이력 조회; 수정은 nextCaregiverId 또는 null |
| POST | /groups/{g}/handover | 선택 nextCaregiverId(기존 다음 담당자 사용 가능), fromDate, toDate |

초대는 48시간 유효한 6자리 숫자 1회용 코드(`code`, 호환용 `token`은 같은 값)을 반환합니다. 사용자가 직접 공유하며 이메일 발송은 하지 않습니다. 그룹 생성과 고령자 등록을 분리할 수 있고 그룹당 고령자 한 명만 허용합니다. 소유자 탈퇴는 소유권 이전 후 가능합니다. 현재 담당자만 다음 담당자를 지정하고 교대할 수 있습니다.

## 돌봄 기록

| 메서드 | 경로 | 본문/설명 |
|---|---|---|
| POST | /groups/{g}/events | content, 선택 type/timestamp/analyze |
| GET | /groups/{g}/events | 선택 쿼리 from, to, type; 시간 오름차순 |
| GET | /groups/{g}/events/{id} | 상세 |
| PATCH | /groups/{g}/events/{id} | content/type/timestamp 중 하나 이상, 선택 version |
| DELETE | /groups/{g}/events/{id} | 작성자만 삭제 |
| POST | /groups/{g}/events/analyze | content → 저장 전 분석 결과 |
| POST | /groups/{g}/events/{id}/analyze | 기존 기록 재분석 및 분석 결과 저장 |

type: hospital, medication, meal, life, schedule, observation. 이전 타입 homecoming, care_center도 지원합니다. 시스템 전용 이벤트는 handover, approval 등입니다. 발생 시간은 ISO 8601 시간대 필수, 미래 기록은 차단합니다. 작성자만 수정·삭제하며 시스템 이력은 보호합니다.

`type` 생략 또는 `analyze: true`이면 분석합니다. 분석 장애 시 수동 type이 있으면 경고와 함께 저장하고, 없으면 502와 유형 선택 안내를 반환합니다. 결과는 `analysis: {mode, type, facts:[{text,quote}], followUp:[{text,quote}]}`에 저장합니다. 수정하면 이전 analysis를 지워 오래된 분석이 남지 않도록 합니다. 분석만 재실행하면 사용자 선택 type은 자동 변경하지 않습니다.

## 일정

| 메서드 | 경로 | 본문/설명 |
|---|---|---|
| POST | /groups/{g}/schedules | title, scheduledAt, 선택 type/caregiverId |
| GET | /groups/{g}/schedules | 선택 view(today/next), status, from, to |
| GET | /groups/{g}/schedules/{id} | 상세 |
| PATCH | /groups/{g}/schedules/{id} | title/type/scheduledAt/caregiverId/status 중 하나 이상, 선택 version |
| DELETE | /groups/{g}/schedules/{id} | 소프트 삭제, 대기 승인 요청 종료 |

type: hospital/examination/visit/care_center/medication/other. 상태: scheduled/completed/cancelled. 그룹 보호자는 직접 수정·완료·취소할 수 있습니다. 고령자 역할은 직접 변경할 수 없습니다. 취소는 삭제와 별개로 목록에 남습니다. today는 서울 날짜 기준 전체 당일 일정, next는 현재 이후 예정 일정 1개를 배열로 반환합니다. version을 보내면 이전 조회 버전과 다를 때 409로 거절합니다.

## 인수인계

| 메서드 | 경로 | 본문/설명 |
|---|---|---|
| POST | /groups/{g}/handoffs | 선택 fromDate/toDate/toCaregiverId |
| GET | /groups/{g}/handoffs | 생성 순서 역순 이력 |
| GET | /groups/{g}/handoffs/latest | 가장 최근 저장 결과 |
| GET | /groups/{g}/handoffs/{id} | 생성 당시 결과와 근거 |
| POST | /groups/{g}/handoffs/{id}/regenerate | 선택 fromDate/toDate/toCaregiverId; 새 결과 생성 |
| POST | /groups/{g}/handoffs/{id}/acknowledge | 인수 보호자 확인, 중복 확인은 1회 저장 |

기본 기간은 최근 7일, 최대 기간 길이는 90일이며 과거 기간을 지정할 수 있습니다. 인수 보호자 기본값은 다음 담당자, 없으면 현재 담당자입니다. 기간 내 보호자 기록이 없으면 **422 NO_CARE_EVENTS**와 `요약할 돌봄 기록이 없습니다.`를 반환합니다. 시스템 일정 등록 이력만 존재해도 요약을 생성하지 않습니다. AI 오류는 **502 HANDOFF_GENERATION_FAILED**, 저장·교대는 롤백되고 원문 기록은 유지됩니다.

응답: id, elderId, fromCaregiverId, toCaregiverId, fromDate, toDate, healthSummary, lifeSummary, scheduleSummary, followUp, evidence, sourceEvents, sourceSchedules, mode, modelId, createdAt, createdBy, acknowledgements, regeneratesId.

재생성은 원래 결과를 덮어쓰지 않습니다. 원문 수정/삭제 이후에도 인수인계 당시 근거 스냅샷은 보존됩니다. 원문 삭제와 모든 파생 기록의 영구 삭제는 다른 작업입니다. 교대 시 기록이 있으면 같은 트랜잭션에서 인수인계를 생성하고, 없으면 담당자만 변경합니다.

## 확장 기능

- GET/POST `/groups/{g}/approvals`: 조회/요청 생성(scheduleId, action: cancel/reschedule, reason, reschedule은 proposedAt 필수).
- PATCH `/groups/{g}/approvals/{id}`: decision: approve/reject/call. 현재 담당자만. call은 연락 필요 표시이며 발송하지 않습니다.
- POST `/groups/{g}/assistant`: question. DB 기반 제한된 한국어 병원·복약·방문·일정/담당자 조회. 날짜 표현은 오늘·내일·모레·이번 주·다음 주를 한국 시간 기준으로 해석하며(주는 월~일), 해당 범위에 일정이 없으면 없다고 답합니다. 월간·특정 날짜 등 그 밖의 기간 표현은 지원하지 않습니다.
- POST `/groups/{g}/assistant/voice`: audioBase64(base64 오디오, 기본 4MB 이하), 선택 mimeType. [fcc-ai](https://github.com/FamilyCareCloud/fcc-ai)의 GPU STT(`feature/stt-service`, Whisper-small+LoRA)로 전사한 뒤 `/groups/{g}/assistant`와 동일한 DB 근거 답변을 반환합니다. 응답에 `transcript`가 추가됩니다. `STT_SERVICE_URL` 미설정 시 **503**, STT 서버 연결 실패/오류 시 **502**, 인식 결과가 비어있으면 **422**, 오디오가 `AUDIO_MAX_BYTES`(기본 4MB)를 넘으면 **413**입니다. fcc-ai는 로컬 GPU 환경에서 별도 프로세스(uvicorn)로 실행해야 합니다.

## 데이터·오류 계약

API의 `id`는 엔티티별 eventId/scheduleId/careGroupId/handoffId에 해당합니다. 중첩 관계는 group.elder와 각 리소스 elderId로 표현합니다. 목록은 현재 소규모 MVP 범위에서 전체 배열을 반환합니다.

성공은 일반 요청 200, 그룹·기록·일정·초대·고령자·인수인계 생성 201. 오류는 400(검증), 401(인증), 403(권한), 404(없음/다른 그룹), 409(충돌), 413(용량), 422(요약 기록 없음/음성 미인식), 429(로그인 제한), 502(AI·STT 실패), 503(인증/AWS 초기화/STT 미설정), 500(저장 등 내부 실패).

로컬 프론트 개발 서버는 백엔드로 프록시하세요. AWS CORS 허용 Origin은 배포 파라미터로 지정합니다. 민감한 응답에는 Cache-Control: no-store가 적용됩니다.

회원가입 정책·오류 코드·인증 재개·재전송 제한은 [인증 API 상세 계약](AUTH_API.md)을 참고하세요.

초대 수락 요청은 로그인 사용자당 15분 동안 5회까지 가능합니다(성공·실패 모두 포함). 초과 시 `429 INVITATION_ATTEMPT_LIMIT`, `details.retryAfterSeconds`, `details.retryAvailableAt`를 반환합니다. 선행 0 유지를 위해 코드는 문자열로 전송하세요. 기존에 발급된 긴 토큰은 `token` 필드로 만료 전까지 사용할 수 있습니다.
