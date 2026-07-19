# OpenClaw Guardrail Plugin

Bachelorarbeitsprojekt: Guardrails in OpenClaw - experimentelle Studie zu
Design, Overhead und Erfolgsraten.

Dieses Plugin untersucht `exec`-Guardrails fuer OpenClaw. Der aktuelle Stand
umfasst:

- shell-aehnlicher Tokenisierung ohne Ausfuehrung
- POSIX-Pfadnormalisierung relativ zu `workdir` und `workspaceRoot`
- Symlink-/Realpath-Pruefung gegen Workspace-Escapes, wenn der Workspace existiert
- Blockregeln fuer sensible Workspace-Dateien und `mkfs.*`
- argumentbewusste Git-Readonly-Allowlist und Erkennung eines einzelnen `&`
- laufzeitkonfigurierbare `protectedTargets` und `approvalTargets`
- Policy-Entscheidungen `allow`, `block`, `require_approval` und `escalate_llm`
- optionalen LLM-Judge nur fuer `escalate_llm`
- explizites HITL-Gate (`hitl.enabled`): ohne HITL wird `require_approval`
  fail-closed geblockt, mit HITL als strukturierte OpenClaw-Anfrage ausgegeben
- JSONL-Logging fuer `before_tool_call`, Approval-Request,
  Approval-Resolution und `tool_result_persist`

Policy-Verdikt (`policyDecision`) und effektive Durchsetzung
(`enforcementAction`) werden getrennt geloggt. So bleibt beispielsweise ein
fachliches `require_approval` sichtbar, auch wenn C1 oder C2 es mangels HITL als
`block` durchsetzt.

Bei einer strukturierten Approval-Anfrage protokolliert das Plugin die sichere
Request-Metadatenansicht und über den OpenClaw-Callback `onResolution` die
tatsächliche Auflösung (`allow-once`, `deny`, `timeout` oder `cancelled`). Der
Experiment-Responder ergänzt dazu die Gateway-Approval-ID und das vollständige
Requestobjekt; dadurch sind Routing und Durchsetzung unabhängig prüfbar.

Die vier Experimentkonfigurationen sind:

| Konfig. | Modus | Judge | HITL | Judge-Fallback |
|---|---|---:|---:|---|
| C0 | observe | aus | aus | block |
| C1 | enforce | aus | aus | block |
| C2 | enforce | an | aus | block |
| C3 | enforce | an | an | require_approval |

Deployment erfolgt extern ueber `scripts/deploy.sh` auf dem Uni-Host; lokal
werden keine Docker-, SSH- oder OpenClaw-Gateway-Befehle benoetigt.

Lokale Tests:

```sh
npm test
```

Alternativ:

```sh
node --test tests
```
