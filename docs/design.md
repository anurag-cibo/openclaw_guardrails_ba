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
unknown commands are escalated instead of allowed. In the plugin entrypoint,
`escalate_llm` currently fails closed to `{ block: true }` unless runtime config
sets `escalateFallback` to `approval` or `allow`.

## Judge Extension Point

`src/judge.js` is only a placeholder. No LLM-as-a-Judge, Ollama, network call,
Docker command, or deployment action is implemented in this local plugin code.

## Deployment

Deployment is external. The plugin is meant to be copied to the Uni-host by the
existing `scripts/deploy.sh` workflow and then tested in OpenClaw via the WebUI.
Local development in this repository should use `npm test` or
`node --test tests`.
