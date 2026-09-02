# 전체 실행 흐름 계약

- 버전: `execution_flow_v1`
- 상태: 채택, 구현 추적 기준

이 문서는 영역별 계약을 하나의 실행 순서로 연결한다. 각 단계는 다음 단계로 넘어가기 전에 영속 evidence와 실패 판정을 남겨야 한다.

| 단계 | 진입 조건 | 소유자 | 정본 입력 | 외부 동작 | commit evidence | timeout·실패 | 취소·재시작 | 다음 단계 |
|---|---|---|---|---|---|---|---|---|
| 1. 요청 접수 | 사용자 요청과 origin 확인 | daemon | request schema, product claims | 없음 | `Run(accepted)`, request key, origin provenance | invalid request는 configuration terminal | terminal Run 재개 금지; 같은 key는 기존 Run 반환 | context resolution |
| 2. 맥락 확정 | accepted Run | Context Resolver | active claims와 requested threads | 명시된 thread read만 허용 | immutable snapshot ID/fingerprint | conflict·누락은 planning 전 실패 | 같은 revision은 같은 snapshot 사용 | planning |
| 3. 계획 Dispatch | validated snapshot | Planner + TurnDispatcher | objective, snapshot, Plan revision | Planner thread acquire, Turn 1회 제출 | Plan, Planner Dispatch, threadId/turnId | stage deadline; invalid graph는 제한된 새 revision만 허용 | 기존 Turn reconcile 전 재제출 금지; 취소 fence | graph compile |
| 4. 계약 compile | complete Planner graph | contract compiler | graph fields, role template ceiling | 없음 | canonical contract와 fingerprint | configuration/policy terminal; Agent·attempt 없음 | persisted fingerprint 재검증 | preflight |
| 5. workspace preflight | 모든 계약 valid | daemon | workspaceMode, integration strategy | Git/read-only filesystem inspection | preflight result와 baseline evidence | workspace failure terminal; worktree 생성 전 차단 | 동일 evidence가 유효한지 재검증 | graph commit |
| 6. graph commit | 모든 Task 준비 가능 | Registry | Run, Task, dependency, contracts | 없음 | 한 transaction의 staged DAG | 일부 graph 금지, rollback | committed graph만 release 가능 | automatic release |
| 7. dependency release | committed staged DAG | RunController | dependency policy | 없음 | queued/blocked/skipped 상태 | illegal transition 거부 | 상태에서 결정론적으로 재계산 | claim |
| 8. Task claim | runnable + validated contract | scheduler | Task version/fingerprint, parent auth | 없음 | workerId, claimToken, attempt | 계약 오류는 attempt 전 차단 | stale token 결과 거부 | workspace/Agent lease |
| 9. 실행 Dispatch | claim과 lease 유효 | TurnDispatcher | prompt, execution contract, context pack | thread acquire, `turn/start` 1회 | Task Dispatch, threadId/turnId, Agent running projection | execution deadline; interrupted/failed 분류 | 제출 불명 시 reconcile; cancellation generation fence | evidence hydration |
| 10. evidence hydration | terminal 후보 Turn | Completion Evaluator | live items + `thread/read` Turn | final read 1회 | merged item set, evidence fingerprint | 누락·모순은 성공 보류 | 정상·timeout·restart가 같은 merge 규칙 사용 | output/validation |
| 11. output·검증 | complete Turn evidence | Completion Evaluator + Validator | contract outputs, workspace baseline, criteria | 필요 시 read-only Validator Turn | output mapping, diff/artifact, validation revision | 필수 evidence 누락은 reject/rework | 새 feedback revision만 rework 허용 | integration 또는 terminal gate |
| 12. 통합·postcondition | accepted artifact | Worktree manager + Completion Evaluator | durable artifact와 journal | patch/cherry-pick, destination verification | prepared→applying→applied→recorded journal, postcondition receipt | conflict는 `integration_blocked`; 최종 조건 실패는 product failure | 적용 여부 판별 후 재개; 중복 적용 금지 | completion gate |
| 13. Completion Gate | 같은 contract revision의 evidence 완비 | Completion Evaluator + Registry | Turn, command, output, validation, integration evidence | 없음 | versioned CompletionVerdict | Agent 자연어로 실패를 덮어쓸 수 없음 | 정상·restart가 같은 verdict 함수 사용 | Task/Run terminal projection |
| 14. Run 종결 | 모든 Task terminal | Registry | Task terminal projection | optional synthesis Turn | Run result, notification, terminal status | 부분 취소·실패를 성공으로 집계 금지 | terminal 역전이 금지 | work navigator |
| 15. 결과 접근 | durable result 존재 | work navigator | Registry projection과 thread identity | 선택한 Codex thread navigation | receipt/조회 evidence | navigation 실패는 실행 결과를 변경하지 않음 | origin 자동 append 없음 | 사용자 검토 |

## 전 구간 공통 gate

모든 외부 동작 직전에 다음 조건을 같은 durable revision 기준으로 확인한다.

1. 부모 Global Run/Run/Task가 non-terminal이다.
2. cancellation generation이 Dispatch가 준비될 때의 값과 같다.
3. 현재 daemon/worker가 owner token을 보유한다.
4. context와 execution contract fingerprint가 변조되지 않았다.
5. deadline이 지나지 않았다.
6. 같은 submission 또는 side effect가 이미 실행되지 않았다.

하나라도 확인할 수 없으면 외부 동작을 시작하지 않는다. 결과가 불확실하면 자동 반복보다 reconciliation 또는 attention을 선택한다.

## 구현 상태와 후속 우선순위

- **완료(P0)**: 계획·실행 TurnDispatch 영속화, cancellation fencing, restart reconciliation.
- **완료(P1)**: Validator·Synthesizer·Orchestrator 공통 dispatcher 전환과 dashboard Dispatch projection.
- **완료(P0)**: Completion Gate 실패 테스트, terminal Turn 전체 hydration, output/mutation materialization, 정상·복구 공통 verdict, Validator 이후 integration continuation.
- **완료(P1)**: destination artifact postcondition, Master/Synthesizer consistency와 fingerprinted evidence verdict.
- **후속(P2)**: deadline watchdog의 주기적 강제 수렴, App Server native idempotency key 지원 시 submission key 전달, 운영 telemetry 보강.

Global Run 취소는 먼저 Global cancellation intent를 영속화한 뒤 각 Project Run의 `RunController.cancel()`을 통해 정확한 active Turn을 interrupt한다. 모든 자식 취소가 끝난 뒤 Global Run을 terminalize하며, 재시작 복구에서는 이미 기록된 cancellation intent를 기준으로 같은 절차를 결정론적으로 수렴한다.

각 단계의 상세 규칙은 `CONTEXT_RESOLUTION`, `EXECUTION_CONTRACT`, `STATE_MACHINES`, `TURN_DISPATCH`, `COMPLETION_GATE`, `PERSISTENCE`, `FAILURE_RECOVERY`, `RESULT_DELIVERY` 계약을 따른다. 충돌 시 더 좁고 version이 명시된 계약을 우선하고 계약 충돌 자체를 실행 전에 차단한다.
