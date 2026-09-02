# G7 최종 E2E 검증 근거

- 상태: 통과
- 실행 경계: plugin 설치·재설치·plugin dispatch 없음
- 실행 명령: `pnpm run check && pnpm run test:g7 && git diff --check`
- 테스트 환경: 로컬 Node, 임시 SQLite, 임시 Git repository, in-process App Server test double

이 게이트는 신규 Global orchestration 시나리오와 [STABILIZATION_GATE.md](./STABILIZATION_GATE.md)의 기존 10개 안정화 시나리오를 동시에 요구한다. 특정 파일만 통과시키지 않고 전체 `node --test`를 릴리스 판정으로 사용한다.

| # | 최종 시나리오 | 자동 검증 evidence | 보장하는 terminal/next action |
|---:|---|---|---|
| 1 | 단일 프로젝트 read-only Run | `run_agent_task injects project context and records its result` | `completed`; 실행 계약은 read-only/none |
| 2 | managed worktree 수정·통합 | `dirty project state is snapshotted and worker artifacts integrate back`; commit/parallel integration tests | 성공 시 `completed`; 충돌 시 `integration_blocked`와 recovery |
| 3 | 두 프로젝트 read-only Global Run | `prepare_global_run atomically exposes root and dependent Project Runs through MCP` | validated revision 뒤 root만 release |
| 4 | producer artifact → consumer | `a recorded producer artifact crosses the project boundary only through a validated handoff`; MCP durable handoff E2E | `received` receipt 전 consumer attempt 0 |
| 5 | 충돌한 과거 맥락 차단 | `equal-authority contract conflict creates an invalid terminal snapshot`; Planner conflict gate | `CONTEXT_SNAPSHOT_INVALID`; conflict resolution 요구 |
| 6 | 사용자 결정 후 새 Snapshot 실행 | `an explicit user resolution supersedes conflicting history before a new snapshot can execute` | 과거 claim은 superseded, 새 fingerprint만 claim 가능 |
| 7 | 권한 확대 revision 경계 | `authorization expansion requires an explicit new revision payload before graph persistence`; API version test | 좁은 권한은 persistence 전 거부; 명시적 revision 2만 저장 |
| 8 | required Project Run 실패 | `required failure fails Global Run while optional failure is preserved as a completion warning` | Global Run `failed` |
| 9 | optional Project Run 실패 | 같은 집계 테스트 | Global Run `completed`, warning 보존 |
| 10 | daemon 재시작 복구 | building Context Snapshot, committed Global graph, handoff receipt reopen/idempotency tests | 안전한 graph만 release; handoff 중복 적용 없음 |
| 11 | 전역 취소와 부분 integration 보존 | `global cancellation preserves already completed integration evidence`; cancellation fencing test | Global Run `cancelled`; 완료 artifact/evidence 유지 |
| 12 | 결과 탐색과 스레드 이동 | dashboard navigation, host provenance, no-origin-append MCP tests | Global/Project/Task 구조에서 실제 스레드 이동 |

## 공개 계약 version

- Global Run request API: v1 (`GLOBAL_RUN_API_VERSION`)
- authorization manifest: v1
- cross-project handoff schema: v1
- version 누락은 v1 호환으로 처리한다.
- 미지원 Global Run version은 graph, Agent, turn, worktree, attempt 생성 전에 거부한다.

## 릴리스 판정

다음 세 조건이 모두 성공해야 한다.

1. 모든 JS/MJS 정적 문법 검사
2. 전체 테스트 suite 통과
3. whitespace/error marker 검사인 `git diff --check` 통과

하나라도 실패하면 G7은 통과로 판정하지 않는다.
