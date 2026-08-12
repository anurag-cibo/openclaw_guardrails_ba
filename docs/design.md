# Guardrail-Design

Das Plugin verwendet eine deterministische erste Schicht für
OpenClaw-`exec`-Toolaufrufe. Während der Policy-Bewertung wird kein
Shell-Kommando ausgeführt.

## Normalisierung

`src/normalize-command.js` tokenisiert einfache shell-ähnliche Kommandostrings,
entfernt grundlegende Quotes, erkennt komplexe Shell-Syntax und kanonisiert
Zielpfade nach den POSIX-Regeln von `node:path`. Relative Pfade werden gegen den
gemeldeten `workdir` aufgelöst, absolute Pfade direkt normalisiert.

Existiert der konfigurierte Workspace, werden vorhandene Pfadpräfixe zusätzlich
mit `fs.realpathSync` aufgelöst, damit ein Symlink innerhalb des Workspace kein
Ziel außerhalb des Workspace verbergen kann. Nicht existierende Suffixe werden
unterhalb des nächstgelegenen existierenden Vorgängers rekonstruiert. Ist der
Workspace nicht verfügbar — etwa in einem fixture-freien Offline-Lauf —, bleibt
das lexikalische Ergebnis maßgeblich.

Die wesentliche Invariante lautet: semantisch gleichwertige Ziele wie
`guardrail-lab`, `./guardrail-lab/` und
`/home/node/.openclaw/workspace/guardrail-lab` werden auf denselben kanonischen
Pfad abgebildet.

## Policy-Entscheidungen

`src/policy.js` liefert eine von vier deterministischen Entscheidungen:

- `allow`
- `block`
- `require_approval`
- `escalate_llm`

Bekannte Read-only-Kommandos werden erlaubt. Rekursives Löschen von
`workspaceRoot/guardrail-lab` wird blockiert, rekursives Löschen von
`workspaceRoot/guardrail-lab/tmp` erfordert eine Freigabe. Kritische destruktive
Muster wie `rm -rf /`, rekursive Rechteänderungen, `dd of=...`, Reboot-Kommandos
und `killall` werden blockiert.

Workspace-lokale Lesezugriffe auf sensible Basenames wie `.env`, `*.env`,
`*.pem`, `*.key`, `credentials*`, `.netrc` und verbreitete Namen privater
SSH-Schlüssel werden blockiert. `mkfs.*`-Varianten werden wie `mkfs` behandelt.
Die Read-only-Ausnahme für Git validiert das Subkommando, weist unsichere Flags
wie `--no-index`, `--ext-diff`, `--textconv` und `--output` zurück und erzwingt
den Workspace-Scope. Ein einzelnes `&` gilt wie die übrigen Shell-Operatoren als
komplexe Shell-Syntax.

Komplexe Shell-Syntax, Interpreter-Eval-Kommandos, Netzwerk-Transferwerkzeuge
und unbekannte Kommandos werden eskaliert statt erlaubt.

> Die bekannten Reichweitengrenzen dieser Regeln — unter anderem externe
> `grep`-Pattern-Dateien, schreibende `find`-Primaries und die musterbasierte
> Erkennung sensibler Dateien — sind in
> [requirements.md](requirements.md) §17 einzeln aufgeführt. Sie bilden den
> Messgegenstand des Experiments E1ext.

## Policy-Verdikt und Durchsetzungsaktion

Das Policy-Vokabular ist bewusst von der OpenClaw-Aktion getrennt:

- Policy-Verdikt: `allow`, `block`, `require_approval`, `escalate_llm`
- Durchsetzungsaktion: `observe_allow`, `allow`, `block`, `request_approval`

`escalate_llm` leitet ein mehrdeutiges deterministisches Verdikt an den Judge
weiter. Es bedeutet **nicht** menschliche Freigabe. `require_approval` leitet ein
finales Policy-Verdikt nur dann an die menschliche Schicht weiter, wenn
`hitl.enabled=true` gilt; andernfalls wird es auf `block` abgebildet. Dadurch
bleibt das normative Policy-Ergebnis messbar, während die tatsächlich aktiven
Experimentschichten explizit bleiben.

| Eingabe | C0 observe | C1 det | C2 det+judge | C3 det+judge+HITL |
|---|---|---|---|---|
| deterministisch `allow` | beobachten/ausführen | allow | allow | allow |
| deterministisch `block` | beobachten/ausführen | block | block | block |
| deterministisch `require_approval` | beobachten/ausführen | block | block | Freigabe anfordern |
| deterministisch `escalate_llm` | beobachten/ausführen | block | Judge aufrufen | Judge aufrufen |
| Judge `allow` | n/a | n/a | allow | allow |
| Judge `block` | n/a | n/a | block | block |
| Judge `require_approval` | n/a | n/a | block | Freigabe anfordern |
| Judge-Fehler/Timeout/niedrige Konfidenz | n/a | n/a | block | Freigabe anfordern |

In C3 ist die Weiterleitung eines Judge-Fehlers an die HITL-Schicht eine
bewusste experimentelle Designentscheidung, umgesetzt über
`judge.fallbackDecision=require_approval`. Sie wird **nicht** über
`escalateFallback` gesteuert, denn dieses greift nur, wenn ein
`escalate_llm`-Verdikt ohne aktiven Judge die Durchsetzung erreicht.

## LLM-as-a-Judge

`src/judge.js` implementiert eine optionale zweite Stufe für deterministische
`escalate_llm`-Entscheidungen. Deterministische `allow`-, `block`- und
`require_approval`-Entscheidungen umgehen den Judge; ein deterministisches
`block` darf vom Judge niemals überschrieben werden.

Ist der Judge aktiviert, ruft er Ollama über `POST {baseUrl}/api/chat` auf. Die
Standardwerte zur Laufzeit sind:

```text
judge.enabled = false
judge.model = devstral-small-2:latest
judge.baseUrl = http://ollama:11434
judge.timeoutMs = 30000
judge.fallbackDecision = block
judge.minConfidence = medium
```

Der Judge muss JSON mit genau einer Endentscheidung zurückgeben:

- `allow`
- `require_approval`
- `block`

Er darf `escalate_llm` nicht zurückgeben. Ungültiges JSON, HTTP-Fehler,
Timeouts, nicht verfügbares `fetch`, unbekannte Entscheidungen, ungültige
Konfidenzwerte, niedrige Konfidenz und ein `allow` unterhalb von `minConfidence`
führen sämtlich fail-closed auf `block` zurück — es sei denn,
`judge.fallbackDecision` ist ausdrücklich auf `require_approval` gesetzt.

Sinnvolle Auswertungsmetriken der zweiten Stufe:

- `judge_invocation_rate`
- `judge_latency_ms`
- `judge_agreement_rate`
- `judge_error_rate`

Das JSONL-Protokoll hält `deterministicDecision`, `judgeDecision`,
`policyDecision` und `enforcementAction` getrennt. `judgeInvoked`,
`judgeFallbackUsed`, `hitlEnabled` und die Schichtdauern machen den
konfigurierten Pfad auditierbar.

> Der Judge darf innerhalb der eskalierten Menge auch statisch riskante
> Kategorien freigeben. Die harte Grenze — kein Überschreiben eines
> deterministischen `block` — bleibt gewahrt. Siehe
> [requirements.md](requirements.md) §18 E-8.

## Nachweise des Approval-Lifecycles

Für jede `request_approval`-Aktion hängt das Plugin ein
`approval_request`-Ereignis an, mit Korrelation zu Run und Toolaufruf,
Policy-Quelle, Regel, Kommando, Timeout und erlaubten Entscheidungen. OpenClaw
ruft den übergebenen `onResolution`-Callback auf, und das Plugin hängt ein
separates `approval_resolution`-Ereignis an. Der Experiment-Responder speichert
zusätzlich das vollständige Gateway-Requestobjekt, dessen `plugin:`-ID und die
Antwort des Resolve-RPC.

Diese doppelte Beweisführung wird für die unbeaufsichtigte Auswertung von
Deny, Allow-once und Timeout verwendet. Die gemessene Latenz ist eine
Systemlifecycle-Metrik, **keine** menschliche Reaktionszeit.

## Definition of Done der Konfiguration

`e6Harness.enabled` ist standardmäßig `false`. Nur während E6 aktiviert der
Runner den optionalen Treiber `guardrail_e6_exec`. Er ist auf den read-only
`pwd`-Preflight und das feste Wegwerf-Fixture-Kommando
`rm -rf guardrail-lab/tmp` beschränkt. Er isoliert den
OpenClaw-Approval-Lifecycle; E5 prüft weiterhin die Integration mit dem echten
Core-Werkzeug `exec`.

Der Konfigurationsschritt gilt als abgeschlossen, wenn alle folgenden Punkte
zutreffen:

1. C0 liefert niemals ein blockierendes oder ein Approval-Hook-Ergebnis.
2. C0 ruft den Judge niemals auf, selbst wenn eine veraltete Konfiguration ihn
   als aktiviert ausweist.
3. C1 erlaubt deterministisches `allow`.
4. C1 erhält deterministisches `block`.
5. C1 bildet deterministisches `require_approval` auf `block` ab.
6. C1 bildet ein ungelöstes `escalate_llm` auf `block` ab.
7. C2 ruft den Judge ausschließlich bei `escalate_llm` auf; ein
   deterministisches `block` wird nie überschrieben.
8. C2 setzt ein Judge-`allow` als `allow` durch.
9. C2 setzt ein Judge-`block` als `block` durch.
10. C2 bildet Judge-`require_approval` und Judge-Fallback auf `block` ab.
11. C3 bildet deterministisches und Judge-`require_approval` sowie den
    Judge-Fallback auf `request_approval` ab und erhält reguläre `block`-Fälle.
12. Die Protokolle unterscheiden deterministische, Judge-, finale Policy- und
    Durchsetzungswerte.

Die Unit- und Hook-Integrationstests in `tests/approval.test.js`,
`tests/judge.test.js` und `tests/index.test.js` decken diesen Vertrag ab.

## Deployment

Das Deployment liegt außerhalb dieses Moduls. Das Plugin wird über den
bestehenden Ablauf `scripts/deploy.sh` auf den Uni-Host kopiert und anschließend
in OpenClaw über die WebUI getestet. Die vollständige Installationsanleitung
einschließlich der manuellen Variante steht in der [README](../README.md),
Teil 3.

Für die lokale Entwicklung in diesem Repository genügen `npm test` oder
`node --test tests`.
