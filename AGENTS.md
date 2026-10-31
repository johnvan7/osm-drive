# AGENTS.md

Notes for anyone working on the code, people and AI agents alike.

## The project

**OSM Drive** is a browser driving game on real roads, built on the fly from open data: OpenFreeMap vector tiles, Overpass, Terrain Tiles and Photon (sources and licences in the [README](README.md)).

- **No build, no dependencies:** plain JavaScript and three.js r128 in `js/`. Serve it with `python3 serve.py` (alone) or `npx wrangler@4 dev` (with the online world).
- **Published** on a Cloudflare Worker (`wrangler.toml`): the static site from the repository root (`.assetsignore` keeps the rest out) and the realtime world on `/ws`. GitHub Pages also serves the game, joining the Worker's world.
- **`index.html`** holds the 3D view and its global functions (`setMapScene`, `updateMap`, `setUpcomingTurn`, …). The scripts in `src/` extend or replace them from outside.

## Structure

Scripts load in this order (bottom of `index.html`); each exposes one global:

| File | Global | Role |
|---|---|---|
| `src/osm-i18n.js` | `I18n` | language (`?lang=`, saved choice, browser language, else English), texts in it/en/es/fr, place names in the chosen language |
| `src/osm-match.js` | `OsmMatch` | road graph, joining nodes across tiles, road matching, routing |
| `src/osm-online.js` | `OsmOnline` | MVT decoding (hand-written protobuf), conversion to the matcher's tile format, Overpass (toll booths, signals, crossings, level crossings, lanes) with server rotation |
| `src/osm-terrain.js` | `Terrain` | smoothed Terrarium z13 elevation, ground, asphalt on the ground (narrower on a side where buildings close in), embankments where the ground stays below a road, guardrails, sky and fog |
| `src/osm-buildings.js` | `Buildings` | extruded buildings, footprints indexed by cell for collisions, road widths and roof heights, toll plazas |
| `src/osm-world.js` | `World` | land cover, water, railways, street lights (never on another road or in a building), trees |
| `src/osm-fuel.js` | `Fuel` | tank, consumption, fuel stations set beside their road at its level and slope (drawn here), filling up when stopped on a forecourt, roadside help |
| `src/osm-poi.js` | `Pois` | labels over places of interest in the 3D view: the most important near and ahead, at most 10 (7 on phones), kept apart on screen; can be turned off |
| `src/osm-sim.js` | `osmSim` | free driving: physics (slower, less grip and shaking off the asphalt), gearbox, collisions, back to the road. With `?debug`, road-matching tools |
| `src/osm-net.js` | `Net` | online: connection, updates paced by proximity, other cars drawn a moment behind with interpolation, collisions between cars, ghost for 5 s after a start or help, horns heard by distance (volume, delay, muffling, side) |
| `src/osm-engine.js` | `Engine` | synthesised engine, wind, tyre and rain sound, horn |
| `src/osm-game.js` | — | interface: big map and minimap, search, navigation, sky and weather, settings, touch controls |

- **`server/index.js`:** the Worker and its `World` Durable Object: one world, a grid of ~500 m cells; each update a player sends is answered with the 12 nearest in full and, every 5 s, the others roughly; horns are passed on to players within 500 m; the big map asks for what it shows (players by name from zoom 14, groups farther out). No timers, so it hibernates when nobody drives; nothing is stored.
- **`dev/`:** old style experiments, not loaded.
- **`tools/traces.py`:** prepares GPS traces in `data/traces/` for `?debug`.
- **`data/`:** local only, not in git.

## Coordinates

- **Projection:** `OsmMatch.project(lat, lon)` is an equirectangular metric projection centred on the first point loaded: x east, y north, in metres.
- **three.js scene:** `(-x*u, y0 + h*u, y*u)` with `u = 1/METERS_PER_UNIT` (1.2 m per unit) and `y0` the road height in the view.
- **Map objects** go in `map.inner`.
- **Far away:** beyond 30 km from the origin the world resets around the car (`osmSim.recenter`).

## Trying it out

```sh
python3 serve.py                      # http://127.0.0.1:8765/
python3 serve.py . 0.0.0.0 8765       # from a phone on the local network
for f in src/*.js; do node --check "$f"; done
```

- **No automated tests:** try it in the browser, also in a phone view (`?touch` or a mobile user agent, e.g. 844×390), and check the console.
- **Overpass is sometimes down:** without it toll booths, signals, crossings, level crossings and lane counts are missing; everything else works.

## Conventions

- **Interface texts:** never hard-coded; they go in `src/osm-i18n.js` in all four languages (it, en, es, fr) and are used through `I18n.t('key')`. The `?debug` tools are the exception, in Italian.
- **Comments** in English, short, only the why.
- **Network:**
  - one request at a time per service, with waits and rotation when a server refuses;
  - don't raise radii or frequencies without a reason: these are free public services;
  - cache everything downloaded, per tile or cell.
- **Performance:**
  - it must run on a phone;
  - geometry merged per tile, instancing for repeated objects;
  - detail only a few hundred metres around the car;
  - the scene around the car (ground, asphalt, lines) is in map coordinates: in free driving it is rebuilt only when the car has moved a few tens of metres or new data arrive (`freeScene` in `osm-sim.js`), not at every fix.
- **Attribution:** every new data source or asset goes in the in-game credits (`credits` in `osm-i18n.js`) and in the README.
- **Saved data:** `localStorage` only. The one backend is the realtime Worker: it keeps players in memory while they are connected and stores nothing.
- **Free plan:** Workers and Durable Objects have daily quotas; keep messages few (the client sends 5/s only with someone near, otherwise every 2-5 s) and never add server timers that keep the world awake.
- **Commits:** only when asked.
