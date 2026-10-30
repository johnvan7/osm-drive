// Terrain in the simulator: Terrarium DEM tiles (AWS open data, SRTM 30 m in Europe) as solid ground, roads with
// asphalt and guardrails laid on a smoothed profile, and the car resting on it
(() => {
    const Z = 13;
    const URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/';
    const RAD = Math.PI / 180;
    const GROUND_R = 240, GROUND_STEP = 8;   // m: solid ground around the car, the fog hides its edge
    const PROFILE_STEP = 2;                  // m between road profile samples
    const CELL = 10;                         // m, spatial index of the samples
    // Numeric cell keys: looked up thousands of times per scene, strings would be built and dropped each time
    const cellKey = (i, j) => (i + 50000) * 100000 + j + 50000;
    const RAILED = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];
    const tiles = new Map();
    const T = { on: true, version: 0, h0: 0, pitch: 0, slope: 0, samples: [], grid: new Map(), profiles: [], meshes: [], wayInfo: new Map(), wayInfoN: 0 };

    // ---- DEM ----
    function tileXY(lat, lon) {
        const n = 2 ** Z, r = lat * RAD;
        return { x: (lon + 180) / 360 * n, y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n };
    }

    function load(tx, ty) {
        const key = tx + '/' + ty;
        if (tiles.has(key)) return tiles.get(key);
        loading(1);
        const job = fetch(`${URL}${Z}/${key}.png`)
            .then(r => r.blob())
            .then(createImageBitmap)
            .then(img => {
                const c = new OffscreenCanvas(256, 256), g = c.getContext('2d');
                g.drawImage(img, 0, 0);
                const px = g.getImageData(0, 0, 256, 256).data, h = new Float32Array(256 * 256);
                for (let i = 0; i < h.length; i++) h[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
                tiles.set(key, h);
                T.version++;
            })
            .catch(() => tiles.delete(key))
            .finally(() => loading(-1));
        tiles.set(key, job);
        return job;
    }

    // ---- Loading indicator: tiles still on their way in the current batch ----
    const batch = { pending: 0, total: 0, el: null };
    function loading(delta) {
        if (!batch.el) {
            batch.el = document.createElement('div');
            batch.el.style.cssText = 'position:fixed;left:8px;top:376px;width:344px;z-index:300;background:rgba(0,0,0,.7);color:#fff;'
                + 'padding:8px 8px 6px;border-radius:10px;font:12px sans-serif;display:none';
            batch.el.innerHTML = '<div class="t"></div><div style="height:4px;margin-top:6px;background:rgba(255,255,255,.2);border-radius:2px">'
                + '<div class="b" style="height:100%;width:0;background:#3e8bff;border-radius:2px"></div></div>';
            document.body.appendChild(batch.el);
        }
        batch.pending += delta;
        if (delta > 0) batch.total += delta;
        const done = batch.total - batch.pending;
        batch.el.style.display = batch.pending > 0 && !T.quiet ? 'block' : 'none';
        batch.el.querySelector('.t').textContent = I18n.t('loadingElevation', done, batch.total);
        batch.el.querySelector('.b').style.width = (batch.total ? 100 * done / batch.total : 0) + '%';
        if (batch.pending === 0) batch.total = 0;
    }

    // One job per tile within `radius` tiles of the points, for a caller that waits on them
    T.jobs = (points, radius) => {
        const jobs = new Map();
        for (const f of points) {
            const p = tileXY(f.lat, f.lon), tx = Math.floor(p.x), ty = Math.floor(p.y);
            for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) {
                const key = (tx + dx) + '/' + (ty + dy);
                if (!jobs.has(key)) jobs.set(key, load(tx + dx, ty + dy));
            }
        }
        return [...jobs.values()];
    };

    T.ensure = (lat, lon) => {
        const p = tileXY(lat, lon), tx = Math.floor(p.x), ty = Math.floor(p.y);
        const jobs = [];
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) jobs.push(load(tx + dx, ty + dy));
        return Promise.all(jobs);
    };

    function heightLL(lat, lon) {
        const p = tileXY(lat, lon), tx = Math.floor(p.x), ty = Math.floor(p.y);
        const h = tiles.get(tx + '/' + ty);
        if (!(h instanceof Float32Array)) return NaN;
        // Pixel centres; at the tile border the last row is reused
        const fx = Math.min(255, Math.max(0, (p.x - tx) * 256 - 0.5)), fy = Math.min(255, Math.max(0, (p.y - ty) * 256 - 0.5));
        const i = Math.min(254, Math.floor(fx)), j = Math.min(254, Math.floor(fy)), a = fx - i, b = fy - j;
        const at = (x, y) => h[y * 256 + x];
        return (at(i, j) * (1 - a) + at(i + 1, j) * a) * (1 - b) + (at(i, j + 1) * (1 - a) + at(i + 1, j + 1) * a) * b;
    }

    // Bare terrain at map coordinates; the car's height while a tile is loading
    function dem(x, y) {
        if (!T.on) return 0;
        const ll = OsmMatch.unproject(x, y);
        const h = heightLL(ll.lat, ll.lon);
        return Number.isFinite(h) ? h : T.h0;
    }

    // Terrain blurred over about 10 m: one height per place whatever roads are loaded, so nothing jumps between scenes.
    // Kept on a fixed 4 m lattice, each point computed once
    const BLUR = [], LAT = 4, lattice = new Map();
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) BLUR.push([i * 8, j * 8, Math.exp(-(i * i + j * j) * 64 / 200)]);
    function latticeAt(i, j) {
        const key = i * 1e6 + j;
        const cached = lattice.get(key);
        if (cached !== undefined) return cached;
        let sum = 0, w = 0, missing = false;
        for (const [dx, dy, k] of BLUR) {
            const ll = OsmMatch.unproject(i * LAT + dx, j * LAT + dy);
            const h = heightLL(ll.lat, ll.lon);
            if (Number.isFinite(h)) { sum += h * k; w += k; } else missing = true;
        }
        const h = w ? sum / w : NaN;
        if (!missing) {
            if (lattice.size > 300000) lattice.clear();
            lattice.set(key, h);
        }
        return h;
    }
    function smoothDem(x, y) {
        if (!T.on) return 0;
        const fx = x / LAT, fy = y / LAT, i = Math.floor(fx), j = Math.floor(fy), a = fx - i, b = fy - j;
        const h = (latticeAt(i, j) * (1 - a) + latticeAt(i + 1, j) * a) * (1 - b) + (latticeAt(i, j + 1) * (1 - a) + latticeAt(i + 1, j + 1) * a) * b;
        return Number.isFinite(h) ? h : T.h0;
    }

    // ---- Roads: centre lines sampled every 2 m, flat across ----
    function wayInfo(way) {
        if (OsmMatch.edges.length !== T.wayInfoN) {
            for (let i = T.wayInfoN; i < OsmMatch.edges.length; i++) {
                const e = OsmMatch.edges[i], t = e.tags;
                if (!T.wayInfo.has(e.way)) {
                    T.wayInfo.set(e.way, {
                        hw: t.highway.replace('_link', ''), urban: e.urban,
                        bridge: !!t.bridge && t.bridge !== 'no', tunnel: !!t.tunnel && t.tunnel !== 'no'
                    });
                }
            }
            T.wayInfoN = OsmMatch.edges.length;
        }
        return T.wayInfo.get(way) || { hw: '', urban: true, bridge: false, tunnel: false };
    }

    function buildProfiles(roads) {
        T.samples = [];
        T.grid = new Map();
        T.profiles = [];
        roads.forEach((r, ri) => {
            const info = wayInfo(r.way);
            const pts = resample(smoothPolyline(r.pts), PROFILE_STEP);
            if (pts.length < 2) return;
            const hw = (r.fwd + r.back) * r.laneW / 2, first = T.samples.length, end = pts[pts.length - 1];
            T.profiles[ri] = { pts, hs: null, first };
            // A bridge spans the valley and a tunnel goes through the hill: straight between their ends
            const span = info.bridge || info.tunnel ? { h0: smoothDem(pts[0].x, pts[0].y), h1: smoothDem(end.x, end.y), L: end.s || 1 } : null;
            pts.forEach((p, i) => {
                const s = { x: p.x, y: p.y, s: p.s, i: first + i, first, last: first + pts.length - 1, hw, road: ri, info, span };
                T.samples.push(s);
                const key = cellKey(Math.floor(p.x / CELL), Math.floor(p.y / CELL));
                if (!T.grid.has(key)) T.grid.set(key, []);
                T.grid.get(key).push(s);
            });
        });
        // The surface along each road, once all are indexed: the asphalt is laid on it and the lines follow it
        for (const p of T.profiles) if (p) p.hs = p.pts.map(q => ground(q.x, q.y));
    }

    // Height of road ri's surface s metres along it; `from` is a sample index to search on from, for callers going
    // forwards along the road. Flat across, like the asphalt
    function profileAt(ri, s, from = 0) {
        const p = T.profiles[ri], pts = p.pts;
        let k = Math.min(from, pts.length - 2);
        if (pts[k].s > s) k = 0;
        while (k < pts.length - 2 && pts[k + 1].s <= s) k++;
        const a = pts[k], b = pts[k + 1], t = b.s > a.s ? Math.min(1, Math.max(0, (s - a.s) / (b.s - a.s))) : 0;
        return { h: p.hs[k] + (p.hs[k + 1] - p.hs[k]) * t, k };
    }

    function nearest(x, y, r, skip) {
        let best = null, bd = r;
        for (let i = Math.floor((x - r) / CELL); i <= Math.floor((x + r) / CELL); i++) {
            for (let j = Math.floor((y - r) / CELL); j <= Math.floor((y + r) / CELL); j++) {
                const cell = T.grid.get(cellKey(i, j));
                if (cell) for (const s of cell) {
                    if (s.road === skip) continue;
                    const d = Math.hypot(s.x - x, s.y - y);
                    if (d < bd) { bd = d; best = s; }
                }
            }
        }
        return best && { s: best, d: bd };
    }

    // Height of the centre line abreast of (x, y), on the segment to the nearer neighbouring sample
    function centreHeight(n, x, y) {
        const s = n.s;
        let best = { x: s.x, y: s.y, s: s.s, d: Infinity };
        for (const k of [s.i - 1, s.i + 1]) {
            if (k < s.first || k > s.last) continue;
            const o = T.samples[k], dx = o.x - s.x, dy = o.y - s.y, l2 = dx * dx + dy * dy || 1e-9;
            const t = Math.max(0, Math.min(1, ((x - s.x) * dx + (y - s.y) * dy) / l2));
            const px = s.x + dx * t, py = s.y + dy * t, d = Math.hypot(x - px, y - py);
            if (d < best.d) best = { x: px, y: py, s: s.s + (o.s - s.s) * t, d };
        }
        return s.span ? s.span.h0 + (s.span.h1 - s.span.h0) * best.s / s.span.L : smoothDem(best.x, best.y);
    }

    // Height of what is under (x, y): a road's surface, else the terrain
    function ground(x, y) {
        const n = nearest(x, y, 20);
        return n && n.d <= n.s.hw + 1.5 ? centreHeight(n, x, y) : smoothDem(x, y);
    }
    T.ground = ground;

    // Height of what is drawn at (x, y): the asphalt on a road, else the ground mesh's own triangles
    T.surface = (x, y) => {
        const n = nearest(x, y, 20);
        if (n && n.d <= n.s.hw + 0.4) return centreHeight(n, x, y);
        const g = T.mesh;
        if (!g) return smoothDem(x, y);
        const fx = (x - g.gx) / GROUND_STEP, fy = (y - g.gy) / GROUND_STEP, i = Math.floor(fx), j = Math.floor(fy);
        if (i < 0 || j < 0 || i >= g.n - 1 || j >= g.n - 1) return dem(x, y);
        const a = fx - i, b = fy - j, h = (p, q) => g.hs[(j + q) * g.n + i + p];
        return a + b <= 1
            ? h(0, 0) + a * (h(1, 0) - h(0, 0)) + b * (h(0, 1) - h(0, 0))
            : h(1, 1) + (1 - a) * (h(0, 1) - h(1, 1)) + (1 - b) * (h(1, 0) - h(1, 1));
    };
    // Set by the free-driving simulation: { x, y, brg (deg), z, pitch, roll }; the view then follows it
    T.car = null;
    T.dem = dem;
    // Whether the elevation under a point has arrived
    T.has = (lat, lon) => Number.isFinite(heightLL(lat, lon));
    // Map coordinates change with a new origin: everything cached in them goes
    T.reset = () => {
        lattice.clear();
        T.mesh = null;
        T.samples = [];
        T.grid = new Map();
        T.profiles = [];
        T.car = null;
    };

    // ---- Meshes, rebuilt with every scene. Unlit with their own shading, so day and night look as chosen ----
    const PALETTE = {
        day: { ground: 0x8fa868, asphalt: 0x6e6f73, rail: 0xc9cdd3, zenith: 0x3d7fd1, horizon: 0xcfe2f2, below: 0xb9cbb0 },
        night: { ground: 0x1c2219, asphalt: 0x2c2c30, rail: 0x5a5d63, zenith: 0x03050b, horizon: 0x1a2232, below: 0x10140f },
    };
    const SUN = (() => { const v = [-0.45, -0.35, 0.82], l = Math.hypot(...v); return v.map(c => c / l); })();
    let mats = null;
    const palette = () => isDarkTheme ? PALETTE.night : PALETTE.day;

    function clearMeshes() {
        for (const m of T.meshes) {
            map.inner.remove(m);
            m.geometry.dispose();
        }
        T.meshes = [];
    }

    function buildMeshes(roads, cx, cy) {
        if (!mats) {
            mats = {
                // Pushed back in depth so the asphalt wins over the ground and the painted lines over the asphalt
                ground: new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4 }),
                asphalt: new THREE.MeshBasicMaterial({ polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }),
                rail: new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
            };
        }
        const u = 1 / METERS_PER_UNIT, y0 = roadMesh.position.y;
        const V = (x, y, h) => [-x * u, y0 + h * u, y * u];

        // Ground: just under the roads near them, back to the DEM within 16 m
        const n = Math.round(2 * GROUND_R / GROUND_STEP) + 1;
        const gx = Math.round(cx / GROUND_STEP) * GROUND_STEP - GROUND_R, gy = Math.round(cy / GROUND_STEP) * GROUND_STEP - GROUND_R;
        // Under every road near a vertex, not just the nearest: a triangle can span two roads at different heights, and
        // the ground must stay below both. One road at a time, its samples reach out to the vertices around them and
        // each vertex keeps the nearest: far fewer distances than searching around every vertex
        const target = new Float64Array(n * n).fill(Infinity), tMin = new Float64Array(n * n).fill(1);
        const bestD = new Float64Array(n * n).fill(Infinity), bestS = new Array(n * n), touched = [];
        for (const p of T.profiles) {
            if (!p) continue;
            const s0 = T.samples[p.first];
            if (s0.info.bridge || s0.info.tunnel) continue;
            const reach = s0.hw + GROUND_STEP * 1.5 + 16;
            for (let k = p.first; k <= s0.last; k++) {
                const s = T.samples[k];
                const i0 = Math.max(0, Math.ceil((s.x - reach - gx) / GROUND_STEP)), i1 = Math.min(n - 1, Math.floor((s.x + reach - gx) / GROUND_STEP));
                const j0 = Math.max(0, Math.ceil((s.y - reach - gy) / GROUND_STEP)), j1 = Math.min(n - 1, Math.floor((s.y + reach - gy) / GROUND_STEP));
                for (let j = j0; j <= j1; j++) {
                    for (let i = i0; i <= i1; i++) {
                        const d = Math.hypot(gx + i * GROUND_STEP - s.x, gy + j * GROUND_STEP - s.y), v = j * n + i;
                        if (d >= reach || d >= bestD[v]) continue;
                        if (bestD[v] === Infinity) touched.push(v);
                        bestD[v] = d;
                        bestS[v] = s;
                    }
                }
            }
            for (const v of touched) {
                const t = Math.min(1, Math.max(0, (bestD[v] - s0.hw - GROUND_STEP * 1.5) / 16));
                if (t < 1) {
                    target[v] = Math.min(target[v], centreHeight({ s: bestS[v] }, gx + (v % n) * GROUND_STEP, gy + Math.floor(v / n) * GROUND_STEP) - 0.3);
                    tMin[v] = Math.min(tMin[v], t);
                }
                bestD[v] = Infinity;
            }
            touched.length = 0;
        }
        const hs = new Float32Array(n * n);
        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
                const v = j * n + i, tg = target[v], t = tMin[v];
                let h = dem(gx + i * GROUND_STEP, gy + j * GROUND_STEP);
                if (tg !== Infinity) h = tg + (h - tg) * t * t * (3 - 2 * t);
                hs[v] = h;
            }
        }
        T.mesh = { gx, gy, n, hs };
        const groundPos = [], groundCol = [];
        // Land cover colours the ground; hillshade from a sun high in the south-west, softer at night
        const COVER = isDarkTheme
            ? { wood: 0x111a10, park: 0x16211a, grass: 0x1a2318, farm: 0x24231a, sand: 0x2b2820, rock: 0x252525, urban: 0x1e1f22 }
            : { wood: 0x5d7d45, park: 0x84a865, grass: 0x8fae68, farm: 0xbfb58a, sand: 0xd8cca0, rock: 0xa9a59c, urban: 0xb5b1a8 };
        const base = new THREE.Color(palette().ground), contrast = isDarkTheme ? 0.35 : 0.6;
        const cover = new Array(n * n), tint = new THREE.Color();
        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
                const cls = window.World ? World.coverAt(gx + i * GROUND_STEP, gy + j * GROUND_STEP) : null;
                cover[j * n + i] = cls ? tint.set(COVER[cls]).clone() : base;
            }
        }
        const shade = new Float32Array(n * n);
        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
                const at = (a, b) => hs[Math.min(n - 1, Math.max(0, b)) * n + Math.min(n - 1, Math.max(0, a))];
                const gx_ = (at(i + 1, j) - at(i - 1, j)) / (2 * GROUND_STEP), gy_ = (at(i, j + 1) - at(i, j - 1)) / (2 * GROUND_STEP);
                const l = Math.hypot(gx_, gy_, 1);
                const lit = Math.max(0, (-gx_ * SUN[0] - gy_ * SUN[1] + SUN[2]) / l);
                shade[j * n + i] = 1 - contrast + contrast * lit / SUN[2];
            }
        }
        for (let j = 0; j < n - 1; j++) {
            for (let i = 0; i < n - 1; i++) {
                const p = (a, b) => V(gx + (i + a) * GROUND_STEP, gy + (j + b) * GROUND_STEP, hs[(j + b) * n + i + a]);
                const c = (a, b) => { const k = shade[(j + b) * n + i + a], cc = cover[(j + b) * n + i + a]; return [cc.r * k, cc.g * k, cc.b * k]; };
                groundPos.push(...p(0, 0), ...p(1, 0), ...p(0, 1), ...p(1, 0), ...p(1, 1), ...p(0, 1));
                groundCol.push(...c(0, 0), ...c(1, 0), ...c(0, 1), ...c(1, 0), ...c(1, 1), ...c(0, 1));
            }
        }

        const asphalt = [], rail = [];
        // Guardrail segments in map metres, for the car's collisions
        T.rails = [];
        const post = (x, y, h) => {
            const s = 0.06, c = [];
            for (const dz of [0, 0.75]) for (const [dx, dy] of [[-s, -s], [s, -s], [s, s], [-s, s]]) c.push(V(x + dx, y + dy, h + dz));
            for (let k = 0; k < 4; k++) {
                const a = c[k], b = c[(k + 1) % 4], a2 = c[k + 4], b2 = c[(k + 1) % 4 + 4];
                rail.push(...a, ...b, ...b2, ...a, ...b2, ...a2);
            }
        };
        roads.forEach((r, ri) => {
            if (!T.profiles[ri]) return;
            const info = wayInfo(r.way);
            const { pts, hs } = T.profiles[ri];
            const W = (r.fwd + r.back) * r.laneW / 2 + 0.4;
            const inRange = p => Math.hypot(p.x - cx, p.y - cy) < MAP_RANGE && (!r.clip || Math.hypot(p.x - r.clip.x, p.y - r.clip.y) < r.clip.r);
            for (let i = 0; i < pts.length - 1; i++) {
                const a = pts[i], b = pts[i + 1];
                if (!inRange(a) || !inRange(b)) continue;
                const L = (p, h) => V(p.x + p.nx * W, p.y + p.ny * W, h), R = (p, h) => V(p.x - p.nx * W, p.y - p.ny * W, h);
                asphalt.push(...R(a, hs[i]), ...R(b, hs[i + 1]), ...L(a, hs[i]), ...L(a, hs[i]), ...R(b, hs[i + 1]), ...L(b, hs[i + 1]));
            }

            // Guardrails out of town on the bigger roads: always on motorways, trunks and bridges, elsewhere on embankments
            if (r.clip || info.urban || info.tunnel || !RAILED.includes(info.hw)) return;
            const always = info.hw === 'motorway' || info.hw === 'trunk' || info.bridge;
            const off = W + 0.5;
            for (const side of [1, -1]) {
                let last = null;
                pts.forEach((p, i) => {
                    const x = p.x + p.nx * off * side, y = p.y + p.ny * off * side, h = hs[i];
                    const drop = h - dem(p.x + p.nx * (off + 4) * side, p.y + p.ny * (off + 4) * side);
                    // Not across a junction
                    const other = nearest(x, y, 25, ri);
                    const want = inRange(p) && (always || drop > 1.2) && !(other && other.d < other.s.hw + 4);
                    if (!want) { last = null; return; }
                    if (last) {
                        T.rails.push({ ax: last.x, ay: last.y, bx: x, by: y });
                        rail.push(...V(last.x, last.y, last.h + 0.5), ...V(x, y, h + 0.5), ...V(last.x, last.y, last.h + 0.8),
                            ...V(last.x, last.y, last.h + 0.8), ...V(x, y, h + 0.5), ...V(x, y, h + 0.8));
                    }
                    if (i % 2 === 0) post(x - p.nx * 0.1 * side, y - p.ny * 0.1 * side, h);
                    last = { x, y, h };
                });
            }
        });

        mats.asphalt.color.set(palette().asphalt);
        mats.rail.color.set(palette().rail);
        for (const [pos, mat, col] of [[groundPos, mats.ground, groundCol], [asphalt, mats.asphalt], [rail, mats.rail]]) {
            if (!pos.length) continue;
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            if (col) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
            const m = new THREE.Mesh(g, mat);
            map.inner.add(m);
            T.meshes.push(m);
        }
    }

    // ---- Sky: a gradient dome around the camera, with stars at night; the fog takes the horizon's colour ----
    let sky = null, stars = null;
    function buildSky() {
        sky = new THREE.Mesh(new THREE.SphereGeometry(800, 32, 16), new THREE.ShaderMaterial({
            uniforms: { zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, below: { value: new THREE.Color() }, bg: { value: new THREE.Color() }, mixK: { value: 1 } },
            vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
            fragmentShader: `uniform vec3 zenith, horizon, below, bg; uniform float mixK; varying vec3 vDir;
                void main() {
                    float y = vDir.y;
                    vec3 c = y > 0.0 ? mix(horizon, zenith, pow(min(1.0, y * 1.4), 0.6)) : mix(horizon, below, min(1.0, -y * 6.0));
                    gl_FragColor = vec4(mix(bg, c, mixK), 1.0);
                }`,
            side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false
        }));
        // Drawn first, behind everything: it neither tests nor writes depth
        sky.renderOrder = -10;
        sky.frustumCulled = false;
        scene.add(sky);

        const pos = [];
        for (let k = 0; k < 900; k++) {
            const y = 0.06 + Math.random() * 0.94, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - y * y);
            pos.push(Math.cos(a) * r * 780, y * 780, Math.sin(a) * r * 780);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, depthWrite: false, fog: false }));
        stars.frustumCulled = false;
        scene.add(stars);
    }

    function updateSky(o) {
        if (!sky) buildSky();
        const p = T.sky || palette(), u = sky.material.uniforms;
        const bg = new THREE.Color(isDarkTheme ? 0x242424 : 0xf0f0f0);
        u.zenith.value.set(p.zenith);
        u.horizon.value.set(p.horizon);
        u.below.value.set(p.below);
        u.bg.value.copy(bg);
        u.mixK.value = o;
        sky.visible = o > 0.01;
        sky.position.copy(camera.position);
        stars.position.copy(camera.position);
        stars.visible = isDarkTheme && o > 0.01 && !T.overcast;
        stars.material.opacity = o * 0.8;
        if (scene.fog) {
            scene.fog.color.copy(bg).lerp(new THREE.Color(p.horizon), o);
            // Set by the game for fog and rain: { near, far } in metres
            const d = T.fog || { near: 72, far: 216 };
            scene.fog.near = d.near / METERS_PER_UNIT;
            scene.fog.far = d.far / METERS_PER_UNIT;
        }
    }

    // ---- Viewer hooks: everything on the map gets its height, the car rests on the road ----
    window.addEventListener('load', () => {
        // The viewer's painted lines, laid on their road's asphalt. Rebuilt with every scene, so written to allocate
        // little, with the other carriageways looked up in a grid
        const G = 20, gridKey = (i, j) => (i + 50000) * 100000 + j + 50000;
        mapLinesGeometry = function (sceneRoads, cx, cy) {
            const u = 1 / METERS_PER_UNIT, y0 = roadMesh.position.y + 0.02;
            const W = sceneRoads.map(r => (r.fwd + r.back) * r.laneW);
            // Each segment in every cell within half its road's width of it
            const segs = new Map();
            sceneRoads.forEach((r, ri) => {
                const pad = W[ri] / 2;
                for (let k = 0; k < r.pts.length - 1; k++) {
                    const [ax, ay] = r.pts[k], [bx, by] = r.pts[k + 1];
                    for (let i = Math.floor((Math.min(ax, bx) - pad) / G); i <= Math.floor((Math.max(ax, bx) + pad) / G); i++) {
                        for (let j = Math.floor((Math.min(ay, by) - pad) / G); j <= Math.floor((Math.max(ay, by) + pad) / G); j++) {
                            const key = gridKey(i, j);
                            if (!segs.has(key)) segs.set(key, []);
                            segs.get(key).push(ri, ax, ay, bx, by);
                        }
                    }
                }
            });
            const insideOther = (ri, x, y) => {
                const c = segs.get(gridKey(Math.floor(x / G), Math.floor(y / G)));
                if (c) for (let k = 0; k < c.length; k += 5) {
                    if (c[k] === ri) continue;
                    const ax = c[k + 1], ay = c[k + 2], dx = c[k + 3] - ax, dy = c[k + 4] - ay, l2 = dx * dx + dy * dy || 1e-9;
                    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
                    if (Math.hypot(x - ax - dx * t, y - ay - dy * t) < W[c[k]] / 2 - 0.3) return true;
                }
                return false;
            };
            const pos = [], uv = [];
            const vertex = (x, y, h) => pos.push(-x * u, h, y * u);
            sceneRoads.forEach((r, ri) => {
                // Offsets from the centre line, + left of pts: lanes along pts drive on the right
                const lines = [{ o: -W[ri] / 2 }, { o: W[ri] / 2 }];
                for (let k = 1; k < r.fwd + r.back; k++) {
                    if (k === r.fwd && !r.center) continue;
                    lines.push({ o: -W[ri] / 2 + k * r.laneW, dashed: true });
                }
                const period = r.dash[0] + r.dash[1];
                const samples = resample(r.pts, MAP_STEP);
                const prof = T.profiles && T.profiles[ri];
                for (const { o, dashed } of lines) {
                    let k = 0;
                    const height = (p, x, y) => {
                        if (!prof) return ground(x, y);
                        const at = profileAt(ri, p.s, k);
                        k = at.k;
                        return at.h;
                    };
                    for (let i = 0; i < samples.length - 1; i++) {
                        const a = samples[i], b = samples[i + 1];
                        const mx = (a.x + b.x) / 2 + (a.nx + b.nx) / 2 * o, my = (a.y + b.y) / 2 + (a.ny + b.ny) / 2 * o;
                        const far = Math.hypot(mx - cx, my - cy);
                        if (far > MAP_RANGE) continue;
                        if (dashed && (((a.s + b.s) / 2 + (r.s0 || 0)) % period) > r.dash[0]) continue;
                        if (r.clip && Math.hypot(mx - r.clip.x, my - r.clip.y) > r.clip.r) continue;
                        if (insideOther(ri, mx, my)) continue;
                        // Real 15 cm lines (plus their soft sides), wider far away so they stay visible
                        const w = Math.max(0.22, far * 0.005) / 2;
                        const ax = a.x + a.nx * o, ay = a.y + a.ny * o, bx = b.x + b.nx * o, by = b.y + b.ny * o;
                        const ha = y0 + height(a, ax, ay) * u, hb = y0 + height(b, bx, by) * u;
                        const a0x = ax - a.nx * w, a0y = ay - a.ny * w, a1x = ax + a.nx * w, a1y = ay + a.ny * w;
                        const b0x = bx - b.nx * w, b0y = by - b.ny * w, b1x = bx + b.nx * w, b1y = by + b.ny * w;
                        vertex(a0x, a0y, ha); vertex(a1x, a1y, ha); vertex(b1x, b1y, hb);
                        vertex(a0x, a0y, ha); vertex(b1x, b1y, hb); vertex(b0x, b0y, hb);
                        uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
                    }
                }
            });
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
            return g;
        };

        const baseSetMapScene = setMapScene;
        setMapScene = function (sc) {
            const roads = sc && sc.path && sc.path.length > 1 ? sc.roads : [];
            buildProfiles(roads);
            baseSetMapScene(sc);
            if (!map.inner) return;
            clearMeshes();
            if (!map.scene) return;
            const u = 1 / METERS_PER_UNIT;
            for (const g of map.objects) g.position.y += ground(-g.position.x / u, g.position.z / u) * u;
            const [cx, cy] = sc.path[sc.carIndex || 0];
            buildMeshes(roads, cx, cy);
        };

        const baseUpdateMap = updateMap;
        updateMap = function (dt) {
            const shown = baseUpdateMap(dt);
            updateSky(shown ? Math.min(1, roadCurrentOpacity / 0.8) : 0);
            if (!shown || !map.pose) return shown;
            const u = 1 / METERS_PER_UNIT;
            // Yaw, then pitch about the car's side axis, then roll about its length
            map.root.rotation.order = 'ZXY';
            if (T.car) {
                const c = T.car, b = c.brg * Math.PI / 180;
                map.pose = { x: c.x, y: c.y, brg: b };
                map.inner.position.set(c.x * u, -c.z * u, -c.y * u);
                map.root.rotation.set(c.pitch, b, c.roll);
                T.h0 = c.z;
                T.slope = Math.tan(c.pitch);
                fade();
                return shown;
            }
            // On the followed road's centre line abreast of the smoothed pose: it moves without jumps, and the
            // height there is the same function the lines are drawn with
            const { x, y, brg } = map.pose, off = map.scene.car.offset || 0;
            const cx = x + Math.cos(brg) * off, cy = y - Math.sin(brg) * off, fx = Math.sin(brg) * 6, fy = Math.cos(brg) * 6;
            const along = (px, py) => {
                const n = nearest(px, py, 6);
                return n && n.s.span ? centreHeight(n, px, py) : smoothDem(px, py);
            };
            T.h0 = along(cx, cy);
            T.slope = (along(cx + fx, cy + fy) - along(cx - fx, cy - fy)) / 12;
            T.pitch += (Math.atan(T.slope) - T.pitch) * (1 - Math.exp(-dt / 0.3));
            map.inner.position.y = -T.h0 * u;
            // The world tilts by the slope under the car, so the car sits on the road
            map.root.rotation.x = T.pitch;
            map.root.rotation.z = 0;
            fade();
            return shown;
        };

        function fade() {
            const o = Math.min(1, roadCurrentOpacity / 0.8);
            for (const m of Object.values(mats || {})) {
                m.opacity = o;
                m.transparent = o < 0.999;
            }
            if (!isDarkTheme) mapMaterial.color.set(0xffffff);
        }
    });

    window.Terrain = T;
})();
