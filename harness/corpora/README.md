# Testkorpora und Datengrenze

- `examples/` enthaelt minimale Formatbeispiele ohne Studienbezug.
- `pilot/` enthaelt die kleinen, noch zu pruefenden Kandidaten fuer den
  oeffentlichen Beispielpiloten.
- `custom/` ist ein ignorierter lokaler Arbeitsbereich fuer neue Korpora.
- `private/` ist ein ignorierter lokaler Ablageort fuer Forschungsdaten.
- Die eingefrorenen historischen Korpora bleiben waehrend der Entwicklung
  unveraendert unter `corpora/research/`; sie gehoeren nicht zur geplanten
  oeffentlichen Distribution.

Eigene Korpora werden nicht in `pilot/` kopiert. Sie werden spaeter ueber eine
externe Konfiguration referenziert. Format, Validierung und Registrierung sind
bis zur oeffentlichen Dokumentation intern in `docs/KORPUSFORMAT.md`
beschrieben.
