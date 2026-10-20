# 구현·전달 상태 SOT

기준: 2026-10-20 KST. 외부 서비스의 구현·실제 검증을 구분한다.

| 영역        | 구현                                                                   | 실제 연결/검증                                                                                                  |
| ----------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 경제 캘린더 | 월·주·일·시간, 중요도·자산·카테고리·시장 필터, 상세·출처·영향 시나리오 | 합성 모드와 관리자 등록 조회; 한국은행·연준 RSS 수집 통합 검증 진행                                             |
| 차트        | SMA/EMA/볼린저/RSI/MACD, 기간별 비교, 수동 매수·매도선, 관심종목       | 합성 기본 모드; 실제 토스 캔들 어댑터와 계약 테스트 완료, 키 대기                                               |
| 자산·전략   | 통화 분리, 잔액 숨김, 계정별 전략 저장, 리밸런싱 시나리오              | 실제 주식 보유잔고 어댑터; 토스 실계좌 호출 대기                                                                |
| 추천        | 기간별 규칙 분석, 저장전략·차트·등록일정 근거, Vertex 해설 어댑터      | 실제 토스 데이터 대기; Vertex 공개 합성 입력1회 ready 실호출 검증                                               |
| 인증        | 관리자만 계정 생성, 비활성화, 공유 로그인 제한, 세션 폐기, CSRF        | 운영 Firestore 관리자 로그인·전략조회·로그아웃 후401 실제 통과                                                  |
| 인프라      | Cloud Run·Firestore·WIF·NAT·고정IP·예산 알림 Terraform                 | 개인 전용 프로젝트 실제 배포; 월15,000원50/90/100% 알림, Firestore 외부 접근차단 적용                           |
| GitHub      | public Bulgogi-Pizza/ai-investing, main 보호, 필수 CI, 배포 워크플로   | Secret Scanning/Push Protection; 보안 PR14의 필수3개 CI 통과·병합, main4b1033e의 실제 OIDC 자동배포·health 성공 |
| 협업·QA     | 공통 AGENTS.md + Claude/Gemini 진입 문서, 기능 문서·테스트·브라우저 QA | Codex 병렬 구현 및 Claude Sonnet 독립 검토; 최종 증거는 testing/evidence.md                                     |

## 운영 접속

- 서비스: https://ai-investing-688204744640.asia-northeast3.run.app
- 공개 소스: https://github.com/Bulgogi-Pizza/ai-investing
- 최초 관리자 자격증명은 gitignore된 `.local/owner-access.json`(0600)에만 있다. 원문을 공개 문서·로그·채팅에 기록하지 않는다.
- 사용자가 지정한 개인 GCP 계정으로 전용 프로젝트를 생성하고 활성 개인 결제를 연결했다. 모든 CLI에 개인 account/project/billing-project를 명시한다. 회사 계정과 회사 리소스를 사용하지 않는다.

## 남은 실제 데이터 연결 조건

토스 OAuth client_id/client_secret, 계좌 시퀀스, 연결할 로컬 사용자ID를 Secret Manager로 제공하고 고정 출구 IP를 토스 허용 목록에 등록해야 한다. 실제 토스 OAuth·시세·계좌 호출은 아직 검증하지 않았다. 합성 데이터와 검증 fixture를 실데이터라고 표시하지 않는다.

## 문서 인덱스

요구사항: planning/requirements.md. 시스템: architecture/system.md. 기능: implementation/{auth,integrations,calendar,charts,portfolio,recommendations,news-provider,ai-provider}. 검증: testing/workflow.md. 운영: operations/{cloud-comparison,deployment}. 협업: agents/collaboration.md + 루트 AGENTS.md.
