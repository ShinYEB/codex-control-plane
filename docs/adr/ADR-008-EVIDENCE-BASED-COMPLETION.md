# ADR-008: 성공은 Agent 문구가 아니라 실행 증거로 판정한다

- 상태: 채택 및 핵심 구현 완료
- 결정 대상: daemon scheduler, Completion Evaluator, Validator, WorktreeManager, Run Result projection

## 맥락

Codex Turn이 `completed`인 것과 사용자가 요청한 작업이 실제로 성공한 것은 다르다. Agent가 성공을 보고해도 명령이 실패했거나 파일이 바뀌지 않았거나 artifact가 main workspace에 적용되지 않았을 수 있다. 반대로 재시작 시 이미 성공한 Turn의 evidence를 잃으면 불필요한 실패나 `recovery_attention`이 생긴다.

실시간 notification, Agent 자연어, Validator 판단과 실제 workspace 상태 중 어느 하나만으로 성공을 판정하면 정상 실행과 복구 경로가 서로 다른 결과를 만들 수 있다.

## 결정

Task 성공 여부는 daemon의 단일 Completion Evaluator가 구조화된 evidence로 결정한다. Agent와 Master Orchestrator의 자연어 응답은 설명과 탐색을 위한 결과이며 terminal status 권한을 갖지 않는다.

Evidence 우선순위는 다음과 같다.

1. App Server의 terminal Turn 상태와 error
2. 전체 Turn의 명령·테스트 item과 종료 코드
3. 선언된 output의 실제 materialization
4. workspace diff와 artifact
5. acceptance validation
6. integration journal과 최종 workspace postcondition
7. Agent 또는 Orchestrator의 자연어 설명

낮은 단계는 높은 단계의 실패를 성공으로 덮어쓸 수 없다. evidence가 누락되거나 서로 모순되면 성공으로 추정하지 않고 `rework`, `failed`, `integration_blocked` 또는 `recovery_attention` 중 원인에 맞는 결과를 선택한다.

## 완료 판정

```text
Task completed =
  terminal Turn completed
  AND complete Turn evidence hydrated
  AND no failed required command
  AND required verification commands executed
  AND declared outputs materialized
  AND workspace mutation matches the contract
  AND acceptance criteria satisfied
  AND required integration recorded
  AND required postconditions passed in the destination workspace
```

`implementation`, `integration`, `release` Task는 명시적 acceptance criteria 또는 계약에서 생성된 output·mutation 완료 조건을 가져야 한다. `mutatesWorkspace=true`이고 `outputs`가 workspace 변경을 요구하면 변경 없는 artifact는 성공이 아니다. 분석·검토처럼 결과가 report인 Task도 비어 있지 않은 결과 evidence를 가져야 한다.

## 정상 실행과 복구

- terminal notification을 받았더라도 완료 직전에 `thread/read`로 전체 Turn을 다시 읽는다.
- 실시간 item과 읽어온 item은 stable item identity로 병합한다.
- 정상 완료, timeout probe와 daemon restart reconciliation은 같은 Completion Evaluator를 호출한다.
- Validator가 완료된 뒤 재시작했더라도 필요한 integration과 postcondition을 생략하지 않는다.
- `integration_pending` journal recovery 뒤에도 destination postcondition을 평가한다.
- 이미 확정한 evidence receipt는 content fingerprint가 같을 때 재사용하고 같은 명령이나 side effect를 다시 실행하지 않는다.

## Run과 synthesis

Run status는 중앙 Task 집계가 결정한다. Master Orchestrator와 Synthesizer는 이 상태를 설명하지만 바꿀 수 없다. 자연어 summary가 terminal status, 실패 Task, 취소, 미통합 artifact와 모순되면 summary를 정본으로 저장하지 않고 deterministic fallback projection과 consistency warning을 사용한다.

## 구현된 실패 테스트

1. Agent가 성공을 말해도 명령 exit code가 0이 아니면 실패한다.
2. 실시간 command item을 놓쳐도 final `thread/read`에서 실패를 발견한다.
3. 구현 Task가 변경 없이 끝나면 output materialization failure가 된다.
4. 필수 verification command를 실행하지 않으면 성공하지 않는다.
5. Validator 승인 직후 daemon을 종료해도 artifact 통합을 건너뛰지 않는다.
6. integration 이후 destination workspace의 postcondition 실패를 검출한다.
7. 정상 실행과 restart reconciliation이 같은 evidence에 같은 verdict를 낸다.
8. 실패한 Run을 Master가 성공이라고 요약하면 구조화된 Run status가 유지되고 consistency warning이 생긴다.

## 결과

- 성공과 실패가 Agent의 표현 방식에 좌우되지 않는다.
- notification 유실과 daemon 재시작이 판정을 바꾸지 않는다.
- “검증 성공, 실제 변경 없음”과 “통합 성공, 최종 상태 실패”를 구분할 수 있다.
- 모든 retry와 repair가 구체적인 누락 evidence를 대상으로 한다.
