# Betriebsgrenzen, Sicherheit und Limitationen

## Ausfuehrungsgrenzen

Der Control-Container besitzt keinen Docker-Socket und arbeitet fuer
Offline-Experimente ohne Netzwerk. Judge-Laeufe erhalten nur das konfigurierte
Judge-Netzwerk. Live-Laeufe verwenden einen getrennten Host-Runner mit
`/var/run/docker.sock`; dieser Zugriff entspricht praktisch Host-Rechten.

`./bin/harness live preflight` prueft Host, Docker, Compose, Socket,
OpenClaw-Dienste, Modelle, Image-Identitaet und den read-only Korpus-Mount,
bevor eine Live-Konfiguration veraendert wird.

Bei einem erstmaligen Image-Import wird das Exportarchiv per SHA-256 geprueft
und die resultierende Linux-Docker-ID in der Lockdatei festgehalten. Eine
eigenstaendig entpackte Quell-Distribution muss dieses mehr als 100 MB grosse
Transportarchiv nicht dauerhaft mitfuehren: Fehlt es spaeter, wird die aktuell
geladene Image-ID gegen die bereits auf dem Zielhost validierte Import-ID
geprueft. Ist ein Exportarchiv vorhanden, aber sein Hash falsch, bleibt der
Preflight weiterhin gesperrt.

## Hostvoraussetzungen

Python und Node.js sind Bestandteile der Container und keine
Hostvoraussetzung. Unterstuetzt und validiert ist Linux x86-64 mit Bash,
Docker Engine und Docker Compose v2. Andere Plattformen sind nicht freigegeben.

## Bekannte Limitationen

- Agenten koennen den Tool-Aufruf verweigern; dies wird als `no_tool_call`
  ausgewiesen.
- Laufzeiten haengen stark von Modell und Hardware ab.
- Live-Adapter konfigurieren und starten das OpenClaw-Gateway neu.
- Gleichzeitige Live-Laeufe sind durch ein exklusives Lock gesperrt.
- Der kurze Standard-Smoke-Test ist ein technischer Funktionsnachweis und
  ersetzt keine statistisch belastbare Messserie.
- Der profilgebundene Hauptlauf samt automatischem Metrikbundle ist
  freigegeben. Grafikerzeugung gehoert bewusst nicht zum Produktumfang.

## E6a-Testtreiber

Der kurze E6a-Smoke prueft den Approval-Lifecycle deterministisch ueber das
optionale Plugin-Tool `guardrail_e6_exec`. Es ist in der validierten
Plugin-Version standardmaessig deaktiviert und wird vom Adapter nur fuer die
Dauer von E6a aktiviert. Akzeptiert werden die Read-only-Probe `pwd` und exakt
der feste Befehl `rm -rf guardrail-lab/tmp`; andere Befehle werden abgewiesen.
Das Ziel wird zusaetzlich gegen den Workspace und den festen relativen
Fixture-Pfad geprueft. Der Adapter stellt den vorherigen Konfigurationswert beim
Beenden wieder her.

Damit ist das Tool eng begrenzt, bleibt aber Versuchsinstrumentierung im
Produktivpfad des derzeitigen Guardrail-Plugins. Eine bereinigte
Produktarchitektur sollte diesen Treiber als separates test-only Fixture-Plugin
bereitstellen. Er darf nicht ersatzlos entfernt werden, solange E6a ihn noch als
Kompatibilitaetsschnittstelle verwendet. E5 und E6b pruefen dagegen den normalen
Agent-/Core-exec-Pfad.

## Daten

Private Korpora, Run-Artefakte, Transferarchive und interne
Entwicklungsdokumente gehoeren nicht in die oeffentliche Distribution. Der
oeffentliche Paketbau verwendet eine Allowlist und erzeugt ein Manifest mit
SHA-256 fuer jede enthaltene Datei.
