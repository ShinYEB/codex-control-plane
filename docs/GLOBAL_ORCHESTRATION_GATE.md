# 전역 오케스트레이션 구현 게이트

이 문서는 맥락 정본, Global Run과 thread lifecycle 구현을 시작하고 완료하기 위한 실패 테스트 순서를 정의한다. 각 단계는 구현보다 먼저 현재 결함 또는 미지원 동작을 명확한 실패로 고정한다.

## G0 — 계약 정본

- [x] 제품 목적과 범위 확정
- [x] 맥락 정본 ADR
- [x] Global Run 계층 ADR
- [x] thread lifecycle ADR
- [x] 사용자-visible Result authority ADR
- [x] Context Resolution 목표 계약
- [x] Global Run 목표 계약
- [x] 목표 persistence/migration 계약
- [x] 구현 enum/schema version 확정
- [x] Global Run 공개 API v1과 handoff schema v1 고정; version 누락은 v1 호환, 미지원 version은 persistence 전 거부

## G1 — Project identity와 확장 migration

상태: 기반 구현 완료. 기존 `cwd` API는 호환 경로로 유지하며 Router/Context의 snapshot 기반 전환은 G2~G3에서 수행한다.

실패 테스트:

- symlink, Git worktree, nested cwd가 canonical project identity로 수렴한다.
- 서로 다른 non-Git root를 잘못 병합하지 않는다.
- 모호한 identity는 구조화된 migration attention으로 종료한다.
- migration snapshot, transaction, reopen과 idempotent backfill을 보장한다.
- legacy memory는 candidate/legacy authority로만 이관된다.

완료 조건:

- [x] 모든 Run, Task, Agent, Plan, memory를 project ID로 조회할 수 있다.
- [x] 신규 canonicalizer가 raw cwd 문자열만으로 project identity를 결정하지 않는다.
- [x] 기존 단일-project 실행과 origin delivery가 회귀하지 않는다.

구현 근거:

- `src/project-identity.js`
- `src/registry.js` schema version 2 migration
- `test/project-identity.test.js`
- `schema v1 expands canonical projects and backfills legacy memories as unverified candidate claims`
- `new project-scoped entities persist the same canonical project id`

## G2 — Claim과 Thread Knowledge

상태: 저장·검증·managed Task 연동과 명시적으로 요청한 과거 스레드의 read-only on-demand 색인 완료.

실패 테스트:

- provenance 없는 claim 활성화 거부
- 사용자 결정의 자동 supersede 거부
- expired/superseded claim 선택 거부
- thread snapshot digest 중복 억제
- fork lineage와 inherited snapshot 기록
- archive/compact thread의 active lease 거부

완료 조건:

- [x] claim validation의 단일 정본이 존재한다.
- [x] managed Task 결과와 등록된 스레드 지식을 source digest 범위와 함께 색인할 수 있다.
- [x] Router가 ThreadKnowledge snapshot/claim evidence와 제외 사유를 반환한다.
- [x] 관리 밖 과거 스레드의 on-demand read/extraction을 Context Resolver에 연결한다.

구현 근거:

- `src/context-claims.js`
- `src/context-manager.js`의 validated Task result claim/snapshot 생성
- `src/thread-knowledge-indexer.js`의 원문 비보존 digest/topic 색인
- `src/registry.js` schema version 3과 claim/snapshot/lineage/routing API
- `src/router.js`, `src/mcp-server.js`의 knowledge evidence와 durable routing decision
- `test/context-claims.test.js`
- `test/context-manager.test.js`
- `task routing provenance and capability/tool matrix persist with scheduler identity`

## G3 — Context Snapshot pre-planning gate

상태: 완료. immutable Snapshot, 과거 스레드 digest 범위, Planner/Task 게이트와 dashboard 진단을 연결했다.

실패 테스트:

- blocking conflict가 planning 전에 차단된다.
- 변조 fingerprint가 Planner에 도달하지 않는다.
- planning 중 새 claim이 기존 snapshot을 변경하지 않는다.
- invalid snapshot은 접수 결과를 전달하기 위한 graphless terminal Run 외에 Task graph/Agent/turn/worktree/attempt를 만들지 않는다.
- daemon restart 후 building snapshot이 deterministic하게 복구된다.

완료 조건:

- [x] 모든 Planner 입력 경로가 같은 snapshot validator를 사용한다.
- [x] direct/planned dispatch와 Task가 사용한 snapshot ID/fingerprint를 기록한다.
- [x] 저장 API에서 선택·제외·충돌 이유와 structured failure를 확인할 수 있다.
- [x] dashboard 전용 진단 화면에서 선택·제외·충돌 이유를 on-demand로 확인할 수 있다.

구현 근거:

- `src/context-resolver.js`
- `src/thread-knowledge-indexer.js`
- `src/registry.js` schema version 4와 `context_snapshots`, `context_snapshot_claims`, `context_conflicts`
- `src/planner-engine.js`, `src/mcp-server.js`의 pre-planning/pre-graph gate
- `src/dashboard-model.js`, `ui/dashboard.html`의 lightweight summary와 상세 진단 조회
- `test/context-resolver.test.js`, `test/thread-knowledge-indexer.test.js`, `planner blocks conflicting context before creating or resuming an Agent`

## G4 — Global Run 상태와 graph

상태: 완료. schema version 5, 중앙 Global Run 상태 머신, 원자적 revision/Project Run/Task graph 저장, dependency release, required/optional 집계, cancellation/claim fencing, 재시작 projection과 MCP/dashboard 조회를 구현했다.

실패 테스트:

- illegal Global Run transition 거부
- invalid/순환 project graph의 원자적 거부
- 부분 graph crash 후 worker release 금지
- required/optional child의 정확한 terminal 집계
- 전역 취소 후 신규 child claim 금지
- terminal attention 동일 revision 자동 재시도 금지

완료 조건:

- Global Run 상태 의미가 중앙 상태 모듈에서 파생된다.
- 기존 Run은 project 권한 경계를 유지한다.
- 전역 결과가 일부 성공을 전체 성공으로 과장하지 않는다.

구현·검증 근거:

- `src/global-runs.js`, `src/domain-states.js`, `src/registry.js` schema version 5
- MCP `prepare_global_run`, `list_global_runs`, `get_global_run`, `refresh_global_run`, `cancel_global_run`
- `src/dashboard-model.js`, `ui/dashboard.html`의 Global Run projection/진단
- `test/global-runs.test.js`, `test/mcp-server.test.js`, `test/dashboard-model.test.js`

## G5 — Cross-project handoff와 권한

상태: 완료. schema version 6의 project authorization manifest와 cross-project handoff/receipt를 구현했다. manifest와 dependency/handoff fingerprint를 graph 준비 및 claim 전에 재검증하고, durable `received` receipt가 없으면 consumer를 release하지 않는다.

실패 테스트:

- authorization manifest보다 강한 child contract 거부
- 다른 프로젝트 권한의 암묵적 상속 거부
- handoff schema/fingerprint 변조 차단
- durable/validated handoff 전 consumer claim 금지
- restart 후 handoff receipt 중복 적용 금지

완료 조건:

- 모든 프로젝트 간 dependency에 producer, consumer, schema, evidence가 있다.
- 권한 확대는 새 GlobalRunRevision과 사용자 경계를 요구한다.
- artifact/claim 전달과 filesystem 권한 위임이 분리된다.

구현·검증 근거:

- `src/global-runs.js`의 authorization manifest/dependency/handoff version·fingerprint validator
- `src/registry.js` schema version 6의 `authorization_manifests`, `cross_project_handoffs`, receipt recovery와 claim fencing
- `src/mcp-server.js`의 strict Global Run input schema와 validated handoff prompt injection
- `test/global-runs.test.js`의 권한 상향·root 상속·변조·receipt/reopen·v5 migration 테스트
- `test/mcp-server.test.js`의 실제 producer → durable handoff → consumer E2E

## G6 — Thread 수명주기와 생성 예산

상태: 완료. schema version 7의 분리된 lifecycle projection과 versioned project/role budget, Router의 wait/ephemeral 결정, 안전한 compact/archive fencing과 dashboard 진단을 구현했다.

실패 테스트:

- busy라는 이유만으로 budget 초과 fork 금지
- compact 조건 미충족 thread의 archive/cleanup 금지
- superseded thread의 Router 후보 제외
- 단발성 Task가 durable specialist를 불필요하게 생성하지 않음
- lineage와 provenance를 잃는 deletion 금지

완료 조건:

- [x] Router가 reuse/fork/spawn/ephemeral/wait 결정을 설명한다.
- [x] project/role별 thread budget과 context health가 versioned policy다.
- [x] sidebar 스레드 증가를 줄이면서 Task·evidence 기록은 유지한다.

구현·검증 근거:

- `src/thread-lifecycle.js`, `src/router.js`
- `src/registry.js` schema version 7의 `thread_lifecycle`, `thread_lifecycle_events`, `thread_budgets`
- MCP `list_thread_lifecycles`, `get_thread_budget`, `upsert_thread_budget`
- `src/dashboard-model.js`, `ui/dashboard.html`의 lifecycle/context health와 budget projection
- `test/thread-lifecycle.test.js`와 `automatic routing archives an ephemeral one-off worker after its terminal task`

## G7 — 최종 E2E

상태: 완료. 아래 12개 시나리오와 기존 안정화 게이트를 plugin 실행 없는 로컬 Node/SQLite/Git E2E로 검증한다. 상세 evidence는 [G7_E2E_EVIDENCE.md](./G7_E2E_EVIDENCE.md)에 고정한다.

1. [x] 기존 단일 프로젝트 read-only Run
2. [x] 기존 managed worktree 수정과 통합
3. [x] 두 프로젝트 read-only Global Run
4. [x] producer artifact를 consumer가 사용하는 다중 프로젝트 Run
5. [x] 충돌한 과거 스레드 맥락의 실행 전 차단
6. [x] 사용자 결정으로 conflict resolution 후 새 snapshot 실행
7. [x] authorization scope 확대 거부와 새 revision 승인 경계
8. [x] required Project Run 실패의 전역 실패 판정
9. [x] optional Project Run 실패의 warning 포함 완료
10. [x] daemon 재시작 후 context/global graph/handoff 복구
11. [x] 전역 취소와 부분 integration 결과 보존
12. [x] terminal GlobalResult의 작업 탐색기 표시와 Project/Task 스레드 이동

최종 게이트는 기존 [STABILIZATION_GATE.md](./STABILIZATION_GATE.md)의 10개 시나리오를 모두 포함한다. 새 기능 통과가 기존 계약 안정화 회귀를 허용하지 않는다.
