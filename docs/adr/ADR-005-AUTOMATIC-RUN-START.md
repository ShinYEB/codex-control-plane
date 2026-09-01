# ADR-005: 검증 완료 후 Run 자동 시작

- 상태: 채택
- 결정일: 2026-09-02
- subject: `explicit_run_start`

## 배경

초기 계약은 Run을 명시적 Start 동작 이후에만 실행하도록 요구했다. 이후 제품은 채팅을 기본 Control Plane으로, dashboard를 선택적 inspector로 재정의했다. 이 구조에서 요청 후 별도 Start를 다시 요구하면 원격 사용이 중단되고, 사용자의 같은 의도를 두 번 확인하며, preparation·restart recovery·dependency 실행 경계가 불필요하게 복잡해진다.

동시에 자동 시작이 안전하려면 Planner 결과를 곧바로 신뢰해서는 안 된다. Context 계약 충돌, capability, sandbox, tool, workspace, policy와 fingerprint를 실행 전에 검증해야 한다.

## 결정

사용자의 Control Plane 실행 요청을 부모 Run의 유일한 시작 승인으로 간주한다.

```text
user execution request
  -> resolve authoritative context
  -> compile and validate complete graph
  -> persist graph atomically
  -> daemon automatically releases runnable roots
```

- dashboard open, refresh, Run selection은 Start가 아니다.
- 분석·설명·상태 조회 요청은 Run을 만들지 않는다.
- graph가 완전히 준비되기 전에는 Agent, worktree와 attempt를 만들지 않는다.
- 계약 충돌이나 수행 불가능한 capability가 있으면 자동 시작하지 않고 구조화된 pre-claim 실패로 종료한다.
- dependency, Validator, transient retry와 승인된 integration은 부모 Run 권한을 상속하며 추가 Start를 요구하지 않는다.
- 후속 작업, 외부 서비스 변경과 파괴적 작업은 부모 권한에 포함되지 않는다.

## 결과

- `awaiting_user_start`는 신규 정상 경로에서 사용하지 않는 legacy 상태다.
- dashboard에는 Start 버튼이나 실행 승인 API를 제공하지 않는다.
- 안전 경계는 UI 확인이 아니라 immutable Context Snapshot과 Execution Contract v2다.
- 원격 사용자는 요청을 보낸 뒤 별도 화면 동작 없이 결과를 받을 수 있다.
- 같은 요청의 이중 승인과 restart 후 Start 증거 복구 문제가 제거된다.

## 대체된 결정

“Run은 명시적 사용자 Start 이후에만 시작한다”는 기존 사용자 결정을 이 결정으로 대체한다. “dashboard를 여는 것으로 작업이 시작돼서는 안 된다”는 하위 계약은 그대로 유지한다.

