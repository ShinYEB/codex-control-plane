# ADR-007: 스레드 확보와 명령 실행을 하나의 durable TurnDispatch로 관리한다

- 상태: 채택 및 schema v8 구현 완료
- 결정 대상: App Server client, Planner, RunController, Task worker, recovery, cancellation

## 맥락

현재 구현은 `thread/start` 또는 `thread/resume`으로 스레드를 확보한 뒤 별도의 `turn/start`로 명령을 보낸다. 명령 자체는 실제 Codex Turn에 도달하지만, daemon이 그 사이 또는 결과 관찰 중 종료되면 Registry는 “아직 보내지 않음”과 “이미 보냈으나 결과를 잃음”을 구분하지 못한다.

실제 장애에서는 Planner 스레드와 명령 Turn이 생성됐고 Turn이 즉시 interrupted됐지만 Plan과 Run은 `planning`에 남았다. 재시작은 기존 Turn을 복구하지 않고 새 Planner를 만들었으며, Run 취소 뒤에도 늦은 Planner 생성과 명령 제출이 진행됐다. 이는 모델의 READY 여부가 아니라 dispatch ownership과 복구 경계의 결함이다.

## 결정

모든 역할의 스레드 실행은 공통 `TurnDispatch` entity와 dispatcher를 사용한다. `threadId` 확보는 중간 체크포인트이고 `turnId`가 owner token과 함께 저장돼야 실행 시작으로 본다.

구체적인 상태, 저장 필드, 제출·취소·복구 판정은 [Durable Turn Dispatch 계약](../contracts/TURN_DISPATCH.md)을 정본으로 사용한다.

## 핵심 선택

1. placeholder `READY` Turn과 `ready` 실행 상태를 사용하지 않는다.
2. 스레드 생성과 Turn 제출 API가 물리적으로 분리돼도 하나의 논리적 Dispatch로 영속화한다.
3. submission intent를 외부 호출 전에 저장한다.
4. 제출 여부가 불확실하면 새 Turn을 보내기 전에 `thread/read`로 reconcile한다.
5. 부모 cancellation generation과 Dispatch owner token을 외부 호출 전후에 검사한다.
6. Planner도 일반 Task와 동일한 durable dispatch·watchdog·recovery 규칙을 적용받는다.

## 결과

- 재시작 후 중복 명령과 side effect를 방지할 수 있다.
- Run, Plan, Task와 실제 Codex Turn 사이의 추적이 가능해진다.
- Agent `idle/running` projection을 실제 Dispatch에서 계산할 수 있다.
- 새로운 Registry entity와 migration, 공통 dispatcher, App Server reconciliation, crash-point E2E가 필요하다.

## 기각한 대안

### READY 응답 후 별도 명령 전송

READY는 스레드 생성만 확인할 뿐 명령 제출이나 결과 관찰을 보장하지 않는다. 외부 호출 사이의 crash와 취소 race를 해결하지 못한다.

### 메모리 Promise와 notification만 사용

daemon 재시작 시 진행 상태와 제출 identity를 잃으며 notification 유실을 복구할 수 없다.

### planning Run을 재시작 시 그대로 다시 실행

기존 Turn의 제출 여부를 모른 채 같은 prompt를 중복 실행할 수 있으므로 허용하지 않는다.

### Planner만 별도 예외 처리

Worker, Validator, Synthesizer도 동일한 App Server 경계를 사용하므로 역할별 보강은 다시 계약을 분산시킨다.
