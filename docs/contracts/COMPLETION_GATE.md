# 증거 기반 Completion Gate 계약

- 버전: `completion_gate_v1`
- 상태: 핵심 구현 완료

이 계약은 Data Plane Turn 종료부터 Task terminal 전이까지의 유일한 성공 판정 경계를 정의한다. 실행 계약이 “무엇을 할 수 있는가”를 정한다면 Completion Gate는 “무엇이 실제로 완료되었는가”를 판정한다.

## 입력

Completion Evaluator는 최소 다음 입력을 같은 Task·contract revision에서 받는다.

| 입력 | 필수 내용 |
|---|---|
| Turn evidence | threadId, turnId, terminal status, error, 전체 item 목록 |
| Command evidence | command identity, 목적, exit code, status, output digest |
| Output evidence | contract `outputs` 항목과 실제 결과의 대응, location/content digest |
| Workspace evidence | preflight baseline, final diff, artifact identity |
| Validation evidence | criteria별 verdict와 근거 reference |
| Integration evidence | journal identity와 prepared/applying/applied/recorded 상태 |
| Postcondition evidence | destination workspace에서 수행한 최종 검증 결과 |

각 evidence는 source, observedAt, content fingerprint를 가진다. Agent의 자연어 output은 evidence reference를 설명할 수 있지만 command exit code나 workspace 상태를 대신하지 않는다.

## 단계별 gate

### 1. Turn hydration

`turn/completed` notification은 완료 후보 신호다. daemon은 `thread/read(includeTurns=true)`로 해당 Turn을 다시 읽고 실시간 수집 item과 병합한다. terminal Turn을 읽을 수 없거나 item 집합의 완전성을 확인할 수 없으면 성공 판정을 보류한다.

### 2. Command verdict

- 실패 status 또는 non-zero exit code가 있는 필수 명령은 Task를 실패시킨다.
- 계약이나 acceptance criteria가 요구하는 검증 명령이 실행되지 않았으면 `evidence_missing`이다.
- Agent 문구에 포함된 테스트 통과 주장은 command evidence가 아니다.
- 선택적 진단 명령 실패를 허용하려면 계획 단계에서 optional로 구조화해야 한다.
- 테스트 성공은 인식 가능한 직접 실행과 종료 코드 0이 함께 있어야 한다. 실행 파일의 절대 경로와 지원되는 Node 옵션은 허용하지만, 임의 Python/JavaScript 래퍼의 자식 성공을 추측하지 않는다. 자식 명령이 별도 native receipt로 관찰되지 않으면 `attention`, `inspect_execution_evidence`, 자동 재시도 불가로 판정한다.
- 같은 Turn 안에서 명령 문자열과 명시적 작업 디렉터리가 동일한 테스트를 나중에 성공적으로 재검증하면 앞선 실패를 대체할 수 있다. 다른 테스트·작업 디렉터리·일반 부작용 명령은 대체하지 않으며 원본 명령 기록은 보존한다.
- 명시적인 진행 안내(`commentary`)는 최종 보고서의 대체값이 아니다. phase가 없는 구형 호스트 응답만 마지막 메시지 호환 처리를 허용한다.

### 3. Output materialization

계약의 각 `outputs`는 type별 검증 규칙을 가진다.

- `report`: 비어 있지 않은 구조화된 결과와 provenance
- `workspace-change`: baseline과 다른 diff 또는 적용 가능한 artifact
- `patch`/`commit`: content digest와 기준 ref를 가진 artifact
- 사용자 정의 output: versioned schema와 location/content digest

이름이 선언되어 있고 Agent output 문자열이나 임의 artifact가 하나 존재한다는 이유만으로 충족된 것으로 보지 않는다.

### 4. Workspace와 integration

- `mutatesWorkspace=false`이면 허용되지 않은 project diff가 없어야 한다.
- `mutatesWorkspace=true`이고 변경 output이 필수이면 빈 diff는 실패다.
- managed worktree 변경은 journal이 `recorded`가 된 뒤에만 통합 완료다.
- Validator가 worktree에서 승인했더라도 destination workspace postcondition이 필요한 작업은 통합 후 다시 검사한다.

### 5. Validation

분석·검토의 단순 report를 제외한 구현·통합·release Task는 명시적 acceptance criterion 또는 실행 계약에서 생성된 output·mutation 조건을 가져야 한다. test Task와 테스트 통과 criterion은 실제 test command evidence를 요구한다. Validator는 worker output을 untrusted evidence로 취급하고 실제 evidence reference가 없는 criterion을 승인하지 않는다.

### 6. Terminal transition

Completion Evaluator는 다음 구조를 반환한다.

```text
CompletionVerdict
  decision: accept | accept_with_warnings | reject | attention
  category
  cause
  satisfiedEvidence[]
  missingEvidence[]
  conflictingEvidence[]
  retryable
  nextAction
  contractFingerprint
  evidenceFingerprint
```

daemon의 정상 실행과 restart reconciliation은 `completeClaim()` 또는 `finishValidationClaim()` 전에 동일한 Completion Evaluator를 호출하고 verdict를 Task metadata에 저장한다. Registry의 저수준 fenced transition은 migration·테스트 호환을 위해 유지하지만 제품 실행 경로에서는 유효한 CompletionVerdict 없는 성공 진입점으로 사용하지 않는다.

## Master와 Run 정합성

Slave CompletionVerdict는 Registry에 먼저 저장된다. daemon은 decision barrier에서 검증된 결과 묶음만 Master Orchestrator에 전달한다. Master의 최종 종합은 다음을 만족해야 한다.

- Run terminal status와 같은 overall verdict를 표현한다.
- 실패·취소·경고·미통합 artifact를 누락하지 않는다.
- Task evidence fingerprint를 reference한다.
- 새 Task, retry 또는 side effect를 시작하지 않는다.

불일치하면 Run status는 유지하고 synthesis를 `consistency_failed`로 기록한 뒤 deterministic Result projection을 사용자에게 보여준다.

## 구현 상태

1. 완료: terminal Turn 전체 hydration과 item 병합
2. 완료: output/mutation materialization과 실제 test command 검사
3. 완료: 정상·복구 공통 Completion Evaluator와 fingerprinted verdict
4. 완료: Validator 이후 integration continuation 복구
5. 완료: integration journal과 destination artifact 적용 postcondition
6. 완료: Master와 Synthesizer의 durable Run verdict consistency 검사

향후 계약 확장 시에는 특정 test target, 브라우저 검증과 사용자 정의 output schema를 실행 계약의 versioned 필드로 승격한다.
