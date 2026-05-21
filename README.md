# OpenClaw Guardrail Plugin

Bachelorarbeitsprojekt: Guardrails in OpenClaw - experimentelle Studie zu
Design, Overhead und Erfolgsraten.

Dieses Plugin untersucht `exec`-Guardrails fuer OpenClaw. Der aktuelle Stand ist
ein deterministischer Layer mit:

- shell-aehnlicher Tokenisierung ohne Ausfuehrung
- POSIX-Pfadnormalisierung relativ zu `workdir` und `workspaceRoot`
- Policy-Entscheidungen `allow`, `block`, `require_approval` und `escalate_llm`
- fail-closed Verhalten fuer noch nicht implementierte LLM-Eskalation
- JSONL-Logging fuer `before_tool_call` und `tool_result_persist`

Der LLM-as-a-Judge ist vorbereitet, aber noch nicht aktiv. Deployment erfolgt
extern ueber `scripts/deploy.sh` auf dem Uni-Host; lokal werden keine Docker-,
SSH- oder OpenClaw-Gateway-Befehle benoetigt.

Lokale Tests:

```sh
npm test
```

Alternativ:

```sh
node --test tests
```
