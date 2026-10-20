# 계정과 인증

SOT: `docs/planning/requirements.md` AUTH. 서버 구현: `src/server/app.ts`, `auth.ts`, `store.ts`. 기능 테스트: `tests/auth.test.ts`, `tests/server.test.ts`, `tests/login-throttle.test.ts`.

관리자만 `/api/admin/users`로 회원을 만든다. 공개 가입은 없다. API로 생성되는 계정은 항상 member이며 클라이언트 role 필드를 무시한다. 모든 `/api` 요청은 health/login을 제외하고 세션 검사, 계정 활성 상태 및 버전 검사를 통과해야 한다. 관리자 계정 비활성화는 서버가 즉시 기존 세션도 차단한다. 본인 비활성화는 관리 API에서 차단한다.

비밀번호는 32바이트 난수 salt와 scrypt 64바이트 파생키로 저장한다. 로그인 비밀번호는 12–256자다. 원문 비밀번호를 로그에 남기지 않는다. 세션은 32바이트 난수 토큰이고 서버에는 SHA-256 해시만 저장한다. 만료는 8시간으로 서버가 검증한다. production 쿠키는 HttpOnly, Secure, SameSite=Strict다. 로그인 보호는 운영 Firestore loginAttempts에 IP별15분10회 및 정규화 이메일별15분5회를 두 키 트랜잭션으로 공유한다. 성공과 실패 모두 횟수에 포함하고 비밀번호 검증 전에 차감한다. 알 수 없는 계정에도 동일하게 적용하여 계정 존재 여부를 노출하지 않는다. 여러 IP에서 같은 이메일을 시도해도 이메일 한도를 공유하며 scale-to-zero·인스턴스 교체에도 보존된다. 문서 ID는 접두어를 포함한 IP/이메일의 SHA-256 해시이며 원문 IP/이메일을 저장하지 않는다. IPv6 IP는 /56으로 정규화한다. 제한 시429와 Retry-After, 저장소 오류 시 계정 조회 전에503으로 차단한다. ttlAt Timestamp의 TTL을 켜서 만료 문서를 정리하며 TTL 삭제가 늦어져도 resetAt 서버 검증으로 창을 갱신한다. 개발·테스트 MemoryLoginThrottle도 같은 두 한도를 사용한다. 별도로 기존 인스턴스 IP15분10회 및 전체API 분당120회 제한을 유지한다. 전체API 제한은 인스턴스별이며 엄격한 전체API 공유한도는 후속 과제다. 모든 API 변경 요청에 정확히 일치하는 Origin을 요구한다. 로그인 시에도 동일하다. 사용자 정보 응답에는 비밀번호 해시를 포함하지 않는다. 인증 응답은 no-store다.

운영 createApp은 공유 loginThrottle 의존성 주입 없이 시작할 수 없다. index.ts는 FirestoreLoginThrottle을 주입한다. 로그인 창은 키별 최초 시도부터15분이며 차단된 시도는 창을 연장하지 않는다. 성공도 포함하므로 같은 이메일의 정상 로그인5회 후에는 창 만료를 기다려야 한다.

운영에서는 NODE_ENV=production, APP_ORIGIN=https://실제서비스호스트 (마지막 / 없음), GOOGLE_CLOUD_PROJECT가 필요하다. Cloud Run ADC 서비스 계정과 Firestore를 사용한다. APP_ORIGIN이 최초 URL 설정 이전에 없으면 부팅이 거부된다. 개발용 ADMIN_EMAIL/ADMIN_PASSWORD는 production에서 거부된다. 개발 메모리 저장소는 재시작 시 삭제되며 기본 계정은 없다. 선택적으로 개발 환경변수 ADMIN_EMAIL/ADMIN_PASSWORD로 관리자를 만든다.

최초 운영 관리자: 승인된 운영 환경에서 ADC 인증 후 PROVISION_ADMIN_EMAIL, PROVISION_ADMIN_PASSWORD를 비밀 주입하여 `node --import tsx scripts/admin-user.ts`를 실행한다. 명령 인자에 비밀번호를 쓰지 않는다. 스크립트 출력에 계정/비밀번호를 남기지 않으며 생성 후 주입 변수를 지운다. 중복 이메일은 트랜잭션으로 방지한다. 일반 계정 생성은 로그인한 관리자 API를 사용한다. `GET /api/admin/users`는 이메일순 최대100개 계정의 id/email/role/active만 반환한다. `POST /api/admin/users/:id/revoke`로 비활성화한다.

운영 전제: Firestore를 브라우저에 직접 공개하지 않는다. 서버 서비스 계정만 IAM으로 읽고 쓴다. sessions.expiresAt은 서버 검증용 epoch 밀리초이고 ttlAt은 Firestore Timestamp다. 운영에서 sessions 컬렉션 그룹의 ttlAt TTL 정책을 활성화하여 만료 문서를 정리한다. TTL 삭제가 늦어져도 expiresAt 검증으로 만료 세션은 거부된다. 계정 비활성화 후 재활성화·비밀번호 재설정·MFA는 아직 구현하지 않았다. 프로비저닝 권한은 운영자가 가진다.

검증: `npx vitest run tests/auth.test.ts tests/server.test.ts`. 미등록/비활성/위조/만료/폐기 세션, 관리자 권한, 계정별 전략 분리, Origin, 운영 쿠키를 검증한다. Firestore 실서비스 통합 검증은 배포 전 별도 수행해야 한다.

최근 검증 (2026-10-20 KST): TypeScript 검사 통과, auth/server 2개 파일13개 테스트 통과. 로컬 HTTP 포트를 금지하는 샌드박스에서는 EPERM으로 실패했고, 허용된 실행에서 같은 테스트를 통과했다. Firestore 실서비스 연동이나 클라우드 배포 완료를 뜻하지 않는다.

추가 검증: tests/login-throttle.test.ts는 Firestore 트랜잭션 fixture로 서로 다른 앱/스로틀 인스턴스, 다른IP·같은 이메일, 성공횟수 포함, 만료, 해시 문서명·TTL 및 저장소 장애 시 fail-closed를 검증한다. 실Firestore 부하/통합 검증을 대신하지 않는다.
