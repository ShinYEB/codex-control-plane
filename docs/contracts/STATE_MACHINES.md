# 상태 머신 계약

이 문서는 현재 코드에 분산된 상태 이름과 전이 규칙을 한곳에 모은다. 상태 변경은 Registry에 먼저 기록되고, 상태 변경 이벤트가 뒤따른다. 아래에 명시되지 않은 전이는 호환 경로나 복구 경로이며 신규 기능에서 사용하지 않는다.

## Global Run

```text
accepted -> resolving_context -> planning -> preparing -> running <-> waiting
                                                     \-> completed | failed | cancelled | attention_required
```

- `completed`, `failed`, `cancelled`, `attention_required`는 terminal이며 일반 역전이가 없다.
- required Project Run의 failure/cancel은 전역 성공으로 집계하지 않는다. optional failure는 terminal 완료 warning으로 보존한다.
- 전역 취소 intent, current validated revision, graph/authorization fingerprint를 모두 만족한 child Task만 claim할 수 있다.
- `running`/`waiting`은 Project Run의 durable 상태에서 다시 계산한다. commit된 `preparing` graph는 재시작 후 root를 release하고, graph 없는 중단 preparation은 `failed`로 수렴한다.
- 정확한 enum, 전이와 집계 의미는 `src/domain-states.js`의 Global Run 정의가 정본이다.

## Run

정상 자동 실행 경로는 다음과 같다.

```text
accepted -> planning -> preparing -> running -> completed
                                           \-> failed
                                           \-> cancelled
```

| 상태 | 의미 | 진입 주체 | 주요 종료 조건 |
|---|---|---|---|
| `draft` | 저수준 API로 생성했지만 아직 접수되지 않은 Run | Registry caller | 계획 또는 준비 시작 |
| `accepted` | 사용자 요청과 origin 정보가 영속화됨 | `dispatch_control_request` | 백그라운드 dispatch가 계획 시작 |
| `planning` | Planner가 DAG를 생성·수정 중 | daemon dispatch worker | 유효한 계획 생성 또는 계획 실패 |
| `preparing` | 유효한 전체 DAG를 원자적으로 저장하는 단계 | daemon scheduler | staged Task 전체 저장 및 자동 시작 |
| `agents_prepared` | 이전 수동 준비 흐름의 호환 상태 | compatibility API | `RunController.start()` |
| `awaiting_user_start` | 이전 dashboard-gated 흐름의 호환 상태 | compatibility API | `RunController.start()` |
| `running` | staged Task가 `queued`/`blocked`로 풀려 실행 가능 | Registry/RunController | 모든 Task가 terminal |
| `completed` | 실패 Task 없이 모든 Task가 terminal | Registry refresh | terminal |
| `failed` | 하나 이상의 실패·정책 차단·통합 차단 Task가 terminal | Registry refresh 또는 dispatch failure | terminal |
| `cancelled` | 실행이 사용자 취소로 종료됨 | RunController | terminal |

`agents_prepared`와 `awaiting_user_start`는 현재 자동 dispatch의 정상 상태가 아니다. `RunController.start()`가 읽는 이유는 저장 데이터와 저수준 API 호환성 때문이다. `releaseStagedRun()`의 반환값 `ready`도 저장되는 Run 상태가 아니다.

## TurnDispatch

TurnDispatch는 모든 Codex 명령에 적용되는 공통 실행 하위 상태 머신이다.

```text
prepared -> thread_acquiring -> thread_created -> turn_submitting -> turn_running
                                                                  -> completed | failed | interrupted
각 비terminal 상태 -> cancelling -> cancelled
                  \-> recovery_attention
```

- `thread_created`는 작업 준비 완료나 성공 상태가 아니다.
- `turn_running`은 `threadId + turnId + ownerToken + promptFingerprint`가 영속화된 상태다.
- 부모가 terminal이거나 cancellation generation이 달라지면 새 thread/Turn을 만들 수 없다.
- 제출 여부가 불확실한 `turn_submitting`은 기존 Turn을 reconcile하기 전 재전송할 수 없다.
- 상세 계약은 [TURN_DISPATCH.md](./TURN_DISPATCH.md)를 따른다.

Run 종료 판정은 Task 전체가 terminal일 때만 수행한다. `completed_with_warnings`는 Run을 실패시키지 않는다. `blocked_by_policy`와 `integration_blocked`는 Run을 `failed`로 만든다.

## Task

### 준비와 dependency

```text
staged -> queued ------------------------------+
      \-> blocked -> queued / skipped --------+---> running
```

- 전체 graph는 `staged` 상태로 한 transaction 안에 생성한다.
- dependency가 없는 Task는 자동 시작 시 `queued`, 있는 Task는 `blocked`가 된다.
- `all_success`: 모든 선행 Task가 성공해야 release한다. 실패한 dependency가 있으면 `skipped`로 끝난다.
- `all_terminal`: 모든 선행 Task가 성공 여부와 관계없이 terminal이면 release한다.
- `on_failure`: 선행 Task가 terminal이고 하나 이상 실패했을 때만 release한다. 실패가 없으면 `skipped`로 끝난다.

### Claim과 실행

```text
queued | retry_waiting | waiting_for_lease
  -> running
  -> agent_done -> validating
  -> integration_pending
  -> terminal or retry_waiting
```

| 상태 | 의미 |
|---|---|
| `queued` | dependency와 시간 조건을 만족해 claim 가능 |
| `waiting_for_lease` | 필요한 workspace/Agent lease를 얻지 못해 재대기 |
| `retry_waiting` | `next_retry_at`까지 재시도 대기 |
| `running` | daemon instance가 `worker_id + claim_token`으로 Task를 소유하고 Data Plane turn 실행 중 |
| `agent_done` | Data Plane turn은 끝났고 acceptance 검증이 남음 |
| `validating` | 별도 read-only Validator turn이 완료 기준을 확인 중 |
| `integration_pending` | managed worktree artifact를 main workspace에 통합 중 |
| `approval_waiting` | App Server 호환 승인 상태. 정상 Run은 `approvalPolicy=never`이므로 기본 경로가 아님 |
| `upgrade_pending` | 런타임 전환 관련 호환/표시 상태 |
| `recovery_attention` | 재시작 후 부작용 있는 active turn의 결과를 확정할 수 없어 자동 재실행하지 않는 격리 상태 |

### Terminal Task 상태

| 상태 | Run 성공으로 집계 | 의미 |
|---|---:|---|
| `completed` | 예 | 실행, 검증, 필요한 통합 완료 |
| `completed_with_warnings` | 예 | Validator가 경고와 함께 수락 |
| `skipped` | 예 | dependency policy상 실행할 필요가 없음 |
| `rejected` | 아니오 | 실행 또는 검증 결과 거부 |
| `validation_failed` | 아니오 | Validator 실행·구성 자체 실패의 terminal 결과 |
| `failed` | 아니오 | 실행 실패, 시도 예산 소진 포함 |
| `canceled` | 아니오 | Task 취소. 하나라도 취소된 Run은 실패 Task가 없다면 `cancelled`로 집계 |
| `interrupted` | 아니오 | active turn 중단 |
| `blocked_by_policy` | 아니오 | 외부·파괴적 작업 등 정책 경계 |
| `integration_blocked` | 아니오 | artifact는 있으나 안전한 통합 실패 |

Task는 미국식 `canceled`, Run은 영국식 `cancelled`를 사용한다. 이는 현재 저장/API 호환 이름이며 통합 여부는 별도 검토 대상이다.

## Claim fencing

Task claim은 조건부 SQLite update로 이루어진다.

- claim 가능한 상태: `queued`, 기한이 지난 `retry_waiting`, `waiting_for_lease`
- claim 전에 저장된 version, enum, 교차 필드, fingerprint를 검증한다. 실패하면 attempt를 증가시키지 않고 terminal configuration/policy 상태로 기록한다.
- claim 결과: `running`, `worker_id`, 새 `claim_token`, heartbeat, 증가한 attempt
- heartbeat, turn binding, 완료, 실패, 검증 전이는 모두 같은 `worker_id + claim_token`을 요구한다.
- claim 직후에도 계약을 다시 검증한다. 이 방어 검증이 실패하면 같은 claim token으로 failure를 기록하고 ownership을 제거한다.
- claim이 회수된 뒤 도착한 이전 worker 결과는 조건부 update에 실패하므로 저장되지 않는다.

## Agent와 Agent lease

정상 managed Agent 수명주기는 다음과 같다.

```text
idle/available -> leased -> running -> validating -> idle
```

- `agent_leases.agent_id`가 primary key이므로 한 Agent에는 active lease가 하나뿐이다.
- owner Task와 token이 일치해야 heartbeat 또는 release할 수 있다.
- 대상 Agent가 이미 leased이면 daemon은 안전한 fork 또는 새 Agent를 선택한다.
- terminal Task의 thread는 삭제하지 않고 결과 열람과 향후 재사용을 위해 보존한다.
- Agent 상태 전이는 `transitionAgent()`로 검증한다. App Server의 `notLoaded`는 Registry 경계에서 `available`로 정규화한다.

## Project queue와 leases

- project preparation queue: `queued -> leased -> completed`, 실패 시 `retry_waiting` 또는 terminal failure
- worktree lease: `active -> released | expired`; worktree entity 자체는 `retained`/`quarantined`가 될 수 있음
- dashboard lease: project key당 한 owner/token이며 TTL 이후에만 다른 owner가 획득한다.
- 만료 worktree lease는 자동으로 artifact를 삭제하거나 같은 workspace를 재할당하지 않는다.
- Agent/worktree lease 전이는 `transitionLease()`로 검증하며 terminal lease를 다시 사용할 때만 `active`로 재획득한다.

## Result delivery

```text
pending -> delivering -> delivered
                   \-> retry_waiting -> delivering
                                     \-> pending_attention
```

- delivery 전이는 `transitionDelivery()`로 검증한다.
- `delivered`는 terminal이며 되돌릴 수 없다.
- daemon이 `delivering` 중 종료되면 `retry_waiting`으로 복구한다.
- attempt 예산을 소진하면 `pending_attention`에서 사용자 확인을 기다린다.

## 상태 변경 규칙

1. Run/Task terminal 상태를 비terminal 상태로 되돌리는 일반 전이는 없다.
2. 예외는 명시적 Task 계약 복구다. 이전 failure와 fingerprint를 history에 남기고 해당 Task만 새 계약으로 다시 queue한다.
3. Run graph는 실행·thread binding 전에만 교체할 수 있다.
4. Task 상태와 Run 상태가 어긋나면 Run graph 조회와 background reconciliation이 `refreshRun()`으로 parent 상태를 복구한다.
5. 신규 상태를 추가할 때는 `src/domain-states.js`의 enum, 의미표, 전이표와 관련 SQL fencing 및 테스트를 함께 변경해야 한다.

## 구현 정본과 호환 상태

- 상태 집합, terminal/success/active 의미와 Run/Task 전이표의 구현 정본은 `src/domain-states.js`다.
- Registry SQL의 상태 조건은 atomic fencing을 위한 저장 계층 표현이며 중앙 의미와 함께 테스트한다.
- `recovery_attention`은 terminal failure이고 `approval_waiting`과 `upgrade_pending`은 active 상태다.
- 호환 상태 `awaiting_user_start`는 저장 데이터와 저수준 API 호환용이며 정상 자동 dispatch 경로에서는 생성하지 않는다.

이 항목은 [REVIEW_CHECKLIST.md](../REVIEW_CHECKLIST.md)에서 결정한다.
