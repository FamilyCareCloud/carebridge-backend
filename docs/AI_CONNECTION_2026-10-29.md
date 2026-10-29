# 기관 AI 연결 점검 — 2026-10-29

팀원 프론트 develop@0c2cc52(기관 화면·REST·실시간 권한 확인·관리자 로그인)와 백엔드 develop@a597d31(기관 업무·WebSocket·범위 제한 Cognito 관리자)을 확인했다. AI 연결을 위해 팀원의 UI/CSS를 개편하지 않는다.

## 연결 계약

프론트는 GPU 서비스에 직접 접근하지 않고 Bearer 인증을 포함해 /workspaces/{id}/drafts, /transcriptions, /submissions/{id}/check를 사용한다. 백엔드는 기존 CAREBRIDGE_SERVICE_URL/API_KEY로 AI에 연결한다. API 키는 브라우저 변수나 로그에 넣지 않는다.

작성자는 합성 비식별 입력임을 확인하고 생성한다. 생성 ID·원문·작성자 편집본을 함께 제출하고, 원문이 바뀌면 새 생성본을 요구한다. 음성 결과는 원문을 직접 확인·수정한 뒤 생성한다.

검토자는 최종 내용을 먼저 저장하고 응답 버전으로 QA를 요청한다. 경고를 보존하며 원문·경고 확인 후 별도 확정한다. QA 뒤 내용을 바꾸면 다시 검사한다. 확정만으로 공개하지 않는다. 기관의 유효한 hold 경고는 명시적 확인 후 확정할 수 있다는 팀원 정책을 유지한다. 기존 가족 그룹 CareBridge API의 보류 시 승인·미리보기 차단 정책은 별도다.

QA의 원문·구간·검사 항목 일치와 명확한 누락의 사전 보류를 지원하는 백엔드 PR #8이 새 AI보다 먼저 반영되어야 한다. 구간 수가 달라진 편집본의 EDITED_EVIDENCE_REQUIRED와 형식 오류·장애는 성공으로 대체하지 않는다.

## 격리된 실제 검증

scripts/check-workspace-ai-live.mjs는 실제 프론트 API 어댑터의 컴파일 결과를 불러와, 메모리 저장소와 로컬 HTTP/SSE 백엔드 및 실제 GPU에 연결한다. 실제 AWS 데이터와 Cognito 계정을 만들거나 수정하지 않는다. 결과에 세션·API 키·비밀번호를 쓰지 않는다.

1. 프론트에서 `npx vite build --ssr src/workspace/gateway.ts --outDir .local/live-gateway`로 검증 모듈을 만든다.
2. 별도 loopback 포트에 carebridge-ai qa.v2 및 CUDA/STT를 준비한다. 기존 GPU 모델과 동시에 로드하지 않는다.
3. CAREBRIDGE_SERVICE_URL을 해당 loopback 주소로, CAREBRIDGE_SERVICE_API_KEY를 프로세스 환경에만 설정한다.
4. 백엔드에서 `node scripts/check-workspace-ai-live.mjs`를 실행한다. 기본 결과는 무시되는 data/workspace-ai-v14.json이며 기존 결과를 덮어쓰지 않는다.

가입·참여 승인·실시간 권한 증명, 주스 번역, 생성 ID 제출, 잘못 편집한 대상의 실제 보류, 최종본 재검사·확정, 별도 수신자 공개·철회, 실제 Whisper 전사를 확인한다. 공개 터널은 테스트용 포트에 연결하지 않는다. 종료 시 테스트 서버·메모리 데이터·이벤트 연결을 정리한다.

이 검증은 실제 프론트 API 코드의 로컬 종단 검증이다. 배포 Cognito 계정과 실제 브라우저의 전체 UI 수용 검증으로 집계하지 않는다. 전체 GPU 평가와 비교 대조 기록은 AI 저장소 evaluation/에 보존한다.

## 배포 준비 상태

기존 배포 API /health는 a597d31 및 aiConfigured=true를 반환했다. 이는 주소 설정 여부이며 GPU 신규 버전 적용 또는 실제 번역 성공을 뜻하지 않는다. 기존 GPU 서비스는 구 fcc-ai 체크아웃을 사용하고 있어 개선 버전은 별도 반영이 필요하다.

로컬 AWS 자격증명은 InvalidClientTokenId로 확인됐다. 기존 GitHub Actions는 OIDC 배포 경로를 갖고 있다. 사용자 요청에 따라 연결 코드를 준비했으나, 자동 승인 검토는 공유 develop 병합과 AWS 배포에 별도 명시 승인이 필요하다고 차단했다. 승인 전에는 PR 상태와 로컬 검증 결과를 전달하고 공유 배포를 진행하지 않는다.
