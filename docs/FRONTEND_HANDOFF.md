# 프론트 팀 전달: 백엔드·AI 추가 구현 현황

기준일: 2026-10-27. 교육용 가상·비식별 관찰 메모의 케어브릿지 흐름을 구현했다.
현재 구현·배포된 기능과 번역 검증에서 발견한 문제를 함께 공유한다.

## 반영·배포 현황

| 저장소 | 기능 반영 기준 | 구현 PR |
| --- | --- | --- |
| fcc-ai | main | [GPU 번역·의미 재검사·편집 가능한 전사 API #4](https://github.com/FamilyCareCloud/fcc-ai/pull/4) |
| fcc-backend | develop | [비공개 초안·역할·버전·승인·가족 미리보기 #6](https://github.com/FamilyCareCloud/fcc-backend/pull/6) |
| fcc-frontend | develop | [케어브릿지 화면 #10](https://github.com/FamilyCareCloud/fcc-frontend/pull/10), [모바일 메뉴·스크롤 수정 #11](https://github.com/FamilyCareCloud/fcc-frontend/pull/11) |

위 기능 PR은 모두 병합됐다. 이번에 추가하는 것은 이 전달 문서와 AI 번역 평가 자료다.
기존 프론트 구현과 API 클라이언트가 develop에 있으므로, 이를 기준으로 화면을 이어서 수정하면 된다.

- [프론트 개발 배포](https://develop.db2l4u9y804jp.amplifyapp.com/)
- [백엔드 API](https://uwv0zhujxf.execute-api.ap-northeast-2.amazonaws.com)
- [백엔드 상태 확인](https://uwv0zhujxf.execute-api.ap-northeast-2.amazonaws.com/health)

기준일에 프론트·백엔드·GPU 서버의 HTTP 200 응답을 확인했다.
AI는 RTX 5070 Ti가 있는 로컬 PC에서 실행 중이며, 보호된 HTTPS 터널을 통해 AWS가 호출한다.
PC가 꺼지거나 임시 터널 주소가 바뀌면 AI 처리가 실패할 수 있다. 상시 운영 환경은 별도로 필요하다.

## 추가한 기능

### AI

- 음성을 먼저 전사문으로 반환한다. 작성자가 내용을 확인·수정한 뒤 초안을 생성한다.
- Whisper 기반 전사와 Qwen3-8B 4bit 기반 다국어→한국어 번역이 로컬 GPU에서 동작한다.
- 한국어 번역, 식사·수분·이동·수면·위생·복약 관찰·상태 관찰·기타 분류,
  추가 확인 항목, 원문 인용과 위치, QA 결과를 구조화해서 반환한다.
- 원문 무결성·구간 누락·숫자·부정·추측 등에 대한 검사와 모델의 의미 재검사를 수행한다.
- AI는 승인하지 않는다. 결과는 검토 전 초안이며, 동일 모델 재검사는 정확도 증명이 아니다.

### 백엔드

- 그룹별 작성자(author)·검토자(reviewer)·가족 열람자(family) 권한을 확인한다.
- 메모 생성/목록/상세, 번역 수정, 재검사, 승인/보류, 버전 이력,
  승인된 현재 버전의 가족 미리보기 API를 추가했다.
- 최초 원문·해시·근거 위치를 보존하고, 변경 사유와 버전 스냅샷을 저장한다.
- 자신이 작성한 메모는 다른 검토자가 승인해야 한다.
- 수정·재검사·보류 시 기존 승인을 철회한다. 재승인 전 가족에게 이전 승인본도 반환하지 않는다.
- 중복 생성 요청과 동시에 발생하는 수정·권한 변경·승인 철회를 서버에서 검증한다.
- 편집·검사·승인 중 AI가 실패하면 통과로 바꾸지 않는다. 수동 보류는 AI 장애 중에도 가능하다.
- 가족 미리보기는 승인된 관찰 문장만 반환한다. 원문·검토 전 초안·검토 사유는 포함하지 않는다.

## 프론트 연결 기준

프론트 환경변수:

```dotenv
VITE_API_BASE_URL=https://uwv0zhujxf.execute-api.ap-northeast-2.amazonaws.com
```

기존 로그인 토큰을 `Authorization: Bearer <accessToken>`으로 전달한다.
AI 서비스 키와 GPU 터널 주소는 백엔드가 관리한다. 프론트 환경변수에 넣지 않는다.

기본 경로는 `/groups/{groupId}/carebridge`다.
실제 프론트 클라이언트·타입은
[fcc-frontend/src/carebridge-api.ts](https://github.com/FamilyCareCloud/fcc-frontend/blob/develop/src/carebridge-api.ts)를 참고한다.
백엔드 요청은 camelCase, 응답 draft 내부 AI 계약은 snake_case가 섞여 있으므로 기존 타입을 사용한다.

| 동작 | 메서드·하위 경로 | 핵심 요청/응답 |
| --- | --- | --- |
| 내 역할·구성원 역할 확인 | GET /roles | myRole, canManage, aiEnabled, version, roles |
| 보호자 구성원의 역할 변경 | PATCH /roles | expectedVersion, userId, role |
| 음성 전사 | POST /transcriptions | audioBase64, sourceLanguage, dataUse → text, requiresTranscriptReview |
| 메모 생성 | POST /notes | memo, sourceLanguage, requestId(UUID), inputKind(text/transcript), dataUse |
| 작성자 본인/검토자 목록 | GET /notes | items, nextCursor |
| 초안 상세 | GET /notes/{id} | note 최상위 status/version, draft, qa, history |
| 번역 편집 | PATCH /notes/{id} | expectedVersion, reason, segments |
| QA 재검사 | POST /notes/{id}/check | expectedVersion |
| 승인·보류 | POST /notes/{id}/review | expectedVersion, decision(approve/hold), reason, confirmSource, confirmChecks |
| 버전 이력/스냅샷 | GET /notes/{id}/versions[/{version}] | 메타데이터 또는 해당 버전 draft |
| 가족용 승인 목록 | GET /family | 승인 메타데이터 목록 |
| 가족 미리보기 열기 | GET /notes/{id}/preview | 승인된 현재 버전의 관찰 문장 |

생성·전사 요청에는 `dataUse: "synthetic_deidentified"`가 필수다.
메모는 4,000자·40줄 이내로 보낸다. 음성은 30초 이하 PCM WAV를 Base64 문자열로 전달한다.
전사된 text는 먼저 편집 가능한 입력창에 보여주고, 작성자가 확인한 내용으로
`inputKind: "transcript"` 메모를 생성한다.
동일한 생성 요청의 재시도에는 같은 requestId를 쓰며, 원문이 달라지면 새 requestId를 만든다.

### 상태·권한 처리

- 화면의 승인 상태는 **note 최상위 status**를 사용한다:
  review_required(검토 대기), hold(보류), approved(담당자 승인).
  `draft.status`는 AI 초안 상태이므로 최종 승인 상태와 다를 수 있다.
- AI의 `qa.external_share_allowed`는 항상 false다. 이를 클라이언트에서 바꾸지 않는다.
  가족 열람 가능 여부는 승인된 현재 버전을 확인하는 백엔드 preview API가 결정한다.
- 역할은 `GET /roles` 결과를 사용한다. 기본 매핑은 그룹 소유자→reviewer,
  보호자→author, 고령자→family다. 보호자의 CareBridge 역할은 소유자가 변경할 수 있다.
- 메모 수정·재검사·승인·보류에는 현재 note.version을 expectedVersion으로 보낸다.
  역할 변경에는 roles 응답의 version을 사용한다. 성공 후 새 응답의 버전을 다시 반영한다.
- 승인에는 사유와 원문 대조 확인이 필요하고, 추가 확인 항목이 있으면 확인 완료도 필요하다.
  자기 작성 메모를 직접 승인하면 403으로 거절된다.
- 원문/해시/인용 위치/status/QA/approvedVersion은 편집 요청에 넣지 않는다.
  번역 편집은 segments의 segmentId, text, category, needsConfirmation만 전달한다.
- 근거 위치는 Unicode 코드 포인트 기준이다. JS에서 강조 표시할 때는
  `Array.from(source.text).slice(start, end).join("")`처럼 처리해야 이모지에서도 위치가 맞는다.

### 오류 처리

| 응답 | 화면 처리 |
| --- | --- |
| 401 | 로그인 상태 확인 |
| 403 | 작성/검토 권한 또는 자기 승인 여부 안내 |
| 409 + CAREBRIDGE_STALE_VERSION | 최신 메모·버전을 다시 불러오고 사용자에게 충돌 안내 |
| 409 + CAREBRIDGE_QA_HOLD | QA 보류 사유를 보여주고 원문 대조·수정 필요 안내 |
| 409 + CAREBRIDGE_NOT_APPROVED | 가족 미리보기 중단, 승인 목록 새로고침 |
| 400/413/422 | 입력·오디오 길이·가상/비식별 확인 항목 안내 |
| 502/503 | 입력을 유지하고 처리 실패/재시도 안내. 성공·승인으로 표시하지 않음 |

일반적인 409도 있으므로 code가 없으면 서버의 error 메시지를 표시하고 현재 상태를 확인한다.
요청 실패를 임의의 번역이나 승인 상태로 대체하지 않는다.

## 번역 품질: 현재 확인된 한계

영어·베트남어·인도네시아어 합성 메모 36건을 고정 기준문과 대조했다.
AI 검토 기준 의미 보존 29건, 의미 오류/모호한 한국어 5건, 생성 실패 2건이었다.
일부는 “피곤함→어색함”, “수프를 먹지 않음→식사를 하지 않음”으로 의미가 달라졌다.

별도의 의도적 오역 27건 중 24건은 보류했고,
“도움을 받아 걸었다”에서 도움을 받았다는 사실을 뺀 3건은 놓쳤다.
실제 생성 결과에서는 올바른 번역을 보류한 오탐도 6건 있었다.
반환된 초안은 모두 사람 검토 필수·외부 공유 불허였지만, QA 자체가 의미 정확성을 보장하지는 않는다.

이 결과는 작은 합성 집합의 AI 대조이며 원어민 전문가 검증이나 일반 정확도 점수가 아니다.
화면에는 원문·번역·QA를 함께 표시하고 검토 전 초안임을 유지해야 한다.
베트남어·인도네시아어 번역과 사실 누락 검사, 오탐 감소가 다음 개선 과제다.
품질 검증 자료는 AI 저장소의 `docs/TRANSLATION_EVALUATION.md`와
`evaluation/translation-*.json`에 제공한다.

## 팀 확인 순서

1. develop의 기존 케어브릿지 화면과 API 클라이언트를 확인한다.
2. 같은 그룹에 작성자와 별도 검토자를 준비해 메모 생성→수정→승인 흐름을 확인한다.
3. 가족 계정에서 승인된 현재 버전만 열리는지 확인한다.
4. 승인된 메모를 수정/재검사/보류한 후 가족의 새 미리보기 열람이 차단되는지 확인한다.
5. 번역 보류·버전 충돌·AI 장애 시 입력 보존과 안내를 확인한다.

전체 API·저장·권한 계약은 [CAREBRIDGE.md](CAREBRIDGE.md)에 있다.
