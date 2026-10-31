// Map matching on the OSM tiles from build_tiles.py. Prototype for the simulator, to be ported to Kotlin.
const OsmMatch = (() => {
    const EARTH = 6371000, RAD = Math.PI / 180;
    const CELL = 50;          // m, spatial index
    const AHEAD_STEP = 2;     // m between heading samples sent to the viewer

    let base = '', tileDeg = 0.02, tileSet = new Set(), origin = null;
    const tiles = new Map();
    const nodes = new Map();  // id -> { x, y, edges: [edge index] }
    const edges = [];
    const wayEdges = new Map();  // way id -> its loaded edges
    const seen = new Set();
    const grid = new Map();
    const feats = [];
    const state = { e: null, fwd: true, t: 0, x: 0, y: 0, at: 0, cost: 0, lostAt: 0 };

    async function init(dir) {
        base = dir;
        const idx = await (await fetch(dir + 'index.json')).json();
        tileDeg = idx.tileDeg;
        tileSet = new Set(idx.tiles);
        source = localSource;
    }

    // Where tiles come from: keys around a point and a loader giving the tile format of build_tiles.py
    const localSource = {
        keys(lat, lon, radius) {
            const ti = Math.floor(lat / tileDeg), tj = Math.floor(lon / tileDeg), out = [];
            for (let a = ti - radius; a <= ti + radius; a++) {
                for (let b = tj - radius; b <= tj + radius; b++) if (tileSet.has(`${a}_${b}`)) out.push(`${a}_${b}`);
            }
            return out;
        },
        load: key => fetch(`${base}${key}.json`).then(r => r.json())
    };
    let source = localSource;
    const useSource = s => { source = s; };

    // Everything loaded is relative to the first point projected: a drive far away needs a fresh start
    function reset() {
        origin = null;
        for (const c of [tiles, nodes, wayEdges, seen, grid, nodeGrid, alias]) c.clear();
        edges.length = 0;
        feats.length = 0;
        Object.assign(state, { e: null, fwd: true, t: 0, x: 0, y: 0, at: 0, cost: 0, lostAt: 0 });
    }

    function project(lat, lon) {
        if (!origin) origin = { lat, lon, cos: Math.cos(lat * RAD) };
        return { x: (lon - origin.lon) * RAD * EARTH * origin.cos, y: (lat - origin.lat) * RAD * EARTH };
    }

    function unproject(x, y) {
        return { lat: origin.lat + y / (RAD * EARTH), lon: origin.lon + x / (RAD * EARTH * origin.cos) };
    }

    const norm360 = a => ((a % 360) + 360) % 360;
    // Signed difference b - a in (-180, 180]: positive = clockwise (right)
    const turnOf = (a, b) => { const d = norm360(b - a); return d > 180 ? d - 360 : d; };
    const bearing = (ax, ay, bx, by) => norm360(Math.atan2(bx - ax, by - ay) / RAD);

    // One promise per tile around the point, for callers that count them
    function jobs(lat, lon, radius = 1) {
        project(lat, lon);
        return source.keys(lat, lon, radius).map(key => {
            if (!tiles.has(key)) tiles.set(key, source.load(key).then(addTile).catch(() => { tiles.delete(key); }));
            return tiles.get(key);
        });
    }

    const ensure = (lat, lon, radius = 1) => Promise.all(jobs(lat, lon, radius));

    // Road features from another source: { k, lat, lon, d }
    function addFeats(list) {
        for (const f of list) feats.push({ raw: f, k: f.k, d: f.d, ...project(f.lat, f.lon), edge: null });
        feats.filter(f => !f.edge).forEach(attachFeat);
    }

    function onewayOf(t) {
        if (['yes', '1', 'true'].includes(t.oneway)) return 1;
        if (t.oneway === '-1') return -1;
        if (t.oneway === 'no') return 0;
        if (t.junction === 'roundabout' || t.junction === 'circular') return 1;
        return t.highway === 'motorway' || t.highway === 'motorway_link' ? 1 : 0;
    }

    const allowed = (e, fwd) => e.oneway === 0 || (e.oneway === 1) === fwd;

    // Sources without node ids (vector tiles) give each end its position: ends within a metre are the same node
    const nodeGrid = new Map(), alias = new Map();
    function node(id, lat, lon) {
        id = alias.get(id) || id;
        let n = nodes.get(id);
        if (!n) {
            const p = project(lat, lon), gx = Math.floor(p.x), gy = Math.floor(p.y);
            if (typeof id === 'string') {
                for (let i = gx - 1; i <= gx + 1 && !n; i++) {
                    for (let j = gy - 1; j <= gy + 1 && !n; j++) {
                        for (const other of nodeGrid.get(i + ',' + j) || []) {
                            const o = nodes.get(other);
                            if (Math.hypot(o.x - p.x, o.y - p.y) < 1) { alias.set(id, other); return { id: other, n: o }; }
                        }
                    }
                }
                const k = gx + ',' + gy;
                if (!nodeGrid.has(k)) nodeGrid.set(k, []);
                nodeGrid.get(k).push(id);
            }
            n = { x: p.x, y: p.y, edges: [] };
            nodes.set(id, n);
        }
        return { id, n };
    }

    function addTile(d) {
        for (const p of d.ways) {
            const tags = d.tags[p.t];
            for (let k = 0; k < p.n.length - 1; k++) {
                const key = p.w + ':' + (p.i + k);
                if (seen.has(key)) continue;
                seen.add(key);
                const { id: ia, n: A } = node(p.n[k], p.c[2 * k], p.c[2 * k + 1]);
                const { id: ib, n: B } = node(p.n[k + 1], p.c[2 * k + 2], p.c[2 * k + 3]);
                if (ia === ib) continue;
                const e = {
                    idx: edges.length, a: ia, b: ib, ax: A.x, ay: A.y, bx: B.x, by: B.y,
                    len: Math.max(0.1, Math.hypot(B.x - A.x, B.y - A.y)), brg: bearing(A.x, A.y, B.x, B.y),
                    way: p.w, seq: p.i + k, tags, urban: !!p.u, oneway: onewayOf(tags)
                };
                edges.push(e);
                if (!wayEdges.has(e.way)) wayEdges.set(e.way, []);
                wayEdges.get(e.way).push(e);
                A.edges.push(e.idx);
                B.edges.push(e.idx);
                const steps = Math.ceil(e.len / (CELL / 2));
                const cells = new Set();
                for (let s = 0; s <= steps; s++) {
                    const x = e.ax + (e.bx - e.ax) * s / steps, y = e.ay + (e.by - e.ay) * s / steps;
                    cells.add(Math.floor(x / CELL) + ',' + Math.floor(y / CELL));
                }
                for (const c of cells) {
                    if (!grid.has(c)) grid.set(c, []);
                    grid.get(c).push(e.idx);
                }
            }
        }
        for (const f of d.feats || []) feats.push({ raw: f, k: f.k, d: f.d, rb: f.rb, ...project(f.lat, f.lon), edge: null });
        // Features near a tile border may need the neighbour's roads
        feats.filter(f => !f.edge).forEach(attachFeat);
    }

    // Features are nodes of the road itself; from another source they only have a position
    function attachFeat(f) {
        if (!f.raw.ways) {
            let best = null;
            for (const e of edgesNear(f.x, f.y, 8)) {
                const p = projectOn(e, f.x, f.y);
                if (p.d <= 6 && (!best || p.d < best.d)) best = { e, t: p.t, d: p.d };
            }
            if (best) {
                f.edge = best.e;
                f.t = best.t;
            }
            return;
        }
        for (const [w, i] of f.raw.ways) {
            const e = (wayEdges.get(w) || []).find(e => e.seq === i || e.seq === i - 1);
            if (e) {
                f.edge = e;
                f.t = e.seq === i ? 0 : 1;
                return;
            }
        }
    }

    function edgesNear(x, y, r) {
        const out = new Set();
        for (let i = Math.floor((x - r) / CELL); i <= Math.floor((x + r) / CELL); i++) {
            for (let j = Math.floor((y - r) / CELL); j <= Math.floor((y + r) / CELL); j++) {
                (grid.get(i + ',' + j) || []).forEach(k => out.add(k));
            }
        }
        return [...out].map(k => edges[k]);
    }

    function projectOn(e, x, y) {
        const dx = e.bx - e.ax, dy = e.by - e.ay;
        const t = Math.max(0, Math.min(1, ((x - e.ax) * dx + (y - e.ay) * dy) / (e.len * e.len)));
        const px = e.ax + dx * t, py = e.ay + dy * t;
        return { t, px, py, d: Math.hypot(x - px, y - py) };
    }

    // Typical speed by road type in km/h, for choosing routes
    function roadSpeed(e) {
        const hw = e.tags.highway;
        if (hw === 'motorway') return 130;
        if (hw === 'trunk') return e.oneway ? 110 : 90;
        if (['primary', 'secondary', 'tertiary', 'unclassified', 'road'].includes(hw)) return e.urban ? 50 : 90;
        if (hw === 'residential') return 50;
        return 30;
    }

    // ---- Matching ----

    // Driving distance from the matched point to the start node of every directed edge within maxDist
    function reachable(maxDist) {
        const e = state.e;
        const first = state.fwd ? e.b : e.a;
        const dist = new Map([[first, state.fwd ? e.len * (1 - state.t) : e.len * state.t]]);
        const queue = [first];
        while (queue.length) {
            queue.sort((p, q) => dist.get(p) - dist.get(q));
            const id = queue.shift();
            const d = dist.get(id);
            const n = nodes.get(id);
            if (!n || d > maxDist) continue;
            for (const k of n.edges) {
                const o = edges[k];
                for (const fwd of [true, false]) {
                    if ((fwd ? o.a : o.b) !== id || !allowed(o, fwd)) continue;
                    const to = fwd ? o.b : o.a;
                    if (!dist.has(to) || d + o.len < dist.get(to)) {
                        dist.set(to, d + o.len);
                        queue.push(to);
                    }
                }
            }
        }
        return dist;
    }

    function routeDistance(reach, c, fwd) {
        if (c.e === state.e && fwd === state.fwd) {
            const along = (fwd ? c.t - state.t : state.t - c.t) * c.e.len;
            if (along > -10) return Math.max(0, along);   // GPS jitter can step a little backwards
        }
        const start = reach.get(fwd ? c.e.a : c.e.b);
        return start == null ? null : start + (fwd ? c.t : 1 - c.t) * c.e.len;
    }

    // fix: { t (ms), lat, lon, speed (m/s) | null, bearing (deg) | null, acc (m) | null }
    function match(fix) {
        const p = project(fix.lat, fix.lon);
        const sigma = Math.max(5, fix.acc || 8);
        const moving = fix.speed == null || fix.speed > 2;
        const cands = edgesNear(p.x, p.y, Math.max(25, 2.5 * sigma))
            .map(e => ({ e, ...projectOn(e, p.x, p.y) }))
            .filter(c => c.d <= Math.max(25, 2.5 * sigma));

        // Stopped: the bearing means nothing, stay on the same road
        if (!moving && state.e) {
            const same = cands.find(c => c.e === state.e);
            if (same) {
                Object.assign(state, { t: same.t, x: same.px, y: same.py, at: fix.t });
                return result(p, same.d);
            }
        }

        const dt = state.e ? (fix.t - state.at) / 1000 : 0;
        const reach = state.e && dt < 15 ? reachable((fix.speed || 15) * dt * 1.5 + 60) : null;
        let best = null;
        for (const c of cands) {
            for (const fwd of [true, false]) {
                if (!allowed(c.e, fwd)) continue;
                let cost = (c.d / sigma) ** 2;
                if (fix.bearing != null && moving) {
                    cost += (turnOf(fix.bearing, fwd ? c.e.brg : c.e.brg + 180) / 30) ** 2;
                }
                if (reach) {
                    const rd = routeDistance(reach, c, fwd);
                    const straight = Math.hypot(c.px - state.x, c.py - state.y);
                    cost += rd == null ? 6 : Math.min(6, ((rd - straight) / 20) ** 2);
                }
                if (c.e.tags.highway === 'service') cost += 1;
                if (!best || cost < best.cost) best = { ...c, fwd, cost };
            }
        }
        if (!best) {
            if (state.e && fix.t - state.at > 10000) state.e = null;
            return result(p, null);
        }
        Object.assign(state, { e: best.e, fwd: best.fwd, t: best.t, x: best.px, y: best.py, at: fix.t, cost: best.cost });
        return result(p, best.d);
    }

    function result(p, d) {
        return { raw: p, matched: state.e ? { e: state.e, fwd: state.fwd, x: state.x, y: state.y, d, cost: state.cost } : null };
    }

    // ---- Road ahead ----

    // nav: { dir (+1 left, -1 right), angle (deg), meters } of the next maneuver, to pick the way at junctions
    function ahead(nav, maxM = 600) {
        if (!state.e) return null;
        let e = state.e, fwd = state.fwd, t = state.t;
        const pts = [{ x: state.x, y: state.y, s: 0 }];
        const segs = [];
        let s = 0;
        let navPending = nav && nav.dir && nav.meters != null;
        let turn = null;
        for (let guard = 0; guard < 400; guard++) {
            const segLen = fwd ? e.len * (1 - t) : e.len * t;
            segs.push({ e, fwd, s0: s, t0: t });
            s += segLen;
            pts.push({ x: fwd ? e.bx : e.ax, y: fwd ? e.by : e.ay, s });
            if (s >= maxM) break;
            const id = fwd ? e.b : e.a;
            const inBrg = fwd ? e.brg : norm360(e.brg + 180);
            const options = [];
            for (const k of (nodes.get(id) || { edges: [] }).edges) {
                const o = edges[k];
                if (o === e) continue;
                if (o.a === id && allowed(o, true)) options.push({ e: o, fwd: true, turn: turnOf(inBrg, o.brg) });
                if (o.b === id && allowed(o, false)) options.push({ e: o, fwd: false, turn: turnOf(inBrg, o.brg + 180) });
            }
            if (!options.length) break;
            let pick;
            if (options.length === 1) {
                pick = options[0];
            } else if (navPending && Math.abs(s - nav.meters) < 30 + nav.meters * 0.15) {
                const want = -nav.dir * nav.angle;
                pick = options.reduce((a, b) => Math.abs(b.turn - want) < Math.abs(a.turn - want) ? b : a);
                navPending = false;
                turn = { s, index: pts.length - 1 };
            } else {
                const sameRoad = o => (e.tags.name && o.e.tags.name === e.tags.name) || (e.tags.ref && o.e.tags.ref === e.tags.ref);
                const score = o => Math.abs(o.turn) + (sameRoad(o) ? 0 : 20) + (o.e.tags.highway === 'service' ? 30 : 0);
                pick = options.reduce((a, b) => score(b) < score(a) ? b : a);
            }
            e = pick.e;
            fwd = pick.fwd;
            t = fwd ? 0 : 1;
        }

        // Headings every AHEAD_STEP metres, relative to the road at the car, + left (viewer convention)
        const h = [];
        let k = 0, prev = null, acc = 0;
        for (let d = 0; d <= s; d += AHEAD_STEP) {
            while (k < pts.length - 2 && pts[k + 1].s <= d) k++;
            const a = pts[k], b = pts[k + 1];
            if (b.s - a.s < 0.01) continue;
            const brg = bearing(a.x, a.y, b.x, b.y);
            if (prev != null) acc += turnOf(prev, brg);
            prev = brg;
            h.push(-acc * RAD);
        }

        return { pts, segs, step: AHEAD_STEP, h, turn, road: segs[0].e.tags };
    }

    // ---- Scene for the viewer's 1:1 map ----
    const LANE_W = { motorway: 3.75, trunk: 3.5, primary: 3.5, secondary: 3.25, tertiary: 3.0, service: 2.5 };
    const MARKED = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];

    // Cross-section of a way: lanes along / against its nodes, lane width, centre line, dashes (Italian lengths)
    function laneInfo(e) {
        const t = e.tags, hw = t.highway.replace('_link', '');
        const lanes = parseInt(t.lanes) || 0;
        let fwd, back;
        if (e.oneway !== 0) {
            fwd = lanes || (hw === 'motorway' || hw === 'trunk' ? 2 : 1);
            back = 0;
            if (e.oneway === -1) [fwd, back] = [back, fwd];
        } else if (parseInt(t['lanes:forward']) && parseInt(t['lanes:backward'])) {
            fwd = parseInt(t['lanes:forward']);
            back = parseInt(t['lanes:backward']);
        } else if (lanes === 1) {
            fwd = 1;
            back = 0;
        } else {
            fwd = Math.max(1, Math.ceil(lanes / 2));
            back = Math.max(1, Math.floor(lanes / 2));
        }
        let laneW = LANE_W[hw] || 2.75;
        const width = parseFloat(t.width);
        if (width > 2) laneW = width / (fwd + back);
        return {
            fwd, back, laneW,
            center: fwd > 0 && back > 0 && (lanes > 0 || MARKED.includes(hw)),
            dash: e.urban ? [3, 4.5] : [4.5, 7.5]
        };
    }

    // Offset of the centre of the rightmost lane in the travel direction from the centre line, + left
    function laneOffset(e, fwd) {
        const l = laneInfo(e);
        return (fwd ? l.fwd : l.back) ? -((l.fwd + l.back) * l.laneW / 2 - l.laneW / 2) : 0;
    }

    // Contiguous loaded stretches of a way whose edges pass `keep`; s0 keeps the dashes anchored to the way
    function wayRoads(way, keep, clip) {
        const list = (wayEdges.get(way) || []).slice().sort((a, b) => a.seq - b.seq);
        const out = [];
        let cur = null, s = 0, prev = null;
        for (const e of list) {
            if (prev && e.seq !== prev.seq + 1) { cur = null; s = 0; }
            if (keep(e)) {
                if (!cur) {
                    cur = { way, pts: [[e.ax, e.ay]], s0: s, ...laneInfo(e), clip };
                    out.push(cur);
                }
                cur.pts.push([e.bx, e.by]);
            } else {
                cur = null;
            }
            s += e.len;
            prev = e;
        }
        return out;
    }

    // Road behind the car, as far as `maxM`, choosing the straightest way back at junctions
    function behind(maxM) {
        let e = state.e, fwd = state.fwd;
        const pts = [];
        let s = fwd ? e.len * state.t : e.len * (1 - state.t);
        pts.push({ x: fwd ? e.ax : e.bx, y: fwd ? e.ay : e.by, e, id: fwd ? e.a : e.b });
        while (s < maxM) {
            const id = fwd ? e.a : e.b;
            const outBrg = fwd ? norm360(e.brg + 180) : e.brg;  // looking backwards
            let best = null;
            for (const k of (nodes.get(id) || { edges: [] }).edges) {
                const o = edges[k];
                if (o === e) continue;
                // An edge the car could have arrived on: it must allow driving into this node
                for (const ofwd of [true, false]) {
                    if ((ofwd ? o.b : o.a) !== id || !allowed(o, ofwd)) continue;
                    const back = ofwd ? norm360(o.brg + 180) : o.brg;
                    const score = Math.abs(turnOf(outBrg, back)) + (o.way === e.way ? 0 : 20);
                    if (!best || score < best.score) best = { o, ofwd, score };
                }
            }
            if (!best) break;
            e = best.o;
            fwd = best.ofwd;
            s += e.len;
            pts.push({ x: fwd ? e.ax : e.bx, y: fwd ? e.ay : e.by, e, id: fwd ? e.a : e.b });
        }
        return pts;
    }

    function scene(nav) {
        const ah = ahead(nav, 320);
        if (!ah) return null;
        const back = behind(60);
        const path = [...back.slice().reverse().map(p => [p.x, p.y]), ...ah.pts.map(p => [p.x, p.y])];
        const carIndex = back.length;
        const car = { x: state.x, y: state.y };
        // By the segment's distance, not its ends: long straights have far-apart nodes
        const near = (e, x, y, r) => {
            const dx = e.bx - e.ax, dy = e.by - e.ay, l2 = dx * dx + dy * dy || 1e-9;
            const t = Math.max(0, Math.min(1, ((x - e.ax) * dx + (y - e.ay) * dy) / l2));
            return Math.hypot(e.ax + dx * t - x, e.ay + dy * t - y) < r;
        };

        const pathWays = new Set([...ah.segs.map(sg => sg.e.way), ...back.map(p => p.e.way)]);
        const roads = [];
        for (const way of pathWays) roads.push(...wayRoads(way, e => near(e, car.x, car.y, 350)));

        // Side roads at every junction along the path, drawn for their first metres
        const junctions = [...ah.segs.map(sg => sg.fwd ? sg.e.b : sg.e.a), ...back.map(p => p.id)];
        const done = new Set();
        for (const id of junctions) {
            const n = id != null && nodes.get(id);
            if (!n || n.edges.length < 3 || Math.hypot(n.x - car.x, n.y - car.y) > 320) continue;
            for (const k of n.edges) {
                const way = edges[k].way;
                if (pathWays.has(way) || done.has(way + ':' + id)) continue;
                done.add(way + ':' + id);
                roads.push(...wayRoads(way, e => near(e, n.x, n.y, 45) || e.a === id || e.b === id, { x: n.x, y: n.y, r: 40 }));
            }
        }

        return {
            car: { offset: laneOffset(state.e, state.fwd) }, path, carIndex, roads, features: sceneFeatures(ah, roads, car), ahead: ah
        };
    }

    // Signals, crossings, level crossings and bumps on the drawn roads, oriented to the way they are met
    function sceneFeatures(ah, roads, car) {
        const drawn = new Set(roads.map(r => r.way));
        const out = [];
        for (const f of feats) {
            if (!f.edge || Math.hypot(f.x - car.x, f.y - car.y) > 250) continue;
            // A node at a junction belongs to several ways: take the car's edge arriving at it
            const arriving = sg => Math.hypot((sg.fwd ? sg.e.bx : sg.e.ax) - f.x, (sg.fwd ? sg.e.by : sg.e.ay) - f.y) < 0.5;
            const sg = ah.segs.find(arriving);
            if (!sg && !drawn.has(f.edge.way)) continue;
            const e = sg ? sg.e : f.edge, fwd = sg ? sg.fwd : true;
            // Signals only where the car meets them, and not the ones facing the other way
            if (f.k === 'signals' && (!sg || f.d === 'forward' && !fwd || f.d === 'backward' && fwd)) continue;
            const l = laneInfo(e);
            const W = (l.fwd + l.back) * l.laneW;
            const travel = (fwd ? l.fwd : l.back) || l.fwd + l.back;
            out.push({
                k: f.k, x: f.x, y: f.y, brg: fwd ? e.brg : norm360(e.brg + 180),
                W, travelW: travel * l.laneW, rb: f.rb, onPath: !!sg
            });
        }
        return out;
    }

    // ---- Routing, for synthetic drives ----
    function nearestNode(x, y) {
        let best = null;
        for (let r = 100; !best && r <= 1600; r *= 2) {
            for (const e of edgesNear(x, y, r)) {
                if (e.tags.highway === 'service') continue;
                for (const [id, nx, ny] of [[e.a, e.ax, e.ay], [e.b, e.bx, e.by]]) {
                    const d = Math.hypot(nx - x, ny - y);
                    if (!best || d < best.d) best = { id, d };
                }
            }
        }
        return best && best.id;
    }

    function route(from, to) {
        const src = nearestNode(from.x, from.y), dst = nearestNode(to.x, to.y);
        const cost = new Map([[src, 0]]), prev = new Map();
        const heap = [[0, src]];
        const push = (item) => {
            heap.push(item);
            for (let i = heap.length - 1; i > 0;) {
                const p = (i - 1) >> 1;
                if (heap[p][0] <= heap[i][0]) break;
                [heap[p], heap[i]] = [heap[i], heap[p]];
                i = p;
            }
        };
        const pop = () => {
            const top = heap[0], last = heap.pop();
            if (heap.length) {
                heap[0] = last;
                for (let i = 0; ;) {
                    const l = 2 * i + 1, r = l + 1;
                    let m = i;
                    if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
                    if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
                    if (m === i) break;
                    [heap[m], heap[i]] = [heap[i], heap[m]];
                    i = m;
                }
            }
            return top;
        };
        while (heap.length) {
            const [c0, id] = pop();
            if (c0 > cost.get(id)) continue;
            if (id === dst) break;
            for (const k of nodes.get(id).edges) {
                const o = edges[k];
                for (const fwd of [true, false]) {
                    if ((fwd ? o.a : o.b) !== id || !allowed(o, fwd)) continue;
                    const v = roadSpeed(o) / 3.6 / (o.tags.highway === 'service' ? 3 : 1);
                    const to2 = fwd ? o.b : o.a, c = cost.get(id) + o.len / v;
                    if (!cost.has(to2) || c < cost.get(to2)) {
                        cost.set(to2, c);
                        prev.set(to2, { e: o, fwd, from: id });
                        push([c, to2]);
                    }
                }
            }
        }
        let end = dst;
        if (!prev.has(end)) {
            // Destination only reachable through roads not in the tiles (pedestrian zones): stop as close as possible
            let bestD = Infinity;
            for (const id of prev.keys()) {
                const n = nodes.get(id), d = Math.hypot(n.x - to.x, n.y - to.y);
                if (d < bestD) { bestD = d; end = id; }
            }
            if (bestD > 500) return null;
        }
        const path = [];
        for (let id = end; id !== src; id = prev.get(id).from) path.unshift(prev.get(id));
        return path;
    }

    return { init, useSource, reset, ensure, jobs, addFeats, project, unproject, match, ahead, scene, route, edgesNear, roadSpeed, turnOf, bearing, wayRoads, laneInfo, nodes, edges, state };
})();
