# Security Policy

## Supported versions

RUVORA is pre-1.0 software. Security fixes are applied to the latest release and the `main` branch.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting feature on the RUVORA repository.

Include, when possible:

- the affected version or commit;
- the security boundary or invariant involved;
- reproduction steps that do not expose real credentials or private data;
- expected and observed behavior;
- the potential impact.

Never include API keys, access tokens, private Codex transcripts, personal data, or proprietary source code in a report. We will acknowledge a complete report as soon as practical and coordinate disclosure after a fix is available.

## Security boundaries

RUVORA coordinates processes that may read or modify local workspaces. Its execution contract, authorization scope, sandbox, side-effect policy, claim fencing, and evidence gates are security-relevant behavior. A planner description or worker completion message is never an authorization grant or proof of success.
