# 구현·전달 상태 SOT

기준: 2026-10-20 KST. 완료하지 않은 외부 연결은 완료로 표시하지 않는다.

| 영역           | 구현                                                                      | 실제 연결/검증                                                                                    |
| -------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 앱/경제 캘린더 | 반응형 월·주·일·시간, 필터·상세·영향 시나리오                             | 합성 모드와 관리자 출처 등록·조회 모드 구현                                                       |
| 차트           | SMA/EMA/볼린저/RSI/MACD·비교·기준선·관심종목                              | 합성 기본 모드; 토스 캔들 조회 모드 구현, 실제 키 대기                                            |
| 자산·전략      | 통화 분리·프라이버시·전략 계정저장·리밸런싱                               | 토스 성공 응답 시 실주식 보유잔고 표시; 공식 스펙 계약 테스트                                     |
| 추천           | 기간별 합성 및 실제 토스 차트·등록일정·저장전략 기반 규칙 분석, 위험·출처 | 실제 데이터 규칙 API/UI 구현; 생성형 AI·자동 뉴스 수집 미연결 명시                                |
| 인증           | 관리자 등록·목록·비활성화·세션·권한·CSRF                                  | 자동 통합 테스트 완료; Firestore 실서비스 테스트 대기                                             |
| 인프라         | Cloud Run 배포 CI + Firestore/WIF/NAT/고정IP Terraform                    | Terraform validate 통과. 개인 전용 프로젝트 생성, 결제 활성화 대기로 apply 미실행                 |
| GitHub         | public Bulgogi-Pizza/ai-investing 생성                                    | Secret Scanning/Push Protection 활성화; 초기 소스 push 완료; 원격 CI의 스크린샷 경로 수정 검증 중 |
| UI QA          | 실제 IAB 데스크톱 렌더 확인 및 Playwright                                 | 최종 재검증 결과 docs/testing/evidence.md 참조                                                    |

## 외부 연결 조건

- GitHub 인증 정상. 최초 sandbox 네트워크 상태가 인증 실패처럼 보였으나 제한 밖 재확인으로 정상 확인.
- 사용자가 지정한 개인 계정의 GCP CLI 로그인을 완료했고 전용 프로젝트 `folio-investing-60029579`를 생성했다. 개인 결제 계정이 CLOSED 상태이므로 사용자에게 결제 활성화 및 프로젝트 연결을 요청한 상태다. 유료 리소스는 생성하지 않았고 Terraform apply도 실행하지 않았다. 회사 계정이나 기존 회사 리소스는 변경하지 않았다.
- 토스 OAuth client_id/client_secret, 계좌 시퀀스, 연결할 로컬 사용자ID 및 고정 출구 IP 허용 목록 등록 필요. 키를 채팅/저장소에 붙여 넣지 않는다.
- 실제 뉴스/경제 일정 자동 공급자와 생성형 AI 공급자는 아직 정해지지 않았다. 등록형 일정과 검증 가능한 규칙 분석을 제공하며 미연결을 명시한다.

## 문서 인덱스

요구사항: planning/requirements.md. 시스템: architecture/system.md. 기능: implementation/{auth,integrations,calendar,charts,portfolio,recommendations}. 검증: testing/workflow.md. 운영: operations/{cloud-comparison,deployment}. 협업: agents/collaboration.md + 루트 AGENTS.md.
