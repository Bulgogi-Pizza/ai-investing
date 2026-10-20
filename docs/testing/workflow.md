# 항상 실행 가능한 검증 흐름

```sh
npm ci
npm run check
npx playwright install --with-deps chromium
npm run test:e2e
```

- `npm run build`: TypeScript 전체 검사와 Vite production build.
- `npm test`: tests/ 하위 기능별 Vitest 계산/서버 통합 테스트. `npm run test:watch` 반복 실행.
- `npm run security:check`: 환경파일·키·일부 토큰 패턴 검사. 완전한 비밀 탐지 보장은 아니므로 diff 검토/플랫폼 secret scanning 병행.
- `npm run test:e2e`: 로컬 Vite 서버 자동 시작, 모든 화면/필터/전략/모바일 동작, 실패시 screenshot/trace. 실제 서비스/시크릿 없이 재현.
- UI 수정은 실제 브라우저에서 데스크톱/모바일 렌더링을 확인하고 오버플로·읽기 순서·접근성·상태 표시를 기록한다. DOM 테스트만으로 시각 검증을 대체하지 않는다.
- CI는 PR과 main push에서 전체 검증. 성공한 main push의 정확한 SHA만 배포한다. PR/fork는 배포 권한을 받지 않는다.

## 기능별 테스트 소유권

| 기능           | 파일                                             | 초점                                                   |
| -------------- | ------------------------------------------------ | ------------------------------------------------------ |
| 인증/API       | server.test.ts/auth.test.ts                      | 미인증 접근·계정 비활성화·CSRF·검증                    |
| 차트           | market.test.ts                                   | 정규화/지표 경계값                                     |
| 자산·전략      | strategy.test.ts                                 | 합100%·리밸런싱·유효성                                 |
| 시장 API       | market-api.test.ts                               | 소유자 403·미설정 503·입력·스키마                      |
| 소유자 경로    | server.test.ts·calendar-api.test.ts·news.test.ts | 전략·캘린더·뉴스 소유자 403, 관리자 쓰기=관리자+소유자 |
| 화면 상태      | ui-state.test.ts                                 | 상태 분류·KST 날짜·빈 캔들                             |
| 화면           | app.spec.ts                                      | 로그인 화면·소유자/회원·상태·반응형                    |
| 세션·전략·분석 | session-and-strategy.spec.ts                     | 전략 로딩 규칙·401 복귀·분석 실행·https 링크           |

새 기능에 테스트 명령과 수용 기준을 같이 추가한다. 실패가 있으면 배포 금지. 미실행/환경 제한은 상태 SOT에 기록한다.

추가 기능 파일: `tests/calendar-api.test.ts`(등록 일정 권한/검증), `tests/toss.test.ts`(공식 계약), `tests/recommendations.test.ts`(실데이터 규칙/소유자/기간), `tests/recommendations-live.spec.ts`(실분석 화면), `tests/ui-regressions.spec.ts`(경계 정렬·USD·중요도). `npm run format:check`는 공통 형식도 검사한다. CI는 앱 검증·인프라 검증·운영 컨테이너 빌드/스모크 세 job 모두 성공해야 배포를 시작한다.

## E2E는 가짜 API로만 돈다

브라우저 테스트(`tests/*.spec.ts`)는 서버와 외부 통신 없이 `page.route`로 `/api/**`를 가로채는 `tests/fixtures/api-mock.ts`를 쓴다. 이 파일의 시세·종목·일정·보유는 모두 합성 fixture이며 실데이터 검증이 아니다. 앱 코드(`src/`)에는 데모 시세·일정이 없다(`grep -rn "demoPrices\|합성 데모" src/`가 비어야 한다). 시계는 `page.clock.setFixedTime`으로 2026-10-20 KST에 고정한다. 시나리오: 비로그인(로그인 화면만), 소유자(실데이터 표시), 일반 회원(소유자 전용 안내), 토스 미연결 503, 빈 데이터, 일시 오류 후 다시 시도. 모든 화면에서 예시·데모 문구가 보이지 않는지도 검사한다. 시각 확인 스크린샷은 `test-results/`(커밋하지 않음)에 남긴다.
