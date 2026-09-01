# 런타임과 배포 수명주기

이 프로젝트는 source checkout, personal-plugin source, installed cache, daemon process, MCP proxy가 서로 다른 generation일 수 있다는 전제로 동작한다. version 문자열만 같다고 호환되는 것으로 보지 않는다.

## Runtime identity

identity는 다음 세 값으로 구성한다.

- `buildId`: `package.json`, `src`, `ui`, `scripts` 전체 내용의 hash
- `protocolVersion`: daemon RPC 호환 버전. 현재 `2`
- `runtimePath`: 실제 실행 중인 canonical daemon path

daemon `/health`는 identity와 함께 pid, started time, capabilities, active task count, drain state를 반환한다.

## Single daemon

- 기본 Unix socket: `~/.codex/control-plane/control-plane.sock`
- override: `CODEX_CONTROL_SOCKET`
- lock file은 process 단위 single daemon을 보장한다.
- stale lock은 PID 생존 여부를 확인한 뒤에만 회수한다.
- socket mode는 `0600`이다.
- 요청 body는 2 MiB로 제한한다.

MCP proxy는 daemon client이고 Registry/App Server writer가 아니다.

## Identity mismatch

일반 MCP proxy는 관찰자다.

1. `/health`의 build, protocol, path가 모두 기대값과 같으면 기존 daemon을 사용한다.
2. 하나라도 다르고 handover authority가 없으면 `CLIENT_UPGRADE_REQUIRED`를 반환한다.
3. 일반 proxy는 daemon을 종료·교체·downgrade하지 않는다.
4. 사용자는 설치된 generation을 로드하는 새 Codex 대화를 열어야 한다.

## Authorized handover

배포·재설치 도구만 `authority=deployment`로 `/shutdown`을 요청할 수 있다.

```text
running -> draining -> socket/lock release -> new generation start
```

- active Task가 있으면 daemon은 `DAEMON_UPGRADE_PENDING`을 반환하고 새 RPC 작업을 거부한다.
- control dispatch, Task, finalization, delivery flight를 active work로 센다.
- active work가 0이 된 뒤에만 daemon을 닫는다.
- authority 없는 shutdown은 `HANDOVER_AUTHORITY_REQUIRED`다.

## Runtime deployment

`npm run runtime:deploy -- --target <runtime-directory>`의 계약:

1. 새 `src`, `ui`, `scripts`, `package.json`을 staging에 복사한다.
2. source와 staging digest를 비교한다.
3. target을 원자적으로 swap한다.
4. 새 daemon identity를 검증한다.
5. 실패하면 backup을 복원한다.
6. 복원된 runtime의 build, protocol, canonical path로 daemon을 다시 시작하고 health를 검증한다. rollback 검증도 실패하면 원래 배포 오류와 함께 명시적으로 보고한다.

Registry DB와 managed worktree directory는 runtime target 밖의 durable data이며 swap/cleanup 대상이 아니다.

## Plugin reinstall

재설치는 기본 dry-run이다.

```bash
npm run reinstall:preflight -- --plugin codex-agent-control-plane --marketplace personal
```

실행 전 조건:

- daemon active Task가 0
- daemon이 drain 중이 아님
- 해당 installed cache를 사용하는 MCP proxy가 0. 탐지는 cwd뿐 아니라 process command와 open file 경로도 확인한다.
- 대상 selector가 정확히 `codex-agent-control-plane@personal`

조건을 만족한 뒤에만 `--execute`로 정확한 cache를 제거·재설치한다. broad cache cleanup이나 Registry/worktree 삭제는 허용하지 않는다. 기존 대화는 plugin generation을 hot reload하지 않으므로 재설치 후 새 대화를 연다.

## Shutdown and signals

- 정상 close는 background control을 먼저 닫고 HTTP server, socket, lock을 정리한다.
- `SIGINT`/`SIGTERM`도 같은 close 경로를 사용한다.
- Task 복구 계약은 [FAILURE_RECOVERY.md](./FAILURE_RECOVERY.md)를 따른다.

## Compatibility policy

- protocol version 변경은 RPC 호환성이 깨지는 변경이다.
- build ID 변경은 내용이 달라진 새 generation이다.
- runtime path 변경도 identity 변경이다. 동일 내용이어도 다른 cache path의 process를 같은 generation으로 간주하지 않는다.
- ordinary client의 자동 daemon replacement는 금지한다.
- 새 generation은 이전 durable data를 읽을 수 있어야 하며, 불가능하면 명시적 migration이 먼저 필요하다.

Registry는 독립적인 SQLite `user_version`을 사용한다. runtime 시작 시 지원 schema로 transaction migration하며, 기존 DB이면 먼저 SQLite snapshot을 만든다. 따라서 protocol/build identity와 storage schema compatibility를 별도로 검증할 수 있다.
