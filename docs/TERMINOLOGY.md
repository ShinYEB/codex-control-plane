# 용어 표준

이 프로젝트는 Codex Desktop에서 보이는 영구 대화와 일시적인 실행 상태를 구분합니다. 사용자 화면과 문서는 아래 용어를 사용하고, App Server·SQLite 호환 필드는 기존 이름을 유지합니다.

| 표준 용어 | 의미 | 사용 예 | 사용하지 않는 표현 |
|---|---|---|---|
| Control Plane 스레드 | 여러 프로젝트의 요청을 접수하고 작업 탐색기를 여는 사용자의 Codex 대화 | “Control Plane에서 작업 목록 확인” | Control Plane 세션 |
| 에이전트 스레드 | 역할과 맥락이 부여되어 재사용·포크할 수 있는 영구 Codex 대화 | “기존 QA 스레드 재사용” | 에이전트 세션 |
| Orchestrator 스레드 | 복합 Run 하나의 조정과 종합을 기록하는 에이전트 스레드 | “Orchestrator 스레드 열기” | 조정 세션 |
| Data Plane 스레드 | Task를 실제로 수행하는 에이전트 스레드 | “작업 스레드 3개” | 작업 세션 |
| 실행 세션 | App Server가 특정 스레드를 점유해 턴을 처리하는 일시적인 런타임 상태 | “실행 세션 종료 후 스레드는 유지됨” | 영구 기록을 뜻하는 세션 |
| Run(실행) | 사용자가 Control Plane에 제출한 요청 한 건과 그 전체 수명주기 | “실행 완료” | 작업과 혼용 |
| Task(작업) | Run 내부 DAG의 실행 노드 한 개 | “선행 작업 완료” | Run과 혼용 |
| Turn(턴) | 한 스레드 안의 요청·응답 한 회 | “완료 턴” | 스레드와 혼용 |
| 에이전트 | 역할, capability, 권한 계약과 현재 배정 상태를 포함한 논리적 작업 주체 | “QA 에이전트” | 스레드 ID 자체와 동일시 |
| 데몬 스케줄러 | Run·Task·lease·재시도·결과 projection을 소유하는 로컬 프로세스 | “데몬이 작업을 배정” | Codex 에이전트 또는 스레드 |
| 실행 계약 | Task의 sandbox, network, workspace, side effect, 통합 방식을 결정하는 구조화된 권한 계약 | “실행 계약 preflight” | 역할 이름이나 prompt |
| Claim | 특정 데몬 worker가 Task 상태를 바꿀 수 있게 하는 `worker_id + claim_token` 소유권 | “claim을 회수함” | Agent lease와 혼용 |
| Agent lease | 한 Agent 스레드를 한 Task에 독점 배정하는 TTL 소유권 | “Agent lease 해제” | worktree lease와 혼용 |
| Artifact | managed worktree 변경을 보존하는 commit과 binary patch | “artifact를 다시 통합” | 이미 main에 적용된 변경과 동일시 |
| Origin | Run 요청이 시작되어 결과를 받아야 하는 Control Plane thread/turn identity | “origin 스레드로 전달” | 현재 열린 임의 대화 |
| Context Claim | 출처, scope, 최신성, 권위를 포함한 재사용 가능한 사실·결정·제약·결과 | “결정 claim이 이전 제약을 supersede함” | 출처 없는 요약 문자열 |
| Context Snapshot | 특정 목표의 planning에 사용하도록 선택·고정한 Context Claim 집합과 미해결 충돌 | “snapshot revision 2로 재계획” | 가변적인 현재 대화 전체 |
| Global Run | 여러 프로젝트를 포함할 수 있는 사용자 목표와 전역 조정의 수명주기 | “Global Run 아래 프로젝트 실행 2개” | 단일 프로젝트 Run과 혼용 |
| Project Run | 하나의 canonical project와 권한·workspace 경계를 소유하는 실행 | “프로젝트 실행 A가 통합 대기 중” | 여러 cwd를 가진 Run |
| Thread lineage | spawn, fork, compact, supersede로 이어지는 스레드의 계보 | “fork가 snapshot 3을 상속함” | 제목이 비슷한 스레드 묶음 |

## 내부 호환 이름

다음 식별자는 공개 API와 저장 데이터의 하위 호환성을 위해 이름을 바꾸지 않습니다.

- `threadId`, `originThreadId`: Codex 스레드 식별자
- `turnId`, `originTurnId`: Codex 턴 식별자
- `sessionId`: 기존 레지스트리 호환 별칭이며 새로운 사용자 문구에서는 사용하지 않음
- `codex_session`, `orchestratorSessionIdentity`, `resultSession`: 기존 DTO·영속 데이터 호환 이름
- `sessions` 탭 키: deep link와 클라이언트 상태 호환을 위해 유지하되 화면 라벨은 `스레드`

코드의 session 계열 호환 필드를 사용자에게 표시할 때는 항상 `스레드`로 번역합니다. `세션`은 실제 연결·점유·프로세스 수명처럼 일시적인 런타임을 가리킬 때만 사용합니다.
