// Simulator drives on the OSM tiles: public traces, head-unit recordings or synthetic routes, through OsmMatch into the viewer
(() => {
    const SGLM = { lat: 41.2709, lon: 14.9201, name: 'San Giorgio La Molara' };
    const PLACES = [
        { lat: 41.1302, lon: 14.7787, name: 'Benevento' },
        { lat: 41.2962, lon: 14.9105, name: 'Molinara' },
        { lat: 41.2307, lon: 14.8143, name: 'Pesco Sannita' },
        { lat: 41.3237, lon: 15.0063, name: 'San Marco dei Cavoti' },
    ];
    const RAD = Math.PI / 180;
    const run = { on: false, fixes: [], navs: [], maneuvers: null, i: 0, t: 0, last: 0, speedup: 1, ok: 0, n: 0, trail: [], res: null, ah: null, truth: null };
    // Replays, matcher map and directions are for testing the matcher: shown with ?debug
    const DEBUG = new URLSearchParams(location.search).has('debug');
    let canvas = null, info = document.createElement('div');

    function gauss() {
        return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
    }

    function mapsRounding(m) {
        if (m >= 1000) return Math.round(m / 100) * 100;
        if (m >= 300) return Math.round(m / 50) * 50;
        if (m >= 100) return Math.round(m / 10) * 10;
        return Math.max(0, Math.round(m / 10) * 10);
    }

    const fmtDist = m => m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(m / 10) * 10 + ' m';

    // GPX traces only have positions: speed and bearing as the GPS chip would give them
    function deriveMotion(fixes) {
        for (let i = 0; i < fixes.length; i++) {
            const f = fixes[i];
            if (f.speed != null) continue;
            const a = fixes[Math.max(0, i - 1)], b = fixes[Math.min(fixes.length - 1, i + 1)];
            const pa = OsmMatch.project(a.lat, a.lon), pb = OsmMatch.project(b.lat, b.lon);
            const d = Math.hypot(pb.x - pa.x, pb.y - pa.y), dt = (b.t - a.t) / 1000;
            f.speed = dt > 0 ? d / dt : 0;
            f.bearing = d > 3 ? OsmMatch.bearing(pa.x, pa.y, pb.x, pb.y) : null;
        }
    }

    // Everything a drive needs before it starts: road tiles, elevation tiles and the 3D model, behind one progress bar
    async function prepare(points, osmRadius, demRadius) {
        const jobs = new Set();
        for (const p of points) for (const j of OsmMatch.jobs(p.lat, p.lon, osmRadius)) jobs.add(j);
        const list = [...jobs];
        if (window.Terrain) list.push(...Terrain.jobs(points, demRadius));
        list.push(new Promise(res => {
            const wait = () => typeof loadState === 'undefined' || loadState === 'ready' || loadState === 'error' ? res() : setTimeout(wait, 100);
            wait();
        }));

        const box = document.createElement('div');
        box.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:1000;background:rgba(0,0,0,.8);color:#fff;'
            + 'padding:14px 18px;border-radius:12px;font:14px sans-serif;width:300px';
        box.innerHTML = `<div class="t">${I18n.t('preparing')}</div>`
            + '<div style="height:6px;margin-top:10px;background:rgba(255,255,255,.2);border-radius:3px">'
            + '<div class="b" style="height:100%;width:0;background:#3e8bff;border-radius:3px"></div></div>';
        document.body.appendChild(box);
        const buttons = document.querySelectorAll('[data-sim-start]');
        buttons.forEach(b => { b.disabled = true; });
        if (window.Terrain) Terrain.quiet = true;
        let done = 0;
        const show = () => {
            box.querySelector('.t').textContent = I18n.t('preparingN', done, list.length);
            box.querySelector('.b').style.width = 100 * done / list.length + '%';
        };
        show();
        await Promise.all(list.map(j => Promise.resolve(j).catch(() => {}).then(() => { done++; show(); })));
        if (window.Terrain) Terrain.quiet = false;
        buttons.forEach(b => { b.disabled = false; });
        box.remove();
    }

    // ---- Synthetic drive along a computed route, with correlated GPS noise ----
    async function synthetic(from, to) {
        info.textContent = 'Carico le strade…';
        const jobs = [];
        for (let lat = Math.min(from.lat, to.lat) - 0.04; lat <= Math.max(from.lat, to.lat) + 0.04; lat += 0.02) {
            for (let lon = Math.min(from.lon, to.lon) - 0.04; lon <= Math.max(from.lon, to.lon) + 0.04; lon += 0.02) {
                jobs.push(OsmMatch.ensure(lat, lon, 0));
            }
        }
        await Promise.all(jobs);
        info.textContent = 'Calcolo il percorso…';
        const path = OsmMatch.route(OsmMatch.project(from.lat, from.lon), OsmMatch.project(to.lat, to.lon));
        if (!path) { info.textContent = 'Percorso non trovato'; return null; }

        const pts = [];
        let s = 0;
        path.forEach((st, k) => {
            const e = st.e;
            if (k === 0) pts.push({ x: st.fwd ? e.ax : e.bx, y: st.fwd ? e.ay : e.by, s: 0, k });
            st.s0 = s;
            s += e.len;
            pts.push({ x: st.fwd ? e.bx : e.ax, y: st.fwd ? e.by : e.ay, s, k });
        });
        const at = d => {
            let lo = 0, hi = pts.length - 2;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (pts[mid].s <= d) lo = mid; else hi = mid - 1;
            }
            const a = pts[lo], b = pts[lo + 1];
            const f = b.s > a.s ? Math.min(1, Math.max(0, (d - a.s) / (b.s - a.s))) : 0;
            return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, brg: OsmMatch.bearing(a.x, a.y, b.x, b.y), k: b.k };
        };

        // Speed: the road's usual speed, slower in bends (2 m/s² sideways), 1.5 m/s² up and 2.5 m/s² down
        const N = Math.floor(s);
        const v = new Float32Array(N + 1);
        for (let d = 0; d <= N; d++) {
            const p = at(d);
            const st = path[p.k];
            const lim = OsmMatch.roadSpeed(st.e) / 3.6;
            const dth = Math.abs(OsmMatch.turnOf(at(Math.max(0, d - 15)).brg, at(Math.min(N, d + 15)).brg)) * RAD;
            v[d] = Math.min(lim, dth > 0.01 ? Math.sqrt(2 * 30 / dth) : lim);
        }
        v[0] = 0;
        v[N] = 0;
        for (let d = 1; d <= N; d++) v[d] = Math.min(v[d], Math.sqrt(v[d - 1] ** 2 + 2 * 1.5));
        for (let d = N - 1; d >= 0; d--) v[d] = Math.min(v[d], Math.sqrt(v[d + 1] ** 2 + 2 * 2.5));

        const fixes = [];
        let t = 0, next = 0, nx = 0, ny = 0;
        for (let d = 0; d < N; d++) {
            const dt = 1 / Math.max(1, (v[d] + v[d + 1]) / 2);
            while (t + dt >= next) {
                const p = at(d + (next - t) / dt);
                nx = 0.9 * nx + 1.5 * gauss();
                ny = 0.9 * ny + 1.5 * gauss();
                const speed = v[d];
                const ll = OsmMatch.unproject(p.x + nx, p.y + ny);
                fixes.push({
                    t: Math.round(next * 1000), lat: ll.lat, lon: ll.lon, speed: Math.max(0, speed + 0.2 * gauss()),
                    bearing: speed > 1 ? (p.brg + 3 * gauss() + 360) % 360 : null, acc: 5,
                    truth: path[p.k].e, truthXY: p, s: d
                });
                next += 1;
            }
            t += dt;
        }

        // Navigation maneuvers where the route turns at a junction
        const maneuvers = [];
        for (let k = 1; k < path.length; k++) {
            const a = path[k - 1], b = path[k];
            const id = a.fwd ? a.e.b : a.e.a;
            if ((OsmMatch.nodes.get(id) || { edges: [] }).edges.length < 3) continue;
            const turn = OsmMatch.turnOf(a.fwd ? a.e.brg : a.e.brg + 180, b.fwd ? b.e.brg : b.e.brg + 180);
            if (Math.abs(turn) < 25) continue;
            const name = b.e.tags.name || b.e.tags.ref;
            maneuvers.push({
                s: b.s0, dir: turn < 0 ? 1 : -1, angle: Math.round(Math.abs(turn)),
                text: `Svolta a ${turn < 0 ? 'sinistra' : 'destra'}${name ? ' in ' + name : ''}`
            });
        }
        maneuvers.push({ s: N, dir: 0, angle: 0, text: 'Arrivo a ' + to.name });
        info.textContent = `Percorso ${(N / 1000).toFixed(1)} km, ${Math.round(fixes.length / 60)} min, ${maneuvers.length - 1} manovre`;
        return { fixes, maneuvers };
    }

    // ---- Head-unit recordings (GpsTrackLog CSV) ----
    function parseCsv(text) {
        const fixes = [], navs = [];
        for (const line of text.split('\n')) {
            const f = line.split(',');
            if (f[0] === 'FIX') {
                const num = i => f[i] === '' || f[i] == null ? null : +f[i];
                fixes.push({ t: +f[1], lat: +f[2], lon: +f[3], acc: num(5), speed: num(6), bearing: num(7) });
            } else if (f[0] === 'NAV') {
                navs.push({ t: +f[1], dir: f[2] === '' ? 0 : +f[2], angle: +f[3] || 0, meters: f[4] === '' ? null : +f[4], text: (line.match(/"([^"]*)"\s*$/) || [])[1] || '' });
            }
        }
        return { fixes, navs };
    }

    // ---- Replay ----
    async function start(drive) {
        if (!drive || !drive.fixes.length) return;
        run.on = false;
        free.on = false;
        if (window.Terrain) Terrain.car = null;
        deriveMotion(drive.fixes);
        await prepare(drive.fixes, 1, 1);
        Object.assign(run, {
            on: true, fixes: drive.fixes, navs: drive.navs || [], maneuvers: drive.maneuvers || null,
            i: 0, t: drive.fixes[0].t, last: performance.now(), ok: 0, n: 0, trail: []
        });
        OsmMatch.state.e = null;
        snapToDrive();
        frame();
    }

    // A drive starts in the driver's view with the world already drawn, not with the launcher's fade and camera swing
    function snapToDrive() {
        isThirdPersonView = true;
        targetCameraAngle = drivePose.az;
        roadTargetOpacity = roadCurrentOpacity = 0.8;
        camDist = drivePose.d;
        camera.position.set(FOCUS.x + Math.sin(drivePose.az) * drivePose.d, drivePose.h, FOCUS.z + Math.cos(drivePose.az) * drivePose.d);
        camera.lookAt(FOCUS);
    }

    function navAt(f) {
        if (run.maneuvers) {
            const m = run.maneuvers.find(m => m.s > f.s - 3);
            return m && { dir: m.dir, angle: m.angle, meters: Math.max(0, m.s - f.s), text: m.text };
        }
        let nav = null;
        for (const n of run.navs) if (n.t <= f.t) nav = n;
        // The notification's distance counts down between updates
        return nav && nav.meters != null ? { ...nav, meters: Math.max(0, nav.meters - (f.speed || 0) * (f.t - nav.t) / 1000) } : nav;
    }

    function onFix(f) {
        if (window.Terrain) Terrain.ensure(f.lat, f.lon);
        const nav = navAt(f);
        const man = document.getElementById('sim-maneuver');
        if (nav && DEBUG) {
            setUpcomingTurn({ dir: nav.dir, angle: nav.angle, meters: nav.meters == null ? undefined : mapsRounding(nav.meters) });
            if (man) man.innerHTML = `<div style="font-size:26px;font-weight:300">${nav.meters != null ? fmtDist(nav.meters) : ''}</div><div style="font-size:14px;opacity:.7">${nav.text || ''}</div>`;
        } else {
            setUpcomingTurn(null);
            if (man) man.innerHTML = '';
        }

        const res = OsmMatch.match(f);
        // Free driving shows the world, not what the launcher would: every road around, also off the matched one
        const sc = free.on ? freeScene(nav, res) : res.matched ? OsmMatch.scene(nav) : null;
        if (sc || !free.on) run.ah = sc && sc.ahead;
        else if (DEBUG) run.ah = res.matched ? OsmMatch.ahead(nav, 320) : null;
        run.res = res;
        run.truth = f.truthXY || null;
        run.trail.push(res.raw);
        if (run.trail.length > 40) run.trail.shift();
        if (f.truth) {
            run.n++;
            const m = res.matched;
            if (m && (m.e === f.truth || (m.e.way === f.truth.way && Math.abs(m.e.seq - f.truth.seq) <= 1))) run.ok++;
        }

        if (sc || !free.on) setMapScene(sc);
        else map.at = performance.now();
        draw();
    }

    // Free driving: the scene is drawn in map coordinates, so it holds while the car moves. It is laid out around a
    // point ahead of the car, and rebuilt once that point has moved on or new roads, heights or colours have come in
    const LEAD = 60, REBUILD = 50;
    const built = { x: NaN, y: NaN, edges: 0, dem: 0, dark: null };
    function freeScene(nav, res) {
        // Ahead in the gear's direction: a bounce off a wall doesn't swing the scene round
        const b = (free.gear === 'R' ? free.brg + 180 : free.brg) * RAD;
        const cx = free.x + Math.sin(b) * LEAD, cy = free.y + Math.cos(b) * LEAD;
        const dem = (window.Terrain ? Terrain.version : 0) + (window.Fuel ? Fuel.version * 1e6 : 0);
        if (Math.hypot(cx - built.x, cy - built.y) < REBUILD && OsmMatch.edges.length === built.edges && dem === built.dem && isDarkTheme === built.dark) return null;
        Object.assign(built, { x: cx, y: cy, edges: OsmMatch.edges.length, dem, dark: isDarkTheme });
        const sc = (res.matched && OsmMatch.scene(nav)) || { car: { offset: 0 }, features: [] };
        return { ...sc, path: [[cx, cy], [cx + Math.sin(b), cy + Math.cos(b)]], carIndex: 0, roads: nearbyRoads(cx, cy, 250) };
    }

    function frame() {
        if (!run.on) return;
        requestAnimationFrame(frame);
        const now = performance.now();
        run.t += (now - run.last) * run.speedup;
        run.last = now;
        while (run.i < run.fixes.length && run.fixes[run.i].t <= run.t) onFix(run.fixes[run.i++]);
        const f0 = run.fixes[Math.max(0, run.i - 1)], f1 = run.fixes[Math.min(run.fixes.length - 1, run.i)];
        const a = f1.t > f0.t ? Math.min(1, Math.max(0, (run.t - f0.t) / (f1.t - f0.t))) : 0;
        const kmh = Math.round(((f0.speed || 0) + ((f1.speed || 0) - (f0.speed || 0)) * a) * 3.6);
        updateSpeed(kmh, kmh);
        if (run.i >= run.fixes.length) {
            run.on = false;
            updateSpeed(0, 0);
        }
    }

    // ---- Debug map: north up, 1 px ≈ 1.6 m ----
    function draw() {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height, sc = 0.6;
        const m = run.res && run.res.matched;
        const c = m || (run.res && run.res.raw);
        ctx.fillStyle = 'rgba(10,10,14,0.85)';
        ctx.fillRect(0, 0, W, H);
        if (!c) return;
        const X = x => W / 2 + (x - c.x) * sc, Y = y => H / 2 - (y - c.y) * sc;
        const width = { motorway: 5, trunk: 4, primary: 3.5, secondary: 3, tertiary: 2.5 };
        for (const e of OsmMatch.edgesNear(c.x, c.y, 320)) {
            ctx.strokeStyle = e.urban ? '#6a6a8a' : '#777';
            ctx.lineWidth = width[e.tags.highway.replace('_link', '')] || 1.5;
            ctx.beginPath();
            ctx.moveTo(X(e.ax), Y(e.ay));
            ctx.lineTo(X(e.bx), Y(e.by));
            ctx.stroke();
        }
        const ah = run.ah;
        if (ah) {
            ctx.strokeStyle = '#29b6f6';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ah.pts.forEach((p, i) => i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y)));
            ctx.stroke();
        }
        ctx.fillStyle = '#ef5350';
        run.trail.forEach(p => ctx.fillRect(X(p.x) - 1.5, Y(p.y) - 1.5, 3, 3));
        if (run.truth) {
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(X(run.truth.x), Y(run.truth.y), 7, 0, 7);
            ctx.stroke();
        }
        if (m) {
            ctx.fillStyle = '#66bb6a';
            ctx.beginPath();
            ctx.arc(X(m.x), Y(m.y), 5, 0, 7);
            ctx.fill();
        }
        const lines = [];
        if (m) {
            const t = m.e.tags;
            lines.push(`${t.name || t.ref || '(senza nome)'} · ${t.highway}${m.e.urban ? ' · urbana' : ''} · costo ${m.cost.toFixed(1)}`);
        } else {
            lines.push('nessuna strada');
        }
        if (run.n) lines.push(`abbinamenti corretti ${(100 * run.ok / run.n).toFixed(1)}% (${run.n})`);
        ctx.font = '12px sans-serif';
        ctx.fillStyle = '#fff';
        lines.forEach((l, i) => ctx.fillText(l, 8, H - 8 - (lines.length - 1 - i) * 15));
    }

    // Whole drive through the matcher at once: matching rate and what the driver would have been told
    async function evaluate(drive) {
        deriveMotion(drive.fixes);
        await prepare(drive.fixes, 1, 1);
        OsmMatch.state.e = null;
        run.maneuvers = drive.maneuvers || null;
        run.navs = drive.navs || [];
        let ok = 0, n = 0, unmatched = 0, maxCost = 0;
        for (const f of drive.fixes) {
            const res = OsmMatch.match(f);
            if (!res.matched) unmatched++;
            else maxCost = Math.max(maxCost, res.matched.cost);
            if (f.truth) {
                n++;
                const m = res.matched;
                if (m && (m.e === f.truth || (m.e.way === f.truth.way && Math.abs(m.e.seq - f.truth.seq) <= 1))) ok++;
            }
        }
        return { fixes: drive.fixes.length, correct: n ? +(100 * ok / n).toFixed(1) : null, unmatched, maxCost: +maxCost.toFixed(1) };
    }
    // ---- Free driving from the keyboard (arrows or WASD); the GPS reports once a second, like the head unit's ----
    const WHEELBASE = 2.7, TRACK = 1.6;

    // Six-speed automatic. Each gear has its range in km/h: it shifts up between `up` (light throttle) and the
    // second value (floored), down below `down`, sooner with the pedal floored (kickdown). `a` is the push in m/s²
    const GEARS = [
        { ratio: 3.5, up: [15, 32], down: 0, a: 3.6 },
        { ratio: 2.05, up: [30, 58], down: 10, a: 3.0 },
        { ratio: 1.38, up: [45, 85], down: 22, a: 2.4 },
        { ratio: 1.03, up: [60, 112], down: 38, a: 1.9 },
        { ratio: 0.82, up: [75, 140], down: 52, a: 1.6 },
        { ratio: 0.68, up: [Infinity, Infinity], down: 66, a: 1.4 },
    ];
    const FINAL = 3.9, WHEEL = 0.31, IDLE = 800, REDLINE = 6300, REVERSE = 3.3;

    function gearbox(dt, now) {
        const kmh = Math.abs(free.v) * 3.6, thr = free.thr;
        if (free.gear === 'R') free.gearN = 1;
        else if (now > free.shiftUntil) {
            const g = GEARS[free.gearN - 1], prev = GEARS[free.gearN - 2];
            const down = g.down + (prev ? (prev.up[0] - g.down) * Math.max(0, thr - 0.6) * 2 : 0);
            if (kmh > g.up[0] + (g.up[1] - g.up[0]) * thr) { free.gearN++; free.shiftUntil = now + 300; }
            else if (prev && kmh < down) { free.gearN--; free.shiftUntil = now + 300; }
        }
        const ratio = free.gear === 'R' ? REVERSE : GEARS[free.gearN - 1].ratio;
        // Pulling away the torque converter slips: the engine runs above the wheels
        const rpm = Math.max(Math.abs(free.v) / (2 * Math.PI * WHEEL) * 60 * ratio * FINAL, IDLE + thr * 2000 * Math.max(0, 1 - kmh / 20));
        free.rpm += (Math.min(REDLINE, rpm) - free.rpm) * (1 - Math.exp(-dt / 0.08));
    }

    // Share of the peak torque: low at idle, flat in the middle, falling towards the redline
    const torque = rpm => 0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, Math.max(0, (rpm - 600) / 6200)));

    function nearbyRoads(x, y, r) {
        const ways = new Set(OsmMatch.edgesNear(x, y, r).map(e => e.way));
        const near = e => Math.min(Math.hypot(e.ax - x, e.ay - y), Math.hypot(e.bx - x, e.by - y)) < r + 50;
        const out = [];
        for (const way of ways) out.push(...OsmMatch.wayRoads(way, near));
        return out;
    }
    const free = { on: false, keys: new Set(), x: 0, y: 0, brg: 0, v: 0, steer: 0, z: 0, vz: 0, pitch: 0, roll: 0, air: false, t: 0, nextFix: 0, last: 0, nx: 0, ny: 0, tile: '', shownAt: 0 };

    async function startFree(place) {
        run.on = false;
        free.on = false;
        recenter(place.lat, place.lon);
        // The route is unknown: about 4 km of roads and 7 km of terrain all around
        await prepare([place], 2, 2);
        // On the nearest road, heading along it
        const p = OsmMatch.project(place.lat, place.lon);
        let best = null;
        for (const e of OsmMatch.edgesNear(p.x, p.y, 300)) {
            const dx = e.bx - e.ax, dy = e.by - e.ay, l2 = dx * dx + dy * dy || 1e-9;
            const t = Math.max(0, Math.min(1, ((p.x - e.ax) * dx + (p.y - e.ay) * dy) / l2));
            const d = Math.hypot(p.x - e.ax - dx * t, p.y - e.ay - dy * t);
            if (!best || d < best.d) best = { d, x: e.ax + dx * t, y: e.ay + dy * t, brg: OsmMatch.bearing(e.ax, e.ay, e.bx, e.by) };
        }
        if (!best) { info.textContent = 'Nessuna strada qui'; return false; }
        Object.assign(free, { on: true, x: best.x, y: best.y, brg: best.brg, v: 0, steer: 0, vz: 0, pitch: 0, roll: 0, air: false, t: 0, nextFix: 0, last: performance.now(), nx: 0, ny: 0,
            gear: 'D', gearN: 1, rpm: IDLE, shiftUntil: 0, thr: 0, brk: 0, dive: 0, waitGear: 0, road: null, roadAt: 0, offSince: 0, off: 0, odo: 0 });
        // Below everything: the first frame sets it on the ground
        free.z = -1e9;
        built.x = NaN;
        Object.assign(run, { maneuvers: null, navs: [], ok: 0, n: 0, trail: [] });
        OsmMatch.state.e = null;
        info.textContent = 'Frecce o WASD: su accelera, giù frena; da fermo, tenendo giù si va in retromarcia';
        snapToDrive();
        freeFrame();
        return true;
    }

    function freeFrame() {
        if (!free.on) return;
        requestAnimationFrame(freeFrame);
        const now = performance.now();
        const dt = Math.min(0.1, (now - free.last) / 1000);
        free.last = now;
        const k = c => free.keys.has(c);
        const up = k('ArrowUp') || k('KeyW'), down = k('ArrowDown') || k('KeyS');
        const left = k('ArrowLeft') || k('KeyA'), right = k('ArrowRight') || k('KeyD');

        // Engine fades out towards 200 km/h, brakes at 7 m/s², reverse up to 15 km/h once stopped; nothing in the air
        const sign = Math.sign(free.v), stopped = Math.abs(free.v) < 0.05;
        // Stopped, keeping the brake pressed for half a second engages reverse; in reverse the gas pedal does the same back to drive
        if (stopped && (free.gear === 'D' ? down : up)) free.waitGear = free.waitGear || now;
        else free.waitGear = 0;
        if (free.waitGear && now - free.waitGear > 500) {
            free.gear = free.gear === 'D' ? 'R' : 'D';
            free.waitGear = 0;
        }
        // An empty tank: the engine has stopped, the pedal does nothing
        const dry = window.Fuel && Fuel.empty;
        const gas = !dry && (free.gear === 'D' ? up : down), brake = free.gear === 'D' ? down : up;
        // Pedals take a moment: about 0.3 s to full throttle, 0.2 s to full brake
        const ramp = (x, on, upS, downS) => Math.min(1, Math.max(0, x + (on ? dt / upS : -dt / downS)));
        free.thr = ramp(free.thr, gas, 0.3, 0.15);
        free.brk = ramp(free.brk, brake, 0.2, 0.1);

        // Share of the wheels off the asphalt, on grass, earth or gravel: they slip, drag and grip less
        if (window.Terrain && Terrain.onRoad) {
            const b = free.brg * RAD, fx = Math.sin(b), fy = Math.cos(b), half = WHEELBASE / 2, tr = TRACK / 2;
            let offWheels = 0;
            for (const [al, le] of [[half, tr], [half, -tr], [-half, tr], [-half, -tr]]) if (!Terrain.onRoad(free.x + fx * al - fy * le, free.y + fy * al + fx * le)) offWheels++;
            free.off += (offWheels / 4 - free.off) * (1 - Math.exp(-dt / 0.1));
        }
        const off = free.off;

        let a = 0;
        if (!free.air) {
            const sp0 = Math.abs(free.v);
            gearbox(dt, now);
            const shifting = now < free.shiftUntil ? 0.2 : 1;
            a += (free.gear === 'D' ? free.thr * GEARS[free.gearN - 1].a * torque(free.rpm) * shifting : -free.thr * 2 * Math.max(0, 1 - sp0 / 4.2)) * (1 - 0.4 * off);
            // Rolling resistance, air drag and, off the throttle, the engine holding the car back; off the road the
            // ground drags far more, which keeps the car under about 60 km/h there
            const resist = 0.15 + 0.00042 * sp0 * sp0 + (free.thr < 0.05 && sp0 > 2 ? 0.5 + sp0 * 0.012 : 0) + off * (0.35 + 0.0026 * sp0 * sp0);
            // Brakes up to the tyres' grip, about 8.5 m/s² on dry asphalt (ABS keeps steering), 5 on grass
            a -= sign * (resist + free.brk * (8.5 - 3.5 * off));
            a -= 9.81 * Math.sin(free.pitch);
        } else {
            a -= sign * 0.00042 * free.v * free.v;
        }
        const v0 = free.v;
        free.v += a * dt;
        // Brakes and resistance stop the car, they never push it backwards; on a slope the brake holds it
        const pushedBack = Math.sign(free.v) !== Math.sign(v0) && v0 !== 0;
        if ((pushedBack && !(free.thr > 0 && Math.sign(free.v) === (free.gear === 'D' ? 1 : -1))) || (stopped && free.thr === 0)) {
            free.v = 0;
        }
        // The body dives under braking and squats under throttle, about 0.25° per m/s²
        free.dive += (-0.0045 * (a + 9.81 * Math.sin(free.pitch)) - free.dive) * (1 - Math.exp(-dt / 0.15));

        // Steering is limited to about 6 m/s² sideways (3.5 off the road), and centres itself
        const sp = Math.abs(free.v);
        const maxSteer = Math.min(0.6, Math.atan((6 - 2.5 * off) * WHEELBASE / Math.max(1, sp * sp)));
        const target = (left ? -1 : right ? 1 : 0) * maxSteer;
        const rate = target === 0 ? 2.5 : 1.2;
        free.steer += Math.max(-rate * dt, Math.min(rate * dt, target - free.steer));
        const px = free.x, py = free.y, pb = free.brg;
        free.brg = (free.brg + (free.air ? 0 : free.v * Math.tan(free.steer) / WHEELBASE * dt / RAD) + 360) % 360;
        free.x += Math.sin(free.brg * RAD) * free.v * dt;
        free.y += Math.cos(free.brg * RAD) * free.v * dt;
        free.t += dt * 1000;
        // Buildings and guardrails stop the car: back where it was, a small bounce, a thud
        if (collides(px, py, pb)) {
            const impact = Math.abs(free.v);
            Object.assign(free, { x: px, y: py, brg: pb, v: -0.2 * free.v, thr: 0, steer: 0 });
            if (impact > 1 && window.Engine) Engine.crash(impact);
        }
        // And the other players' cars
        if (window.Net) Net.collide(free, dt);

        // The body rests on its four wheels: pushed up by the ground, never into it; when the ground drops away faster
        // than gravity pulls, it flies
        if (window.Terrain) {
            const b = free.brg * RAD, fx = Math.sin(b), fy = Math.cos(b), half = WHEELBASE / 2, tr = TRACK / 2;
            const at = (along, left) => Terrain.surface(free.x + fx * along - fy * left, free.y + fy * along + fx * left);
            const fl = at(half, tr), fr = at(half, -tr), rl = at(-half, tr), rr = at(-half, -tr);
            const floor = Math.max((fl + fr + rl + rr) / 4, Terrain.surface(free.x, free.y));
            free.vz -= 9.81 * dt;
            free.z += free.vz * dt;
            if (free.z <= floor) {
                free.z = floor;
                free.vz = 0;
            }
            free.air = free.z > floor + 0.05;
            if (!free.air) {
                const k = 1 - Math.exp(-dt / 0.08);
                free.pitch += (Math.atan((fl + fr - rl - rr) / 2 / WHEELBASE) - free.pitch) * k;
                free.roll += (-Math.atan((fl + rl - fr - rr) / 2 / TRACK) - free.roll) * k;
            }
            // Off the road the body shakes on the uneven ground, more the faster it goes
            free.odo += sp * dt;
            const shake = free.air ? 0 : off * Math.min(1, sp / 8) * 0.012, o = free.odo;
            const bumpP = shake * (Math.sin(o * 2.3) + 0.6 * Math.sin(o * 5.1 + 1)), bumpR = shake * (Math.sin(o * 3.1 + 2) + 0.5 * Math.sin(o * 6.7));
            Terrain.car = { x: free.x, y: free.y, brg: free.brg, z: free.z, pitch: free.pitch + free.dive + bumpP, roll: free.roll + bumpR };
        }
        const kmh = Math.round(sp * 3.6);
        updateSpeed(kmh, kmh);
        if (now - free.roadAt > 250) {
            free.roadAt = now;
            free.road = roadUnder(free.x, free.y);
            // A fuel station's forecourt is not off the road
            if (free.road || (window.Fuel && Fuel.padAt(free.x, free.y, 1))) free.offSince = 0;
            else if (!free.offSince) free.offSince = now;
        }

        if (free.t >= free.nextFix) {
            free.nextFix += 1000;
            free.nx = 0.9 * free.nx + 1.5 * gauss();
            free.ny = 0.9 * free.ny + 1.5 * gauss();
            const ll = OsmMatch.unproject(free.x + free.nx, free.y + free.ny);
            OsmMatch.ensure(ll.lat, ll.lon, 1);
            // The GPS bearing is the direction of travel, also in reverse
            const travel = free.v < 0 ? (free.brg + 180) % 360 : free.brg;
            onFix({
                t: Math.round(free.t), lat: ll.lat, lon: ll.lon, speed: Math.max(0, sp + 0.2 * gauss()),
                bearing: sp > 1 ? (travel + 3 * gauss() + 360) % 360 : null, acc: 5, truthXY: { x: free.x, y: free.y }
            });
        }
        if (now - free.shownAt > 500 && window.Terrain && Terrain.on) {
            free.shownAt = now;
            const slope = Math.round(Terrain.slope * 100);
            info.textContent = `${free.gear} · quota ${Math.round(Terrain.h0)} m · pendenza ${slope > 0 ? '+' : ''}${slope}%`;
        }
    }

    window.addEventListener('keydown', e => {
        const typing = e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
        if (!free.on || free.paused || typing || !/^(Arrow|Key[WASD]$)/.test(e.code)) return;
        free.keys.add(e.code);
        e.preventDefault();
        e.stopPropagation();
    }, true);
    window.addEventListener('keyup', e => free.keys.delete(e.code), true);
    window.addEventListener('blur', () => free.keys.clear());

    // Corners of a 4.4 x 1.8 m car at pose (x, y, brg)
    function corners(x, y, brg) {
        const b = brg * RAD, fx = Math.sin(b), fy = Math.cos(b);
        return [[2.2, 0.9], [2.2, -0.9], [-2.2, 0.9], [-2.2, -0.9]].map(([a, l]) => ({ x: x + fx * a - fy * l, y: y + fy * a + fx * l }));
    }

    const crosses = (a, b, c, d) => {
        const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
        return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
    };

    // A corner going into a building, or through a guardrail since the last frame
    function collides(px, py, pb) {
        const now = corners(free.x, free.y, free.brg), before = corners(px, py, pb);
        if (window.Buildings && now.some(c => Buildings.hit(c.x, c.y)) && !before.some(c => Buildings.hit(c.x, c.y))) return true;
        const rails = (window.Terrain && Terrain.rails) || [];
        for (const r of rails) {
            if (Math.min(r.ax, r.bx) > free.x + 6 || Math.max(r.ax, r.bx) < free.x - 6 || Math.min(r.ay, r.by) > free.y + 6 || Math.max(r.ay, r.by) < free.y - 6) continue;
            const a = { x: r.ax, y: r.ay }, b = { x: r.bx, y: r.by };
            for (let i = 0; i < 4; i++) if (crosses(before[i], now[i], a, b)) return true;
        }
        return false;
    }

    // Tags of the road under (x, y), null off the roads
    function roadUnder(x, y) {
        let best = null;
        for (const e of OsmMatch.edgesNear(x, y, 25)) {
            const dx = e.bx - e.ax, dy = e.by - e.ay, l2 = dx * dx + dy * dy || 1e-9;
            const t = Math.max(0, Math.min(1, ((x - e.ax) * dx + (y - e.ay) * dy) / l2));
            const d = Math.hypot(x - e.ax - dx * t, y - e.ay - dy * t);
            if (!best || d < best.d) best = { d, e };
        }
        return best && best.d < 8 ? best.e.tags : null;
    }

    let ready;
    const readyP = new Promise(r => { ready = r; });

    // Map coordinates are relative to the first point loaded: far from it they bend, so a far start begins afresh
    function recenter(lat, lon) {
        const p = OsmMatch.project(lat, lon);
        if (Math.hypot(p.x, p.y) < 30000) return;
        stop();
        OsmMatch.reset();
        if (window.OsmOnline) OsmOnline.reset();
        if (window.Terrain) Terrain.reset();
        if (window.Buildings) Buildings.reset();
        if (window.World) World.reset();
        if (window.Pois) Pois.reset();
        if (window.Fuel) Fuel.reset();
        OsmMatch.project(lat, lon);
    }

    function stop() {
        free.on = false;
        run.on = false;
        if (window.Terrain) Terrain.car = null;
        updateSpeed(0, 0);
    }

    // Back on the nearest road, facing the way along it closest to the car's heading
    function backToRoad() {
        let best = null;
        for (const r of [50, 200, 1000]) {
            for (const e of OsmMatch.edgesNear(free.x, free.y, r)) {
                const dx = e.bx - e.ax, dy = e.by - e.ay, l2 = dx * dx + dy * dy || 1e-9;
                const t = Math.max(0, Math.min(1, ((free.x - e.ax) * dx + (free.y - e.ay) * dy) / l2));
                const d = Math.hypot(free.x - e.ax - dx * t, free.y - e.ay - dy * t);
                if (!best || d < best.d) best = { d, e, x: e.ax + dx * t, y: e.ay + dy * t };
            }
            if (best) break;
        }
        if (!best) return false;
        const along = best.e.brg, back = (along + 180) % 360;
        const turn = a => Math.abs(OsmMatch.turnOf(free.brg, a));
        Object.assign(free, { x: best.x, y: best.y, brg: turn(along) <= turn(back) ? along : back, v: 0, vz: 0, steer: 0, z: -1e9, offSince: 0, gear: 'D' });
        OsmMatch.state.e = null;
        return true;
    }

    window.osmSim = { synthetic: (a, b) => synthetic(a, b), evaluate, run, free, startFree, roadUnder, recenter, stop, backToRoad, prepare, ready: readyP, SGLM, PLACES };

    window.addEventListener('load', () => setTimeout(async () => {
        // A simulator keeps the driver's view when the car stops, instead of turning round to the parked car
        const baseHold = holdDriveView;
        holdDriveView = () => free.on || run.on || baseHold();
        // Online by default, like a browser game; ?local uses the tiles of build_tiles.py copied into data/tiles
        if (new URLSearchParams(location.search).has('local')) await OsmMatch.init('data/tiles/');
        else {
            await OsmOnline.init();
            OsmMatch.useSource(OsmOnline.source);
        }
        ready();
        if (!DEBUG) return;
        const traces = await fetch('data/traces/index.json').then(r => r.json()).catch(() => []);

        canvas = document.createElement('canvas');
        canvas.width = 360;
        canvas.height = 360;
        canvas.style.cssText = 'position:fixed;left:8px;top:8px;z-index:300;border-radius:10px';
        document.body.appendChild(canvas);

        const panel = document.createElement('div');
        panel.style.cssText = 'position:fixed;top:120px;right:8px;z-index:999;background:rgba(0,0,0,.7);color:#fff;padding:8px 12px;border-radius:10px;font:12px sans-serif;display:flex;flex-direction:column;gap:6px;max-width:260px';
        const options = [
            ...PLACES.map((p, i) => `<option value="syn-out-${i}">Sintetico: ${SGLM.name} → ${p.name}</option>`),
            ...PLACES.map((p, i) => `<option value="syn-in-${i}">Sintetico: ${p.name} → ${SGLM.name}</option>`),
            ...traces.map(t => `<option value="trace-${t.file}">Reale: ${t.label}</option>`),
        ].join('');
        panel.innerHTML = `<b>OpenStreetMap</b>
          <select id="osm-drive">${options}</select>
          <label>velocità <select id="osm-speedup"><option value="0">pausa</option><option>1</option><option>2</option><option selected>4</option><option>10</option></select>×</label>
          <button id="osm-go" data-sim-start>▶ Guida su OSM</button>
          <select id="osm-free-from">${[SGLM, ...PLACES].map((p, i) => `<option value="${i}">Parti da ${p.name}</option>`).join('')}</select>
          <button id="osm-free" data-sim-start>Guida libera (frecce)</button>
          <label>traccia head unit <input id="osm-csv" type="file" accept=".csv" style="width:150px"></label>
          <div id="osm-info" style="opacity:.8"></div>`;
        document.body.appendChild(panel);
        info = panel.querySelector('#osm-info');
        panel.querySelector('#osm-speedup').onchange = e => { run.speedup = +e.target.value; };
        run.speedup = 4;
        panel.querySelector('#osm-go').onclick = async () => {
            const v = panel.querySelector('#osm-drive').value;
            if (v.startsWith('trace-')) {
                const fixes = await (await fetch('data/traces/' + v.slice(6))).json();
                info.textContent = `${fixes.length} punti GPS reali`;
                start({ fixes });
            } else {
                const [, way, i] = v.split('-');
                const p = PLACES[+i];
                const [from, to] = way === 'out' ? [SGLM, p] : [p, SGLM];
                start(await synthetic(from, to));
            }
        };
        panel.querySelector('#osm-free').onclick = e => {
            e.target.blur();
            startFree([SGLM, ...PLACES][+panel.querySelector('#osm-free-from').value]);
        };
        panel.querySelector('#osm-csv').onchange = async e => {
            const file = e.target.files[0];
            if (!file) return;
            const drive = parseCsv(await file.text());
            info.textContent = `${drive.fixes.length} punti, ${drive.navs.length} manovre dall'head unit`;
            start(drive);
        };
    }, 50));
})();
