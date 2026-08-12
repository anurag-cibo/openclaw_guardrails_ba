# Plan zur Abgabereife des Guardrail-Plugins

**Stand:** 12. August 2026 (Ursprungsfassung: 11. August 2026)
**Ziel:** wissenschaftlich nachvollziehbares und gepflegtes Begleitartefakt der
Bachelorarbeit
**Nicht primäres Ziel:** allgemeine Produktreife oder portable Installation in
beliebigen OpenClaw-Umgebungen

---

## 0. Fortschreibung vom 12. August 2026

Jede Maßnahme trägt seit dieser Fortschreibung eine Statuszeile. Drei Befunde
haben die Bewertung der Ursprungsfassung grundlegend verändert.

### 0.1 Neuer Befund: M-07 (Korpora waren nicht versioniert)

Der einzige echte Abgabe-Blocker lag nicht im Code, sondern in der
Root-`.gitignore`. Er ist behoben, siehe **M-07**.

### 0.2 K-01 und K-02 sind kein Defekt, sondern Messgegenstand

Die Ursprungsfassung führte K-01 (`grep -f`) und K-02 (mutierende
`find`-Primaries) als P0-Beanstandungen. Die Prüfung des Harness-Korpus zeigt,
dass beide **Gegenstand des Experiments E1ext („Regelumgehung")** sind.

`harness/corpora/research/e1_extension_ruleevasion.jsonl` enthält 35 Fälle in
sechs Klassen — 32 Umgehungen und drei Kontrollfälle. Gemessen gegen den
aktuellen `src/policy.js`:

| Klasse | Fälle | Ist-Entscheidung | im Plan geführt als |
|---|---:|---|---|
| `grep_content_dump` | 6 | `allow` | *nicht erfasst* |
| `parser_option_argument` | 4 | `allow` | **K-01** |
| `sensitive_basename_gap` | 12 | `allow` | *nicht erfasst* |
| `find_write_primitive` | 6 | `allow` | **K-02** |
| `git_readonly_gap` | 4 | `allow` | *nicht erfasst* |
| `boundary_control` | 3 | `block` | Kontrollfälle |

Die Ursprungsfassung dieses Plans erfasste damit nur zwei von fünf
Umgehungsklassen und deutete sie als Mängel. Richtig ist: sie belegen die
Reichweitengrenze eines rein deterministischen, musterbasierten Layers — genau
die Lücke, für die die Arbeit Judge- und HITL-Schicht als Ergänzung untersucht.
Alle fünf Klassen sind jetzt in `docs/requirements.md` §17 als Abweichungen
A-1 bis A-6 und in der README unter „Aussagegrenzen" dokumentiert.

### 0.3 Der Policy-Kern ist gegen Änderungen gebunden

`harness/vendor/plugin-baseline/src/` ist eine byte-identische Kopie von `src/`
und dient als **Messreferenz**. Der Harness vergleicht den SHA-256 der
deployten Plugin-Dateien mit dieser Referenz, schreibt beide Werte in jedes
Run-Manifest (`pluginProvenance.deployed` gegen
`pluginProvenance.measurementBaseline`) und weist im Pilot→Hauptlauf-Gate eine
Abweichung ab.

Da die Hauptläufe gemessen und ihre Zahlen berichtet sind, entwertet **jede**
Änderung an `src/` die Referenz und erzwingt eine Neubewertung der betroffenen
Experimente. Alle Kernbefunde werden deshalb dokumentiert statt behoben. Die
Statuszeilen weisen das jeweils als `dokumentiert statt behoben` aus.

### 0.4 Statusübersicht

| Status | Punkte |
|---|---|
| `erledigt` | M-01, M-05, M-07, R-01, R-07 |
| `teilweise erledigt` | M-03, R-03, R-04, K-14 |
| `umgewidmet — Messgegenstand` | K-01, K-02 |
| `dokumentiert, Einflussfreiheit belegt` | K-03, K-04 |
| `dokumentiert statt behoben` | R-08, R-09, K-05, K-06, K-09, K-10 |
| `offen` | M-02, M-04, M-06, R-02, R-05, R-06, K-07, K-08, K-11, K-12, K-13 |

Kein Punkt ist unbewertet. Für die verbleibenden `offen`-Punkte gilt: keiner
davon berührt die Gültigkeit einer berichteten Messgröße.

---

## 1. Kurzbewertung

Der Kern ist modular aufgebaut, besitzt keine externen npm-Abhängigkeiten und
hat eine belastbare Unit- und Hook-Testbasis. Am 11. August 2026 bestanden unter
Node.js 20.19.0 alle 69 vorhandenen Tests; am 12. August 2026 wurde derselbe
Stand zusätzlich unter Node.js 22.22.2 verifiziert (69/69).

Vor einer finalen Abgabe sollten jedoch mehrere Punkte bearbeitet werden. Die
wichtigsten wissenschaftlichen Risiken sind derzeit nicht die allgemeine
Codeorganisation, sondern einzelne Policy-Grenzfälle, die Verlässlichkeit der
Messprotokollierung und die genaue Definition des gemessenen Overheads.

Die Prioritäten bedeuten:

- **P0:** vor der Bachelorabgabe klären oder beheben; kann Aussagen zur
  Schutzwirkung oder Messvalidität beeinflussen.
- **P1:** für einen gepflegten finalen Artefaktstand sehr empfohlen.
- **P2:** sinnvolle Weiterentwicklung, aber bei sauberer Dokumentation kein
  zwingender Abgabeblocker.

## 2. Pflegezustand

### M-01 — Veraltete Anforderungsdokumentation (**P0**)

**Status (12.08.2026):** `erledigt` — `docs/requirements.md` am 12.08.2026 saniert: Statusmodell für alle 32 Anforderungen, §11 auf Ist-Stand, §13 als historisch gekennzeichnet, §17 Abweichungen und §18 Einschränkungen ergänzt.

**Beanstandung:** `docs/requirements.md` trägt den Stand 20. Mai 2026 und nennt
bereits implementierte Funktionen weiterhin als offene Designentscheidungen
oder nächste Schritte. Unter anderem werden zusätzliche Tests, generische
Targets, Outside-Workspace-Regeln und ein grüner Testlauf noch als zukünftige
Arbeit beschrieben.

**Maßnahme:**

1. Anforderungen von historischen Arbeitsnotizen trennen.
2. Jede Anforderung als `erfüllt`, `teilweise erfüllt`, `offen` oder
   `bewusst außerhalb des Scopes` markieren.
3. Den aktuellen Test- und Implementierungsstand referenzieren.
4. Alte Planungsabschnitte entweder entfernen oder als historischen Stand
   eindeutig kennzeichnen.

**Akzeptanzkriterium:** Kein als aktuell bezeichneter Abschnitt widerspricht dem
Quellcode oder den vorhandenen Tests.

### M-02 — Doppelte Konfigurationsschemata (**P1**)

**Status (12.08.2026):** `offen` — Beide Schemata sind derzeit deckungsgleich, aber nicht gegeneinander abgesichert. Vorschlag: Gleichheitstest in `scripts/check.sh` statt Codeänderung.

**Beanstandung:** Das Konfigurationsschema steht sowohl in
`openclaw.plugin.json` als auch in `src/index.js`. Beide Fassungen können sich
unbemerkt auseinanderentwickeln.

**Maßnahme:** Eine Quelle als kanonisch festlegen und die zweite Darstellung
daraus generieren oder ihre Gleichheit automatisiert testen.

**Akzeptanzkriterium:** Ein Test schlägt fehl, sobald Felder, Defaults, Enums
oder Validierungsregeln voneinander abweichen.

### M-03 — Uneinheitliche Benennung und Versionspflege (**P1**)

**Status (12.08.2026):** `teilweise erledigt` — Die README benennt `guardrail-spike` jetzt als kanonische Plugin-Kennung mit eigenem Schritt und Troubleshooting-Eintrag. Die Version `0.1.0` bleibt an drei Stellen hartcodiert.

**Beanstandung:** Im Repository werden `guardrail-spike`, `Guardrail Spike` und
`OpenClaw Guardrail Plugin` parallel verwendet. Die Version `0.1.0` ist in
Manifest, Paketmetadaten und Laufzeitlog mehrfach hartcodiert.

**Maßnahme:**

- einen technischen Plugin-Identifier unverändert festlegen,
- einen einheitlichen Anzeigenamen verwenden,
- die Version aus einer kanonischen Quelle übernehmen oder auf Konsistenz
  testen.

**Akzeptanzkriterium:** Identifier, Anzeigename und Version sind dokumentiert
und können nicht unbemerkt divergieren.

### M-04 — Experimentelle Diagnose-Hooks im Hauptpfad (**P1**)

**Status (12.08.2026):** `offen` — Bewusst zurückgestellt: Das Entfernen der Hooks wäre eine Änderung an `src/index.js` und würde die eingefrorene Messreferenz entwerten (siehe §0.3).

**Beanstandung:** `before_agent_run`, `model_call_started` und `agent_end`
schreiben zusätzliche Debug-Ereignisse. Das erhöht Logvolumen und koppelt das
Plugin an weitere OpenClaw-Lifecycle-APIs, obwohl die Guardrail-Funktion primär
`before_tool_call` benötigt.

**Maßnahme:** Diagnose-Hooks entfernen oder hinter ein standardmäßig
deaktiviertes `diagnostics.enabled` stellen.

**Akzeptanzkriterium:** Der Standardbetrieb registriert nur Hooks, die für
Durchsetzung oder definierte Messgrößen erforderlich sind.

### M-05 — Repository-Aufräumung (**P1**)

**Status (12.08.2026):** `erledigt` — `testdatei.txt` entfernt. Zusätzlich wurde ein schwerwiegenderer Fund behoben, siehe **M-07**.

**Beanstandung:** `testdatei.txt` ist ein funktionsloses Testartefakt. Die
Historie enthält außerdem generische Commit-Nachrichten wie `test commit`.

**Maßnahme:** `testdatei.txt` entfernen. Die Git-Historie muss für die Abgabe
nicht umgeschrieben werden; stattdessen einen sauberen finalen Commit und Tag
mit aussagekräftiger Beschreibung erstellen.

**Akzeptanzkriterium:** Jeder im Abgabe-Commit enthaltene Pfad hat eine
nachvollziehbare Funktion.

### M-06 — Einheitlicher Stil und statische Prüfungen (**P2**)

**Status (12.08.2026):** `offen` — Vorschlag: `scripts/check.sh` als ein Befehl für Tests, JSON-Syntax und Schema-Abgleich — ohne neue Abhängigkeiten.

**Beanstandung:** Es existieren keine dokumentierte Formatierungsregel und keine
statische Prüfung für JavaScript, JSON, Markdown oder Shell.

**Maßnahme:** Leichte, reproduzierbare Prüfungen ergänzen, beispielsweise
Syntaxprüfung, Format-Check und Shell-Lint. Zusätzliche Abhängigkeiten nur dann
aufnehmen, wenn der Nutzen für das Abgabeartefakt den Reproduktionsaufwand
rechtfertigt.

**Akzeptanzkriterium:** Ein einzelner Check-Befehl prüft Tests, JSON-Syntax und
die wichtigsten Format-/Lint-Regeln.

### M-07 — Mitgelieferte Korpora waren nicht versioniert (**P0**)

**Status (12.08.2026):** `erledigt` — behoben in der Root-`.gitignore`.

**Beanstandung:** Zeile 3 der Root-`.gitignore` lautete `*.jsonl` und wirkte
rekursiv auf das gesamte Repository. Dadurch waren **alle 13** JSONL-Korpora des
Harness ungetrackt, darunter `harness/corpora/examples/minimal_policy.jsonl` und
die vier Dateien unter `harness/corpora/pilot/`.

**Auswirkung:** Ein frischer Clone hätte keine Korpora enthalten. Damit wäre
Schritt 4 der `harness/README.md` (`./bin/harness offline pilot E1 E2 E3`)
gescheitert — genau der Schritt, mit dem ein Prüfer die Installation
verifizieren soll.

**Maßnahme:** Die Regel bleibt bestehen, damit Laufzeit-JSONL nicht versioniert
wird; für die mitzuliefernden Korpora wurde eine Ausnahme ergänzt:

```gitignore
*.jsonl
!harness/corpora/**/*.jsonl
```

`harness/.gitignore` liegt tiefer und behält Vorrang. Die privaten
Forschungskorpora unter `corpora/research/`, `corpora/private/` und
`corpora/custom/` bleiben dadurch weiterhin ungetrackt.

**Akzeptanzkriterium:** Ein frischer Clone enthält `corpora/examples/` und
`corpora/pilot/`, aber keine Laufzeitprotokolle und keine privaten
Forschungskorpora. Verifiziert am 12.08.2026 per `git check-ignore`.

## 3. Release-Hygiene

### R-01 — Fehlender Lizenztext (**P1**)

**Status (12.08.2026):** `erledigt` — `LICENSE` (MIT) vorhanden, in der README referenziert.

**Beanstandung:** Ohne `LICENSE` ist zwar die Begutachtung als Teil der Arbeit
möglich, eine allgemeine Nutzung, Veränderung oder Weitergabe aber nicht
eindeutig geregelt.

**Maßnahme:** Mit Hochschule und Betreuer klären, ob und unter welcher Lizenz
der Quellcode veröffentlicht werden darf. Anschließend `LICENSE` ergänzen und
den Lizenzstatus in der README aktualisieren.

**Akzeptanzkriterium:** Rechte und erlaubte Nutzung sind für Prüfer und spätere
Leser eindeutig.

### R-02 — Fehlende Zitier- und Autorenmetadaten (**P1**)

**Status (12.08.2026):** `offen` — `CITATION.cff` fehlt weiterhin.

**Beanstandung:** Das Repository nennt noch keine zitierfähige Artefaktversion,
Autorenangabe oder Verbindung zur finalen Bachelorarbeit.

**Maßnahme:** `CITATION.cff` oder einen äquivalenten Zitierhinweis ergänzen. Nach
Abgabe Titel, Autor, Jahr, Hochschule, Repository-Version und gegebenenfalls
DOI/Archivlink eintragen.

**Akzeptanzkriterium:** Ein Dritter kann Quellcode und Arbeit eindeutig
zitieren.

### R-03 — Veränderliches Judge-Modell (**P0**)

**Status (12.08.2026):** `teilweise erledigt` — README und `requirements.md` §18 E-6 weisen den Bezeichner jetzt ausdrücklich als veränderlich aus und verweisen für den maßgeblichen Stand auf das Laufmanifest. Die Archivierung der Modell-Digests bleibt offen.

**Beanstandung:** `devstral-small-2:latest` ist kein unveränderlicher
Modellbezeichner. Derselbe Konfigurationsstring kann später ein anderes Modell
beziehungsweise andere Gewichte laden und damit Ergebnisse verändern.

**Maßnahme:** Für alle berichteten Experimente Modell-Digest, Ollama-Version,
Modellmetadaten und relevante Inferenzparameter archivieren. In finalen
Konfigurations-Snapshots möglichst einen unveränderlichen Digest verwenden.

**Akzeptanzkriterium:** Für jeden Judge-Lauf lässt sich eindeutig bestimmen,
welche Modellgewichte und welche Laufzeit verwendet wurden.

### R-04 — Kompatibilitätsstand nicht maschinenlesbar (**P1**)

**Status (12.08.2026):** `teilweise erledigt` — Die README enthält jetzt eine Kompatibilitätsmatrix und nennt Node 20.19.0 sowie 22.22.2 als verifiziert. `engines.node` in `package.json` fehlt weiterhin.

**Beanstandung:** `package.json` enthält kein `engines.node`. Die geprüfte
OpenClaw-Version ist nur dokumentarisch festgehalten.

**Maßnahme:** Node-Laufzeit in `package.json` eingrenzen und eine kleine
Kompatibilitätsmatrix für Node, OpenClaw, Docker Compose, Ollama und Betriebssystem
führen. Nicht getestete Kombinationen ausdrücklich als solche markieren.

**Akzeptanzkriterium:** Die für die Bachelorarbeit verwendete Umgebung ist ohne
Raten rekonstruierbar.

### R-05 — Kein finaler Release-Snapshot (**P1**)

**Status (12.08.2026):** `offen` — Kein Release-Tag, keine `CHANGELOG.md`.

**Beanstandung:** Es existiert noch kein Release-Tag und keine kurze Liste der
Änderungen des finalen Artefakts.

**Maßnahme:** Nach Abschluss aller P0/P1-Punkte einen finalen Tag erstellen,
beispielsweise `ba-submission-v1`, und Commit-ID sowie SHA-256 des
Abgabearchivs festhalten. Eine kurze `CHANGELOG.md` oder Release-Notiz reicht
für den Umfang der Arbeit aus.

**Akzeptanzkriterium:** Die in der Arbeit untersuchte Version ist unveränderlich
identifizierbar.

### R-06 — Keine automatisierte Repository-Prüfung (**P1**)

**Status (12.08.2026):** `offen` — Keine CI-Konfiguration.

**Beanstandung:** Die Tests sind lokal grün, werden aber nicht durch eine
versionierte CI-Konfiguration bei Änderungen wiederholt.

**Maßnahme:** Eine minimale CI für die festgelegte Node-Version ergänzen. Sie
soll mindestens `npm test`, JSON-Validierung und den Konsistenztest der Schemata
ausführen.

**Akzeptanzkriterium:** Der finale Commit besitzt einen nachweislich erfolgreichen
automatisierten Prüflauf oder ein archiviertes gleichwertiges Prüfprotokoll.

### R-07 — Plattformabhängige Zeilenenden (**P1**)

**Status (12.08.2026):** `erledigt` — `.gitattributes` vorhanden, erzwingt LF.

**Beanstandung:** Es gibt keine `.gitattributes`. Dadurch kann insbesondere
`scripts/deploy.sh` auf Windows mit CRLF ausgecheckt werden, obwohl das Skript
eine POSIX-Shell voraussetzt.

**Maßnahme:** Für `*.sh` LF erzwingen und Textdateien konsistent als UTF-8
behandeln.

**Akzeptanzkriterium:** Ein frischer Checkout liefert das Deploy-Skript mit
ausführbaren POSIX-Zeilenenden.

### R-08 — Riskanter Recovery-Pfad im Deploy-Skript (**P1**)

**Status (12.08.2026):** `dokumentiert statt behoben` — Die README enthält den Abschnitt „Grenzen des Deploy-Skripts", der den Recovery-Pfad ausdrücklich benennt. Ein Umbau des Skripts würde die für die Messreihen verwendete Deploymentprozedur verändern.

**Beanstandung:** Bei einem normalen Startfehler kann `deploy.sh` automatisch
Restart-Policies ändern, Container zwangsweise entfernen und Host-PIDs mit
`sudo kill -9` beenden. Das ist für die bekannte Versuchsumgebung erklärbar,
sollte aber nicht wie ein normaler Deployment-Schritt wirken.

**Maßnahme:** Recovery in ein separates Skript oder hinter einen expliziten
Schalter wie `--force-gateway-recovery` verschieben. Im Standardpfad bei Fehlern
mit Diagnose abbrechen.

**Akzeptanzkriterium:** Ein gewöhnlicher Deploy-Aufruf führt keine erzwungene
Prozess- oder Containerbeendigung aus.

### R-09 — Deployment-Verifikation kann Fehler übergehen (**P1**)

**Status (12.08.2026):** `dokumentiert statt behoben` — Ebenda benannt. Der verbindliche Nachweis ist stattdessen README-Schritt 9 (`plugin_loaded`-Ereignis mit Wertprüfung).

**Beanstandung:** Mehrere Prüfkommandos in `verify_inside_container` enden mit
`|| true`. Dadurch kann das Skript erfolgreich abschließen, obwohl Plugin,
Konfiguration oder Logdatei nicht verfügbar sind.

**Maßnahme:** Informative Diagnosen und zwingende Abnahmekriterien trennen. Als
Pflichtprüfungen mindestens Plugin-Dateien, aktive Plugin-Konfiguration,
`plugin_loaded`-Logereignis und Gateway-Health auswerten.

**Akzeptanzkriterium:** Das Skript meldet nur dann Erfolg, wenn das Plugin
nachweislich geladen wurde.

## 4. Kerncode

### K-01 — Externe Grep-Pattern-Dateien werden nicht als Eingabeziel geprüft (**P0**)

**Status (12.08.2026):** `umgewidmet — Messgegenstand` — Kein Defekt, sondern Klasse `parser_option_argument` (4 Fälle) im E1ext-Korpus. Dokumentiert als Abweichung **A-2** in `requirements.md` §17 und in der README unter „Aussagegrenzen". Siehe §0.2.

**Beanstandung:** Die Argumentanalyse behandelt den Wert von `grep -f` oder
`grep --file` als Pattern-Metadatum, nimmt den referenzierten Pfad aber nicht in
`targetInfos` auf. Dadurch wurden bei der Prüfung sowohl
`grep -f /etc/passwd local.txt` als auch
`grep --file=/etc/passwd local.txt` deterministisch erlaubt.

**Maßnahme:** Alle Optionen, die Dateien lesen, mit Typ und Pfad erfassen. Die
Pattern-Datei muss denselben Workspace-, Symlink- und Sensitive-Read-Prüfungen
unterliegen wie normale Suchziele.

**Akzeptanzkriterium:** Beide genannten Befehle sind nicht `allow`; äquivalente
Workspace-interne Pattern-Dateien bleiben entsprechend der Policy behandelbar.

### K-02 — Mutierende `find`-Primaries werden unvollständig erkannt (**P0**)

**Status (12.08.2026):** `umgewidmet — Messgegenstand` — Kein Defekt, sondern Klasse `find_write_primitive` (6 Fälle) im E1ext-Korpus. Dokumentiert als Abweichung **A-4**. Siehe §0.2.

**Beanstandung:** Der Parser erkennt `-delete`, `-exec` und `-execdir`, nicht
aber weitere aktions- oder schreibfähige Primaries. In der Prüfung wurden
`find . -fprint /tmp/out` und `find . -ok rm {} \;` als read-only erlaubt.
Betroffen sind mindestens `-fprint`, `-fprintf`, `-fls`, `-ok` und `-okdir`.

**Maßnahme:** `find` über eine explizite Allowlist tatsächlich read-onlyer
Primaries klassifizieren oder alle aktionsfähigen Primaries vollständig
erkennen. Output-Dateien müssen als eigene Ziele normalisiert werden.

**Akzeptanzkriterium:** Kein `find`-Ausdruck, der Dateien schreibt, löscht oder
Unterprogramme ausführen kann, erhält `allow`.

### K-03 — Shell-Expansionen sind nicht vollständig markiert (**P0**)

**Status (12.08.2026):** `dokumentiert, Einflussfreiheit belegt` — Dokumentiert als Abweichung **A-1**. Gegen alle 798 kommandoführenden Korpuszeilen geprüft: nur `echo $$` und `echo $?` betroffen, beide erhalten über andere Regeln ohnehin `escalate_llm`. Kein Einfluss auf berichtete Metriken.

**Beanstandung:** Brace Expansion und mehrere spezielle Shell-Parameter werden
nicht als unsicher erkannt. Bei der Prüfung wurden `ls {safe,/etc}` und
`ls $1` erlaubt. Weitere relevante Formen sind `$@`, `$*`, `$?`, `$$`, `$#`,
`$-`, `$0`, ANSI-C-Quoting `$'...'` und locale quoting `$"..."`.
Parserwarnungen wie nicht geschlossene Quotes oder ein abschließender Backslash
führen ebenfalls nicht automatisch zu einer konservativen Entscheidung.

**Maßnahme:** Jede nicht vollständig statisch auflösbare Shell-Expansion sowie
jeden Parserfehler als `hasUnsafeExpansion` beziehungsweise `complexShell`
markieren. Die Erkennung mit einer tabellarischen Bypass-Testmenge absichern.

**Akzeptanzkriterium:** Die genannten Formen und ihre Quote-Varianten können
nicht deterministisch `allow` ergeben.

### K-04 — Parameterloses `ls` berücksichtigt ein externes `workdir` nicht (**P0**)

**Status (12.08.2026):** `dokumentiert, Einflussfreiheit belegt` — Dokumentiert als Abweichung **A-6**. Gegen alle 798 kommandoführenden Korpuszeilen geprüft: **null** betroffene Fälle. Kein Einfluss auf berichtete Metriken.

**Beanstandung:** `ls` ohne Zielargument wird erlaubt, sobald keine Targets
vorliegen. Der tatsächliche implizite Zielpfad ist jedoch das Arbeitsverzeichnis.
Bei der Prüfung ergab `command="ls"` mit `workdir="/etc"` ein `allow`.

**Maßnahme:** Für Programme mit implizitem aktuellem Verzeichnis das `workdir`
als Ziel behandeln oder den Workspace-Scope vor der Read-only-Freigabe separat
prüfen.

**Akzeptanzkriterium:** Parameterlose Leseoperationen werden außerhalb des
Workspace nicht deterministisch erlaubt.

### K-05 — Gemessene Dauer schließt Logging nicht ein (**P0**)

**Status (12.08.2026):** `dokumentiert statt behoben` — Die Messgrenze steht jetzt ausdrücklich in der README (Teil 7) und in `requirements.md` §18 E-1. Die Trennung in `decisionDurationMs`/`loggingDurationMs` wäre eine Codeänderung.

**Beanstandung:** `guardrailDurationMs` wird berechnet, bevor der zugehörige
JSONL-Eintrag synchron geschrieben wird. `appendFileSync` verzögert den Hook
trotzdem. Der protokollierte Wert bildet daher nicht den vollständigen vom
Plugin verursachten Hook-Overhead ab. Weitere Approval-Logs liegen ebenfalls
außerhalb der Messgrenze.

**Maßnahme:** In der Methodik eine eindeutige Messgrenze festlegen und getrennte
Werte ausweisen, beispielsweise `decisionDurationMs`, `loggingDurationMs` und
vollständige Hook-Dauer. Den extern beobachteten End-to-End-Overhead als
Referenzmessung beibehalten.

**Akzeptanzkriterium:** Quellcode, Logfelddefinitionen und Methodikkapitel
beschreiben dieselbe Messgröße; Loggingkosten werden nicht irrtümlich als
Guardrail-frei behandelt.

### K-06 — Logfehler können Experimentdaten unbemerkt unvollständig machen (**P0**)

**Status (12.08.2026):** `dokumentiert statt behoben` — `requirements.md` §18 E-2; README-Schritt 7 macht die Prüfung des Logpfads zum verbindlichen Installationsschritt.

**Beanstandung:** `logger.append` fängt Schreibfehler ab und meldet sie nur über
`console.error`. Policy und Toolausführung laufen weiter. Das ist für
Verfügbarkeit vertretbar, kann aber einen Experimentlauf ohne vollständige
Messdaten erzeugen.

**Maßnahme:** Einen expliziten Experimentmodus mit `loggingRequired=true`
vorsehen oder vor jedem Lauf einen verbindlichen Log-Healthcheck durchführen.
Fehlgeschlagene Writes müssen maschinenlesbar gezählt und der Lauf als ungültig
markiert werden.

**Akzeptanzkriterium:** Ein nicht beschreibbarer Logpfad kann nicht zu einem als
gültig ausgewerteten Experimentlauf führen.

### K-07 — Rohbefehle können sensible Werte und Steuerzeichen enthalten (**P1**)

**Status (12.08.2026):** `offen` — Für den kontrollierten Versuchskorpus vertretbar, aber noch nicht ausdrücklich als Entscheidung dokumentiert.

**Beanstandung:** `rawCommand` wird in JSONL-Logs, Approval-Beschreibungen und
Judge-Prompts übernommen. Befehle können Tokens, Passwörter, Header oder
Terminal-/UI-Steuerzeichen enthalten. `safeJson` serialisiert, redigiert aber
nicht.

**Maßnahme:** Für Logs und UI eine klar definierte Redaktions- und
Steuerzeichenbereinigung einführen. Wenn Rohbefehle für einen kontrollierten
Korpus wissenschaftlich erforderlich sind, diese Entscheidung dokumentieren
und die Datenablage entsprechend schützen.

**Akzeptanzkriterium:** Standardlogs und Approval-UI geben keine offensichtlichen
Credential-Werte oder aktiven Steuersequenzen wieder.

### K-08 — Konservative Grenzen für den Judge fehlen (**P1**)

**Status (12.08.2026):** `offen` — Die erlaubten Judge-Übergänge sind in `docs/design.md` als Tabelle beschrieben, aber nicht auf Risikokategorien eingeschränkt.

**Beanstandung:** Wrapper, komplexe Shell-Syntax und unbekannte Programme werden
an den Judge eskaliert. Der Judge darf anschließend `allow` zurückgeben. Damit
können Prompt-Injection oder Fehlklassifikation die konservative Wirkung bei
Fällen reduzieren, die statisch bereits besonders riskant erscheinen.

**Maßnahme:** Für die Bachelorarbeit explizit festlegen, welche deterministischen
Risikokategorien der Judge überhaupt freigeben darf. Hochriskante Kategorien
gegebenenfalls auf `block` oder höchstens `require_approval` begrenzen.
Adversariale Judge-Tests mit eingebetteten Instruktionen ergänzen.

**Akzeptanzkriterium:** Die erlaubten Judge-Übergänge sind als Matrix definiert,
getestet und im Methodikkapitel identisch beschrieben.

### K-09 — Leere Target-Listen aktivieren unerwartet die Defaults (**P1**)

**Status (12.08.2026):** `dokumentiert statt behoben` — `requirements.md` §18 E-3 und README, Teil 6.

**Beanstandung:** Leere Arrays für `protectedTargets` oder `approvalTargets`
werden wie fehlende Konfiguration behandelt und durch `guardrail-lab`-Defaults
ersetzt. Damit kann ein Nutzer die Listen nicht bewusst leeren, obwohl das
Schema leere Arrays zulässt.

**Maßnahme:** Zwischen `undefined` und `[]` unterscheiden. Fehlend bedeutet
Default, leer bedeutet bewusst keine Ziele. Die gewünschte Semantik in
Manifest, README und Tests festhalten.

**Akzeptanzkriterium:** Leere, fehlende und ungültige Konfiguration besitzen
jeweils eindeutig getestetes Verhalten.

### K-10 — Konfigurationsschema akzeptiert Tippfehler (**P1**)

**Status (12.08.2026):** `dokumentiert statt behoben` — `requirements.md` §18 E-4 und README, Teil 6; Troubleshooting-Eintrag „Eine Konfigurationsänderung wirkt nicht".

**Beanstandung:** Die Hauptobjekte verwenden überwiegend
`additionalProperties: true`; `timeoutMs` besitzt keine positive Untergrenze.
Dadurch können falsch geschriebene Felder stillschweigend wirkungslos bleiben.

**Maßnahme:** Das kanonische Schema soweit kompatibel auf
`additionalProperties: false` setzen, numerische Grenzen ergänzen und
Altbezeichner ausdrücklich migrieren oder ablehnen.

**Akzeptanzkriterium:** Eine fehlerhafte Konfiguration scheitert sichtbar statt
mit unerwarteten Defaults weiterzulaufen.

### K-11 — Fehlendes Verdikt ist in einer Hilfsfunktion fail-open (**P1**)

**Status (12.08.2026):** `offen` — Der Hauptpfad ist abgesichert; der unsichere Default der exportierten Hilfsfunktion besteht fort.

**Beanstandung:** `resolveEnforcementAction` behandelt ein fehlendes Verdikt wie
`allow`. Der aktuelle Hauptpfad fängt Policy-Exceptions zwar ab, die exportierte
Hilfsfunktion besitzt aber einen unsicheren Default.

**Maßnahme:** Fehlende oder unbekannte Verdict-Strukturen grundsätzlich auf
`block` abbilden und durch Tests absichern.

**Akzeptanzkriterium:** Keine ungültige Entscheidungsstruktur kann technisch zu
`allow` führen.

### K-12 — Leerer Exec-Aufruf wird erlaubt (**P2**)

**Status (12.08.2026):** `offen` — Unverändert.

**Beanstandung:** Ein leerer Command erhält `exec.empty -> allow`. Das ist
weitgehend harmlos, aber für einen sicherheitsorientierten Enforce-Pfad semantisch
ungewöhnlich und kann fehlerhafte Hook-Payloads verdecken.

**Maßnahme:** Leere oder fehlende Commands mindestens als ungültig protokollieren
und bewusst zwischen Observe- und Enforce-Verhalten entscheiden.

**Akzeptanzkriterium:** Das Verhalten ist begründet, dokumentiert und getestet.

### K-13 — Approval-Parameter sind hartcodiert (**P2**)

**Status (12.08.2026):** `offen` — Unverändert.

**Beanstandung:** Timeout, erlaubte Entscheidungen und UI-Titel sind nicht Teil
des Konfigurationsschemas. Für Experimente ist der feste Wert reproduzierbar,
aber die Abhängigkeit bleibt implizit im Code.

**Maßnahme:** Entweder als bewusst feste Versuchsparameter dokumentieren oder
konfigurierbar machen und in jedem Lauf mitspeichern.

**Akzeptanzkriterium:** Die Approval-Parameter eines Ergebnislaufs sind aus
Konfiguration oder Artefaktversion eindeutig rekonstruierbar.

### K-14 — Teststrategie benötigt systematische Grenzfallabdeckung (**P1**)

**Status (12.08.2026):** `teilweise adressiert` — Die Grenzfälle sind über den E1ext-Korpus systematisch erfasst und mit Kontrollfällen abgesichert. Regressionstests in der lokalen Suite und ein versionierter OpenClaw-Smoke-Test fehlen weiterhin; README Teil 4 beschreibt den manuellen Smoke-Test.

**Beanstandung:** Die vorhandenen 69 Tests decken die Kernarchitektur gut ab,
haben die oben genannten Parser- und Argumentsemantikfälle aber nicht erkannt.
Ein echter OpenClaw-Smoke-Test ist ebenfalls nicht Teil der lokalen Testsuite.

**Maßnahme:**

- tabellengetriebene Tests für alle Optionsargumente und Shell-Expansionen,
- Regressionstests für K-01 bis K-04,
- Property-/Fuzz-Tests für „Varianten dürfen nie von block/escalate zu allow
  kippen“,
- kleiner versionierter OpenClaw-Smoke-Test für Laden, Allow, Block, Approval
  und Logkorrelation.

**Akzeptanzkriterium:** Jeder behobene P0-Fall besitzt mindestens einen
Regressionstest; ein dokumentierter Integrationstest bestätigt den Hook-Vertrag
der verwendeten OpenClaw-Version.

## 5. Empfohlene Reihenfolge

### Phase A — Wissenschaftlich kritische Korrekturen

1. K-01 bis K-04 als zunächst fehlschlagende Regressionstests ergänzen.
2. Parser und Scope-Logik korrigieren.
3. K-05 und K-06 mit dem Methodik- und Ergebniskapitel abgleichen.
4. Judge-Modell und Laufzeit gemäß R-03 unveränderlich dokumentieren.
5. Alle betroffenen Experimente darauf prüfen, ob ein Befund oder eine
   berichtete Metrik neu berechnet werden muss.

### Phase B — Konsistenter Abgabezustand

1. Anforderungen gemäß M-01 aktualisieren.
2. Namen, Versionen und Schemata gemäß M-02/M-03 konsolidieren.
3. Repository aufräumen und Debug-Funktionen begrenzen.
4. Lizenz-, Zitier- und Kompatibilitätsangaben ergänzen.
5. Deploy- und Verifikationsskript gegen unbeabsichtigte Recovery-Aktionen
   härten.

### Phase C — Freeze und Nachweis

1. Lokale Tests und statische Checks in einer sauberen Umgebung ausführen.
2. C0 bis C3 in der festgelegten OpenClaw-Umgebung als Smoke-Test prüfen.
3. Testprotokoll, Konfigurations-Snapshots und Modellmetadaten archivieren.
4. Finalen Commit und Release-Tag setzen.
5. Commit-ID und SHA-256 des Abgabearchivs in Arbeit beziehungsweise
   Begleitdokumentation aufnehmen.

## 6. Bereits solide und nicht grundsätzlich zu beanstanden

- klare Trennung von Normalisierung, Policy, Judge, Approval und Logging,
- keine Ausführung von Shell-Kommandos während der deterministischen Analyse,
- keine externen npm-Abhängigkeiten,
- deterministische Blockentscheidungen werden nicht vom Judge überschrieben,
- fail-closed Hauptpfad bei Policy-/Normalisierungsfehlern im Enforce-Modus,
- getrennte Felder für fachliches Verdikt und technische Durchsetzung,
- gute Testabdeckung der vier Experimentkonfigurationen und des
  Approval-Lifecycles,
- konfigurierbare Workspace-, Schutz- und Approval-Ziele,
- nachvollziehbare Regel-IDs und strukturierte JSONL-Ereignisse.

Diese Stärken rechtfertigen, das Repository als substanzielles
Bachelorarbeits-Artefakt einzuordnen.

Die Ursprungsfassung stellte für die P0-Punkte zwei Wege zur Wahl: beheben oder
– bei nachgewiesener Einflussfreiheit – ausdrücklich als Validitätsgrenze
dokumentieren. Mit der Fortschreibung vom 12. August 2026 ist der zweite Weg
gewählt und der Nachweis erbracht:

- K-01 und K-02 sind Messgegenstand von E1ext und dürfen nicht geschlossen
  werden, ohne den Befund zu entfernen (§0.2).
- Für K-03 und K-04 wurde die Einflussfreiheit gegen alle 798 kommandoführenden
  Korpuszeilen geprüft und belegt.
- Der Policy-Kern ist über `harness/vendor/plugin-baseline/` an die berichteten
  Läufe gebunden (§0.3).

Alle Abweichungen sind in `docs/requirements.md` §17 einzeln benannt, mit
gemessener Ist-Entscheidung und Angabe, ob sie von E1ext erfasst werden. Die
README weist sie unter „Aussagegrenzen" aus.
