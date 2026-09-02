# ADR-006: 작업 탐색기 기반 결과 접근

## 결정

Control Plane의 사용자 표면은 결과를 원래 요청 스레드로 밀어 넣는 전달함이 아니라, 현재 및 종료된 작업을 탐색하는 **작업 탐색기**다.

- 작업 탐색기는 사용자 요청을 대표하는 active·terminal Master Worker를 상태 목록으로 보여준다.
- 단순 Master Worker를 선택하면 작업을 수행한 실제 Codex 스레드로 이동한다.
- Master Orchestrator를 선택하면 실제 Codex 실행 기록과 Slave Worker Task DAG를 계층적으로 보여준다.
- Slave 노드를 선택하면 그 작업을 실제로 소유한 Codex 스레드로 이동한다.
- Planner, Validator, Synthesizer는 고급 진단 evidence이며 Master와 동급인 최상위 사용자 작업으로 표시하지 않는다.
- daemon은 terminal 결과를 요청을 만든 스레드에 자동 append하지 않는다.
- 결과 요약은 Registry의 durable Result projection으로 남으며 작업 탐색기에서 조회한다.

## 이유

자동 origin 반환은 제어 대화와 실제 작업 대화의 경계를 흐리고, 작업이 많을수록 어떤 스레드가 무엇을 수행했는지 다시 찾기 어렵게 만든다. 작업 목록과 실행 구조를 정본으로 삼으면 상태 확인과 맥락 복귀가 같은 탐색 경로를 사용한다.

## 탐색 흐름

```text
작업 목록
  -> Master Worker 선택 -> Codex 스레드 이동
     -> 단순 Master: 일반 실행 기록
     -> Master Orchestrator: 일반 실행 기록 + Slave Task DAG
        -> Slave 노드 선택 -> Slave Codex 스레드 이동
```

## 불변조건

- 목록·구조 조회와 스레드 이동은 Run을 시작하거나 retry하지 않는다.
- 스레드 이동은 새 turn을 생성하지 않는다.
- 실행 중인 스레드도 열 수 있지만 writer 소유권은 daemon에 남는다.
- Run 결과, Task 결과, validation, artifact, failure는 한 durable projection을 공유한다.
- notification은 작업 탐색기에서 표시하며 origin 스레드에 자동 전달하지 않는다.

## 호환성

기존 `control_result_deliveries` 데이터는 migration 호환을 위해 보존할 수 있으나 새 Run에는 생성하지 않는다. `drain_control_results`는 공개 MCP 계약에서 제거한다.
