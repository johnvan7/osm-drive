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
| `?at=lat,lon&da=name` | an invitation: the map opens there, ready to start near a friend |

## Online

Everyone driving meets on the same map, no rooms: other players' cars appear when they are near (up to the 12 nearest, with collisions). While driving, the nearest are listed on screen (on phones behind the people button) and shown on the minimap. The horn is heard by players within 500 m as it would be for real: quieter, duller and later (sound travels at 343 m/s) the farther they are, from their side. The big map shows who is playing, before the start too: each player with their name up close, groups with how many farther out (rounded to about 1 km); tap a player to start near them, or to join them while driving. **Invite friends** in the settings makes a message with your town and a link to your approximate position (about 100 m). Online can be turned off in the settings to play alone.

What other players see: the name you choose and your car's position while you drive. Nothing is stored on the server.

To run it locally with the realtime server (Node.js needed):

```sh
npx wrangler@4 dev                     # http://127.0.0.1:8787/
```

With `python3 serve.py` the game works alone, without the other players.

## Controls

| Key | Action |
|---|---|
| Arrows or WASD | steer, throttle, brake; hold brake when stopped to reverse |
| M | map: choose the start, navigate to a point (after a reload it opens where you last were) |
| H | horn (hold) |
| R | back to the nearest road |
| F | full screen |

On phones: ◀ ▶, brake/throttle and horn buttons. The gear in the top right corner opens the settings: day/night, engine sound, places of interest, fuel, language, online and your name, invite friends, back to the road, full screen.

**Fuel:** a tank lasts about 40 km. Fill up at a real fuel station by stopping under its canopy; on reserve the game offers to take you to the nearest one, and if you run dry roadside help brings you there. Fuel can be turned off in the settings.

## Data sources

| Data | Source |
|---|---|
| Roads, buildings, water, land cover, railways, place names, places of interest; map and minimap | [OpenFreeMap](https://openfreemap.org) vector tiles (OpenMapTiles schema) |
| Toll booths, traffic signals, crossings, level crossings, lane counts | [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) (public instances, in rotation) |
| Elevation | [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) on AWS (Terrarium) |
| Address search, town names | [Photon](https://photon.komoot.io) by komoot |
| Other players | a [Cloudflare Workers](https://workers.cloudflare.com) Durable Object (`server/`) |

These are free public services with usage policies: the game asks for one area at a time, caches what it gets and backs off when a server refuses.

## Credits and licences

- **Map data:** © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL); tiles © OpenMapTiles, served by OpenFreeMap.
- **Elevation:** Terrain Tiles; sources include SRTM, GMTED, ETOPO1 and EU-DEM (see their [attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)).
- **Car model:** "Kiri '10 - Low poly model" by Daniel Zhabotinsky, [Sketchfab](https://sketchfab.com/3d-models/kiri-10-low-poly-model-7fd6e15785fa4aa9bfd6e31eb7c97ba6), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); adapted (format, colours, wheels).
- **three.js** with GLTFLoader and OrbitControls: MIT, © 2010-2021 three.js authors.
