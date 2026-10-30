# 케어브릿지: 메모부터 가족 미리보기까지

교육용 가상·비식별 메모를 위한 구현이다. 의료 판단·공식기록·자동 전송 기능이 아니다.
프론트의 **케어브릿지** 메뉴가 아래 서버 흐름에 연결된다.

1. 작성자가 언어와 가상·비식별 입력 여부를 확인하고 메모를 남긴다.
2. 음성은 먼저 전사문만 반환하며 작성자가 확인·수정한 뒤 초안을 생성한다.
3. AI는 한국어 번역·관찰·추가확인·원문 인용·QA를 반환한다.
4. 담당 검토자가 원문을 대조하고 사유와 함께 승인·수정·보류한다.
5. 그룹 가족은 승인된 현재 버전만 직접 눌러 미리보기 한다.
6. 수정/재검사는 기존 승인을 철회한다. 재승인 전에는 이전 승인 버전도 가족에게 반환하지 않는다.

## 권한

그룹 멤버십과 별도의 CareBridge 역할을 서버에서 확인한다.

| 역할 | 기본 대상 | 가능한 작업 |
| --- | --- | --- |
| reviewer | 그룹 소유자 | 모든 초안/버전 검토, 수정, 승인/보류 |
| author | 보호자 | 작성, 본인 초안/버전 조회·수정 |
| family | 고령자 | 승인된 현재 버전의 수동 미리보기 |

소유자는 보호자 구성원의 CareBridge 역할을 변경할 수 있다. 소유자/고령자 역할은 고정이다.
자기 작성 메모를 스스로 승인할 수 없다. 다른 검토자가 필요하면 보호자를 초대해 reviewer로 지정한다.
AI 서버 키는 백엔드에만 있으며 프론트에는 사용자 토큰만 전달한다.

## API

기존 Cognito/로컬 로그인 토큰 `Authorization: Bearer ...`가 필요하다.
기본 경로: `/groups/{groupId}/carebridge`.

| 메서드·경로 | 요청/응답 |
| --- | --- |
| GET /roles | version, myRole, canManage, roles, aiEnabled |
| PATCH /roles | expectedVersion, userId, role(author/reviewer/family) |
| POST /transcriptions | audioBase64(PCM WAV, 30초 이하), sourceLanguage, dataUse → text, requiresTranscriptReview |
| POST /notes | memo, sourceLanguage, requestId(UUID), inputKind(text/transcript), dataUse → 비공개 초안 |
| GET /notes | 검토자 전체 또는 작성자 본인 목록. limit=1~50, cursor |
| GET /notes/{id} | 권한이 있는 초안/QA/버전 이력 |
| PATCH /notes/{id} | expectedVersion, reason, segments[{segmentId,text,category,needsConfirmation}] |
| POST /notes/{id}/check | expectedVersion → QA 재검사, 승인 철회 |
| POST /notes/{id}/review | expectedVersion, decision(approve/hold), reason, confirmSource, confirmChecks |
| GET /notes/{id}/versions | 비공개 버전 메타데이터 목록 |
| GET /notes/{id}/versions/{version} | 보존된 원문·초안/QA 스냅샷 |
| GET /family | 승인 메타데이터 목록. 원문·초안은 포함하지 않음 |
| GET /notes/{id}/preview | 승인된 현재 버전의 관찰 문장만 반환 |

`dataUse=synthetic_deidentified`가 필수다. 전사문은 저장된 메모가 아니며 사람이 확인한 텍스트가 생성 시 원문으로 고정된다.
입력은 최대 4,000자/40줄. 음성 요청은 JSON 4MiB 이내이며 디코딩 오디오 상한은 3MiB보다 작게 제한한다.
나머지 CareBridge 요청 본문 상한은 256KiB다. 원문/관찰 구간이 길면 나눠 입력한다.
개별 초안 응답은 240,000바이트로 제한한다. 교육용 그룹당 500개 메모, 메모당 500개 버전 상한이다(승인 차단을 위한 수동 보류는 예외). 사유 전문은 불변 버전 스냅샷에, 목록에는 짧은 요약만 저장한다.

## 승인과 근거 보호

- 최초 원문/UTF-8 SHA-256과 Unicode 코드 포인트 기준 인용 위치를 서버가 검증·보존한다.
- 클라이언트는 source, qa, status, approvedVersion 등을 쓸 수 없다. 편집 API는 번역/분류/추가확인 여부만 받는다.
- 편집과 승인 시 서버에 저장된 초안을 AI `/carebridge/qa/semantic`로 다시 검사한다.
- 구조 검사·의미 검사 응답이 잘렸거나 누락됐으면 승인하지 않는다. 모델 연결 실패를 통과로 대체하지 않는다.
- QA 보류 사유를 무시하고 승인하는 API는 없다. 보류는 모델 장애 중에도 가능하다.
- AI 호출 전후에 그룹/역할/버전을 확인한다. 최종 저장은 DynamoDB 조건부 트랜잭션으로 경쟁을 차단한다.
- 보호된 초안·버전·가족 미리보기 읽기도 모든 읽은 버전을 원자적으로 재확인한다.
  조회 중 승인 철회/권한 변경이 발생하면 409로 실패한다.
- 원문과 스냅샷은 별도 레코드에 저장하므로 일반 `GET /groups/{g}`에는 비공개 메모가 섞이지 않는다.
- 이 구현은 미리보기만 제공하며 자동 가족 발송·외부 공유/내보내기 경로는 제공하지 않는다.

메모의 version은 생성·수정·재검사·승인·보류마다 증가한다.
가족 조회는 `status=approved && approvedVersion===version`을 확인한다.
이미 전달된 화면을 원격으로 회수하는 기능은 아니며, 새 열람마다 현재 승인을 확인한다.

## 저장 구조와 오류

동일 DynamoDB 테이블 안의 `carebridge-roles#...`, `carebridge-note#...`,
`carebridge-version#...`, `carebridge-index#...`, `carebridge-request#...`에 분리 저장한다.
기존 사용자/그룹 데이터 이전은 필요 없다. 원문이 다른 동일 requestId 재사용은 409다.
AI 호출이 실패하면 요청을 고정 저장하지 않으므로 같은 ID로 재시도할 수 있다.
동시에 생성하면 조건부 커밋으로 중복 기록을 막는다.

- 401: 로그인 필요, 403: 역할 부족, 404: 타 그룹/없는 메모
- 409: 버전 충돌·QA 보류·현재 버전 미승인
- 413: 본문/저장 한도
- 422: AI 입력 거절(가상·비식별 여부/오디오 확인)
- 502/503: 모델/연결 실패. 입력은 프론트에서 유지한다.

## 로컬 실행

carebridge-ai, carebridge-backend, fcc-frontend를 같은 부모 폴더에 둔다.
실행 스크립트는 carebridge-ai를 우선 선택하고, 없으면 이전 fcc-ai 폴더를 확인한다.
AI qa.v2가 필요하며 적용 순서는 [FIDELITY_V2.md](FIDELITY_V2.md)를 따른다.
AI는 GPU PR과 전사 API까지 포함한 버전을 사용해야 한다.

```powershell
# carebridge-ai: CUDA 환경 준비 후
.\.venv\Scripts\python.exe -m pip install -r requirements-gpu.txt
# models/whisper-senior-lora 어댑터 배치, Qwen 체크포인트 캐시
# carebridge-backend
pnpm install --frozen-lockfile --ignore-scripts
# fcc-frontend
npm ci
# carebridge-backend에서 세 서비스 실행
.\scripts\start-carebridge-local.ps1
```

기본 주소: 프론트 `http://127.0.0.1:5174`, 백엔드 `:3002`, AI `:8002`.
스크립트는 API 키가 없으면 로컬 .env에 생성하고, 로그·로컬 DB·시작한 프로세스 기록을 data/에 저장한다.
다른 포트를 쓰는 프로세스를 종료하지 않으며, 중지는 `scripts/stop-carebridge-local.ps1`로 한다.
가중치/키/DB/합성 음성은 git에 올리지 않는다.

실제 GPU 연동 확인:

```powershell
node scripts/check-carebridge-live.mjs
```

이 스크립트는 루프백 서버에서만 합성 계정과 그룹을 만든다.
검토자 `reviewer@example.test`, 작성자 `author@example.test`, 가족 `family@example.test`,
로컬 데모 비밀번호 `CareBridge!Demo26`으로 프론트에서 각 역할을 확인할 수 있다.
AWS Cognito/운영 환경에는 이 계정을 만들지 않는다.
결과는 `data/carebridge-live-report.json`에 저장되며 정확도·현장 효과 측정이 아니다.
음성 검증에는 AI 레포의 evaluation/synthetic-english.wav가 필요하다(없으면 합성 WAV를 준비).

## AWS 배포 연결

배포는 기존 `develop` → GitHub Actions OIDC → `fcc-backend-dev` 흐름을 유지한다.
새 저장소 설정은 다음과 같다.

- Variable `CAREBRIDGE_SERVICE_URL`: API 키로 보호된 GPU 서비스의 공인 HTTPS 기본 주소
- Secret `CAREBRIDGE_SERVICE_API_KEY`: GPU의 `FCC_AI_API_KEY`와 같은 값
- SAM 파라미터 CarebridgeServiceUrl / CarebridgeServiceApiKey / CarebridgeTimeoutMs(기본 22000)

원래 STT 설정과 분리하므로 기존 음성 비서 설정을 덮어쓰지 않는다.
로컬 실행 스크립트는 외부 터널을 열지 않는다. 새 공인 노출은 별도로 승인·설정해야 한다.
PC가 꺼지거나 터널이 만료되면 작성/검사/승인은 실패하지만 이미 저장된 승인 미리보기와 수동 보류는 동작한다.
생성+의미 검사는 2회 모델 호출이므로 GPU 호출별 시간 한도 10초, 백엔드 22초,
Lambda 29초를 기준으로 짧은 메모를 사용한다. 시간 초과는 성공/자동 승인으로 처리하지 않는다.

프론트는 기존 Amplify/API 주소로 배포하며 AI 주소나 서비스 키를 VITE 변수에 넣지 않는다.

## 검증 범위

자동 테스트는 권한, 원문·근거 위조, 버전 경쟁, 읽기 중 승인 철회,
가족 데이터 최소화, 멱등 생성, AI 장애/실패, 음성 본문 상한을 확인한다.
실제 로컬 GPU 흐름도 별도 실행했다. 검토 시간·번역 정확도·현장/임상 품질을 증명하는 검증은 아니다.
