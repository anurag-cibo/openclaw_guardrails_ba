# Runtime

Der HAW-Host benötigt weder Python noch Node.js. Zwei lokal geprüfte Images
trennen die Ausführungsgrenzen:

- `guardrail-harness-runtime:dev`: Offline-/Judge-Kontrollschicht; kein
  Docker-Socket, im Offline-Modus kein Netzwerk.
- `guardrail-harness-host-runner:dev`: nur für E5/E6; enthält zusätzlich die
  gepinnte Docker CLI 24.0.6 und Compose 2.23.0.

Der Host-Runner erhält `/var/run/docker.sock`. Dieser Zugriff entspricht
praktisch Host-Rechten und ist deshalb technisch und methodisch ausdrücklich
als Betriebsannahme behandelt. Der read-only Zielhosttest lautet:

```bash
./bin/harness live preflight
```

Die konkreten Image-IDs stehen in `image-lock.json` und
`host-runner-lock.json`. Export-SHA-256 und lokale Build-IDs sind fixiert; vor
dem HAW-Pilot fehlt weiterhin die vollständig grüne Zielhostvalidierung.

Docker Desktop und der Linux-Image-Store können nach `docker load` für dasselbe
Archiv unterschiedliche `.Id`-Darstellungen anzeigen. Deshalb werden lokale
Build-ID und beobachtete HAW-Import-ID getrennt geführt. Primärer
Identitätsbeleg ist der SHA-256 des vollständigen Exportarchivs; eine
HAW-Import-ID wird nur zusammen mit diesem geprüften Archivhash akzeptiert.
