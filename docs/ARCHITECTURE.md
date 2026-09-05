# RUVORA 아키텍처

이 문서는 전체 구조와 책임 경계의 정본이다. 제품이 해결하는 문제와 목표 방향은 [제품 목적과 설계 방향](./PRODUCT_DIRECTION.md), 세부 상태, 권한, 저장, 전달, 복구 규칙은 [설계 문서 인덱스](./README.md)에서 연결된 계약 문서를 따른다.

## 범위

이 시스템은 Codex App Server 스레드와 여러 프로젝트의 지식·실행 상태를 관리하는 로컬 Control Plane이다. 현재 구현은 영구 스레드를 재사용 가능한 작업 주체로 다루며, 하나의 데몬이 영속 Registry, 스케줄링과 App Server writer를 소유하고 각 Codex 대화에서 시작되는 MCP 프로세스는 얇은 프록시로 동작한다. 작업 탐색기는 Run 상태와 실행 구조를 보여주고 실제 작업 스레드로 이동시키는 사용자 표면이다.

현재 설계가 책임지는 범위는 다음과 같다.

- 사용자 요청 한 건을 durable Run으로 접수하고 Task DAG로 준비한다.
- Task별 권한과 작업공간을 실행 계약으로 확정한 뒤 worker를 시작한다.
- Agent/Task/Run/Lease 상태를 영속화하고 재시작 후 복구한다.
- Data Plane 결과를 검증·통합·종합하여 작업 탐색기의 durable result projection과 담당 Codex 스레드에서 확인할 수 있게 한다.
- 프로젝트 내부 파일 변경은 관리하지만 원격 서비스 변경과 파괴적 작업은 자동 실행하지 않는다.

## 설계 철학

Control Plane은 다음 사용자 요청을 받을 수 있는 상태를 유지한다. 의도, 영속 context, 계획, 정책, 관찰을 소유하지만 긴 구현 turn을 직접 수행하지 않는다. 의미 있는 작업 단위는 durable Codex 스레드에 위임하여 전체 대화, 명령, 결과를 나중에도 읽을 수 있게 한다. 용어는 [TERMINOLOGY.md](./TERMINOLOGY.md)를 따른다. 스레드는 영구 대화이고 세션은 스레드에 일시적으로 붙는 runtime이다.

계획은 데이터이지 권한이 아니다. worker 스레드를 만들기 전에 repository product contract와 사용자 결정을 같은 subject로 해소하고, deterministic compiler가 Planner Task를 명시적 실행 계약으로 변환한다. 역할 이름은 전문성을 설명할 뿐 filesystem, network, side effect 권한을 부여하지 않는다.

## Plane별 책임

### Control Plane

- 사용자 목표를 접수하고 즉시 Run으로 영속화한다.
- 프로젝트 memory와 authoritative plan을 유지한다.
- direct dispatch와 Orchestrator Plane 경로를 선택한다.
- 실행 계약을 compile하고 preflight한다.
- 단일 embedded dashboard를 제공하되 다음 요청을 받을 수 있게 유지한다.
- 작업 탐색기를 상태·결과의 기본 제품 표면으로 삼고 origin Control Plane 스레드에는 terminal 결과를 자동 append하지 않는다.
- 사용자 요청마다 하나의 Master Worker identity를 만들고 작업 탐색기의 최상위 목록은 Master를 중심으로 구성한다.

### Orchestrator Plane

- 복합 Run 하나의 조정 context와 최종 synthesis를 소유한다.
- 배정, retry, failure, artifact, integration 결정을 기록한다.
- dependency Task 사이에 구조화된 A2A handoff를 전달한다.
- 두 번째 scheduler나 workspace writer가 되지 않는다. claim, lease, fencing, 상태 전이는 daemon 소유다.
- Slave 결과를 직접 수신하는 임시 메시지함이 아니라 Registry의 검증된 결과 묶음을 decision barrier에서 읽고 최종 결과를 자신의 Codex 스레드에 기록한다.

### Data Plane

- durable Codex 스레드에서 배정된 전문 Task 하나를 수행한다.
- 배정된 sandbox와 shared/worktree workspace 안에서만 작업한다.
- 선언된 output과 validation evidence를 만든다.
- 읽을 수 있는 작업 이력을 보존하고 artifact를 Integration Manager에 반환한다.
- 자신의 자연어 응답으로 Task terminal 상태를 결정하지 않는다.

## Component 소유권

| Component | 소유하는 것 | 소유하면 안 되는 것 |
|---|---|---|
| MCP proxy | host-facing MCP transport, caller identity 전달 | Registry, scheduler, daemon 교체 |
| Control Plane daemon | SQLite Registry, project queue, claim, lease, App Server writer, Result projection | 사용자-facing 계획 판단 |
| Planner | 목표 분해와 immutable Task graph 제안 | 권한 부여, Task 실행 |
| RunController | Run projection, start/cancel orchestration | 두 번째 scheduler 또는 worker writer |
| Router | 명시적 요구에 맞는 Agent 선택 | sandbox 또는 side-effect 권한 변경 |
| Data Plane 스레드 | 배정된 Task 하나와 그 evidence | Run scheduling, sibling Task 변경 |
| Validator | acceptance criteria 판정 | 제품 구현 또는 scope 확장 |
| WorktreeManager | 격리 workspace, artifact, 직렬 integration | 무음 conflict 해결 또는 artifact 삭제 |
| Orchestrator | 복합 Run 조정 context와 synthesis evidence | scheduling, terminal 상태 또는 사용자 결과 정본 결정 |
| Synthesizer | durable 상태에서 Result projection 생성 | terminal 상태 변경, follow-up 작업 자동 시작 |
| Completion Evaluator | Turn·명령·산출물·validation·integration·postcondition evidence 판정 | Agent 자연어만으로 성공 확정 |

## 시스템 불변조건

1. **Single writer:** managed Codex turn은 daemon 소유 App Server 연결만 기록한다.
2. **Run-level authorization:** Control Plane 요청이 Run을 한 번 승인하며 Task, dependency, Validator, retry, rework가 새 Start 경계를 만들지 않는다.
3. **Plan is not permission:** Planner prose와 역할 이름은 filesystem, network, side-effect 권한을 부여하지 않는다.
4. **Graph before workers:** 전체 DAG를 검증하고 원자적으로 저장한 뒤에만 worker 스레드를 생성하거나 resume한다.
5. **Fenced completion:** active `worker_id + claim_token`이 일치하는 결과만 받으며 stale worker는 회수된 Task를 완료할 수 없다.
6. **One active Agent lease:** Agent 스레드 하나를 두 managed Task에 동시에 배정하지 않는다.
7. **Artifact preservation:** 통합되지 않았거나 conflict가 난 managed worktree는 retain/quarantine하며 조용히 폐기하지 않는다.
8. **Durable terminal delivery:** terminal Run을 먼저 projection한다. writer conflict는 delivery를 defer하며 대체 summary 스레드를 만들지 않는다.
9. **Dashboard independence:** dashboard를 열고 새로 고치거나 닫는 동작은 작업을 시작하거나 완료하지 않는다.
10. **No automatic external authority:** `external`, `destructive` side effect는 별도 사용자 요청이 필요하며 Task repair나 dashboard action으로 승인할 수 없다.
11. **One result authority:** 작업 목록, 결과 요약과 thread drill-down은 같은 durable Result projection을 사용한다. Orchestrator prose는 terminal 상태나 결과 정본을 덮어쓰지 않는다.
12. **No unresolved contract execution:** 권한·계약·workspace에 active 충돌이 있으면 Planner, Task, Agent, lease, worktree, attempt 생성 전에 차단한다.
13. **Evidence before success:** Agent·Orchestrator의 자연어 완료 선언은 terminal 상태를 만들지 않는다. 구조화된 completion evidence가 모두 충족되어야 한다.
14. **Same completion logic after restart:** 정상 실행과 daemon 재시작 복구는 같은 Completion Evaluator와 evidence precedence를 사용한다.

## 기본 요청 흐름

```text
Control Plane request
  -> persist Run(accepted)
  -> sync repository product contract + user decisions
  -> resolve immutable Context Snapshot or stop on conflict
  -> Planner creates and validates graph
  -> atomically persist Run + staged Tasks + dependencies
  -> automatic release to queued/blocked
  -> claim + Agent lease
  -> durable TurnDispatch(thread acquire -> turn submit -> reconcile)
  -> Data Plane turn
  -> hydrate complete Turn evidence
  -> materialize and verify declared outputs
  -> Validator when required by Task kind/criteria
  -> artifact integration when required
  -> post-integration verification when required
  -> one Completion Gate verdict
  -> terminalize Tasks and Run
  -> project/synthesize result
  -> work navigator -> owning Codex thread
```

정상 경로에는 placeholder `READY` turn과 dashboard Start gate가 없다.

스레드 생성은 작업 시작을 뜻하지 않는다. Planner, Orchestrator, Worker, Validator, Synthesizer는 모두 [Durable Turn Dispatch 계약](./contracts/TURN_DISPATCH.md)을 사용한다. `threadId` 확보, 제출 의도, `turnId`, terminal evidence를 단계별로 저장하고 취소 generation과 owner token으로 fence한다.

## 실행 계약

모든 Task는 `taskKind`, `mutatesWorkspace`, `requiredSandbox`, `sandbox`, `networkAccess`, `executionCapabilities`, `approvalPolicy`, `authorizationScope`, `sideEffectPolicy`, `idempotencyKey`, `workspaceMode`, `baseRef`, `integrationStrategy`, `outputs`, stable fingerprint를 기록한다. `authorizationScope`는 구조적으로 `parent_run`에 고정된다. `executionCapabilities`는 프로젝트 변경과 임시 파일, 프로세스, localhost, 브라우저, 외부 네트워크를 분리한다. Task prose는 모순을 찾는 lint 입력일 뿐 권한의 정본이 아니다. Side effect는 관찰(`none`), 제품 내부 daemon/process 수명주기(`local-runtime`), 프로젝트 파일(`workspace`), 원격·외부 시스템(`external`), 복구하기 어려운 변경(`destructive`)으로 구분한다. planning 중 계약을 compile하므로 잘못된 계획은 graph 준비 전에 수정한다. 자세한 규칙은 [contracts/EXECUTION_CONTRACT.md](./contracts/EXECUTION_CONTRACT.md)를 따른다.

### Runtime generation과 재설치 계약

project source, personal-plugin source, installed cache, daemon, MCP proxy는 runtime content hash, protocol version, canonical runtime path로 identity를 드러낸다. content hash는 `package.json`과 `src`, `ui`, `scripts` 아래 파일을 포함한다. 내용이 같아도 cache path가 바뀌면 다른 generation이다. 일반 MCP proxy는 mismatch를 관찰하면 `CLIENT_UPGRADE_REQUIRED`를 반환할 뿐 daemon을 종료·교체·downgrade하지 않는다. deployment/reinstall 도구만 handover authority를 사용할 수 있다.

재설치는 daemon active work가 0이고 이 plugin cache를 사용하는 MCP proxy가 모두 종료된 뒤에만 허용한다. Registry와 managed worktree는 durable data이므로 cache cleanup에 포함하지 않는다. preflight는 기본 dry-run이며 실행 시 정확한 `plugin@marketplace` selector만 제거·재설치하고 새 대화를 열어야 한다.

프로젝트 내부 변경은 사용자 Run-level authorization 안에서 `workspace-write + approvalPolicy=never`를 사용한다. 외부·파괴적 action은 dashboard에서 승인하지 않으며 `blocked_by_policy`로 종료하고 별도 사용자 요청을 요구한다.

## Workspace와 integration 수명주기

shared mutation은 project-scoped writer lease를 얻는다. 병렬 mutation은 기본적으로 managed worktree를 사용한다. dirty main workspace는 사용자 index를 바꾸지 않는 임시 Git index로 synthetic baseline commit을 만든다. Worker 변경은 commit과 binary patch artifact가 되어 repository-scoped 직렬 integration queue로 들어간다.

Task는 필요한 경우 완료 전에 `integration_pending`을 거친다. patch integration은 `git apply --check`를 사용하고 commit integration은 clean main workspace에서 cherry-pick한다. conflict는 안전하게 abort하고 artifact를 보존하며 `integration_blocked`로 끝난다. recovery tool은 inspect, finalize, integrate, cleanup, quarantine을 지원한다.

## 실패와 retry 정책

Failure의 canonical category는 `configuration`, `policy`, `environment`, `coordination`, `product`, `validation`이다. 진단을 위한 상세 type은 별도로 유지한다. configuration과 policy failure는 같은 계약으로 반복하지 않는다. 일시적 infrastructure/coordination/timeout만 같은 입력으로 retry할 수 있고 Validator rework에는 새 feedback이 필요하다. 모든 retry는 sandbox, thread, workspace, prompt 변경 여부를 기록한다.

Dependency는 `all_success`, `all_terminal`, `on_failure`를 지원한다. terminal failure cascade를 정리한 뒤 parent Run을 finalize한다.

## Daemon과 deployment

daemon health contract는 build ID, protocol version, runtime path, start time, capabilities, active work count, drain state를 제공한다. 승인된 mismatch handover에서는 구 daemon이 새 작업을 거부하고 active work를 drain한 뒤 socket을 해제해야 새 build가 시작된다.

Runtime deployment는 `src`, `ui`, `scripts`, `package.json`을 staging하고 digest를 검증한 뒤 runtime directory를 원자적으로 교체하고 새 daemon identity를 확인한다. 검증 실패 시 backup을 복원한다.

## Dashboard 계약

작업 탐색기는 현재 Codex 채팅 안의 MCP Apps UI로 표시하는 것이 기본이다. 로컬 web server는 host가 embedded UI를 지원하지 않거나 사용자가 web 표시를 명시한 경우에만 시작한다. Host가 확인한 각 Control Plane 채팅은 독립적인 TTL view lease를 받을 수 있고, 마지막 owner 기록은 host identity가 없는 호출의 fallback일 뿐 새 채팅을 막지 않는다. Worker와 Orchestrator 스레드는 view lease를 받을 수 없으며 poll하지 않는다. dispatch는 작업 탐색기를 자동으로 열지 않는다. 기본 화면의 최상위 목록은 사용자 요청을 대표하는 Master Worker들이다. 단순 Run의 Master를 선택하면 실제 작업 스레드로 이동한다. 복잡한 Run의 Master Orchestrator를 선택하면 일반 Codex 실행 기록과 함께 하위 Slave Task DAG를 표시하며, 그래프 노드를 선택하면 실제 Slave Worker 스레드로 이동한다. Planner, Validator, Synthesizer TurnDispatch는 고급 진단에서 조회할 수 있지만 사용자 작업 목록의 동급 최상위 노드로 올리지 않는다. Daemon Scheduler는 Codex 채팅이 아니므로 탐색 대상으로 넣지 않는다. Task approval tab이나 manual Start 경로는 없다.

사용자-visible notification은 `completed`, `failed`, `attention_required`, `policy_blocked` 네 종류뿐이다. running, queued, retrying, validation 같은 정상 진행은 notification을 만들지 않는다. notification은 작업 탐색기에 표시하며 policy stop은 제품·infrastructure failure와 구분한다.

## 결과 접근 계약

모든 control request는 요청 thread와 host가 제공하면 origin turn을 provenance로 기록한다. terminal projection, synthesis와 notification은 durable하다. daemon은 요청 스레드에 결과를 append하지 않는다. 사용자는 작업 탐색기에서 active·terminal Master를 확인하고 실제 Master 스레드로 이동한다. Master Orchestrator의 하위 그래프에서는 Slave 스레드로 이동할 수 있다. 기존 delivery row는 migration 호환 데이터일 뿐 새 Run에는 생성하지 않는다.

Responsive contract는 360, 600, 800, 1000, 1200px에서 검증한다. 좁은 화면은 1열 흐름을 사용하고 한국어 단어를 불필요하게 분리하지 않으며 primary container가 document-level 가로 overflow를 만들면 안 된다.
