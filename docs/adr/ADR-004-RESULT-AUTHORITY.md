# ADR-004: durable Result projection만 사용자-visible 결과의 정본이다

- 상태: Result projection 권위는 채택, delivery 부분은 ADR-006으로 대체
- 결정 대상: Orchestrator, Synthesizer, RunController, Work Navigator

## 맥락

현재 구조에서는 Orchestrator와 Synthesizer가 모두 terminal summary를 만들 수 있다. 서로 다른 시점과 입력으로 두 결과가 만들어지면 사용자는 어느 결과가 최종인지 판단할 수 없고, dashboard와 origin delivery가 다른 내용을 보여줄 수 있다. Global Run은 여러 Project Run의 부분 성공·실패를 집계하므로 이 중복이 더 위험하다.

## 결정

사용자-visible terminal 결과의 정본은 Registry에 저장된 durable Result projection 하나다.

- Project Run은 `run_results` projection을 가진다.
- Global Run은 `global_run_results` projection을 가진다.
- Synthesizer는 durable 상태, 검증 결과와 artifact에서 이 projection payload를 만든다.
- Orchestrator 스레드의 설명은 synthesis input/evidence일 수 있지만 terminal 결과의 정본이 아니다.
- daemon/Registry writer가 projection을 terminal entity와 원자적으로 연결하고 작업 탐색기는 저장된 projection만 표시한다.

## Projection 규칙

Result projection은 최소한 다음 구조화된 필드를 가진다.

```text
ResultProjection
  entity_id
  entity_revision
  terminal_status
  summary
  scope_completed[]
  scope_missing[]
  warnings[]
  failures[]
  artifacts[]
  next_action?
  source_fingerprints[]
  synthesizer_version
  fingerprint
```

- terminal 상태와 child 집계는 중앙 상태 함수에서 가져오며 자연어 summary가 바꿀 수 없다.
- Task terminal 상태는 versioned CompletionVerdict에서 가져오며 Agent output이나 Validator 문구만으로 만들지 않는다.
- 일부 실패·취소·미통합 artifact를 summary가 성공으로 숨길 수 없다.
- 동일 entity revision과 source fingerprint는 동일 projection에 수렴한다.
- projection 생성 중 새 Task나 후속 Run을 시작하지 않는다.

## 실패와 fallback

- narrative synthesis가 실패해도 구조화된 상태·failure·artifact를 포함한 deterministic fallback projection을 저장한다.
- fallback은 빈 성공 메시지가 아니며 synthesis failure warning을 포함한다.
- Orchestrator의 오래된 summary를 fallback 정본으로 승격하지 않는다.
- terminal projection 저장 전 완료 notification을 만들지 않는다.
- Orchestrator summary가 구조화된 Run verdict와 모순되면 `consistency_failed`로 기록하고 deterministic fallback을 사용한다.
- 화면 재조회는 projection을 다시 합성하지 않고 저장된 payload/fingerprint를 사용한다.

## 작업 탐색기

- Run 목록, 결과 요약과 스레드 구조는 같은 projection ID/fingerprint를 읽는다.
- 상세 Orchestrator thread와 Project Run 결과는 evidence link로 표시한다.
- terminal 결과를 origin 스레드에 자동 append하지 않는다.

## 결과

- Orchestrator는 조정 맥락과 판단 근거에 집중한다.
- Synthesizer는 사용자 결과 projection 생성 책임을 가진다.
- 작업 목록, 요약과 실제 스레드 사이의 결과 drift를 방지한다.
- synthesis 실패도 실행 성공·실패 상태를 잃지 않고 조회할 수 있다.

## 구현 전 실패 테스트

1. Orchestrator summary가 terminal 상태를 덮어쓰지 못한다.
2. required child failure가 성공 summary로 투영되지 않는다.
3. synthesis 실패 시 구조화된 fallback이 생성된다.
4. 작업 목록·요약·스레드 구조가 같은 projection fingerprint를 반환한다.
5. 화면 재조회가 projection을 다시 합성하지 않는다.
6. 같은 source fingerprint가 중복 result row를 만들지 않는다.
