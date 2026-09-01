# Global Run과 다중 프로젝트 실행 계약

- 설계 상태: G4~G7 구현 및 최종 E2E 검증 완료. 상태·원자적 graph·프로젝트별 권한 ceiling·durable handoff/receipt·Project Run release/집계·취소/claim fencing·재시작 projection을 제공한다.
- 선행 결정: [ADR-002](../adr/ADR-002-GLOBAL-RUN-HIERARCHY.md)

이 문서는 하나의 사용자 목표를 여러 프로젝트의 Run으로 계획·실행·집계하는 전역 계약을 정의한다. 기존 Run, Task와 execution contract는 Project Run 내부에서 그대로 적용한다.

## 엔터티 계층

```text
GlobalRun
  -> GlobalRunRevision
  -> ProjectRunMembership -> existing Run
  -> CrossProjectDependency
  -> ContextSnapshot
  -> GlobalResult
  -> existing durable origin delivery
```

기존 `runs` row는 하나의 canonical project identity와 권한 경계를 소유한다. `GlobalRun`은 여러 Run을 묶지만 그 내부 상태를 직접 건너뛰거나 Task를 claim하지 않는다.

## Global Run 요청

공개 요청 계약은 `apiVersion=1`이다. 호환성을 위해 version 누락은 v1로 해석한다. v1 이외의 값은 Global Run, Project Run, Task를 저장하기 전에 `GLOBAL_RUN_API_VERSION_UNSUPPORTED`로 거부한다. Cross-project handoff schema도 v1이며 dependency마다 고정한다.

```text
GlobalRunRequest
  objective
  request_key
  origin_host_id
  origin_thread_id
  origin_turn_id?
  project_scopes[]
  requested_dependencies[]?
  authorization_manifest
```

각 project scope는 canonical project ID, 허용 workspace root, 읽기/변경 의도와 side-effect ceiling을 명시한다. 문자열 `cwd` 목록만으로 전역 권한을 표현하지 않는다.

## 상태 머신

정상 경로는 다음과 같다.

```text
accepted
  -> resolving_context
  -> planning
  -> preparing
  -> running <-> waiting
  -> completed
       \-> failed
       \-> cancelled
       \-> attention_required
```

| 상태 | 의미 | terminal |
|---|---|---:|
| `accepted` | objective, origin, project scope가 영속화됨 | 아니오 |
| `resolving_context` | 전역 Context Snapshot을 만들고 검증 중 | 아니오 |
| `planning` | Project Run graph와 cross-project dependency를 생성 중 | 아니오 |
| `preparing` | 전체 graph와 계약을 transaction으로 저장 중 | 아니오 |
| `running` | 하나 이상의 Project Run이 실행 가능하거나 실행 중 | 아니오 |
| `waiting` | dependency, bounded retry 또는 명시된 외부 입력을 기다림 | 아니오 |
| `completed` | 모든 required Project Run이 성공 terminal | 예 |
| `failed` | required scope가 실패했거나 전역 계약이 invalid | 예 |
| `cancelled` | 사용자 전역 취소가 수렴함 | 예 |
| `attention_required` | 자동 복구가 안전하지 않아 terminal attention으로 격리됨 | 예 |

`attention_required`는 무기한 active 대기가 아니다. repair 또는 재개는 기존 terminal row를 되돌리지 않고 새 GlobalRunRevision과 execution lineage를 만든다.

## 허용 전이 원칙

- `accepted -> resolving_context | failed | cancelled`
- `resolving_context -> planning | failed | attention_required | cancelled`
- `planning -> preparing | failed | attention_required | cancelled`
- `preparing -> running | failed | attention_required | cancelled`
- `running -> waiting | completed | failed | cancelled | attention_required`
- `waiting -> running | failed | cancelled | attention_required`
- terminal 상태에서 일반 역전이는 없다.

정확한 enum, 의미 집합과 전이표의 구현 정본은 `src/domain-states.js`다. Registry의 `updateGlobalRun()`은 이 전이표를 통과하며 terminal 상태의 일반 역전이를 거부한다.

## 전체 graph 준비 게이트

```text
persist GlobalRun(accepted)
  -> resolve/validate Context Snapshot
  -> canonicalize and authorize project set
  -> plan Project Run graph
  -> compile/validate every Task execution contract
  -> validate cross-project handoff contracts
  -> project workspace preflight
  -> atomically persist revision + memberships + dependencies + staged Runs/Tasks
  -> release root Project Runs
```

다음이 완료되기 전에는 Project Run claim, Agent/turn/worktree 생성과 attempt 증가를 금지한다.

- GlobalRunRevision status가 `validated`
- Context Snapshot status가 `validated`
- project graph가 acyclic
- 모든 required project identity가 canonical
- 모든 Task contract가 valid
- authorization manifest fingerprint가 일치

schema version 6은 Project Run마다 versioned authorization manifest를 저장한다. manifest는 canonical project/root, task kind, mutation, side-effect policy, sandbox ceiling, network와 workspace mode를 고정한다. 전체 manifest-set fingerprint와 project별 fingerprint를 revision·Run·Task marker에 연결하고 graph 준비와 claim 직전에 재계산한다.

## Cross-project dependency

```text
CrossProjectDependency
  id
  global_run_revision_id
  producer_project_run_id
  producer_task_key?
  consumer_project_run_id
  consumer_task_key?
  condition: all_success | all_terminal | on_failure
  required_outputs[]
  acceptance_criteria[]
  handoff_schema_version
  fingerprint
```

- producer와 consumer는 같을 수 없다.
- dependency graph cycle과 자기 dependency를 거부한다.
- consumer는 required output evidence가 durable handoff에 저장되고 `validated -> received` receipt가 기록될 때만 release된다.
- handoff에는 output evidence, validation과 artifact identity/content hash를 사용한다. workspace path는 payload에서 제거하며 filesystem 권한을 전달하지 않는다.
- handoff 변조는 consumer attempt 전에 차단한다.

## 전역 권한

Authorization manifest는 GlobalRunRevision마다 immutable하다.

```text
AuthorizationManifest
  project_id
  allowed_roots[]
  task_kinds[]
  mutates_workspace
  side_effect_ceiling
  network_access
  granted_by_origin
  fingerprint
```

규칙:

1. Project Run 계약은 manifest보다 강한 권한을 가질 수 없다.
2. 프로젝트 추가, root 확대, network 허용 또는 side-effect 상향은 새 revision과 사용자 권한 확인이 필요하다.
3. 한 프로젝트의 workspace 권한은 다른 프로젝트로 전이되지 않는다.
4. `external`과 `destructive`는 기존 실행 계약과 마찬가지로 자동 전역 승인하지 않는다.
5. Planner prose, Context Claim, thread role은 authorization manifest를 수정할 수 없다.

## 집계 규칙

Project Run membership은 `required` 또는 `optional`이다.

1. 전역 사용자 취소가 있으면 Global Run은 모든 child cancellation을 시도한 뒤 `cancelled`로 수렴한다.
2. required Project Run 하나라도 failure terminal이면, 나머지 required/cleanup 경로가 terminal이 된 뒤 `failed`로 수렴한다.
3. required Project Run 하나라도 cancelled이면 Global Run을 성공으로 판정하지 않는다. 전역 취소가 아니면 `failed`와 cause `required_project_cancelled`을 사용한다.
4. 모든 required Project Run이 success terminal이고 optional Project Run도 terminal이면 `completed`다.
5. optional failure는 Global Run을 실패시키지 않지만 `completed` 결과의 warning과 누락 scope에 반드시 포함한다.
6. `skipped` Project Run은 dependency policy가 명시적으로 허용할 때만 success-equivalent다.
7. child `recovery_attention`이나 안전하지 않은 integration 상태가 자동으로 확정되지 않으면 `attention_required`로 수렴한다.

Global Run은 일부 성공 결과를 전체 성공으로 과장하지 않는다.

## 취소

- 전역 취소 요청을 먼저 durable event로 기록한다.
- 아직 release되지 않은 Project Run과 Task는 새 claim을 금지하고 취소한다.
- active Task에는 기존 fenced cancellation을 요청한다.
- 이미 적용된 integration을 자동 rollback하지 않는다. 적용 결과를 synthesis에 기록한다.
- 취소 중 daemon이 종료되면 재시작 후 cancellation intent를 계속 적용한다.
- Project Run 단독 취소는 해당 membership이 optional인지 required인지에 따라 전역 상태를 다시 집계한다.

## Retry와 repair

- Project Run/Task retry는 기존 중앙 retry policy를 사용한다.
- 같은 configuration fingerprint, context snapshot fingerprint와 authorization fingerprint 조합을 자동 반복하지 않는다.
- Context conflict, project identity 또는 authorization 오류는 transient failure가 아니다.
- repair는 변경된 부분에 새 revision/fingerprint를 만들고 이전 graph와 failure history를 보존한다.
- 이미 성공하고 입력 fingerprint가 변하지 않은 Project Run은 repair로 다시 실행하지 않는다.

## 결과와 전달

GlobalResult는 다음을 포함한다.

- objective와 terminal status
- Context Snapshot revision
- required/optional Project Run별 상태와 결과
- cross-project handoff 결과
- 적용·미적용 artifact
- warning, failure, attention과 nextAction
- 누락 또는 충돌한 scope

GlobalResult가 사용자-visible terminal 결과의 정본이다. Project Run 결과는 근거로 연결한다. 기존 durable origin delivery를 재사용하며 dashboard는 결과 전달의 필수 경로가 아니다.

## 재시작 복구

- `resolving_context`, `planning`, `preparing`은 side effect 전 단계이므로 idempotency key와 revision을 확인해 재개하거나 terminal configuration failure로 정리한다.
- `running`과 `waiting`은 child Run의 durable 상태에서 projection을 복구한다.
- 전체 graph가 commit되지 않은 `preparing` revision은 release하지 않는다.
- terminal GlobalResult와 delivery가 어긋나면 결과를 다시 계산하지 않고 저장된 projection의 delivery만 복구한다.

## 검증 상태

G4~G5에서 구현하고 자동화한 실패 테스트:

- illegal Global Run transition
- 순환 graph와 transaction 중간 저장 실패의 전체 rollback
- validated revision만 root release
- dependency 성공 전 consumer `staged` 유지
- required/optional failure 집계와 warning 보존
- 취소·graph fingerprint 변조 후 claim/attempt 차단
- `recovery_attention -> attention_required`
- daemon 재시작 시 committed graph release와 pre-graph preparation 실패 수렴
- child contract의 project authorization ceiling 초과와 다른 project root 상속 차단
- dependency schema/fingerprint와 persisted handoff content/fingerprint/receipt 변조 차단
- `received` receipt 전 consumer release/claim 차단
- receipt 기록 중 재시작 후 동일 row/hash로 멱등 복구
- v5 DB의 v6 authorization/handoff schema migration, backup과 reopen

아래 항목은 전체 계약의 남은 G6~G7 검증 목록이다.

1. invalid project scope가 child Run과 attempt 생성 전에 차단된다.
2. authorization manifest보다 강한 child contract가 거부된다.
3. cross-project cycle이 전체 graph transaction 전에 거부된다.
4. handoff fingerprint 변조가 consumer claim 전에 차단된다.
5. required child failure가 Global Run 성공으로 집계되지 않는다.
6. optional child failure가 warning 없이 숨겨지지 않는다.
7. required child 단독 취소가 성공으로 집계되지 않는다.
8. 전역 취소 후 새 child claim이 생성되지 않는다.
9. preparing 중 crash가 부분 graph나 worker를 남기지 않는다.
10. terminal attention이 동일 revision 자동 재시도로 되돌아가지 않는다.
11. repair가 변경되지 않은 성공 Project Run을 다시 실행하지 않는다.
12. terminal GlobalResult가 origin delivery와 drain fallback으로 한 번 acknowledge된다.
