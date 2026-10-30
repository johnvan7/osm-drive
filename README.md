# OSM Drive

A driving game in the browser on real roads. Pick a point on the map or search for an address, and drive from there. Roads, buildings and terrain are built on the fly from OpenStreetMap and other open data, downloaded only for the area around the car.

**Play:** https://johnvan7.github.io/osm-drive/

## Run locally

Plain JavaScript and three.js, no build and no dependencies. Any static file server works; the bundled one only needs Python 3 and turns off browser caching:

```sh
python3 serve.py                      # http://127.0.0.1:8765/
python3 serve.py . 0.0.0.0 8765       # reachable from a phone on the same network
```

"My location" needs `localhost` or HTTPS.

| URL parameter | Effect |
|---|---|
| `?lang=it` | interface language: `it`, `en`, `es`, `fr` (default: the browser's language, else English) |
| `?touch` | on-screen controls on a computer too (phones get them automatically) |
| `?debug` | tools for testing road matching |

## Controls

| Key | Action |
|---|---|
| Arrows or WASD | steer, throttle, brake; hold brake when stopped to reverse |
| M | map: choose the start, navigate to a point |
| R | back to the nearest road |
| F | full screen |

On phones: ◀ ▶ and brake/throttle buttons. The gear in the top right corner opens the settings: day/night, weather, engine sound, language, back to the road, full screen.

## Data sources

| Data | Source |
|---|---|
| Roads, buildings, water, land cover, railways, place names; map and minimap | [OpenFreeMap](https://openfreemap.org) vector tiles (OpenMapTiles schema) |
| Toll booths, traffic signals, crossings, level crossings, lane counts | [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) (public instances, in rotation) |
| Elevation | [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) on AWS (Terrarium) |
| Address search, town names | [Photon](https://photon.komoot.io) by komoot |

These are free public services with usage policies: the game asks for one area at a time, caches what it gets and backs off when a server refuses.

## Credits and licences

- **Map data:** © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL); tiles © OpenMapTiles, served by OpenFreeMap.
- **Elevation:** Terrain Tiles; sources include SRTM, GMTED, ETOPO1 and EU-DEM (see their [attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)).
- **Car model:** "Kiri '10 - Low poly model" by Daniel Zhabotinsky, [Sketchfab](https://sketchfab.com/3d-models/kiri-10-low-poly-model-7fd6e15785fa4aa9bfd6e31eb7c97ba6), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); adapted (format, colours, wheels).
- **three.js** with GLTFLoader and OrbitControls: MIT, © 2010-2021 three.js authors.
