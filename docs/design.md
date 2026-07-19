# Guardrail Design

This plugin uses a deterministic first layer for OpenClaw `exec` tool calls.
It does not execute shell commands while evaluating policy.

## Normalization

`src/normalize-command.js` tokenizes simple shell-like command strings, removes
basic quotes, detects complex shell syntax, and canonicalizes target paths with
`node:path` POSIX rules. Relative paths are resolved against the reported
`workdir`; absolute paths are normalized directly. If the configured workspace
exists, existing path prefixes are additionally resolved with `fs.realpathSync`
so a symlink inside the workspace cannot hide an outside-workspace target.
Non-existing suffixes are reconstructed below the nearest existing ancestor.
If the workspace itself is unavailable (for example in a fixture-free offline
run), the lexical result remains authoritative.

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

Workspace-local reads of sensitive basenames such as `.env`, `*.env`, `*.pem`,
`*.key`, `credentials*`, `.netrc`, and common SSH private-key names are blocked.
`mkfs.*` variants are treated like `mkfs`. The readonly Git exception validates
the subcommand, rejects unsafe flags such as `--no-index`, `--ext-diff`,
`--textconv`, and `--output`, and enforces workspace scope. A single `&` is
classified as complex shell syntax just like the other shell operators.

Complex shell syntax, interpreter eval commands, network transfer tools, and
unknown commands are escalated instead of allowed.

## Policy verdict and enforcement action

The policy vocabulary is deliberately separate from the OpenClaw action:

- policy verdict: `allow`, `block`, `require_approval`, `escalate_llm`
- enforcement action: `observe_allow`, `allow`, `block`, `request_approval`

`escalate_llm` routes an ambiguous deterministic verdict to the judge. It does
not mean human approval. `require_approval` routes a final policy verdict to the
human layer only if `hitl.enabled=true`; otherwise it is mapped to `block`.
This keeps the normative policy result measurable while making the active
experimental layers explicit.

| Input | C0 observe | C1 det | C2 det+judge | C3 det+judge+HITL |
|---|---|---|---|---|
| deterministic `allow` | observe/execute | allow | allow | allow |
| deterministic `block` | observe/execute | block | block | block |
| deterministic `require_approval` | observe/execute | block | block | request approval |
| deterministic `escalate_llm` | observe/execute | block | invoke judge | invoke judge |
| judge `allow` | n/a | n/a | allow | allow |
| judge `block` | n/a | n/a | block | block |
| judge `require_approval` | n/a | n/a | block | request approval |
| judge error/timeout/low confidence | n/a | n/a | block | request approval |

In C3, routing a judge failure to HITL is an explicit experimental design
decision, implemented by `judge.fallbackDecision=require_approval`. It is not
controlled by `escalateFallback`, because the latter only applies when an
`escalate_llm` verdict reaches enforcement without an active judge.

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

The JSONL log keeps `deterministicDecision`, `judgeDecision`,
`policyDecision`, and `enforcementAction` separate. `judgeInvoked`,
`judgeFallbackUsed`, `hitlEnabled`, and layer durations make the configured
path auditable.

## Approval lifecycle evidence

For every `request_approval` action, the plugin appends an `approval_request`
event with run/tool-call correlation, policy source, rule, command, timeout and
allowed decisions. OpenClaw invokes the supplied `onResolution` callback and
the plugin appends a separate `approval_resolution` event. The experiment
responder additionally stores the complete Gateway request object, its
`plugin:` ID and the resolve RPC response. This dual evidence is used for the
unattended deny/allow-once/timeout evaluation; measured latency is a system
lifecycle metric, not human reaction time.

## Configuration definition of done

The configuration step is complete when all of the following hold:

1. C0 never returns a blocking or approval hook result.
2. C0 never invokes the judge, even if stale configuration says it is enabled.
3. C1 allows deterministic `allow`.
4. C1 preserves deterministic `block`.
5. C1 maps deterministic `require_approval` to `block`.
6. C1 maps unresolved `escalate_llm` to `block`.
7. C2 invokes the judge only for `escalate_llm`; deterministic `block` is never overridden.
8. C2 enforces judge `allow` as `allow`.
9. C2 enforces judge `block` as `block`.
10. C2 maps judge `require_approval` and judge fallback to `block`.
11. C3 maps deterministic/judge `require_approval` and judge fallback to `request_approval`, while preserving regular `block`.
12. Logs distinguish deterministic, judge, final policy, and enforcement values.

The unit and hook-integration tests in `tests/approval.test.js`,
`tests/judge.test.js`, and `tests/index.test.js` cover this contract.

## Deployment

Deployment is external. The plugin is meant to be copied to the Uni-host by the
existing `scripts/deploy.sh` workflow and then tested in OpenClaw via the WebUI.
Local development in this repository should use `npm test` or
`node --test tests`.
