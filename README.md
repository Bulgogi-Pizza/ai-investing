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

브라우저: http://127.0.0.1:5173 . 로그인 전 화면 데이터는 합성 데모다. 토스 공식 명세 기반 주식 잔고·일봉 조회와 저장 전략·등록 일정에 따른 규칙 분석을 구현했다. 실제 조회는 토스 자격증명·소유자 지정·고정 IP 허용 등록 후 가능하며 실계좌 검증은 대기 상태다. 한국은행·연준 공식 RSS를 관리자 요청으로 수집하고, 실제 규칙 분석에 선택적 Vertex 해설을 추가한다. 예약 수집은 구성하지 않았다. 제공자별 실제 연결 상태는 진행 상태 문서를 따른다. 토스 API 키를 설정하는 것만으로 연동 완료되지 않는다. 주문/커뮤니티는 포함하지 않는다.

- [공통 에이전트 지침](AGENTS.md): Codex·Claude·Gemini 공통 SOT
- [요구사항](docs/planning/requirements.md) / [아키텍처](docs/architecture/system.md)
- [진행 상태](docs/implementation/status.md) / [검증 흐름](docs/testing/workflow.md)
- [클라우드 비교](docs/operations/cloud-comparison.md) / [배포 운영](docs/operations/deployment.md)
- [인증](docs/implementation/auth.md) / [금융 연동](docs/implementation/integrations.md)

환경변수 샘플은 `.env.example`. 실제 `.env`, 금융정보와 클라우드/GitHub 키는 공개 저장소에 넣지 않는다. 로그인 계정은 관리자가 등록하며 공개 회원가입은 제공하지 않는다. 기능 변경 시 관련 문서와 테스트도 함께 수정한다.
