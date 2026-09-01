# 맥락 수집·선택 계약

- 설계 상태: G3 구현 완료. Context Snapshot Resolver, pre-planning gate, 명시적 과거 스레드 색인과 dashboard on-demand 진단을 제공한다.
- 선행 결정: [ADR-001](../adr/ADR-001-CONTEXT-SOURCE-OF-TRUTH.md)

이 문서는 여러 프로젝트와 스레드에서 지식을 수집하고, 특정 사용자 목표에 사용할 immutable Context Snapshot을 만드는 계약을 정의한다. 이 계약의 목적은 긴 대화 전체를 복사하는 것이 아니라 재사용 가능한 주장과 그 근거를 구조화하고 선택 과정을 설명 가능하게 만드는 것이다.

## 엔터티

### ThreadKnowledgeSnapshot

스레드가 특정 시점까지 무엇을 다뤘는지 나타내는 immutable 색인이다.

```text
ThreadKnowledgeSnapshot
  id
  thread_id
  through_turn_id?
  project_ids[]
  role
  topics[]
  claim_ids[]
  artifact_ids[]
  source_digest
  extracted_at
  extractor_version
  status: current | superseded | incomplete
```

ThreadKnowledgeSnapshot은 스레드 전체를 정본으로 복제하지 않는다. 원본 스레드 범위와 digest를 기록하여 동일 범위를 중복 추출하지 않고, 새 turn이 생기면 새 snapshot을 만든다.

### ContextClaim

재사용 가능한 사실, 결정, 제약, 가정, artifact 또는 결과다. 최소 필드는 [ADR-001](../adr/ADR-001-CONTEXT-SOURCE-OF-TRUTH.md)의 모델을 따른다. 하나의 claim은 여러 source를 가질 수 있으며 source는 별도 관계로 보존한다.

Claim status는 다음 의미를 갖는다.

| 상태 | 의미 | Context Snapshot 선택 가능 |
|---|---|---:|
| `candidate` | 추출됐지만 아직 정본으로 검증되지 않음 | 아니오 |
| `active` | scope, provenance와 evidence가 검증됨 | 예 |
| `disputed` | 같은 subject/scope의 양립 불가능한 active claim이 존재 | 조건부 |
| `superseded` | 명시적 후속 claim으로 대체됨 | 아니오 |
| `expired` | 유효 기간 또는 freshness 정책이 끝남 | 아니오 |
| `rejected` | 근거 부족, scope 오류 또는 변조로 거부됨 | 아니오 |

`disputed` claim은 정보 제공 목적 snapshot에 포함할 수 있지만 반드시 conflict와 함께 포함한다. 권한, 실행 계약, 프로젝트 범위 또는 파괴 가능성에 영향을 주는 충돌은 planning을 차단한다.

### ContextSnapshot

하나의 objective revision에 사용할 claim과 충돌, 선택 근거를 고정한 planning 입력이다.

```text
ContextSnapshot
  id
  objective_hash
  requested_scope_hash
  resolver_version
  revision
  status: building | validated | invalid
  fingerprint
  created_at
  validated_at?
```

선택된 claim, 제외 사유와 conflict는 정규화된 관계로 저장한다. `validated` snapshot만 Planner에 전달할 수 있다.

## Authority 순서

Authority는 claim이 사실인지 단독으로 결정하는 점수가 아니라, 충돌 해결과 사용자 표시를 위한 명시적 등급이다.

높은 순서부터 다음 값을 사용한다.

1. `user_explicit`: 사용자가 현재 목표 또는 프로젝트 계약에서 명시한 결정
2. `project_contract`: repository의 검증된 정책·계약 문서
3. `validated_artifact`: 테스트, schema, commit 등 기계적으로 검증된 artifact
4. `validated_task_result`: acceptance 검증을 통과한 managed Task 결과
5. `observed_thread`: 원본 turn은 있으나 별도 검증되지 않은 스레드 관측
6. `model_inference`: 출처에서 추론했지만 직접 진술·검증되지 않은 내용
7. `legacy_unverified`: 기존 `project_memories`에서 이관된 내용

낮은 authority가 높은 authority를 자동 supersede할 수 없다. `model_inference`와 `legacy_unverified`는 기본적으로 `candidate`이며, 단독으로 권한·sandbox·side effect·프로젝트 범위를 결정할 수 없다.

## 수집 경로

모든 입력 경로는 같은 claim validator를 사용한다.

- managed Task terminal result와 Validator evidence
- 사용자가 현재 요청에서 명시한 결정과 제약
- 프로젝트의 선언된 계약 문서
- 기존 또는 새 Agent 스레드의 on-demand read
- artifact와 integration 결과
- legacy `project_memories` migration

수집 경로는 source identity, 관측 범위, extractor version과 content digest를 제공해야 한다. source 없이 생성된 claim은 `rejected`로 기록하며 active가 될 수 없다.

과거 스레드 색인은 사용자가 `requestedThreadIds`로 명시한 스레드에만 수행한다. `thread/read`는 새 turn이나 Agent를 만들지 않으며, 색인에는 source digest, through-turn, topic과 extractor version만 저장한다. 원문 prompt/output은 자동으로 Claim 본문이나 ThreadKnowledge metadata에 복제하지 않는다. 읽기 실패나 현재 digest 부재는 planning 전에 `requested_thread_unavailable` 또는 `requested_thread_knowledge_missing`으로 종료한다.

## Claim 활성화 게이트

```text
extract candidate
  -> validate schema and source
  -> normalize subject/scope
  -> detect duplicate/supersede/conflict
  -> validate evidence and authority
  -> active | disputed | rejected
```

검증 전에 다음 부작용을 만들면 안 된다.

- 기존 active claim supersede
- Thread/Agent 선택 결과 변경
- Planner 입력 변경
- project scope 또는 execution authority 확장

## 목표별 Context Resolution

Resolver 입력은 다음을 포함한다.

```text
ContextResolutionRequest
  objective
  objective_revision
  requested_project_ids[]
  requested_thread_ids[]?
  required_subjects[]?
  excluded_claim_ids[]?
  max_context_budget
  origin
```

처리 순서는 고정한다.

1. objective와 requested scope를 canonicalize한다.
2. scope 안의 active/disputed claim과 최신 ThreadKnowledgeSnapshot을 조회한다.
3. superseded, expired, rejected claim을 후보에서 제외한다.
4. 관련성, scope 일치, authority, freshness, evidence를 계산한다.
5. 동일 subject/scope의 충돌을 탐지한다.
6. 필수 subject와 provenance가 충족되는지 확인한다.
7. context budget 안에서 claim을 선택하고 제외 사유를 기록한다.
8. canonical payload의 fingerprint를 계산한다.
9. snapshot을 `validated` 또는 `invalid`로 terminalize한다.

점수는 후보 순서를 정할 뿐 claim의 진실성이나 권한을 만들지 않는다.

## 충돌 분류

| 분류 | 예 | Planning |
|---|---|---|
| `authorization` | 허용 프로젝트 또는 side effect 범위 불일치 | 차단 |
| `contract` | API/schema/상태 의미가 양립 불가 | 차단 |
| `workspace` | 기준 branch, repository identity 불일치 | 차단 |
| `factual` | 구현 상태나 버전에 대한 서로 다른 관측 | 필수 subject면 차단 |
| `preference` | 스타일이나 비필수 구현 선호 차이 | 경고와 함께 허용 |

차단 conflict가 있으면 Context Snapshot은 `invalid`이며 다음을 구조화해 반환한다.

```text
category: configuration | policy
cause: unresolved_context_conflict
conflict_ids[]
repairable: true | false
nextAction
```

invalid snapshot은 실패를 원래 Control Plane에 전달하기 위한 graphless terminal Run만 남길 수 있다. 실행 Task, attempt, Agent lease, turn 또는 worktree는 만들지 않는다.

## Fingerprint

Snapshot fingerprint는 다음 canonical payload의 SHA-256으로 계산한다.

- schema version과 resolver version
- objective hash와 objective revision
- 정렬된 project/thread scope
- 정렬된 `(claim_id, claim_revision, content_hash)`
- 정렬된 conflict ID와 resolution
- budget policy version

timestamp, DB row insertion order와 점수의 부동소수점 표현은 fingerprint 입력에서 제외한다. 저장된 payload와 fingerprint가 다르면 snapshot은 변조된 것으로 간주한다.

## Planning 경계

- Planner는 `status=validated`이고 fingerprint가 재검증된 snapshot만 받는다.
- Planner prompt에는 선택 claim과 provenance, unresolved non-blocking conflict를 포함한다.
- planning 도중 발견한 새 사실은 현재 snapshot을 변경하지 않고 candidate claim으로 저장한다.
- 해당 사실이 계획 또는 권한에 필요하면 기존 planning을 중단하고 새 snapshot revision을 만든다.
- Task에는 사용한 `context_snapshot_id`와 fingerprint를 저장한다.
- retry는 같은 Task contract뿐 아니라 같은 snapshot fingerprint 여부도 기록한다.

## 실패와 복구

- source thread를 읽지 못하면 snapshot을 임의 요약으로 채우지 않는다.
- 일부 선택 source가 없어도 필수 subject가 충족되면 warning으로 진행할 수 있다.
- 필수 provenance가 없거나 fingerprint가 다르면 `invalid`로 종료한다.
- daemon 재시작 시 `building` snapshot은 attempt를 소비하지 않고 deterministic resolution을 다시 수행하거나 invalid로 격리한다.
- 같은 objective/scope/source digest에 대한 resolution은 idempotency key로 기존 validated snapshot에 수렴한다.

## 개인정보와 retention

- 원본 prompt 전체는 claim body에 자동 복제하지 않는다.
- secret 후보와 인증 정보는 claim으로 저장하지 않는다.
- claim source가 삭제·접근 불가해져도 provenance identity와 digest는 보존하되 본문 retention 정책을 적용한다.
- snapshot이 참조하는 claim은 해당 Run의 감사·복구 retention 기간 동안 물리 삭제하지 않는다.

## 구현 검증

1. source 없는 candidate가 active가 되지 않는다.
2. 낮은 authority claim이 사용자 결정을 supersede하지 못한다.
3. blocking conflict가 Planner와 Agent 생성 전에 종료된다.
4. snapshot fingerprint 변조가 planning 전에 차단된다.
5. planning 중 새 claim이 기존 snapshot을 변경하지 않는다.
6. expired/superseded claim이 새 snapshot에 선택되지 않는다.
7. 동일 입력의 resolution이 같은 fingerprint와 entity로 수렴한다.
8. restart 후 building snapshot이 attempt 증가 없이 복구된다.
9. legacy memory가 자동 active authority로 승격되지 않는다.
10. Router 선택 결과에 claim provenance와 제외 사유가 남는다.

현재 구현 근거:

- `src/context-resolver.js`: deterministic resolution key, authority/relevance 선택, budget, blocking conflict, fingerprint 재검증
- `src/thread-knowledge-indexer.js`: 명시적으로 요청한 과거 스레드의 read-only digest/topic 색인과 원문 비보존
- `src/registry.js` schema version 4: snapshot/claim selection/conflict 관계와 pre-claim fingerprint gate
- `src/planner-engine.js`: Resolver 검증 완료 후에만 Planner Agent 생성
- `src/mcp-server.js`: direct/planned dispatch의 공통 snapshot gate와 Run/Task marker
- `src/dashboard-model.js`, `ui/dashboard.html`: polling에는 요약만 포함하고 선택·제외·충돌은 view lease 뒤에서 상세 조회
- `test/context-resolver.test.js`, `test/thread-knowledge-indexer.test.js`, `test/planner-engine.test.js`: 충돌·필수 맥락 누락·스레드 읽기 실패·변조·불변성·멱등성·재시작 복구·Agent 선행 생성 금지

후속 범위는 Global Run 도입 시 project별 snapshot slice와 authorization manifest를 결합하는 것이다.
