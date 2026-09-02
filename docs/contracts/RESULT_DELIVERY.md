# 결과 접근 계약

결과는 원래 요청 스레드로 자동 반환하지 않는다. 작업 탐색기가 Run 상태, 실행 구조와 실제 Codex 스레드로 들어가는 durable 진입점이다.

## 상태와 결과의 정본

Run이 `completed`, `failed`, `cancelled`가 되면 daemon은 다음을 수행한다.

1. 모든 Task 결과, validation, artifact와 failure를 `run_results`에 projection한다.
2. Plan이 있으면 Synthesizer를 실행한다.
3. Orchestrator 스레드가 있으면 그 스레드에 terminal orchestration report를 기록한다.
4. 작업 탐색기에 표시할 canonical notification을 만든다.
5. Run에 `resultAccess=dashboard_thread_navigation`을 기록한다.

이 과정은 origin 스레드를 resume하거나 결과 turn을 append하지 않는다. Synthesizer 또는 Orchestrator finalization 실패도 Task별 결과를 지우지 않는다.

## 작업 탐색기

작업 탐색기는 다음 계층을 제공한다.

```text
Master Worker 목록
  -> 단순 Master Worker -> 실제 Codex thread
  -> Master Orchestrator -> 실제 Codex thread + Slave Task DAG
       -> Slave Worker node -> 실제 Codex thread
```

- Master 목록은 진행 중, 대기, 완료, 실패 상태를 함께 보여준다.
- 단순 Run은 작업을 직접 수행한 Master Worker가 곧 탐색 대상이다.
- 복잡한 Run은 Master Orchestrator와 Slave dependency graph를 기본으로 펼친다.
- Planner, Validator, Synthesizer `TurnDispatch`는 고급 진단 evidence이며 Master와 동급인 사용자 작업으로 표시하지 않는다.
- 실제 Codex 스레드를 선택하면 `open_desktop_thread`로 기존 스레드를 연다. Daemon Scheduler는 프로세스 identity이므로 열 수 있는 채팅으로 표시하지 않는다.
- 스레드 열기는 prompt 전송, retry, claim 또는 상태 전이를 만들지 않는다.
- active 스레드를 여는 것은 관찰 경로다. 해당 작업의 명령 제출과 취소는 계속 daemon owner token과 lease가 관리한다.
- 별도 웹 대시보드에서는 직접 이동할 수 없으므로 thread ID를 복사하는 fallback을 제공한다.

## Notification 계약

사용자-visible notification은 작업 탐색기에만 표시한다.

| kind | 의미 |
|---|---|
| `completed` | Run 성공, warning 포함 가능 |
| `failed` | 제품·검증·환경 실패 |
| `attention_required` | 계약 수리, integration 또는 recovery 판단 필요 |
| `policy_blocked` | 권한 또는 정책 경계에서 중단 |

정상적인 queued/running/validating/retrying 상태는 notification을 만들지 않는다. Notification을 표시하는 행위가 읽음 처리나 origin-thread 쓰기를 암묵적으로 수행해서는 안 된다.

## Completion 의미

- **Run terminal:** 모든 Task 상태로부터 parent Run이 terminal이 된 시점
- **Result finalized:** durable Result projection과 notification 생성이 끝난 시점
- **Result inspected:** 사용자가 작업 탐색기에서 Run, 결과 또는 담당 스레드를 연 시점

세 시점은 서로 다르다. 사용자가 결과를 열지 않았더라도 Run과 결과는 손실 없이 Registry에 남는다.

Master Orchestrator가 작성한 최종 자연어 응답은 실제 Master 스레드에서 볼 수 있다. 다만 그 문구는 durable Result projection을 설명하는 표현 계층이며 Run의 구조화된 status, failure, artifact 또는 미충족 범위를 변경할 수 없다. 문구와 projection이 모순되면 projection이 정본이고 synthesis consistency failure를 기록한다.

## Legacy 데이터

이전 버전의 `control_result_deliveries` 테이블과 row는 migration 및 감사 호환을 위해 유지할 수 있다. 새 Run은 delivery row를 만들지 않으며 daemon은 해당 row를 origin 스레드에 자동 전달하지 않는다.
