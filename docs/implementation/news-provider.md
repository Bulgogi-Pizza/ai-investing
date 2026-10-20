# 공식 보도자료 RSS — NEWS

## 공식 근거 및 범위

확인일: 2026-10-20 KST. [미 연준 RSS 안내](https://www.federalreserve.gov/feeds/feeds.htm)가 제공하는 [All Press Releases](https://www.federalreserve.gov/feeds/press_all.xml)와 [한국은행 공식 RSS 안내](https://www.bok.or.kr/static/view/popup/rss_popup.html)에 명시된 [보도자료 전체 RSS](https://www.bok.or.kr/portal/bbs/B0000552/news.rss?menuNo=200690)를 고정 허용 출처로 사용한다. 실제 공개 XML을 읽기 전용으로 확인했고 동일 파서로 연준20건·한국은행100건을 정규화했다. 제공 건수는 확인 시점의 피드 스냅샷이며 상시 보장하지 않는다.

RSS의 제목·원문 링크·게시시각만 원천 데이터로 사용한다. 기사 본문·첨부·RSS description·guid·channel 본문을 저장하거나 재배포하지 않는다. 항목에서 파생된 KST 게시일시, 출처, 규칙 태그와 분류 한계 안내만 경제 일정 레코드에 함께 저장한다. 원문 기사는 방문·크롤링하지 않는다. 두 기관의 최근 보도자료이므로 일반 언론 뉴스, 전체 금융 시장 또는 모든 국가를 포괄하지 않는다. 일일 스냅샷 작업(4단계, [jobs.md](../operations/jobs.md))이 KR 마감 후 실행마다 같은 수집을 호출한다. 운영 적용 전에는 자동 수집이 없다.

## API 및 운영

`src/server/news.ts`의 `syncOfficialNews(repository,{sourceIds,transport?,now?,cache?,authorId?})`는 고정 출처ID만 선택한다.

- 인증된 `GET /api/news/sources`: `{sources:[{id,name,feedUrl,country,coverage}],warnings}`. ID는 `fed-press`, `bok-press`.
- 관리자 전용 `POST /api/admin/news/sync`: `{sourceIds?:['fed-press','bok-press']}`. 생략하면 두 출처 모두 조회한다. 임의 URL·추가 필드·알 수 없는 ID·중복 ID·빈 배열은400.
- 응답 `{count,sources:[{id,name,status,count}],warnings}`. status는 `synced|cached|failed`. count는 해당 요청에서 upsert한 유효 레코드 수이며 신규 기사 수나 누적 기사 수가 아니다.
- 일부 출처 실패는200과 출처별 실패/경고를 반환한다. 전부 실패하면503과 동일 결과 및 `error`를 반환한다. 이전 저장 데이터는 삭제하지 않는다.

상위 앱은 인증·동일출처·body/rate limit 이후에 라우터를 설치한다. 라우터도 활성 로그인·관리자 권한을 재검사한다. UI는 관리자만 공식 뉴스 가져오기 버튼을 보며 출처 범위·대기·출처별 결과·경고·오류를 표시한다. 성공 count가 양수이면 등록 일정 모드로 전환·재조회한다. 실패를 데모 일정으로 대체하지 않는다.

## 전송·파싱·저장 경계

고정 HTTPS feed만 fetch하며 redirect를 금지한다.8초 제한, Content-Length와 실제 스트림 각각 최대2MiB를 검사한다. DOCTYPE/ENTITY 선언은 파서 실행 전에 거부한다. `fast-xml-parser`의 XML 검증 후 제목·링크·시간 필드를 확인하고, 원문 링크도 해당 공식 feed와 같은 hostname의 HTTPS만 허용한다. 인증정보·포트·fragment가 있는 링크, 시간대가 없는/비정상/확인시각보다5분 넘게 미래인 게시시각, 필드 한도 초과는 제외하고 건수 경고를 표시한다. 최대100항목/출처를 처리한다.

출처별 프로세스 메모리 캐시는15분이며 동시에 들어온 요청을 하나로 합친다. 캐시 사용 시 원래 fetch 확인시각을 유지한다. 여러 Cloud Run 인스턴스는 서로 캐시를 공유하지 않는다. 제목·게시시각이 바뀌어도 같은 출처+정규화 링크의52비트 SHA-256 숫자ID로 upsert하므로 반복 수집은 중복 레코드를 만들지 않는다. 해시ID는 양의 safe integer이며 사용자계좌 식별자가 아니다.

게시시각은 KST date/time으로 변환한다. `eventKind:'news-release'`는 발표된 보도자료를 뜻하며 예정 경제지표 발표가 아니다. 제목 키워드로 중요도1~3·카테고리·영향자산을 분류하지만 confidence는 항상low, impactDirection은unknown이다. 설명에 규칙 추정과 한계를 표시한다. `factualObservedAt`은 fetch UTC시각이며 기사 원래 게시시각과 구분한다. 금융 가격에 대한 영향을 실제 분석하거나 방향을 단정하지 않는다.

## 추천 연결과 검증

추천 서비스는 news-release를 미래 일정에서 제외하고, 일/주/월에 따라 최근1/7/30일의 공개 보도자료를 `evidence.news`로 별도 제공한다. 같은 시장·글로벌·명시적 종목 태그의 관련성 규칙을 적용한다. 뉴스 게시시각과 향후 일정의 시계를 혼합하지 않으며 낮은 확신의 제목 중요도만으로 규칙 판단을 뒤집지 않는다.

`tests/news.test.ts`10개는 KST 변환·한/미 출처, 본문 미보존, XML 선언·크기·리다이렉트·출처·시각 검증, 고정 URL·캐시·동시 요청 병합·ID upsert, 인증/관리자 권한, 부분 및 전체 실패를 검사한다. 외부 통신 없이 합성 XML fixture와 주입 transport를 사용한다. `tests/recommendations.test.ts`는 최근 뉴스/미래 일정 분리, 미래 뉴스 배제, 조회기간과 시장 필터, 뉴스만으로 판단이 바뀌지 않는 경계를 검증한다. 뉴스·추천·캘린더 API의24개 테스트가 통과했다. 실제 운영 Firestore 저장과 정기 수집은 배포 이후 별도 검증 대상이다.

반복 수집의 저장 비용을 줄이기 위해 수집 경로를 사용자별 인스턴스당15분3회로 제한한다. 네트워크 캐시는 인스턴스별이며 캐시 결과도 요청당 upsert한다. 현재 최대2인스턴스이므로 이 제한은 전역 하드캡이 아니다. 동일 ID upsert는 기존 값을 대체하며 신규 건수로 해석하지 않는다.
