# 결과 전달 계약

채팅이 기본 제품 표면이다. dashboard는 관찰 도구이며 Run 시작과 결과 수신에 필요하지 않다. terminal 결과는 원래 요청이 들어온 Control Plane 스레드로 돌아가며, active-writer 충돌이 있으면 durable inbox가 손실을 막는다.

## Origin identity

Control request는 가능한 경우 다음을 저장한다.

- `originThreadId`: 결과를 받을 Control Plane 스레드
- `originTurnId`: 요청을 만든 turn의 provenance
- `runId`: 결과의 durable 실행 단위
- delivery policy: `origin_thread_then_inbox` 또는 `durable_inbox`

호스트 identity는 MCP `_meta["codex/origin"]`에 담기며 tool argument의 caller 입력과 분리한다. 둘이 충돌하면 host identity가 정본이고 caller 값은 audit provenance로만 보존한다. 호스트가 identity를 전달하지 않으면 project에 등록된 Control Plane owner를 사용한다. 둘 다 없으면 Run 결과는 Registry와 dashboard에 남지만 자동 thread append는 만들 수 없다.

## Terminal projection

Run이 `completed`, `failed`, `cancelled`가 되면 daemon은 다음 순서로 finalize한다.

1. 모든 Task 결과, validation, artifact, failure를 `run_results`에 projection한다.
2. Plan이 있으면 Synthesizer를 실행한다.
3. Orchestrator thread가 있으면 terminal report를 남기게 한다.
4. 사용자 payload와 canonical notification을 만든다.
5. origin이 있으면 durable delivery row를 upsert한다.
6. direct origin-thread append를 시도한다.

Synthesizer나 Orchestrator finalization 실패는 Task 실행 결과를 지우지 않는다. projection의 raw task results가 fallback이다. 제안된 후속 작업은 자동 시작하지 않는다.

## Delivery state

```text
pending -> direct_delivered
       \-> retry_waiting -> direct_delivered
                         \-> pending_attention -> delivered
       \---------------------------------------> delivered
```

| 상태 | 의미 |
|---|---|
| `pending` | 처음 생성되어 direct delivery 가능 |
| `delivering` | 이전/호환 worker가 남길 수 있는 in-flight 상태. 재시작 시 `retry_waiting`으로 복구 |
| `retry_waiting` | writer 충돌 또는 일시 오류로 `not_before`까지 대기 |
| `pending_attention` | 최대 시도 횟수 소진. durable drain으로 회수 가능 |
| `direct_delivered` | origin thread append 성공. direct delivery의 terminal 결과 |
| `delivered` | drain에서 payload 반환 후 acknowledgement 완료 |

- 기본 최대 시도 횟수는 20회다.
- delay는 30초에서 시작해 최대 5분까지 제한된 지수 backoff를 사용한다.
- daemon 재시작 시 남은 `delivering`은 `retry_waiting`으로 되돌린다.
- delivery key는 기본 `${runId}:${originThreadId}`이며 unique다.
- direct-delivered 또는 acknowledged row는 다시 사용자에게 반환하지 않는다.

## Direct delivery

daemon은 origin thread를 read-only/`approvalPolicy=never`로 resume하고 `[BACKGROUND CONTROL PLANE RESULT]` 또는 attention payload를 append한다.

- 이 turn은 결과 표현만 담당한다.
- 새 작업, retry, workspace mutation을 시작하지 않는다.
- active writer를 빼앗지 않는다.
- 실패하면 별도 summary thread를 만들지 않고 durable row를 defer한다.

## Drain fallback

`drain_control_results`는 현재 Control Plane identity와 project cwd에 해당하는 미전달 결과를 반환하고 acknowledgement한다. Control Plane turn 시작 시 한 번 호출하는 durable fallback이다.

- 이미 delivered인 결과는 중복 반환하지 않는다.
- 다른 Control Plane origin의 결과를 반환하지 않는다.
- drain이 최종 결과의 내용을 재합성하지 않고 저장된 payload를 전달한다.
- direct append는 `deliveryMethod=direct_origin_append`와 `directDeliveredAt`을 기록한다.
- drain acknowledgement는 `deliveryMethod=drain_acknowledgement`와 `acknowledgedAt/acknowledgedTurnId`를 기록한다. 두 보장을 하나의 성공 신호로 혼용하지 않는다.

## Notification contract

사용자-visible notification은 정확히 네 종류다.

| kind | 의미 |
|---|---|
| `completed` | Run 성공, warning 포함 가능 |
| `failed` | 제품·검증·환경 실패 |
| `attention_required` | 계약 수리, integration/recovery 판단, 전달 확인 필요 |
| `policy_blocked` | 권한 또는 정책 경계에서 중단 |

queued/running/validating/retrying 같은 정상 진행은 notification을 만들지 않는다. `dedupe_key`와 audience receipt로 중복 표시를 방지한다.

## Payload boundary

origin thread payload는 사용자 응답에 필요한 compact 결과만 담는다.

- Run verdict와 summary
- Task별 id/title/status와 잘린 output/error
- validation, artifacts, unresolved risks
- notification kind/id

전체 prompt, command transcript, raw events는 Data Plane thread와 dashboard detail에서 조회한다.

## Completion semantics

- **Run terminal:** 모든 Task 상태를 바탕으로 parent Run이 terminal이 된 시점
- **Result finalized:** run result projection과 delivery queue 생성이 끝난 시점
- **Result delivered:** origin thread append가 `direct_delivered`로 기록되거나 drain acknowledgement가 `delivered`로 기록된 시점

세 시점은 같지 않다. 사용자 결과를 잃지 않기 위해 Run terminal 여부와 delivery 성공 여부를 분리한다.
