# Codex Control Plane

Codex App Server의 스레드(thread)를 재사용 가능한 에이전트로 다루는 로컬 Control Plane입니다. Codex 작업마다 생성되는 MCP 프로세스는 얇은 프록시이며, 실제 레지스트리·스케줄러·App Server·대시보드는 하나의 영속 Control Plane 데몬이 소유합니다. 프로젝트의 표준 용어는 [용어 표준](./docs/TERMINOLOGY.md)을 따릅니다.

현재 구현의 설계 기준선은 [설계 문서 인덱스](./docs/README.md)에 정리되어 있습니다. 전체 구조, 상태 머신, 실행 계약, 영속성, 결과 전달, 장애 복구, 런타임 수명주기를 주제별 문서로 나누며 아직 결정되지 않은 항목은 [설계 점검 체크리스트](./docs/REVIEW_CHECKLIST.md)에 별도로 기록합니다.

현재 범위:

- App Server JSONL/stdio 연결과 초기화
- 기존 스레드 조회 및 공통 Agent 형태로 변환
- 스레드 생성, 재개, 포크
- turn 실행과 스트리밍 응답 수집
- 안전한 기본값: 분석은 `read-only`, 프로젝트 수정은 Run의 단일 권한 경계 안에서 `workspace-write + approvalPolicy=never`
- 외부 npm 패키지 없음
- Codex Desktop에서 사용할 수 있는 로컬 stdio MCP 프록시와 자동 시작 CP 데몬
- SQLite 기반 영구 Agent/Task/Run/Memory/Event Registry
- 원래 Control Plane 스레드로 완료 결과를 반환하는 영속 delivery inbox와 중복 방지 receipt
- 프로젝트 결정·제약·아키텍처와 작업 결과를 보존하는 중앙 기억
- 실행 시점에 관련 기억을 선별하는 감사 가능한 context pack
- 일반 단일 작업의 `reuse/fork/spawn` 라우팅과 Run task별 영구 스레드 1:1 바인딩
- 완료 결과를 프로젝트 기억과 에이전트 프로필로 자동 환류
- worker heartbeat와 재시작 후 중단 작업 복구
- 에이전트 스레드의 원자적 lease와 `leased → running → validating → idle` 수명주기
- 누락된 종료 알림의 `thread/read` 기반 상태 복구
- dependency DAG 기반 순차·병렬 작업 스케줄링
- 원자적 claim token과 fencing으로 stale worker 완료 거부
- 제한된 지수 백오프 재시도
- 독점 worktree lease와 만료 lease 격리
- Start 이후 데몬이 만든 `[🤖 역할] 작업명` 형식의 영구 스레드 이름과 Desktop 노출용 pin 시도
- 로컬 HTTP/SSE 실시간 대시보드
- `accepted → planning → preparing → running → completed/failed/cancelled` 비동기 실행 상태 머신
- 대시보드와 무관하게 자동 시작하며 필요할 때만 여는 상세·취소 UI
- 상위·하위 작업 디렉터리를 한 프로젝트 범위로 조회
- 데몬 소유 Planner 스레드의 계획 생성·수정과 실행 후 Synthesizer 결과 종합
- 단일 SQLite transaction의 Run + Task DAG 생성, cycle 검증, request key 멱등성
- `git worktree add/remove` 수명주기와 dirty 보존·실패 격리
- 부모 Run의 단일 권한 경계와 작업별 실행 계약으로 중복 승인 요청 제거
- 역할별 system prompt, capability, tool, model 템플릿과 별도의 sandbox 실행 계약
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
"에이전트 컨트롤 플레인 계획" 스레드를 포크하고,
읽기 전용으로 현재 구현의 빠진 부분을 검토시켜줘.
```

```text
새 에이전트를 만들어 codex-control-plane 테스트를 검토하게 해줘.
```

### 채팅 우선 실행과 선택형 상황판

일반적인 여러 에이전트 작업은 `dispatch_control_request`로 접수합니다. 이 도구는 즉시 Run ID를 반환하고 다음 절차를 데몬 백그라운드에서 수행합니다.

1. `accepted` 상태의 Run을 영구 Registry에 기록하고 Control Plane을 즉시 해제합니다.
2. Planner가 작업 규모와 direct/orchestrated 경로를 산정합니다.
3. Codex 스레드를 만들지 않은 채 작업 DAG를 원자적으로 materialize한 뒤 자동으로 실행을 시작합니다.
4. 그래프 준비가 끝나면 데몬이 runnable task마다 영구 스레드를 하나 만들고 task와 1:1로 바인딩한 뒤 실제 turn을 자동 시작합니다.
5. 완료 결과를 종합해 요청이 시작된 Control Plane 스레드로 반환합니다. Desktop이 해당 스레드를 사용 중이면 영속 delivery inbox에 보관하고 다음 Control Plane turn에서 회수합니다.

대시보드를 열거나 새로 고치는 동작이 실행을 시작하는 것은 아닙니다. 신규 Control Plane 요청은 그래프 준비 완료 이벤트가 항상 자동 실행을 시작하며, 별도의 수동 Start 모드는 없습니다.

준비 단계에는 `READY` turn이나 Desktop placeholder task가 생기지 않습니다. Codex 빌드가 `thread/metadata/update.isPinned`를 지원하면 Start 이후 실제 실행 스레드를 pin합니다. 현재 빌드가 이 필드를 지원하지 않아도 이름 지정과 실행은 정상 동작하며 pin만 건너뜁니다.

`dispatch_control_request`는 대시보드를 자동으로 열지 않습니다. 사용자는 기본적으로 Control Plane 채팅에서 접수와 최종 결과만 확인합니다. 실행 흐름, 작업 스레드, 의존 그래프나 진단 정보가 궁금할 때만 `show_agent_dashboard`를 호출합니다. 별도 웹 화면은 내장 UI를 사용할 수 없을 때의 후순위 fallback입니다.

대시보드 기본 화면에는 현재 Run 하나의 작업명, 상태, 지금 하는 일과 결과 요약만 표시합니다. 이전 작업함은 접힌 서랍에 두고, 실행 상세는 `결과 / 진행 / 스레드 / 그래프` 네 탭으로 분리합니다. 실행 계약, 내부 이벤트와 원시 상태는 별도의 `고급 진단` 화면에서만 표시합니다.

사용자 알림은 `완료`, `실패`, `판단 필요`, `정책 중단` 네 유형만 저장·전달합니다. 정상 진행 상태는 알림을 만들지 않습니다. 판단이 필요한 복구 상태는 완료를 기다리지 않고 원래 Control Plane 스레드의 영속 전달 큐로 보내며, 권한·정책 차단은 일반 실패와 구분해 전달합니다.

결과 전달은 `originThreadId + originTurnId + Run ID` 계약으로 추적합니다. 데몬은 직접 전달을 먼저 시도하고 active-writer 충돌 시 제한된 백오프로 재시도합니다. 직접 전달이 불가능해도 다음 요청에서 `drain_control_results`가 같은 Control Plane 스레드의 미전달 결과를 한 번만 반환합니다.

### 3계층 실행 구조

```text
Control Plane
  Planner · Memory · Role/Policy Registry · Validator · Synthesizer
        ↓ immutable plan
Orchestration Plane
  RunController · DAG scheduling · routing · execution contract · worktree integration · retry/recovery
        ↓ assigned task
Data Plane
  Backend · Frontend · QA · Reviewer 등 실제 Codex agent
```

`RunController`는 Run 시작·취소, dependency 해제, 다음 실행 노드 선택과 claim, 종료 후 상태 갱신, dashboard graph snapshot 생성을 담당합니다. MCP 서버는 이 계층을 호출하고 Codex App Server turn을 실행하는 adapter 역할을 합니다. `get_run_graph`로 같은 그래프 모델을 직접 조회할 수 있습니다.

선행 Data Plane 작업이 완료되면 그 결과는 후행 작업 prompt에 `A2A HANDOFF`로 명시적으로 전달됩니다. 따라서 작업 간 의존성은 단순 실행 순서뿐 아니라 에이전트 간 결과 전달 경로이기도 합니다.

### 완료 판정과 검증 게이트

작업에 `acceptanceCriteria`가 있으면 작업 에이전트의 turn 종료만으로 `completed`가 되지 않습니다. 상태는 `running → agent_done → validating`으로 진행되고, 프로젝트별 영구 `[Validator]` 스레드가 read-only 정책으로 결과와 실제 작업 공간을 검사합니다. 모든 기준을 통과하면 `completed`, 명시적 경고와 함께 수락하면 `completed_with_warnings`가 되며 두 상태 모두 후행 노드를 해제합니다. 기준 미충족은 시도 예산 안에서 새 feedback을 포함해 재작업하고, 끝내 충족하지 못하면 `rejected`가 되어 후행 작업을 차단합니다. Validator 실행 자체가 실패하면 성공으로 간주하지 않고 `validation_failed` 또는 재시도 가능한 환경 실패로 기록합니다.

App Server turn의 `completed`, `failed`, `interrupted`는 registry task에 같은 의미로 기록됩니다. dependency의 성공 상태는 `completed`와 `completed_with_warnings`이고, 명시적인 차단 상태는 `failed`와 `rejected`입니다. 모든 Run task가 terminal이면 Run도 즉시 `completed`, `failed`, `cancelled` 중 하나로 집계됩니다.

`acceptanceCriteria`가 없는 기존 단일 작업은 호환성을 위해 작업 에이전트 종료 시 바로 `completed`가 됩니다. 엄격한 완료 판정이 필요한 실행 계획에는 각 작업의 기준을 명시해야 합니다.

### 대화 안에서 상황판 열기

```text
Codex 에이전트 상황판을 UI로 보여줘.
```

`show_agent_dashboard`는 기본적으로 현재 Codex 대화 안에 MCP Apps 인터랙티브 상황판을 렌더링합니다. 별도 브라우저 탭은 자동으로 열지 않습니다. 호스트가 UI 리소스를 렌더링하지 못하거나 사용자가 별도 웹 페이지를 명시적으로 요청한 경우에만 `presentation: "web"`으로 호출해 `dashboardUrl`을 보조 경로로 사용합니다.

대시보드 UI output template은 `show_agent_dashboard`에만 연결됩니다. Worker/Data Plane과 Orchestrator Plane 스레드에는 대시보드를 렌더링하지 않으며, 내부 갱신과 상세 조회는 Control Plane이 발급한 만료형 view lease가 있어야 합니다. 목록은 revision 기반 경량 DTO로 전달되고 prompt, output, validation 같은 큰 필드는 항목을 선택할 때만 on-demand로 읽습니다. 로컬 웹 SSE도 전체 snapshot을 반복 전송하지 않고 revision delta를 전송합니다.

`initialize`는 Codex 스레드 전체를 동기화하지 않고, `list_agents`는 SQLite registry만 읽습니다. App Server reconciliation은 프로젝트 경로별로 최대 5분에 한 번 수행하며 같은 프로젝트의 동시 요청은 하나의 single-flight로 합쳐집니다.

긴 작업은 다음처럼 요청하면 상황판에서 진행 상태를 확인할 수 있습니다.

```text
새 백그라운드 에이전트에게 이 프로젝트의 테스트 구조 분석을 맡기고 상황판을 보여줘.
```

이 경우 `dispatch_agent_task`가 즉시 작업 ID를 반환하고 실제 작업은 백그라운드에서 계속됩니다.

핵심 MCP 도구는 `dispatch_control_request`, `plan_agent_run`, `revise_agent_plan`, `prepare_agent_run`, `synthesize_run`, `list_managed_worktrees`, `recover_managed_worktree`, `cleanup_worktree`, `list_role_templates`, `upsert_role_template`, `get_desktop_handoff`, 기존 agent/task/run/memory 도구와 `show_agent_dashboard`입니다. 원자적 그래프 생성 직후 실행은 자동으로 시작됩니다. 작업은 프로젝트·역할·capability뿐 아니라 sandbox·workspace·branch 실행 계약이 맞는 기존 에이전트 스레드를 임대해 재사용하고, 안전한 후보가 없을 때만 새 스레드를 만듭니다. 이미 임대된 스레드에는 두 writer를 붙이지 않고 안전한 포크로 전환합니다. 대시보드의 `Codex에서 스레드 찾기`는 MCP Apps 메시지 브리지를 통해 현재 Control Plane 대화에 이동 요청을 보내므로 실행 중 스레드도 읽기용으로 찾을 수 있습니다.

### 중앙 Planner와 원자적 실행 그래프

`plan_agent_run`은 데몬이 유지하는 `[CP·Planner]` Codex 스레드에 목표와 중앙 context pack을 전달합니다. Planner는 JSON task DAG만 만들며 구현하지 않습니다. 결과는 영구 Plan으로 저장되고, Run과 전체 Task DAG가 스레드 생성 없이 하나의 SQLite transaction으로 생성됩니다. 잘못된 dependency나 cycle이면 어떤 Run/Task도 남지 않습니다. `requestKey`를 주면 같은 요청의 재전송도 기존 결과로 귀결됩니다.

`revise_agent_plan`은 동일 Planner 맥락에서 버전을 올립니다. Run이 종료되면 `[CP·Synthesizer]`가 목표·계획·전체 결과를 비교해 요약과 위험을 Plan에 저장합니다. 제안된 후속 작업은 사용자 확인 없이 자동 실행하지 않습니다.

### 실행 계약과 실제 worktree

Planner의 역할 이름은 전문성을 설명할 뿐 권한을 부여하지 않습니다. 각 Task는 `taskKind`, `mutatesWorkspace`, `requiredSandbox`, `networkAccess`, `authorizationScope`, `sideEffectPolicy`, `workspaceMode`, `outputs`, `integrationStrategy`를 가진 실행 계약으로 컴파일됩니다. `sideEffectPolicy`는 관측 전용 `none`, 제품 내부 데몬·프로세스 수명주기 `local-runtime`, 프로젝트 파일 변경 `workspace`, 원격·외부 시스템 변경 `external`, 복구하기 어려운 변경 `destructive`로 구분합니다. Planner 단계에서 모든 계약을 미리 컴파일하고 잘못된 계획은 자동으로 다시 작성합니다. 수정 작업은 역할 이름과 관계없이 `workspace-write`가 필요하고, 모순된 계약이나 외부·파괴적 부작용은 스레드를 만들기 전에 거부됩니다. 일반 Run의 프로젝트 내부 변경은 부모 Run에서 한 번 승인된 범위 안에서 `approvalPolicy=never`로 실행되므로 작업별 승인 UI를 사용하지 않습니다.

재설치 전에는 `npm run reinstall:preflight -- --plugin codex-agent-control-plane --marketplace personal`로 dry-run 점검을 수행합니다. 활성 Task, drain 중인 데몬, 설치 캐시를 사용 중인 MCP 프록시가 있으면 재설치를 차단합니다. Codex를 완전히 종료하고 blocker가 0인 상태에서만 같은 명령에 `--execute`를 추가합니다. 실행 모드는 정확한 `codex-agent-control-plane@personal`만 Codex CLI로 제거·재설치하며 `~/.codex/control-plane/v2/registry.sqlite`와 managed worktree는 보존합니다. 기존 대화는 새 플러그인 generation을 hot reload하지 않으므로 재설치 후 반드시 새 대화를 엽니다.

파일을 수정하는 병렬 작업에는 `workspaceMode=worktree`를 지정합니다. 컨트롤 플레인은 메인 작업공간이 dirty하면 index를 건드리지 않는 임시 Git index로 현재 추적·미추적 상태의 합성 기준 commit을 만든 뒤 `~/.codex/control-plane/worktrees` 아래에 `codex/<task-id>` 브랜치를 만듭니다. 성공한 변경은 commit/patch 산출물로 확정하고 메인 작업공간에 적용 검사를 통과한 뒤 통합합니다. 충돌하면 변경을 삭제하지 않고 `integration_blocked`로 보존하며, 통합되지 않은 Task는 완료로 간주하지 않습니다.

`recover_managed_worktree`의 `inspect`, `finalize`, `integrate`, `cleanup`, `quarantine` 동작으로 보존된 변경을 검사하고 다시 통합할 수 있습니다. 공유 작업공간의 수정 작업은 프로젝트별 단일 writer lease를 사용하며, worktree 통합도 저장소별 직렬 큐를 사용합니다. `commit` 통합은 clean 메인 작업공간에서 cherry-pick하고 실패 시 즉시 abort하며, patch 산출물은 복구용으로 유지합니다.

Dependency는 기본 `all_success` 외에 실패 여부와 관계없이 모든 선행 작업 종료 후 실행하는 `all_terminal`, 실패했을 때만 실행하는 `on_failure`를 지원합니다. 재시도는 일시적인 인프라·조정·timeout 오류 또는 새로운 Validator 피드백이 있는 재작업에만 허용하며, 권한·sandbox·환경 설정 오류를 같은 계약으로 반복하지 않습니다.

권한이나 작업공간 계약이 잘못되어 종료된 Task는 상세 화면에서 sandbox, 네트워크, 공유/worktree, 통합 방식을 명시적으로 수정한 뒤 그 Task만 다시 큐에 넣을 수 있습니다. 이전 실패와 계약 fingerprint는 이력으로 보존되며, 외부 서비스 변경이나 파괴적 작업은 이 복구 UI가 승인하지 않습니다.

### 데몬 빌드 수명주기

데몬 `/health`는 package version뿐 아니라 소스 build ID, protocol version, 실제 runtime 경로, 시작 시각과 capability를 반환합니다. MCP proxy가 기대하는 빌드와 다르면 실행 중 작업이 없을 때만 구 데몬을 종료하고 새 데몬으로 전환합니다. 실행 중 작업이 있으면 `DAEMON_UPGRADE_PENDING`으로 drain을 기다리므로 플러그인 재설치가 활성 Run을 중간에 끊거나 구 코드를 새 코드처럼 재사용하지 않습니다.

설치 런타임 갱신은 `npm run runtime:deploy -- --target <plugin-runtime-directory>`로 수행합니다. 이 절차는 staging 복사본의 `src`·`ui`·`package.json` digest를 원본과 비교하고, 디렉터리를 원자적으로 교체한 뒤 새 데몬의 build ID와 runtime 경로를 확인합니다. 검증이 실패하면 이전 런타임 디렉터리를 복원합니다. 실행과 테스트에는 Codex 번들 Node 경로를 사용할 수 있어 시스템 `PATH`의 Node 설치에 의존하지 않습니다.

### 역할 전문화와 Desktop 한계

내장 역할은 `planner`, `control-plane-architect`, `implementer`, `reviewer`, `qa`, `synthesizer`이며 각 역할에는 개발자 지침, capability, 도구와 권장 모델 같은 전문화 기본값을 저장합니다. 실제 쓰기·네트워크·작업공간 권한은 역할 이름이 아니라 각 Task의 명시적 실행 계약으로만 결정합니다. `upsert_role_template`로 프로젝트 역할을 추가할 수 있습니다.

Desktop 사이드바의 폴더/계층/grouping은 Codex 호스트 소유라 MCP나 App Server가 직접 변경할 수 없습니다. 대신 작업 thread를 `[역할] 작업명`으로 이름 붙이고 pin을 시도하며, `get_desktop_handoff`가 native thread ID를 반환합니다. Codex Desktop 호스트는 이 ID를 이용해 해당 작업으로 직접 이동할 수 있지만, 외부 브라우저 대시보드 자체가 사이드바를 제어하지는 못합니다.

### 중앙 기억과 context pack

`upsert_project_memory`로 사람이 확인한 제약, 결정, 아키텍처, 사실과 참고 메모를 저장할 수 있습니다. 작업을 실행할 때는 현재 prompt, 역할, capability, 필요 도구, 브랜치를 기준으로 관련 기억을 점수화하여 context pack을 만듭니다.

- `constraint`, `decision`, `architecture`이면서 사용자 또는 컨트롤 플레인 출처인 항목은 authoritative context로 전달합니다.
- 과거 에이전트 결과는 reference data로 표시하여 지시문으로 취급하지 않습니다.
- 선택된 기억, 점수와 선택 이유는 task metadata와 `get_project_context` 결과에서 감사할 수 있습니다.
- DAG의 선행 작업이 끝나면 결과가 `task_result` 기억으로 저장되므로 후행 작업의 context pack에 즉시 반영됩니다.
- 각 Data Plane 작업은 실제 Codex 스레드에 전체 대화·명령·최종 결과를 남깁니다. 완료된 작업 카드는 `스레드에서 전체 결과 보기`를 제공하며, 복합 Run은 Orchestrator 스레드에도 작업별 종합 보고서를 남깁니다.
- Control Plane 작업함의 Run 카드에는 실제 Orchestrator와 Data Plane 스레드 이름이 함께 표시됩니다.
- 재시도 가능한 작업은 동일한 managed Worktree를 유지합니다. 데몬 재시작 등으로 경로만 제거된 경우에도 같은 작업 전용 브랜치를 `-b`로 중복 생성하지 않고 재연결합니다.
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
이 스레드를 backend-reviewer 역할로 등록하고 api, database, security 역량을 부여해줘.
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

결과에는 후보별 `scoreBreakdown`, 선택 이유, blocker와 confidence가 포함됩니다. 요청에 명시된 capability와 tool은 점수 가산점이 아니라 필수 조건입니다. 하나라도 빠진 기존 에이전트는 후보 설명에는 남지만 선택되지 않으며 새 스레드를 생성합니다. 조건을 모두 만족하고 기준 점수를 넘는 에이전트가 있으면 기본 결정은 `fork`, `reuseExisting=true`일 때만 `reuse`입니다. 항상 새 에이전트가 필요하면 `routingMode=new`를 사용합니다.

Registry는 기본적으로 `~/.codex/control-plane/v2/registry.sqlite`에 저장됩니다. 처음 시작할 때 이전 `registry.sqlite`가 있으면 SQLite의 일관된 스냅샷으로 한 번 이관합니다. 이 버전 경계는 아직 열려 있는 구버전 MCP 프로세스와 새 데몬이 같은 작업을 동시에 선점하지 못하게 합니다. `CODEX_CONTROL_DB` 환경 변수로 다른 경로를 지정할 수 있습니다.

CP 데몬은 첫 MCP 요청에서 자동으로 시작되며 기본 Unix 소켓은 `~/.codex/control-plane/control-plane.sock`입니다. `CODEX_CONTROL_SOCKET`으로 변경할 수 있습니다. 따라서 특정 Codex 작업을 닫아도 다른 작업이 동일한 레지스트리, 스케줄러와 대시보드를 사용합니다.

데몬이 Codex App Server를 시작할 때 현재 데몬의 Node 실행 파일 디렉터리를 Data Plane `PATH` 맨 앞에 넣고 `CODEX_DATA_PLANE_NODE`로 절대 경로를 전달합니다. npm이 런타임에 포함되지 않은 환경에서는 에이전트가 실행하지 않은 `npm test`를 성공으로 추정하지 않고, 안내된 Node 절대 경로로 `node --test` 같은 실제 명령을 수행합니다.

스케줄러는 heartbeat가 끊긴 active task를 주기적으로 `thread/read`와 대조합니다. 이미 끝난 turn이면 registry를 완료 상태로 복구하고, 결과를 확정할 수 없으면 `sideEffectPolicy=none`인 read-only 작업만 자동 재큐잉하며 나머지는 `recovery_attention`으로 격리합니다. 데몬 종료 시에는 진행 중 작업을 먼저 drain하고 제한 시간이 지나면 turn을 interrupt한 뒤 claim을 복구하므로 `running` 상태가 무기한 남지 않습니다. 실패에는 `configuration`, `environment`, `infrastructure`, `coordination`, `timeout`, `workspace`, `routing`, `validation`, `test`, `command`, `worker` 분류와 실행 계약 fingerprint가 metadata에 기록됩니다.

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

분석 작업의 기본 정책은 `read-only`/`never`, 프로젝트 수정 작업은 `workspace-write`/`never`입니다. 권한은 역할명이 아니라 컴파일된 실행 계약에서 결정됩니다. 외부 시스템 변경과 파괴적 작업은 Data Plane으로 자동 전달하지 않고 `blocked_by_policy`로 분리합니다. `danger-full-access`는 실행 계약에 직접 명시하고 preflight를 통과한 경우에만 사용할 수 있습니다.

남은 주요 확장 범위는 retry 가능 오류 분류, Claude Code provider adapter, 그리고 Codex Desktop이 향후 공식 sidebar grouping/navigation API를 제공할 경우의 네이티브 adapter입니다.

## 참고

- [Codex App Server 공식 문서](https://learn.chatgpt.com/docs/app-server)
