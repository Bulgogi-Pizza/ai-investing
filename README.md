# Folio · 개인 투자 워크스페이스

금융 캘린더, 차트 분석, 자산·전략, 추천 시나리오를 묶은 한국어 투자 도구. React/TypeScript + Express + Firestore + Cloud Run.

운영 서비스: https://ai-investing-688204744640.asia-northeast3.run.app

```sh
npm ci
npm run dev
# 별도 터미널: 개발 API (자체 부트스트랩 계정은 환경변수로만 지정)
APP_ORIGIN=http://127.0.0.1:5173 npm start
npm run check
npx playwright install chromium
npm run test:e2e
```

브라우저: http://127.0.0.1:5173 . 로그인 전에는 로그인 화면만 보이고, 데모 데이터는 없다. 화면은 토스·DART·SEC·FRED·ECOS 실데이터만 쓰며 소유자 계정 전용이다. 예약 작업(일일 스냅샷, 아침 캘린더 갱신, 모의 운용)은 Cloud Run Job과 Cloud Scheduler로 돈다. 커뮤니티는 포함하지 않는다. 주문은 소유자 전용 알고리즘 실전 운용에서 [설계](docs/planning/next-phase-design.md) 4절의 안전장치를 모두 통과할 때만 나가며, 실전 일정은 사용자가 켜기 전까지 꺼져 있다. 지금 상태와 다음 할 일은 [다음 할 일과 인수인계](docs/planning/next-steps.md)를 먼저 본다.

- [공통 에이전트 지침](AGENTS.md): Codex·Claude·Gemini 공통 SOT
- [요구사항](docs/planning/requirements.md) / [아키텍처](docs/architecture/system.md)
- [다음 할 일과 인수인계](docs/planning/next-steps.md) / [진행 상태](docs/implementation/status.md) / [검증 흐름](docs/testing/workflow.md)
- [클라우드 비교](docs/operations/cloud-comparison.md) / [배포 운영](docs/operations/deployment.md)
- [인증](docs/implementation/auth.md) / [금융 연동](docs/implementation/integrations.md)

환경변수 샘플은 `.env.example`. 실제 `.env`, 금융정보와 클라우드/GitHub 키는 공개 저장소에 넣지 않는다. 로그인 계정은 관리자가 등록하며 공개 회원가입은 제공하지 않는다. 기능 변경 시 관련 문서와 테스트도 함께 수정한다.
