# 설계 문서 인덱스

이 디렉터리는 Codex Agent Control Plane `0.14.0`의 **현재 구현(as-is)** 을 설명하는 설계 기준선이다. 문서가 아직 구현하지 않은 목표를 설명할 때는 반드시 `제안` 또는 `점검 필요`라고 표시한다.

## 읽는 순서

1. [PRODUCT_DIRECTION.md](./PRODUCT_DIRECTION.md) — 프로젝트 시작 이유, 제품 정의, 현재 방향과 목표 구조
2. [ARCHITECTURE.md](./ARCHITECTURE.md) — 시스템 경계, 세 Plane의 책임, 핵심 불변조건
3. [TERMINOLOGY.md](./TERMINOLOGY.md) — 스레드, 세션, Run, Task 등 표준 용어
4. [adr/ADR-001-CONTEXT-SOURCE-OF-TRUTH.md](./adr/ADR-001-CONTEXT-SOURCE-OF-TRUTH.md) — 맥락의 정본과 provenance
5. [adr/ADR-002-GLOBAL-RUN-HIERARCHY.md](./adr/ADR-002-GLOBAL-RUN-HIERARCHY.md) — 다중 프로젝트 실행 계층
6. [adr/ADR-003-THREAD-LIFECYCLE.md](./adr/ADR-003-THREAD-LIFECYCLE.md) — 스레드 생성·재사용·압축·보관 정책
7. [adr/ADR-004-RESULT-AUTHORITY.md](./adr/ADR-004-RESULT-AUTHORITY.md) — Orchestrator, Synthesizer와 사용자-visible 결과 정본
8. [adr/ADR-005-AUTOMATIC-RUN-START.md](./adr/ADR-005-AUTOMATIC-RUN-START.md) — 사용자 요청 1회 승인과 graph 검증 후 자동 시작
9. [contracts/CONTEXT_RESOLUTION.md](./contracts/CONTEXT_RESOLUTION.md) — 지식 수집, authority, 충돌과 Context Snapshot
10. [contracts/CONTRACT_AUTHORITY.md](./contracts/CONTRACT_AUTHORITY.md) — 제품 계약 manifest, 권위, revision과 실행 전 충돌 차단
11. [contracts/GLOBAL_RUNS.md](./contracts/GLOBAL_RUNS.md) — Global Run 상태, 권한, 프로젝트 간 dependency
12. [contracts/TARGET_PERSISTENCE.md](./contracts/TARGET_PERSISTENCE.md) — 목표 schema, 원자성, migration과 호환성
13. [contracts/STATE_MACHINES.md](./contracts/STATE_MACHINES.md) — 현재 Run, Task, Agent, Lease의 상태와 전이
14. [contracts/EXECUTION_CONTRACT.md](./contracts/EXECUTION_CONTRACT.md) — 권한, sandbox, workspace, 부작용 계약
15. [contracts/PERSISTENCE.md](./contracts/PERSISTENCE.md) — 현재 SQLite 소유권, 원자성, 멱등성, 저장 모델
16. [contracts/RESULT_DELIVERY.md](./contracts/RESULT_DELIVERY.md) — 결과 종합, 알림, 원래 대화로의 전달
17. [operations/FAILURE_RECOVERY.md](./operations/FAILURE_RECOVERY.md) — 실패 분류, 재시도, 재시작 복구, worktree 복구
18. [operations/RUNTIME_LIFECYCLE.md](./operations/RUNTIME_LIFECYCLE.md) — 런타임 identity, 데몬 handover, 배포·재설치
19. [STABILIZATION_GATE.md](./STABILIZATION_GATE.md) — 1~8단계 안정화의 최종 E2E 검증 근거
20. [GLOBAL_ORCHESTRATION_GATE.md](./GLOBAL_ORCHESTRATION_GATE.md) — 새 설계의 구현 순서와 최종 E2E 게이트
21. [G7_E2E_EVIDENCE.md](./G7_E2E_EVIDENCE.md) — 최종 12개 시나리오의 자동 검증 evidence
22. [REVIEW_CHECKLIST.md](./REVIEW_CHECKLIST.md) — 현재 설계에서 다음 점검 때 결정해야 할 항목

## 문서의 권위와 변경 규칙

- 이 문서는 현재 동작을 사람이 검토할 수 있게 정리한 기준선이다.
- 코드와 문서가 다르면 코드가 현재 동작의 증거이지만, 차이는 결함으로 기록하고 어느 쪽이 맞는지 결정해야 한다.
- 권한이나 상태 전이를 바꾸는 변경은 관련 계약 문서와 테스트를 같은 변경에서 수정해야 한다.
- 호환성 필드는 문서에서 표준 용어로 설명하되, 저장 데이터와 공개 API의 기존 이름은 임의로 변경하지 않는다.
- `README.md`는 제품 소개와 사용법을 담당하고, 세부 설계의 정본은 이 디렉터리에 둔다.
- 제품 목적과 우선순위 판단의 정본은 `PRODUCT_DIRECTION.md`이며, 채택된 설계 결정은 `adr/`에 둔다.

## 구현 추적 기준

| 설계 영역 | 주요 구현 | 주요 검증 |
|---|---|---|
| 요청 접수와 그래프 준비 | `src/mcp-server.js`, `src/planner-engine.js` | `test/mcp-server.test.js`, `test/planner-engine.test.js` |
| 실행 계약 | `src/execution-contracts.js` | `test/execution-contracts.test.js` |
| 상태와 원자적 claim | `src/registry.js`, `src/run-controller.js` | `test/registry.test.js`, `test/run-controller.test.js` |
| 라우팅과 agent lease | `src/router.js`, `src/mcp-server.js` | `test/registry.test.js`, `test/mcp-server.test.js` |
| 검증 | `src/result-validator.js` | `test/result-validator.test.js` |
| worktree와 통합 | `src/worktree-manager.js` | `test/worktree-manager.test.js` |
| 결과 전달과 알림 | `src/registry.js`, `src/mcp-server.js`, `src/notification-policy.js` | `test/registry.test.js`, `test/mcp-server.test.js`, `test/notification-policy.test.js` |
| 데몬과 generation | `src/daemon.js`, `src/daemon-client.js`, `src/build-info.js` | `test/daemon.test.js`, `test/reinstall-preflight.test.js` |
| Project identity와 legacy claim migration | `src/project-identity.js`, `src/registry.js` schema v2 | `test/project-identity.test.js`, `test/registry.test.js` migration/project tests |
| Claim·ThreadKnowledge·routing evidence | `src/context-claims.js`, `src/context-manager.js`, `src/registry.js`, `src/router.js` | `test/context-claims.test.js`, `test/context-manager.test.js`, routing tests |
| Context Resolution | G3 완료: immutable snapshot, 과거 thread digest, conflict/fingerprint gate, Planner·Task·dashboard 연동 | `src/context-resolver.js`, `src/thread-knowledge-indexer.js` |
| Global Run core | G4 완료: 중앙 상태, 원자적 Project Run graph, dependency release/집계, 취소·claim fencing, 재시작 복구, MCP/dashboard projection | `src/global-runs.js`, `src/domain-states.js`, `src/registry.js`, `test/global-runs.test.js` |
| Cross-project handoff와 권한 ceiling | G5 완료: schema v6 project manifest, handoff evidence/content hash/receipt, consumer claim fencing과 재시작 멱등 복구 | `src/global-runs.js`, `src/registry.js`, `test/global-runs.test.js`, `test/mcp-server.test.js` |
| Thread lifecycle | G6 완료: schema v7 lifecycle projection, versioned budget, wait/ephemeral routing, compact/archive fencing과 dashboard 진단 | `src/thread-lifecycle.js`, `src/registry.js`, `src/router.js`, `test/thread-lifecycle.test.js` |

추적 대상이 없거나 구현과 문서가 어긋나는 항목은 [REVIEW_CHECKLIST.md](./REVIEW_CHECKLIST.md)에 남긴다.
