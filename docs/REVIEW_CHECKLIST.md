# 설계 점검 체크리스트

이 문서는 설계 점검 항목과 결정 상태를 기록한다. 완료된 항목은 결정과 검증 근거를 남기고, 미결 항목은 다음 점검에서 `유지`, `변경`, `폐기` 중 하나로 결정한다.

## P0 — Durable TurnDispatch 구현

- 상태: 구현 및 자동 테스트 완료.
- 결정: 스레드 확보와 명령 제출을 `turn_dispatch_v1` 단일 프로토콜로 관리한다. `ready` 상태와 placeholder READY Turn은 사용하지 않는다.
- 구현: schema v8 `turn_dispatches`, 중앙 상태 의미·전이, 공통 `TurnDispatcher`, Planner/Worker/Validator/Synthesizer/Orchestrator 연결, 취소 generation fencing, restart reconciliation과 dashboard 고급 진단 projection.
- 검증: thread/Turn 선저장, 늦은 thread 응답 fencing, 이미 제출된 Turn의 read recovery, 동일 submission 중복 방지, migration과 전체 회귀 테스트.

## P0 — Evidence-based Completion Gate

- 상태: 핵심 구현 및 자동 테스트 완료.
- 결정: Agent와 Orchestrator 자연어는 성공 권한이 없다. daemon의 단일 Completion Evaluator가 전체 Turn item, 명령·테스트, output materialization, workspace diff, validation, integration journal과 destination postcondition을 결합한다.
- 정상 실행과 restart reconciliation은 같은 verdict 함수를 사용한다.
- 구현: final `thread/read` hydration과 item 병합, fingerprinted CompletionVerdict, 실제 test command와 output/mutation 검사, Validator 이후 integration 복구, destination artifact 적용 확인, Master/Synthesizer consistency fallback.
- 검증: 누락된 command event, non-zero exit와 성공 문구 충돌, 변경 없는 구현, 실행되지 않은 필수 검증, Validator 직후 crash, 통합 후 실패, 정상/복구 verdict 동등성.
- 근거: [ADR-008](./adr/ADR-008-EVIDENCE-BASED-COMPLETION.md), [Completion Gate 계약](./contracts/COMPLETION_GATE.md)

## P0 — 기준선 확정 전 결정

### 0. 제품 목적과 다음 설계 축

- 상태: 완료.
- 결정: 제품의 중심 문제를 스레드 지식 식별, 목표별 맥락 통합, 다중 프로젝트 전역 실행으로 정의한다. 기존 실행 안정화 계약은 기반으로 유지한다.
- 근거: [PRODUCT_DIRECTION.md](./PRODUCT_DIRECTION.md)

### 1. 상태 모델의 단일 정본

- 상태: 완료.
- 결정: Run, Task, Agent, Lease, Delivery enum·의미 집합·허용 전이를 `src/domain-states.js`의 단일 정본으로 둔다.
- 검증: 각 entity의 illegal transition과 모든 상태의 terminal/retry/recovery/attention 의미를 테스트한다.

### 2. `recovery_attention`의 정식 의미

- 상태: 완료.
- 결정: `recovery_attention`은 terminal attention failure이며 자동 retry 대상이 아니다. Run을 실패로 확정하고 사용자 repair/recovery 판단을 요구한다.
- 검증: restart recovery와 Run 집계가 이 의미를 공유하며 `nextAction`을 반환한다.

### 3. 저장 스키마 version과 migration

- 상태: 완료.
- 결정: SQLite `user_version`, migration 전 snapshot, transaction migration, `tasks.run_id` FK와 Task status CHECK를 사용한다.
- 검증: 구 DB upgrade/reopen, backup, FK와 invalid status 거부 테스트를 유지한다.

### 4. 자동 Start와 compatibility 상태

- 현상: 정상 흐름은 자동 시작이지만 `agents_prepared`, `awaiting_user_start`, manual source 이름이 남아 있다.
- 위험: API/UI가 다시 수동 Start를 제품 흐름으로 노출할 수 있다.
- 결정할 것: 호환 상태의 읽기 전용 유지 기간과 제거 migration.

### 5. 실패 유형과 category 정본

- 현상: 상세 type과 canonical category가 코드에 존재하지만 문서/화면은 두 수준을 혼용할 수 있다.
- 위험: retry와 notification 정책이 type 문자열에 과도하게 의존한다.
- 결정할 것: error code → type → category → next action의 versioned mapping.

### 6. 일부 Task 취소의 Run 판정

- 상태: 완료.
- 결정: terminal Task 중 하나라도 `canceled`이면 Run을 `cancelled`로 판정한다. 취소된 산출물을 성공으로 과장하지 않는다.
- 검증: 성공 Task와 canceled Task가 섞인 Run의 terminal 상태 테스트를 유지한다.

## P0 — 제품 방향 구현 전 결정

### 16. 맥락의 정본과 authority

- 상태: Claim·authority·ThreadKnowledge와 Context Snapshot Resolver 핵심 구현 완료.
- 결정: Registry의 versioned Context Claim과 immutable Context Snapshot을 정본으로 사용하고 스레드는 provenance로 유지한다.
- 결정: authority 순서, blocking conflict, snapshot fingerprint와 legacy memory candidate migration은 Context Resolution 계약을 따른다.
- 구현: schema version 4에서 source 없는 claim 활성화, authority downgrade supersede, active claim provenance 삭제, invalid/tampered snapshot의 Planner·claim 진입을 차단한다. managed Task 결과, Router/fork evidence와 snapshot 선택·제외·충돌을 영속화한다.
- 구현: dashboard polling은 Snapshot 요약만 반환하고 view lease 기반 상세 조회에서 선택·제외·충돌을 노출한다. 명시적 `requestedThreadIds`만 `thread/read`로 digest/topic 색인하며 원문은 보존하지 않는다.
- 결정할 것: Global Run의 project별 Context Snapshot slice API 호환성.
- 근거: [ADR-001](./adr/ADR-001-CONTEXT-SOURCE-OF-TRUTH.md)

### 17. 다중 프로젝트 실행 계층

- 상태: G4~G5 구현 완료.
- 결정: Global Run 아래에 기존 단일-project Run을 두고 cross-project dependency를 명시한다.
- 결정: 전역 상태, 권한 revision, 취소·실패 집계와 cross-project handoff는 Global Run 계약을 따른다.
- 구현: schema version 6의 Global Run/revision/membership/dependency/result, project authorization manifest와 durable handoff/receipt, 중앙 전이·집계, 원자적 graph 저장, validated revision release, 취소 및 claim fencing, 재시작 복구, MCP/dashboard projection.
- 결정할 것: Global/handoff API version 고정과 기존 단일 Run의 implicit wrapping 시점.
- 근거: [ADR-002](./adr/ADR-002-GLOBAL-RUN-HIERARCHY.md)

### 18. 스레드 생명주기와 생성 예산

- 상태: G6 구현 완료.
- 결정: 스레드를 제한된 실행·provenance 자원으로 관리하고 durable specialist와 ephemeral execution을 구분한다.
- 구현: schema version 7의 lifecycle/budget/event projection, 안전한 compact/archive fencing, successor snapshot을 요구하는 supersede, Router의 `reuse/fork/spawn/ephemeral/wait`, terminal ephemeral archive와 dashboard/MCP 진단.
- 운영 점검: 실제 App Server archive 실패는 cleanup attention event와 compacted 격리로 보존하며 런타임별 지원 여부를 관측한다.
- 근거: [ADR-003](./adr/ADR-003-THREAD-LIFECYCLE.md)

## P1 — 안정화 전에 결정

### 7. Test Task의 mutation 기본값

- 현상: 모든 `taskKind=test`는 기본적으로 mutating으로 컴파일된다.
- 선택지: 안전 여유 유지, `test-readonly` 분리, `mutatesWorkspace` 명시 의무화.
- 검증할 것: unit test, integration test, daemon lifecycle E2E 각각의 최소 권한.

### 8. `read-only + networkAccess` 금지 정책

- 현상: compiler는 filesystem read-only와 network access를 동시에 허용하지 않는다.
- 결정할 것: sandbox가 filesystem과 network를 하나의 level로 묶는 것이 맞는지, 독립 capability로 분리할지.

### 9. Delivery exactly-once의 범위

- 상태: 완료.
- 결정: direct append의 `direct_delivered`와 drain acknowledgement의 `delivered`를 별도 terminal 결과와 timestamp로 기록한다. durable key는 중복 시도를 억제하지만 host append 경계의 전역 exactly-once는 약속하지 않는다.

### 10. Project integration queue의 내구성

- 상태: 완료.
- 결정: process 내 직렬화에 더해 SQLite integration journal을 두고 `prepared → applying → applied → recorded`를 복구한다.
- 검증: applying/applied/recording 강제 종료와 중복 patch 방지 테스트를 유지한다.

### 11. Contract version upgrade

- 상태: 완료.
- 결정: 실행은 지원 version만 허용한다. repair는 최신 compiler로 새 contract revision/fingerprint를 만들며 이전 contract와 failure history를 보존한다.

## P2 — 운영성 점검

### 12. 문서-코드-테스트 추적 자동화

- 각 계약 문서의 invariant에 테스트 ID를 붙일지 결정한다.
- 상태/notification/contract 상수의 문서 drift 검사를 CI에 추가할지 결정한다.
- 구현 추적표의 각 영역이 실제 검증 테스트와 연결되는지 자동으로 확인한다.

### 13. Event schema와 retention

- event type naming/version, payload 최소 필드, 보존 기간이 아직 명시적으로 강제되지 않는다.
- 장기 실행 시 DB 크기와 개인정보/명령 기록 범위를 점검한다.

### 14. CWD project scope

- 상태: Project ID와 migration 구현 완료, Router/Context cutover 필요.
- 결정: raw cwd 비교를 권한 정본으로 사용하지 않는다. realpath와 Git common dir에 기반한 versioned canonical Project ID를 사용하고 모호한 충돌은 자동 병합하지 않는다.
- 구현: schema version 2가 Run, Task, Agent, Plan, memory에 `project_id`를 backfill하고 모호한 경로를 `migration_attention`으로 격리한다.
- 근거: [TARGET_PERSISTENCE.md](./contracts/TARGET_PERSISTENCE.md)

### 15. Orchestrator와 Synthesizer 중복 책임

- 상태: 결정 완료, 구현 필요.
- 결정: Synthesizer가 durable 상태에서 만든 Result projection만 사용자-visible 정본이다. Orchestrator 결과는 evidence이며 synthesis 실패 시 구조화된 fallback projection을 사용한다.
- 근거: [ADR-004](./adr/ADR-004-RESULT-AUTHORITY.md)

## 점검 기록 형식

각 항목을 결정할 때 다음 형식으로 기록한다.

```text
Decision:
Rationale:
Affected contracts:
Affected code:
Migration/compatibility:
Required tests:
Owner:
```

확정된 결정은 별도 ADR로 옮기고 이 체크리스트에서는 링크와 완료 상태만 남긴다.
