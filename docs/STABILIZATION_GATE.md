# 안정화 릴리스 검증 게이트

이 문서는 1~8단계 계약 안정화의 최종 시나리오와 자동 검증 근거를 연결한다. 모든 항목은 plugin 실행 없이 로컬 Node test와 임시 SQLite/Git repository로 검증한다.

| # | 시나리오 | 주요 자동 검증 |
|---|---|---|
| 1 | 유효한 read-only 분석 | `execution authority follows explicit task intent`, `run_agent_task injects project context and records its result` |
| 2 | shared workspace 수정 | `an arbitrary unregistered implementation role executes with the explicit write contract` |
| 3 | managed worktree 수정과 통합 | `dirty project state is snapshotted and worker artifacts integrate back`, commit/parallel integration tests |
| 4 | 잘못된 계약의 실행 전 차단 | `invalid persisted contracts fail before claim without consuming an attempt`, preflight contradiction tests |
| 5 | 변조된 persisted contract 차단 | fingerprint integrity test와 pre/post-claim tamper tests |
| 6 | 같은 configuration failure 재시도 금지 | `configuration failures never repeat under the same execution contract`, 중앙 retry policy tests |
| 7 | repair 후 새 계약 실행 | `repair_task_contract preserves failure history and requeues with a new explicit contract` |
| 8 | daemon 재시작 후 active Task 복구 | restart reconciliation/requeue tests와 recorded integration journal Task finalization test |
| 9 | integration 단계별 강제 종료 복구 | applying/applied/recording forced-stop tests; patch 중복 적용 금지 검증 |
| 10 | terminal 결과의 durable projection과 작업 스레드 이동 | dashboard navigation, host provenance, no-origin-append tests |

추가 storage/runtime 게이트:

- 구 DB는 migration 전 snapshot을 만들고 transaction으로 현재 `user_version`으로 승격한다.
- `tasks.run_id` FK와 Task status CHECK를 reopen 후에도 검증한다.
- live proxy 탐지는 cwd, command, open file을 함께 본다.
- runtime deploy와 rollback 모두 daemon path/build/protocol health를 검증한다.

릴리스 판정은 전체 `node --test`, 모든 JS/MJS `node --check`, `git diff --check`가 동시에 성공해야 한다.
