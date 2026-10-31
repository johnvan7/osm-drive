// Online: everyone driving meets on the same map. The server tells each player about the few nearest in full and
// the rest roughly; this sends the car's state as often as there is someone near to see it, draws the other cars
// a moment behind their last update so they move smoothly, and lets the car bump into them
(() => {
    const KEY_ON = 'osm-drive-online', KEY_NAME = 'osm-drive-name';
    const NEAR_MS = 200, ALONE_MS = 2000, STILL_MS = 5000;   // ms between updates: someone near, alone, alone and stopped
    const DELAY = 250;          // ms the other cars are drawn behind their updates
    const GHOST_MS = 5000;      // after a start, help or back to the road: no collisions for a moment
    const LEN = 4.4, WID = 1.8; // m, the car
    const SHOW = 700;           // m: other cars drawn within this
    // On GitHub Pages the realtime world is on the Worker; elsewhere on the same host as the page
    const WORKER = 'wss://osm-drive.johnvan7.workers.dev/ws';
    const RAD = Math.PI / 180;

    let on = true, name = '';
    try { on = localStorage.getItem(KEY_ON) !== 'off'; name = localStorage.getItem(KEY_NAME) || ''; } catch (err) { /* storage blocked */ }
    const save = () => { try { localStorage.setItem(KEY_ON, on ? 'on' : 'off'); localStorage.setItem(KEY_NAME, name); } catch (err) { /* storage blocked */ } };

    const net = { ws: null, id: null, status: 'off', crowd: 0, total: 0, sentAt: 0, retryAt: 0, retry: 2000, ghostUntil: 0, crowdSaidAt: 0 };
    // The big map: what it shows, asked every few seconds and soon after it moves; the answer, with where each dot was
    // before it, to slide it there
    const MAP_EVERY = 3000, MAP_SETTLE = 300, SLIDE = 1000;
    const view = { open: false, b: null, z: 0, key: '', changedAt: 0, askedAt: 0, askedKey: '', at: 0, c: [], p: [], from: new Map() };
    const others = new Map();   // id -> { id, name, colour, buf: [{ t, lat, lon, b, v, g }], far, pose, mesh, label }

    function url() {
        const q = new URLSearchParams(location.search).get('server');
        if (q) return q;
        if (/github\.io$/.test(location.hostname)) return WORKER;
        return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    }

    // ---- Connection ----
    function connect() {
        if (net.ws || !on || performance.now() < net.retryAt) return;
        net.status = 'connecting';
        let ws;
        try { ws = new WebSocket(url()); } catch (err) { fail(); return; }
        net.ws = ws;
        ws.onopen = () => {
            net.status = 'on';
            net.retry = 2000;
            ws.send(JSON.stringify({ t: 'hi', name: name || 'Pilota' }));
            net.sentAt = 0;
        };
        ws.onmessage = e => { try { receive(JSON.parse(e.data)); } catch (err) { /* a bad message is skipped */ } };
        ws.onclose = () => { if (net.ws === ws) fail(); };
        ws.onerror = () => {};
    }

    // Down or refused: again later, waiting longer each time (up to a minute)
    function fail() {
        net.ws = null;
        net.status = on ? 'offline' : 'off';
        net.retryAt = performance.now() + net.retry;
        net.retry = Math.min(60000, net.retry * 2);
        for (const id of [...others.keys()]) drop(id);
    }

    function disconnect() {
        const ws = net.ws;
        net.ws = null;
        if (ws) ws.close();
        net.status = 'off';
        for (const id of [...others.keys()]) drop(id);
    }

    function receive(m) {
        if (m.t === 'w') { net.id = m.id; return; }
        if (m.t === 'h') { heard(m); return; }
        if (m.t === 'm') {
            const now = performance.now(), was = new Map(view.p.map(o => [o.id, place(o, now)]));
            view.from = was;
            view.at = now;
            view.c = (m.c || []).map(([lat, lon, n, id, name]) => ({ lat, lon, n, id, name, colour: id ? colourOf(id) : null }));
            view.p = (m.p || []).map(([id, name, lat, lon, b]) => ({ id, name, lat, lon, b, colour: colourOf(id) }));
            net.total = m.total || 0;
            Net.onMap && Net.onMap();
            return;
        }
        if (m.t !== 'u') return;
        const now = performance.now();
        net.crowd = m.c || 0;
        if (m.total != null) net.total = m.total;
        for (const [id, n] of Object.entries(m.names || {})) entry(id).name = n || 'Pilota';
        const seen = new Set();
        for (const [id, lat, lon, b, v, g, age] of m.n || []) {
            const o = entry(id);
            seen.add(id);
            o.buf.push({ t: now - age, lat, lon, b, v, g });
            o.buf.sort((p, q) => p.t - q.t);
            if (o.buf.length > 12) o.buf.shift();
            o.nearAt = now;
            o.far = { lat, lon, at: now };
        }
        if (m.f) {
            for (const [id, lat, lon] of m.f) { const o = entry(id); o.far = { lat, lon, at: now }; }
            // Gone from the world
            const listed = new Set([...seen, ...m.f.map(f => f[0])]);
            for (const id of [...others.keys()]) if (!listed.has(id)) drop(id);
        }
        if (net.crowd > 12 && now - net.crowdSaidAt > 60000) {
            net.crowdSaidAt = now;
            Net.onMessage && Net.onMessage('crowded', 12);
        }
    }

    // A colour of its own for each player, from its id
    function colourOf(id) {
        let h = 0;
        for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
        return `hsl(${h % 360}, 75%, 55%)`;
    }

    // Where a map dot is drawn now: sliding from where it was to where it is
    function place(o, now) {
        const a = view.from.get(o.id), k = Math.min(1, (now - view.at) / SLIDE);
        return a ? { lat: a.lat + (o.lat - a.lat) * k, lon: a.lon + (o.lon - a.lon) * k } : { lat: o.lat, lon: o.lon };
    }

    function entry(id) {
        let o = others.get(id);
        if (!o) {
            o = { id, name: 'Pilota', colour: colourOf(id), buf: [], far: null, pose: null, nearAt: 0 };
            others.set(id, o);
        }
        return o;
    }

    function drop(id) {
        const o = others.get(id);
        if (o && o.mesh) { map.inner.remove(o.mesh); disposeCar(o); }
        others.delete(id);
    }

    // ---- Sending ----
    function send(now) {
        const f = osmSim.free;
        if (!net.ws || net.ws.readyState !== 1 || !f.on) return;
        const near = [...others.values()].some(o => o.nearAt && now - o.nearAt < 3000);
        const every = near ? NEAR_MS : Math.abs(f.v) > 1 ? ALONE_MS : STILL_MS;
        if (now - net.sentAt < every) return;
        net.sentAt = now;
        const ll = OsmMatch.unproject(f.x, f.y);
        net.ws.send(JSON.stringify({ t: 's', s: [+ll.lat.toFixed(7), +ll.lon.toFixed(7), Math.round(f.brg * 10) / 10, Math.round(f.v * 10) / 10, ghost() ? 1 : 0] }));
    }

    const ghost = () => performance.now() < net.ghostUntil;

    function askMap(now) {
        if (!view.open || !view.b || !net.ws || net.ws.readyState !== 1) return;
        const moved = view.key !== view.askedKey;
        if (moved ? now - view.changedAt < MAP_SETTLE && now - view.askedAt < MAP_EVERY : now - view.askedAt < MAP_EVERY) return;
        view.askedAt = now;
        view.askedKey = view.key;
        net.ws.send(JSON.stringify({ t: 'm', b: view.b, z: view.z }));
    }

    // ---- The other cars ----
    // Where a car is now: between the two updates around a moment just past, or a little beyond the last one
    function poseOf(o, now) {
        const R = now - DELAY, buf = o.buf;
        if (!buf.length || now - o.nearAt > 3000) return null;
        let a = buf[0], b = null;
        for (let i = 0; i < buf.length; i++) {
            if (buf[i].t <= R) a = buf[i];
            else { b = buf[i]; break; }
        }
        const pa = OsmMatch.project(a.lat, a.lon);
        let x = pa.x, y = pa.y, brg = a.b, v = a.v;
        if (b && b.t > a.t) {
            const pb = OsmMatch.project(b.lat, b.lon), k = Math.max(0, Math.min(1, (R - a.t) / (b.t - a.t)));
            // A jump (help, back to the road) is not slid through
            if (Math.hypot(pb.x - pa.x, pb.y - pa.y) < 40) {
                x += (pb.x - pa.x) * k;
                y += (pb.y - pa.y) * k;
                brg = a.b + OsmMatch.turnOf(a.b, b.b) * k;
                v = a.v + (b.v - a.v) * k;
            } else if (k > 0.5) {
                x = pb.x; y = pb.y; brg = b.b; v = b.v;
            }
        } else {
            // Past the last update: on along its heading, for at most half a second
            const ahead = Math.min(0.5, Math.max(0, (R - a.t) / 1000)) * a.v;
            x += Math.sin(a.b * RAD) * ahead;
            y += Math.cos(a.b * RAD) * ahead;
        }
        return { x, y, brg: ((brg % 360) + 360) % 360, v, g: (b || a).g };
    }

    // A copy of the player's car in the other's colour, its name above it
    let carSize = null;
    function makeCar(o) {
        if (!model) return null;
        if (!carSize) carSize = new THREE.Box3().setFromObject(model);
        const u = 1 / METERS_PER_UNIT;
        const wrap = new THREE.Group(), tilt = new THREE.Group(), turn = new THREE.Group();
        // The model faces the road's direction in the view: undo that, so it faces +Z and the heading turns it
        turn.rotation.y = -roadPivot.rotation.y;
        const car = model.clone(true), tint = new THREE.Color(o.colour);
        car.traverse(m => {
            if (!m.isMesh) return;
            m.material = (Array.isArray(m.material) ? m.material : [m.material]).map(mat => {
                const c = mat.clone();
                if (c.color) c.color.lerp(tint, 0.45);
                c.transparent = true;
                return c;
            });
            if (m.material.length === 1) m.material = m.material[0];
        });
        turn.add(car);
        tilt.add(turn);
        wrap.add(tilt);
        wrap.add(o.label = label(o));
        o.label.position.y = carSize.max.y + 0.9 * u;
        o.tilt = tilt;
        o.mats = [];
        car.traverse(m => { if (m.isMesh) o.mats.push(...[].concat(m.material)); });
        return wrap;
    }

    function label(o) {
        const c = document.createElement('canvas'), g = c.getContext('2d'), font = '600 30px system-ui,sans-serif';
        g.font = font;
        const w = Math.min(360, g.measureText(o.name).width);
        c.width = Math.ceil(w + 56);
        c.height = 52;
        g.fillStyle = 'rgba(14,18,24,.85)';
        g.beginPath();
        g.roundRect ? g.roundRect(0, 0, c.width, c.height, 26) : g.rect(0, 0, c.width, c.height);
        g.fill();
        g.fillStyle = o.colour;
        g.beginPath();
        g.arc(24, 26, 9, 0, 7);
        g.fill();
        g.fillStyle = '#fff';
        g.font = font;
        g.textBaseline = 'middle';
        g.fillText(o.name, 42, 27, w);
        const tex = new THREE.CanvasTexture(c);
        tex.minFilter = THREE.LinearFilter;
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
        s.center.set(0.5, 0);
        const h = 0.8 / METERS_PER_UNIT;
        s.scale.set(h * c.width / c.height, h, 1);
        s.userData.name = o.name;
        return s;
    }

    function disposeCar(o) {
        for (const m of o.mats || []) m.dispose();
        if (o.label) { o.label.material.map.dispose(); o.label.material.dispose(); }
        o.mesh = o.label = o.tilt = null;
        o.mats = [];
    }

    function draw(now) {
        const f = osmSim.free, u = 1 / METERS_PER_UNIT;
        for (const o of others.values()) {
            o.pose = f.on ? poseOf(o, now) : null;
            const show = o.pose && Math.hypot(o.pose.x - f.x, o.pose.y - f.y) < SHOW;
            if (!show) {
                if (o.mesh) { map.inner.remove(o.mesh); disposeCar(o); }
                continue;
            }
            if (o.mesh && o.label && o.label.userData.name !== o.name) { map.inner.remove(o.mesh); disposeCar(o); }
            if (!o.mesh) {
                o.mesh = makeCar(o);
                if (!o.mesh) continue;
                map.inner.add(o.mesh);
            }
            const { x, y, brg, g } = o.pose, b = brg * RAD, fx = Math.sin(b), fy = Math.cos(b);
            const h = Terrain.surface(x, y), front = Terrain.surface(x + fx * LEN / 2, y + fy * LEN / 2), back = Terrain.surface(x - fx * LEN / 2, y - fy * LEN / 2);
            o.mesh.position.set(-x * u, h * u, y * u);
            o.mesh.rotation.y = -b;
            o.tilt.rotation.x = -Math.atan((front - back) / LEN);
            // A ghost is seen through
            const alpha = g ? 0.4 : 1;
            for (const m of o.mats) m.opacity = alpha;
        }
        // The own car is a ghost too for a moment after a start
        if (model) {
            const alpha = ghost() ? 0.5 : 1;
            if (alpha !== draw.ownAlpha) {
                draw.ownAlpha = alpha;
                model.traverse(m => { if (m.isMesh) for (const mat of [].concat(m.material)) { mat.transparent = alpha < 1; mat.opacity = alpha; } });
            }
        }
    }

    // ---- Horn: held for at most a few seconds; heard by the others as far as it really is ----
    const HORN_MAX = 3000, SOUND = 343;   // ms, m/s
    const horns = new Map();              // id ('' for the own) -> { stop, timer }
    const pitchOf = id => { let h = 7; for (const c of id || '') h = (h * 31 + c.charCodeAt(0)) >>> 0; return 0.92 + (h % 17) / 100; };

    function hornOff(id) {
        const h = horns.get(id);
        if (!h) return;
        horns.delete(id);
        clearTimeout(h.timer);
        h.stop();
    }

    function horn(down) {
        const f = window.osmSim && osmSim.free;
        if (!window.Engine || !f || !f.on) return;
        if (down === horns.has('')) return;
        if (down) {
            horns.set('', { stop: Engine.horn({ pitch: pitchOf(net.id) }), timer: setTimeout(() => horn(false), HORN_MAX) });
        } else {
            hornOff('');
        }
        if (on && net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify({ t: 'h', on: down ? 1 : 0 }));
    }

    // Louder near (inverse of the distance from 8 m), duller far (the air takes the highs), later by the time sound
    // takes, and from where it is
    function heard(m) {
        const f = window.osmSim && osmSim.free;
        if (!window.Engine || !f || !f.on || !m.id) return;
        const o = others.get(m.id), at = o && o.pose ? o.pose : Number.isFinite(m.lat) ? OsmMatch.project(m.lat, m.lon) : null;
        if (!at) return;
        const d = Math.hypot(at.x - f.x, at.y - f.y), delay = d / SOUND;
        if (!m.on) { hornOff(m.id); return; }
        if (horns.has(m.id)) return;
        const turn = OsmMatch.turnOf(f.brg, OsmMatch.bearing(f.x, f.y, at.x, at.y)) * RAD;
        const stop = Engine.horn({
            gain: 0.22 * Math.min(1, 8 / Math.max(1, d)), pan: Math.sin(turn) * 0.8, delay,
            cutoff: Math.max(600, 3500 * Math.min(1, 40 / Math.max(1, d))), pitch: pitchOf(m.id)
        });
        // An end that never comes (connection lost): silent anyway after the longest horn
        horns.set(m.id, { stop, timer: setTimeout(() => hornOff(m.id), HORN_MAX + 500 + delay * 1000) });
    }

    // ---- Collisions: each player moves only their own car, out of the others and with a knock ----
    function corners(x, y, brg) {
        const b = brg * RAD, fx = Math.sin(b), fy = Math.cos(b), rx = fy, ry = -fx;
        return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, s]) => ({ x: x + fx * a * LEN / 2 + rx * s * WID / 2, y: y + fy * a * LEN / 2 + ry * s * WID / 2 }));
    }
    // Separating axes of two boxes: the smallest push out of the other, null when apart
    function overlap(A, B) {
        let best = null;
        for (const P of [A, B]) {
            for (let i = 0; i < 2; i++) {
                const ex = P[i + 1].x - P[i].x, ey = P[i + 1].y - P[i].y, l = Math.hypot(ex, ey), nx = -ey / l, ny = ex / l;
                const pa = A.map(p => p.x * nx + p.y * ny), pb = B.map(p => p.x * nx + p.y * ny);
                const d = Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb));
                if (d <= 0) return null;
                if (!best || d < best.d) best = { d, nx, ny };
            }
        }
        return best;
    }

    const knocks = new Map();
    function collide(f, dt) {
        if (!on || ghost()) return;
        const now = performance.now(), mine = corners(f.x, f.y, f.brg);
        for (const o of others.values()) {
            const p = o.pose;
            if (!p || p.g || Math.abs(p.x - f.x) > 8 || Math.abs(p.y - f.y) > 8) continue;
            const hit = overlap(mine, corners(p.x, p.y, p.brg));
            if (!hit) continue;
            // From this car towards the other
            let { nx, ny } = hit;
            if ((p.x - f.x) * nx + (p.y - f.y) * ny < 0) { nx = -nx; ny = -ny; }
            f.x -= nx * hit.d;
            f.y -= ny * hit.d;
            const hx = Math.sin(f.brg * RAD), hy = Math.cos(f.brg * RAD), along = hx * nx + hy * ny;
            const ov = { x: Math.sin(p.brg * RAD) * p.v, y: Math.cos(p.brg * RAD) * p.v };
            const closing = f.v * along - (ov.x * nx + ov.y * ny);
            // Driving into it: the speed towards it goes, a little comes back; driven into: pushed along
            if (f.v * along > 0) f.v -= 1.3 * f.v * along * along;
            // Driven into: moved away at up to 60% of the other's speed towards it, once (not again every frame of the
            // contact); a knock from the side only shifts it
            const push = -(ov.x * nx + ov.y * ny), away = -along;
            if (push > 0 && Math.abs(away) > 0.3 && f.v * away < 0.6 * push) f.v = 0.6 * push / away;
            if (closing > 1 && now - (knocks.get(o.id) || 0) > 500) {
                knocks.set(o.id, now);
                if (window.Engine) Engine.crash(closing);
            }
        }
    }

    function tick(now) {
        requestAnimationFrame(tick);
        const f = window.osmSim && osmSim.free;
        if (!f) return;
        // Driving, or looking at the map (before a start too: then only watching, and there is no scene yet)
        if (on && (f.on || view.open)) connect();
        askMap(now);
        if (!map.inner) return;
        send(now);
        draw(now);
    }

    window.Net = {
        get on() { return on; },
        set on(v) { on = !!v; save(); if (!on) disconnect(); else net.retryAt = 0; },
        get name() { return name; },
        set name(v) {
            name = String(v || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 20);
            save();
            if (net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify({ t: 'hi', name: name || 'Pilota' }));
        },
        get status() { return net.status; },
        // Players near enough to be drawn, and everyone else roughly
        get nearCount() { return [...others.values()].filter(o => o.pose).length; },
        get total() { return net.total; },
        players() {
            const out = [];
            for (const o of others.values()) {
                if (o.pose) { const ll = OsmMatch.unproject(o.pose.x, o.pose.y); out.push({ lat: ll.lat, lon: ll.lon, x: o.pose.x, y: o.pose.y, name: o.name, colour: o.colour, near: true }); }
                else if (o.far) out.push({ lat: o.far.lat, lon: o.far.lon, name: o.name, colour: o.colour, near: false });
            }
            return out;
        },
        ghost: () => { net.ghostUntil = performance.now() + GHOST_MS; },
        // The big map tells what it shows: [south, west, north, east] and its zoom
        set mapOpen(v) { view.open = !!v; if (v) view.askedAt = 0; },
        mapView(b, z) {
            const key = b.map(x => x.toFixed(4)).join(',') + ':' + Math.round(z * 2);
            if (key !== view.key) { view.key = key; view.changedAt = performance.now(); }
            view.b = b;
            view.z = z;
        },
        // For the big map: groups { lat, lon, n } far out, single players { id, name, colour, lat, lon, b } close up;
        // the ones near the car where they are now. `moving` while dots are still sliding
        mapItems() {
            const now = performance.now(), near = new Map();
            for (const o of others.values()) if (o.pose) near.set(o.id, o);
            const p = view.p.map(o => {
                const n = near.get(o.id);
                if (n) { const ll = OsmMatch.unproject(n.pose.x, n.pose.y); return { ...o, lat: ll.lat, lon: ll.lon, b: n.pose.brg }; }
                return { ...o, ...place(o, now) };
            });
            return { c: on ? view.c : [], p: on ? p : [], moving: now - view.at < SLIDE || near.size > 0 };
        },
        onMap: null,
        collide,
        horn,
        onMessage: null,
    };

    // A start, roadside help and back to the road put the car where another might be
    window.addEventListener('load', () => {
        for (const [obj, fn] of [[osmSim, 'startFree'], [osmSim, 'backToRoad'], [window.Fuel, 'rescue']]) {
            if (!obj || !obj[fn]) continue;
            const base = obj[fn].bind(obj);
            // Also once a start has finished loading, which takes a while
            obj[fn] = (...args) => { const r = base(...args); Net.ghost(); Promise.resolve(r).then(() => Net.ghost()); return r; };
        }
    });
    requestAnimationFrame(tick);
})();
