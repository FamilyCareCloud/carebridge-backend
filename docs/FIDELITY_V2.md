# 이관 후 CareBridge QA v2 적용

저장소는 FamilyCareCloud/carebridge-backend이며, 케어브릿지 구현·배포 기준은 develop이다.
main에는 아직 이전 백엔드가 있으므로 이 브랜치와 혼동하지 않는다.

## 승인 검증 보완

- ASSISTANCE_FACT_PRESERVED와 SEMANTIC_OMITTED_FACTS를 필수 검사에 추가했다.
- 모델을 실행한 의미 검사는 모든 원문 구간의 근거·순서를 보존해야 한다.
- 각 구간에 다섯 의미 검사 코드가 중복 없이 모두 있어야 하며 값은 불리언이어야 한다.
- 전체 검사 결과는 구간별 결과의 집계와 일치해야 한다.
  구간/검사 누락, 다른 원문 인용, 집계 위조는 502로 실패하고 승인·버전을 저장하지 않는다.
- 모델을 생략한 보류는 실제 구조 검사 실패와 빈 구간 목록이 있어야 한다.
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

실제 GPU 연동 스크립트의 합성 WAV는 carebridge-ai/evaluation에서 찾는다.
CAREBRIDGE_TEST_AUDIO 환경변수로 별도 합성 WAV를 지정할 수도 있다.
키·실제 메모·모델 가중치·로컬 DB는 Git에 올리지 않는다.

검증은 권한·승인·사실 누락·불완전한 의미 검사·집계 불일치·기존 승인본 재검사 흐름을 포함한다.
자동 테스트와 실제 GPU 번역 품질 재평가는 별개의 검증이다.

2026-10-28: 백엔드 67건·AI 149건과 추론 대역을 사용한 Python/Node 계약 호환성 2건 통과.
