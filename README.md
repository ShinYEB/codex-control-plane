# Codex Control Plane

Codex App Server의 thread를 재사용 가능한 에이전트로 다루는 로컬 컨트롤 플레인입니다. Codex 작업마다 생성되는 MCP 프로세스는 얇은 프록시이며, 실제 레지스트리·스케줄러·App Server·대시보드는 하나의 영속 CP 데몬이 소유합니다.

현재 범위:

- App Server JSONL/stdio 연결과 초기화
- 기존 thread 조회 및 공통 Agent 형태로 변환
- thread 생성, 재개, 포크
- turn 실행과 스트리밍 응답 수집
- 안전한 기본값: 일반 작업은 `read-only`, 쓰기 역할은 승인 브로커를 통한 `on-request`
- 외부 npm 패키지 없음
- Codex Desktop에서 사용할 수 있는 로컬 stdio MCP 프록시와 자동 시작 CP 데몬
- SQLite 기반 영구 Agent/Task/Run/Memory/Event Registry
- 프로젝트 결정·제약·아키텍처와 작업 결과를 보존하는 중앙 기억
- 실행 시점에 관련 기억을 선별하는 감사 가능한 context pack
- 일반 단일 작업의 `reuse/fork/spawn` 라우팅과 Run task별 새 영구 thread 1:1 바인딩
- 완료 결과를 프로젝트 기억과 에이전트 프로필로 자동 환류
- worker heartbeat와 재시작 후 중단 작업 복구
- 에이전트 세션의 원자적 lease와 `leased → running → validating → idle` 수명주기
- 누락된 종료 알림의 `thread/read` 기반 상태 복구
- dependency DAG 기반 순차·병렬 작업 스케줄링
- 원자적 claim token과 fencing으로 stale worker 완료 거부
- 제한된 지수 백오프 재시도
- 독점 worktree lease와 만료 lease 격리
- Start 이후 데몬이 만든 `[🤖 역할] 작업명` 형식의 영구 thread 이름과 Desktop 노출용 pin 시도
- 로컬 HTTP/SSE 실시간 대시보드
- `accepted → planning → preparing → running → completed/failed/cancelled` 비동기 실행 상태 머신
- 대시보드의 명시적인 시작·취소 제어
- 상위·하위 작업 디렉터리를 한 프로젝트 범위로 조회
- 데몬 소유 Planner 세션의 계획 생성·수정과 실행 후 Synthesizer 결과 종합
- 단일 SQLite transaction의 Run + Task DAG 생성, cycle 검증, request key 멱등성
- `git worktree add/remove` 수명주기와 dirty 보존·실패 격리
- App Server 명령·파일 변경 승인을 `approval_waiting`으로 중계하고 대시보드에서 재개
- 역할별 system prompt, capability, tool, model, sandbox, approval policy 템플릿
- Control Plane과 실행 통제를 분리한 `RunController` 기반 Orchestration Plane
- 담당 에이전트·의존 순서·worktree·승인·결과를 함께 표시하는 실시간 Run DAG
- 작업 에이전트와 분리된 read-only Validator의 완료 기준 검증 및 후행 작업 차단

## Codex Desktop에서 사용

개인 플러그인 `codex-agent-control-plane`으로 설치되어 있습니다. 플러그인 소스는 `/Users/sin-yebin/plugins/codex-agent-control-plane`이며 개인 마켓플레이스에서 관리됩니다.

1. Codex Desktop에서 이 프로젝트의 새 작업을 엽니다.
2. 처음 설치하거나 플러그인을 갱신한 뒤에는 Codex Desktop에서 새 작업을 엽니다.
3. 플러그인 화면에서 `Codex Agent Control Plane`이 활성화되어 있는지 확인하고, 작성창에서 `/mcp`를 입력해 `codex_control_plane` 연결을 확인합니다.
4. 자연어로 에이전트 관리 작업을 요청합니다.

예시:

```text
현재 프로젝트에서 재사용 가능한 Codex 에이전트를 보여줘.
```

```text
"에이전트 컨트롤 플레인 계획" 세션을 포크하고,
읽기 전용으로 현재 구현의 빠진 부분을 검토시켜줘.
```

```text
새 에이전트를 만들어 codex-control-plane 테스트를 검토하게 해줘.
```

### Desktop 사이드바와 실시간 상황판

일반적인 여러 에이전트 작업은 `dispatch_control_request`로 접수합니다. 이 도구는 즉시 Run ID를 반환하고 다음 절차를 데몬 백그라운드에서 수행합니다.

1. `accepted` 상태의 Run을 영구 Registry에 기록하고 Control Plane을 즉시 해제합니다.
2. Planner가 작업 규모와 direct/orchestrated 경로를 산정합니다.
3. Codex thread를 만들지 않은 채 작업 DAG만 원자적으로 materialize하고 `awaiting_user_start`에서 대기합니다.
4. 사용자가 명시적으로 Start하면 데몬이 runnable task마다 새 영구 thread를 하나 만들고 task와 1:1로 바인딩한 뒤 실제 turn을 시작합니다.
5. 여러 Run은 `Control Plane 작업함`에서 전환할 수 있습니다.

대시보드를 열거나 새로 고치는 동작은 실행을 시작하지 않습니다. `autoStart` 입력은 호환 목적으로만 수용되고 무시되며, 모든 신규 Run은 `start_agent_run` 또는 대시보드의 사용자 Start 동작이 필요합니다.

준비 단계에는 `READY` turn이나 Desktop placeholder task가 생기지 않습니다. Codex 빌드가 `thread/metadata/update.isPinned`를 지원하면 Start 이후 실제 실행 thread를 pin합니다. 현재 빌드가 이 필드를 지원하지 않아도 이름 지정과 실행은 정상 동작하며 pin만 건너뜁니다.

요청 예시:

```text
Backend 구현, 테스트, 리뷰 에이전트를 먼저 준비하고 사이드바에 보이도록 이름을 붙여줘.
실시간 대시보드를 연 다음에만 작업을 시작해줘.
```

반환된 `dashboardUrl`을 열면 SSE 연결이 생성됩니다. 준비된 에이전트와 작업을 확인한 후 `작업 시작` 또는 `취소`를 선택할 수 있습니다. URL에는 임의 접근을 막는 세션 토큰이 포함되며 서버는 `127.0.0.1`에서만 수신합니다.

대시보드의 기본 화면은 세션 목록이 아니라 선택된 Run의 실행 그래프입니다. 각 노드는 작업명, 담당 DP 에이전트, 역할, 현재 상태, shared/worktree 작업 공간, 브랜치, 승인 대기와 실행 결과를 표시하며 dependency edge가 실제 실행 순서를 나타냅니다. 노드를 선택하면 prompt, acceptance criteria, routing, workspace, approval, output, validation과 error를 검사할 수 있습니다. 기존 세션 현황은 `Agent Fleet` 탭으로 분리되어 있습니다.

기본 화면은 `Control Plane 작업함 → 선택한 Run → Control/Orchestrator/Data 실행 구조 → 작업 DAG → 검증 결과` 순서로 읽도록 구성됩니다. 접수·계획·세션 준비 단계도 작업 노드가 생기기 전부터 실시간으로 표시됩니다. 상태 코드는 한글 의미로 표시되고, 자주 쓰는 `실행 현황·에이전트·승인 요청`만 기본 탐색에 노출합니다. 작업·계획·Worktree·역할·맥락·이벤트는 `고급 관리`에 모읍니다.

### 3계층 실행 구조

```text
Control Plane
  Planner · Memory · Role/Policy Registry · Validator · Synthesizer
        ↓ immutable plan
Orchestration Plane
  RunController · DAG scheduling · routing · worktree · approval · retry/recovery
        ↓ assigned task
Data Plane
  Backend · Frontend · QA · Reviewer 등 실제 Codex agent
```

`RunController`는 Run 시작·취소, dependency 해제, 다음 실행 노드 선택과 claim, 종료 후 상태 갱신, dashboard graph snapshot 생성을 담당합니다. MCP 서버는 이 계층을 호출하고 Codex App Server turn을 실행하는 adapter 역할을 합니다. `get_run_graph`로 같은 그래프 모델을 직접 조회할 수 있습니다.

선행 Data Plane 작업이 완료되면 그 결과는 후행 작업 prompt에 `A2A HANDOFF`로 명시적으로 전달됩니다. 따라서 작업 간 의존성은 단순 실행 순서뿐 아니라 에이전트 간 결과 전달 경로이기도 합니다.

### 완료 판정과 검증 게이트

작업에 `acceptanceCriteria`가 있으면 작업 에이전트의 turn 종료만으로 `completed`가 되지 않습니다. 상태는 `running → agent_done → validating`으로 진행되고, 프로젝트별 영구 `[Validator]` 세션이 read-only 정책으로 결과와 실제 작업 공간을 검사합니다. 모든 기준을 통과하면 `completed`, 작업 결과는 있으나 검증 인프라 자체가 실패하면 `completed_with_warnings`가 되며 두 상태 모두 후행 노드를 해제합니다. 기준 미충족은 `rejected`가 되어 후행 작업을 차단합니다. 검증 요약, 증거, 미충족 기준은 그래프 노드의 상세 패널에 남습니다.

App Server turn의 `completed`, `failed`, `interrupted`는 registry task에 같은 의미로 기록됩니다. dependency의 성공 상태는 `completed`와 `completed_with_warnings`이고, 명시적인 차단 상태는 `failed`와 `rejected`입니다. 모든 Run task가 terminal이면 Run도 즉시 `completed`, `failed`, `cancelled` 중 하나로 집계됩니다.

`acceptanceCriteria`가 없는 기존 단일 작업은 호환성을 위해 작업 에이전트 종료 시 바로 `completed`가 됩니다. 엄격한 완료 판정이 필요한 실행 계획에는 각 작업의 기준을 명시해야 합니다.

### 대화 안에서 상황판 열기

```text
Codex 에이전트 상황판을 UI로 보여줘.
```

`show_agent_dashboard`는 기본적으로 현재 Codex 대화 안에 MCP Apps 인터랙티브 상황판을 렌더링합니다. 별도 브라우저 탭은 자동으로 열지 않습니다. 호스트가 UI 리소스를 렌더링하지 못하거나 사용자가 별도 웹 페이지를 명시적으로 요청한 경우에만 `presentation: "web"`으로 호출해 `dashboardUrl`을 보조 경로로 사용합니다.

대시보드 UI output template은 `show_agent_dashboard`에만 연결됩니다. Worker/Data Plane과 Orchestrator Plane 세션에는 대시보드를 렌더링하지 않으며, 내부 갱신과 상세 조회는 Control Plane이 발급한 만료형 view lease가 있어야 합니다. 목록은 revision 기반 경량 DTO로 전달되고 prompt, output, validation 같은 큰 필드는 항목을 선택할 때만 on-demand로 읽습니다. 로컬 웹 SSE도 전체 snapshot을 반복 전송하지 않고 revision delta를 전송합니다.

`initialize`는 Codex 세션 전체를 동기화하지 않고, `list_agents`는 SQLite registry만 읽습니다. App Server reconciliation은 프로젝트 경로별로 최대 5분에 한 번 수행하며 같은 프로젝트의 동시 요청은 하나의 single-flight로 합쳐집니다.

긴 작업은 다음처럼 요청하면 상황판에서 진행 상태를 확인할 수 있습니다.

```text
새 백그라운드 에이전트에게 이 프로젝트의 테스트 구조 분석을 맡기고 상황판을 보여줘.
```

이 경우 `dispatch_agent_task`가 즉시 작업 ID를 반환하고 실제 작업은 백그라운드에서 계속됩니다.

핵심 MCP 도구는 `plan_agent_run`, `revise_agent_plan`, `prepare_agent_run`, `start_agent_run`, `synthesize_run`, `list_approvals`, `resolve_approval`, `list_managed_worktrees`, `cleanup_worktree`, `list_role_templates`, `upsert_role_template`, `get_desktop_handoff`, 기존 agent/task/run/memory 도구와 `show_agent_dashboard`입니다. `mark_dashboard_ready`는 이전 버전 호환용 `start_agent_run` 별칭입니다. 기존 thread ID로 작업할 때 명시적으로 `reuseExisting=true`를 전달하지 않는 한 원본 세션 대신 포크에서 실행합니다. 이미 임대된 세션의 직접 재사용을 요청하면 동일 세션에 두 writer를 붙이지 않고 안전한 포크로 전환합니다. 대시보드의 채팅 링크도 작업이 종료된 뒤에만 활성화됩니다.

### 중앙 Planner와 원자적 실행 그래프

`plan_agent_run`은 데몬이 유지하는 `[CP·Planner]` Codex 세션에 목표와 중앙 context pack을 전달합니다. Planner는 JSON task DAG만 만들며 구현하지 않습니다. 결과는 영구 Plan으로 저장되고, Run과 전체 Task DAG가 세션 생성 없이 하나의 SQLite transaction으로 생성됩니다. 잘못된 dependency나 cycle이면 어떤 Run/Task도 남지 않습니다. `requestKey`를 주면 같은 요청의 재전송도 기존 결과로 귀결됩니다.

`revise_agent_plan`은 동일 Planner 맥락에서 버전을 올립니다. Run이 종료되면 `[CP·Synthesizer]`가 목표·계획·전체 결과를 비교해 요약과 위험을 Plan에 저장합니다. 제안된 후속 작업은 사용자 확인 없이 자동 실행하지 않습니다.

### 실제 worktree와 승인 브로커

파일을 수정하는 병렬 작업에는 `workspaceMode=worktree`를 지정합니다. 컨트롤 플레인은 `~/.codex/control-plane/worktrees` 아래에 통제된 경로와 `codex/<task-id>` 브랜치를 만들고 해당 경로에서 turn을 실행합니다. 완료 후 깨끗한 worktree만 제거하며, 변경이 남아 있으면 `retained`, 검사·정리가 실패하면 `quarantined`로 보존합니다. branch를 강제 삭제하지 않습니다.

`approvalPolicy=on-request`인 역할이 명령 실행이나 파일 변경 승인을 요청하면 App Server 응답을 보류하고 작업을 `approval_waiting`으로 전환합니다. 대시보드의 승인 탭이나 `resolve_approval`로 승인/거절하면 같은 turn이 재개됩니다. 15분 동안 응답이 없거나 데몬이 종료되면 안전하게 거절됩니다.

### 역할 전문화와 Desktop 한계

내장 역할은 `planner`, `control-plane-architect`, `implementer`, `reviewer`, `qa`, `synthesizer`이며 각 역할에 개발자 지침, capability, 도구, 모델, sandbox, 승인 정책을 함께 저장합니다. `upsert_role_template`로 프로젝트 역할을 추가할 수 있습니다.

Desktop 사이드바의 폴더/계층/grouping은 Codex 호스트 소유라 MCP나 App Server가 직접 변경할 수 없습니다. 대신 작업 thread를 `[역할] 작업명`으로 이름 붙이고 pin을 시도하며, `get_desktop_handoff`가 native thread ID를 반환합니다. Codex Desktop 호스트는 이 ID를 이용해 해당 작업으로 직접 이동할 수 있지만, 외부 브라우저 대시보드 자체가 사이드바를 제어하지는 못합니다.

### 중앙 기억과 context pack

`upsert_project_memory`로 사람이 확인한 제약, 결정, 아키텍처, 사실과 참고 메모를 저장할 수 있습니다. 작업을 실행할 때는 현재 prompt, 역할, capability, 필요 도구, 브랜치를 기준으로 관련 기억을 점수화하여 context pack을 만듭니다.

- `constraint`, `decision`, `architecture`이면서 사용자 또는 컨트롤 플레인 출처인 항목은 authoritative context로 전달합니다.
- 과거 에이전트 결과는 reference data로 표시하여 지시문으로 취급하지 않습니다.
- 선택된 기억, 점수와 선택 이유는 task metadata와 `get_project_context` 결과에서 감사할 수 있습니다.
- DAG의 선행 작업이 끝나면 결과가 `task_result` 기억으로 저장되므로 후행 작업의 context pack에 즉시 반영됩니다.
- 에이전트를 포크하면 source agent의 역할, capability, 요약, 도구와 브랜치 프로필을 상속합니다.

### 작업 의존성, 재시도, lease

`dispatch_agent_task`에 다음 실행 정책을 함께 지정할 수 있습니다.

- `dependsOn`: 먼저 완료되어야 하는 task ID 목록
- `maxAttempts`: 최대 실행 횟수. 안전한 기본값은 1
- `retryDelayMs`: 재시도 기본 대기 시간. 시도마다 지수 증가
- `leaseKey`: 동시에 한 작업만 소유할 수 있는 workspace key
- `worktreePath`, `leaseTtlMs`: lease 대상과 heartbeat 만료 시간

dependency가 끝나기 전에는 작업이 `blocked`, lease가 사용 중이면 `waiting_for_lease`, 재시도 대기 중에는 `retry_waiting`으로 유지됩니다. 단일 CP 데몬과 SQLite 조건부 `UPDATE ... RETURNING`, claim token을 함께 사용하므로 같은 작업의 중복 실행을 방지하며, 회수된 이전 worker의 늦은 완료도 거부합니다. 만료된 worktree lease는 자동 재할당하지 않고 `expired` 상태로 격리합니다.

대시보드 HTTP 서버도 SQLite owner lease로 단일 데몬만 소유합니다. Desktop 네이티브 프로젝트 thread가 별도 App Server의 active writer로 남아 있으면 `idle` 표시에 의존해 소유권을 빼앗지 않습니다. 같은 thread의 동시 resume은 single-flight로 합치고 active-writer 오류만 제한적으로 재시도한 뒤 `THREAD_ACTIVE_WRITER`로 반환합니다.

`npm test`에는 10개 Run × 5개 작업의 snapshot/delta 예산과 10,000회 반복 조회의 heap 상한 회귀 검사가 포함됩니다.

### 자동 라우팅

에이전트 역할과 역량을 한 번 등록하면 이후 요청에서 재사용할 맥락을 자동으로 선택합니다.

```text
이 세션을 backend-reviewer 역할로 등록하고 api, database, security 역량을 부여해줘.
```

`run_agent_task`와 `dispatch_agent_task`는 `threadId`가 없을 때 기본적으로 다음 항목을 점수화합니다.

- 동일한 작업 경로
- 역할 일치
- 필요한 역량 일치
- 에이전트 이름과 요약의 작업 키워드
- 중앙 context pack과의 키워드 중첩
- 필요한 도구, provider와 model
- 브랜치 일치와 context 최신성
- 현재 사용 가능 여부

결과에는 후보별 `scoreBreakdown`, 선택 이유, blocker와 confidence가 포함됩니다. 요청에 명시된 capability와 tool은 점수 가산점이 아니라 필수 조건입니다. 하나라도 빠진 기존 에이전트는 후보 설명에는 남지만 선택되지 않으며 새 세션을 생성합니다. 조건을 모두 만족하고 기준 점수를 넘는 에이전트가 있으면 기본 결정은 `fork`, `reuseExisting=true`일 때만 `reuse`입니다. 항상 새 에이전트가 필요하면 `routingMode=new`를 사용합니다.

Registry는 기본적으로 `~/.codex/control-plane/v2/registry.sqlite`에 저장됩니다. 처음 시작할 때 이전 `registry.sqlite`가 있으면 SQLite의 일관된 스냅샷으로 한 번 이관합니다. 이 버전 경계는 아직 열려 있는 구버전 MCP 프로세스와 새 데몬이 같은 작업을 동시에 선점하지 못하게 합니다. `CODEX_CONTROL_DB` 환경 변수로 다른 경로를 지정할 수 있습니다.

CP 데몬은 첫 MCP 요청에서 자동으로 시작되며 기본 Unix 소켓은 `~/.codex/control-plane/control-plane.sock`입니다. `CODEX_CONTROL_SOCKET`으로 변경할 수 있습니다. 따라서 특정 Codex 작업을 닫아도 다른 작업이 동일한 레지스트리, 스케줄러와 대시보드를 사용합니다.

데몬이 Codex App Server를 시작할 때 현재 데몬의 Node 실행 파일 디렉터리를 Data Plane `PATH` 맨 앞에 넣고 `CODEX_DATA_PLANE_NODE`로 절대 경로를 전달합니다. npm이 런타임에 포함되지 않은 환경에서는 에이전트가 실행하지 않은 `npm test`를 성공으로 추정하지 않고, 안내된 Node 절대 경로로 `node --test` 같은 실제 명령을 수행합니다.

스케줄러는 heartbeat가 끊긴 active task를 주기적으로 `thread/read`와 대조합니다. 이미 끝난 turn이면 registry를 완료 상태로 복구하고, 결과를 확정할 수 없으면 자동 재실행 대신 `recovery_attention`으로 격리합니다. 데몬 종료 시에는 진행 중 작업을 먼저 drain하고 제한 시간이 지나면 turn을 interrupt한 뒤 claim을 복구하므로 `running` 상태가 무기한 남지 않습니다. 실패에는 `infrastructure`, `coordination`, `timeout`, `approval`, `workspace`, `routing`, `validation`, `worker` 분류가 metadata에 기록됩니다.

## 실행

Node.js 20 이상과 로그인된 Codex CLI가 필요합니다.

```bash
cd /Users/sin-yebin/Desktop/project/codex-control-plane
node src/cli.js list --cwd /Users/sin-yebin/Desktop/project
node src/cli.js start --cwd /Users/sin-yebin/Desktop/project
node src/cli.js start --cwd /Users/sin-yebin/Desktop/project --ephemeral
node src/cli.js ask --cwd /Users/sin-yebin/Desktop/project --prompt "이 디렉터리의 구조를 짧게 설명해줘"
```

기존 thread 재사용과 포크:

```bash
node src/cli.js resume THREAD_ID
node src/cli.js run THREAD_ID --prompt "앞선 분석을 이어서 테스트 전략을 제안해줘"
node src/cli.js fork THREAD_ID
```

쓰기 작업은 명시적으로 활성화합니다.

```bash
node src/cli.js ask \
  --cwd /absolute/path/to/git/repository \
  --sandbox workspace-write \
  --prompt "실패하는 테스트를 고치고 다시 실행해줘"
```

## 안전 모델

일반 작업의 기본 정책은 `read-only`/`never`입니다. 역할 템플릿이 `workspace-write`/`on-request`를 요구할 때만 승인 브로커가 개입합니다. 승인을 기다리는 요청은 영구 Registry와 감사 이벤트에 남고, 데몬 재시작 시 열린 요청은 거절 처리합니다. `danger-full-access`는 직접 명시한 경우에만 사용할 수 있습니다.

남은 주요 확장 범위는 retry 가능 오류 분류, Claude Code provider adapter, 그리고 Codex Desktop이 향후 공식 sidebar grouping/navigation API를 제공할 경우의 네이티브 adapter입니다.

## 참고

- [Codex App Server 공식 문서](https://learn.chatgpt.com/docs/app-server)
