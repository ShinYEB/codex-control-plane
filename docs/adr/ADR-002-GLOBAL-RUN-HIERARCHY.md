# ADR-002: Global Run 아래에 프로젝트별 Run을 둔다

- 상태: 채택, G4~G5 구현 완료
- 결정 대상: MCP schema, Planner, RunController, Registry, 상태 머신, Dashboard, Delivery

## 맥락

현재 Run과 Task는 하나의 `cwd`를 중심으로 계획·실행된다. daemon과 Registry는 여러 프로젝트를 관찰할 수 있지만, 하나의 목표에 여러 프로젝트를 포함하거나 프로젝트 사이의 dependency를 표현하는 실행 단위는 없다.

기존 Run의 `cwd`를 배열로 바꾸면 workspace 권한, integration queue, 실패 판정과 origin delivery의 의미가 모호해진다.

## 결정

사용자 목표의 최상위 단위로 `GlobalRun`을 도입하고 기존 Run은 `ProjectRun` 의미로 유지한다. 이름 변경에 따른 호환성 비용을 피하기 위해 저장/API의 기존 `runs`는 당분간 유지하되 `global_run_id`를 통해 상위 실행과 연결한다.

```text
GlobalRun
  ├─ ProjectRun(project A, authorization A, context slice A)
  │    └─ Task DAG A
  ├─ ProjectRun(project B, authorization B, context slice B)
  │    └─ Task DAG B
  └─ CrossProjectDependency(ProjectRun/Task output -> ProjectRun/Task input)
```

## 책임 경계

### GlobalRun

- 사용자 objective, origin과 전역 Context Snapshot을 소유한다.
- 참여 프로젝트와 project graph를 고정한다.
- 프로젝트 간 dependency, handoff와 전체 결과 synthesis를 소유한다.
- ProjectRun의 sandbox, workspace 또는 integration 권한을 확장하지 않는다.

### ProjectRun

- 하나의 canonical project identity와 workspace 경계를 소유한다.
- 기존 execution contract, Task DAG, claim, retry, integration과 delivery projection 규칙을 사용한다.
- 다른 ProjectRun의 workspace를 직접 수정하지 않는다.

### CrossProjectDependency

- producer, consumer, 전달 artifact/claim, acceptance criteria를 명시한다.
- consumer는 전달 데이터가 검증되고 durable하게 기록되기 전에 실행되지 않는다.
- filesystem 경로의 암묵적 공유를 dependency로 간주하지 않는다.

## 권한 규칙

1. GlobalRun 요청은 포함될 project scope를 명시해야 한다.
2. 각 ProjectRun은 자체 execution contract와 workspace preflight를 통과해야 한다.
3. 프로젝트가 추가되거나 side-effect 범위가 넓어지면 GlobalRun revision과 필요한 사용자 권한을 새로 확인한다.
4. 한 프로젝트의 승인은 다른 프로젝트나 외부 서비스에 전이되지 않는다.
5. cross-project handoff는 데이터 전달이지 filesystem/network 권한 위임이 아니다.

## 상태와 실패 집계 원칙

- GlobalRun은 최소한 `accepted`, `resolving_context`, `planning`, `running`, `waiting`, `attention_required`, `completed`, `failed`, `cancelled` 의미를 가져야 한다.
- 모든 ProjectRun이 success terminal이면 GlobalRun을 완료할 수 있다.
- required ProjectRun의 failure/cancel은 GlobalRun 성공으로 숨기지 않는다.
- optional project 실패 허용 여부는 graph에 명시하며 synthesis에 반드시 노출한다.
- 한 ProjectRun의 configuration/policy failure는 같은 contract로 자동 재시도하지 않는다.
- 부분 취소와 recovery attention은 기존 중앙 상태 의미를 보존한다.

정확한 enum과 전이표는 `src/domain-states.js`, graph/authorization/handoff version과 fingerprint 규칙은 `src/global-runs.js`가 구현 정본이다. Project Run 사이에는 durable evidence와 receipt만 전달하며 project filesystem 권한은 전이하지 않는다.

## 계획 순서

```text
persist GlobalRun(accepted)
  -> resolve and freeze global Context Snapshot
  -> identify and authorize project set
  -> create and validate project graph
  -> compile/validate every ProjectRun and cross-project handoff
  -> atomically persist graph
  -> release eligible ProjectRuns
```

전체 project graph와 전달 계약이 유효해지기 전에 worker, Agent turn 또는 worktree를 만들지 않는다.

## 결과 접근

- terminal 사용자 결과의 정본은 GlobalRun synthesis 하나다.
- ProjectRun 결과와 artifact는 상세 evidence로 유지한다.
- 작업 탐색기에서 Global Run → Project Run → Orchestrator/Task 스레드 계층으로 접근한다.
- 일부 프로젝트 결과만 도착한 상태를 전체 성공으로 표시하지 않는다.

## 기각한 대안

### 기존 Run에 여러 cwd를 직접 저장

권한·workspace·integration과 실패 경계가 하나의 상태에 섞이므로 기각한다.

### 프로젝트마다 독립 Run을 만들고 prompt로만 연결

dependency와 전체 terminal 판정을 영속적으로 증명할 수 없어 기각한다.

## 후속 계약에서 확정할 항목

- canonical project identity와 symlink/worktree 처리
- GlobalRun 및 cross-project dependency schema
- project graph cycle과 atomic persistence 검증
- optional ProjectRun의 성공 집계 규칙
- global cancellation의 ProjectRun 전파 규칙
- Context Snapshot의 프로젝트별 최소 slice
- 기존 단일 프로젝트 요청을 implicit GlobalRun으로 감쌀지 여부
- migration, downgrade와 API compatibility
