# ThreadGraph Context Pack consumer contract

ThreadHub and ThreadGraph remain independent applications with separate storage, schemas, release cycles, and failure domains. Their only knowledge-transfer boundary is the public `threadgraph-context-pack/1-alpha` value described here. ThreadHub never reads ThreadGraph's database or imports its implementation.

## Import boundary

`import_threadgraph_context_pack` requires:

- an existing or resolvable ThreadHub project path (`cwd`);
- the ThreadGraph project identity the user intends to bind (`expectedScopeId`);
- one complete Context Pack;
- an optional explicit partial-import policy for missing sources.

The tool call is an import request, not an execution request. It cannot create a Context Snapshot, plan, Run, Task, Agent, Turn, lease, worktree, or execution contract.

## Required validation order

ThreadHub validates the full value before opening a registry transaction:

1. reject unknown top-level fields and nested authority-bearing keys;
2. require the exact supported schema version and field types;
3. match `scopeId` to the explicitly supplied source scope;
4. accept only the `codex-threadgraph/<version>` producer identity, or an exact deployment allowlist;
5. independently recompute the canonical content digest;
6. independently recompute the content-addressed pack ID;
7. reject invalid time ordering, excessive future skew, or stale observation cutoff;
8. reject unresolved conflicts;
9. reject missing sources unless the caller explicitly allows a partial import.

A rejection has `mutated: false`. No claim, source, snapshot, routing decision, or execution entity is stored.

## Canonical fingerprint

The consumer independently implements the public producer algorithm:

- recursively sort JSON object keys; preserve array order; normalize negative zero to zero;
- reject undefined, non-finite, and non-JSON values;
- frame every hash field as eight hexadecimal UTF-8 byte-length characters, `:`, then the value;
- compute SHA-256 over the concatenated framed namespace and fields;
- represent fingerprints as `sha256:<lowercase hex>`;
- represent IDs as lowercase unpadded Base32.

`contentDigest` covers every semantic field except `packId` and `contentDigest`. `packId` covers the graph revision, selection digest, full `contentDigest`, and Context Pack ID-contract version. Therefore changing the summary, conflicts, missing sources, observation times, or producer identity changes both the digest and ID.

## Stored result

An accepted pack creates exactly one project-scoped Context Claim and one provenance source:

| Field | Stored value |
|---|---|
| status | `candidate` |
| authority | `observed_thread` |
| kind | `note` |
| source kind | `threadgraph_context_pack` |
| source ID | `packId` |
| source revision | `graphRevisionId` |
| source digest | `contentDigest` |
| execution authority | `false` |

Repeated imports converge on the same claim and source. Import does not activate the claim. ThreadHub's existing provenance validation, conflict resolution, immutable Context Snapshot, planning gate, and strict execution-contract gate remain authoritative.

## Failure isolation

- ThreadGraph being unavailable does not stop ThreadHub operation.
- ThreadHub being unavailable does not change ThreadGraph graph exploration or exports.
- Rejected packs leave ThreadHub and ThreadGraph state unchanged.
- A candidate can influence planning only after a separate ThreadHub validation explicitly activates it and a new validated Context Snapshot selects it.

## Verification

- `test/fixtures/threadgraph-context-pack-v1-alpha.json` is produced by ThreadGraph and consumed as an external compatibility fixture.
- `test/threadgraph-context-pack.test.js` covers digest, ID, scope, identity, freshness, authority, conflict, missing-source, no-mutation, idempotency, and candidate-only behavior.
- `test/mcp-server.test.js` proves the public import tool binds the candidate to a ThreadHub project without creating a Context Snapshot.
