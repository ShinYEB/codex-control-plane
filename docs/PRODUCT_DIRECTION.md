# 제품 목적과 설계 방향

이 문서는 Codex Agent Control Plane이 해결하려는 사용자 문제와 제품 경계를 정의하는 정본이다. 실행 방법은 [ARCHITECTURE.md](./ARCHITECTURE.md), 세부 계약은 [설계 문서 인덱스](./README.md)를 따른다.

## 시작 이유

Codex를 오래 사용할수록 프로젝트와 작업별 스레드가 계속 늘어난다. 그러나 스레드가 가진 결정, 제약, 조사 결과와 작업 이력은 검색·비교·결합할 수 있는 공용 지식으로 관리되지 않는다. 그 결과 다음 문제가 생긴다.

1. 어떤 스레드가 현재 목표의 맥락을 가장 잘 이해하는지 판단하기 어렵다.
2. 하나의 복잡한 목표에 필요한 맥락이 여러 스레드에 나뉘면 이를 일관된 계획으로 조정할 수 없다.
3. 여러 프로젝트와 여러 스레드에 걸친 목표를 하나의 명령과 상태로 관리할 중앙 계층이 없다.

이 프로젝트의 목적은 단순히 더 많은 worker 스레드를 만드는 것이 아니다. 스레드와 프로젝트에 흩어진 지식과 실행 상태를 로컬에서 지속적으로 관리하고, 사용자 목표에 필요한 맥락을 근거와 함께 선택·고정한 뒤, 중앙 정책 아래 여러 실행 주체를 조정하는 것이다.

## 제품 정의

> Codex Agent Control Plane은 여러 프로젝트와 스레드의 지식·상태를 색인하고, 목표에 맞는 맥락을 근거와 함께 구성하며, 이를 바탕으로 안전한 다중 스레드·다중 프로젝트 실행을 지휘하는 로컬 영속 조정 계층이다.

사용자 요청 한 건은 작업 탐색기에서 하나의 **Master Worker**로 표현한다. 단순 요청은 실제 작업을 직접 수행하는 단일 Master Worker 스레드로, 복합 요청은 하위 작업을 분해하고 종합하는 Master Orchestrator 스레드로 실행한다. 복합 Run의 개별 Task는 Slave Worker 스레드가 수행한다. daemon은 이 스레드들의 계약·상태·소유권을 관리하는 백그라운드 프로세스이며 사용자 작업 노드가 아니다.

## 제품이 수행해야 하는 세 가지 일

### 1. 스레드와 지식의 식별

- 각 스레드의 역할, 프로젝트, 작업 이력과 현재 생명주기를 추적한다.
- 스레드에서 만들어진 사실, 결정, 제약, 산출물을 출처와 함께 구조화한다.
- 목표별 관련성, 최신성, 권위와 충돌 여부를 기준으로 필요한 지식을 찾는다.
- 사용자가 특정 스레드의 제목이나 위치를 기억해야 하는 상황을 줄인다.

### 2. 목표별 맥락 통합과 오케스트레이션

- 여러 스레드와 프로젝트에서 관련 지식을 수집한다.
- 상충하는 주장을 숨기지 않고 근거와 함께 표시한다.
- 실행 전에 목표별 immutable Context Snapshot을 만든다.
- 해당 snapshot을 기준으로 계획, Task DAG, handoff, 검증과 결과 종합을 수행한다.

### 3. 전역 명령과 실행 관리

- 하나의 사용자 목표가 여러 프로젝트를 포함할 수 있다.
- 전역 목표를 프로젝트별 Run과 프로젝트 간 dependency로 분해한다.
- 각 프로젝트의 권한, workspace, integration과 실패 경계를 독립적으로 유지한다.
- 전체 진행 상태와 결과를 하나의 Global Run에서 설명한다.

## 핵심 제품 불변조건

1. **Registry knowledge is canonical:** 재사용 가능한 맥락의 정본은 구조화된 Registry 지식이다. 스레드는 근거와 실행 이력이지 유일한 지식 저장소가 아니다.
2. **Provenance is mandatory:** 재사용되는 사실, 결정, 제약은 출처 스레드·턴 또는 artifact와 관측 시점을 가져야 한다.
3. **Snapshot before planning:** 복합 목표는 계획 전에 Context Snapshot을 확정한다. 계획 중 암묵적으로 추가된 맥락은 별도 revision 없이 권한이나 범위를 넓힐 수 없다.
4. **Conflict is explicit:** 상충하는 지식을 임의로 병합하지 않는다. 해결되지 않은 충돌은 snapshot과 계획에 표시한다.
5. **Global goal, local authority:** Global Run은 조정을 소유하지만 프로젝트별 실행 계약과 권한 경계를 우회하지 않는다.
6. **Threads are bounded resources:** Task 기록을 영속화하기 위해 항상 새 영구 스레드를 만들 필요는 없다. 생성·재사용·압축·대체·보관은 명시적 정책을 따른다.
7. **Selection is explainable:** Agent, 스레드와 맥락을 선택한 이유를 사용자와 감사 로그가 확인할 수 있어야 한다.
8. **Execution safety remains foundational:** 계약 검증, 상태 머신, claim, retry, recovery, integration과 Result projection 불변조건은 전역 오케스트레이션에서도 그대로 적용한다.

## 현재 구현 판정

현재 구현은 안전한 실행 기반을 제공하지만 제품 목적을 일부만 충족한다.

| 사용자 문제 | 현재 구현 | 판정 | 필요한 변화 |
|---|---|---|---|
| 스레드가 계속 증가함 | Agent 재사용·fork·archive, durable Task thread | 부분 충족 | 생성 예산, compact/supersede, ephemeral 실행 정책 |
| 적합한 스레드를 찾기 어려움 | 역할·경로·요약·키워드 기반 Router | 부분 충족 | Thread Knowledge와 provenance 기반 선택 |
| 여러 스레드의 맥락이 분산됨 | 프로젝트 memory, Task DAG, A2A handoff | 부분 충족 | 기존 스레드 지식 수집, 충돌 검출, Context Snapshot |
| 여러 프로젝트를 중앙 지휘할 수 없음 | Global Run, Project Run, cross-project dependency와 durable handoff | 핵심 구현 | Master 중심 탐색 구조와 실제 복합 E2E 검증 |

계약 안정화 작업은 폐기하거나 후퇴시키지 않는다. 다음 제품 단계의 중심을 dashboard 확장이나 worker 수 증가가 아니라 지식 구조화, context resolution과 전역 실행 계층으로 옮긴다.

## 목표 구조

```text
User Objective
  -> create one Master Worker
       -> simple: Master Worker performs the Task
       -> complex: Master Orchestrator
            -> validated Task DAG
            -> Slave Worker threads
            -> durable evidence/result envelopes
            -> final synthesis in the Master thread
  -> inspect status and hierarchy in Work Navigator
  -> navigate to the actual Master or Slave Codex thread
```

여러 프로젝트를 포함하는 경우 `Global Run`이 목표와 전역 조정을 소유하고, 기존 `Run`은 프로젝트별 권한과 실행을 소유하는 `Project Run`으로 유지한다. 이 계층도 사용자에게는 하나의 Master를 중심으로 표시하며 프로젝트별 Run과 Slave는 그 하위 구조가 된다.

Slave 결과는 Master에게 직접 비영속 메시지로 보내지 않는다. Slave가 명령·테스트·artifact·validation evidence를 Registry에 기록하면 daemon이 이를 검증하고, 결정 장벽이나 예외 또는 최종 종합 시점에 Master를 깨워 검증된 결과 묶음을 전달한다.

## 성공의 제품적 의미

Agent가 자연어로 “완료”라고 답한 것은 성공 증거가 아니다. 성공은 terminal Turn, 명령과 테스트 결과, 실제 산출물, workspace 변경, validation, integration과 통합 후 조건을 daemon이 확인한 뒤에만 확정한다. 자연어 답변은 이 구조화된 판정을 설명할 수 있지만 뒤집을 수 없다. 세부 규칙은 [Completion Gate 계약](./contracts/COMPLETION_GATE.md)을 따른다.

## 범위 밖

- 스레드 전체 대화를 무제한으로 복제해 중앙 prompt에 넣는 것
- 근거 없이 오래된 스레드를 자동으로 권위 있는 지식으로 승격하는 것
- Global Run을 이유로 프로젝트별 sandbox나 사용자 권한을 우회하는 것
- dashboard를 열어야만 작업이 진행되거나 결과를 받을 수 있게 하는 것
- 외부 서비스와 파괴적 변경을 전역 목표라는 이유로 자동 승인하는 것

## 다음 설계 순서

1. [ADR-001: 맥락의 정본](./adr/ADR-001-CONTEXT-SOURCE-OF-TRUTH.md)
2. [ADR-002: 전역 실행 계층](./adr/ADR-002-GLOBAL-RUN-HIERARCHY.md)
3. [ADR-003: 스레드 생명주기](./adr/ADR-003-THREAD-LIFECYCLE.md)
4. [ADR-004: 사용자 결과의 정본](./adr/ADR-004-RESULT-AUTHORITY.md)
5. [Context Resolution 계약](./contracts/CONTEXT_RESOLUTION.md)
6. [Global Run과 다중 프로젝트 실행 계약](./contracts/GLOBAL_RUNS.md)
7. [목표 persistence 계약](./contracts/TARGET_PERSISTENCE.md)
8. [전역 오케스트레이션 구현 게이트](./GLOBAL_ORCHESTRATION_GATE.md)의 실패 테스트를 먼저 추가한 뒤 구현
