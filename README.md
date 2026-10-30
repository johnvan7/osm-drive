# OSM Drive

Gioco di guida nel browser su strade vere: scegli un punto sulla mappa o cerchi un indirizzo e guidi da lì. Strade, edifici e terreno arrivano da OpenStreetMap e da altri dati aperti, scaricati per la zona in cui ti trovi.

È nato come simulatore di prova di [Diamond 3D Launcher](../modern-3d-launcher) e ne riusa la vista 3D (`index.html` è una copia di `app/src/main/assets/3d_viewer.html`).

## Avvio

Serve solo Python 3 (nessuna dipendenza da installare):

```sh
python3 serve.py                      # http://127.0.0.1:8765/
python3 serve.py . 0.0.0.0 8765       # raggiungibile da telefono sulla stessa rete
```

Il server non fa usare la cache al browser, così ogni ricarica prende i file aggiornati. La posizione del dispositivo ("La mia posizione") funziona solo su `localhost` o in HTTPS.

Parametri utili nell'indirizzo:

| Parametro | Effetto |
|---|---|
| `?touch` | comandi a schermo anche su computer (sui telefoni si attivano da soli) |
| `?debug` | strumenti per provare l'abbinamento alla strada (percorsi simulati, tracce GPS) |
| `?local` | strade dalle tile locali in `data/tiles/` invece che online (generate da `prototypes/osm/build_tiles.py` del launcher) |

## Comandi

| Tastiera | Azione |
|---|---|
| Frecce o WASD | sterzo, gas, freno; da fermo, tenendo il freno si va in retromarcia |
| M | mappa (scelta della partenza, navigazione verso un punto) |
| R | torna sulla strada più vicina |
| F | schermo intero |

Su telefono ci sono i pulsanti ◀ ▶ FRENO GAS e i pulsanti Mappa e Opzioni.

## Da dove vengono i dati

Tutto viene scaricato durante il gioco, solo per la zona attorno all'auto o inquadrata sulla mappa.

| Dato | Fonte | Dettagli |
|---|---|---|
| Strade (nomi, classi, sensi unici, ponti, gallerie), edifici, acqua, vegetazione, ferrovie, distributori, luoghi | [OpenFreeMap](https://openfreemap.org), tile vettoriali schema OpenMapTiles, zoom 14 | `src/osm-online.js`; dati © OpenStreetMap contributors (ODbL), © OpenMapTiles |
| Mappa grande e minimappa | OpenFreeMap, le stesse tile, disegnate nel canvas | `src/osm-game.js` |
| Caselli, semafori, attraversamenti, passaggi a livello, corsie delle strade | [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) (overpass-api.de, overpass.private.coffee, overpass.kumi.systems a rotazione) | `src/osm-online.js`; celle da 0,1° attorno all'auto, una richiesta alla volta, interrotta dopo 30 s se il server non risponde. Le tile vettoriali non contengono questi dati. Se Overpass non risponde, mancano |
| Altitudine del terreno | [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) su AWS, formato Terrarium, zoom 13 | `src/osm-terrain.js`; fonti: SRTM, GMTED, ETOPO1, EU-DEM e altre (vedi la loro attribuzione) |
| Ricerca indirizzi, comune sotto il nome della strada | [Photon](https://photon.komoot.io) di komoot (ricerca e ricerca inversa) | `src/osm-game.js`; dati OpenStreetMap |
| Posizione del sole (giorno, notte, alba, tramonto) | calcolata in locale | `src/osm-game.js` |

I servizi pubblici gratuiti (Overpass, Photon, OpenFreeMap) hanno regole d'uso: poche richieste, niente scaricamenti massicci. Il gioco chiede un blocco alla volta e rallenta quando un server rifiuta.

## Struttura

```
index.html          vista 3D (copia di quella del launcher) più gli script del gioco
src/
  osm-online.js     tile vettoriali OpenFreeMap e dati Overpass
  osm-match.js      grafo stradale, aggancio alla strada, percorsi
  osm-terrain.js    altitudine, terreno, asfalto, guardrail, cielo
  osm-buildings.js  edifici e caselli
  osm-world.js      acqua, ferrovie, distributori, lampioni, alberi
  osm-sim.js        fisica dell'auto, cambio, collisioni
  osm-engine.js     suono del motore
  osm-game.js       interfaccia: mappa, ricerca, navigazione, opzioni, comandi touch
dev/                prove di icone e avvisi autovelox, non caricate da index.html
tools/traces.py     tracce GPS pubbliche OSM (data/traces-p*.gpx) in data/traces per ?debug
data/               dati locali facoltativi, fuori da git
js/                 three.js r128, GLTFLoader, OrbitControls
kiri10.glb          modello dell'auto
serve.py            server statico senza cache
```

## Licenze di terze parti

- **three.js** (con GLTFLoader e OrbitControls): licenza MIT, © 2010-2021 three.js authors.
- **Modello 3D** "Kiri '10 - Low poly model" di Daniel Zhabotinsky, [Sketchfab](https://sketchfab.com/3d-models/kiri-10-low-poly-model-7fd6e15785fa4aa9bfd6e31eb7c97ba6), licenza [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); adattato (formato, colori, ruote).
- **Dati cartografici:** © OpenStreetMap contributors, licenza [ODbL](https://www.openstreetmap.org/copyright); tile © OpenMapTiles, servite da OpenFreeMap. L'attribuzione è mostrata in gioco.
