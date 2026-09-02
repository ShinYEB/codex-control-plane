# 제품 계약 권위와 충돌 게이트

제품 계약은 문서 설명이 아니라 planning과 claim을 통제하는 실행 입력이다. 저장소는 `control-plane.contracts.json`에 현재 구현이 따르는 계약을 기계 판독 가능한 claim으로 선언한다. Context Resolver는 이 manifest와 사용자 결정, 검증된 artifact, task 결과를 같은 subject 기준으로 비교한다.

## 권위 순서

1. `user_explicit`
2. `project_contract`
3. `validated_artifact`
4. `validated_task_result`
5. `observed_thread`
6. `model_inference`
7. `legacy_unverified`

높은 권위는 낮은 권위의 상충 동작을 자동으로 허용하지 않는다. 권한·계약·workspace subject에 서로 다른 active claim이 있으면 낮은 권위 claim도 명시적으로 supersede되기 전까지 planning을 차단한다. 이렇게 해야 구현이 사용자 결정을 무시한 채 실행되는 것을 막을 수 있다.

## 정본 흐름

```text
user decision / repository manifest / validated evidence
  -> provenance-backed ContextClaim
  -> normalize project + scope + subject
  -> detect active conflicts
  -> immutable ContextSnapshot
  -> compile Execution Contract v2
  -> capability and policy preflight
  -> atomic graph persistence
  -> claim
```

차단 conflict는 `unresolved_context_conflict`로 종료한다. 이 시점에는 Task, Agent, lease, worktree, attempt가 없어야 한다.

## Revision과 supersession

- 계약 변경은 기존 claim의 본문을 덮어쓰지 않고 새 claim ID와 revision을 만든다.
- 새 claim은 대체할 claim ID를 `supersedes`로 명시한다.
- 명시적 사용자 결정을 supersede할 수 있는 것은 다른 `user_explicit` claim뿐이다.
- active claim catalog가 바뀌면 같은 objective라도 Context Snapshot cache를 재사용하지 않는다.
- manifest 본문을 바꾸면서 ID와 revision을 유지하면 ID/content 충돌로 거부한다.

## 확정된 Run 시작 계약

`explicit_run_start`의 최종 계약은 [ADR-005](../adr/ADR-005-AUTOMATIC-RUN-START.md)다.

- 사용자의 실행 요청이 부모 Run의 유일한 시작 승인이다.
- 원자적 graph와 pre-claim 검증이 끝나면 daemon이 자동 실행한다.
- dashboard open과 refresh는 실행을 시작하지 않는다.
- 기존 “별도 명시적 Start 필요” 결정은 새 사용자 결정이 supersede한다.

## 확정된 결과 접근 계약

`result_access`의 최종 계약은 [ADR-006](../adr/ADR-006-WORK-NAVIGATOR-RESULT-ACCESS.md)과 manifest의 `result_access_policy_v3`다.

- 작업 탐색기의 최상위 작업 목록은 사용자 요청마다 하나의 Master Worker를 보여준다.
- 복잡한 Run은 Master Orchestrator 아래 Slave Task DAG를 보여준다.
- 사용자가 Master 또는 Slave를 선택하면 실제 Codex 스레드로 이동한다.
- Planner, Validator, Synthesizer는 고급 진단 evidence이며 Master와 동급인 최상위 작업이 아니다.
- daemon은 terminal 결과를 요청 스레드에 자동 append하지 않는다.

## 확정된 성공 판정 계약

`task_completion_authority`의 최종 계약은 [ADR-008](../adr/ADR-008-EVIDENCE-BASED-COMPLETION.md)과 [Completion Gate](./COMPLETION_GATE.md)다.

- Agent·Orchestrator의 자연어 완료 선언은 terminal 상태 권한이 없다.
- daemon의 Completion Evaluator가 전체 Turn, 명령·테스트, output, workspace, validation, integration과 postcondition evidence를 판정한다.
- 정상 실행과 restart reconciliation은 같은 verdict 함수를 사용한다.
- 누락되거나 상충하는 evidence는 성공으로 추정하지 않는다.

## 변경 체크리스트

제품 계약을 바꿀 때는 한 변경에서 다음을 함께 갱신한다.

- `control-plane.contracts.json`
- 관련 ADR과 계약 문서
- 중앙 compiler와 validator
- Planner/MCP schema
- 상태·retry·recovery projection
- 충돌, fingerprint, pre-claim 회귀 테스트
