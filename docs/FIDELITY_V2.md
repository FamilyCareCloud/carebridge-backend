# 이관 후 CareBridge QA v2 적용

저장소는 FamilyCareCloud/carebridge-backend이며, 케어브릿지 구현·배포 기준은 develop이다.
main에는 아직 이전 백엔드가 있으므로 이 브랜치와 혼동하지 않는다.

## 승인 검증 보완

- ASSISTANCE_FACT_PRESERVED와 SEMANTIC_OMITTED_FACTS를 필수 검사에 추가했다.
- 모델을 실행한 의미 검사는 모든 원문 구간의 근거·순서를 보존해야 한다.
- 각 구간에 다섯 의미 검사 코드가 중복 없이 모두 있어야 하며 값은 불리언이어야 한다.
- 전체 검사 결과는 구간별 결과의 집계와 일치해야 한다.
  구간/검사 누락, 다른 원문 인용, 집계 위조는 502로 실패하고 승인·버전을 저장하지 않는다.
- 모델을 생략한 보류는 빈 구간 목록과 실제 구조 검사 실패가 있어야 한다. AI가 명시적 사실 누락을 모델 호출 전에 검사한 경우에는 `SEMANTIC_OMITTED_FACTS=false`와 같은 코드의 `hold` 사유가 함께 있어도 허용한다. 이 경우에도 상태는 반드시 `hold`이며 승인·가족 열람은 계속 차단한다.
- 사실 누락 판정은 QA 보류이므로 승인할 수 없다. 사람 검토도 계속 필요하다.

## 기존 기록과 프론트

새 필수 검사가 없는 이전 승인본의 가족 미리보기는
409 / CAREBRIDGE_RECHECK_REQUIRED를 반환한다.
담당 검토자가 메모를 재검사하고 원문을 대조해 다시 승인하면 열람할 수 있다.
기존 승인 스냅샷을 자동 통과시키거나 수정하지 않는다.

프론트 API 경로와 note.status는 동일하다. QA 목록은 새 코드를 그대로 표시하고,
CAREBRIDGE_RECHECK_REQUIRED이면 재검사·재승인 안내와 목록 새로고침을 제공하면 된다.
원문 인용 위치는 계속 Unicode 코드 포인트 기준이다.

## 로컬 경로와 배포 순서

1. 같은 부모 폴더에 carebridge-ai, carebridge-backend, fcc-frontend를 둔다.
   start-carebridge-local.ps1은 carebridge-ai를 우선 찾고, 없으면 fcc-ai를 확인한다.
   다른 환경은 -AiRepo/-Python/-FrontendRepo를 명시한다.
2. 새 AI에 Python 환경·모델 캐시·Whisper 어댑터를 준비한다. 기존 프로세스와 키를 임의 복사/종료하지 않는다.
3. **AI부터 적용**하고 /health의 carebridge_qa_revision이 carebridge.qa.v2인지 확인한다.
   로컬 시작 스크립트도 이 버전을 확인한 뒤 백엔드를 시작한다.
4. 백엔드를 적용한다. 기존 develop GitHub Actions의 AWS fcc-backend-dev 배포 설정을 사용한다.
5. 기존 승인 메모는 필요하면 재검사·재승인한다.

기존 qa.v2 서비스에 [AI #7](https://github.com/FamilyCareCloud/carebridge-ai/pull/7)의 사전 누락 검사를 추가할 때는 이 백엔드의 호환 변경을 먼저 적용한다. 기존 백엔드는 기본 구조 검사가 모두 통과한 규칙 기반 보류를 잘못된 응답으로 거절한다. 프론트 응답 구조와 `hold` 처리에는 변화가 없다.

실제 GPU 연동 스크립트의 합성 WAV는 carebridge-ai/evaluation에서 찾는다.
CAREBRIDGE_TEST_AUDIO 환경변수로 별도 합성 WAV를 지정할 수도 있다.
키·실제 메모·모델 가중치·로컬 DB는 Git에 올리지 않는다.

검증은 권한·승인·사실 누락·불완전한 의미 검사·집계 불일치·기존 승인본 재검사 흐름을 포함한다.
자동 테스트와 실제 GPU 번역 품질 재평가는 별개의 검증이다.

2026-10-28: 백엔드 67건·AI 149건과 추론 대역을 사용한 Python/Node 계약 호환성 2건 통과.

2026-10-29: 사전 누락 보류 지원 후 백엔드 69건 통과. 잘못된 형식·상태·공유 허용·알 수 없는 사유를 거부하고, 정상적인 사전 보류만 저장하며 승인과 가족 열람을 막는 테스트를 추가했다. 실제 GPU 응답 호환 결과는 AI 저장소의 `evaluation/backend-contract-spec-v13-compatible.json`에 별도 기록한다. 기존 검사기에서 거절된 9건을 포함해 같은 230개 실제 응답을 재검사한다.

같은 날 최신 develop의 기관 기능과 통합해 103건을 통과했다. 기관 검토 경로도 `validateReview`에 원문을 포함한 검증 대상 초안을 전달하도록 수정했다. 합성 테스트 AI에는 도움·사실 누락 검사와 원문 구간별 5종 의미 검사를 추가했다. 기관 테스트의 구조 오류 응답은 `model_checked=false`로 표시한다. 이전 69건은 통합 전 브랜치 검사이며, 103건에는 기관·실시간·테스트 계정 경로가 포함된다.

위의 승인/가족 열람 차단은 기존 그룹 기반 CareBridge API의 정책이다. 최신 `/workspaces`는 유효한 AI 경고를 보존하면서 검토자의 명시적 확인과 별도 공개 절차를 사용하는 자체 정책을 따른다. 이번 변경은 각 경로가 동일한 QA 응답의 형식과 원문 근거를 정확히 검증하도록 연결한다. 최신 통합 상태의 실제 GPU 응답 계약은 `evaluation/backend-contract-spec-v13-integrated.json`에 기록한다.
