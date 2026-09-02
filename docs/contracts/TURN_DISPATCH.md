# Durable Turn Dispatch 계약

- 계약 버전: `turn_dispatch_v1`
- 설계 상태: schema v8과 공통 dispatcher로 구현
- 적용 대상: Planner, Orchestrator, Data Plane, Validator, Synthesizer Turn

## 목적

스레드 생성·재개와 명령 전송을 서로 무관한 두 동작으로 취급하지 않는다. Control Plane은 하나의 논리적 `TurnDispatch`를 영속화하고, 그 Dispatch가 어느 Codex 스레드와 Turn에 결합됐는지 추적한다.

이 계약이 보장해야 하는 것은 다음 세 가지다.

1. 명령이 전송되지 않았는지, 전송됐지만 결과 관찰을 잃었는지 구분한다.
2. daemon 재시작이나 연결 단절 후 같은 명령을 무조건 다시 보내지 않는다.
3. 취소되거나 소유권을 잃은 Run/Task가 새 스레드나 Turn을 만들지 못한다.

## 용어와 불변조건

- **Thread identity**: 영구 Codex 대화를 식별하는 `threadId`다. 생성됐다는 사실만으로 작업이 시작된 것이 아니다.
- **Turn identity**: 실제 명령 한 회를 식별하는 `turnId`다.
- **TurnDispatch**: 하나의 Run phase 또는 Task가 한 prompt를 정확한 스레드의 Turn으로 제출하고 terminal 결과를 회수하는 내구성 있는 레코드다.
- **Dispatch owner**: 상태를 변경할 수 있는 daemon instance와 fencing token이다.
- **Dispatch revision**: repair나 명시적 새 명령을 구분하는 단조 증가 revision이다.

다음 불변조건을 지킨다.

1. placeholder `READY` Turn을 만들지 않는다.
2. `thread_created`는 준비 완료나 작업 성공을 뜻하지 않는다.
3. `turn_running`은 `threadId`, `turnId`, prompt fingerprint와 owner token이 저장된 뒤에만 성립한다.
4. 하나의 `(subjectType, subjectId, purpose, revision)`에는 active Dispatch가 최대 하나다.
5. terminal 또는 취소된 부모는 새 `thread/start`, `thread/resume`, `turn/start`를 호출할 수 없다.
6. 동일 prompt fingerprint의 제출 여부가 불확실하면 재전송하지 않고 먼저 reconcile한다.
7. App Server notification은 관찰 신호이며 정본은 아니다. Registry의 Dispatch와 `thread/read` 결과를 함께 사용한다.

## 정상 흐름

```text
Run/Task authorization and contract validated
  -> create TurnDispatch(prepared)
  -> acquire dispatch owner token
  -> choose reuse | resume | spawn
  -> persist threadId(thread_created)
  -> recheck parent status + cancellation generation + owner token
  -> persist submission intent(turn_submitting)
  -> call turn/start once
  -> persist turnId(turn_running)
  -> observe notification and periodically reconcile with thread/read
  -> persist terminal Turn evidence
  -> complete | fail | interrupt the owning Plan/Task phase
  -> release dispatch ownership
```

App Server가 향후 thread 생성과 첫 prompt의 원자적 제출을 지원해도, 반환된 `threadId`와 `turnId`를 같은 Dispatch에 기록하는 규칙은 유지한다.

## 상태 머신

```text
prepared
  -> thread_acquiring
  -> thread_created
  -> turn_submitting
  -> turn_running
  -> completed | failed | interrupted

각 비terminal 상태
  -> cancelling -> cancelled
  -> recovery_attention
```

| 상태 | 영속화된 사실 | 허용되는 다음 동작 |
|---|---|---|
| `prepared` | 목적, 부모, revision, prompt fingerprint, 실행 옵션 | owner 획득 |
| `thread_acquiring` | 선택 정책과 owner token | 기존 thread resume 또는 새 thread 생성 |
| `thread_created` | 확정된 `threadId`와 생성/reuse 근거 | 부모·취소·owner 재검증 |
| `turn_submitting` | 제출 의도와 submission key | `turn/start` 1회 호출 또는 reconcile |
| `turn_running` | 확정된 `turnId`와 시작 시각 | notification 관찰, `thread/read`, interrupt |
| `completed` | terminal Turn과 결과 evidence | 부모 phase 완료 |
| `failed` | terminal failure와 분류 | 부모 failure/retry 판단 |
| `interrupted` | App Server가 확정한 중단 | 부모 interrupted/retry 판단 |
| `cancelling` | durable cancellation intent | active Turn interrupt와 reconciliation |
| `cancelled` | Turn 없음 또는 중단 확인, lease 해제 | terminal |
| `recovery_attention` | 제출/side effect 여부를 안전하게 확정할 수 없음 | 사용자 또는 repair 절차 |

`ready`는 이 상태 집합에 존재하지 않는다.

## Deadline과 watchdog

각 deadline은 Dispatch 생성 시 절대 시각으로 저장한다. 재시작이 시간을 초기화하지 않는다.

| 구간 | 기본 한도 | 만료 시 처리 |
|---|---:|---|
| owner 획득과 thread 확보 | 30초 | 명확한 transient면 제한 retry, 아니면 `failed` |
| `turn_submitting` 응답 대기 | 30초 | 즉시 재전송하지 않고 reconcile |
| active Turn probe 간격 | 15초 | notification 유실 여부를 `thread/read`로 확인 |
| Turn 실행 | execution contract의 `timeoutMs`, 기본 30분 | 정확한 Turn interrupt 후 terminal 확인 |
| cancellation 수렴 | 60초 | 결과를 확정할 수 없으면 `recovery_attention` |

watchdog은 Run의 `planning` 같은 상위 상태만 보지 않고 active Dispatch의 heartbeat와 deadline을 검사한다. deadline을 넘긴 Dispatch가 존재하는 한 상위 상태를 무기한 유지할 수 없다.

## 필수 저장 필드

각 Dispatch는 최소 다음을 저장한다.

| 영역 | 필드 |
|---|---|
| identity | `id`, `subjectType`, `subjectId`, `purpose`, `revision` |
| input | `promptFingerprint`, `executionContractFingerprint`, `contextSnapshotId` |
| thread | `threadId`, `threadAction`, `threadSource`, `agentId` |
| turn | `submissionKey`, `turnId`, `turnStatus`, `startedAt`, `terminalAt` |
| ownership | `ownerInstanceId`, `ownerToken`, `heartbeatAt`, `leaseExpiresAt` |
| cancellation | `cancellationGeneration`, `cancelRequestedAt` |
| recovery | `lastProbeAt`, `probeCount`, `reconciliationDecision`, `failure` |
| evidence | terminal output reference, error, completion method, raw status digest |

prompt 원문 전체를 중복 저장할 필요는 없지만, 재전송 동일성을 판별할 canonical fingerprint와 원문의 권위 있는 참조는 반드시 존재해야 한다.

## 제출 규칙

1. `turn_submitting`을 먼저 commit한 뒤 `turn/start`를 호출한다.
2. `turn/start` 성공 응답의 `turnId`를 받은 즉시 같은 owner token으로 `turn_running`을 commit한다.
3. 응답을 받기 전에 연결이 끊어지면 제출 성공 여부가 불확실하다. 동일 명령을 다시 보내지 않고 해당 `threadId`를 읽어 submission key, prompt provenance 또는 시작 시각 이후 Turn을 대조한다.
4. App Server가 caller idempotency key를 지원하면 `submissionKey`를 전달한다. 지원하지 않으면 Control Plane이 `thread/read` reconciliation으로 중복 제출을 막는다.
5. `turn/start` 자체가 명확히 거부됐고 Turn이 생성되지 않았음이 확인된 경우에만 같은 Dispatch에서 제한적으로 재호출할 수 있다.

## 완료와 상태 투영

- `turn/completed`, `turn/failed`, `turn/interrupted` notification을 받으면 해당 `threadId + turnId`가 Dispatch와 일치하는지 확인한다.
- notification을 놓쳤거나 연결이 재구성되면 `thread/read(includeTurns=true)`로 terminal 상태를 회수한다.
- notification과 read 결과가 충돌하면 terminal evidence를 덮어쓰지 않고 `recovery_attention`으로 보낸다.
- Agent의 `idle/running` projection은 Dispatch에서 파생한다. Planner처럼 실제 Turn이 있는데 Agent가 `idle`로 남아서는 안 된다.
- Plan/Run/Task는 Dispatch terminal 결과가 저장된 뒤에만 다음 상태로 전이한다.

## 취소와 fencing

취소는 메모리 Promise 취소가 아니라 부모와 Dispatch에 기록되는 durable intent다.

1. Run/Task 취소 시 `cancellationGeneration`을 증가시키고 active Dispatch를 `cancelling`으로 바꾼다.
2. thread 확보 전후와 `turn/start` 직전에 부모 status, cancellation generation, owner token을 다시 검사한다.
3. `turnId`가 있으면 정확한 Turn만 interrupt한다.
4. `turnId`가 없고 제출 여부가 불확실하면 reconcile한 뒤 `cancelled` 또는 `recovery_attention`으로 확정한다.
5. 취소 후 늦게 도착한 thread/turn 응답은 generation 또는 owner token이 달라 상태를 전진시키지 못한다.

따라서 `Run cancelled` 이벤트 이후 새 Planner/Worker Turn이 만들어지는 것은 계약 위반이다.

## 재시작 복구 판정표

| 저장 상태 | 관찰 결과 | 결정 |
|---|---|---|
| `prepared` | 외부 호출 근거 없음 | 같은 Dispatch를 계속 진행 |
| `thread_acquiring` | `threadId` 없음 | 부모와 owner를 다시 확인한 뒤 획득 재개 |
| `thread_created` | Turn 없음 | 부모와 취소를 확인한 뒤 제출 진행 |
| `turn_submitting` | 대응 Turn 발견 | `turnId`를 결합하고 running/terminal로 복구 |
| `turn_submitting` | Turn 없음이 확정 | 동일 submission을 한 번 진행 |
| `turn_submitting` | 제출 여부 불확실 | `recovery_attention`; 무조건 재전송 금지 |
| `turn_running` | active | 새 owner로 관찰 재개; 재전송 금지 |
| `turn_running` | terminal | 결과를 회수해 terminalize |
| `turn_running` | thread/Turn 불명 | side-effect-free이면 정책에 따른 제한 retry, 그 외 attention |
| `cancelling` | active Turn | interrupt 후 재확인 |
| `cancelling` | terminal/없음 확정 | `cancelled` 또는 이미 확정된 terminal 결과 보존 |

## Planner와 Task의 적용 차이

Planner도 Data Plane과 같은 Dispatch 계약을 사용한다. 다만 부모와 failure projection이 다르다.

- Planner Dispatch: `subjectType=plan`, `purpose=planning`; 실패 시 Plan과 Run을 구조화된 planning failure로 종료한다.
- Orchestrator Dispatch: `subjectType=run`, `purpose=orchestration`; scheduling authority를 부여하지 않는다.
- Worker Dispatch: `subjectType=task`, `purpose=execution`; Task claim token과 결합한다.
- Validator Dispatch: `subjectType=task`, `purpose=validation`; 구현 권한 없이 validation revision과 결합한다.
- Synthesizer Dispatch: `subjectType=run`, `purpose=synthesis`; terminal Task projection만 입력으로 받는다.

별도 구현으로 분기하지 않고 같은 dispatcher와 상태 머신을 사용해야 한다.

## 실패 분류

| 실패 | category | 자동 재제출 |
|---|---|---:|
| thread writer ownership 충돌 | coordination | owner와 안전성 확인 시 제한 허용 |
| thread/start 명시적 거부 | environment/configuration | transient만 허용 |
| turn/start 명시적 거부, Turn 없음 확인 | coordination/configuration | 분류에 따라 제한 허용 |
| 제출 성공 여부 불명 | coordination | 아니오; 먼저 reconcile |
| terminal notification 유실 | observation | 아니오; thread/read로 회수 |
| daemon 재시작 | lifecycle | 아니오; 저장 Dispatch 재개 |
| 부모 취소 또는 token 상실 | cancellation/fencing | 아니오 |

## 구현 완료 조건

1. Planner, Orchestrator, Worker, Validator, Synthesizer가 같은 durable dispatcher를 사용한다.
2. thread 생성 뒤 command 전송 전 crash, `turn/start` 응답 전 crash, notification 전후 crash를 모두 복구한다.
3. 전송된 Turn을 재시작 후 중복 제출하지 않는다.
4. 취소 이벤트 뒤 새 thread/Turn이 생성되지 않는다.
5. Planner의 `threadId`, `turnId`가 성공 전에도 Registry에 남는다.
6. Agent 상태가 실제 active Dispatch와 일치한다.
7. 각 비terminal 단계에 deadline과 watchdog이 있으며 무기한 `planning`/`running`이 없다.
8. 모든 terminal Dispatch가 `nextAction`, failure category와 reconciliation evidence를 가진다.

구현 정본은 `src/turn-dispatcher.js`, `src/domain-states.js`와 Registry schema v8의 `turn_dispatches`다. Planner, Task worker, Validator, Synthesizer와 Orchestrator finalization은 공통 dispatcher를 사용하며 작업 탐색기의 고급 진단은 선택한 Run의 Dispatch projection을 표시한다.
