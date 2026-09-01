# ADR-001: 구조화된 Registry 지식을 맥락의 정본으로 사용한다

- 상태: 채택, G2~G3 핵심 구현 완료
- 결정 대상: Context Manager, Router, Planner, Registry, Dashboard

## 맥락

현재 프로젝트 memory와 Agent summary는 `cwd`, 경로 관계와 키워드를 중심으로 관련성을 계산한다. 이는 같은 프로젝트의 최근 작업을 찾는 데 유용하지만 다음을 보장하지 못한다.

- 어떤 스레드가 특정 결정이나 제약을 실제로 알고 있는지
- 같은 주제에 대한 서로 다른 결론 중 무엇이 최신인지
- 재사용한 사실이 어느 스레드·턴·artifact에서 왔는지
- 여러 프로젝트에 걸친 지식을 한 목표에 사용할 수 있는지

스레드 자체를 정본으로 유지하면 목표마다 전체 이력을 다시 읽어야 하고, 맥락이 계속 분산된다.

## 결정

재사용 가능한 맥락의 정본은 Registry의 versioned `ContextClaim`과 `ContextSnapshot`으로 한다. Codex 스레드와 artifact는 claim의 provenance 및 감사 가능한 실행 이력으로 유지한다.

### ContextClaim 최소 모델

```text
ContextClaim
  id
  kind: fact | decision | constraint | assumption | artifact | result
  subject
  body
  scope: global | project | workspace | task
  project_ids[]
  source_thread_id
  source_turn_id?
  source_artifact_id?
  observed_at
  valid_from?
  valid_until?
  authority
  confidence
  status: active | disputed | superseded | expired
  supersedes_claim_id?
  content_hash
  schema_version
```

`body`가 같더라도 scope와 provenance가 다르면 같은 claim으로 간주하지 않는다. 중복 억제용 content hash와 의미적 supersede 관계를 분리한다.

### ContextSnapshot 최소 모델

```text
ContextSnapshot
  id
  objective_hash
  scope
  selected_claim_ids[]
  unresolved_conflicts[]
  selection_evidence[]
  created_at
  revision
  fingerprint
  schema_version
```

Snapshot은 planning 입력으로 immutable하다. claim을 추가·제거하거나 충돌을 해결하면 새 revision과 fingerprint를 만든다.

## 선택 규칙

Context Resolver는 최소한 다음 신호를 기록하고 사용한다.

1. 목표와 subject/body의 관련성
2. project와 workspace scope 일치
3. source의 authority
4. 관측 시점과 유효 기간
5. supersede 관계
6. 독립된 근거의 수
7. 현재 claim과의 충돌

점수만으로 충돌을 제거하지 않는다. 동일 subject와 scope에 양립할 수 없는 active claim이 있으면 snapshot에 `unresolved_conflict`를 남긴다. 정책이나 실행 계약을 바꾸는 충돌은 planning을 차단한다.

## 쓰기 경계

- worker 결과는 곧바로 canonical claim이 되지 않는다.
- Validator가 evidence와 scope를 확인한 뒤 claim 후보를 승인한다.
- 사용자 명시 결정은 별도 authority를 가지며 자동 결과가 조용히 supersede할 수 없다.
- Synthesizer는 claim을 요약할 수 있지만 새로운 사실을 생성하지 않는다.
- claim 수정은 기존 row 덮어쓰기가 아니라 revision 또는 supersede event로 기록한다.

## 결과

- 새 스레드는 필요한 snapshot을 받아 과거 대화 전체를 소유하지 않아도 작업할 수 있다.
- Router는 스레드 제목이나 요약이 아니라 관련 claim과 실제 provenance를 근거로 선택할 수 있다.
- Dashboard는 “왜 이 맥락과 스레드가 선택됐는가”를 표시할 수 있다.
- claim extraction, conflict detection, retention과 개인정보 범위가 새로운 운영 책임이 된다.

## 기각한 대안

### 스레드 전체 이력을 정본으로 유지

검색 비용과 context window 의존성이 계속 증가하고, 상충하는 결정을 구조적으로 표현할 수 없어 기각한다.

### 요약 문자열만 중앙 저장

출처, scope, 최신성, supersede와 충돌을 검증할 수 없어 기각한다.

## 후속 계약에서 확정할 항목

- claim schema와 fingerprint canonicalization
- 사용자 결정과 자동 추출 결과의 authority 순서
- 민감한 prompt·artifact의 저장 및 삭제 정책
- Router가 반환해야 할 selection evidence
- 기존 `memories` 데이터의 migration/legacy read 정책
- snapshot validation 실패의 terminal 상태와 nextAction
