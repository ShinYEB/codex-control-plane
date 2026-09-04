# 영속성 계약

Control Plane daemon은 SQLite Registry의 단일 논리 writer다. MCP proxy, dashboard, Data Plane thread는 Registry 파일을 직접 수정하지 않고 daemon RPC를 사용한다.

## Storage location

- 기본 DB: `~/.codex/control-plane/v2/registry.sqlite`
- override: `CODEX_CONTROL_DB`
- legacy DB가 있으면 최초 시작 시 SQLite snapshot으로 한 번 이관한다.
- managed worktree와 artifact는 DB가 아니라 `~/.codex/control-plane/worktrees` 아래에 두고 DB에는 경로와 상태를 저장한다.

`v2` 경계는 이전 MCP/daemon generation과 새 generation이 같은 작업을 동시에 선점하지 못하게 하는 물리적 격리다.

## Data ownership

| 영역 | 테이블 | 역할 |
|---|---|---|
| 작업 주체 | `agents`, `role_templates`, `agent_leases` | thread profile, 전문화, 단일 Task lease |
| 실행 | `runs`, `tasks`, `task_dependencies`, `plans`, `plan_revisions` | 요청, DAG, 계획과 revision |
| 조정 | `project_queue_items`, `worktree_leases`, `dashboard_leases`, `approvals` | project serialization, workspace/화면 소유권, 호환 승인 기록 |
| 결과 | `run_results`, `notifications`, `notification_receipts` | terminal projection과 작업 탐색기 알림 |
| legacy 결과 전달 | `control_result_deliveries` | 이전 버전 migration·감사 호환; 새 Run은 row를 만들지 않음 |
| workspace | `managed_worktrees` | branch, path, baseline, artifact, integration 상태 |
| context | `project_memories`, `settings` | 프로젝트 지식과 Control Plane owner 등 설정 |
| project identity | `projects`, `project_path_mappings`, `migration_attention` | canonical project 경계, 관측 경로와 모호한 migration 격리 |
| context migration | `context_claims`, `context_claim_sources` | legacy memory의 검증 전 candidate claim과 provenance |
| thread knowledge | `thread_knowledge_snapshots`, `thread_knowledge_claims`, `thread_lineage` | source digest 기반 지식 snapshot, claim 연결과 fork/supersede 계보 |
| thread lifecycle | `thread_lifecycle`, `thread_lifecycle_events`, `thread_budgets` | 실행 상태와 분리된 수명주기 projection, 전이 감사, project/role 생성 예산 revision |
| routing evidence | `routing_decisions` | 후보, 선택 근거, 제외 사유와 decision fingerprint |
| Turn dispatch | `turn_dispatches`, 공통 `events` | thread 확보, submission intent, turn binding, owner/cancel fencing과 reconciliation evidence |
| global orchestration | `global_runs`, `global_run_revisions`, `global_run_projects`, `cross_project_dependencies`, `global_run_results` | 전역 목표 revision, Project Run membership/dependency와 terminal projection |
| audit | `events` | entity별 append-only 상태·결정 기록 |

## Atomic graph creation

Run과 Task DAG materialization은 `BEGIN IMMEDIATE` transaction으로 처리한다.

1. 전체 Task의 execution contract를 단일 validator로 compile/validate한다.
2. managed worktree가 필요한 Task는 repository preflight를 수행한다.
3. 전체 Task graph의 key와 dependency를 검증한다.
4. cycle과 자기 dependency를 거부한다.
5. Run을 create/update한다.
6. 모든 Task를 `contractStatus=validated`와 검증 fingerprint를 포함해 `staged`로 저장한다.
7. 모든 dependency edge를 저장한다.
8. transaction commit 후에만 이벤트를 기록하고 자동 시작한다.

중간 실패 시 rollback하므로 부분 graph와 placeholder Task가 남지 않는다. graph는 Run이 시작되지 않았고 모든 Task가 아직 unbound `staged`일 때만 원자적으로 교체할 수 있다.

Global Run graph도 하나의 outer `BEGIN IMMEDIATE` transaction에서 revision, 기존 Run 기반 Project Run, Task DAG, membership과 cross-project dependency를 저장한다. 내부 Task graph는 savepoint를 사용한다. 어떤 Project Run 저장이 실패해도 앞서 저장한 Project Run과 Task를 포함해 revision 전체를 rollback하며, validated revision commit 이후에만 root Project Run을 release한다.

## Idempotency

- `runs.request_key`는 non-null unique index다.
- `plans.request_key`는 unique다.
- 동일 request key의 control request는 기존 Run을 반환한다.
- Task 계약의 `idempotencyKey`는 execution fingerprint와 함께 retry 판단에 사용한다.
- legacy delivery row는 `${runId}:${originThreadId}` unique key를 유지한다.
- notification은 `dedupe_key` unique constraint를 사용한다.
- notification receipt는 `(notification_id, audience_id)` 복합 key다.

멱등성은 중복 요청을 기존 durable entity로 수렴시키는 것이며, 외부 side effect의 exactly-once를 보장하지 않는다. 외부 side effect를 자동 실행하지 않는 이유이기도 하다.

## Concurrency and fencing

- SQLite conditional `UPDATE ... RETURNING`이 queue claim과 Task claim의 원자적 소유권 획득을 담당한다.
- Task claim은 저장 계약의 `contractStatus=validated`와 검증 fingerprint가 현재 fingerprint와 일치할 때만 허용한다.
- Global Run child Task claim은 current validated revision, graph/authorization fingerprint, non-terminal parent 상태와 cancellation intent까지 같은 SQL 조건에서 확인한다.
- 계약·정책 오류는 claim 전에 terminal 처리하므로 attempt, Agent lease, Codex turn, managed worktree를 소비하지 않는다.
- Task completion에는 `worker_id + claim_token`이 모두 일치해야 한다.
- Agent lease에는 owner Task와 owner token이 필요하다.
- dashboard server와 worktree lease는 단일 owner/token/TTL을 사용한다. 채팅별 dashboard view lease는 process memory의 TTL token이며, 저장된 Control Plane owner는 신원 fallback으로만 사용한다.
- Run integration은 process 내 repository별 promise queue로 직렬화하고 SQLite integration journal로 crash recovery와 중복 적용 방지를 보장한다.

## JSON metadata

빠르게 변하는 상세 데이터는 `metadata_json`과 도메인별 JSON column에 저장한다. 예:

- execution contract, contract version/fingerprint/revision, validation status/time/error, routing decision, failure history
- Run origin, dispatch phase, scheduler/orchestrator identity
- durable TurnDispatch의 prompt/contract fingerprint, thread/turn identity, owner token, cancellation generation과 probe evidence
- worktree baseline, artifact, integration result
- durable integration journal과 적용 evidence
- context pack provenance

JSON에 새 필드를 추가할 때는 missing field를 정상으로 처리하고 default를 명시해야 한다. 기존 field의 의미를 바꾸지 말고 새 version 또는 새 field를 사용한다.

## Schema evolution

Registry는 `PRAGMA user_version`으로 schema version을 관리한다.

현재 schema version `8`은 v7의 canonical Project ID, Context Claim·ThreadKnowledge, immutable Context Snapshot, Global Run, durable cross-project handoff/receipt와 thread lifecycle/budget에 `turn_dispatches`를 추가한다. v6→v7 migration은 기존 Agent 상태를 candidate/active/idle/archived lifecycle로 backfill하고 기존 routing decision CHECK를 wait/ephemeral까지 확장한다. Run, Task, Agent, Plan과 memory는 호환 `cwd`와 함께 nullable `project_id`를 저장한다. 실제로 canonicalize할 수 없는 과거 경로는 ID를 추측하지 않고 `migration_attention`에 남긴다. 기존 `project_memories`는 `legacy_unverified + candidate` Context Claim으로 이관되며 자동으로 active 지식이 되지 않는다.

Context Claim은 candidate로 생성한 뒤 provenance source를 저장해야 active/disputed로 전이할 수 있다. SQLite trigger도 source 없는 활성화와 active claim의 마지막 source 삭제를 거부한다. authority가 낮은 claim은 높은 authority claim을 supersede할 수 없으며 사용자 명시 결정은 다른 사용자 명시 결정만 supersede할 수 있다.

- 기존 DB를 올리기 전 `VACUUM INTO` snapshot을 원본 옆에 만든다.
- DDL, backfill, table rebuild, version 갱신은 하나의 `BEGIN IMMEDIATE` transaction에서 수행한다.
- `tasks.run_id`는 `runs(id)`를 참조하는 정식 FK이며 legacy `metadata.runId`를 backfill한다.
- Task status는 중앙 상태 enum에서 생성한 SQLite CHECK constraint로 제한한다.
- migration 후 reopen 시 같은 migration이나 backup을 반복하지 않는다.
- Registry와 managed worktree directory는 runtime cache 배포·재설치 대상에 포함하지 않는다.

현재 구현은 forward migration만 자동화한다. downgrade는 runtime swap이 아니라 migration 전 snapshot을 이용한 명시적 운영 복구로 수행한다.

## Retention

- terminal Run은 archive할 수 있지만 기본적으로 삭제하지 않는다.
- Agent thread도 archive/unarchive하며 durable history를 보존한다.
- event, result, failure history는 진단 근거다.
- clean integrated worktree는 cleanup할 수 있다.
- dirty, uninspectable, conflict artifact는 retain 또는 quarantine한다.
- material deletion API는 정확한 entity/worktree를 대상으로 해야 하며 broad cleanup을 허용하지 않는다.

## Consistency checks

재시작과 조회 시 다음 불일치를 복구한다.

- 모든 Task가 terminal인데 parent Run이 running인 경우 `refreshRun()`으로 terminalize
- legacy `delivering` row는 감사용으로 보존하며 새 daemon은 origin append를 재개하지 않음
- stale active Task를 Codex `thread/read` 결과와 대조
- 만료 queue/lease owner를 조건부로 회수
- committed Global Run graph의 root release와 child 상태 projection을 복구하고, graph commit 전 중단된 preparation은 구조화된 terminal failure로 수렴

복구가 결과를 안전하게 확정할 수 없고 Task에 side effect가 있으면 자동 재실행하지 않는다.

schema version 8의 `turn_dispatches`는 [TURN_DISPATCH.md](./TURN_DISPATCH.md)의 identity·ownership·cancellation·recovery 필드, subject/purpose/revision uniqueness와 owner-token conditional update를 제공한다.
