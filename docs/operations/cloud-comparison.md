# 클라우드 비용 비교와 선택

확인일: 2026-10-20. 아래 수치는 공식 공개 요금이며 견적/월요금 보장이 아니다. 프로모션은 기본 비교에서 제외한다.

| 후보          | 공개 기준                                                                                                       | 소규모 개인 투자 서비스 판단                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| GCP Cloud Run | 요청 기반 월 CPU180,000 vCPU초·메모리360,000 GiB초·요청200만 무료 구간(us-central1 기준 할인), 지역별 요금 차이 | 최소0으로 미사용 컴퓨팅 절약. 서울 배포 시 지역가격과 추가서비스 별도 계산          |
| AWS Lightsail | IPv4 Linux 월 $5/0.5GB, $7/1GB, $12/2GB; 전송량 지역별 차이                                                     | 상시 가동과 예측 가능한 고정비에 적합. 보안패치·백업·장애복구 운영 필요             |
| NCP           | 공식 요금표 Micro-g3: 월10,850원,1vCPU·1GB·10GB; VAT/공인IP/저장소/트래픽 별도. 상품/세대별 상이                | 국내 VM 운영 편리. 신규가입1년 무료에 의존하지 말고 지원되는 상품을 콘솔에서 재확인 |

## 결정

토스 공식 명세 추가 확인: IP 허용 목록이 필수다. Cloud Run 기본 동적 IP로는 연결할 수 없다. Direct VPC egress + VPC + Cloud NAT + 정적 외부 IPv4를 추가한다. NAT 공개 요금은 사용 VM당 시간$0.0014(32개 초과 최대$0.044), 처리GiB당$0.045, NAT 외부IP 시간$0.005이다. IP 1개를730시간 유지하면 약$3.65/월이 고정 발생하고 NAT 사용/전송은 별도다. Cloud Run 인스턴스별 NAT 과금과 실행 패턴을 실측해야 한다. 저트래픽 가정의 초기 예산은 **월$10 알림**이며 한도 보장이 아니다. AWS Lightsail1GB/$7와 차이가 작아 상시 작업이 늘면 AWS로 재비교한다. 공식 근거: https://cloud.google.com/nat/pricing , https://docs.cloud.google.com/run/docs/configuring/static-outbound-ip

초기 **GCP Cloud Run + Firestore**. 간헐적 개인 사용, 최소0, 최대2, 1vCPU/512MiB, 서울 asia-northeast3. 이 부하 가정에서는 사용량 기반 구성이 고정 VM보다 유리할 가능성이 높다. 확정적인 전체 비용 최저라고 주장하지 않는다.

예산 가정: 월1만 요청, 요청당0.3초, 인스턴스0.5GiB, 응답200KiB → CPU3,000초/메모리1,500GiB초/외부전송약1.9GiB. 동시성·콜드스타트·외부API 지연에 따라 증가한다. 무료 구간 적용 후에도 서울 전송, Firestore 읽기/쓰기/백업, Artifact Registry 이미지, 빌드, 로그, Secret Manager, 데이터/AI 공급자 요금은 별도다. API 계약 전 이 비용은 산정 불가다.

월 예산 알림은 선택 입력한 billing account에 Terraform으로 설정한다. 예산은 지출 차단 장치가 아니다. Cloud Run 최대 인스턴스도 총비용 하드캡이 아니다. 로그 보존·이미지 정리·Firestore TTL을 관리한다. 실제 사용량2주 관측 후 재비교한다.

## 공식 근거

- https://cloud.google.com/run/pricing
- https://cloud.google.com/firestore/pricing
- https://aws.amazon.com/lightsail/pricing/
- https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html
- https://www.ncloud.com/charge/region/ko

## 참고 UI 조사

- https://excelkospi.pages.dev/ : 관심종목·시장정보의 빠른 탐색을 참고.
- https://www.tossinvest.com/?focusedProductCode=A000660 : 제공 링크 직접 열기는 도구에서 오류. 접근 성공으로 기록하지 않음.
- https://www.investing.com/economic-calendar : 중요도/국가/시간 중심 경제 일정 탐색 참고.
- https://p.tossinvest.com/ko/open-api : 계좌·시세·캔들 제공 안내 확인. 공식 OpenAPI v1.2.24의 인증 및 응답 스키마를 확인하고 읽기 전용 어댑터·계약 테스트를 구현했다. 실제 키와 허용 IP를 이용한 실계좌 검증은 대기 중이다. 상세 계약은 [금융 서비스 연결](../implementation/integrations.md)을 따른다.
