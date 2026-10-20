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

| 기능      | 파일                        | 초점                                |
| --------- | --------------------------- | ----------------------------------- |
| 인증/API  | server.test.ts/auth.test.ts | 미인증 접근·계정 비활성화·CSRF·검증 |
| 차트      | market.test.ts              | 정규화/지표 경계값                  |
| 자산·전략 | strategy.test.ts            | 합100%·리밸런싱·유효성              |
| 화면      | app.spec.ts                 | 네비게이션·필터·전략·반응형         |

새 기능에 테스트 명령과 수용 기준을 같이 추가한다. 실패가 있으면 배포 금지. 미실행/환경 제한은 상태 SOT에 기록한다.

추가 기능 파일: `tests/calendar-api.test.ts`(등록 일정 권한/검증), `tests/toss.test.ts`(공식 계약), `tests/recommendations.test.ts`(실데이터 규칙/소유자/기간), `tests/recommendations-live.spec.ts`(실분석 화면), `tests/ui-regressions.spec.ts`(경계 정렬·USD·중요도). `npm run format:check`는 공통 형식도 검사한다. CI는 앱 검증·인프라 검증·운영 컨테이너 빌드/스모크 세 job 모두 성공해야 배포를 시작한다.
