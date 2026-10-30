// The rest of the world for the simulator, per vector tile around the car: rivers and lakes, land cover for the
// ground's colour, trees, railways, street lamps lit at night and fuel stations
(() => {
    const COVER_ORDER = ['wood', 'park', 'grass', 'farm', 'sand', 'rock', 'urban'];
    const CELL = 200;
    const indexed = new Set(), coverGrid = new Map();
    const built = new Map();
    let mats = null, dark = null;
    const World = {};

    const toMap = ring => ring.map(([lat, lon]) => OsmMatch.project(lat, lon));
    function inside(x, y, ring) {
        let c = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[i], b = ring[j];
            if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c;
        }
        return c;
    }
    const insidePoly = (x, y, p) => x >= p.minx && x <= p.maxx && y >= p.miny && y <= p.maxy && inside(x, y, p.rings[0]) && !p.rings.slice(1).some(h => inside(x, y, h));
    function poly(rings, extra) {
        const r = rings.map(toMap), xs = r[0].map(p => p.x), ys = r[0].map(p => p.y);
        return { rings: r, minx: Math.min(...xs), maxx: Math.max(...xs), miny: Math.min(...ys), maxy: Math.max(...ys), ...extra };
    }

    // ---- Land cover: what the ground at a point is, for its colour ----
    function index(key) {
        const area = OsmOnline.areas.get(key);
        if (!area || indexed.has(key)) return;
        indexed.add(key);
        for (const c of area.cover) {
            const p = poly(c.rings, { cls: c.cls });
            for (let i = Math.floor(p.minx / CELL); i <= Math.floor(p.maxx / CELL); i++) {
                for (let j = Math.floor(p.miny / CELL); j <= Math.floor(p.maxy / CELL); j++) {
                    const k = i + ',' + j;
                    if (!coverGrid.has(k)) coverGrid.set(k, []);
                    coverGrid.get(k).push(p);
                }
            }
        }
    }

    World.coverAt = (x, y) => {
        let best = null;
        for (const p of coverGrid.get(Math.floor(x / CELL) + ',' + Math.floor(y / CELL)) || []) {
            if ((!best || COVER_ORDER.indexOf(p.cls) < COVER_ORDER.indexOf(best)) && insidePoly(x, y, p)) best = p.cls;
        }
        return best;
    };

    // ---- Meshes ----
    function materials() {
        const glow = (() => {
            const c = document.createElement('canvas');
            c.width = c.height = 64;
            const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
            gr.addColorStop(0, 'rgba(255,214,140,1)');
            gr.addColorStop(1, 'rgba(255,214,140,0)');
            g.fillStyle = gr;
            g.fillRect(0, 0, 64, 64);
            return new THREE.CanvasTexture(c);
        })();
        mats = {
            water: new THREE.MeshBasicMaterial({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide }),
            solid: new THREE.MeshBasicMaterial({ vertexColors: true }),
            lit: new THREE.MeshBasicMaterial({ vertexColors: true }),
            crown: new THREE.MeshLambertMaterial({ color: 0x3f6b35 }),
            trunk: new THREE.MeshLambertMaterial({ color: 0x5a4632 }),
            pool: new THREE.MeshBasicMaterial({ map: glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.45 }),
        };
    }

    function paint() {
        mats.water.color.set(dark ? 0x0e2236 : 0x4f86b8);
        mats.solid.color.setScalar(dark ? 0.4 : 1);
        mats.lit.color.setScalar(1);
        mats.crown.color.set(dark ? 0x15241a : 0x3f6b35);
        mats.trunk.color.set(dark ? 0x221b14 : 0x5a4632);
        for (const t of built.values()) for (const m of t.meshes) if (m.userData.night) m.visible = dark;
    }

    // Geometry helpers in map metres, heights above sea level
    function builder() {
        const u = 1 / METERS_PER_UNIT, y0 = roadMesh.position.y;
        const out = { pos: [], col: [] };
        out.V = (x, y, h) => [-x * u, y0 + h * u, y * u];
        out.tri = (a, b, c, color) => {
            out.pos.push(...a, ...b, ...c);
            for (let k = 0; k < 3; k++) out.col.push(color.r, color.g, color.b);
        };
        out.quad = (a, b, c, d, color) => { out.tri(a, b, c, color); out.tri(a, c, d, color); };
        // Box in a frame (fx, fy) at (x, y): across, along, from z0 up by h
        out.box = (x, y, fx, fy, across, along, w, d, z0, h, hex) => {
            const rx = fy, ry = -fx, c = new THREE.Color(hex);
            const P = (sa, sd, z) => out.V(x + rx * (across + sa * w / 2) + fx * (along + sd * d / 2), y + ry * (across + sa * w / 2) + fy * (along + sd * d / 2), z);
            const shade = (k) => c.clone().multiplyScalar(k);
            out.quad(P(-1, -1, z0 + h), P(1, -1, z0 + h), P(1, 1, z0 + h), P(-1, 1, z0 + h), shade(1));
            out.quad(P(-1, -1, z0), P(1, -1, z0), P(1, -1, z0 + h), P(-1, -1, z0 + h), shade(0.8));
            out.quad(P(1, 1, z0), P(-1, 1, z0), P(-1, 1, z0 + h), P(1, 1, z0 + h), shade(0.8));
            out.quad(P(-1, 1, z0), P(-1, -1, z0), P(-1, -1, z0 + h), P(-1, 1, z0 + h), shade(0.65));
            out.quad(P(1, -1, z0), P(1, 1, z0), P(1, 1, z0 + h), P(1, -1, z0 + h), shade(0.65));
        };
        // Ribbon draped on the ground along a polyline
        out.ribbon = (pts, half, lift, hex, groundFn) => {
            const c = new THREE.Color(hex);
            for (let i = 0; i < pts.length - 1; i++) {
                const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);
                if (l < 0.1) continue;
                const nx = -dy / l * half, ny = dx / l * half, ha = groundFn(a.x, a.y) + lift, hb = groundFn(b.x, b.y) + lift;
                out.quad(out.V(a.x - nx, a.y - ny, ha), out.V(b.x - nx, b.y - ny, hb), out.V(b.x + nx, b.y + ny, hb), out.V(a.x + nx, a.y + ny, ha), c);
            }
        };
        out.mesh = (mat) => {
            if (!out.pos.length) return null;
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
            g.setAttribute('color', new THREE.Float32BufferAttribute(out.col, 3));
            return new THREE.Mesh(g, mat);
        };
        return out;
    }

    // Points along a polyline every `step` m, densified so drapes follow the terrain
    function densify(pts, step) {
        const out = [pts[0]];
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1], b = pts[i], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
            for (let k = 1; k <= n; k++) out.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
        }
        return out;
    }

    function nearestRoad(x, y, r) {
        let best = null;
        for (const e of OsmMatch.edgesNear(x, y, r)) {
            const dx = e.bx - e.ax, dy = e.by - e.ay, l2 = dx * dx + dy * dy || 1e-9;
            const t = Math.max(0, Math.min(1, ((x - e.ax) * dx + (y - e.ay) * dy) / l2));
            const d = Math.hypot(x - e.ax - dx * t, y - e.ay - dy * t);
            if (!best || d < best.d) best = { d, e };
        }
        return best;
    }

    function build(key) {
        const area = OsmOnline.areas.get(key), meshes = [];
        const add = (m, night) => { if (m) { m.userData.night = !!night; map.inner.add(m); meshes.push(m); } };
        const ground = Terrain.ground, dem = Terrain.dem;

        // Water: lakes flat at their lowest shore, rivers draped on the valley floor
        const water = builder();
        for (const w of area.water) {
            const p = poly(w.rings);
            if (p.rings[0].length < 4) continue;
            const flat = ['lake', 'pond', 'reservoir', 'basin'].includes(w.cls);
            const low = flat ? Math.min(...p.rings[0].map(q => dem(q.x, q.y))) + 0.3 : 0;
            const contour = p.rings[0].slice(0, -1).map(q => new THREE.Vector2(q.x, q.y));
            const holes = p.rings.slice(1).map(r => r.slice(0, -1).map(q => new THREE.Vector2(q.x, q.y)));
            const all = contour.concat(...holes);
            for (const t of THREE.ShapeUtils.triangulateShape(contour, holes)) {
                const v = t.map(k => water.V(all[k].x, all[k].y, flat ? low : dem(all[k].x, all[k].y) + 0.4));
                water.tri(v[0], v[1], v[2], new THREE.Color(1, 1, 1));
            }
        }
        const WIDTH = { river: 7, canal: 5, stream: 2.2, ditch: 1.2, drain: 1.2 };
        for (const w of area.waterways) {
            if (!WIDTH[w.cls]) continue;
            water.ribbon(densify(toMap(w.line), 8), WIDTH[w.cls] / 2, 0.35, 0xffffff, dem);
        }
        add(water.mesh(mats.water));

        // Railways: ballast and two rails
        const rail = builder();
        for (const line of area.rails) {
            const pts = densify(toMap(line), 6);
            rail.ribbon(pts, 1.6, 0.12, 0x8a8076, ground);
            for (const side of [-0.72, 0.72]) {
                const off = pts.map((p, i) => {
                    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
                    return { x: p.x - (b.y - a.y) / l * side, y: p.y + (b.x - a.x) / l * side };
                });
                rail.ribbon(off, 0.05, 0.3, 0xa7adb4, (x, y) => ground(x, y));
            }
        }
        add(rail.mesh(mats.solid));

        // Fuel stations: canopy with a red fascia on pillars, two pump islands
        const fuel = builder();
        for (const s of area.fuel) {
            const p = OsmMatch.project(s.lat, s.lon), r = nearestRoad(p.x, p.y, 60);
            const b = (r ? r.e.brg : 0) * Math.PI / 180, fx = Math.sin(b), fy = Math.cos(b);
            // On a forecourt slab as high as the highest ground under it, deep enough to hide any slope
            const corners = [[-8, -10], [8, -10], [-8, 10], [8, 10], [0, 0]].map(([a, d]) => dem(p.x + fy * a + fx * d, p.y - fx * a + fy * d));
            const h = Math.max(ground(p.x, p.y), ...corners) + 0.15;
            fuel.box(p.x, p.y, fx, fy, 0, 0, 16, 20, h - 3, 3, 0xbfc3c8);
            fuel.box(p.x, p.y, fx, fy, 0, 0, 9, 14, h + 4.6, 0.7, 0xf2f2f2);
            for (const side of [-1, 1]) fuel.box(p.x, p.y, fx, fy, side * 4.55, 0, 0.12, 14.2, h + 4.4, 0.9, 0xd32f2f);
            for (const [a, d] of [[-3.5, -5.5], [3.5, -5.5], [-3.5, 5.5], [3.5, 5.5]]) fuel.box(p.x, p.y, fx, fy, a, d, 0.35, 0.35, h, 4.6, 0xd0d4da);
            for (const a of [-2, 2]) {
                fuel.box(p.x, p.y, fx, fy, a, 0, 1.4, 6, h, 0.2, 0xb8bcc2);
                for (const d of [-1.5, 1.5]) fuel.box(p.x, p.y, fx, fy, a, d, 0.6, 0.9, h + 0.2, 1.8, 0xe8e8e8);
            }
        }
        add(fuel.mesh(mats.lit));

        // Street lamps on the right of urban roads every 30 m, with a pool of light at night
        const lampPos = [];
        for (const e of OsmMatch.edges) {
            if (!e.urban || typeof e.way !== 'string' || !e.way.startsWith(key + ':') || /service/.test(e.tags.highway)) continue;
            const l = OsmMatch.laneInfo(e), off = (l.fwd + l.back) * l.laneW / 2 + 0.8;
            const fx = (e.bx - e.ax) / e.len, fy = (e.by - e.ay) / e.len;
            for (let s = 15; s < e.len && lampPos.length < 700; s += 30) {
                const x = e.ax + fx * s + fy * off, y = e.ay + fy * s - fx * off;
                lampPos.push({ x, y, fx, fy, h: ground(x - fy * off, y + fx * off) });
            }
        }
        const lamp = builder(), heads = builder();
        for (const p of lampPos) {
            lamp.box(p.x, p.y, p.fx, p.fy, 0, 0, 0.14, 0.14, p.h, 7, 0x6b7078);
            lamp.box(p.x, p.y, p.fx, p.fy, -0.7, 0, 1.4, 0.12, p.h + 6.9, 0.12, 0x6b7078);
            heads.box(p.x, p.y, p.fx, p.fy, -1.3, 0, 0.6, 0.3, p.h + 6.75, 0.2, 0xfff0c8);
        }
        add(lamp.mesh(mats.solid));
        add(heads.mesh(mats.lit));
        if (lampPos.length) {
            const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mats.pool, lampPos.length), m4 = new THREE.Matrix4(), u = 1 / METERS_PER_UNIT;
            const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)), s = new THREE.Vector3(12 * u, 12 * u, 1);
            lampPos.forEach((p, i) => {
                const x = p.x - p.fy * 2.2, y = p.y + p.fx * 2.2;
                pools.setMatrixAt(i, m4.compose(new THREE.Vector3(-x * u, roadMesh.position.y + (ground(x, y) + 0.05) * u, y * u), q, s));
            });
            add(pools, true);
        }

        // Trees in woods and parks, off the roads and buildings
        const trees = [];
        for (const c of area.cover) {
            if (c.cls !== 'wood' && c.cls !== 'park') continue;
            const p = poly(c.rings), step = c.cls === 'wood' ? 9 : 16;
            for (let x = Math.ceil(p.minx / step) * step; x <= p.maxx && trees.length < 2500; x += step) {
                for (let y = Math.ceil(p.miny / step) * step; y <= p.maxy && trees.length < 2500; y += step) {
                    const j = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453, jx = (j - Math.floor(j) - 0.5) * step * 0.8, jy = ((j * 7) % 1 - 0.5) * step * 0.8;
                    const tx = x + jx, ty = y + jy;
                    if (!insidePoly(tx, ty, p)) continue;
                    const r = nearestRoad(tx, ty, 8);
                    if ((r && r.d < 6) || Buildings.hit(tx, ty)) continue;
                    trees.push({ x: tx, y: ty, s: 0.7 + (j - Math.floor(j)) * 0.7, h: dem(tx, ty) });
                }
            }
        }
        if (trees.length) {
            const u = 1 / METERS_PER_UNIT, m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
            const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.15 * u, 0.22 * u, 2.4 * u, 6).translate(0, 1.2 * u, 0), mats.trunk, trees.length);
            const crown = new THREE.InstancedMesh(new THREE.ConeGeometry(1.9 * u, 4.6 * u, 7).translate(0, 4 * u, 0), mats.crown, trees.length);
            trees.forEach((t, i) => {
                m4.compose(new THREE.Vector3(-t.x * u, roadMesh.position.y + t.h * u, t.y * u), q, new THREE.Vector3(t.s, t.s, t.s));
                trunk.setMatrixAt(i, m4);
                crown.setMatrixAt(i, m4);
            });
            add(trunk);
            add(crown);
        }
        built.set(key, { meshes });
        for (const m of meshes) if (m.userData.night) m.visible = dark;
    }

    function drop(key) {
        for (const m of built.get(key).meshes) {
            map.inner.remove(m);
            m.geometry.dispose();
        }
        built.delete(key);
    }

    World.reset = () => {
        for (const k of [...built.keys()]) drop(k);
        indexed.clear();
        coverGrid.clear();
    };

    function tick() {
        requestAnimationFrame(tick);
        const f = window.osmSim && osmSim.free;
        if (!window.OsmOnline || !f || !f.on || !map.inner) return;
        if (!mats) materials();
        if (dark !== isDarkTheme) { dark = isDarkTheme; paint(); }
        for (const k of OsmOnline.areas.keys()) if (!indexed.has(k)) { index(k); return; }
        const ll = OsmMatch.unproject(f.x, f.y), [tx, ty] = OsmOnline.tileOf(ll.lat, ll.lon), want = new Set();
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) want.add(`${tx + dx}/${ty + dy}`);
        for (const k of [...built.keys()]) if (!want.has(k)) drop(k);
        for (const k of want) {
            if (built.has(k) || !OsmOnline.areas.has(k) || !Buildings.has(k)) continue;
            const [lat, lon] = OsmOnline.tileCentre(...k.split('/').map(Number));
            if (!Terrain.has(lat, lon)) continue;
            build(k);
            break;
        }
    }

    window.World = World;
    requestAnimationFrame(tick);
})();
