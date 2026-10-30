# AGENTS.md

Guida per chi lavora sul codice (persone e agenti AI).

## Il progetto

**OSM Drive** è un gioco di guida nel browser su strade reali, costruite al volo da dati aperti: tile vettoriali OpenFreeMap, Overpass, Terrain Tiles e Photon (fonti e licenze nel [README](README.md)).

- **Niente build né dipendenze:** JavaScript puro e three.js r128 in `js/`. Si serve con `python3 serve.py`.
- **Origine:** il gioco è nato dal simulatore di prova di Diamond 3D Launcher (`../modern-3d-launcher`).
  - `index.html` è una copia di `app/src/main/assets/3d_viewer.html` di quel progetto: le funzioni globali (`setMapScene`, `updateMap`, `setSpeedCamera`, …) sono le stesse.
  - Gli script in `src/` le estendono o le sostituiscono dall'esterno.
  - Le modifiche alla vista del launcher non arrivano qui da sole.

## Struttura

Gli script si caricano in quest'ordine (fondo di `index.html`), ognuno espone un oggetto globale:

| File | Globale | Ruolo |
|---|---|---|
| `src/osm-match.js` | `OsmMatch` | grafo stradale, unione dei nodi tra tile, aggancio alla strada, percorsi |
| `src/osm-online.js` | `OsmOnline` | decodifica MVT (protobuf scritto a mano), conversione nel formato tile del launcher, Overpass (caselli, semafori, strisce, passaggi a livello, corsie) con rotazione dei server |
| `src/osm-terrain.js` | `Terrain` | altitudine Terrarium z13 lisciata, terreno, asfalto sopra il terreno, guardrail, cielo e nebbia |
| `src/osm-buildings.js` | `Buildings` | edifici estrusi, impronte per le collisioni, caselli |
| `src/osm-world.js` | `World` | uso del suolo, acqua, ferrovie, distributori, lampioni, alberi |
| `src/osm-sim.js` | `osmSim` | guida libera: fisica, cambio, collisioni, torna sulla strada. Con `?debug`, strumenti per l'aggancio alla strada |
| `src/osm-engine.js` | `Engine` | suono sintetizzato di motore, vento, gomme, pioggia |
| `src/osm-game.js` | — | interfaccia: mappa grande e minimappa, ricerca, navigazione, cielo e meteo, comandi touch |

- **`dev/`:** prove di stile per gli avvisi autovelox; non sono caricate.
- **`tools/traces.py`:** prepara in `data/traces/` le tracce GPS per i test in `?debug`.
- **`data/`:** è fuori da git.

## Coordinate

- **Proiezione:** `OsmMatch.project(lat, lon)` è una proiezione metrica equirettangolare centrata sul primo punto: x verso est, y verso nord, in metri.
- **Scena three.js:** `(-x*u, y0 + h*u, y*u)` con `u = 1/METERS_PER_UNIT` (1,2 m per unità) e `y0` = altezza della strada nella vista.
- **Oggetti della mappa:** vanno in `map.inner`.
- **Allontanamento:** oltre 30 km dall'origine il mondo si azzera e riparte attorno all'auto (`osmSim.recenter`).

## Provare

```sh
python3 serve.py                      # http://127.0.0.1:8765/
python3 serve.py . 0.0.0.0 8765       # da telefono sulla rete locale
for f in src/*.js; do node --check "$f"; done
```

- **Senza test automatici:** si prova nel browser, anche con una vista da telefono (`?touch` o user agent mobile, per esempio 844×390).
- **Overpass a volte non risponde:** senza Overpass mancano caselli, semafori, strisce, passaggi a livello e corsie; il resto funziona.
- **Errori:** si controlla la console.

## Convenzioni

- **Testi dell'interfaccia** in italiano; **commenti** in inglese, brevi, solo il perché.
- **Rete:**
  - una richiesta alla volta per servizio, con attesa e rotazione quando un server rifiuta;
  - non aumentare raggi o frequenze senza motivo, perché sono servizi pubblici gratuiti;
  - ogni dato scaricato va messo in cache per tile o cella.
- **Prestazioni:**
  - deve girare su un telefono;
  - geometrie unite per tile e istanze per gli oggetti ripetuti;
  - il dettaglio si disegna solo qualche centinaio di metri attorno all'auto;
  - la scena attorno all'auto (terreno, asfalto, linee) è in coordinate della mappa: in guida libera si ricostruisce solo quando l'auto si è spostata di qualche decina di metri o arrivano dati nuovi (`freeScene` in `osm-sim.js`), non a ogni fix.
- **Attribuzione:** ogni nuova fonte di dati va aggiunta alla riga di attribuzione in gioco e alla tabella del README.
- **Dati salvati:** solo in `localStorage`, niente server propri.
- **Commit:** solo quando richiesto.
