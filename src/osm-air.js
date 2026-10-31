// Airports and flying: runways, taxiways and aprons from the vector tiles, Cessnas parked on the aprons and now and
// then one flying over, the plane the player can fly instead of the car, and the land seen from up there: a wide,
// coarse ground under satellite imagery beyond the detailed one around the plane
(() => {
    const RAD = Math.PI / 180;
    const SPAN = 11, MODEL_SPAN = 1270;    // m and model units: the Cessna 172's wingspan
    const LIFT = 0.25;                     // m: the paving above the ground it is draped on
    const WIDTH = { runway: 30, taxiway: 12 };
    const CELL = 50;
    // version: grows when a runway is fitted to the land, so the scene round it is laid out again
    const Air = { onMessage: null, version: 0 };

    // ================= The model =================
    let proto = null, protoJob = null;
    function loadModel() {
        if (protoJob) return protoJob;
        protoJob = new Promise((resolve, reject) => new THREE.GLTFLoader().load('plane.glb', g => {
            const m = g.scene;
            // Its author left it tilted a little: level, wheels down
            m.traverse(o => { if (o.name === 'Sketchfab_model') o.quaternion.set(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); });
            const s = SPAN / MODEL_SPAN / METERS_PER_UNIT, inner = new THREE.Group();
            inner.add(m);
            inner.scale.setScalar(s);
            // Nose towards +z, the way the view looks
            inner.rotation.y = Math.PI;
            inner.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(inner), c = box.getCenter(new THREE.Vector3());
            inner.position.set(-c.x, -box.min.y, -c.z);
            proto = new THREE.Group();
            proto.add(inner);
            resolve(proto);
        }, undefined, reject));
        return protoJob;
    }

    // A copy with its moving parts found; `lit` false for planes far off, drawn through the fog
    function makePlane(lit = true) {
        const wrap = new THREE.Group(), pitch = new THREE.Group(), roll = new THREE.Group(), body = proto.clone(true);
        const parts = {};
        body.traverse(o => {
            if (o.name === 'propelting') parts.prop = o;
            if (o.name === 'haleror') parts.elev = o;
            if (o.name === 'halerorvert') parts.rud = o;
            if (!lit && o.isMesh) {
                const ms = [].concat(o.material).map(mt => { const c = mt.clone(); c.fog = false; return c; });
                o.material = ms.length === 1 ? ms[0] : ms;
            }
        });
        for (const k of Object.keys(parts)) parts[k].userData.q0 = parts[k].quaternion.clone();
        roll.add(body);
        pitch.add(roll);
        wrap.add(pitch);
        return { wrap, pitch, roll, parts, lit };
    }

    const qa = new THREE.Quaternion(), axis = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
    // The propeller turning with the engine, the elevator and rudder following the stick
    function animate(p, dt, rpm, elev, rud) {
        const { prop, elev: e, rud: r } = p.parts;
        if (prop) { p.spin = ((p.spin || 0) + rpm / 60 * 2 * Math.PI * dt) % (2 * Math.PI); prop.quaternion.copy(prop.userData.q0).multiply(qa.setFromAxisAngle(axis.z, p.spin)); }
        if (e) e.quaternion.copy(e.userData.q0).multiply(qa.setFromAxisAngle(axis.x, elev * 0.35));
        if (r) r.quaternion.copy(r.userData.q0).multiply(qa.setFromAxisAngle(axis.y, rud * 0.3));
    }

    // Map metres to the view's map frame, as the rest of the world
    const V = (x, y, h) => new THREE.Vector3(-x / METERS_PER_UNIT, roadMesh.position.y + h / METERS_PER_UNIT, y / METERS_PER_UNIT);
    function pose(p, x, y, h, brg, pitch, roll) {
        p.wrap.position.copy(V(x, y, h));
        p.wrap.rotation.y = -brg * RAD;
        p.pitch.rotation.x = -pitch;
        p.roll.rotation.z = roll;
    }

    // ================= Airports =================
    const toMap = l => l.map(([lat, lon]) => OsmMatch.project(lat, lon));
    const indexed = new Set(), built = new Map();
    const runways = [];                    // every runway loaded, whole
    const places = new Map();              // towns, villages and peaks loaded, in map metres
    const paved = new Map();               // grid cell -> [{ seg | poly }], for the tiles drawn
    let mats = null, dark = null;

    function inside(x, y, ring) {
        let c = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[i], b = ring[j];
            if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c;
        }
        return c;
    }
    const segDist = (x, y, a, b) => {
        const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
        return Math.hypot(x - a.x - dx * t, y - a.y - dy * t);
    };
    const widthOf = (cls, big) => cls === 'runway' ? (big ? 45 : WIDTH.runway) : WIDTH.taxiway;

    // Every runway as it comes in, whole: the tiles cut a runway at their edges, its pieces are joined again (same
    // line, touching or overlapping). A runway is { a, b, len, ux, uy, w, name }, fitted to the land once its
    // elevation is in
    function index(key) {
        const a = OsmOnline.areas.get(key);
        indexed.add(key);
        if (!a || !a.aero) return;
        const big = a.aero.labels.some(l => l.cls === 'international' || l.cls === 'regional');
        const name = (a.aero.labels[0] || {}).name || '';
        for (const l of a.aero.lines) {
            if (l.cls !== 'runway' || l.line.length < 2) continue;
            const pts = toMap(l.line);
            addRunway(pts[0], pts[pts.length - 1], widthOf('runway', big), name);
        }
        for (const p of a.places || []) {
            const k = p.cls + ':' + p.name + ':' + p.lat.toFixed(2) + ',' + p.lon.toFixed(2);
            if (!places.has(k) && p.name) places.set(k, { ...p, ...OsmMatch.project(p.lat, p.lon) });
        }
    }

    function addRunway(a, b, w, name) {
        let len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 30) return;
        for (const r of runways) {
            const along = p => (p.x - r.a.x) * r.ux + (p.y - r.a.y) * r.uy, across = p => Math.abs((p.x - r.a.x) * -r.uy + (p.y - r.a.y) * r.ux);
            if (across(a) > 6 || across(b) > 6) continue;
            const ta = along(a), tb = along(b);
            if (Math.max(ta, tb) < -60 || Math.min(ta, tb) > r.len + 60) continue;
            // The same runway: stretched to cover both
            const t0 = Math.min(0, ta, tb), t1 = Math.max(r.len, ta, tb);
            if (t0 < 0 || t1 > r.len) {
                const a0 = { x: r.a.x + r.ux * t0, y: r.a.y + r.uy * t0 };
                Object.assign(r, { a: a0, b: { x: r.a.x + r.ux * t1, y: r.a.y + r.uy * t1 }, len: t1 - t0, fit: null, version: r.version + 1 });
            }
            r.name = r.name || name;
            r.w = Math.max(r.w, w);
            return;
        }
        runways.push({ a, b, len, ux: (b.x - a.x) / len, uy: (b.y - a.y) / len, w, name, fit: null, version: 0, built: null });
    }

    // Graded flat: a straight slope along it fitted to the land, the same all across. Null until its elevation is in
    function fitRunway(r) {
        if (r.fit) return r.fit;
        const n = Math.max(2, Math.ceil(r.len / 25)), ts = [], hs = [];
        for (let i = 0; i <= n; i++) {
            const t = r.len * i / n, x = r.a.x + r.ux * t, y = r.a.y + r.uy * t, ll = OsmMatch.unproject(x, y);
            if (!Terrain.has(ll.lat, ll.lon)) return null;
            ts.push(t);
            hs.push(Terrain.dem(x, y));
        }
        const mt = ts.reduce((a, b) => a + b) / ts.length, mh = hs.reduce((a, b) => a + b) / hs.length;
        let sxy = 0, sxx = 0;
        ts.forEach((t, i) => { sxy += (t - mt) * (hs[i] - mh); sxx += (t - mt) ** 2; });
        // Runways are nearly level: at most 2 % along
        const slope = Math.max(-0.02, Math.min(0.02, sxx ? sxy / sxx : 0));
        r.fit = { h0: mh - slope * mt, slope };
        // The scene's ground is laid level with it: drawn again
        Air.version++;
        return r.fit;
    }

    // Where (x, y) is from runway r: along it, across it, and how far outside its paving
    function relRunway(r, x, y) {
        const t = (x - r.a.x) * r.ux + (y - r.a.y) * r.uy, c = (x - r.a.x) * -r.uy + (y - r.a.y) * r.ux;
        const out = Math.max(0, Math.abs(c) - r.w / 2, -t, t - r.len);
        return { t, c, out };
    }

    // The nearest runway's flat level at (x, y) and how far outside its paving, within r m; for the ground round it
    Air.flatAt = (x, y, rr) => {
        let best = null;
        for (const r of runways) {
            if (!r.fit) continue;
            const q = relRunway(r, x, y);
            if (q.out < rr && (!best || q.out < best.d)) best = { d: q.out, h: r.fit.h0 + r.fit.slope * Math.max(0, Math.min(r.len, q.t)) };
        }
        return best;
    };

    // The ground near a runway as the terrain lays it: level with the runway, easing back to the land over 40 m
    function levelled(x, y) {
        const g = Terrain.ground(x, y), flat = Air.flatAt(x, y, 48);
        if (!flat) return g;
        const k = Math.min(1, Math.max(0, (flat.d - 8) / 40));
        return flat.h - 0.4 + (g - flat.h + 0.4) * k * k * (3 - 2 * k);
    }

    function materials() {
        mats = {
            paving: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
            marks: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
            runway: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
            // Lights a few pixels across wherever they are, seen through the fog at night
            lights: new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, vertexColors: true, map: glowTexture(), transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }),
        };
    }
    function paint() {
        mats.paving.color.setScalar(dark ? 0.45 : 1);
        mats.marks.color.setScalar(dark ? 0.6 : 1);
        mats.runway.color.setScalar(dark ? 0.45 : 1);
        // By day the lights are faint and small
        mats.lights.opacity = dark ? 1 : 0.45;
        mats.lights.size = dark ? 6 : 3;
        for (const r of runways) if (r.built) for (const m of r.built.meshes) if (m.material.map && m.material !== mats.lights) m.material.color.setScalar(dark ? 0.6 : 1);
    }

    function addPaved(item) {
        const { minx, maxx, miny, maxy } = item;
        for (let i = Math.floor(minx / CELL); i <= Math.floor(maxx / CELL); i++) {
            for (let j = Math.floor(miny / CELL); j <= Math.floor(maxy / CELL); j++) {
                const k = i + ',' + j;
                if (!paved.has(k)) paved.set(k, []);
                paved.get(k).push(item);
            }
        }
    }

    function build(key) {
        const area = OsmOnline.areas.get(key), meshes = [], planes = [], items = [];
        const pos = [], col = [], mpos = [], mcol = [];
        const ground = (x, y) => levelled(x, y) + LIFT;
        const tri = (P, C, a, b, c, colour) => { P.push(...a.toArray(), ...b.toArray(), ...c.toArray()); for (let k = 0; k < 3; k++) C.push(colour.r, colour.g, colour.b); };
        const taxi = new THREE.Color(0x5f6267), apron = new THREE.Color(0x696c70), yellow = new THREE.Color(0xd9b13b);
        const big = area.aero.labels.some(l => l.cls === 'international' || l.cls === 'regional');
        // A strip along a line, every few metres so it follows the ground; marks a little above
        const strip = (P, C, pts, half, colour, lift, dash) => {
            let s = 0;
            for (let i = 0; i < pts.length - 1; i++) {
                const a = pts[i], b = pts[i + 1], l = Math.hypot(b.x - a.x, b.y - a.y);
                if (l < 0.1) continue;
                const n = Math.max(1, Math.ceil(l / 10)), nx = -(b.y - a.y) / l * half, ny = (b.x - a.x) / l * half;
                for (let k = 0; k < n; k++) {
                    const s0 = s + l * k / n, s1 = s + l * (k + 1) / n;
                    if (dash && (s0 % dash[0]) > dash[1]) continue;
                    const p = { x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n }, q = { x: a.x + (b.x - a.x) * (k + 1) / n, y: a.y + (b.y - a.y) * (k + 1) / n };
                    const hp = ground(p.x, p.y) + lift, hq = ground(q.x, q.y) + lift;
                    const A = V(p.x - nx, p.y - ny, hp), B = V(q.x - nx, q.y - ny, hq), Cc = V(q.x + nx, q.y + ny, hq), D = V(p.x + nx, p.y + ny, hp);
                    tri(P, C, A, B, Cc, colour);
                    tri(P, C, A, Cc, D, colour);
                }
                s += l;
            }
        };
        for (const l of area.aero.lines) {
            // Runways are drawn whole, on their own
            if (l.cls === 'runway') continue;
            const pts = toMap(l.line), half = widthOf(l.cls, big) / 2;
            strip(pos, col, pts, half, taxi, 0);
            // A yellow line down the middle
            strip(mpos, mcol, pts, 0.15, yellow, 0.02);
            for (let i = 0; i < pts.length - 1; i++) {
                const a = pts[i], b = pts[i + 1];
                items.push({ seg: [a, b], half, minx: Math.min(a.x, b.x) - half, maxx: Math.max(a.x, b.x) + half, miny: Math.min(a.y, b.y) - half, maxy: Math.max(a.y, b.y) + half });
            }
        }
        const aprons = [];
        for (const p of area.aero.polys) {
            if (p.cls !== 'apron' && p.cls !== 'taxiway') continue;
            const rings = p.rings.map(toMap);
            if (rings[0].length < 4) continue;
            const contour = rings[0].slice(0, -1).map(q => new THREE.Vector2(q.x, q.y));
            const holes = rings.slice(1).map(r => r.slice(0, -1).map(q => new THREE.Vector2(q.x, q.y)));
            const all = contour.concat(...holes);
            for (const t of THREE.ShapeUtils.triangulateShape(contour, holes)) {
                const v = t.map(k => V(all[k].x, all[k].y, ground(all[k].x, all[k].y) - 0.01));
                tri(pos, col, v[0], v[1], v[2], p.cls === 'apron' ? apron : taxi);
            }
            const xs = rings[0].map(q => q.x), ys = rings[0].map(q => q.y);
            const item = { rings, minx: Math.min(...xs), maxx: Math.max(...xs), miny: Math.min(...ys), maxy: Math.max(...ys) };
            items.push(item);
            if (p.cls === 'apron') aprons.push(item);
        }
        for (const [P, C, mat] of [[pos, col, mats.paving], [mpos, mcol, mats.marks]]) {
            if (!P.length) continue;
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
            g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
            const m = new THREE.Mesh(g, mat);
            map.inner.add(m);
            meshes.push(m);
        }
        for (const it of items) addPaved(it);
        // A few Cessnas on the aprons, in rows clear of each other
        if (proto) {
            for (const a of aprons) {
                const w = a.maxx - a.minx, h = a.maxy - a.miny, n = Math.min(3, Math.floor(w * h / 1500));
                const seed = Math.abs(Math.sin(a.minx * 0.13 + a.miny * 0.71)) * 1000;
                let placed = 0;
                for (let k = 0; k < 40 && placed < n; k++) {
                    const fx = ((seed * (k + 1) * 0.618) % 1), fy = ((seed * (k + 1) * 0.382 + 0.5) % 1);
                    const x = a.minx + w * (0.15 + 0.7 * fx), y = a.miny + h * (0.15 + 0.7 * fy);
                    if (!inside(x, y, a.rings[0]) || planes.some(q => Math.hypot(q.x - x, q.y - y) < 16) || (window.Buildings && Buildings.hit(x, y))) continue;
                    const p = makePlane(true);
                    pose(p, x, y, ground(x, y), (seed * (k + 3)) % 360, 0, 0);
                    map.inner.add(p.wrap);
                    planes.push({ x, y, p });
                    placed++;
                }
            }
        }
        built.set(key, { meshes, planes, items });
    }

    function drop(key) {
        const b = built.get(key);
        for (const m of b.meshes) { map.inner.remove(m); m.geometry.dispose(); }
        for (const q of b.planes) map.inner.remove(q.p.wrap);
        for (const [k, list] of paved) {
            const rest = list.filter(it => !b.items.includes(it));
            if (rest.length) paved.set(k, rest); else paved.delete(k);
        }
        built.delete(key);
    }

    // Height of the paving at (x, y), null off it: a runway's own flat level, else the taxiway's or apron's
    Air.pavedAt = (x, y) => {
        for (const r of runways) {
            if (!r.fit) continue;
            const q = relRunway(r, x, y);
            if (q.out === 0) return r.fit.h0 + r.fit.slope * q.t + LIFT;
        }
        const list = paved.get(Math.floor(x / CELL) + ',' + Math.floor(y / CELL));
        if (!list) return null;
        for (const it of list) {
            if (x < it.minx || x > it.maxx || y < it.miny || y > it.maxy) continue;
            if (it.seg ? segDist(x, y, it.seg[0], it.seg[1]) <= it.half : inside(x, y, it.rings[0])) return levelled(x, y) + LIFT;
        }
        return null;
    };

    // The runway nearest to (x, y) within r: where to line up on it, at its end nearer the point
    Air.runwayNear = (x, y, rr) => {
        for (const k of OsmOnline.areas.keys()) if (!indexed.has(k)) index(k);
        let best = null;
        for (const r of runways) {
            if (r.len < 250) continue;
            const d = segDist(x, y, r.a, r.b);
            if (d < rr && (!best || d < best.d)) best = { d, r };
        }
        if (!best) return null;
        const { r } = best, nearA = Math.hypot(x - r.a.x, y - r.a.y) < Math.hypot(x - r.b.x, y - r.b.y);
        const [from, to, s] = nearA ? [r.a, r.b, 1] : [r.b, r.a, -1];
        return { x: from.x + r.ux * 25 * s, y: from.y + r.uy * 25 * s, brg: OsmMatch.bearing(from.x, from.y, to.x, to.y), name: r.name, mid: { x: (r.a.x + r.b.x) / 2, y: (r.a.y + r.b.y) / 2 }, runway: r };
    };
    Air.runwaysNear = (x, y, rr) => runways.filter(r => segDist(x, y, r.a, r.b) < rr);
    Air.placesNear = (x, y, rr) => [...places.values()].filter(p => Math.abs(p.x - x) < rr && Math.abs(p.y - y) < rr);

    // ---- A runway drawn whole: flat, its markings (edges, centre line, thresholds, numbers, aiming points) and
    // lights (edges, thresholds, approach) ----
    let glow = null;
    function glowTexture() {
        if (glow) return glow;
        const c = document.createElement('canvas');
        c.width = c.height = 32;
        const g = c.getContext('2d'), gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
        gr.addColorStop(0, 'rgba(255,255,255,1)');
        gr.addColorStop(0.35, 'rgba(255,255,255,.8)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr;
        g.fillRect(0, 0, 32, 32);
        return glow = new THREE.CanvasTexture(c);
    }
    function numberTexture(text) {
        const c = document.createElement('canvas');
        c.width = 128;
        c.height = 256;
        const g = c.getContext('2d');
        g.fillStyle = '#e8e8e8';
        g.font = '700 200px system-ui,sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.setTransform(0.55, 0, 0, 1, 64, 140);
        g.fillText(text, 0, 0);
        const t = new THREE.CanvasTexture(c);
        t.anisotropy = 4;
        return t;
    }

    function buildRunway(r) {
        const fit = fitRunway(r);
        if (!fit) return;
        const half = r.w / 2, len = r.len;
        const at = (t, c) => ({ x: r.a.x + r.ux * t - r.uy * c, y: r.a.y + r.uy * t + r.ux * c });
        const P = (t, c, lift = 0) => { const q = at(t, c); return V(q.x, q.y, fit.h0 + fit.slope * Math.max(0, Math.min(len, t)) + LIFT + lift); };
        const pos = [], col = [], mpos = [], mcol = [];
        const tri = (A, C, a, b, c, k) => { A.push(...a.toArray(), ...b.toArray(), ...c.toArray()); for (let i = 0; i < 3; i++) C.push(k.r, k.g, k.b); };
        const rect = (A, C, t0, t1, c0, c1, k, lift) => {
            for (let t = t0; t < t1 - 0.01; t += 60) {
                const e = Math.min(t1, t + 60), a = P(t, c0, lift), b = P(e, c0, lift), c = P(e, c1, lift), d = P(t, c1, lift);
                tri(A, C, a, b, c, k);
                tri(A, C, a, c, d, k);
            }
        };
        const asphalt = new THREE.Color(0x3d4045), shoulder = new THREE.Color(0x585b60), white = new THREE.Color(0xeeeeee);
        rect(pos, col, 0, len, -half - 3, half + 3, shoulder, -0.02);
        rect(pos, col, 0, len, -half, half, asphalt, 0);
        // Side stripes along the edges, and the centre line in dashes between the threshold markings
        for (const side of [-1, 1]) rect(mpos, mcol, 0, len, side * (half - 1.4), side * (half - 0.5), white, 0.02);
        for (let t = 75; t < len - 75; t += 50) rect(mpos, mcol, t, Math.min(t + 30, len - 75), -0.45, 0.45, white, 0.02);
        const keys = r.w >= 45 ? 12 : r.w >= 30 ? 8 : 4, gap = 1.8, room = half - 3, kw = Math.min(1.8, (room - gap) / (keys / 2) - 1.2);
        const numbers = [];
        for (const end of [0, 1]) {
            // From this end along the runway: t grows inward
            const T = (d) => end ? len - d : d, span = (d0, d1) => end ? [len - d1, len - d0] : [d0, d1];
            // Piano keys
            for (let i = 0; i < keys / 2; i++) {
                const c0 = gap + i * (room - gap) / (keys / 2), [t0, t1] = span(6, 36);
                for (const side of [-1, 1]) rect(mpos, mcol, t0, t1, side * c0, side * (c0 + kw), white, 0.02);
            }
            // Aiming points on longer runways
            if (len > 1200) {
                const [t0, t1] = span(300, 345);
                for (const side of [-1, 1]) rect(mpos, mcol, t0, t1, side * half * 0.3, side * (half * 0.3 + Math.min(9, r.w * 0.2)), white, 0.02);
            }
            // The number: the heading flying in from this end, in tens of degrees
            const brg = (OsmMatch.bearing(r.a.x, r.a.y, r.b.x, r.b.y) + (end ? 180 : 0)) % 360;
            const num = String(Math.round(brg / 10) || 36).padStart(2, '0');
            const s = end ? -1 : 1, left = s, t0 = T(44), t1 = T(62), w = Math.min(4.5, half * 0.3);
            numbers.push({ num, quad: [P(t0, left * w, 0.03), P(t0, -left * w, 0.03), P(t1, -left * w, 0.03), P(t1, left * w, 0.03)] });
        }
        const meshes = [];
        for (const [A, C, mat] of [[pos, col, mats.runway], [mpos, mcol, mats.marks]]) {
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(A, 3));
            g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
            meshes.push(new THREE.Mesh(g, mat));
        }
        for (const n of numbers) {
            const g = new THREE.BufferGeometry(), q = n.quad;
            g.setAttribute('position', new THREE.Float32BufferAttribute([...q[0].toArray(), ...q[1].toArray(), ...q[2].toArray(), ...q[0].toArray(), ...q[2].toArray(), ...q[3].toArray()], 3));
            g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
            const mat = new THREE.MeshBasicMaterial({ map: numberTexture(n.num), transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
            mat.color.setScalar(dark ? 0.6 : 1);
            meshes.push(new THREE.Mesh(g, mat));
        }
        // Lights: white along the edges every 60 m, green across both ends, white approach lights 420 m out
        const lp = [], lc = [], light = (q, h, k) => { lp.push(...V(q.x, q.y, h).toArray()); lc.push(k.r, k.g, k.b); };
        const green = new THREE.Color(0x3cff7a), warm = new THREE.Color(0xfff2c8);
        const hAt = t => fit.h0 + fit.slope * Math.max(0, Math.min(len, t)) + LIFT + 0.5;
        for (let t = 0; t <= len + 0.1; t += Math.max(30, len / Math.ceil(len / 60))) for (const side of [-1, 1]) light(at(t, side * (half + 1.5)), hAt(t), warm);
        for (const end of [0, 1]) {
            const t = end ? len + 3 : -3;
            for (let c = -half; c <= half; c += 3) light(at(t, c), hAt(t), green);
            for (let d = 30; d <= 420; d += 30) {
                const ta = end ? len + d : -d, q = at(ta, 0);
                light(q, levelled(q.x, q.y) + 0.8, warm);
                if (d === 300) for (const c of [-12, -8, -4, 4, 8, 12]) { const w = at(ta, c); light(w, levelled(w.x, w.y) + 0.8, warm); }
            }
        }
        const lg = new THREE.BufferGeometry();
        lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
        lg.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
        const lights = new THREE.Points(lg, mats.lights);
        lights.frustumCulled = false;
        meshes.push(lights);
        for (const m of meshes) map.inner.add(m);
        r.built = { meshes, version: r.version };
    }

    function dropRunway(r) {
        for (const m of r.built.meshes) {
            map.inner.remove(m);
            m.geometry.dispose();
            if (m.material.map && m.material !== mats.lights) { m.material.map.dispose(); m.material.dispose(); }
        }
        r.built = null;
    }

    function updateRunways(f) {
        for (const r of runways) {
            const d = segDist(f.x, f.y, r.a, r.b);
            if (r.built && (d > 9000 || r.built.version !== r.version)) dropRunway(r);
            if (!r.built && d < 7000 && fitRunway(r)) buildRunway(r);
        }
    }

    // ================= A plane passing over now and then =================
    let flyover = null, nextFlyover = 0;
    function updateFlyover(f, now, dt) {
        if (!proto || !map.inner) return;
        if (!flyover) {
            if (!nextFlyover) nextFlyover = now + 60000 + Math.random() * 60000;
            if (now < nextFlyover || plane.on) return;
            nextFlyover = now + 120000 + Math.random() * 120000;
            const dir = Math.random() * 360, side = (Math.random() - 0.5) * 600, b = dir * RAD;
            const sx = f.x - Math.sin(b) * 2500 + Math.cos(b) * side, sy = f.y - Math.cos(b) * 2500 - Math.sin(b) * side;
            flyover = { p: makePlane(false), x: sx, y: sy, brg: dir, v: 55, h: Terrain.ground(f.x, f.y) + 250 + Math.random() * 200, d: 0 };
            map.inner.add(flyover.p.wrap);
        }
        const o = flyover, b = o.brg * RAD;
        o.x += Math.sin(b) * o.v * dt;
        o.y += Math.cos(b) * o.v * dt;
        o.d += o.v * dt;
        pose(o.p, o.x, o.y, o.h, o.brg, 0.02, 0);
        animate(o.p, dt, 2400, 0, 0);
        if (o.d > 5000) { map.inner.remove(o.p.wrap); flyover = null; }
    }

    // ================= Flying =================
    // Arcade: the plane goes where its nose points while fast enough; slower it sinks and drops its nose (stall).
    // Roll turns it, coordinated; on the ground the nose wheel steers and the throttle at idle brakes
    const VSTALL = 24, VROT = 23, VLIFT = 30, GROUND_V = 2;
    const KP = 0.6, KR = 0.25;             // shares of pitch and roll the view follows; the plane shows the rest
    const plane = { on: false, mesh: null, saved: null, stick: { x: 0, y: 0 }, touch: null, thrSet: 0, crashedAt: 0, stall: false };

    // Under the plane: the detailed ground where its elevation has come in, else the coarse one
    function groundAt(x, y) {
        const ll = OsmMatch.unproject(x, y);
        if (Terrain.has(ll.lat, ll.lon)) return Terrain.surface(x, y);
        const h = far.heightAt(ll.lat, ll.lon);
        return Number.isFinite(h) ? h : -1e9;
    }

    Air.start = async (f, x, y, inAir) => {
        await loadModel();
        let spot = null;
        if (!inAir) spot = Air.runwayNear(x, y, 20000);
        if (!inAir && !spot && Air.onMessage) Air.onMessage('noRunway');
        const brg = spot ? spot.brg : f.brg;
        const px = spot ? spot.x : x, py = spot ? spot.y : y;
        Object.assign(f, { kind: 'plane', x: px, y: py, brg, pitch: 0, roll: 0, vz: 0, steer: 0, thr: 0, brk: 0, off: 0, air: !!(inAir || !spot), gear: 'D', rpm: 800, shiftUntil: 0 });
        plane.thrSet = spot ? 0 : 0.75;
        f.v = spot ? 0 : 50;
        f.z = spot ? -1e9 : groundAt(px, py) + 300;
        plane.ground = !!spot;
        plane.crashedAt = 0;
        enterView();
        return spot;
    };

    Air.stop = f => {
        if (f) f.kind = 'car';
        leaveView();
    };

    // On a runway found by runwayNear, stopped, engine at idle
    Air.placeOn = (f, spot) => {
        Object.assign(f, { x: spot.x, y: spot.y, brg: spot.brg, v: 0, vz: 0, pitch: 0, roll: 0, thr: 0, air: false, z: -1e9 });
        plane.thrSet = 0;
        plane.ground = true;
        plane.crashedAt = 0;
        if (window.Net && Net.ghost) Net.ghost();
    };

    function enterView() {
        if (plane.on) return;
        plane.on = true;
        if (!plane.mesh) plane.mesh = makePlane(true);
        scene.add(plane.mesh.wrap);
        if (model) model.visible = false;
        plane.saved = { drive: { ...drivePose }, far: camera.far };
        drivePose = { az: drivePose.az, h: 6.5, d: 17 };
        camDist = drivePose.d;
        camera.far = 15000;
        camera.updateProjectionMatrix();
        // Roads and their lines drawn farther round the point ahead
        Terrain.range = 600;
        far.show(true);
        Air.hud(true);
    }

    function leaveView() {
        if (!plane.on) return;
        plane.on = false;
        if (plane.mesh) scene.remove(plane.mesh.wrap);
        if (model) model.visible = true;
        if (Terrain.groundMesh) Terrain.groundMesh.visible = true;
        drivePose = plane.saved.drive;
        camDist = drivePose.d;
        camera.far = plane.saved.far;
        camera.updateProjectionMatrix();
        Terrain.fogAir = null;
        Terrain.range = null;
        nav = null;
        for (const p of [...labels.keys()]) dropLabel(p);
        far.show(false);
        Air.hud(false);
    }

    function crash(f, now) {
        if (plane.crashedAt) return;
        plane.crashedAt = now;
        f.v = 0;
        f.thr = 0;
        if (window.Engine) Engine.crash(25);
        if (Air.onMessage) Air.onMessage('planeCrash');
    }

    // Back in the air above where it fell, level and flying; with an empty tank, help brings it to a runway instead
    function respawn(f) {
        if (window.Fuel && Fuel.empty && Fuel.rescue()) return;
        Object.assign(f, { z: Math.max(groundAt(f.x, f.y), 0) + 300, v: 50, vz: 0, pitch: 0, roll: 0, air: true });
        plane.thrSet = 0.75;
        plane.ground = false;
        plane.crashedAt = 0;
        if (window.Net && Net.ghost) Net.ghost();
    }

    Air.step = (f, dt, now) => {
        const k = c => f.keys.has(c);
        // Map or settings open: the plane waits in the air where it is
        if (f.paused) { show(f, 0, 0, 0); return; }
        if (plane.crashedAt) {
            if (now - plane.crashedAt > 1800) respawn(f);
            show(f, dt, 0, 0);
            return;
        }
        // Stick: keys give full deflection, eased in; the touch stick is analogue
        const want = plane.touch || {
            x: (k('ArrowRight') || k('KeyD') ? 1 : 0) - (k('ArrowLeft') || k('KeyA') ? 1 : 0),
            y: (k('ArrowDown') ? 1 : 0) - (k('ArrowUp') ? 1 : 0)
        };
        const ease = 1 - Math.exp(-dt / 0.12);
        plane.stick.x += (want.x - plane.stick.x) * ease;
        plane.stick.y += (want.y - plane.stick.y) * ease;
        if (!plane.touch || plane.touch.thr == null) {
            if (k('KeyW')) plane.thrSet = Math.min(1, plane.thrSet + 0.6 * dt);
            if (k('KeyS')) plane.thrSet = Math.max(0, plane.thrSet - 0.6 * dt);
        } else plane.thrSet = plane.touch.thr;
        // An empty tank stops the engine: the plane glides
        const dry = window.Fuel && Fuel.empty;
        f.thr += Math.max(-0.8 * dt, Math.min(0.8 * dt, (dry ? 0 : plane.thrSet) - f.thr));
        const sx = plane.stick.x, sy = plane.stick.y, v = Math.max(0, f.v);
        // Full lift from about 108 km/h: slower, it sinks more and more (so at idle it comes down to land), and
        // under the stall speed the nose drops too
        const lift = Math.min(1, (v / VLIFT) ** 2);

        // Thrust, drag and, along the path, gravity: about 320 km/h flat out
        let a = 5.2 * f.thr - 0.00065 * v * v;
        const g0 = groundAt(f.x, f.y);
        if (plane.ground) {
            const onPaving = Air.pavedAt(f.x, f.y) != null;
            a -= 0.3 + (onPaving ? 0 : 0.9) + (f.thr < 0.05 ? 1.8 : 0);
            // Nose wheel: sharp turns slowly, gentle ones fast
            f.brg = (f.brg + sx * Math.min(0.6, 8 / (v + 2)) / RAD * dt + 360) % 360;
            f.roll += (0 - f.roll) * ease;
            // The nose comes up by itself once fast enough with the throttle open (the stick back brings it up sooner,
            // pushed forward keeps it down); it lifts off as soon as the wings carry it
            const auto = v > VLIFT * 0.92 && f.thr > 0.4 && want.y > -0.05 ? 0.13 : 0;
            const target = v > VROT ? Math.max(auto, Math.max(0, sy) * 0.2) : 0;
            f.pitch += (target - f.pitch) * (1 - Math.exp(-dt / 0.4));
            f.v = Math.max(0, v + a * dt);
            f.z = g0;
            f.vz = 0;
            if (lift > 0.88 && f.pitch > 0.06) { plane.ground = false; f.vz = Math.max(1, v * Math.sin(f.pitch)); }
        } else {
            // Roll with the stick, back to level without it; pitch with the stick, easing back towards level
            const rolling = Math.abs(want.x) > 0.05, pitching = Math.abs(want.y) > 0.05;
            f.roll += Math.max(-1.2 * dt, Math.min(1.2 * dt, (rolling ? sx * 1.05 : 0) - f.roll)) * (rolling ? 1 : 0.7);
            f.pitch += (pitching ? sy * 0.55 : -f.pitch * 0.4) * dt;
            plane.stall = v < VSTALL * 0.9;
            if (plane.stall) f.pitch -= 0.45 * dt;
            // Close to the ground without the stick: the nose comes up a little (a flare), so it settles gently
            const agl = f.z - groundAt(f.x, f.y);
            if (!pitching && agl < 12 && f.vz < 0) f.pitch += (0.05 - f.pitch) * Math.min(1, 1.5 * dt);
            // Just off the ground with the throttle open and hands off: it keeps climbing away
            else if (!pitching && agl < 40 && f.thr > 0.4) f.pitch += (0.11 - f.pitch) * Math.min(1, 1.5 * dt);
            f.pitch = Math.max(-0.6, Math.min(0.5, f.pitch));
            a -= 9.81 * Math.sin(f.pitch) * lift;
            f.v = Math.max(0, Math.min(100, v + a * dt));
            // Coordinated turn
            f.brg = (f.brg + 9.81 * Math.tan(f.roll) / Math.max(v, 15) / RAD * dt + 360) % 360;
            f.vz = v * Math.sin(f.pitch) * lift - (1 - lift) * 9;
            f.z = Math.min(4000, f.z + f.vz * dt);
        }
        const b = f.brg * RAD, hv = v * Math.cos(f.pitch);
        f.x += Math.sin(b) * hv * dt;
        f.y += Math.cos(b) * hv * dt;

        // Down onto the ground: a landing if gentle, level and nose up enough, else a crash
        if (!plane.ground) {
            const g = groundAt(f.x, f.y), roof = window.Buildings && Buildings.topAt(f.x, f.y);
            if (roof != null && f.z < roof) crash(f, now);
            else if (f.z <= g) {
                if (f.vz < -6 || Math.abs(f.roll) > 0.35 || f.pitch < -0.15) crash(f, now);
                else { plane.ground = true; f.z = g; f.vz = 0; f.roll = 0; f.pitch = Math.max(0, f.pitch); }
            }
        } else if (window.Buildings && Buildings.hit(f.x + Math.sin(b) * 4, f.y + Math.cos(b) * 4)) {
            if (v > 8) crash(f, now); else f.v = 0;
        }
        f.air = !plane.ground;
        f.rpm = 700 + 1900 * f.thr + 8 * v;
        show(f, dt, sx, sy);
    };

    function show(f, dt, sx, sy) {
        // The view follows most of the pitch and a little of the roll; the plane shows the rest
        const g = groundAt(f.x, f.y);
        Terrain.car = { x: f.x, y: f.y, brg: f.brg, z: f.z, pitch: f.pitch * KP, roll: -f.roll * KR, ground: g > -1e8 ? g : null };
        const p = plane.mesh;
        if (p) {
            p.wrap.position.set(0, roadMesh.position.y, 0);
            p.wrap.rotation.y = 0;
            p.pitch.rotation.x = -f.pitch * (1 - KP);
            p.roll.rotation.z = f.roll * (1 - KR);
            animate(p, dt, plane.crashedAt ? 0 : f.rpm, sy, sx);
        }
        // The farther it sees, the higher it flies
        const agl = Math.max(0, f.z - groundAt(f.x, f.y)), w = Terrain.fog;
        const base = { near: Math.min(4000, 800 + agl * 6), far: Math.min(14000, 5000 + agl * 18) };
        Terrain.fogAir = w ? { near: Math.min(base.near, w.near * 8), far: Math.min(base.far, w.far * 12) } : base;
        Air.agl = agl;
        // Roads drawn farther round the point ahead, the higher the farther
        Terrain.range = Math.min(1100, 600 + agl);
        // High up the satellite picture is the ground, under the roads and buildings; low down the detailed one
        if (Terrain.groundMesh) Terrain.groundMesh.visible = agl < 150;
    }

    Air.state = () => ({ on: plane.on, thr: plane.thrSet, stall: plane.stall && !plane.ground, ground: plane.ground, crashed: !!plane.crashedAt, agl: Air.agl || 0 });
    Air.setTouch = t => { plane.touch = t; };
    Air.makePlane = (lit) => proto ? makePlane(lit) : null;
    Air.pose = pose;
    Air.animate = animate;
    Air.load = loadModel;
    Object.defineProperty(Air, 'flying', { get: () => plane.on });

    // ================= The land from up there =================
    // A grid of about 18 km around the plane on coarse elevation (Terrarium zoom 10, ~120 m), dressed in the
    // Sentinel-2 cloudless 2016 mosaic (zoom 12, ~30 m). One request at a time to each service, all kept; rebuilt
    // when the plane has gone a few km. Where the detailed ground is drawn, it sinks out of the way
    const DEM_Z = 10, HOLE_R = 300;
    const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/';
    const SAT_URL = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg';
    const far = { dem: new Map(), sat: new Map(), queue: [], busy: { dem: false, sat: false }, version: 0, shown: false };

    const tileXY = (lat, lon, z) => {
        const n = 2 ** z, r = lat * RAD;
        return { x: (lon + 180) / 360 * n, y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n };
    };

    function want(kind, z, tx, ty) {
        const store = far[kind], key = z + '/' + tx + '/' + ty;
        if (store.has(key)) return store.get(key);
        store.set(key, null);
        far.queue.push({ kind, z, tx, ty, key });
        pump();
        return null;
    }
    function pump() {
        for (const kind of ['dem', 'sat']) {
            if (far.busy[kind]) continue;
            const i = far.queue.findIndex(q => q.kind === kind);
            if (i < 0) continue;
            const q = far.queue.splice(i, 1)[0];
            far.busy[kind] = true;
            const url = kind === 'dem' ? `${DEM_URL}${q.z}/${q.tx}/${q.ty}.png` : SAT_URL.replace('{z}', q.z).replace('{x}', q.tx).replace('{y}', q.ty);
            fetch(url).then(r => r.ok ? r.blob() : Promise.reject(r.status)).then(createImageBitmap).then(img => {
                if (kind === 'dem') {
                    const c = new OffscreenCanvas(256, 256), g = c.getContext('2d');
                    g.drawImage(img, 0, 0);
                    const px = g.getImageData(0, 0, 256, 256).data, h = new Float32Array(256 * 256);
                    for (let k = 0; k < h.length; k++) h[k] = px[k * 4] * 256 + px[k * 4 + 1] + px[k * 4 + 2] / 256 - 32768;
                    far.dem.set(q.key, h);
                } else far.sat.set(q.key, img);
                far.version++;
            }).catch(() => far[kind].delete(q.key)).finally(() => {
                // A short pause between requests: a free service
                setTimeout(() => { far.busy[kind] = false; pump(); }, 150);
            });
        }
    }

    far.heightAt = (lat, lon) => {
        const p = tileXY(lat, lon, DEM_Z), tx = Math.floor(p.x), ty = Math.floor(p.y);
        const h = far.dem.get(DEM_Z + '/' + tx + '/' + ty);
        if (!h) { if (plane.on) want('dem', DEM_Z, tx, ty); return NaN; }
        const fx = Math.min(255, Math.max(0, (p.x - tx) * 256 - 0.5)), fy = Math.min(255, Math.max(0, (p.y - ty) * 256 - 0.5));
        const i = Math.min(254, Math.floor(fx)), j = Math.min(254, Math.floor(fy)), a = fx - i, bb = fy - j, at = (x, y) => h[y * 256 + x];
        return (at(i, j) * (1 - a) + at(i + 1, j) * a) * (1 - bb) + (at(i, j + 1) * (1 - a) + at(i + 1, j + 1) * a) * bb;
    };

    // Two layers: the wide one at zoom 12, and a sharper one at zoom 13 (the imagery's own detail, ~14 m) nearer;
    // the wide one sinks under the near one so it never shows through it
    const LAYERS = [
        { z: 12, R: 9000, n: 90, ahead: 3500, move: 2500, offset: 6, order: -5 },
        { z: 13, R: 3600, n: 72, ahead: 1500, move: 1000, offset: 5, order: -4 },
    ].map(l => ({ ...l, mesh: null, mat: null, at: null, builtVersion: -1, builtAt: 0 }));
    const u = v => (v / METERS_PER_UNIT).toFixed(1);

    function layerMaterial(l) {
        const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: l.offset, polygonOffsetUnits: l.offset });
        mat.userData.hole = { value: new THREE.Vector3() };
        mat.userData.inner = { value: new THREE.Vector3() };
        mat.onBeforeCompile = sh => {
            sh.uniforms.uHole = mat.userData.hole;
            sh.uniforms.uInner = mat.userData.inner;
            sh.vertexShader = 'uniform vec3 uHole, uInner;\n' + sh.vertexShader.replace('#include <begin_vertex>',
                `#include <begin_vertex>
                float dh = distance(transformed.xz, uHole.xy);
                transformed.y -= uHole.z * (1.0 - smoothstep(${u(HOLE_R * 0.8)}, ${u(HOLE_R)}, dh));
                float di = distance(transformed.xz, uInner.xy);
                transformed.y -= uInner.z > 0.0 ? ${u(40)} * (1.0 - smoothstep(uInner.z * 0.9, uInner.z, di)) : 0.0;`);
        };
        return mat;
    }

    // A layer's mesh and picture, laid out round (x, y)
    function buildLayer(l, x, y) {
        const ll = OsmMatch.unproject(x, y), Z = l.z;
        // Satellite tiles over the square
        const c0 = tileXY(ll.lat, ll.lon, Z), mPerTile = 40075016 * Math.cos(ll.lat * RAD) / 2 ** Z;
        const rt = Math.ceil(l.R / mPerTile + 0.5), tx0 = Math.floor(c0.x) - rt, ty0 = Math.floor(c0.y) - rt, nt = 2 * rt + 1;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = Math.min(2048, nt * 256);
        const g = canvas.getContext('2d'), px = canvas.width / nt;
        g.fillStyle = '#6f7d5c';
        g.fillRect(0, 0, canvas.width, canvas.height);
        let missing = 0;
        for (let i = 0; i < nt; i++) for (let j = 0; j < nt; j++) {
            const img = want('sat', Z, tx0 + i, ty0 + j);
            if (img) g.drawImage(img, i * px, j * px, px, px); else missing++;
        }
        const tex = new THREE.CanvasTexture(canvas);
        tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
        // Grid in map metres, its heights from the coarse elevation, its picture from where each point is on the tiles
        const n = l.n, step = 2 * l.R / n, pos = new Float32Array((n + 1) * (n + 1) * 3), uv = new Float32Array((n + 1) * (n + 1) * 2);
        const gx = Math.round(x / step) * step - l.R, gy = Math.round(y / step) * step - l.R;
        let k = 0;
        for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++, k++) {
            const mx = gx + i * step, my = gy + j * step, q = OsmMatch.unproject(mx, my);
            let h = far.heightAt(q.lat, q.lon);
            if (!Number.isFinite(h)) h = Terrain.h0 - 50;
            const v = V(mx, my, h - 1.5);
            pos[k * 3] = v.x; pos[k * 3 + 1] = v.y; pos[k * 3 + 2] = v.z;
            const t = tileXY(q.lat, q.lon, Z);
            uv[k * 2] = (t.x - tx0) / nt;
            uv[k * 2 + 1] = 1 - (t.y - ty0) / nt;
        }
        const idx = [];
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
            const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
            // Map x runs the other way in the view: wound so the faces look up
            idx.push(a, b, c, b, d, c);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        geo.setIndex(idx);
        if (!l.mat) l.mat = layerMaterial(l);
        if (l.mesh) {
            map.inner.remove(l.mesh);
            l.mesh.geometry.dispose();
            if (l.mat.map) l.mat.map.dispose();
        }
        l.mat.map = tex;
        l.mat.needsUpdate = true;
        l.mesh = new THREE.Mesh(geo, l.mat);
        l.mesh.frustumCulled = false;
        l.mesh.renderOrder = l.order;
        l.mesh.visible = far.shown;
        map.inner.add(l.mesh);
        l.at = { x, y };
        l.builtVersion = far.version;
        l.complete = !missing;
    }

    far.show = on => {
        far.shown = on;
        for (const l of LAYERS) if (l.mesh) l.mesh.visible = on;
    };
    far.clear = () => {
        for (const l of LAYERS) {
            if (l.mesh && map.inner) map.inner.remove(l.mesh);
            l.mesh = null;
            l.at = null;
        }
    };

    function updateFar(f, now) {
        if (!plane.on || !map.inner) return;
        const b = f.brg * RAD, c = map.scene && map.scene.path ? map.scene.path[0] : [f.x, f.y];
        for (const l of LAYERS) {
            // Laid out round a point ahead: most of what is seen is in front
            const ax = f.x + Math.sin(b) * l.ahead, ay = f.y + Math.cos(b) * l.ahead;
            const moved = !l.at || Math.hypot(ax - l.at.x, ay - l.at.y) > l.move;
            // New tiles in: drawn again, at most every 2 s, until it has them all
            if (moved || (!l.complete && far.version !== l.builtVersion && now - l.builtAt > 2000)) {
                l.builtAt = now;
                buildLayer(l, moved ? ax : l.at.x, moved ? ay : l.at.y);
            }
            if (!l.mat) continue;
            l.mat.color.setScalar(isDarkTheme ? 0.3 : 1);
            // The detailed ground is laid out around the scene's centre: sink these there while it shows
            l.mat.userData.hole.value.set(-c[0] / METERS_PER_UNIT, c[1] / METERS_PER_UNIT, Air.agl > 120 ? 0 : 60 / METERS_PER_UNIT);
        }
        // The wide layer under the near one
        const near = LAYERS[1], wide = LAYERS[0];
        if (wide.mat && near.at) wide.mat.userData.inner.value.set(-near.at.x / METERS_PER_UNIT, near.at.y / METERS_PER_UNIT, near.R * 0.98 / METERS_PER_UNIT);
    }

    // ================= Names of towns and peaks, seen from the plane =================
    // The nearest and biggest: cities from 25 km, towns 14, villages 6, hamlets 2 when low; peaks from 12 km with
    // their height. Always the same size on screen, hidden behind the hills
    const LABEL_R = { city: 25000, town: 14000, village: 6000, hamlet: 2000, peak: 12000 };
    const LABEL_W = { city: 0, town: 1, peak: 1.5, village: 2, hamlet: 3 };
    const labels = new Map();
    let labelsAt = 0;

    function labelSprite(p) {
        const c = document.createElement('canvas'), g = c.getContext('2d'), peak = p.cls === 'peak';
        const big = p.cls === 'city' || p.cls === 'town', font = `${big ? 700 : 600} ${big ? 34 : 28}px system-ui,sans-serif`;
        const text = peak && p.ele ? `${p.name}  ${Math.round(p.ele)} m` : p.name;
        g.font = font;
        const w = Math.min(520, g.measureText(text).width), pad = peak ? 46 : 22;
        c.width = Math.ceil(w + pad + 18);
        c.height = 52;
        g.fillStyle = 'rgba(14,18,24,.72)';
        g.beginPath();
        g.roundRect ? g.roundRect(0, 0, c.width, c.height, 26) : g.rect(0, 0, c.width, c.height);
        g.fill();
        if (peak) {
            g.fillStyle = '#c9a26b';
            g.beginPath();
            g.moveTo(16, 36); g.lineTo(28, 14); g.lineTo(40, 36);
            g.closePath();
            g.fill();
        }
        g.fillStyle = '#fff';
        g.font = font;
        g.textBaseline = 'middle';
        g.fillText(text, pad, 27, w);
        const tex = new THREE.CanvasTexture(c);
        tex.minFilter = THREE.LinearFilter;
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, sizeAttenuation: false }));
        sp.center.set(0.5, 0);
        sp.userData.aspect = c.width / c.height;
        sp.renderOrder = 40;
        return sp;
    }

    function dropLabel(p) {
        const sp = labels.get(p);
        map.inner.remove(sp);
        sp.material.map.dispose();
        sp.material.dispose();
        labels.delete(p);
    }

    function heightOf(x, y) {
        const ll = OsmMatch.unproject(x, y);
        return Terrain.has(ll.lat, ll.lon) ? Terrain.dem(x, y) : far.heightAt(ll.lat, ll.lon);
    }

    function updateLabels(f, now) {
        if (!plane.on) { for (const p of [...labels.keys()]) dropLabel(p); return; }
        if (now - labelsAt < 700) return;
        labelsAt = now;
        const agl = Air.agl || 0, cands = [];
        for (const p of places.values()) {
            const r = LABEL_R[p.cls];
            if (!r || (p.cls === 'hamlet' && agl > 400)) continue;
            const d = Math.hypot(p.x - f.x, p.y - f.y);
            if (d < r && d > 150) cands.push({ p, score: LABEL_W[p.cls] * 5000 + d });
        }
        cands.sort((a, b) => a.score - b.score);
        const keep = new Map(cands.slice(0, 16).map(c => [c.p, c.score]));
        for (const p of [...labels.keys()]) if (!keep.has(p)) dropLabel(p);
        // A label's height on screen: about 22 px whatever the distance
        const k = 22 / innerHeight * 2 * Math.tan(camera.fov * RAD / 2);
        for (const [p, score] of keep) {
            let sp = labels.get(p);
            if (!sp) {
                const ground = heightOf(p.x, p.y);
                if (!Number.isFinite(ground)) continue;
                sp = labelSprite(p);
                sp.position.copy(V(p.x, p.y, (p.cls === 'peak' && p.ele ? Math.max(p.ele, ground) : ground) + (p.cls === 'peak' ? 25 : 60)));
                map.inner.add(sp);
                labels.set(p, sp);
            }
            sp.scale.set(k * sp.userData.aspect, k, 1);
            sp.userData.score = score;
        }
    }

    // Each frame: names that would cover a more important one on screen are hidden
    const lp = new THREE.Vector3();
    function declutter() {
        if (!labels.size) return;
        map.inner.updateMatrixWorld();
        const W = innerWidth, H = innerHeight, taken = [];
        for (const sp of [...labels.values()].sort((a, b) => a.userData.score - b.userData.score)) {
            sp.getWorldPosition(lp).project(camera);
            const h = sp.scale.y / (2 * Math.tan(camera.fov * RAD / 2)) * H, w = h * sp.userData.aspect;
            const x = (lp.x + 1) / 2 * W - w / 2, y = (1 - lp.y) / 2 * H - h;
            const box = [x, y, w, h];
            sp.visible = lp.z < 1 && !taken.some(r => x < r[0] + r[2] && x + w > r[0] && y < r[1] + r[3] && y + h > r[1]);
            if (sp.visible) taken.push(box);
        }
    }

    // ================= Where to fly: a place, or a runway (snapped to it within 3 km), in a straight line =================
    let nav = null;
    Air.setNav = (x, y, name) => {
        const rw = Air.runwayNear(x, y, 3000);
        nav = rw ? { x: rw.mid.x, y: rw.mid.y, name: rw.name || name, runway: true } : { x, y, name, runway: false };
        return nav;
    };
    Air.clearNav = () => { nav = null; };
    // Distance and how far to turn (deg, + right) from the plane, null without a destination
    Air.nav = () => {
        const f = osmSim.free;
        if (!nav || !plane.on) return null;
        return { ...nav, d: Math.hypot(nav.x - f.x, nav.y - f.y), turn: OsmMatch.turnOf(f.brg, OsmMatch.bearing(f.x, f.y, nav.x, nav.y)) };
    };
    function updateNav(f) {
        // Down on the ground near it: arrived
        if (nav && plane.ground && Math.abs(f.v) < 15 && Math.hypot(nav.x - f.x, nav.y - f.y) < 2500) {
            if (Air.onMessage) Air.onMessage('arrived', nav.name);
            nav = null;
        }
    }

    // ================= Every frame =================
    let last = 0;
    function tick(now) {
        requestAnimationFrame(tick);
        const dt = Math.min(0.1, (now - (last || now)) / 1000);
        last = now;
        const f = window.osmSim && osmSim.free;
        if (!window.OsmOnline || !f || !f.on || !map.inner || !window.Terrain) {
            if (plane.on && f && !f.on) leaveView();
            return;
        }
        if (!mats) materials();
        if (dark !== isDarkTheme) { dark = isDarkTheme; paint(); }
        for (const k of OsmOnline.areas.keys()) if (!indexed.has(k)) index(k);
        // The airports near: drawn per tile around the plane or the car, the model loaded once one is near
        const ll = OsmMatch.unproject(f.x, f.y), [tx, ty] = OsmOnline.tileOf(ll.lat, ll.lon), wanted = new Set();
        const r = plane.on ? 2 : 1;
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) wanted.add(`${tx + dx}/${ty + dy}`);
        for (const k of [...built.keys()]) if (!wanted.has(k)) drop(k);
        for (const k of wanted) {
            const a = OsmOnline.areas.get(k);
            if (built.has(k) || !a || !a.aero || !(a.aero.lines.length || a.aero.polys.length)) continue;
            if (!proto) { loadModel(); continue; }
            if (!Terrain.tileReady(k)) continue;
            build(k);
            break;
        }
        updateRunways(f);
        updateLabels(f, now);
        declutter();
        updateNav(f);
        if (!proto && now > 20000) loadModel();
        updateFlyover(f, now, dt);
        updateFar(f, now);
    }

    Air.reset = () => {
        for (const k of [...built.keys()]) drop(k);
        indexed.clear();
        for (const r of runways) if (r.built) dropRunway(r);
        runways.length = 0;
        for (const p of [...labels.keys()]) dropLabel(p);
        places.clear();
        if (flyover) { if (map.inner) map.inner.remove(flyover.p.wrap); flyover = null; }
        far.clear();
    };

    // Cars and planes roll on the paving like on a road
    window.addEventListener('load', () => {
        const baseSurface = Terrain.surface, baseOnRoad = Terrain.onRoad;
        Terrain.surface = (x, y) => {
            const s = baseSurface(x, y), p = Air.pavedAt(x, y);
            return p != null ? Math.max(s, p) : s;
        };
        Terrain.onRoad = (x, y) => baseOnRoad(x, y) || Air.pavedAt(x, y) != null;
        // The ground round a runway is laid level with it
        Terrain.flatAt = Air.flatAt;
        // Where the detailed elevation is not in yet, the coarse one: never the plane's own height
        Terrain.coarse = (lat, lon) => plane.on ? far.heightAt(lat, lon) : NaN;
    });

    Air.hud = () => {};
    window.Air = Air;
    requestAnimationFrame(tick);
})();
