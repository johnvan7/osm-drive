// Labels over places of interest in the 3D view: from the vector tiles' poi layer, only the most important ones near
// the car and ahead of it, a few at a time and kept apart, so a busy old town doesn't fill the screen
(() => {
    const RANGE = 180;     // m: farther labels are not shown
    const FULL = 110;      // m: nearer labels are fully opaque, fading out to RANGE
    const GAP = 35;        // m between two labels shown
    const NEAR = 30;       // m: nearer labels fade out, as they would hang over the camera
    const KEY = 'osm-drive-pois';
    // Kind -> tier (0 shows first), colour as on the big map, glyph. Kinds not listed are never shown
    const KINDS = {
        fuel: [0, '#ff9f1a', '\u26fd'], hospital: [0, '#ff5a4f', '\u271a'], pharmacy: [0, '#3ccf7a', '\u271a'],
        railway: [0, '#3e8bff', '\ud83d\ude86'], attraction: [0, '#bfa58a', '\u2605'], museum: [0, '#bfa58a', '\ud83c\udfdb'],
        town_hall: [0, '#bfa58a', '\ud83c\udfdb'], police: [1, '#3e8bff', '\ud83d\ude93'], place_of_worship: [1, '#bfa58a', '\u26ea'],
        lodging: [1, '#7aa2c7', '\ud83d\udecf'], restaurant: [1, '#e86aa6', '\ud83c\udf74'], grocery: [1, '#9b7bff', '\ud83d\uded2'],
        cafe: [2, '#e86aa6', '\u2615'], bar: [2, '#e86aa6', '\ud83c\udf78'], pub: [2, '#e86aa6', '\ud83c\udf7a'], fast_food: [2, '#e86aa6', '\ud83c\udf54'],
        ice_cream: [2, '#e86aa6', '\ud83c\udf66'], bakery: [2, '#9b7bff', '\ud83e\udd50'], bank: [2, '#7aa2c7', '\ud83c\udfe6'],
        school: [2, '#d9b44a', '\ud83c\udfeb'], college: [2, '#d9b44a', '\ud83c\udf93'], doctors: [2, '#ff5a4f', '\u2695'],
        parking: [2, '#3e8bff', 'P'], park: [2, '#3ccf7a', '\ud83c\udf33'], shop: [3, '#9b7bff', '\ud83d\udecd'], clothing_store: [3, '#9b7bff', '\ud83d\udc55'],
    };
    // Shown without a name too, as what they are
    const GENERIC = { fuel: 'poiFuel', pharmacy: 'poiPharmacy', hospital: 'poiHospital', parking: 'poiParking' };
    const touch = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || new URLSearchParams(location.search).has('touch');
    const MAX = touch ? 7 : 10;

    let on = true;
    try { on = localStorage.getItem(KEY) !== 'off'; } catch (err) { /* storage blocked */ }

    const labels = new Map();   // poi -> { sprite, want, op }
    let chosen = new Set(), pickedAt = 0;

    function text(poi) {
        return I18n.name(poi.p) || (GENERIC[poi.p.class] ? I18n.t(GENERIC[poi.p.class]) : '');
    }

    // A dark pill with the kind's coloured badge and the name, and a small point under it
    function makeSprite(poi) {
        const [, colour, glyph] = KINDS[poi.p.class], name = text(poi);
        const c = document.createElement('canvas'), g = c.getContext('2d'), H = 64, R = 24, PAD = 14, TIP = 12;
        const font = '600 30px system-ui,sans-serif';
        g.font = font;
        const nameW = Math.min(420, g.measureText(name).width);
        c.width = Math.ceil(PAD + R * 2 + 12 + nameW + PAD * 1.4);
        c.height = H + TIP;
        g.fillStyle = 'rgba(14,18,24,.85)';
        g.beginPath();
        g.roundRect ? g.roundRect(0, 0, c.width, H, H / 2) : g.rect(0, 0, c.width, H);
        g.moveTo(c.width / 2 - TIP, H);
        g.lineTo(c.width / 2, H + TIP);
        g.lineTo(c.width / 2 + TIP, H);
        g.fill();
        g.fillStyle = colour;
        g.beginPath();
        g.arc(PAD + R - 4, H / 2, R, 0, 7);
        g.fill();
        g.fillStyle = '#fff';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.font = glyph === 'P' ? '700 28px system-ui,sans-serif' : '26px system-ui,sans-serif';
        g.fillText(glyph, PAD + R - 4, H / 2 + 1);
        g.font = font;
        g.textAlign = 'left';
        g.fillText(name, PAD + R * 2 + 8, H / 2 + 1, nameW);
        const tex = new THREE.CanvasTexture(c);
        tex.minFilter = THREE.LinearFilter;
        // Drawn over everything, like a navigation app's pins: few enough not to clutter, and never lost behind a wall
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false, opacity: 0 }));
        // The point at the bottom stands on the place
        s.center.set(0.5, 0);
        s.renderOrder = 50;
        s.userData.aspect = c.width / c.height;
        return s;
    }

    function drop(poi) {
        const l = labels.get(poi);
        map.inner.remove(l.sprite);
        l.sprite.material.map.dispose();
        l.sprite.material.dispose();
        labels.delete(poi);
    }

    // Where a label hangs, in the view's local coordinates: at shop-sign height, under the roof of a low building
    const u = 1 / METERS_PER_UNIT;
    function anchor(poi) {
        const ground = Terrain.ground(poi.x, poi.y), top = window.Buildings && Buildings.topAt(poi.x, poi.y);
        const h = top != null ? Math.min(top + 1, ground + 6) : ground + 4;
        return new THREE.Vector3(-poi.x * u, roadMesh.position.y + h * u, poi.y * u);
    }
    function size(d) {
        // About the same size up close, a little smaller far away: 1.5 m tall at 30 m, scaled with distance
        return 1.5 * Math.max(1, d / 30) * (1 - 0.35 * Math.min(1, Math.max(0, (d - 30) / (RANGE - 30)))) * u;
    }

    // The labels worth showing now: important first, then near; only those that land on screen and clear of the ones
    // already taken, the ones already up kept a little longer
    function pick(f) {
        const ll = OsmMatch.unproject(f.x, f.y), [tx, ty] = OsmOnline.tileOf(ll.lat, ll.lon);
        const b = (f.v < 0 ? f.brg + 180 : f.brg) * Math.PI / 180, hx = Math.sin(b), hy = Math.cos(b);
        const list = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const area = OsmOnline.areas.get(`${tx + dx}/${ty + dy}`);
                if (!area) continue;
                for (const poi of area.pois) {
                    const kind = KINDS[poi.p.class];
                    if (!kind) continue;
                    if (poi.x === undefined) {
                        Object.assign(poi, OsmMatch.project(poi.lat, poi.lon));
                        poi.label = text(poi);
                    }
                    if (!poi.label) continue;
                    const vx = poi.x - f.x, vy = poi.y - f.y, d = Math.hypot(vx, vy);
                    if (d > RANGE || d < NEAR / 2 || (vx * hx + vy * hy) < d * 0.3) continue;
                    const score = kind[0] * 25 + Math.min(30, poi.p.rank || 30) + d / 12 - (chosen.has(poi) ? 12 : 0);
                    list.push({ poi, score, d });
                }
            }
        }
        list.sort((a, b) => a.score - b.score);
        map.inner.updateMatrixWorld();
        const W = innerWidth, H = innerHeight, out = [], boxes = [];
        for (const { poi, d } of list) {
            if (out.length >= MAX) break;
            if (!Terrain.has(poi.lat, poi.lon) || out.some(o => Math.hypot(o.x - poi.x, o.y - poi.y) < GAP)) continue;
            const p = map.inner.localToWorld(anchor(poi)).project(camera);
            if (p.z > 1) continue;
            const sx = (p.x + 1) / 2 * W, sy = (1 - p.y) / 2 * H;
            // Its box on screen, from the bottom point up; about 7 characters' width per 10 of label height
            const hPx = size(d) / (2 * Math.tan(camera.fov * Math.PI / 360) * camera.position.distanceTo(map.inner.localToWorld(anchor(poi)))) * H;
            const wPx = hPx * (1.4 + 0.42 * Math.min(18, poi.label.length));
            const box = [sx - wPx / 2, sy - hPx, sx + wPx / 2, sy];
            if (box[2] < 0 || box[0] > W || box[3] < 40 || box[1] > H * 0.75) continue;
            if (boxes.some(o => box[0] < o[2] + 6 && box[2] > o[0] - 6 && box[1] < o[3] + 4 && box[3] > o[1] - 4)) continue;
            boxes.push(box);
            out.push(poi);
        }
        return new Set(out);
    }

    function tick() {
        requestAnimationFrame(tick);
        const f = window.osmSim && osmSim.free;
        if (!window.OsmOnline || !map.inner) return;
        if (!f || !f.on || !on) {
            for (const poi of [...labels.keys()]) drop(poi);
            chosen = new Set();
            return;
        }
        const now = performance.now();
        if (now - pickedAt > 400) {
            pickedAt = now;
            chosen = pick(f);
            for (const poi of chosen) {
                if (labels.has(poi)) continue;
                const sprite = makeSprite(poi);
                map.inner.add(sprite);
                labels.set(poi, { sprite, op: 0 });
            }
            // Buildings come in over time: the height again
            for (const [poi, l] of labels) l.sprite.position.copy(anchor(poi));
        }
        // Fog hides them with everything else
        const fogFar = Terrain.fog ? Terrain.fog.far : Infinity, shown = Math.min(1, roadCurrentOpacity / 0.8);
        // In gently, out quickly, so few more than the chosen ones are up while they change
        const kIn = 1 - Math.exp(-1 / 60 / 0.25), kOut = 1 - Math.exp(-1 / 60 / 0.08);
        for (const [poi, l] of labels) {
            const d = Math.hypot(poi.x - f.x, poi.y - f.y);
            const fade = Math.min(1, Math.max(0, 1 - (d - FULL) / (RANGE - FULL))) * Math.min(1, Math.max(0, 2 - 2 * d / fogFar))
                * Math.min(1, Math.max(0, (d - NEAR / 2) / (NEAR / 2)));
            const want = chosen.has(poi) ? fade : 0;
            l.op += (want - l.op) * (want > l.op ? kIn : kOut);
            if (want === 0 && l.op < 0.02) { drop(poi); continue; }
            l.sprite.material.opacity = l.op * shown;
            const h = size(d);
            l.sprite.scale.set(h * l.sprite.userData.aspect, h, 1);
        }
    }

    window.Pois = {
        get on() { return on; },
        set on(v) {
            on = !!v;
            try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (err) { /* storage blocked */ }
        },
        wants: p => !!KINDS[p.class] && (!!p.name || !!GENERIC[p.class]),
        reset: () => { if (map.inner) for (const poi of [...labels.keys()]) drop(poi); chosen = new Set(); },
    };
    requestAnimationFrame(tick);
})();
