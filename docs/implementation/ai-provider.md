# 선택적 Vertex AI 해설

구현: `src/server/ai.ts`, 테스트: `tests/ai.test.ts`. 실제 공급자 해설은 rules-v1 결과에 `ai` 필드를 추가한다. 규칙의 판단·지표·비중·출처를 바꾸지 않으며 AI 실패가 규칙 API 자체를 실패시키지 않는다. AI 미설정은 disabled, 오류·차단·할당량 초과는 unavailable로 표시하고 해설을 만들지 않는다. `aiFromEnvironment()`를 앱 수명 동안 한 번 만들고 `await adapter.enrich(rules,userId)`로 사용한다. 간단한 진입점 `enrich(rules,userId)`도 제공한다.

## 설정과 공식 계약

`AI_PROVIDER=vertex`, `AI_MODEL`, 명시적 `GOOGLE_CLOUD_PROJECT`가 모두 있어야 켜진다. `AI_LOCATION` 기본값은 global이며 지원 지역은 모델별로 확인한다. API키를 쓰지 않는다. GoogleAuth의 ADC로 런타임 서비스 계정 bearer token을 얻어 메모리에만 보관한다. Cloud Run 런타임 IAM은 선택한 개인 프로젝트의 모델 호출 권한만 부여하고 aiplatform.googleapis.com을 활성화해야 한다. 개발자의 다른 조직/회사 ADC로 실제 호출하지 않는다.

공식 REST: global은 `https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/publishers/google/models/{model}:generateContent`, 지역은 `https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent`. project/model/location은 제한된 문자로 검증하고 임의 URL·redirect를 허용하지 않는다. POST Bearer, JSON contents/systemInstruction/generationConfig를 사용한다. responseMimeType=application/json과 responseSchema를 요청하고 후보1개, STOP 완료, 문자열 parts만 허용한다. 생성 요청을 자동 재시도하지 않는다.

공식 근거: [REST 요청/응답](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/inference), [global REST 예제](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/function-calling), [구조화 출력](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/control-generated-output).

2026-10-20 KST 공식 문서 조사: `gemini-2.5-flash-lite`는 당일 지원 종료 예정이므로 새 설정에 선택하지 않는다. 비용 우선 후보는 GA `gemini-3.1-flash-lite`, 최신 Flash-Lite 후보는 GA `gemini-3.5-flash-lite`다. 모델을 코드 기본값으로 고정하지 않고 운영자가 프로젝트 접근 권한과 지원 지역을 확인해 AI_MODEL을 선택한다. [공식 수명 주기](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions), [3.5 Flash-Lite 모델/지역](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash-lite).

공식 표준 global 텍스트 요금은 100만 토큰당3.1 Flash-Lite 입력$0.25/출력$1.50, 3.5 Flash-Lite 입력$0.30/출력$2.50이다. 모델 접근·가격은 활성화 시 다시 확인한다. [공식 요금](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing). 일25회 제한은 호출 수 제한이며 토큰·기타 클라우드 비용의 하드캡은 아니다.

## 개인정보·근거·출력 경계

입력은 live rules-v1만 허용한다. 저장 전략 중 위험성향·기간·목표 비중, 계산된 지표, 규칙 action, 출처 ID와 제한된 제목/일정 시각만 보낸다. 미래 일정 최대6개(event-N), 최근 공개 보도자료 최대6개(news-N)를 별도로 표시하며 본문이나 다른 기사를 추가하지 않는다. 실제 계좌 식별자·이메일·보유수량·계정ID·사용자 메모·전략 이름·원시 보유액·전체 차트는 모델에 보내지 않는다. 텍스트의 이메일/긴 숫자식별자/URL을 제거하고 전체 직렬화 입력을12,000 UTF-8바이트로 제한한다. 공급자에게 userId를 전달하지 않는다. 이 ID는 서버의 사용자별 캐시 SHA-256 키에만 사용한다. 입력 제목은 신뢰할 수 없는 데이터로 취급하며 도구/검색/외부정보 연결을 제공하지 않는다.

출력은 summary, actions(1–5문자열), counterScenario, dataGaps(1–5문자열), confidenceExplanation, sourceIds 여섯 필드만 허용한다. 길이·형식을 검사하고 없는 출처 ID·중복 ID·URL/HTML·이메일·8자리 이상 숫자 식별자 형태·추가필드를 거부한다. confidenceExplanation에는 숫자와 퍼센트를 허용하지 않으며 다른 필드도 확률/신뢰도에 연결된 숫자 패턴을 거부한다. 명시적인 주문/목표가격/비중 변경 문구도 패턴으로 거부한다. 근거 URL은 모델이 만들지 않고 서버가 원래 출처에서 붙인다. 문구 검사는 의미 정확도의 완전한 보장이 아니므로 AI 해설은 원본 근거를 확인하는 보조 정보이며 실제 주문·가격 목표·자산 배분을 소유하지 않는다. 규칙 결과와 해설을 UI에서 분리하고 모델명·불확실성을 표시한다.

ready 계약: `{status:'ready',type:'llm',provider:'vertex',model,asOf,summary,actions,counterScenario,dataGaps,confidenceExplanation,sourceIds,sources:[{id,title,url?}]}`. unavailable/disabled는 `{status,type:'llm',provider:'vertex',model?,message}`이고 생성된 것처럼 보이는 문장을 넣지 않는다. 예외·토큰·원문 공급자 오류를 로그/응답에 출력하지 않는다.

알고리즘 판단용 AI 호출은 이 해설 계약과 별도의 계약을 쓴다(구현 계획 7c, [next-phase-design.md](../planning/next-phase-design.md) 4·5절). 위의 주문/목표가격/비중 변경 문구 거부는 이 해설 계약의 출력에만 적용한다. 판단 계약의 입출력 형식·검사·한도는 구현 때 따로 정의하며, 해설 기능은 계속 주문·목표가·비중을 만들지 않는다.

## 비용과 실패 처리

온도0.2, 출력최대1600토큰, 공급자 응답최대64KiB, 총 생성 처리12초 제한을 적용한다. 입력12,000바이트는 토큰 상한과 같지 않다. Firestore aiUsage/{KST날짜} 트랜잭션에서 모든 인스턴스·모델의 시도를 하루25회로 제한한다. 발급 직전 차감하고 실패해도 돌려주지 않는다. ttlAt Timestamp를 TTL 정책에 연결해 정리한다. TTL 삭제와 별개로 날짜별 문서로 창을 구분한다. 할당량 저장소 오류는 호출하지 않고 unavailable로 처리한다. 개발은 MemoryAiQuota를 사용한다.

해설 캐시는 사용자ID+최소화 근거+출처의 해시로2분 유지하며 최대100개, 동시에 최대8개 생성을 허용한다. 같은 입력은 singleflight로 중복 호출을 막는다. 캐시·singleflight는 인스턴스별이지만 일일 할당량은 Firestore로 공유한다. 제공자 오류도 같은 입력의2분 재시도를 억제한다. 모델 응답의 의미 검증·성능 평가는 후속 작업이며 fixture 테스트를 실모델 연동 검증으로 주장하지 않는다.

수동 실모델 스모크: 개인계정 지정 .local/deployment.json과 .local/deployment-account.md가 일치할 때만 `node --import tsx scripts/smoke-ai.ts`를 실행한다. gcloud에 계정·프로젝트를 명시하고 토큰을 메모리로만 받아 인증 주입한다. 공개 합성 fixture로 정확히1회만 시도하며 실제 자산·추천 입력을 쓰지 않는다. 이 수동 시험은 MemoryAiQuota를 쓰며 운영 경로는 Firestore 할당량을 유지한다. 출력은 상태/모델/합성입력 표시뿐이며 생성 본문·토큰·계정 식별자를 출력하지 않는다. 실서비스 금융 입력 연동 검증을 대신하지 않는다.

실모델 수송 검증(2026-10-20 KST): 지정된 개인 계정·프로젝트의 Gemini3.1 Flash-Lite global에 공개 합성 입력으로1회 호출하여 ready 응답을 확인했다. 실제 토스 계좌·시세·뉴스를 이용한 사용자 추천 검증이나 투자 해설 품질 평가를 뜻하지 않는다. 이후 출력 개인정보/수치 확신 패턴 검사는 fixture로 추가 검증했다.
