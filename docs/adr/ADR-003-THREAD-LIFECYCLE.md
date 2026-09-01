# ADR-003: 스레드를 제한된 실행·근거 자원으로 관리한다

- 상태: 채택 및 G6 구현 완료
- 결정 대상: Router, Agent Registry, Data Plane, App Server client, Dashboard

## 맥락

현재 Agent는 영구 Codex 스레드와 결합되며 Router는 reuse, fork, spawn을 선택한다. 이 방식은 작업 이력을 읽을 수 있게 하지만 Task가 늘수록 스레드 수도 계속 증가할 수 있다. fork는 충돌을 피하지만 장기적으로 같은 맥락의 계보를 더 복잡하게 만든다.

Task의 durable record와 영구 대화 스레드는 같은 것이 아니다. 실행과 evidence는 Registry에 보존할 수 있으므로 모든 Task가 새 영구 스레드를 요구하지 않는다.

## 결정

스레드를 무제한 생성되는 Task 저장소가 아니라 예산과 생명주기를 가진 실행·provenance 자원으로 관리한다. Router는 단순 `reuse | fork | spawn` 외에 context health와 예상 재사용 가치를 고려해야 한다.

### 생명주기

```text
candidate -> active -> idle -> compacted -> archived
                         \-> superseded
```

- `candidate`: 등록됐지만 아직 신뢰 가능한 지식이나 역할 이력이 부족하다.
- `active`: lease를 가지고 Task를 수행 중이다.
- `idle`: 재사용 가능하며 최신 Context Snapshot을 받을 수 있다.
- `compacted`: 핵심 claim과 evidence가 Registry에 반영됐고 긴 대화 이력을 재사용 대상으로 삼지 않는다.
- `superseded`: 더 적합한 후속 스레드나 역할 계보로 대체됐다.
- `archived`: 실행 후보에서 제외되지만 provenance와 감사 조회는 유지한다.

생명주기는 Agent 실행 상태와 분리된 `thread_lifecycle` projection으로 저장한다. Agent의 leased/running/validating 상태는 `active`, idle/available은 `idle`로 투영하지만 compacted/superseded/archived 상태를 자동으로 되살리지 않는다.

## 스레드 유형

### Durable specialist thread

지속적으로 재사용할 역할·프로젝트 지식이 있으며 후속 대화 가치가 높은 스레드다. 명시적 역할과 지식 범위를 가진다.

### Run orchestrator thread

복합 Run의 조정과 synthesis 근거를 기록한다. scheduling authority는 없으며 Run terminal 후 기본 재사용 대상이 아니다.

### Ephemeral worker execution

단순·독립적 Task를 처리하고 결과와 evidence만 Registry에 보존하는 실행이다. App Server가 기술적으로 영구 thread identity를 만들더라도 제품의 재사용 후보나 사용자 주요 목록에는 올리지 않고 완료 후 archive 대상이 된다.

## Router 선택 규칙

Router는 다음 순서로 판단 근거를 남긴다.

1. 필요한 capability와 실행 계약 충족 여부
2. 목표 ContextClaim과 스레드 provenance의 관련성
3. 스레드의 context health와 최근 Context Snapshot revision
4. active lease와 writer conflict 여부
5. 역할 계보에서 superseded 여부
6. 재사용이 장기 지식 축적에 주는 가치
7. 프로젝트별 thread budget

스레드 제목이나 키워드 일치만으로 “맥락을 가장 잘 이해한다”고 판정하지 않는다. 선택 결과에는 `selected_thread`, `alternatives`, `evidence`, `rejection_reasons`, `context_snapshot_id`를 기록한다.

## 생성·fork 정책

- `spawn`은 기존 후보가 실행 계약 또는 관련 맥락을 충족하지 않을 때만 허용한다.
- `fork`는 원본의 어떤 snapshot과 claim을 상속했는지 기록한다.
- busy 상태만으로 무조건 fork하지 않는다. queue latency와 thread budget을 함께 평가한다.
- 단발성 분석·검증은 기본적으로 ephemeral execution 후보로 분류한다.
- 새 영구 specialist thread 생성은 기대 역할, scope와 재사용 근거를 요구한다.
- 생성 예산 초과는 기존 스레드 compact/archive 또는 사용자 선택을 nextAction으로 제시한다.

## Compact와 supersede

Compact는 대화를 삭제하거나 요약 문자열 하나로 치환하는 작업이 아니다. 다음 조건을 만족해야 한다.

1. 재사용할 claim과 artifact가 provenance와 함께 Registry에 반영됨
2. 미해결 Task, delivery, integration과 lease가 없음
3. 후속 스레드가 필요한 Context Snapshot을 독립적으로 받을 수 있음
4. 계보와 원본 thread identity가 보존됨

`superseded`는 오래됐다는 이유만으로 자동 적용하지 않는다. 같은 역할·scope를 더 최신 snapshot으로 수행하는 후속 스레드가 있고 unresolved conflict가 처리됐을 때만 적용한다.

## 사용자 표면

Dashboard의 기본 질문은 “스레드가 몇 개인가”보다 다음에 답해야 한다.

- 이 목표에 어떤 스레드와 지식이 선택됐는가
- 왜 선택됐고 어떤 대안이 제외됐는가
- 어느 스레드가 active, reusable, compacted, superseded 상태인가
- 같은 역할의 계보와 최신 authoritative 결과는 무엇인가
- 생성 예산과 archive 후보는 무엇인가

## 기각한 대안

### Task마다 새 영구 specialist thread 생성

작업 이력 보존과 재사용 가능한 지식 관리를 혼동하고 원래의 스레드 증가 문제를 악화시키므로 기각한다.

### 가장 최근 스레드만 재사용

주제 관련성, 권위와 context health를 보장하지 못하므로 기각한다.

### 일정 기간 후 자동 삭제

provenance, delivery와 recovery evidence를 잃을 수 있으므로 기각한다.

## 구현된 정책

- schema version 7에서 `thread_lifecycle`, `thread_lifecycle_events`, `thread_budgets`를 저장한다.
- 기본 policy version 1은 project 8개, role 3개, lineage fork 4개, reuse 12회, context health 0.25를 한도로 사용한다.
- active lease, 미종결·attention·integration Task, 미전달 Control Result가 있으면 compact/archive를 거부한다.
- supersede는 같은 project/role successor와 successor의 current ThreadKnowledge Snapshot을 요구하고 lineage를 보존한다.
- Router는 `reuse | fork | spawn | ephemeral | wait`와 budget/context evidence를 durable routing decision으로 남긴다.
- read-only 단발 분석·검토만 durable budget 소진 시 ephemeral 후보가 되며 terminal 후 compact/archive한다.
- MCP와 Dashboard가 현재 lifecycle, context health, successor와 budget counter를 조회할 수 있다.

App Server archive 실패는 Registry에서 cleanup attention event로 남기며 해당 thread를 compacted 상태로 Router에서 격리한다.
