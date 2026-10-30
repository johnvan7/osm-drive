// Online data for the browser game, in the tile format of build_tiles.py so the matcher and the viewer keep working:
// roads, names, built-up areas and buildings from the OpenFreeMap vector tiles (OpenMapTiles schema, zoom 14),
// toll booths, signals, crossings and lanes from Overpass
const OsmOnline = (() => {
    const Z = 14, RAD = Math.PI / 180;
    const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
    const CLASS = { motorway: 'motorway', trunk: 'trunk', primary: 'primary', secondary: 'secondary', tertiary: 'tertiary', minor: 'unclassified', service: 'service' };
    const SKIP_SERVICE = ['parking_aisle', 'driveway', 'drive-through'];
    const URBAN = ['residential', 'commercial', 'retail'];
    let url = null;
    const buildings = new Map();   // tile key -> [{ rings: [[[lat, lon]...]...], h, min, colour }]
    const tolls = [];              // motorway toll booths: { lat, lon, name }
    const areas = new Map();       // tile key -> { water, waterways, cover, rails, fuel }

    async function init() {
        url = (await (await fetch('https://tiles.openfreemap.org/planet')).json()).tiles[0];
    }

    function tileOf(lat, lon) {
        const n = 2 ** Z, r = lat * RAD;
        return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)];
    }

    // ---- Mapbox Vector Tile decoding: protobuf, just what the layers below need ----
    const td = new TextDecoder();
    function decode(buf) {
        const b = new Uint8Array(buf), dv = new DataView(buf);
        let pos = 0;
        const varint = () => {
            let r = 0, s = 1, c;
            do { c = b[pos++]; r += (c & 0x7f) * s; s *= 128; } while (c & 0x80);
            return r;
        };
        const skip = wt => { if (wt === 0) varint(); else if (wt === 1) pos += 8; else if (wt === 2) pos += varint(); else if (wt === 5) pos += 4; };
        const string = () => { const l = varint(), s = td.decode(b.subarray(pos, pos + l)); pos += l; return s; };
        const packed = () => { const end = varint() + pos, out = []; while (pos < end) out.push(varint()); return out; };
        function value(end) {
            let v = null;
            while (pos < end) {
                const tag = varint(), f = tag >> 3;
                if (f === 1) v = string();
                else if (f === 2) { v = dv.getFloat32(pos, true); pos += 4; }
                else if (f === 3) { v = dv.getFloat64(pos, true); pos += 8; }
                else if (f === 4 || f === 5) v = varint();
                else if (f === 6) { const n = varint(); v = n % 2 ? -(n + 1) / 2 : n / 2; }
                else if (f === 7) v = !!varint();
                else skip(tag & 7);
            }
            return v;
        }
        const layers = {};
        while (pos < b.length) {
            const tag = varint();
            if (tag >> 3 !== 3) { skip(tag & 7); continue; }
            const end = varint() + pos, layer = { name: '', extent: 4096, keys: [], values: [], features: [] };
            while (pos < end) {
                const t = varint(), f = t >> 3;
                if (f === 1) layer.name = string();
                else if (f === 3) layer.keys.push(string());
                else if (f === 4) { const e = varint() + pos; layer.values.push(value(e)); }
                else if (f === 5) layer.extent = varint();
                else if (f === 2) {
                    const fe = varint() + pos, feat = { tags: [], type: 0, geom: [] };
                    while (pos < fe) {
                        const ft = varint(), ff = ft >> 3;
                        if (ff === 2) feat.tags = packed();
                        else if (ff === 3) feat.type = varint();
                        else if (ff === 4) feat.geom = packed();
                        else skip(ft & 7);
                    }
                    layer.features.push(feat);
                } else skip(t & 7);
            }
            for (const feat of layer.features) {
                feat.props = {};
                for (let i = 0; i < feat.tags.length; i += 2) feat.props[layer.keys[feat.tags[i]]] = layer.values[feat.tags[i + 1]];
            }
            layers[layer.name] = layer;
        }
        return layers;
    }

    // Lines or rings in tile units; a closed ring repeats its first point
    function geometry(cmds) {
        const out = [];
        let x = 0, y = 0, cur = null;
        for (let i = 0; i < cmds.length;) {
            const c = cmds[i++], id = c & 7, n = c >> 3;
            if (id === 7) { if (cur) cur.push(cur[0]); continue; }
            for (let k = 0; k < n; k++) {
                const dx = cmds[i++], dy = cmds[i++];
                x += dx % 2 ? -(dx + 1) / 2 : dx / 2;
                y += dy % 2 ? -(dy + 1) / 2 : dy / 2;
                if (id === 1) { cur = [[x, y]]; out.push(cur); } else cur.push([x, y]);
            }
        }
        return out;
    }

    // Lines cut at the tile's own edge: the neighbour draws the rest, and the cut points match on both sides
    function clipLine(line, E) {
        const out = [];
        let cur = null;
        for (let i = 0; i < line.length - 1; i++) {
            const [x0, y0] = line[i], [x1, y1] = line[i + 1], dx = x1 - x0, dy = y1 - y0;
            let t0 = 0, t1 = 1, ok = true;
            for (const [p, q] of [[-dx, x0], [dx, E - x0], [-dy, y0], [dy, E - y0]]) {
                if (p === 0) { if (q < 0) ok = false; continue; }
                const r = q / p;
                if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
            }
            if (!ok || t0 >= t1) { cur = null; continue; }
            const a = [x0 + dx * t0, y0 + dy * t0], b = [x0 + dx * t1, y0 + dy * t1];
            if (!cur || t0 > 0) { cur = [a]; out.push(cur); }
            cur.push(b);
            if (t1 < 1) cur = null;
        }
        return out.filter(l => l.length > 1);
    }

    const ringArea = r => { let a = 0; for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return a / 2; };
    // Exterior rings are clockwise in tile units (y down): positive area, holes follow their exterior
    function polygons(rings) {
        const out = [];
        for (const r of rings) {
            if (r.length < 4) continue;
            if (ringArea(r) > 0 || !out.length) out.push([r]); else out[out.length - 1].push(r);
        }
        return out;
    }

    function inside(p, ring) {
        let c = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) c = !c;
        }
        return c;
    }

    function convert(key, layers) {
        const [tx, ty] = key.split('/').map(Number), n = 2 ** Z;
        const roads = layers.transportation, E = roads ? roads.extent : 4096;
        const toLL = (x, y) => {
            const X = (tx + x / E) / n, Y = (ty + y / E) / n;
            return [Math.atan(Math.sinh(Math.PI * (1 - 2 * Y))) / RAD, X * 360 - 180];
        };

        // Names come in their own layer, along the same geometry
        const names = new Map(), CELL = 64;
        for (const f of (layers.transportation_name || { features: [] }).features) {
            if (!f.props.name && !f.props.ref) continue;
            for (const line of geometry(f.geom)) {
                for (let i = 0; i < line.length - 1; i++) {
                    const s = { a: line[i], b: line[i + 1], p: f.props };
                    const k = Math.floor((line[i][0] + line[i + 1][0]) / 2 / CELL) + ',' + Math.floor((line[i][1] + line[i + 1][1]) / 2 / CELL);
                    if (!names.has(k)) names.set(k, []);
                    names.get(k).push(s);
                }
            }
        }
        const nameAt = (x, y, cls) => {
            let best = null, bd = 6;
            for (let i = Math.floor(x / CELL) - 1; i <= Math.floor(x / CELL) + 1; i++) {
                for (let j = Math.floor(y / CELL) - 1; j <= Math.floor(y / CELL) + 1; j++) {
                    for (const s of names.get(i + ',' + j) || []) {
                        const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], l2 = dx * dx + dy * dy || 1e-9;
                        const t = Math.max(0, Math.min(1, ((x - s.a[0]) * dx + (y - s.a[1]) * dy) / l2));
                        const d = Math.hypot(x - s.a[0] - dx * t, y - s.a[1] - dy * t) + (s.p.class === cls ? 0 : 3);
                        if (d < bd) { bd = d; best = s.p; }
                    }
                }
            }
            return best;
        };

        const urban = [];
        for (const f of (layers.landuse || { features: [] }).features) {
            if (f.type === 3 && URBAN.includes(f.props.class)) for (const poly of polygons(geometry(f.geom))) urban.push(poly[0]);
        }

        const tags = [], tagIdx = new Map(), ways = [];
        const id = (x, y) => Math.round((tx * E + x) * 4) + '_' + Math.round((ty * E + y) * 4);
        (roads ? roads.features : []).forEach((f, fi) => {
            const p = f.props, cls = CLASS[p.class];
            if (f.type !== 2 || !cls || (cls === 'service' && SKIP_SERVICE.includes(p.service))) return;
            geometry(f.geom).forEach((raw, ri) => clipLine(raw, E).forEach((line, li) => {
                const mid = line[Math.floor(line.length / 2)], m0 = line[Math.floor(line.length / 2) - 1] || line[0];
                const mx = (mid[0] + m0[0]) / 2, my = (mid[1] + m0[1]) / 2;
                const named = nameAt(mx, my, p.class) || {};
                const t = { highway: p.ramp ? cls + '_link' : cls };
                if (named.name) t.name = named.name;
                if (named.ref) t.ref = named.ref;
                if (p.oneway === 1) t.oneway = 'yes';
                else if (p.oneway === -1) t.oneway = '-1';
                if (p.brunnel === 'bridge') t.bridge = 'yes';
                if (p.brunnel === 'tunnel') t.tunnel = 'yes';
                const tk = JSON.stringify(t);
                if (!tagIdx.has(tk)) { tagIdx.set(tk, tags.length); tags.push(t); }
                const c = [];
                for (const [x, y] of line) c.push(...toLL(x, y));
                ways.push({
                    w: `${key}:${fi}:${ri}:${li}`, i: 0, t: tagIdx.get(tk), u: urban.some(r => inside([mx, my], r)) ? 1 : 0,
                    n: line.map(([x, y]) => id(x, y)), c
                });
            }));
        });

        // Buildings: footprints with the heights OpenMapTiles derives from height, levels or a default
        const list = [], bE = layers.building ? layers.building.extent : E;
        for (const f of (layers.building || { features: [] }).features) {
            if (f.type !== 3 || f.props.hide_3d) continue;
            for (const poly of polygons(geometry(f.geom))) {
                list.push({
                    rings: poly.map(r => r.map(([x, y]) => toLL(x * E / bE, y * E / bE))),
                    h: f.props.render_height || 6, min: f.props.render_min_height || 0, colour: f.props.colour
                });
            }
        }
        buildings.set(key, list);

        // The rest of the world: water, land cover, railways, fuel stations, in lat/lon
        const ll = (l, E2) => l.map(([x, y]) => toLL(x * E / E2, y * E / E2));
        const area = { water: [], waterways: [], cover: [], rails: [], fuel: [] };
        const each = (name, fn) => { const l = layers[name]; if (l) for (const f of l.features) fn(f, l.extent); };
        each('water', (f, E2) => {
            if (f.type === 3 && f.props.brunnel !== 'tunnel') for (const poly of polygons(geometry(f.geom))) area.water.push({ rings: poly.map(r => ll(r, E2)), cls: f.props.class });
        });
        each('waterway', (f, E2) => {
            if (f.type !== 2 || f.props.brunnel === 'tunnel') return;
            for (const raw of geometry(f.geom)) for (const line of clipLine(raw, E2)) area.waterways.push({ line: ll(line, E2), cls: f.props.class });
        });
        const COVER = { wood: 'wood', forest: 'wood', grass: 'grass', farmland: 'farm', wetland: 'grass', sand: 'sand', rock: 'rock', ice: 'rock' };
        each('landcover', (f, E2) => {
            const cls = COVER[f.props.class];
            if (f.type === 3 && cls) for (const poly of polygons(geometry(f.geom))) area.cover.push({ rings: poly.map(r => ll(r, E2)), cls });
        });
        each('landuse', (f, E2) => {
            const cls = URBAN.includes(f.props.class) || f.props.class === 'industrial' ? 'urban' : null;
            if (f.type === 3 && cls) for (const poly of polygons(geometry(f.geom))) area.cover.push({ rings: poly.map(r => ll(r, E2)), cls });
        });
        each('park', (f, E2) => {
            if (f.type === 3) for (const poly of polygons(geometry(f.geom))) area.cover.push({ rings: poly.map(r => ll(r, E2)), cls: 'park' });
        });
        each('transportation', (f, E2) => {
            if (f.type !== 2 || f.props.class !== 'rail' || f.props.brunnel === 'tunnel' || (f.props.service && f.props.service !== 'main')) return;
            for (const raw of geometry(f.geom)) for (const line of clipLine(raw, E2)) area.rails.push(ll(line, E2));
        });
        each('poi', (f, E2) => {
            if (f.type === 1 && f.props.class === 'fuel') for (const p of geometry(f.geom)) { const [lat, lon] = ll(p, E2)[0]; area.fuel.push({ lat, lon, name: f.props.name || '' }); }
        });
        areas.set(key, area);
        return { tags, ways, cams: [], feats: [] };
    }

    const source = {
        keys(lat, lon, radius) {
            const [x, y] = tileOf(lat, lon), out = [];
            for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) out.push(`${x + dx}/${y + dy}`);
            return out;
        },
        load(key) {
            const [x, y] = key.split('/');
            const [lat, lon] = tileCentre(+x, +y);
            extras(lat, lon);
            return fetch(url.replace('{z}', Z).replace('{x}', x).replace('{y}', y))
                .then(r => r.ok ? r.arrayBuffer() : new ArrayBuffer(0))
                .then(buf => convert(key, decode(buf)))
                .finally(() => setTimeout(applyLanes, 0));
        }
    };

    function tileCentre(x, y) {
        const n = 2 ** Z;
        return [Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n))) / RAD, (x + 0.5) / n * 360 - 180];
    }

    // A hung instance would hold the queue until the browser gives up: drop it a little after the query's own timeout
    async function overpass(i, q) {
        const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 30000);
        try {
            const r = await fetch(OVERPASS[i], { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
            if (!r.ok) throw new Error(r.status);
            return (await r.json()).elements;
        } finally {
            clearTimeout(timer);
        }
    }

    // ---- Overpass: toll booths, road furniture and lanes, one 0.1\u00b0 cell at a time, one request at a time ----
    const cells = new Set(), queue = [], laneSegs = new Map(), SEG = 40;
    let busy = false, lanesDone = 0, server = 0, fails = 0;
    function extras(lat, lon) {
        const s = Math.floor(lat * 10) / 10, w = Math.floor(lon * 10) / 10, key = s + '_' + w;
        if (cells.has(key)) return;
        cells.add(key);
        queue.push(`${s.toFixed(1)},${w.toFixed(1)},${(s + 0.1).toFixed(1)},${(w + 0.1).toFixed(1)}`);
        pump();
    }

    async function pump() {
        if (busy || !queue.length) return;
        busy = true;
        const bbox = queue.shift();
        const q = `[out:json][timeout:25];(node["barrier"="toll_booth"](${bbox});`
            + `node["highway"="traffic_signals"](${bbox});node["highway"="crossing"](${bbox});node["railway"="level_crossing"](${bbox});`
            + `way["highway"]["lanes"](${bbox}););out tags geom;`;
        try {
            const els = await overpass(server, q);
            const nodes = els.filter(e => e.type === 'node');
            for (const e of nodes) if (e.tags.barrier === 'toll_booth') tolls.push({ lat: e.lat, lon: e.lon, name: e.tags.name || '' });
            // Road furniture the viewer draws: signals, zebra crossings, level crossings
            OsmMatch.addFeats(nodes.map(e => {
                const t = e.tags, d = t['traffic_signals:direction'] || t.direction;
                if (t.highway === 'traffic_signals') return { k: 'signals', lat: e.lat, lon: e.lon, d };
                if (t.railway === 'level_crossing') return { k: 'rail', lat: e.lat, lon: e.lon };
                if (t.highway === 'crossing' && (['zebra', 'marked', 'uncontrolled'].includes(t.crossing) || t['crossing:markings'] === 'zebra')) return { k: 'crossing', lat: e.lat, lon: e.lon };
                return null;
            }).filter(Boolean));
            for (const e of els) {
                if (e.type !== 'way' || !e.geometry) continue;
                for (let i = 0; i < e.geometry.length - 1; i++) {
                    const a = OsmMatch.project(e.geometry[i].lat, e.geometry[i].lon), b = OsmMatch.project(e.geometry[i + 1].lat, e.geometry[i + 1].lon);
                    const k = Math.floor((a.x + b.x) / 2 / SEG) + ',' + Math.floor((a.y + b.y) / 2 / SEG);
                    if (!laneSegs.has(k)) laneSegs.set(k, []);
                    laneSegs.get(k).push({ a, b, tags: e.tags });
                }
            }
            lanesDone = 0;
            fails = 0;
            applyLanes();
        } catch (err) {
            // Busy or refusing: the next public instance, and longer waits the more it fails (15 s up to 5 min)
            server = (server + 1) % OVERPASS.length;
            fails++;
            queue.unshift(bbox);
            busy = false;
            setTimeout(pump, Math.min(300000, 15000 * 2 ** Math.max(0, fails - OVERPASS.length)));
            return;
        }
        busy = false;
        setTimeout(pump, 1000);
    }

    // The vector tiles have no lane counts: each road edge takes them from the Overpass way it lies on
    function applyLanes() {
        const edges = OsmMatch.edges;
        for (let i = lanesDone; i < edges.length; i++) {
            const e = edges[i], mx = (e.ax + e.bx) / 2, my = (e.ay + e.by) / 2;
            let best = null, bd = 5;
            for (let a = Math.floor(mx / SEG) - 1; a <= Math.floor(mx / SEG) + 1; a++) {
                for (let b = Math.floor(my / SEG) - 1; b <= Math.floor(my / SEG) + 1; b++) {
                    for (const s of laneSegs.get(a + ',' + b) || []) {
                        const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, l2 = dx * dx + dy * dy || 1e-9;
                        const t = Math.max(0, Math.min(1, ((mx - s.a.x) * dx + (my - s.a.y) * dy) / l2));
                        const d = Math.hypot(mx - s.a.x - dx * t, my - s.a.y - dy * t);
                        // Same direction either way along the road
                        const cos = Math.abs(((e.bx - e.ax) * dx + (e.by - e.ay) * dy) / (e.len * Math.sqrt(l2)));
                        if (d < bd && cos > 0.9) { bd = d; best = s; }
                    }
                }
            }
            if (best) {
                const keep = ['lanes', 'lanes:forward', 'lanes:backward', 'width'];
                const add = {};
                for (const k of keep) if (best.tags[k]) add[k] = best.tags[k];
                e.tags = { ...e.tags, ...add };
            }
        }
        lanesDone = edges.length;
    }

    function reset() {
        buildings.clear();
        areas.clear();
        tolls.length = 0;
        cells.clear();
        queue.length = 0;
        laneSegs.clear();
        lanesDone = 0;
    }

    const tileUrl = (z, x, y) => url.replace('{z}', z).replace('{x}', x).replace('{y}', y);

    return { init, source, buildings, areas, tolls, tileOf, tileCentre, reset, decode, geometry, polygons, tileUrl, Z };
})();
window.OsmOnline = OsmOnline;
