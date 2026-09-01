# 맥락·전역 실행 목표 영속성 계약

- 설계 상태: G1~G6 구현 완료. schema version 7에 thread lifecycle projection과 versioned project/role budget이 포함된다.
- 현재 저장 계약: [PERSISTENCE.md](./PERSISTENCE.md)

이 문서는 Context Resolution과 Global Run을 추가하기 위한 목표 schema, migration과 원자성 경계를 정의한다. 현재 구현의 SQLite single-writer, `PRAGMA user_version`, migration snapshot과 fencing 원칙을 그대로 유지한다.

## 설계 원칙

1. identity, dependency, provenance와 선택 관계는 JSON 배열이 아니라 FK 관계로 저장한다.
2. immutable revision과 append-only history를 우선하며 실행 중 row 의미를 덮어쓰지 않는다.
3. fingerprint가 있는 payload는 canonical JSON과 분리 저장하되 읽기 시 재검증한다.
4. 전체 graph 준비와 Context Snapshot validation은 worker side effect 전에 완료한다.
5. legacy memory는 검증 없이 active canonical knowledge로 승격하지 않는다.
6. thread와 project는 다대다 관계를 허용한다.

## Project identity

새 `projects` entity가 `cwd` 문자열 대신 논리 프로젝트 경계를 나타낸다.

```text
projects
  id PK
  canonical_key UNIQUE
  kind: git | directory
  canonical_root
  repository_common_dir?
  identity_version
  display_name?
  created_at
  updated_at
```

Canonicalization 규칙:

- 모든 path는 존재 확인 후 `realpath`를 사용한다.
- Git worktree는 `git common dir`로 repository identity를 공유하되 workspace root는 별도 기록한다.
- remote URL과 현재 branch는 변경 가능하므로 project identity의 단독 근거로 사용하지 않는다.
- case-insensitive filesystem에서는 해당 filesystem의 canonical casing을 사용한다.
- non-Git directory는 canonical realpath와 identity version으로 key를 만든다.
- canonicalization 실패는 새 project ID를 추측하지 않고 configuration failure로 반환한다.

기존 `cwd`는 호환 표시와 migration source로 유지할 수 있지만 신규 scope 비교의 정본은 `project_id`다.

## 목표 테이블

### Context와 thread knowledge

| 테이블 | 핵심 역할 |
|---|---|
| `thread_project_memberships` | thread와 project의 다대다 관계, 역할과 관측 범위 |
| `thread_knowledge_snapshots` | source 범위·digest·extractor version별 immutable thread 색인 |
| `context_claims` | claim kind, subject, body, scope, authority, status, revision, hash |
| `context_claim_sources` | claim과 thread/turn/artifact/document provenance 관계 |
| `context_claim_projects` | claim의 project scope 다대다 관계 |
| `context_claim_supersessions` | 이전/후속 claim과 명시적 supersede 이유 |
| `context_conflicts` | claim 쌍/집합, conflict category, resolution 상태 |
| `context_snapshots` | objective/scope/resolver revision과 validated fingerprint |
| `context_snapshot_claims` | 선택 claim, 순서, 점수 근거, inclusion/exclusion reason |
| `context_snapshot_conflicts` | snapshot에 고정된 conflict와 resolution |

### Global execution

| 테이블 | 핵심 역할 |
|---|---|
| `global_runs` | request key, objective, origin, 현재 revision과 projection 상태 |
| `global_run_revisions` | context/authorization/project graph fingerprint의 immutable revision |
| `global_run_projects` | revision과 기존 `runs`의 membership, required/optional 의미 |
| `authorization_manifests` | project별 권한 ceiling과 fingerprint |
| `cross_project_dependencies` | producer/consumer, condition, handoff fingerprint |
| `cross_project_handoffs` | 전달 claim/artifact, content hash, validation/receipt 상태 |
| `global_run_results` | terminal 전역 projection과 synthesis payload |
| `global_run_failures` | category, cause, fingerprint 조합, repair와 nextAction history |

### Thread lifecycle와 routing

| 테이블 | 핵심 역할 |
|---|---|
| `thread_lineage` | parent/fork/supersede 관계와 inherited snapshot |
| `thread_lifecycle_events` | candidate/active/idle/compacted/superseded/archived 전이 감사 |
| `routing_decisions` | 후보, 선택 evidence, 제외 이유, budget과 snapshot identity |
| `thread_budgets` | project/role별 생성·활성·재사용 정책 version |

기존 `agents`는 실행 주체와 lease 상태를 유지하고, 장기 lifecycle은 별도 `thread_lifecycle` projection으로 관리한다. `thread_budgets`의 current revision은 project/role scope별 하나이며 이전 revision은 superseded 상태로 보존한다.

## 필수 key와 constraint

- `global_runs.request_key` unique
- `(global_run_id, revision)` unique
- `(context_snapshot_id, context_claim_id)` unique
- `(claim_id, source_kind, source_id, source_revision)` unique
- Project Run은 하나의 GlobalRunRevision membership에만 속하거나 standalone이어야 함
- dependency producer와 consumer 불일치 CHECK
- terminal/validated fingerprint column non-null CHECK
- current revision FK는 같은 parent Global Run을 가리켜야 함
- source 없는 active/disputed claim 금지
- validated snapshot에 building/candidate claim 연결 금지
- handoff receipt는 producer content hash와 일치해야 함

SQLite가 복잡한 교차-row constraint를 CHECK로 표현하지 못하면 Registry transaction과 검증 query로 강제하고 실패 테스트를 둔다.

## 원자성 경계

### Context Snapshot validation

한 `BEGIN IMMEDIATE` transaction에서 다음을 수행한다.

1. candidate set과 source revision 재확인
2. selected claim/conflict 관계 저장
3. canonical payload와 fingerprint 저장
4. snapshot을 `validated` 또는 `invalid`로 terminalize

### Global graph materialization

한 `BEGIN IMMEDIATE` transaction에서 다음을 수행한다.

1. GlobalRunRevision 저장
2. authorization manifest 저장
3. Project Run과 전체 staged Task graph 저장
4. membership과 cross-project dependency 저장
5. revision validation marker와 fingerprint 저장
6. Global Run을 `preparing`에서 release 가능한 상태로 projection

commit 전에는 queue row를 release하거나 App Server thread/worktree를 만들지 않는다.

### Claim activation

Project Run/Task claim은 기존 execution marker 외에 다음을 확인한다.

- parent GlobalRunRevision이 validated/current임
- Context Snapshot fingerprint 일치
- authorization manifest fingerprint 일치
- 전역 cancellation intent 없음
- inbound required handoff가 validated/received 상태임

하나라도 실패하면 attempt를 증가시키지 않는다.

## Migration 단계

### 0. Backup과 capability check

- 기존 규칙대로 `VACUUM INTO` snapshot을 만든다.
- App Server archive/read capability와 filesystem canonicalization을 점검한다.
- migration version과 target runtime identity를 기록한다.

### 1. Expand

- 신규 table/index/constraint를 transaction으로 추가한다.
- 기존 code path는 계속 `runs`, `tasks`, `project_memories`를 읽는다.

### 2. Project backfill

- 기존 distinct `cwd`를 canonicalize해 `projects`를 만든다.
- symlink/worktree/case 충돌은 자동 병합하지 않고 migration attention row로 격리한다.
- 기존 Run, Agent와 memory에 project mapping을 연결한다.

### 3. Legacy memory backfill

- `project_memories`를 `authority=legacy_unverified`, `status=candidate` claim으로 복사한다.
- 원본 memory ID와 content hash를 provenance에 기록한다.
- 같은 text를 근거로 여러 project scope를 임의 병합하지 않는다.

### 4. Thread knowledge backfill

- 기존 Agent summary와 terminal result를 incomplete ThreadKnowledgeSnapshot 후보로 기록한다.
- 원본 turn을 읽고 검증하기 전에는 authoritative claim으로 사용하지 않는다.

### 5. Compatibility read

- Context Resolver가 validated claim을 우선 읽고 legacy memory는 명시적 fallback warning으로만 제공한다.
- 새 write는 claim candidate pipeline으로만 수행한다.

### 6. Cutover

- 필수 project scope가 validated Context Snapshot을 만들 수 있음을 검사한다.
- Planner와 Router를 snapshot 기반 경로로 전환한다.
- `project_memories` 신규 write를 중단하되 downgrade/감사를 위해 즉시 삭제하지 않는다.

### 7. Contract enforcement

- Global Run parent fencing과 신규 FK/constraint를 claim path에서 의무화한다.
- 구 runtime은 protocol/build compatibility 검사로 신규 DB writer가 되지 못하게 한다.

각 단계는 reopen 후 idempotent해야 한다. 일부 backfill 실패로 schema version만 최종 값이 되어서는 안 된다.

## Compatibility

- 기존 단일-project dispatch는 standalone Run으로 계속 동작할 수 있다.
- Global orchestration API가 안정화된 뒤 단일 요청을 implicit one-project Global Run으로 감쌀지는 별도 API version에서 결정한다.
- 기존 Run ID, Task ID와 origin delivery key를 변경하지 않는다.
- legacy `cwd`, `sessionId`, `project_memories`는 read compatibility 기간과 제거 migration을 별도로 기록한다.
- downgrade는 신규 table을 무시하는 구 runtime 실행이 아니라 migration 전 snapshot 복구로만 지원한다.

## Retention과 삭제

- terminal Global Run을 archive해도 revision, snapshot, manifest, handoff와 result는 보존한다.
- snapshot이 참조하는 claim/source는 해당 Run retention 기간에 물리 삭제하지 않는다.
- thread archive는 claim provenance를 삭제하지 않는다.
- source 본문을 개인정보 정책으로 제거할 때 identity, digest, removal event는 보존한다.
- compacted/superseded thread도 active integration, delivery, lease가 있으면 삭제·cleanup할 수 없다.

## Consistency 검사

재시작과 진단 시 다음을 검출한다.

- current GlobalRunRevision과 project membership 불일치
- validated snapshot fingerprint와 claim revision 불일치
- active claim에 source가 없음
- Global Run이 terminal인데 child Project Run이 새 claim 가능
- consumer가 validated handoff 없이 running
- archived thread가 active lease를 보유
- 같은 lineage에 여러 current specialist가 존재
- legacy project mapping collision이 미해결 상태

자동으로 의미를 추측해 수정할 수 없는 경우 `attention_required` 또는 migration attention으로 terminal 격리하고 nextAction을 제공한다.

## 구현 전 실패 테스트

1. migration 전 snapshot 없이 schema version이 오르지 않는다.
2. symlink/worktree가 잘못된 별도 project 권한으로 분리되지 않는다.
3. 모호한 project identity가 자동 병합되지 않는다.
4. legacy memory가 active claim으로 backfill되지 않는다.
5. source 없는 active claim insert가 거부된다.
6. invalid snapshot을 참조한 graph가 commit되지 않는다.
7. 부분 Global graph가 crash 후 release되지 않는다.
8. parent revision/fingerprint 불일치가 Task attempt 전에 차단된다.
9. validated handoff 없는 consumer가 claim되지 않는다.
10. terminal Global Run 아래 새 Task claim이 거부된다.
11. migration/reopen이 backfill을 중복 생성하지 않는다.
12. 구 runtime이 신규 schema writer가 되지 않는다.
