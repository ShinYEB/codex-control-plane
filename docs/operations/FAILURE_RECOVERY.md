# 실패와 복구 계약

복구의 우선순위는 사용자 데이터 보존, 중복 side effect 방지, 원인 분류, 제한된 자동화 순서다. 단순히 재시도 횟수를 늘려 configuration이나 policy 오류를 반복하지 않는다.

## Failure model

Failure record는 최소 다음을 포함한다.

- `type`: 구체적 진단 유형
- `category`: 상위 정책 범주
- `stage`: planning, dispatch, execution, validation, integration, delivery 등
- `cause`/`message`와 optional error `code`
- `retryable`, `nextAction`
- attempt budget와 exhaustion
- execution contract fingerprint
- retry에서 바뀐 sandbox/thread/workspace/prompt 정보

### Canonical categories

| category | 대표 type | 기본 처리 |
|---|---|---|
| `configuration` | `configuration`, `workspace`, `routing` | 같은 계약으로 자동 반복하지 않음; 계약 수정 또는 환경 정리 |
| `policy` | `approval`, policy rejection | `blocked_by_policy`; 별도 사용자 권한 없이는 중단 |
| `environment` | `environment`, `infrastructure` | infrastructure만 일시 오류로 재시도 가능 |
| `coordination` | `coordination`, `timeout`, `interrupted` | 안전성과 attempt budget을 확인해 제한 재시도 |
| `validation` | `validation` | 새 validator feedback을 prompt에 추가한 rework만 허용 |
| `product` | `test`, `command`, `worker` | 원인 수정이 필요한 rework; 무조건 같은 입력 반복 금지 |

분류는 error code, message, 실행 stage와 command result를 함께 사용한다. 분류는 진단 보조이며 권한을 바꾸지 않는다.

## Retry policy

자동 retry가 허용되는 조건은 다음과 같다.

1. attempt가 `maxAttempts`보다 작다.
2. failure가 transient infrastructure/coordination/timeout이거나 새 validator feedback이 있는 rework다.
3. side effect와 현재 결과 불확실성을 고려해 replay가 안전하다.
4. configuration/policy failure를 같은 fingerprint로 반복하지 않는다.
5. 같은 validator feedback hash를 중복 적용하지 않는다.

`retry_waiting`의 시간은 기본 delay에 attempt별 지수 증가를 적용한다. 모든 retry 기록은 `retrySafety.allowed/reason/mode`로 왜 안전한지 남긴다. 같은 계약이 허용되는 것은 transient failure뿐이며 validator rework는 중복되지 않은 `feedbackRevision`을 증가시킨다.

## Validation failure

- acceptance criteria가 없으면 successful Data Plane result가 바로 완료될 수 있다.
- criteria가 있으면 Data Plane output 후 별도 read-only Validator를 실행한다.
- `accept`는 `completed`, `accept_with_warnings`는 `completed_with_warnings`다.
- unmet criteria가 있으면 feedback을 추가해 attempt budget 내 rework한다.
- Validator runtime/output 자체가 잘못되면 `validation_failed` 또는 environment failure로 기록한다.

Validator는 구현 권한이 없고 scope를 넓히지 않는다.

## Restart reconciliation

daemon은 active Task heartbeat가 끊기면 저장된 status만 믿지 않고 Codex `thread/read`와 대조한다.

- turn이 terminal이고 결과를 읽을 수 있으면 claim을 현재 결과로 완료/실패/검증한다.
- side-effect-free `read-only + sideEffectPolicy=none` 작업은 결과를 확정할 수 없을 때 재queue할 수 있다.
- 재queue 전에 contract marker, version, schema와 fingerprint를 다시 검증한다. invalid contract는 configuration/policy terminal 상태로 종료한다.
- mutation이나 local-runtime side effect가 있는 불확실 작업은 `recovery_attention`으로 격리한다.
- `integration_pending`에 journal이 있으면 적용 여부를 검사해 전용 recovery를 수행한다. journal이 없는 불확실 통합만 `recovery_attention`으로 격리한다.
- read probe가 반복 실패하면 자동 재실행 대신 attention으로 전환한다.
- stale worker가 늦게 완료해도 claim token이 달라 반영되지 않는다.
- restart recovery update는 관찰한 status, version, worker, claim token이 모두 그대로일 때만 적용한다.

daemon 종료는 active work drain을 우선한다. 제한 시간을 넘긴 turn은 interrupt하고 위 규칙으로 claim을 복구한다.

명시적 취소는 Task의 worker, claim token, heartbeat, retry time을 제거하고 해당 Task가 소유한 worktree/Agent lease를 release한다. 연결된 Agent는 active ownership이 사라진 뒤 idle로 복귀한다.

## Dependency failure

- `all_success` downstream은 failed dependency가 생기면 `skipped`된다.
- `all_terminal` downstream은 선행 결과의 성공 여부와 관계없이 모두 끝난 뒤 실행된다.
- `on_failure` downstream은 하나 이상의 선행 실패가 있어야 실행된다.
- terminal cascade가 끝나면 parent Run을 다시 계산한다.

복구용 downstream Task도 최초 Run graph와 실행 계약 안에 있어야 한다. 실패 후 임의 Task를 자동 추가하지 않는다.

## Worktree recovery

managed worktree의 복구 동작은 다음과 같다.

| action | 동작 |
|---|---|
| `inspect` | worktree 존재와 변경 상태 확인 |
| `finalize` | 변경을 commit + binary patch artifact로 확정 |
| `integrate` | 저장된 artifact를 `patch` 또는 `commit` 전략으로 재통합 |
| `cleanup` | clean/integrated worktree만 안전하게 제거 |
| `quarantine` | 경로와 artifact를 보존하고 자동 처리에서 격리 |

원칙:

- cleanup 전에 status를 읽을 수 없으면 quarantine한다.
- uncommitted change가 있고 integrated가 아니면 retain한다.
- commit integration은 dirty main workspace에서 실행하지 않는다.
- cherry-pick failure는 abort하고 artifact를 유지한다.
- `integration_blocked` artifact는 자동 삭제하지 않는다.

통합은 SQLite journal의 `prepared → applying → applied → recorded` 순서를 따른다. 재시작 시 `applying`은 reverse patch check로 실제 적용 여부를 판별하고, 이미 적용된 artifact는 다시 적용하지 않는다. `applied`는 worktree/Task 기록만 복구하고 `recorded`인 journal은 멱등하게 종료한다.

## Contract repair

configuration failure의 권장 복구는 동일 계약 retry가 아니라 명시적 contract repair다.

1. terminal Task와 이전 contract fingerprint를 선택한다.
2. 허용된 필드만 변경한다.
3. 이전 contract와 failure를 history에 보존한다.
4. `contractRevision`을 증가시키고 반드시 새 fingerprint를 만든다. fingerprint가 같으면 repair를 거부한다.
5. 새 revision으로 해당 Task만 queue한다.
6. dependency와 Run 상태를 다시 계산한다.

외부·파괴적 side effect는 repair 대상이 아니다.

## Operator decision points

다음 상태는 자동 복구보다 사람의 판단을 요구한다.

- `recovery_attention`: 기존 side effect가 실제 발생했는지 불확실
- `integration_blocked`: artifact를 어느 기준선에 어떻게 적용할지 필요
- `blocked_by_policy`: 별도 권한과 실행 범위가 필요
- 반복 delivery failure: origin thread 상태 또는 host 문제 확인 필요
- runtime generation mismatch: 새 대화 또는 승인된 배포 handover 필요

이때 시스템은 `attention_required` 또는 `policy_blocked` notification을 만들고 작업을 임의로 계속하지 않는다.
