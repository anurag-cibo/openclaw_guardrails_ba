# Hostvertrag und Runtime-Grenze

## Zielvertrag für den HAW-Host

Erforderlich:

- Linux x86-64,
- Bash,
- Docker Engine mit Zugriff für den ausführenden Benutzer,
- Docker Compose v2,
- ausreichend freier Speicher für Runtime-Image und Run-Artefakte,
- Zugriff auf das bereits vorhandene OpenClaw-Compose-Projekt.

Nicht als Hostinstallation erforderlich:

- Node.js,
- Python,
- Matplotlib oder NumPy.

Der erste Runtime-Stand enthält Node.js und Python aus Debian Bookworm. Die
maßgeblichen Metrikprogramme benötigen nur die Python-Standardbibliothek. Eine
separate Figuren-Laufzeit mit Matplotlib/NumPy wird erst nach Klärung der
aktuellen Grafikpipeline eingefroren.

## Warum zwei Grenzen vorgesehen sind

Der Host-Einstieg bleibt Bash, weil bereits das OpenClaw-System über Docker
Compose auf dem Host gesteuert wird. Die Kontroll- und Auswertungslogik läuft im
Runtime-Container. Dadurch muss der Container zunächst keinen Docker-Socket
erhalten.

Für Live- und Approval-Adapter ist ein separater Host-Runner festgelegt. Er
enthält Docker CLI und Compose und erhält den Docker-Socket. Damit bleiben auch
die historischen Python-Hilfsprogramme im Container und auf dem HAW-Host muss
kein Python installiert werden. Der Docker-Socket entspricht praktisch
Host-Rechten und muss in der Arbeit als Betriebsannahme dokumentiert werden.

Der Host-Runner ist strikt von der Offline-Kontrollschicht getrennt. Nur
`live.compose.yaml` mountet den Socket; `compose.yaml` bleibt offline und ohne
Hoststeuerung. `./bin/harness live preflight` prüft diese Zielgrenze read-only,
bevor ein Pilot freigegeben wird.

## Image-Fixierung

`image-lock.json` ist nach dem lokalen Container-Test als
`development-validated` markiert. Basis-Digest, lokale Image-ID, Plattform und
Laufzeitversionen sind festgehalten. Dieser Status ist noch keine Freigabe für
Messserien. Vor dem ersten HAW-Hauptlauf fehlen noch:

- SHA-256 eines exportierten Image-Archivs,
- `docker version` und `docker compose version` des Zielhosts.

Damit kann dasselbe Image bei fehlendem Registry-/Internetzugriff als Datei auf
den HAW-Host übertragen und mit `docker load` importiert werden.

## Image-ID-Darstellung beim Transfer

Docker Desktop und ein Linux-Image-Store können für dasselbe importierte Archiv
unterschiedliche `.Id`-Darstellungen liefern. Lokale Build-ID und beobachtete
HAW-Import-ID bleiben deshalb getrennte Sekundärmerkmale. Autoritativ ist der
SHA-256 des vollständigen Exportarchivs; der Preflight akzeptiert die
HAW-Import-ID ausschließlich zusammen mit diesem erfolgreichen Hashnachweis.

## Noch offene Zielhostdaten

Der Befehl `./bin/harness host-info` sammelt ausschließlich technische Angaben:
Kernel/Architektur, UID/GID, Docker-/Compose-Version, Socket-Rechte, sichtbare
OpenClaw-Dienste und freien Speicher. Er liest keine Umgebungsvariablen,
Konfigurationsinhalte oder Secrets aus.
