// 3D buildings for the simulator: OpenFreeMap footprints extruded on the terrain, one merged mesh per vector tile
(() => {
    const TINTS = [0xe8dcc6, 0xe3c9a8, 0xf0e6d8, 0xd9b99b, 0xece3d0, 0xcfc6b8, 0xe6d2b5, 0xd8c3a5];
    const CELL = 12;   // m of facade per texture repeat: 4 x 4 windows of 3 m
    const built = new Map();
    const footprints = new Map();   // tile key -> [{ rings: [[{x, y}]], minx, maxx, miny, maxy }]
    // The same footprints by 16 m cell, for asking about a point many times per scene
    const GRID = 16, grid = new Map(), cellKey = (i, j) => (i + 50000) * 100000 + j + 50000;
    function index(list, add) {
        for (const p of list) {
            for (let i = Math.floor(p.minx / GRID); i <= Math.floor(p.maxx / GRID); i++) {
                for (let j = Math.floor(p.miny / GRID); j <= Math.floor(p.maxy / GRID); j++) {
                    const k = cellKey(i, j);
                    if (add) { if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); }
                    else { const c = grid.get(k); if (c) { const n = c.indexOf(p); if (n >= 0) c.splice(n, 1); if (!c.length) grid.delete(k); } }
                }
            }
        }
    }
    let mats = null, builtOn = true, dark = null;

    // Facade of 4 x 4 floors and bays; at night a third of the windows are lit
    function facade(night) {
        const c = document.createElement('canvas');
        c.width = c.height = 256;
        const g = c.getContext('2d');
        g.fillStyle = night ? '#23272e' : '#ffffff';
        g.fillRect(0, 0, 256, 256);
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                g.fillStyle = night ? (Math.random() < 0.33 ? '#ffd27f' : '#14171c') : '#6d7c8a';
                g.fillRect(i * 64 + 20, j * 64 + 14, 24, 32);
            }
        }
        const t = new THREE.CanvasTexture(c);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        return t;
    }

    function materials() {
        // Walls are seen from both sides wherever the footprint winds the other way
        mats = {
            day: new THREE.MeshBasicMaterial({ map: facade(false), vertexColors: true, side: THREE.DoubleSide }),
            night: new THREE.MeshBasicMaterial({ map: facade(true), side: THREE.DoubleSide }),
        };
    }

    function build(key) {
        const list = OsmOnline.buildings.get(key) || [];
        const u = 1 / METERS_PER_UNIT, y0 = roadMesh.position.y;
        const pos = [], uv = [], col = [], feet = [];
        const V = (x, y, h) => [-x * u, y0 + h * u, y * u];
        // A plain bit of wall, without a window, for the roofs
        const ROOF_UV = [2 / 256, 2 / 256];
        for (const b of list) {
            const rings = b.rings.map(r => r.slice(0, -1).map(([lat, lon]) => OsmMatch.project(lat, lon)));
            if (rings[0].length < 3) continue;
            if (!b.min) {
                const xs = rings[0].map(p => p.x), ys = rings[0].map(p => p.y);
                feet.push({ rings, minx: Math.min(...xs), maxx: Math.max(...xs), miny: Math.min(...ys), maxy: Math.max(...ys) });
            }
            const ground = Math.min(...rings[0].map(p => Terrain.dem(p.x, p.y)));
            const bottom = b.min > 0 ? ground + b.min : ground - 1, top = ground + Math.max(3, b.h);
            if (feet.length && feet[feet.length - 1].rings === rings) feet[feet.length - 1].top = top;
            const tint = new THREE.Color(b.colour && /^#[0-9a-f]{6}$/i.test(b.colour) ? b.colour : TINTS[Math.abs(Math.round(rings[0][0].x * 7 + rings[0][0].y * 13)) % TINTS.length]);
            for (const ring of rings) {
                let s = 0;
                for (let i = 0; i < ring.length; i++) {
                    const a = ring[i], c = ring[(i + 1) % ring.length], len = Math.hypot(c.x - a.x, c.y - a.y);
                    if (len < 0.05) continue;
                    // Walls facing the low sun in the south-west are lighter
                    const shade = 0.72 + 0.28 * Math.abs(((c.y - a.y) * -0.6 + (c.x - a.x) * 0.8) / len);
                    const u0 = s / CELL, u1 = (s + len) / CELL, v0 = (bottom - ground) / CELL, v1 = (top - ground) / CELL;
                    pos.push(...V(a.x, a.y, bottom), ...V(c.x, c.y, bottom), ...V(c.x, c.y, top), ...V(a.x, a.y, bottom), ...V(c.x, c.y, top), ...V(a.x, a.y, top));
                    uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
                    for (let k = 0; k < 6; k++) col.push(tint.r * shade, tint.g * shade, tint.b * shade);
                    s += len;
                }
            }
            const contour = rings[0].map(p => new THREE.Vector2(p.x, p.y)), holes = rings.slice(1).map(r => r.map(p => new THREE.Vector2(p.x, p.y)));
            const all = contour.concat(...holes);
            for (const tri of THREE.ShapeUtils.triangulateShape(contour, holes)) {
                for (const k of tri) {
                    pos.push(...V(all[k].x, all[k].y, top));
                    uv.push(...ROOF_UV);
                    col.push(tint.r * 0.8, tint.g * 0.8, tint.b * 0.8);
                }
            }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        const m = new THREE.Mesh(g, isDarkTheme ? mats.night : mats.day);
        map.inner.add(m);
        built.set(key, m);
        footprints.set(key, feet);
        index(feet, true);
    }

    function drop(key) {
        const m = built.get(key);
        map.inner.remove(m);
        m.geometry.dispose();
        built.delete(key);
        index(footprints.get(key) || [], false);
        footprints.delete(key);
    }

    function inside(x, y, ring) {
        let c = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[i], b = ring[j];
            if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c;
        }
        return c;
    }

    function footprintAt(x, y) {
        const c = grid.get(cellKey(Math.floor(x / GRID), Math.floor(y / GRID)));
        if (c) for (const p of c) {
            if (x < p.minx || x > p.maxx || y < p.miny || y > p.maxy) continue;
            if (inside(x, y, p.rings[0]) && !p.rings.slice(1).some(h => inside(x, y, h))) return p;
        }
        return null;
    }

    const Buildings = {
        reset: () => { for (const k of [...built.keys()]) drop(k); for (const t of [...plazas.keys()]) dropPlaza(t); },
        has: key => built.has(key),
        // Whether (x, y) is inside a building standing on the ground (not a bridge or an overhang)
        hit: (x, y) => !!footprintAt(x, y),
        // Height of the roof over (x, y), null outside the buildings drawn
        topAt: (x, y) => { const p = footprintAt(x, y); return p ? p.top : null; }
    };

    // ---- Toll plazas: a canopy across the lanes on pillars, a booth between each pair of lanes ----
    const plazas = new Map();
    let plazaMat = null;
    function buildPlaza(t) {
        const p = OsmMatch.project(t.lat, t.lon);
        let best = null;
        for (const e of OsmMatch.edgesNear(p.x, p.y, 40)) {
            const dx = e.bx - e.ax, dy = e.by - e.ay, l2 = dx * dx + dy * dy || 1e-9;
            const k = Math.max(0, Math.min(1, ((p.x - e.ax) * dx + (p.y - e.ay) * dy) / l2));
            const d = Math.hypot(p.x - e.ax - dx * k, p.y - e.ay - dy * k);
            if (!best || d < best.d) best = { d, e };
        }
        if (!best) return null;
        const b = best.e.brg * Math.PI / 180, fx = Math.sin(b), fy = Math.cos(b), rx = Math.cos(b), ry = -Math.sin(b);
        const lanes = Math.max(3, parseInt(best.e.tags.lanes) || 0), W = lanes * 3.5 + 4;
        const h0 = Terrain.ground(p.x, p.y), u = 1 / METERS_PER_UNIT, y0 = roadMesh.position.y;
        const pos = [], col = [];
        // Box in the plaza's frame: across, along, from z0 up by h
        const box = (across, along, w, d, z0, h, color) => {
            const c = new THREE.Color(color), corner = (sa, sd, z) => {
                const x = p.x + rx * (across + sa * w / 2) + fx * (along + sd * d / 2), y = p.y + ry * (across + sa * w / 2) + fy * (along + sd * d / 2);
                return [-x * u, y0 + (h0 + z) * u, y * u];
            };
            const faces = [
                [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1], 1],
                [[-1, -1, 0], [1, -1, 0], [1, -1, 1], [-1, -1, 1], 0.8],
                [[1, 1, 0], [-1, 1, 0], [-1, 1, 1], [1, 1, 1], 0.8],
                [[-1, 1, 0], [-1, -1, 0], [-1, -1, 1], [-1, 1, 1], 0.65],
                [[1, -1, 0], [1, 1, 0], [1, 1, 1], [1, -1, 1], 0.65],
                [[-1, -1, 0], [-1, 1, 0], [1, 1, 0], [1, -1, 0], 0.5],
            ];
            for (const [a, bb, cc, dd, shade] of faces) {
                const q = [a, bb, cc, dd].map(([sa, sd, sz]) => corner(sa, sd, z0 + sz * h));
                pos.push(...q[0], ...q[1], ...q[2], ...q[0], ...q[2], ...q[3]);
                for (let k = 0; k < 6; k++) col.push(c.r * shade, c.g * shade, c.b * shade);
            }
        };
        box(0, 0, W, 9, 5.4, 0.7, 0xeceef1);
        // The green fascia of the Italian motorways, front and back
        for (const side of [-1, 1]) box(0, side * 4.55, W + 0.2, 0.15, 4.9, 1.3, 0x1f8a4c);
        for (let k = 0; k <= lanes; k++) {
            const across = -W / 2 + 2 + k * 3.5;
            box(across, 0, 1.2, 4.5, 0, 2.6, 0xc9ced6);
            box(across, 0, 1.25, 1.6, 1.2, 1, 0x3c4a5a);
            box(across, 0, 0.35, 0.35, 2.6, 2.8, 0x9aa1ab);
            // Kerb islands the booths stand on
            box(across, 0, 1.6, 7, -0.1, 0.25, 0xb8bcc2);
        }
        if (!plazaMat) plazaMat = new THREE.MeshBasicMaterial({ vertexColors: true });
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        const m = new THREE.Mesh(g, plazaMat);
        map.inner.add(m);
        return m;
    }

    function dropPlaza(t) {
        const m = plazas.get(t);
        if (m) {
            map.inner.remove(m);
            m.geometry.dispose();
        }
        plazas.delete(t);
    }

    function updatePlazas(f) {
        for (const t of OsmOnline.tolls) {
            const p = OsmMatch.project(t.lat, t.lon), d = Math.hypot(p.x - f.x, p.y - f.y);
            if (d > 2000 && plazas.has(t)) dropPlaza(t);
            else if (d < 1500 && !plazas.has(t) && OsmMatch.edgesNear(p.x, p.y, 40).length) {
                // A plaza is often mapped with one node per booth: one canopy for all of them
                const near = [...plazas.keys()].some(o => { const q = OsmMatch.project(o.lat, o.lon); return Math.hypot(q.x - p.x, q.y - p.y) < 80; });
                plazas.set(t, near ? null : buildPlaza(t));
            }
        }
    }

    // Tiles around the car, one new tile per frame so the drive doesn't stall
    function tick() {
        requestAnimationFrame(tick);
        const f = window.osmSim && osmSim.free;
        if (!window.OsmOnline || !f || !f.on || !map.inner) return;
        if (!mats) materials();
        if (builtOn !== Terrain.on) {
            builtOn = Terrain.on;
            Buildings.reset();
        }
        if (dark !== isDarkTheme) {
            dark = isDarkTheme;
            for (const m of built.values()) m.material = dark ? mats.night : mats.day;
        }
        const ll = OsmMatch.unproject(f.x, f.y), [tx, ty] = OsmOnline.tileOf(ll.lat, ll.lon), want = new Set();
        updatePlazas(f);
        // A plane sees farther: two tiles round it instead of one
        const r = f.kind === 'plane' ? 2 : 1;
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) want.add(`${tx + dx}/${ty + dy}`);
        for (const k of [...built.keys()]) if (!want.has(k)) drop(k);
        for (const k of want) {
            if (built.has(k) || !OsmOnline.buildings.has(k) || !Terrain.tileReady(k)) continue;
            build(k);
            break;
        }
    }

    window.Buildings = Buildings;
    requestAnimationFrame(tick);
})();
