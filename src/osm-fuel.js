// Fuel: the tank and what driving uses, fuel stations set beside their road at its level, filling up when stopped on
// a forecourt, and help when the tank runs dry. Stations come from the vector tiles' fuel points
(() => {
    const KEY = 'osm-drive-fuel';
    const TANK = 45;                 // litres, only for the messages
    const SNAP = 40;                 // m: a station nearer its road than this stands right beside it
    const PAD_W = 16, PAD_D = 20;    // m: forecourt across and along the road
    const SKIRT = 2.5;               // m more all round, under the asphalt on the road's side: no gap for a wheel
    const FILL_S = 3.5;              // s from empty to full
    // Driving normally (light throttle, low revs) a tank lasts about 40 km: a game range, not a car's
    const RATE = 1300;
    // The plane: about 45 minutes cruising, some 150 km; filled at an airport in a few seconds more than a car
    const PLANE_RATE = 2400, PLANE_TANK = 200, PLANE_FILL_S = 6;
    const RAD = Math.PI / 180;

    // A tank for each: the car's `level`, the plane's `plane`
    const state = { on: true, level: 1, plane: 1 };
    try { Object.assign(state, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (err) { /* storage blocked */ }
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (err) { /* storage blocked */ } };
    const flying = () => window.osmSim && osmSim.free.kind === 'plane';
    const slot = () => flying() ? 'plane' : 'level';

    // ---- Stations ----
    const placed = new Map();   // lat,lon -> station, once its road and elevation have come in

    function nearestEdge(x, y, r) {
        let best = null;
        for (const e of OsmMatch.edgesNear(x, y, r)) {
            const dx = e.bx - e.ax, dy = e.by - e.ay, l2 = dx * dx + dy * dy || 1e-9;
            const t = Math.max(0, Math.min(1, ((x - e.ax) * dx + (y - e.ay) * dy) / l2));
            const px = e.ax + dx * t, py = e.ay + dy * t, d = Math.hypot(x - px, y - py);
            if (!best || d < best.d) best = { e, x: px, y: py, d };
        }
        return best;
    }

    // { x, y, fx, fy (along the road), h (forecourt level), lat, lon, name }. Near its road the forecourt touches the
    // asphalt's edge, level with it: drive in without a step, and no guardrail in front
    function place(s) {
        const key = s.lat.toFixed(5) + ',' + s.lon.toFixed(5), done = placed.get(key);
        if (done) return done;
        const p = OsmMatch.project(s.lat, s.lon), r = nearestEdge(p.x, p.y, 60);
        let st;
        if (r && r.d < SNAP) {
            const e = r.e, fx = (e.bx - e.ax) / e.len, fy = (e.by - e.ay) / e.len;
            // Right of the road's direction is (fy, -fx): the forecourt goes on the station's side
            const side = (p.x - r.x) * fy - (p.y - r.y) * fx >= 0 ? 1 : -1;
            const l = OsmMatch.laneInfo(e), W = (l.fwd + l.back) * l.laneW / 2 + 0.4, off = (W + PAD_W / 2) * side;
            st = { x: r.x + fy * off, y: r.y - fx * off, fx, fy, h: Terrain.ground(r.x, r.y) - 0.02, beside: true };
        } else {
            // Far from any road: where it is mapped, on a slab as high as the highest ground under it
            const b = (r ? r.e.brg : 0) * RAD, fx = Math.sin(b), fy = Math.cos(b);
            const corners = [[-8, -10], [8, -10], [-8, 10], [8, 10], [0, 0]].map(([a, d]) => Terrain.dem(p.x + fy * a + fx * d, p.y - fx * a + fy * d));
            st = { x: p.x, y: p.y, fx, fy, h: Math.max(Terrain.ground(p.x, p.y), ...corners) + 0.15, beside: false };
        }
        Object.assign(st, { key, lat: s.lat, lon: s.lon, name: s.name });
        // Final once its road and the elevation are in: drawn, and the scene's ground and guardrails make way for it
        if (r && Terrain.has(s.lat, s.lon)) {
            placed.set(key, st);
            Fuel.version++;
        }
        return st;
    }

    // ---- Drawing: canopy with a red fascia on pillars, two pump islands, on a forecourt slab deep enough to hide
    // any slope; one mesh per station, only near the car ----
    const meshes = new Map();   // station -> mesh
    let mat = null;
    function draw(st) {
        const u = 1 / METERS_PER_UNIT, y0 = roadMesh.position.y, pos = [], col = [];
        const { x, y, fx, fy } = st, rx = fy, ry = -fx;
        const box = (across, along, w, d, z0, h, hex) => {
            const c = new THREE.Color(hex);
            const P = (sa, sd, z) => [-(x + rx * (across + sa * w / 2) + fx * (along + sd * d / 2)) * u, y0 + z * u, (y + ry * (across + sa * w / 2) + fy * (along + sd * d / 2)) * u];
            const quad = (a, b, cc, dd, k) => { pos.push(...a, ...b, ...cc, ...a, ...cc, ...dd); for (let i = 0; i < 6; i++) col.push(c.r * k, c.g * k, c.b * k); };
            quad(P(-1, -1, z0 + h), P(1, -1, z0 + h), P(1, 1, z0 + h), P(-1, 1, z0 + h), 1);
            quad(P(-1, -1, z0), P(1, -1, z0), P(1, -1, z0 + h), P(-1, -1, z0 + h), 0.8);
            quad(P(1, 1, z0), P(-1, 1, z0), P(-1, 1, z0 + h), P(1, 1, z0 + h), 0.8);
            quad(P(-1, 1, z0), P(-1, -1, z0), P(-1, -1, z0 + h), P(-1, 1, z0 + h), 0.65);
            quad(P(1, -1, z0), P(1, 1, z0), P(1, 1, z0 + h), P(1, -1, z0 + h), 0.65);
        };
        const h = st.h;
        // A flat forecourt slab, 3 m deep to hide any slope, reaching under the asphalt on the road's side
        box(0, 0, PAD_W + 2 * SKIRT, PAD_D + 2 * SKIRT, h - 3, 3, 0xbfc3c8);
        box(0, 0, 9, 14, h + 4.6, 0.7, 0xf2f2f2);
        for (const side of [-1, 1]) box(side * 4.55, 0, 0.12, 14.2, h + 4.4, 0.9, 0xd32f2f);
        for (const [a, d] of [[-3.5, -5.5], [3.5, -5.5], [-3.5, 5.5], [3.5, 5.5]]) box(a, d, 0.35, 0.35, h, 4.6, 0xd0d4da);
        for (const a of [-2, 2]) {
            box(a, 0, 1.4, 6, h, 0.2, 0xb8bcc2);
            for (const d of [-1.5, 1.5]) box(a, d, 0.6, 0.9, h + 0.2, 1.8, 0xe8e8e8);
        }
        if (!mat) mat = new THREE.MeshBasicMaterial({ vertexColors: true });
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        return new THREE.Mesh(g, mat);
    }
    function drawNear(f) {
        for (const [st, m] of meshes) {
            if (Math.hypot(st.x - f.x, st.y - f.y) < 1600) continue;
            map.inner.remove(m);
            m.geometry.dispose();
            meshes.delete(st);
        }
        for (const st of placed.values()) {
            if (meshes.has(st) || Math.hypot(st.x - f.x, st.y - f.y) > 1200) continue;
            const m = draw(st);
            map.inner.add(m);
            meshes.set(st, m);
        }
    }

    // Stations loaded within r of (x, y), nearest first, with their distance
    function near(x, y, r) {
        const out = [];
        for (const area of OsmOnline.areas.values()) {
            for (const s of area.fuel) {
                const st = place(s), d = Math.hypot(st.x - x, st.y - y);
                if (d < r) out.push({ st, d });
            }
        }
        return out.sort((a, b) => a.d - b.d);
    }

    // The forecourt (x, y) is on, with `margin` metres around it; null elsewhere
    function padAt(x, y, margin = 0) {
        for (const st of placed.values()) {
            const dx = x - st.x, dy = y - st.y;
            if (Math.abs(dx) > 30 || Math.abs(dy) > 30) continue;
            const along = dx * st.fx + dy * st.fy, across = dx * st.fy - dy * st.fx;
            if (Math.abs(across) <= PAD_W / 2 + margin && Math.abs(along) <= PAD_D / 2 + margin) return st;
        }
        return null;
    }
    // Height of the forecourt under (x, y), its skirt included; null off it
    function heightAt(x, y) {
        const st = padAt(x, y, SKIRT);
        return st ? st.h : null;
    }

    // ---- Tank ----
    let last = 0, still = 0, filling = null, hintAt = 0, reserve = false, empty = false, saveAt = 0, placedAt = 0;
    const say = (key, ...args) => Fuel.onMessage && Fuel.onMessage(key, ...args);

    function tick(now) {
        requestAnimationFrame(tick);
        const dt = Math.min(0.1, (now - (last || now)) / 1000), f = window.osmSim && osmSim.free;
        last = now;
        if (!f || !f.on) return;
        // Stations set in place as their tiles come in, before the scene's ground and guardrails are laid around them
        if (now - placedAt > 1000 && map.inner) { placedAt = now; near(f.x, f.y, 3000); drawNear(f); }
        if (f.paused || !state.on) { filling = null; return; }
        const plane = f.kind === 'plane', k = slot();
        // What the engine burns: a little at idle, more with the throttle and the revs; nothing when it has stopped
        if (state[k] > 0) {
            const burn = plane ? (0.3 + 0.7 * f.thr) / PLANE_RATE : (0.25 + 1.5 * (now < f.shiftUntil ? 0.1 : f.thr) * f.rpm / 3000) / RATE;
            state[k] = Math.max(0, state[k] - burn * dt);
        }
        // Where to fill up: a station's forecourt, or for a plane an airport's paving, on its wheels
        const pad = plane ? !f.air && window.Air && Air.pavedAt(f.x, f.y) != null : padAt(f.x, f.y, 1), stopped = Math.abs(f.v) < 0.3;
        still = pad && stopped ? still + dt : 0;
        if (pad && still > 1 && (state[k] < 0.98 || filling)) {
            if (!filling) {
                filling = { from: state[k], k };
                if (window.Engine && Engine.pump) Engine.pump();
            }
            state[k] = Math.min(1, state[k] + dt / (plane ? PLANE_FILL_S : FILL_S));
            if (state[k] >= 1) done();
        } else if (filling) {
            done();
        }
        // Rolling onto a forecourt: how to fill up
        if (pad && !filling && !stopped && Math.abs(f.v) < 7 && state[k] < 0.9 && now - hintAt > 10000) {
            hintAt = now;
            say(plane ? 'stopToRefuelPlane' : 'stopUnder');
        }
        if (state[k] < 0.15 && !reserve) { reserve = true; Fuel.onReserve && Fuel.onReserve(); }
        if (state[k] > 0.2) reserve = false;
        if (state[k] <= 0 && !empty) { empty = true; say(plane ? 'fuelEmptyPlane' : 'fuelEmpty'); }
        if (state[k] > 0) empty = false;
        if (now - saveAt > 2000) { saveAt = now; save(); }
    }

    function done() {
        const litres = Math.round((state[filling.k] - filling.from) * (filling.k === 'plane' ? PLANE_TANK : TANK));
        filling = null;
        if (litres > 0) say('refueled', litres);
        if (window.Engine && Engine.ding) Engine.ding();
        save();
    }

    window.Fuel = {
        PAD_W, PAD_D, version: 0,
        get on() { return state.on; },
        set on(v) { state.on = !!v; save(); },
        // The tank of what is being driven or flown
        get level() { return state[slot()]; },
        get filling() { return !!filling; },
        // Out of fuel: no throttle, no engine sound
        get empty() { return state.on && state[slot()] <= 0; },
        fill() { state.level = 1; state.plane = 1; save(); },
        place, near, padAt, heightAt, SKIRT,
        // Help on the way: to the nearest station loaded, tank full; with none, a can with a quarter of a tank. A
        // plane is brought to the nearest runway, refuelled
        rescue() {
            const f = osmSim.free;
            if (f.kind === 'plane') {
                const rw = window.Air && Air.runwayNear(f.x, f.y, 60000);
                state.plane = rw ? 1 : Math.max(state.plane, 0.25);
                save();
                if (rw) Air.placeOn(f, rw);
                return rw ? { name: rw.name } : null;
            }
            const n = near(f.x, f.y, 20000)[0];
            if (!n) { state.level = Math.max(state.level, 0.25); save(); return null; }
            const st = n.st;
            Object.assign(f, { x: st.x, y: st.y, brg: OsmMatch.bearing(0, 0, st.fx, st.fy), v: 0, vz: 0, steer: 0, z: -1e9, offSince: 0 });
            OsmMatch.state.e = null;
            state.level = 1;
            save();
            return st;
        },
        // Projected coordinates change with a new origin
        reset() {
            placed.clear();
            for (const m of meshes.values()) { map.inner.remove(m); m.geometry.dispose(); }
            meshes.clear();
        },
        onMessage: null,
        onReserve: null,
    };
    requestAnimationFrame(tick);
})();
