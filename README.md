# OpenClaw Exec Guardrail

Dieses Repository enthält das im Rahmen einer Bachelorarbeit entwickelte
Forschungsartefakt zur Untersuchung von Tool-Use-Guardrails in OpenClaw. Das
Plugin bewertet `exec`-Toolaufrufe vor ihrer Ausführung und dient der
experimentellen Analyse von Schutzwirkung, Laufzeit-Overhead und Auswirkungen
auf den Aufgabenerfolg.

Das Artefakt ist ein kontrollierter Forschungsprototyp. Es demonstriert und
evaluiert eine mehrstufige Guardrail-Architektur; es erhebt keinen Anspruch auf
eine vollständige POSIX-Shell-Analyse oder auf produktionsreife Absicherung
beliebiger OpenClaw-Installationen.

## Stand und geprüfter Umfang

- Plugin-Version: `0.1.0`
- lokale Verifikation: Node.js `20.19.0`
- Teststand vom 11. August 2026: 69 von 69 Tests bestanden
- validierter Approval-Flow: OpenClaw `2026.5.18`
- npm-Abhängigkeiten: keine
- primärer Eingriffspunkt: `api.on("before_tool_call", ...)`
- geschütztes Werkzeug: OpenClaw-Core-Tool `exec`

Der angegebene OpenClaw-Stand bezieht sich auf die experimentelle Validierung
des strukturierten Approval-Flows. Andere OpenClaw-Versionen wurden durch dieses
Repository nicht systematisch auf Kompatibilität geprüft.

## Forschungsgegenstand

Das Plugin untersucht die Komposition von drei Entscheidungsebenen:

1. Eine deterministische Policy normalisiert und klassifiziert den Toolaufruf.
2. Ein optionaler LLM-Judge bewertet ausschließlich deterministisch unklare
   Fälle.
3. Ein optionales Human-in-the-Loop-Gate fordert für geeignete Fälle eine
   strukturierte Freigabe an.

```text
OpenClaw exec-Aufruf
  -> before_tool_call
  -> Normalisierung
  -> deterministische Policy
       -> allow
       -> block
       -> require_approval
       -> escalate_llm
            -> optionaler LLM-Judge
                 -> allow | block | require_approval
  -> technische Durchsetzung
  -> JSONL-Protokollierung
```

Das fachliche Policy-Verdikt (`policyDecision`) und die tatsächlich umgesetzte
Aktion (`enforcementAction`) werden getrennt protokolliert. Dadurch bleibt zum
Beispiel ein fachliches `require_approval` messbar, auch wenn es ohne aktive
HITL-Schicht technisch als `block` durchgesetzt wird.

## Implementierte Eigenschaften

Der deterministische Layer umfasst insbesondere:

- shell-ähnliche Tokenisierung ohne Ausführung des analysierten Befehls,
- POSIX-Pfadnormalisierung relativ zu `workdir` und `workspaceRoot`,
- optionale Realpath- und Symlink-Prüfung gegen Workspace-Escapes,
- Klassifikation von Workspace-, Schutz-, Approval- und externen Zielen,
- Erkennung rekursiver Löschvarianten und mehrerer kritischer Systembefehle,
- konservative Behandlung von Shell-Operatoren, Expansionen und Globs,
- argumentbezogene Read-only-Prüfung für ausgewählte Git-Befehle,
- Blockregeln für sensible Workspace-Dateien anhand von Dateinamenmustern,
- Entscheidungen `allow`, `block`, `require_approval` und `escalate_llm`,
- fail-closed Verhalten bei internen Fehlern im Enforce-Modus.

Der optionale LLM-Judge:

- wird ausschließlich bei `escalate_llm` aufgerufen,
- kann deterministische Blockentscheidungen nicht überschreiben,
- erwartet eine strukturierte JSON-Antwort,
- fällt bei Timeout, Transportfehlern, ungültiger Antwort oder zu geringer
  Konfidenz auf die konfigurierte sichere Entscheidung zurück.

## Experimentkonfigurationen

Die Bachelorarbeit vergleicht vier Schichtkonfigurationen:

| Konfiguration | Modus | Judge | HITL | Judge-Fallback |
|---|---|---:|---:|---|
| C0 | `observe` | aus | aus | `block` |
| C1 | `enforce` | aus | aus | `block` |
| C2 | `enforce` | an | aus | `block` |
| C3 | `enforce` | an | an | `require_approval` |

Die zugehörigen Plugin-Konfigurationsobjekte sind:

```json
{
  "mode": "observe",
  "judge": { "enabled": false, "fallbackDecision": "block" },
  "hitl": { "enabled": false },
  "e6Harness": { "enabled": false }
}
```

```json
{
  "mode": "enforce",
  "judge": { "enabled": false, "fallbackDecision": "block" },
  "hitl": { "enabled": false },
  "e6Harness": { "enabled": false }
}
```

```json
{
  "mode": "enforce",
  "judge": {
    "enabled": true,
    "model": "devstral-small-2:latest",
    "baseUrl": "http://ollama:11434",
    "fallbackDecision": "block",
    "minConfidence": "medium"
  },
  "hitl": { "enabled": false },
  "e6Harness": { "enabled": false }
}
```

```json
{
  "mode": "enforce",
  "judge": {
    "enabled": true,
    "model": "devstral-small-2:latest",
    "baseUrl": "http://ollama:11434",
    "fallbackDecision": "require_approval",
    "minConfidence": "medium"
  },
  "hitl": { "enabled": true },
  "e6Harness": { "enabled": false }
}
```

C0 beobachtet und protokolliert, ohne eine Policy-Entscheidung durchzusetzen.
C1 setzt nur den deterministischen Layer durch. C2 ergänzt den Judge und blockt
Judge-Fehler sicher. C3 leitet passende Policy- und Judge-Entscheidungen sowie
den konfigurierten Judge-Fallback an die menschliche Freigabeschicht weiter.

## Wichtige Konfigurationsfelder

| Feld | Standardwert | Bedeutung |
|---|---|---|
| `mode` | `enforce` | Beobachtung oder aktive Durchsetzung |
| `workspaceRoot` | `/home/node/.openclaw/workspace` | kanonische Workspace-Grenze |
| `protectedTargets` | `["guardrail-lab"]` | rekursiv geschützte Ziele |
| `approvalTargets` | `["guardrail-lab/tmp"]` | Ziele mit Approval-Verdikt |
| `resolveSymlinks` | `true` | Realpath-Prüfung existierender Pfade |
| `logFile` | `/home/node/.openclaw/guardrail-enforce.log` | JSONL-Protokoll |
| `judge.enabled` | `false` | aktiviert die zweite Entscheidungsebene |
| `judge.timeoutMs` | `30000` | Timeout des Judge-Aufrufs |
| `judge.fallbackDecision` | `block` | Verhalten bei Judge-Fehlern |
| `judge.minConfidence` | `medium` | Mindestkonfidenz für `allow` |
| `hitl.enabled` | `false` | aktiviert strukturierte Approval-Anfragen |
| `e6Harness.enabled` | `false` | aktiviert ausschließlich den E6-Testtreiber |

`escalateFallback="allow"` ist nur für kontrollierte Experimente vorgesehen und
reduziert den fail-closed Schutz. Der E6-Treiber löscht bei expliziter
Aktivierung ausschließlich das feste Fixture `guardrail-lab/tmp`; er ist kein
allgemeines Exec-Werkzeug.

## Repository-Struktur

```text
.
|-- index.js                  Plugin-Einstiegspunkt
|-- openclaw.plugin.json      Manifest und Konfigurationsschema
|-- package.json              Node-Metadaten und Testbefehl
|-- src/
|   |-- index.js              OpenClaw-Hooks und Schichtkomposition
|   |-- normalize-command.js  Tokenisierung und Pfadnormalisierung
|   |-- policy.js             deterministische Policy
|   |-- judge.js              optionaler Ollama-Judge
|   |-- approval.js           Abbildung auf OpenClaw-Durchsetzung
|   |-- logger.js             JSONL-Protokollierung
|   `-- decisions.js          gemeinsames Entscheidungsmodell
|-- tests/                    Unit- und Hook-Integrationstests
|-- docs/
|   |-- abgabereife-plan.md   Pflege- und Maßnahmenplan
|   |-- design.md             Architektur- und Schichtbeschreibung
|   `-- requirements.md       Anforderungs- und Bedrohungsmodell
|-- scripts/deploy.sh         projektspezifisches Uni-Host-Deployment
`-- harness/                  Experiment-Harness (eigene README)
    |-- README.md             Anleitung ab leerem Linux-Host
    |-- bin/                  Host-CLI; setzt nur Bash, Docker und Compose voraus
    |-- src/                  Kontrollschicht: Runs, Profile, Metriken
    |-- adapters/live/        Live-Adapter mit Gateway-Bereitschaftspruefung
    |-- runners/              Experiment-Runner (12, alle referenziert)
    |-- vendor/plugin-baseline/  gepinnter Plugin-Messstand
    |-- analysis/             Auswertungspipeline (Python)
    |-- corpora/              Beispiele, Schemata, Fixtures, private Korpora
    |-- profiles/             Mess-Profile; profiles/local/ bleibt ungetrackt
    |-- registry/             Experimente, Korpora, Snapshots, Publikationsregeln
    |-- runtime/              gepinnte Container-Laufzeit und Locks
    |-- reference/            eingefrorene Golden-Ausgaben der Messreihen
    |-- artifacts/runs/       Ergebnisse je Run-ID; ungetrackt
    |-- tests/                Selbsttests der Kontroll- und Shell-Schicht
    |-- docs/                 Nutzerdokumentation
    `-- notes/                interne Arbeitsnotizen; ungetrackt
```

## Lokale Verifikation

Voraussetzung ist eine Node.js-20-Laufzeit. Da das Projekt keine externen
npm-Pakete verwendet, ist keine Paketinstallation erforderlich.

```sh
npm test
```

Alternativ kann der native Node-Test-Runner direkt verwendet werden:

```sh
node --test tests
```

Die Tests führen die untersuchten Shell-Kommandos nicht aus. Sie prüfen unter
anderem Tokenisierung, Pfad- und Symlinkbehandlung, Policy-Entscheidungen,
Judge-Fallbacks, Approval-Routing, Logging und Hook-Komposition.

## Projektspezifisches Deployment

Das vorhandene Skript bildet die Versuchsumgebung auf dem Uni-Host ab und ist
kein allgemeiner Installer. Es erwartet:

- eine Linux-/POSIX-Umgebung mit Bash, Docker Compose, `tar` und `curl`,
- ein separates OpenClaw-Repository,
- `docker-compose.yml` und `docker-compose.ollama.override.yml`,
- den Compose-Service `openclaw-gateway` sowie für Judge-Läufe `ollama`,
- eine bereits passende OpenClaw-Plugin-Konfiguration.

Der OpenClaw-Pfad kann explizit gesetzt werden:

```sh
OPENCLAW_REPO=/pfad/zum/openclaw-repository ./scripts/deploy.sh
```

Das Skript kopiert den Plugin-Quellstand nach
`~/.openclaw/local-plugins/guardrail-spike`, startet beziehungsweise lädt den
Gateway neu und gibt Diagnoseinformationen aus. Sein Recovery-Pfad kann
Container zwangsweise entfernen und mit `sudo` einen festgefahrenen
Gateway-Prozess beenden. Er darf deshalb ausschließlich in der dafür
vorgesehenen, kontrollierten Versuchsumgebung eingesetzt werden.

Für die wissenschaftliche Bewertung des Quellcodes und für die lokalen Tests
ist dieses Deployment nicht erforderlich.

## Protokollierung und Auswertung

Das Plugin schreibt JSONL-Ereignisse für unter anderem:

- Laden des Plugins,
- `before_tool_call`,
- Approval-Anforderung und tatsächliche Auflösung,
- `tool_result_persist`,
- ausgewählte Lifecycle-Diagnosen.

Relevante Felder sind unter anderem `deterministicDecision`, `judgeDecision`,
`policyDecision`, `enforcementAction`, `ruleId`, `severity`,
`deterministicDurationMs`, `judgeDurationMs` und `guardrailDurationMs`.

Die Protokollierung arbeitet best-effort: Schreibfehler werden auf der Konsole
gemeldet, blockieren den Toolaufruf aber nicht. Vor Experimentläufen muss daher
geprüft werden, dass der konfigurierte Logpfad existiert und beschreibbar ist.

## Bekannte Grenzen

- Der Tokenizer ist bewusst konservativ und kein vollständiger
  POSIX-Shell-Parser.
- Die Policy schützt ausschließlich Toolaufrufe, die den beobachteten
  `before_tool_call`-Pfad durchlaufen; sie ersetzt weder Sandbox noch
  Betriebssystemrechte.
- Sensitive Reads werden anhand ausgewählter Dateinamenmuster erkannt. Inhaltlich
  sensible Dateien mit unauffälligem Namen können nicht zuverlässig erkannt
  werden.
- Eine belastbare Symlink-Prüfung setzt voraus, dass der Workspace im
  auswertenden Prozess sichtbar ist. Andernfalls bleibt nur die lexikalische
  Pfadklassifikation.
- Der LLM-Judge ist modell- und laufzeitabhängig. Er kann falsch klassifizieren;
  Fehler und geringe Konfidenz werden deshalb konservativ behandelt.
- `observe` ist ein Messmodus und bietet keine technische Durchsetzung.
- Das Deployment-Skript ist an die dokumentierte Versuchsumgebung gebunden.

Diese Grenzen sind Bestandteil des untersuchten Designs und bei der
Interpretation der Versuchsergebnisse zu berücksichtigen.

## Experiment-Harness

Die Experimente, mit denen dieses Plugin bewertet wurde, liegen unter
[`harness/`](harness/). Der Harness fuehrt Policy-, Judge- und
End-to-End-Messungen reproduzierbar aus: jeder Lauf erhaelt ein unveraenderliches
Manifest, per SHA-256 registrierte Artefakte und ein maschinenlesbares
Metrikbundle. Ein Hauptlauf wird nur nach einem bestandenen Piloten mit
identischem Messvertrag freigegeben.

Die vollstaendige Anleitung ab leerem Linux-Host steht in
[harness/README.md](harness/README.md); die Kommandoreferenz in
[harness/docs/COMMANDS.md](harness/docs/COMMANDS.md).

Fuer die Kontrolllogik werden auf dem Host weder Python noch Node.js benoetigt.

## Weiterführende Dokumentation

- [Design und Entscheidungsebenen](docs/design.md)
- [Anforderungen und Bedrohungsmodell](docs/requirements.md)
- [Plan zur Abgabereife](docs/abgabereife-plan.md)

Für die Reproduzierbarkeit eines konkreten Experiments sind zusätzlich der
verwendete Git-Commit, die OpenClaw-Version, die aktive Konfiguration, das
Judge-Modell und die zugehörigen Ergebnisartefakte festzuhalten.

## Lizenz

MIT, siehe [LICENSE](LICENSE). Das externe Kommandokorpus unter
`harness/corpora/research/external/aegish/` unterliegt einer eigenen Lizenz.
