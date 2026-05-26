# Guardrail Design

This plugin uses a deterministic first layer for OpenClaw `exec` tool calls.
It does not execute shell commands while evaluating policy.

## Normalization

`src/normalize-command.js` tokenizes simple shell-like command strings, removes
basic quotes, detects complex shell syntax, and canonicalizes target paths with
`node:path` POSIX rules. Relative paths are resolved against the reported
`workdir`; absolute paths are normalized directly. The code deliberately avoids
`fs.realpathSync` because policy tests and future OpenClaw calls may reference
targets that do not exist yet.

The important invariant is that semantically equivalent targets such as
`guardrail-lab`, `./guardrail-lab/`, and
`/home/node/.openclaw/workspace/guardrail-lab` map to the same canonical path.

## Policy Decisions

`src/policy.js` returns one of four deterministic decisions:

- `allow`
- `block`
- `require_approval`
- `escalate_llm`

Known readonly commands are allowed. Recursive deletion of
`workspaceRoot/guardrail-lab` is blocked. Recursive deletion of
`workspaceRoot/guardrail-lab/tmp` requires approval. Critical destructive
patterns such as `rm -rf /`, recursive permission changes, `dd of=...`, reboot
commands, and `killall` are blocked.

Complex shell syntax, interpreter eval commands, network transfer tools, and
unknown commands are escalated instead of allowed.

## LLM-as-a-Judge

`src/judge.js` implements an optional second stage for deterministic
`escalate_llm` decisions. Deterministic `allow`, `block`, and
`require_approval` decisions bypass the judge; a deterministic `block` decision
must never be overwritten by the judge.

The judge calls Ollama through `POST {baseUrl}/api/chat` when enabled. The
default runtime settings are:

```text
judge.enabled = false
judge.model = devstral-small-2:latest
judge.baseUrl = http://ollama:11434
judge.timeoutMs = 30000
judge.fallbackDecision = block
judge.minConfidence = medium
```

The judge must return JSON with one final decision:

- `allow`
- `require_approval`
- `block`

It must not return `escalate_llm`. Invalid JSON, HTTP errors, timeouts,
unavailable `fetch`, unknown decisions, invalid confidence values, low
confidence, and `allow` below `minConfidence` all fall back fail-closed to
`block` unless `judge.fallbackDecision` is explicitly `require_approval`.

Useful evaluation metrics for the second stage:

- `judge_invocation_rate`
- `judge_latency_ms`
- `judge_agreement_rate`
- `judge_error_rate`

## Deployment

Deployment is external. The plugin is meant to be copied to the Uni-host by the
existing `scripts/deploy.sh` workflow and then tested in OpenClaw via the WebUI.
Local development in this repository should use `npm test` or
`node --test tests`.
