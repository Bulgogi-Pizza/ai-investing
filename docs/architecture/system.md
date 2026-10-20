# 아키텍처 SOT

React + TypeScript + Vite UI, Express API, GCP Cloud Run 컨테이너, Firestore 서버 전용 저장소를 선택한다. 브라우저 → 같은 출처 /api → 계정별 인증·권한 → 서비스 어댑터 → 외부 금융 API. 토스 비밀은 서버 환경변수/Secret Manager에서만 읽는다. 정해진 시각의 작업은 Cloud Scheduler가 Cloud Run Job을 실행하고, 알림은 서버·작업에서 Telegram Bot API로 보내기만 한다.

## 폴더

```
src/
  components/       재사용 UI
  features/         기능별 화면
    calendar/       경제 캘린더 · CalendarPage.tsx
    charts/         차트 분석 · ChartsPage.tsx
    portfolio.tsx   자산 화면
    recommendations.tsx 추천 화면
  lib/              순수 지표·전략 계산
  server/           인증·저장소·외부 서비스·HTTP
 tests/              기능 단위/통합/E2E
 docs/
  planning/         요구사항 SOT
  architecture/     시스템 SOT
  implementation/   기능별 동작·상태 SOT
  testing/          검증 명령·수용 기준·증거
  operations/       클라우드·배포·비밀 운영
  agents/           에이전트별 역할·기능별 지침
 infra/gcp/          재현 가능한 인프라
 scripts/            보안 검사·운영 명령
```

UI 데모 데이터는 재현 가능한 합성 데이터다. 공개 소스에 실제 보유자산을 넣지 않는다. 실계정 API는 미인증401, 권한없음403, 연결준비안됨503으로 처리한다. 배포에서 메모리 계정 저장과 개발용 관리자 부트스트랩을 금지한다. 클라이언트의 숨김 UI는 보안 경계가 아니다.

## 결정

- 개인 저트래픽/간헐적 요청이므로 scale-to-zero Cloud Run 우선. 서울 asia-northeast3, 최소0/최대2. 가격 비교는 docs/operations/cloud-comparison.md.
- 컨테이너 로컬 파일은 영속 저장으로 사용하지 않는다. 계정·세션·전략은 Firestore. 백업/TTL 정책은 운영 문서 참조.
- 공개 GitHub 코드와 비공개 금융 데이터 경계를 유지한다. GitHub OIDC → GCP WIF로 장기 키 없이 CI 배포.
- 실시간 금융 데이터는 토스 키와 허용IP 확보 후 연결한다. 공식 뉴스는 고정 한국은행·연준 RSS를 관리자 요청으로 수집한다. Vertex 생성형 해설은 서버 IAM과 공유 일25회 한도로 규칙 분석에 추가하며 실제 금융 입력은 토스 연결이 선행되어야 한다. 미완료 연결은 명시한다.
- 예약 작업(확정 설계, [next-phase-design.md](../planning/next-phase-design.md), 구현 상태는 status.md): Cloud Scheduler → Cloud Run Job(같은 이미지, 작업별 최소 권한 서비스 계정, 고정 출구 IP). 일일 스냅샷(시장 마감 후), 아침 캘린더 갱신, 시장별 알고리즘 판단(정규장 개장 직후). 휴장·서머타임은 토스 장 운영 캘린더로 판단한다.
- 알림: 저장된 chat ID 하나에만 Telegram Bot API로 보낸다. 봇 토큰·chat ID는 Secret Manager 참조로만 쓰고, 수신 명령·webhook은 두지 않는다. 전송 실패는 판단을 막지 않고 화면 알림 목록에 남긴다.
- 사용 범위: 실데이터 화면·종목 분석·알고리즘·주문은 소유자 전용이며 서버에서 `TOSS_OWNER_USER_ID`로 검사한다. 주문은 알고리즘 실전 운용에서만, 안전장치를 주문 직전 한 곳에서 검사한 뒤 낸다.
