// Browser game screen: full map to search or choose where to start, minimap, road and town name, gear,
// back-to-road button, day/night/auto and engine sound
(() => {
    const RAD = Math.PI / 180;
    // Where the map opens: Rome
    const START = { lat: 41.9028, lon: 12.4964 };
    const CARD = 'background:rgba(14,18,24,.88);color:#fff;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.45);font:14px system-ui,sans-serif';
    const BTN = 'border:0;border-radius:10px;font:600 14px system-ui,sans-serif;cursor:pointer;padding:10px 16px;color:#fff';
    const tr = I18n.t;
    const MAP_CREDIT = '\u00a9 OpenStreetMap contributors \u00b7 \u00a9 OpenMapTiles \u00b7 OpenFreeMap';
    const CREDITS = MAP_CREDIT + ' \u00b7 ' + tr('credits');

    // Road look shared by the map and the minimap: OpenMapTiles class -> colour, width in px at zoom 14
    const ROAD = {
        motorway: ['#f29d38', 5], trunk: ['#f5c451', 4.5], primary: ['#f7e08a', 4], secondary: ['#ffffff', 3.4],
        tertiary: ['#e1e6ec', 3], minor: ['#b4bcc6', 2.2], service: ['#7f8995', 1.4]
    };
    const ROAD_ORDER = ['service', 'minor', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway'];
    const HIGHWAY_CLASS = { unclassified: 'minor', residential: 'minor', living_street: 'minor', road: 'minor' };
    const classOf = hw => { const k = hw.replace('_link', ''); return ROAD[k] ? k : HIGHWAY_CLASS[k] || 'service'; };

    const el = (tag, css, html) => {
        const e = document.createElement(tag);
        if (css) e.style.cssText = css;
        if (html != null) e.innerHTML = html;
        return e;
    };

    // ---- Web Mercator ----
    const world = (lat, lon) => {
        const r = lat * RAD;
        return [(lon + 180) / 360, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2];
    };
    const latLon = (wx, wy) => [Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) / RAD, wx * 360 - 180];

    // ================= Full map =================
    const TILE_PX = 512;
    const big = { open: false, cx: 0, cy: 0, zoom: 12, spawn: null, drag: null, dirty: true };
    const disp = new Map();

    function displayTile(z, x, y) {
        const key = `${z}/${x}/${y}`;
        let t = disp.get(key);
        if (!t) {
            t = { ready: false };
            disp.set(key, t);
            fetch(OsmOnline.tileUrl(z, x, y)).then(r => r.ok ? r.arrayBuffer() : new ArrayBuffer(0)).then(buf => {
                const layers = OsmOnline.decode(buf);
                for (const l of Object.values(layers)) for (const f of l.features) f.lines = OsmOnline.geometry(f.geom);
                Object.assign(t, { ready: true, layers });
                big.dirty = true;
            }).catch(() => disp.delete(key));
            if (disp.size > 400) disp.delete(disp.keys().next().value);
        }
        return t;
    }

    // A link that brings friends to about where the car is (to ~100 m), with the town in the message
    async function share() {
        const f = osmSim.free;
        const [lat, lon] = f.on ? (ll => [ll.lat, ll.lon])(OsmMatch.unproject(f.x, f.y)) : big.spawn || [START.lat, START.lon];
        const link = location.origin + location.pathname + '?at=' + lat.toFixed(3) + ',' + lon.toFixed(3);
        const place = f.on ? town.name : big.spawn ? big.town : '';
        const text = place ? tr('inviteTextAt', place) : tr('inviteText');
        if (navigator.share && touch) {
            try { await navigator.share({ title: 'OSM Drive', text, url: link }); return; } catch (err) { if (err && err.name === 'AbortError') return; }
        }
        try {
            await navigator.clipboard.writeText(text + ' ' + link);
            flash(tr('linkCopied'));
        } catch (err) {
            window.prompt(tr('invite'), text + ' ' + link);
        }
    }

    // Opened from a friend's link: the map there, the start ready on the nearest road
    function invited() {
        const q = new URLSearchParams(location.search), at = (q.get('at') || '').split(',').map(Number);
        if (at.length !== 2 || !(Math.abs(at[0]) <= 85 && Math.abs(at[1]) <= 180)) return false;
        jump(at[0], at[1]);
        big.zoom = 16;
        // Not again at the next reload
        q.delete('at');
        history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
        return true;
    }

    // The last place, for the map after a reload: the car while driving, else the start chosen
    const KEY_PLACE = 'osm-drive-place';
    // What the next start is: car or plane, a plane from a runway or in the air
    const KEY_VEHICLE = 'osm-drive-vehicle';
    const vehicle = { kind: 'car', air: false };
    try { Object.assign(vehicle, JSON.parse(localStorage.getItem(KEY_VEHICLE) || '{}')); } catch (err) { /* storage blocked */ }
    function saveVehicle() { try { localStorage.setItem(KEY_VEHICLE, JSON.stringify(vehicle)); } catch (err) { /* storage blocked */ } }
    let placeAt = 0;
    function savePlace([lat, lon]) {
        try { localStorage.setItem(KEY_PLACE, lat.toFixed(5) + ',' + lon.toFixed(5)); } catch (err) { /* storage blocked */ }
    }
    function carPlace(now) {
        const f = osmSim.free;
        if (!f.on || now - placeAt < 5000) return;
        placeAt = now;
        const ll = OsmMatch.unproject(f.x, f.y);
        savePlace([ll.lat, ll.lon]);
    }
    function lastPlace() {
        let at = [];
        try { at = (localStorage.getItem(KEY_PLACE) || '').split(',').map(Number); } catch (err) { /* storage blocked */ }
        if (at.length !== 2 || !(Math.abs(at[0]) <= 85 && Math.abs(at[1]) <= 180)) return false;
        jump(at[0], at[1]);
        big.zoom = 16;
        return true;
    }

    // The player's name, asked before the first drive online; false when closed without one
    function askName() {
        return new Promise(resolve => {
            const veil = el('div', 'position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center');
            const card = el('div', CARD + ';padding:18px;width:min(340px, calc(100% - 40px));box-sizing:border-box;display:flex;flex-direction:column;gap:10px');
            const input = el('input', 'width:100%;box-sizing:border-box;padding:11px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.18);'
                + 'background:rgba(255,255,255,.08);color:#fff;font:16px system-ui,sans-serif;outline:none');
            input.placeholder = tr('namePlaceholder');
            input.maxLength = 20;
            const go = el('button', BTN + ';background:#3e8bff', tr('letsGo'));
            const alone = el('button', 'background:transparent;border:0;color:#fff;opacity:.7;font:13px system-ui,sans-serif;cursor:pointer;padding:4px', tr('playAlone'));
            card.append(el('div', 'font-size:18px;font-weight:700', tr('yourName')), el('div', 'font-size:13px;opacity:.7', tr('nameHint')), input, go, alone);
            veil.appendChild(card);
            document.body.appendChild(veil);
            setTimeout(() => input.focus(), 50);
            const done = ok => { veil.remove(); resolve(ok); };
            go.onclick = () => {
                if (!input.value.trim()) { input.focus(); return; }
                Net.name = input.value;
                done(true);
            };
            alone.onclick = () => { Net.on = false; done(true); };
            input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') go.onclick(); if (e.key === 'Escape') done(false); });
        });
    }

    // Language menu; choosing reloads the page in the new language
    function languagePicker(css) {
        const row = el('label', 'display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:13px;opacity:.9;' + css);
        const sel = el('select', 'min-width:0;max-width:60%;background:#1b2028;color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:5px 6px;font:13px system-ui,sans-serif;cursor:pointer');
        for (const [code, label] of Object.entries(I18n.langs)) {
            const o = el('option', '', label);
            o.value = code;
            o.selected = code === I18n.lang;
            sel.appendChild(o);
        }
        sel.addEventListener('keydown', e => e.stopPropagation());
        sel.onchange = () => I18n.set(sel.value);
        row.append(el('span', '', tr('language')), sel);
        return row;
    }

    function buildBig() {
        big.box = el('div', 'position:fixed;inset:0;z-index:2000;background:#1b2028;display:none;cursor:grab;user-select:none');
        big.canvas = el('canvas', 'position:absolute;inset:0;width:100%;height:100%');
        big.box.appendChild(big.canvas);

        // Search, my position, language: folded into a button in the corner, opened when wanted, so the map has the room
        const side = el('div', CARD + ';position:absolute;left:20px;top:20px;width:min(360px, calc(100% - 100px));box-sizing:border-box;padding:14px;display:none');
        const head = el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px');
        const fold = el('button', 'background:transparent;border:0;color:#fff;font-size:20px;line-height:1;cursor:pointer;opacity:.75;padding:2px 6px', '\u2715');
        fold.title = fold.ariaLabel = tr('close');
        head.append(el('div', 'font-size:18px;font-weight:700', tr('whereFrom')), fold);
        side.appendChild(head);
        const searchBtn = el('button', CARD + ';position:absolute;left:20px;top:20px;width:44px;height:44px;border:0;cursor:pointer;display:flex;align-items:center;justify-content:center',
            '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>');
        searchBtn.title = searchBtn.ariaLabel = tr('searchPlaceholder');
        big.side = open => {
            side.style.display = open ? 'block' : 'none';
            searchBtn.style.display = open ? 'none' : 'flex';
            if (open && !touch) big.search.focus();
        };
        searchBtn.onclick = e => { e.stopPropagation(); searchBtn.blur(); big.side(true); };
        fold.onclick = e => { e.stopPropagation(); big.side(false); };
        // 16 px: on smaller text iPhones zoom the whole page into the field
        big.search = el('input', 'width:100%;box-sizing:border-box;padding:11px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.18);'
            + 'background:rgba(255,255,255,.08);color:#fff;font:16px system-ui,sans-serif;outline:none');
        big.search.placeholder = tr('searchPlaceholder');
        big.results = el('div', 'margin-top:6px;display:flex;flex-direction:column');
        const here = el('button', BTN + ';margin-top:10px;width:100%;background:rgba(255,255,255,.12)', tr('myPosition'));
        side.append(big.search, big.results, here, languagePicker('margin-top:8px'),
            el('div', 'margin-top:10px;opacity:.65;font-size:12px', tr(touch ? 'hintTouch' : 'hintMouse')));
        big.box.append(side, searchBtn);

        const zoom = el('div', 'position:absolute;right:20px;top:20px;display:flex;flex-direction:column;align-items:flex-end;gap:8px');
        for (const [label, d] of [['+', 1], ['\u2212', -1]]) {
            const b = el('button', CARD + ';width:44px;height:44px;border:0;font-size:24px;cursor:pointer', label);
            b.onclick = e => { e.stopPropagation(); zoomAt(big.canvas.clientWidth / 2, big.canvas.clientHeight / 2, d); };
            zoom.appendChild(b);
        }
        big.box.appendChild(zoom);

        big.bar = el('div', CARD + ';position:absolute;left:50%;bottom:34px;transform:translateX(-50%);padding:10px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;max-width:92%;box-sizing:border-box');
        big.msg = el('div', 'padding:0 8px;opacity:.9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', tr(touch ? 'pickTouch' : 'pickMouse'));
        big.go = el('button', BTN + ';background:#3e8bff', tr('startHere'));
        big.go.dataset.simStart = '';
        big.go.disabled = true;
        big.close = el('button', BTN + ';background:rgba(255,255,255,.12)', tr('closeKey'));
        big.nav = el('button', BTN + ';background:#1f8a4c;display:none', tr('navigateHere'));
        big.nav.disabled = true;
        big.bar.append(big.msg, big.nav, big.go, big.close);
        // Car or plane, a plane from a runway or already in the air: on a row of their own above the buttons
        const segment = (opts, get, set) => {
            const box = el('div', 'display:flex;background:rgba(255,255,255,.1);border-radius:9px;padding:2px');
            const bs = opts.map(([v, label]) => {
                const b = el('button', 'border:0;border-radius:7px;padding:6px 12px;color:#fff;font:13px system-ui,sans-serif;cursor:pointer;background:transparent;white-space:nowrap', label);
                b.onclick = e => { e.stopPropagation(); set(v); paintAll(); b.blur(); };
                box.appendChild(b);
                return [v, b];
            });
            box.paint = () => bs.forEach(([v, b]) => { b.style.background = get() === v ? '#3e8bff' : 'transparent'; });
            return box;
        };
        const kindSeg = segment([['car', tr('car')], ['plane', tr('plane')]], () => vehicle.kind, v => { vehicle.kind = v; saveVehicle(); });
        const airSeg = segment([[false, tr('fromRunway')], [true, tr('inAir')]], () => vehicle.air, v => { vehicle.air = v; saveVehicle(); });
        const paintAll = () => { kindSeg.paint(); airSeg.paint(); airSeg.style.display = vehicle.kind === 'plane' ? 'flex' : 'none'; };
        paintAll();
        big.bar.prepend(el('div', 'width:100%;display:flex;gap:8px;flex-wrap:wrap'));
        big.bar.firstChild.append(kindSeg, airSeg);
        big.box.appendChild(big.bar);
        // How many are playing, under the zoom buttons
        big.players = el('div', CARD + ';padding:6px 10px;font-size:12px;font-weight:600;display:none;pointer-events:none;white-space:nowrap;align-self:flex-end');
        zoom.appendChild(big.players);
        big.credits = el('div', 'position:absolute;right:10px;bottom:6px;font-size:11px;opacity:.6;color:#fff;pointer-events:none', CREDITS);
        big.box.appendChild(big.credits);
        document.body.appendChild(big.box);
        // Phones held sideways have little height: everything smaller, the bar in a corner
        if (innerHeight < 520) {
            side.style.cssText += ';padding:10px;width:min(300px, 44%);top:10px;left:10px';
            Object.assign(head.style, { marginBottom: '6px' });
            head.firstChild.style.fontSize = '15px';
            side.lastChild.style.display = 'none';
            Object.assign(searchBtn.style, { top: '10px', left: '10px' });
            here.style.marginTop = '6px';
            big.search.style.padding = '9px 10px';
            Object.assign(big.bar.style, { left: '', right: '10px', bottom: '22px', transform: 'none', maxWidth: '52%', padding: '8px', gap: '6px' });
            big.msg.style.cssText += ';width:100%;padding:0 4px;font-size:13px';
            for (const b of [big.nav, big.go, big.close]) Object.assign(b.style, { padding: '9px 12px', fontSize: '13px' });
            Object.assign(big.credits.style, { fontSize: '9px', left: '10px', right: '', maxWidth: '45%' });
            Object.assign(zoom.style, { top: '10px', right: '10px' });
        }

        big.close.onclick = () => closeMap();
        big.nav.onclick = () => {
            const f = osmSim.free;
            // A plane flies straight there: to a runway when the point is near one
            if (f.on && f.kind === 'plane' && big.spawn) {
                const p = OsmMatch.project(big.spawn[0], big.spawn[1]);
                Air.setNav(p.x, p.y, big.label || tr('destination'));
                stopNav();
                closeMap(true);
                return;
            }
            navigate(big.spawn, big.label);
        };
        big.go.onclick = async () => {
            Engine.start();
            if (Net.on && !Net.name && !await askName()) return;
            Fuel.fill();
            if (touch) fullscreen(true);
            closeMap(true);
            if (!await osmSim.startFree({ lat: big.spawn[0], lon: big.spawn[1] }, { vehicle: vehicle.kind, inAir: vehicle.air })) {
                openMap();
                big.msg.textContent = tr('noRoad300');
            }
            if (vehicle.kind === 'plane' && !touch) flash(tr('planeKeys'));
            // The sky of the new place straight away, not at the next minute's update
            applySky(performance.now());
            town.at = 0;
        };
        here.onclick = () => {
            big.msg.textContent = tr('locating');
            navigator.geolocation.getCurrentPosition(
                p => { big.side(false); jump(p.coords.latitude, p.coords.longitude, tr('yourPosition')); },
                () => { big.msg.textContent = tr('noPosition'); },
                { enableHighAccuracy: true, timeout: 10000 });
        };
        let searchTimer = 0, searchSeq = 0;
        big.search.addEventListener('keydown', e => e.stopPropagation());
        big.search.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(async () => {
                const q = big.search.value.trim(), seq = ++searchSeq;
                if (q.length < 3) { big.results.innerHTML = ''; return; }
                const [lat, lon] = latLon(big.cx, big.cy);
                try {
                    const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=${I18n.photon}&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`);
                    const feats = (await r.json()).features;
                    if (seq !== searchSeq) return;
                    big.results.innerHTML = '';
                    for (const f of feats) {
                        const p = f.properties, label = placeLabel(p);
                        const item = el('button', 'text-align:left;background:transparent;color:#fff;border:0;border-radius:8px;padding:9px 10px;cursor:pointer;'
                            + 'font:14px system-ui,sans-serif', `<div style="font-weight:600">${escapeHtml(label.main)}</div><div style="opacity:.65;font-size:12px">${escapeHtml(label.sub)}</div>`);
                        item.onmouseenter = () => { item.style.background = 'rgba(255,255,255,.1)'; };
                        item.onmouseleave = () => { item.style.background = 'transparent'; };
                        item.onclick = () => {
                            big.results.innerHTML = '';
                            big.search.value = label.main;
                            big.side(false);
                            jump(f.geometry.coordinates[1], f.geometry.coordinates[0], label.main + (label.sub ? ', ' + label.sub : ''));
                        };
                        big.results.appendChild(item);
                    }
                    if (!feats.length) big.results.innerHTML = `<div style="opacity:.6;padding:8px">${tr('noResults')}</div>`;
                } catch (err) {
                    big.results.innerHTML = `<div style="opacity:.6;padding:8px">${tr('searchDown')}</div>`;
                }
            }, 350);
        });

        const at = e => { const r = big.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
        big.canvas.addEventListener('wheel', e => {
            e.preventDefault();
            // Firefox counts lines, not pixels
            const dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1), p = at(e);
            zoomAt(p.x, p.y, Math.max(-1, Math.min(1, -dy * 0.003)));
        }, { passive: false });
        // Mouse, touch and pen alike: one pointer drags; two pinch, and the place between the fingers stays under them
        // as they zoom and move; a tap without moving picks the point
        const pointers = new Map();
        big.box.style.touchAction = 'none';
        big.canvas.style.touchAction = 'none';
        // Starts over from the fingers down now: lifting one of two carries on dragging without a jump
        const begin = () => {
            const [a, b] = pointers.values();
            big.pinch = big.drag = null;
            if (b) {
                const W = big.canvas.clientWidth, H = big.canvas.clientHeight, s = TILE_PX * 2 ** big.zoom;
                const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
                big.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: big.zoom, wx: big.cx + (mx - W / 2) / s, wy: big.cy + (my - H / 2) / s };
            } else if (a) {
                big.drag = { x: a.x, y: a.y, cx: big.cx, cy: big.cy };
            }
        };
        big.canvas.addEventListener('pointerdown', e => {
            big.canvas.setPointerCapture(e.pointerId);
            const p = at(e);
            if (!pointers.size) big.tap = { x: p.x, y: p.y, ok: true };
            else if (big.tap) big.tap.ok = false;
            pointers.set(e.pointerId, p);
            begin();
            big.box.style.cursor = 'grabbing';
        });
        big.canvas.addEventListener('pointermove', e => {
            if (!pointers.has(e.pointerId)) return;
            const p = at(e);
            pointers.set(e.pointerId, p);
            if (big.tap && Math.hypot(p.x - big.tap.x, p.y - big.tap.y) > 6) big.tap.ok = false;
            const W = big.canvas.clientWidth, H = big.canvas.clientHeight;
            if (big.pinch) {
                const [a, b] = pointers.values(), pc = big.pinch;
                big.zoom = Math.min(19, Math.max(5, pc.zoom + Math.log2(Math.hypot(a.x - b.x, a.y - b.y) / pc.d)));
                const s = TILE_PX * 2 ** big.zoom;
                big.cx = pc.wx - ((a.x + b.x) / 2 - W / 2) / s;
                big.cy = pc.wy - ((a.y + b.y) / 2 - H / 2) / s;
            } else if (big.drag) {
                const d = big.drag, s = TILE_PX * 2 ** big.zoom;
                big.cx = d.cx - (p.x - d.x) / s;
                big.cy = d.cy - (p.y - d.y) / s;
            } else {
                return;
            }
            big.dirty = true;
        });
        const release = e => {
            if (!pointers.has(e.pointerId)) return;
            pointers.delete(e.pointerId);
            if (pointers.size) { begin(); return; }
            big.drag = big.pinch = null;
            big.box.style.cursor = 'grab';
            const tap = big.tap;
            big.tap = null;
            if (!tap || !tap.ok || e.type === 'pointercancel') return;
            // A player or a group of players first: near that player, or closer in on the group
            const q = at(e), hit = (big.hits || []).filter(h => Math.hypot(h.x - q.x, h.y - q.y) < h.r).sort((a, b) => Math.hypot(a.x - q.x, a.y - q.y) - Math.hypot(b.x - q.x, b.y - q.y))[0];
            if (hit && hit.group) { zoomAt(hit.x, hit.y, 2.5); return; }
            if (hit && hit.p) {
                jump(hit.p.lat, hit.p.lon, tr('nearPlayer', hit.p.name || 'Pilota'));
                big.zoom = Math.max(big.zoom, 15);
                if (osmSim.free.on) big.go.textContent = tr('join');
                return;
            }
            // Only roads can be picked: the point moves onto the nearest one in reach
            const p = snapToRoad(q.x, q.y);
            if (!p) {
                big.msg.textContent = tr(touch ? 'tapRoad' : 'clickRoad');
                return;
            }
            const scale = TILE_PX * 2 ** big.zoom, W = big.canvas.clientWidth, H = big.canvas.clientHeight;
            setSpawn(latLon(big.cx + (p[0] - W / 2) / scale, big.cy + (p[1] - H / 2) / scale), null);
        };
        big.canvas.addEventListener('pointerup', release);
        big.canvas.addEventListener('pointercancel', release);
        // Safari zooms the whole page on a pinch whatever the viewport says; the map and the car do their own
        for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, e => e.preventDefault(), { passive: false });
    }

    // Nearest point on a drawn road within 40 px of (sx, sy), in screen pixels
    function snapToRoad(sx, sy) {
        const v = big.view;
        if (!v) return null;
        let best = null, bd = 40;
        for (const { x, y, t } of v.tiles) {
            const l = t.ready && t.layers.transportation;
            if (!l) continue;
            const P = tileProjector(x, y, v.z, l.extent, v.scale, v.W, v.H);
            for (const f of l.features) {
                if (f.type !== 2 || !ROAD[f.props.class]) continue;
                for (const line of f.lines) {
                    for (let i = 0; i < line.length - 1; i++) {
                        const a = P(line[i]), b = P(line[i + 1]), dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1e-9;
                        const t2 = Math.max(0, Math.min(1, ((sx - a[0]) * dx + (sy - a[1]) * dy) / l2));
                        const px = a[0] + dx * t2, py = a[1] + dy * t2, d = Math.hypot(sx - px, sy - py);
                        if (d < bd) { bd = d; best = [px, py]; }
                    }
                }
            }
        }
        return best;
    }

    const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    function placeLabel(p) {
        const street = p.street ? p.street + (p.housenumber ? ' ' + p.housenumber : '') : '';
        const main = p.name || street || p.city || '';
        const sub = [p.name && street, p.city !== main && p.city, p.state].filter(Boolean).join(', ');
        return { main, sub };
    }

    async function setSpawn(ll, label) {
        big.spawn = ll;
        if (!osmSim.free.on) savePlace(ll);
        big.label = label || '';
        big.go.disabled = big.nav.disabled = false;
        big.dirty = true;
        big.msg.textContent = label || tr('pointChosen');
        // The town too, for an invite from here
        big.town = '';
        const p = await reverse(ll[0], ll[1]);
        if (!p || big.spawn !== ll) return;
        big.town = townOf(p);
        if (!label) big.msg.textContent = big.label = [p.street || p.name, p.city].filter(Boolean).join(', ');
    }

    function jump(lat, lon, label) {
        [big.cx, big.cy] = world(lat, lon);
        big.zoom = 16.5;
        setSpawn([lat, lon], label);
    }

    function zoomAt(sx, sy, d) {
        const W = big.canvas.clientWidth, H = big.canvas.clientHeight;
        const s0 = TILE_PX * 2 ** big.zoom, wx = big.cx + (sx - W / 2) / s0, wy = big.cy + (sy - H / 2) / s0;
        big.zoom = Math.min(19, Math.max(5, big.zoom + d));
        const s1 = TILE_PX * 2 ** big.zoom;
        big.cx = wx - (sx - W / 2) / s1;
        big.cy = wy - (sy - H / 2) / s1;
        big.dirty = true;
    }

    function drawBig() {
        const c = big.canvas, dpr = devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
        if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; }
        const g = c.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.fillStyle = '#1b2028';
        g.fillRect(0, 0, W, H);
        const scale = TILE_PX * 2 ** big.zoom, z = Math.min(14, Math.max(0, Math.floor(big.zoom))), n = 2 ** z;
        const x0 = Math.floor((big.cx - W / 2 / scale) * n), x1 = Math.floor((big.cx + W / 2 / scale) * n);
        const y0 = Math.floor((big.cy - H / 2 / scale) * n), y1 = Math.floor((big.cy + H / 2 / scale) * n);
        const tiles = [];
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) if (y >= 0 && y < n) tiles.push({ x, y, t: displayTile(z, ((x % n) + n) % n, y) });
        // Line widths grow with zoom past 14, shrink below
        const k = Math.min(3, Math.max(0.35, 2 ** ((big.zoom - 14) * 0.6)));
        const passes = [
            { layer: 'landuse', fill: f => ['residential', 'commercial', 'retail', 'industrial'].includes(f.props.class) ? '#262d37' : null },
            { layer: 'landcover', fill: f => ['wood', 'forest'].includes(f.props.class) ? '#1c2a21' : f.props.class === 'grass' ? '#1e2822' : null },
            { layer: 'park', fill: () => '#1c2a21' },
            { layer: 'water', fill: () => '#1f4a6e' },
            { layer: 'building', fill: () => big.zoom >= 15 ? '#363e4a' : null },
        ];
        for (const pass of passes) {
            for (const { x, y, t } of tiles) {
                const l = t.ready && t.layers[pass.layer];
                if (!l) continue;
                const P = tileProjector(x, y, z, l.extent, scale, W, H);
                for (const f of l.features) {
                    if (f.type !== 3) continue;
                    const color = pass.fill(f);
                    if (!color) continue;
                    g.fillStyle = color;
                    g.beginPath();
                    for (const ring of f.lines) ring.forEach((p, i) => { const [sx, sy] = P(p); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); });
                    g.fill('evenodd');
                }
            }
        }
        // Roads: casings of all, then fills, minor under major
        g.lineCap = g.lineJoin = 'round';
        for (const casing of [true, false]) {
            for (const cls of ROAD_ORDER) {
                const [color, w] = ROAD[cls];
                g.strokeStyle = casing ? '#0e1116' : color;
                g.lineWidth = w * k + (casing ? 2.2 : 0);
                g.beginPath();
                for (const { x, y, t } of tiles) {
                    const l = t.ready && t.layers.transportation;
                    if (!l) continue;
                    const P = tileProjector(x, y, z, l.extent, scale, W, H);
                    for (const f of l.features) {
                        if (f.type !== 2 || f.props.class !== cls) continue;
                        for (const line of f.lines) line.forEach((p, i) => { const [sx, sy] = P(p); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); });
                    }
                }
                g.stroke();
            }
        }
        // Airports: aprons, then runways and taxiways at their real width (never thinner than a line), runways light
        const mPerPx = 40075016 * Math.cos(latLon(big.cx, big.cy)[0] * RAD) / scale;
        for (const { x, y, t } of tiles) {
            const l = t.ready && t.layers.aeroway;
            if (!l) continue;
            const P = tileProjector(x, y, z, l.extent, scale, W, H);
            for (const f of l.features) {
                if (f.type !== 3 || !['apron', 'runway', 'taxiway'].includes(f.props.class)) continue;
                g.fillStyle = f.props.class === 'runway' ? '#c9d1db' : '#3a424e';
                g.beginPath();
                for (const ring of f.lines) ring.forEach((p, i) => { const [sx, sy] = P(p); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); });
                g.fill('evenodd');
            }
            for (const cls of ['taxiway', 'runway']) {
                g.strokeStyle = cls === 'runway' ? '#c9d1db' : '#6c7684';
                g.lineWidth = Math.max(cls === 'runway' ? 3 : 1.5, (cls === 'runway' ? 40 : 14) / mPerPx);
                g.lineCap = 'butt';
                g.beginPath();
                for (const f of l.features) {
                    if (f.type !== 2 || f.props.class !== cls) continue;
                    for (const line of f.lines) line.forEach((p, i) => { const [sx, sy] = P(p); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); });
                }
                g.stroke();
                g.lineCap = 'round';
            }
        }
        // Labels: street names when close, places always
        const taken = [];
        const free = (x, y, w, h) => {
            if (taken.some(r => x < r[0] + r[2] && x + w > r[0] && y < r[1] + r[3] && y + h > r[1])) return false;
            taken.push([x, y, w, h]);
            return true;
        };
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        // Airports: their name beside a small plane
        for (const { x, y, t } of tiles) {
            const l = t.ready && t.layers.aerodrome_label;
            if (!l) continue;
            const P = tileProjector(x, y, z, l.extent, scale, W, H);
            for (const f of l.features) {
                const name = I18n.name(f.props) || f.props.icao;
                if (!name || f.type !== 1) continue;
                const [sx, sy] = P(f.lines[0][0]);
                g.font = '700 13px system-ui,sans-serif';
                const w = g.measureText(name).width;
                if (!free(sx - 10, sy - 10, w + 26, 20)) continue;
                planeGlyph(g, sx, sy, 8, '#c9d1db');
                g.textAlign = 'left';
                halo(g, name, sx + 12, sy, '#c9d1db');
                g.textAlign = 'center';
            }
        }
        for (const { x, y, t } of tiles) {
            const l = t.ready && t.layers.place;
            if (!l) continue;
            const P = tileProjector(x, y, z, l.extent, scale, W, H);
            for (const f of l.features) {
                const name = I18n.name(f.props), cls = f.props.class;
                if (!name || f.type !== 1) continue;
                const size = { city: 18, town: 16, village: 14, suburb: 13, hamlet: 12, quarter: 12, neighbourhood: 11 }[cls];
                if (!size) continue;
                const [sx, sy] = P(f.lines[0][0]);
                g.font = `${cls === 'city' || cls === 'town' ? 700 : 600} ${size}px system-ui,sans-serif`;
                const w = g.measureText(name).width;
                if (!free(sx - w / 2 - 4, sy - size / 2 - 2, w + 8, size + 4)) continue;
                halo(g, name, sx, sy);
            }
        }
        if (big.zoom >= 14.5) {
            for (const { x, y, t } of tiles) {
                const l = t.ready && t.layers.transportation_name;
                if (!l) continue;
                const P = tileProjector(x, y, z, l.extent, scale, W, H);
                for (const f of l.features) {
                    const name = I18n.name(f.props) || f.props.ref;
                    if (!name || f.type !== 2) continue;
                    for (const line of f.lines) {
                        // On the line's longest stretch, upright
                        let best = null;
                        for (let i = 0; i < line.length - 1; i++) {
                            const a = P(line[i]), b = P(line[i + 1]), len = Math.hypot(b[0] - a[0], b[1] - a[1]);
                            if (!best || len > best.len) best = { a, b, len };
                        }
                        g.font = '600 12px system-ui,sans-serif';
                        const w = g.measureText(name).width;
                        if (!best || best.len < w + 10) continue;
                        const mx = (best.a[0] + best.b[0]) / 2, my = (best.a[1] + best.b[1]) / 2;
                        let ang = Math.atan2(best.b[1] - best.a[1], best.b[0] - best.a[0]);
                        if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
                        if (!free(mx - w / 2, my - 8, w, 16)) continue;
                        g.save();
                        g.translate(mx, my);
                        g.rotate(ang);
                        halo(g, name, 0, 0, '#d9dee5');
                        g.restore();
                    }
                }
            }
        }

        // Points of interest when close: a coloured dot by kind, the name when closer still
        if (big.zoom >= 15) {
            const POI = {
                fuel: '#ff9f1a', restaurant: '#e86aa6', fast_food: '#e86aa6', cafe: '#e86aa6', bar: '#e86aa6', pub: '#e86aa6', ice_cream: '#e86aa6',
                shop: '#9b7bff', grocery: '#9b7bff', clothing_store: '#9b7bff', bakery: '#9b7bff',
                hospital: '#ff5a4f', pharmacy: '#3ccf7a', doctors: '#ff5a4f', parking: '#3e8bff', bus: '#3e8bff', railway: '#3e8bff',
                school: '#d9b44a', college: '#d9b44a', place_of_worship: '#bfa58a', town_hall: '#bfa58a', police: '#3e8bff', bank: '#7aa2c7',
                lodging: '#7aa2c7', museum: '#bfa58a', attraction: '#bfa58a', park: '#3ccf7a'
            };
            g.font = '600 11px system-ui,sans-serif';
            g.textAlign = 'left';
            g.textBaseline = 'middle';
            for (const { x, y, t } of tiles) {
                const l = t.ready && t.layers.poi;
                if (!l) continue;
                const P = tileProjector(x, y, z, l.extent, scale, W, H);
                for (const f of l.features) {
                    const color = POI[f.props.class];
                    if (f.type !== 1 || !color || (f.props.rank > 20 && big.zoom < 17)) continue;
                    const [sx, sy] = P(f.lines[0][0]);
                    if (sx < -20 || sy < -20 || sx > W + 20 || sy > H + 20) continue;
                    g.fillStyle = color;
                    g.strokeStyle = '#0e1116';
                    g.lineWidth = 2;
                    g.beginPath();
                    g.arc(sx, sy, 5, 0, 7);
                    g.fill();
                    g.stroke();
                    const name = I18n.name(f.props);
                    if (name && big.zoom >= 16.5) {
                        const w = g.measureText(name).width;
                        if (free(sx + 8, sy - 7, w, 14)) halo(g, name, sx + 8, sy, '#e8ecf1');
                    }
                }
            }
        }

        const toScreen = (lat, lon) => { const [wx, wy] = world(lat, lon); return [W / 2 + (wx - big.cx) * scale, H / 2 + (wy - big.cy) * scale]; };
        // Toll booths when close
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        if (big.zoom >= 12) {
            for (const tb of OsmOnline.tolls) {
                const [sx, sy] = toScreen(tb.lat, tb.lon);
                if (sx < -20 || sy < -20 || sx > W + 20 || sy > H + 20) continue;
                g.fillStyle = '#1f8a4c';
                g.fillRect(sx - 9, sy - 9, 18, 18);
                g.fillStyle = '#fff';
                g.font = '700 11px system-ui,sans-serif';
                g.fillText('\u20ac', sx, sy + 0.5);
            }
        }
        // Other players, for the view shown: groups with how many far out, each one with its name and heading close up.
        // What is drawn is remembered for a tap
        const [vn, vw] = latLon(big.cx - W / 2 / scale, big.cy - H / 2 / scale), [vs, ve] = latLon(big.cx + W / 2 / scale, big.cy + H / 2 / scale);
        Net.mapView([vs, vw, vn, ve], big.zoom);
        const items = Net.mapItems();
        big.hits = [];
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        for (const c of items.c) {
            const [sx, sy] = toScreen(c.lat, c.lon);
            if (sx < -30 || sy < -30 || sx > W + 30 || sy > H + 30) continue;
            if (c.n === 1 && c.id) {
                g.fillStyle = c.colour;
                g.strokeStyle = '#0e1116';
                g.lineWidth = 2;
                g.beginPath();
                g.arc(sx, sy, 6, 0, 7);
                g.fill();
                g.stroke();
                big.hits.push({ x: sx, y: sy, r: 14, p: c });
                continue;
            }
            const r = 11 + 4 * Math.log2(c.n);
            g.fillStyle = 'rgba(62,139,255,.85)';
            g.strokeStyle = 'rgba(255,255,255,.9)';
            g.lineWidth = 2;
            g.beginPath();
            g.arc(sx, sy, r, 0, 7);
            g.fill();
            g.stroke();
            g.fillStyle = '#fff';
            g.font = `700 ${c.n > 99 ? 11 : 13}px system-ui,sans-serif`;
            g.fillText(String(c.n), sx, sy + 0.5);
            big.hits.push({ x: sx, y: sy, r: r + 4, group: c });
        }
        // Arrows first, then the names over them; a name that would cover a label already written is left out (the
        // arrow stays, and a tap tells who)
        const shown = items.p.map(p => [p, ...toScreen(p.lat, p.lon)]).filter(([, sx, sy]) => sx > -30 && sy > -30 && sx < W + 30 && sy < H + 30);
        for (const [p, sx, sy] of shown) {
            g.save();
            g.translate(sx, sy);
            g.rotate(p.b * RAD);
            g.beginPath();
            g.moveTo(0, -11);
            g.lineTo(7, 7);
            g.lineTo(0, 3);
            g.lineTo(-7, 7);
            g.closePath();
            g.fillStyle = p.colour;
            g.strokeStyle = '#0e1116';
            g.lineWidth = 2;
            g.fill();
            g.stroke();
            g.restore();
            big.hits.push({ x: sx, y: sy, r: 16, p });
        }
        g.font = '600 12px system-ui,sans-serif';
        g.textAlign = 'left';
        for (const [p, sx, sy] of shown) if (free(sx + 11, sy - 8, g.measureText(p.name).width, 16)) halo(g, p.name, sx + 11, sy, '#fff');
        g.textAlign = 'center';
        if (items.moving) big.dirty = true;
        if (big.players) {
            const t = Net.on && Net.status === 'on' ? tr('playing', Net.total) : '';
            if (big.players.textContent !== t) big.players.textContent = t;
            big.players.style.display = t ? 'block' : 'none';
        }
        if (nav.on) {
            g.strokeStyle = '#3e8bff';
            g.lineWidth = 6;
            g.beginPath();
            // Only what is still ahead, from the car's place on the route
            const ahead = [nav.cur, ...nav.pts.slice(nav.cur.i + 1)];
            ahead.forEach((p, i) => { const q = OsmMatch.unproject(p.x, p.y), [sx, sy] = toScreen(q.lat, q.lon); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); });
            g.stroke();
            const [dx, dy] = toScreen(nav.dest[0], nav.dest[1]);
            g.fillStyle = '#1f8a4c';
            g.beginPath();
            g.arc(dx, dy, 9, 0, 7);
            g.fill();
        }
        const f = osmSim.free, an = f.on && f.kind === 'plane' && Air.nav();
        // A plane's destination: a dashed straight line to it
        if (an) {
            const a = OsmMatch.unproject(f.x, f.y), b = OsmMatch.unproject(an.x, an.y), [ax, ay] = toScreen(a.lat, a.lon), [bx, by] = toScreen(b.lat, b.lon);
            g.strokeStyle = '#3e8bff';
            g.lineWidth = 4;
            g.setLineDash([10, 8]);
            g.beginPath();
            g.moveTo(ax, ay);
            g.lineTo(bx, by);
            g.stroke();
            g.setLineDash([]);
            g.fillStyle = '#1f8a4c';
            g.beginPath();
            g.arc(bx, by, 9, 0, 7);
            g.fill();
        }
        if (f.on) {
            const ll = OsmMatch.unproject(f.x, f.y), [sx, sy] = toScreen(ll.lat, ll.lon);
            if (f.kind === 'plane') planeGlyph(g, sx, sy, 13, '#3e8bff', f.brg * RAD);
            else arrow(g, sx, sy, f.brg * RAD, 1.2);
        }
        if (big.spawn) {
            const [sx, sy] = toScreen(big.spawn[0], big.spawn[1]);
            g.fillStyle = '#ff5a4f';
            g.strokeStyle = '#fff';
            g.lineWidth = 3;
            g.beginPath();
            g.arc(sx, sy - 24, 11, Math.PI * 0.85, Math.PI * 0.15);
            g.lineTo(sx, sy);
            g.closePath();
            g.fill();
            g.stroke();
            g.fillStyle = '#fff';
            g.beginPath();
            g.arc(sx, sy - 24, 4, 0, 7);
            g.fill();
        }
        // Scale bar
        const mpp = 40075016.7 * Math.cos(latLon(big.cx, big.cy)[0] * RAD) / scale;
        const step = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000].find(s => s / mpp >= 60) || 100000;
        g.fillStyle = '#fff';
        g.fillRect(24, H - 34, step / mpp, 4);
        g.font = '12px system-ui,sans-serif';
        g.textAlign = 'left';
        g.fillText(step >= 1000 ? step / 1000 + ' km' : step + ' m', 24, H - 46);
        big.view = { tiles, z, scale, W, H };
        big.dirty = disp.size && [...tiles].some(t => !t.t.ready);
    }

    const tileProjector = (x, y, z, E, scale, W, H) => {
        const n = 2 ** z, ox = W / 2 + (x / n - big.cx) * scale, oy = H / 2 + (y / n - big.cy) * scale, k = scale / n / E;
        return p => [ox + p[0] * k, oy + p[1] * k];
    };

    function halo(g, text, x, y, color = '#fff') {
        g.lineWidth = 3.5;
        g.strokeStyle = 'rgba(14,17,22,.9)';
        g.strokeText(text, x, y);
        g.fillStyle = color;
        g.fillText(text, x, y);
    }

    // A small plane seen from above, nose up (or along `angle`): airports on the maps, the plane on the minimap
    function planeGlyph(g, x, y, r, color, angle = 0) {
        g.save();
        g.translate(x, y);
        g.rotate(angle);
        g.beginPath();
        g.moveTo(0, -r);
        g.lineTo(r * 0.16, -r * 0.55);
        g.lineTo(r * 0.16, -r * 0.2);
        g.lineTo(r, r * 0.05);
        g.lineTo(r, r * 0.25);
        g.lineTo(r * 0.16, r * 0.1);
        g.lineTo(r * 0.12, r * 0.65);
        g.lineTo(r * 0.45, r * 0.85);
        g.lineTo(r * 0.45, r);
        g.lineTo(0, r * 0.9);
        g.lineTo(-r * 0.45, r);
        g.lineTo(-r * 0.45, r * 0.85);
        g.lineTo(-r * 0.12, r * 0.65);
        g.lineTo(-r * 0.16, r * 0.1);
        g.lineTo(-r, r * 0.25);
        g.lineTo(-r, r * 0.05);
        g.lineTo(-r * 0.16, -r * 0.2);
        g.lineTo(-r * 0.16, -r * 0.55);
        g.closePath();
        g.lineWidth = 3;
        g.strokeStyle = 'rgba(14,17,22,.9)';
        g.stroke();
        g.fillStyle = color;
        g.fill();
        g.restore();
    }

    function arrow(g, x, y, angle, s = 1) {
        g.save();
        g.translate(x, y);
        g.rotate(angle);
        g.scale(s, s);
        g.beginPath();
        g.moveTo(0, -11);
        g.lineTo(8, 9);
        g.lineTo(0, 5);
        g.lineTo(-8, 9);
        g.closePath();
        g.fillStyle = '#3e8bff';
        g.strokeStyle = '#fff';
        g.lineWidth = 2;
        g.fill();
        g.stroke();
        g.restore();
    }

    function openMap() {
        const f = osmSim.free;
        if (f.on) {
            const ll = OsmMatch.unproject(f.x, f.y);
            [big.cx, big.cy] = world(ll.lat, ll.lon);
            big.zoom = Math.max(big.zoom, 15);
        }
        big.open = true;
        big.dirty = true;
        Net.mapOpen = true;
        big.box.style.display = 'block';
        big.close.style.display = f.on ? '' : 'none';
        // Before a drive there is one thing to do; while driving, going somewhere comes first and starting over second
        big.nav.style.display = f.on ? '' : 'none';
        big.go.textContent = tr(f.on ? 'restartHere' : 'startHere');
        big.go.style.background = f.on ? 'rgba(255,255,255,.12)' : '#3e8bff';
        // Keys go to the map while it is open, not to the car
        f.paused = true;
        f.keys.clear();
    }

    // Without a drive there is nothing behind the map: it stays until a start is chosen
    function closeMap(force) {
        if (!osmSim.free.on && !force) return;
        big.open = false;
        Net.mapOpen = false;
        big.box.style.display = 'none';
        osmSim.free.paused = false;
    }

    // ================= Minimap: heading up, from the roads loaded for the drive =================
    const mini = { mpp: 2, at: 0 };
    function buildMini() {
        const size = 210, dpr = devicePixelRatio || 1;
        mini.box = el('div', `position:fixed;left:16px;bottom:16px;width:${size}px;height:${size}px;border-radius:50%;overflow:hidden;z-index:400;`
            + 'border:3px solid rgba(255,255,255,.25);box-shadow:0 6px 24px rgba(0,0,0,.45);cursor:pointer;background:#1b2028;display:none');
        mini.canvas = el('canvas', `width:${size}px;height:${size}px`);
        mini.canvas.width = mini.canvas.height = size * dpr;
        mini.box.appendChild(mini.canvas);
        document.body.appendChild(mini.box);
        mini.zoom = el('div', `position:fixed;left:${size + 26}px;bottom:20px;z-index:400;display:none;flex-direction:column;gap:6px`);
        for (const [label, f] of [['+', 1 / 1.5], ['\u2212', 1.5]]) {
            const b = el('button', CARD + ';width:34px;height:34px;border:0;font-size:20px;cursor:pointer', label);
            b.onclick = () => { mini.mpp = Math.min(12, Math.max(0.5, mini.mpp * f)); b.blur(); };
            mini.zoom.appendChild(b);
        }
        document.body.appendChild(mini.zoom);
        mini.box.addEventListener('wheel', e => {
            e.preventDefault();
            mini.mpp = Math.min(12, Math.max(0.5, mini.mpp * Math.exp(e.deltaY * 0.0015)));
        }, { passive: false });
        mini.box.onclick = () => openMap();
    }

    function drawMini() {
        const f = osmSim.free, c = mini.canvas, g = c.getContext('2d'), W = c.width, R = W / 2, dpr = devicePixelRatio || 1;
        mini.box.style.display = f.on ? 'block' : 'none';
        mini.zoom.style.display = f.on ? 'flex' : 'none';
        if (!f.on) return;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.fillStyle = '#1b2028';
        g.fillRect(0, 0, W, W);
        // In the air it shows kilometres, more the higher the plane; the zoom buttons scale that
        const mpp = f.kind === 'plane' ? Math.min(80, Math.max(2, (4 + (Air.agl || 0) / 10) * mini.mpp / 2)) : mini.mpp;
        const b = f.brg * RAD, cos = Math.cos(b), sin = Math.sin(b), s = dpr / mpp;
        // Heading up: the direction of travel maps to the top of the circle
        const P = (px, py) => {
            const dx = (px - f.x) * s, dy = (py - f.y) * s;
            return [R + dx * cos - dy * sin, R - (dx * sin + dy * cos)];
        };
        if (f.kind === 'plane') { drawMiniPlane(g, f, P, R, s, dpr); return; }
        const edges = OsmMatch.edgesNear(f.x, f.y, R / s * 1.42), k = dpr * Math.min(1.8, Math.max(0.5, 2.2 / mpp));
        g.lineCap = g.lineJoin = 'round';
        for (const casing of [true, false]) {
            for (const cls of ROAD_ORDER) {
                const [color, w] = ROAD[cls];
                g.strokeStyle = casing ? '#0e1116' : color;
                g.lineWidth = w * k + (casing ? 2.2 * dpr : 0);
                g.beginPath();
                for (const e of edges) {
                    if (classOf(e.tags.highway) !== cls) continue;
                    const a = P(e.ax, e.ay), bb = P(e.bx, e.by);
                    g.moveTo(a[0], a[1]);
                    g.lineTo(bb[0], bb[1]);
                }
                g.stroke();
            }
        }
        // Other players near: dots in their colour
        for (const p of Net.players()) {
            if (!p.near) continue;
            const [x, y] = P(p.x, p.y);
            if (Math.hypot(x - R, y - R) > R - 6 * dpr) continue;
            g.fillStyle = p.colour;
            g.strokeStyle = '#0e1116';
            g.lineWidth = 2 * dpr;
            g.beginPath();
            g.arc(x, y, 5 * dpr, 0, 7);
            g.fill();
            g.stroke();
        }
        // Fuel stations: orange squares
        if (Fuel.on) {
            g.fillStyle = '#ff9f1a';
            for (const { st } of Fuel.near(f.x, f.y, R / s * 1.42)) {
                const [x, y] = P(st.x, st.y);
                if (Math.hypot(x - R, y - R) < R - 6 * dpr) g.fillRect(x - 4 * dpr, y - 4 * dpr, 8 * dpr, 8 * dpr);
            }
        }
        if (nav.on) {
            g.strokeStyle = 'rgba(62,139,255,.9)';
            g.lineWidth = 5 * dpr;
            g.beginPath();
            [nav.cur, ...nav.pts.slice(nav.cur.i + 1)].forEach((p, i) => { const [x, y] = P(p.x, p.y); i ? g.lineTo(x, y) : g.moveTo(x, y); });
            g.stroke();
        }
        arrow(g, R, R, 0, dpr);
        miniNorth(g, R, sin, cos, dpr);
    }

    // The north marker on the minimap's rim
    function miniNorth(g, R, sin, cos, dpr) {
        const nr = R - 14 * dpr, nx = R - sin * nr, ny = R - cos * nr;
        g.fillStyle = 'rgba(14,18,24,.92)';
        g.beginPath();
        g.arc(nx, ny, 10 * dpr, 0, 7);
        g.fill();
        g.fillStyle = '#ff5a4f';
        g.font = `700 ${12 * dpr}px system-ui,sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText('N', nx, ny + dpr);
    }

    // The minimap in a plane: the big roads only, runways, towns and peaks by name, other players, and the line to
    // where it is flying
    function drawMiniPlane(g, f, P, R, s, dpr) {
        const reach = R / s * 1.42, inCircle = (x, y, m = 6) => Math.hypot(x - R, y - R) < R - m * dpr;
        g.lineCap = g.lineJoin = 'round';
        const edges = OsmMatch.edgesNear(f.x, f.y, Math.min(reach, 3000));
        for (const cls of ['secondary', 'primary', 'trunk', 'motorway']) {
            const [color, w] = ROAD[cls];
            g.strokeStyle = color;
            g.globalAlpha = 0.55;
            g.lineWidth = Math.max(1, w * 0.45) * dpr;
            g.beginPath();
            for (const e of edges) {
                if (classOf(e.tags.highway) !== cls) continue;
                const a = P(e.ax, e.ay), b = P(e.bx, e.by);
                g.moveTo(a[0], a[1]);
                g.lineTo(b[0], b[1]);
            }
            g.stroke();
        }
        g.globalAlpha = 1;
        // Runways at their width, never thinner than a few pixels
        g.lineCap = 'butt';
        for (const r of Air.runwaysNear(f.x, f.y, reach)) {
            const a = P(r.a.x, r.a.y), b = P(r.b.x, r.b.y);
            g.strokeStyle = '#0e1116';
            g.lineWidth = Math.max(4 * dpr, r.w * s) + 3 * dpr;
            g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
            g.strokeStyle = '#e8edf3';
            g.lineWidth = Math.max(4 * dpr, r.w * s);
            g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
        }
        g.lineCap = 'round';
        // Towns and peaks, biggest first, kept apart
        const taken = [], order = { city: 0, town: 1, peak: 2, village: 3, hamlet: 4 };
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        for (const p of Air.placesNear(f.x, f.y, reach).sort((a, b) => order[a.cls] - order[b.cls])) {
            if (p.cls === 'hamlet' || (p.cls === 'village' && s < dpr / 12)) continue;
            const [x, y] = P(p.x, p.y);
            if (!inCircle(x, y, 18)) continue;
            const size = (p.cls === 'city' ? 13 : p.cls === 'town' ? 12 : 10.5) * dpr;
            g.font = `${p.cls === 'city' || p.cls === 'town' ? 700 : 600} ${size}px system-ui,sans-serif`;
            const w = g.measureText(p.name).width + (p.cls === 'peak' ? 12 * dpr : 0);
            const box = [x - w / 2, y - size, w, size * 2];
            if (taken.some(r => box[0] < r[0] + r[2] && box[0] + box[2] > r[0] && box[1] < r[1] + r[3] && box[1] + box[3] > r[1])) continue;
            taken.push(box);
            if (p.cls === 'peak') {
                g.fillStyle = '#c9a26b';
                g.beginPath();
                g.moveTo(x - w / 2, y + 4 * dpr); g.lineTo(x - w / 2 + 4.5 * dpr, y - 4 * dpr); g.lineTo(x - w / 2 + 9 * dpr, y + 4 * dpr);
                g.fill();
                g.font = `600 ${size}px system-ui,sans-serif`;
                g.lineWidth = 3 * dpr;
                g.strokeStyle = 'rgba(14,17,22,.9)';
                g.strokeText(p.name, x + 6 * dpr, y);
                g.fillStyle = '#e9d6b6';
                g.fillText(p.name, x + 6 * dpr, y);
            } else {
                g.lineWidth = 3 * dpr;
                g.strokeStyle = 'rgba(14,17,22,.9)';
                g.strokeText(p.name, x, y);
                g.fillStyle = '#fff';
                g.fillText(p.name, x, y);
            }
        }
        // Where it is flying: a dashed line, to the rim when farther
        const an = Air.nav();
        if (an) {
            let [x, y] = P(an.x, an.y);
            const d = Math.hypot(x - R, y - R), lim = R - 10 * dpr;
            if (d > lim) { x = R + (x - R) * lim / d; y = R + (y - R) * lim / d; }
            g.strokeStyle = '#3e8bff';
            g.lineWidth = 3 * dpr;
            g.setLineDash([6 * dpr, 5 * dpr]);
            g.beginPath(); g.moveTo(R, R); g.lineTo(x, y); g.stroke();
            g.setLineDash([]);
            g.fillStyle = '#1f8a4c';
            g.beginPath(); g.arc(x, y, 6 * dpr, 0, 7); g.fill();
        }
        // Other players: planes as planes, cars as dots
        for (const p of Net.players()) {
            if (!p.near) continue;
            const [x, y] = P(p.x, p.y);
            if (!inCircle(x, y)) continue;
            g.fillStyle = p.colour;
            g.strokeStyle = '#0e1116';
            g.lineWidth = 2 * dpr;
            g.beginPath();
            g.arc(x, y, 4 * dpr, 0, 7);
            g.fill();
            g.stroke();
        }
        planeGlyph(g, R, R, 12 * dpr, '#3e8bff');
        const b = f.brg * RAD;
        miniNorth(g, R, Math.sin(b), Math.cos(b), dpr);
    }

    // ================= Road and town, gear, back to the road =================
    const town = { name: '', at: 0, x: 0, y: 0 };
    async function reverse(lat, lon) {
        try {
            const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&lang=${I18n.photon}&limit=1`);
            const f = (await r.json()).features[0];
            return f && f.properties;
        } catch (err) {
            return null;
        }
    }

    // The town of the car, asked again after 400 m and at most every 8 s
    async function updateTown(now) {
        const f = osmSim.free;
        if (!f.on || now - town.at < 8000 || (town.at && Math.hypot(f.x - town.x, f.y - town.y) < 400)) return;
        Object.assign(town, { at: now, x: f.x, y: f.y });
        const ll = OsmMatch.unproject(f.x, f.y), p = await reverse(ll.lat, ll.lon);
        if (p) town.name = townOf(p);
    }
    function townOf(p) { return p.city || (p.type === 'city' ? p.name : '') || p.county || ''; }

    let roadBox, backBtn;
    // Plain text with a shadow, no card: it informs without competing with the road
    const QUIET = 'color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.9),0 0 10px rgba(0,0,0,.6);font-family:system-ui,sans-serif;pointer-events:none';
    function buildHud() {
        roadBox = el('div', QUIET + ';position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:400;display:none;text-align:center;white-space:nowrap;opacity:.9');
        document.body.appendChild(roadBox);
        backBtn = el('button', BTN + ';position:fixed;left:50%;top:96px;transform:translateX(-50%);z-index:400;background:#3e8bff;display:none;'
            + 'box-shadow:0 6px 24px rgba(0,0,0,.45)', tr('backToRoadKey'));
        backBtn.onclick = () => { backBtn.blur(); osmSim.backToRoad(); };
        document.body.appendChild(backBtn);

        // Tank gauge in the bottom right corner, upright: F over ten segments over E, and a pump drawn under them.
        // On phones the corner has the pedals: it stands above the throttle
        fuelBox = el('div', 'position:fixed;right:18px;bottom:18px;z-index:400;display:none;flex-direction:column;align-items:center;gap:3px;'
            + 'padding:7px 7px 6px;border-radius:10px;background:rgba(14,18,24,.6);box-shadow:0 4px 14px rgba(0,0,0,.35);'
            + 'color:#fff;font:700 10px system-ui,sans-serif;letter-spacing:.5px;pointer-events:none');
        fuelBox.append(el('div', 'opacity:.75', 'F'));
        fuelSegs = [];
        for (let k = 0; k < 10; k++) {
            const seg = el('div', 'width:16px;height:6px;border-radius:2px;background:rgba(255,255,255,.16);transition:background .2s');
            fuelSegs.unshift(seg);
            fuelBox.appendChild(seg);
        }
        fuelBox.append(el('div', 'opacity:.75', 'E'),
            el('div', 'margin-top:2px;line-height:0', '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
                + '<path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M3 21h12"/><path d="M4 10h10"/>'
                + '<path d="M14 8h2a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0V9l-3-3"/></svg>'));
        document.body.appendChild(fuelBox);
        // The trip distance moves left of the gauge
        const style = document.createElement('style');
        style.textContent = 'body.fuel-on #bottomBar{padding-right:70px}';
        document.head.appendChild(style);
        // On reserve: to the nearest station; dry: call for help
        fuelBtn = el('button', BTN + ';position:fixed;left:50%;top:150px;transform:translateX(-50%);z-index:400;display:none;'
            + 'box-shadow:0 6px 24px rgba(0,0,0,.45)');
        fuelBtn.onclick = () => { fuelBtn.blur(); Fuel.empty ? rescue() : toStation(); };
        document.body.appendChild(fuelBtn);
        Fuel.onMessage = (key, ...args) => flash(tr(key, ...args));
        Air.onMessage = (key, ...args) => flash(tr(key, ...args));
        Net.onMessage = (key, ...args) => flash(tr(key, ...args));
        Net.onMap = () => { big.dirty = true; };
        Fuel.onReserve = () => {
            const f = osmSim.free;
            if (f.kind === 'plane') {
                const rw = Air.runwayNear(f.x, f.y, 60000);
                flash(rw ? tr('fuelReservePlane', fmtDist(Math.hypot(rw.x - f.x, rw.y - f.y))) : tr('fuelReserveNonePlane'));
                return;
            }
            const n = Fuel.near(f.x, f.y, 20000)[0];
            flash(n ? tr('fuelReserve', fmtDist(n.d)) : tr('fuelReserveNone'));
        };
        // The plane's throttle, left of the tank: on phones the throttle lever shows it
        thrBox = el('div', 'position:fixed;right:62px;bottom:18px;z-index:400;display:none;flex-direction:column;align-items:center;gap:3px;'
            + 'padding:7px 7px 6px;border-radius:10px;background:rgba(14,18,24,.6);box-shadow:0 4px 14px rgba(0,0,0,.35);'
            + 'color:#fff;font:700 10px system-ui,sans-serif;letter-spacing:.5px;pointer-events:none');
        thrSegs = [];
        thrBox.append(el('div', 'opacity:.75', '100'));
        for (let k = 0; k < 10; k++) {
            const seg = el('div', 'width:16px;height:6px;border-radius:2px;background:rgba(255,255,255,.16)');
            thrSegs.unshift(seg);
            thrBox.appendChild(seg);
        }
        thrBox.append(el('div', 'opacity:.75', '0'), el('div', 'margin-top:2px;font-size:9px;opacity:.75', tr('throttle').toUpperCase()));
        document.body.appendChild(thrBox);
    }

    let thrBox, thrSegs;

    let fuelBox, fuelSegs, fuelBtn, rescuing = false, netStatus;

    // ================= Players near the car: a list =================
    let peopleBtn, peopleVeil, peopleList, sideList;
    const arrowSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M12 3l7 16-7-4-7 4z"/></svg>';

    // The players near, nearest first: { name, colour, d (m), turn (deg from the car's heading, + right) }
    function nearPlayers() {
        const f = osmSim.free, travel = f.v < 0 ? (f.brg + 180) % 360 : f.brg;
        return Net.players().filter(p => p.near).map(p => ({
            ...p, d: Math.hypot(p.x - f.x, p.y - f.y), turn: OsmMatch.turnOf(travel, OsmMatch.bearing(f.x, f.y, p.x, p.y))
        })).sort((a, b) => a.d - b.d);
    }

    const row = (p, big) => `<div style="display:flex;align-items:center;gap:8px;padding:${big ? '7px 4px' : '2px 0'}">`
        + `<span style="flex:none;width:${big ? 12 : 9}px;height:${big ? 12 : 9}px;border-radius:50%;background:${p.colour};box-shadow:0 0 0 2px rgba(0,0,0,.5)"></span>`
        + `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.name)}</span>`
        + `<span style="flex:none;opacity:.8">${fmtDist(p.d)}</span>`
        + `<span style="flex:none;display:inline-block;transform:rotate(${Math.round(p.turn)}deg);line-height:0">${arrowSvg}</span></div>`;

    function buildPeople() {
        // The list in a small window, like the settings
        peopleVeil = el('div', 'position:fixed;inset:0;z-index:2500;background:rgba(0,0,0,.5);display:none;align-items:center;justify-content:center');
        const card = el('div', CARD + ';width:min(320px, calc(100% - 32px));max-height:calc(100dvh - 32px);overflow:auto;box-sizing:border-box;padding:12px;font-size:14px');
        const head = el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px');
        const close = el('button', 'background:transparent;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;opacity:.75;padding:2px 6px', '\u2715');
        close.title = close.ariaLabel = tr('close');
        close.onclick = () => showPeople(false);
        head.append(el('div', 'font-size:17px;font-weight:700', tr('nearbyPlayers')), close);
        peopleList = el('div', '');
        card.append(head, peopleList);
        peopleVeil.appendChild(card);
        peopleVeil.addEventListener('pointerdown', e => { if (e.target === peopleVeil) showPeople(false); });
        addEventListener('keydown', e => { if (e.code === 'Escape' && peopleVeil.style.display !== 'none') { e.stopPropagation(); showPeople(false); } }, true);
        document.body.appendChild(peopleVeil);
        // On computers the nearest four stay on screen, under the buttons
        sideList = el('div', QUIET + ';position:fixed;right:16px;top:66px;z-index:400;width:210px;font-size:13px;display:none');
        if (!touch) document.body.appendChild(sideList);
    }

    function showPeople(on) {
        peopleVeil.style.display = on ? 'flex' : 'none';
        if (on) drawPeople();
    }

    let peopleAt = 0;
    function drawPeople(now = performance.now()) {
        const f = osmSim.free, driving = f.on && !big.open && Net.on;
        const list = driving ? nearPlayers() : [];
        const listed = touch ? 0 : 4;
        peopleBtn.style.display = list.length > listed ? 'flex' : 'none';
        peopleBtn.lastChild.textContent = list.length;
        if (!touch) {
            sideList.style.display = list.length ? 'block' : 'none';
            const html = list.slice(0, 4).map(p => row(p, false)).join('');
            if (sideList.innerHTML !== html) sideList.innerHTML = html;
        }
        if (peopleVeil.style.display !== 'none' && now - peopleAt > 400) {
            peopleAt = now;
            const html = list.length ? list.map(p => row(p, true)).join('') : `<div style="opacity:.7;padding:8px 4px">${tr('nobodyNear')}</div>`;
            if (peopleList.innerHTML !== html) peopleList.innerHTML = html;
        }
    }

    // On computers the horn's key, for a few seconds after each start (phones have the button)
    let hornHint = null, hornHintUntil = 0, wasDriving = false;
    function drawHornHint(now) {
        if (touch) return;
        const f = osmSim.free;
        if (!hornHint) {
            hornHint = el('div', QUIET + ';position:fixed;left:16px;bottom:242px;z-index:400;font-size:13px;display:flex;align-items:center;gap:8px;opacity:0;transition:opacity .6s');
            hornHint.innerHTML = '<span style="display:inline-block;min-width:22px;padding:2px 6px;box-sizing:border-box;text-align:center;border:1.5px solid rgba(255,255,255,.85);border-radius:5px;font-weight:700;text-shadow:none;background:rgba(14,18,24,.6)">H</span>'
                + `<span>${escapeHtml(tr('horn'))}</span>`;
            document.body.appendChild(hornHint);
        }
        if (f.on && !wasDriving) hornHintUntil = now + 10000;
        wasDriving = f.on;
        const show = f.on && f.kind !== 'plane' && !big.open && now < hornHintUntil ? '1' : '0';
        if (hornHint.style.opacity !== show) hornHint.style.opacity = show;
    }

    // Navigation to the nearest station loaded; with none in reach, the roads a little farther out first
    async function toStation() {
        const f = osmSim.free;
        let n = Fuel.near(f.x, f.y, 20000)[0];
        if (!n) {
            const ll = OsmMatch.unproject(f.x, f.y);
            await OsmMatch.ensure(ll.lat, ll.lon, 2);
            n = Fuel.near(f.x, f.y, 20000)[0];
        }
        if (!n) { flash(tr('fuelReserveNone')); return; }
        navigate([n.st.lat, n.st.lon], n.st.name || tr('station'));
    }

    function rescue() {
        if (rescuing) return;
        rescuing = true;
        flash(tr('rescueComing'));
        setTimeout(() => {
            rescuing = false;
            const st = Fuel.rescue();
            stopNav();
            town.at = 0;
            flash(st ? tr('rescued', st.name || tr(osmSim.free.kind === 'plane' ? 'plane' : 'station')) : tr('rescuedCan'));
        }, 2000);
    }

    function drawHud(now) {
        const f = osmSim.free, t = f.on && f.road, flying = f.on && f.kind === 'plane';
        roadBox.style.display = f.on && (t || town.name || flying) ? 'block' : 'none';
        if (flying) {
            // In the air: how high above the ground, and a warning when the wings stop carrying it
            const st = Air.state();
            const line = st.stall ? `<span style="color:#ff5a4f">${tr('stall')}</span>` : tr('altitude', Math.round(st.agl / 10) * 10);
            const html = `<div style="font-size:15px;font-weight:600">${line}</div>`
                + (town.name ? `<div style="font-size:12px;opacity:.8;margin-top:1px">${escapeHtml(town.name)}</div>` : '');
            if (roadBox.innerHTML !== html) roadBox.innerHTML = html;
        } else if (f.on) {
            let line = '';
            if (t) {
                const ref = t.ref ? `<span style="background:${/^A\d/.test(t.ref) ? '#1f8a4c' : '#2a6fdb'};border-radius:4px;padding:1px 6px;font-size:12px;margin-right:6px;text-shadow:none">${escapeHtml(t.ref)}</span>` : '';
                line = ref + escapeHtml(t.name || (t.ref ? '' : tr('unnamedRoad')));
            } else if (Fuel.padAt(f.x, f.y, 1)) {
                const st = Fuel.padAt(f.x, f.y, 1);
                line = escapeHtml(st.name || tr('station'));
            } else {
                line = `<span style="opacity:.75">${tr('offRoad')}</span>`;
            }
            const html = `<div style="font-size:15px;font-weight:600">${line}</div>`
                + (town.name ? `<div style="font-size:12px;opacity:.8;margin-top:1px">${escapeHtml(town.name)}</div>` : '');
            if (roadBox.innerHTML !== html) roadBox.innerHTML = html;
        }
        backBtn.style.display = f.on && f.offSince && now - f.offSince > 4000 ? 'block' : 'none';
        if (netStatus) {
            const st = Net.status, txt = !Net.on ? tr('offlineAlone') : st === 'on' ? tr('onlineStatus', Net.nearCount, Net.total || 1) : st === 'connecting' ? tr('connecting') : tr('offline');
            if (netStatus.textContent !== txt) netStatus.textContent = txt;
        }
        const showFuel = f.on && Fuel.on;
        fuelBox.style.display = showFuel ? 'flex' : 'none';
        document.body.classList.toggle('fuel-on', showFuel && !touch);
        if (showFuel) {
            // Lit segments, the last one blinking when nearly dry; green while filling
            const lv = Fuel.level, lit = Math.ceil(lv * 10 - 0.001), blink = lv < 0.05 && Math.floor(now / 400) % 2;
            const on = Fuel.filling ? '#3ccf7a' : lv < 0.05 ? '#ff5a4f' : lv < 0.15 ? '#ff9f1a' : '#f2f4f7';
            fuelSegs.forEach((seg, k) => { seg.style.background = k < lit && !(blink && k === lit - 1) ? on : 'rgba(255,255,255,.16)'; });
        }
        // On reserve, unless already going to a station or filling up; dry and stopped, help. A plane on reserve
        // is told where the nearest runway is, and gets help once down on the ground
        const dry = showFuel && Fuel.empty && Math.abs(f.v) < 0.5 && !(flying && f.air), low = showFuel && Fuel.level < 0.15 && !Fuel.filling && !nav.on && !flying;
        fuelBtn.style.display = dry || low ? 'block' : 'none';
        const label = tr(dry ? 'callRescue' : 'toStation');
        if (fuelBtn.textContent !== label) fuelBtn.textContent = label;
        fuelBtn.style.background = dry ? '#ff5a4f' : '#ff9f1a';
        thrBox.style.display = flying && !touch ? 'flex' : 'none';
        // While flying the satellite imagery is on screen: its credit with the map's, as its licence asks
        const credit = document.getElementById('mapAttribution');
        if (credit) {
            const text = MAP_CREDIT + (flying ? ' \u00b7 Sentinel-2 cloudless \u2013 https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016)' : '');
            if (credit.textContent !== text) credit.textContent = text;
        }
        // On phones the throttle lever is taller than the pedal: in a plane the gauge stands beside it
        if (touch) Object.assign(fuelBox.style, flying ? { bottom: '24px', right: '98px' } : { bottom: '150px', right: '36px' });
        if (flying && !touch) {
            const lit = Math.round(Air.state().thr * 10);
            thrSegs.forEach((seg, k) => { seg.style.background = k < lit ? '#3e8bff' : 'rgba(255,255,255,.16)'; });
        }
    }

    // ================= Day, night or as it is now there; headlights on at night =================
    const sky = { mode: 'auto', at: 0 };
    // Sun elevation in degrees (low-precision solar position, good to a fraction of a degree)
    function sunElevation(lat, lon, date) {
        const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 864e5;
        const g = (357.529 + 0.98560028 * d) * RAD, q = 280.459 + 0.98564736 * d;
        const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD, e = (23.439 - 0.00000036 * d) * RAD;
        const dec = Math.asin(Math.sin(e) * Math.sin(L)), ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
        const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
        const ha = (gmst * 15 + lon) * RAD - ra;
        return Math.asin(Math.sin(lat * RAD) * Math.sin(dec) + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(ha)) / RAD;
    }

    // Sky colours between night and day, through dawn and dusk; overcast and fog grey them out
    const SKY = {
        day: { zenith: 0x3d7fd1, horizon: 0xcfe2f2, below: 0xb9cbb0 },
        dusk: { zenith: 0x3b4a7a, horizon: 0xf0905a, below: 0x3a3530 },
        night: { zenith: 0x03050b, horizon: 0x1a2232, below: 0x10140f },
    };
    function mixSky(a, b, t) {
        const out = {};
        for (const k of ['zenith', 'horizon', 'below']) out[k] = new THREE.Color(a[k]).lerp(new THREE.Color(b[k]), t).getHex();
        return out;
    }
    function skyAt(elev) {
        if (elev < -8) return SKY.night;
        if (elev < -2) return mixSky(SKY.night, SKY.dusk, (elev + 8) / 6);
        if (elev < 4) return SKY.dusk;
        if (elev < 12) return mixSky(SKY.dusk, SKY.day, (elev - 4) / 8);
        return SKY.day;
    }

    function applySky(now) {
        let night = sky.mode === 'night', colours = null;
        if (sky.mode === 'auto') {
            const f = osmSim.free;
            const [lat, lon] = f.on ? (ll => [ll.lat, ll.lon])(OsmMatch.unproject(f.x, f.y)) : big.spawn || [START.lat, START.lon];
            const elev = sunElevation(lat, lon, new Date());
            night = elev < -4;
            colours = skyAt(elev);
        }
        if (weather.mode !== 'clear') {
            const grey = night ? { zenith: 0x0c0f14, horizon: 0x262b33, below: 0x141619 } : { zenith: 0x6f7883, horizon: 0xb4bbc2, below: 0x8d948c };
            colours = weather.mode === 'fog' ? mixSky(colours || (night ? SKY.night : SKY.day), grey, 0.85) : grey;
        }
        Terrain.sky = colours;
        Terrain.overcast = weather.mode !== 'clear';
        Terrain.fog = weather.mode === 'fog' ? { near: 8, far: 90 } : weather.mode === 'rain' ? { near: 30, far: 160 } : null;
        Engine.rain = weather.mode === 'rain';
        if (night !== isDarkTheme) setTheme(night ? 'dark' : 'light');
        // Headlights at night and in bad weather
        setHeadlights(night || weather.mode !== 'clear');
        sky.at = now;
    }

    // ================= Weather: rain falls around the camera =================
    const weather = { mode: 'clear', drops: null };
    function updateRain(dt) {
        const on = weather.mode === 'rain' && osmSim.free.on && !big.open;
        if (!weather.drops) {
            const N = 2500, pos = new Float32Array(N * 6);
            for (let i = 0; i < N; i++) {
                const x = (Math.random() - 0.5) * 40, y = Math.random() * 25, z = (Math.random() - 0.5) * 40;
                pos.set([x, y, z, x, y - 0.6, z], i * 6);
            }
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            weather.drops = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xaab6c4, transparent: true, opacity: 0.45, depthWrite: false }));
            weather.drops.frustumCulled = false;
            scene.add(weather.drops);
        }
        weather.drops.visible = on;
        if (!on) return;
        const a = weather.drops.geometry.attributes.position, p = a.array, fall = 18 * dt;
        for (let i = 0; i < p.length; i += 6) {
            p[i + 1] -= fall;
            p[i + 4] -= fall;
            if (p[i + 4] < -3) { p[i + 1] += 25; p[i + 4] += 25; }
        }
        a.needsUpdate = true;
        weather.drops.position.set(camera.position.x, camera.position.y - 6, camera.position.z);
    }

    // ================= Navigation to a destination, on the roads loaded along the way =================
    const nav = { on: false, dest: null, label: '', pts: [], S: [], man: [], ways: new Map(), cur: null, i: 0, off: 0, routedAt: 0 };
    let navBox;

    async function navigate(dest, label) {
        const f = osmSim.free;
        if (!f.on || !dest) return;
        const from = OsmMatch.unproject(f.x, f.y), to = OsmMatch.project(dest[0], dest[1]);
        const dist = Math.hypot(to.x - f.x, to.y - f.y);
        if (dist > 60000) { big.msg.textContent = tr('tooFar'); return; }
        closeMap(true);
        // Roads along the straight line, wider for longer trips, before searching the route
        const pts = [], n = Math.max(1, Math.ceil(dist / 1500));
        for (let k = 0; k <= n; k++) pts.push({ lat: from.lat + (dest[0] - from.lat) * k / n, lon: from.lon + (dest[1] - from.lon) * k / n });
        f.paused = true;
        await osmSim.prepare(pts, dist > 3000 ? 2 : 1, 0);
        f.paused = false;
        Object.assign(nav, { dest, label: label || tr('destination') });
        if (!route()) flash(tr('noRouteTo', nav.label));
    }

    // The road the car is on and which way along it it is going: { e, fwd, x, y }, null off the roads
    function onRoad(f) {
        const travel = f.v < 0 ? (f.brg + 180) % 360 : f.brg;
        let best = null;
        for (const e of OsmMatch.edgesNear(f.x, f.y, 15)) {
            const dx = e.bx - e.ax, dy = e.by - e.ay, l2 = dx * dx + dy * dy || 1e-9;
            const t = Math.max(0, Math.min(1, ((f.x - e.ax) * dx + (f.y - e.ay) * dy) / l2));
            const x = e.ax + dx * t, y = e.ay + dy * t, turn = Math.abs(OsmMatch.turnOf(travel, e.brg));
            // Nearest, and along the heading where two roads meet
            const score = Math.hypot(f.x - x, f.y - y) + Math.min(turn, 180 - turn) * 0.1;
            if (!best || score < best.score) best = { e, fwd: turn < 90, x, y, score };
        }
        return best && best.score < 12 ? best : null;
    }

    // From the junction ahead of the car, the way it is going: no U-turn to a junction just passed
    function route() {
        const f = osmSim.free, to = OsmMatch.project(nav.dest[0], nav.dest[1]), start = onRoad(f);
        const node = start && (start.fwd ? { x: start.e.bx, y: start.e.by } : { x: start.e.ax, y: start.e.ay });
        const path = OsmMatch.route(node || { x: f.x, y: f.y }, to);
        if (!path || !path.length) { stopNav(); return false; }
        const steps = start ? [{ e: start.e, fwd: start.fwd, part: true }, ...path] : path;
        const pts = [], S = [0];
        const first = steps[0];
        pts.push(start ? { x: start.x, y: start.y } : first.fwd ? { x: first.e.ax, y: first.e.ay } : { x: first.e.bx, y: first.e.by });
        for (const st of steps) {
            const p = st.fwd ? { x: st.e.bx, y: st.e.by } : { x: st.e.ax, y: st.e.ay };
            const len = Math.hypot(p.x - pts[pts.length - 1].x, p.y - pts[pts.length - 1].y);
            st.s0 = S[S.length - 1];
            pts.push(p);
            S.push(S[S.length - 1] + len);
        }
        // Turns at junctions, like a navigation app says them
        const man = [];
        for (let k = 1; k < steps.length; k++) {
            const a = steps[k - 1], b = steps[k], id = a.fwd ? a.e.b : a.e.a;
            if ((OsmMatch.nodes.get(id) || { edges: [] }).edges.length < 3) continue;
            const turn = OsmMatch.turnOf(a.fwd ? a.e.brg : a.e.brg + 180, b.fwd ? b.e.brg : b.e.brg + 180);
            if (Math.abs(turn) < 25) continue;
            const name = b.e.tags.name || b.e.tags.ref;
            man.push({ s: b.s0, dir: turn < 0 ? 1 : -1, angle: Math.round(Math.abs(turn)), text: name ? tr(turn < 0 ? 'turnLeftInto' : 'turnRightInto', name) : tr(turn < 0 ? 'turnLeft' : 'turnRight') });
        }
        man.push({ s: S[S.length - 1], dir: 0, angle: 0, text: tr('arriveAt', nav.label) });
        // Each road of the route and the way it is driven, to notice a turn onto another road or a U-turn
        const ways = new Map(steps.map(st => [st.e, st.fwd]));
        Object.assign(nav, { on: true, pts, S, man, ways, i: 0, off: 0, routedAt: performance.now(), cur: { i: 0, x: pts[0].x, y: pts[0].y } });
        big.dirty = true;
        return true;
    }

    function stopNav() {
        nav.on = false;
        setUpcomingTurn(null);
        setTripInfo(null);
    }

    const roundDist = m => m >= 1000 ? Math.round(m / 100) * 100 : m >= 300 ? Math.round(m / 50) * 50 : Math.round(m / 10) * 10;
    const fmtDist = m => m >= 1000 ? I18n.num(m / 1000, 1) + ' km' : roundDist(m) + ' m';

    // In a plane: which way and how far to the destination, in a straight line
    function airGuide() {
        const n = Air.nav();
        navBox.style.display = n ? 'flex' : 'none';
        if (!n) return;
        const html = `<div style="width:30px;text-align:center;line-height:0"><svg width="26" height="26" viewBox="0 0 24 24" style="transform:rotate(${Math.round(n.turn)}deg)">`
            + `<path d="M12 2l7 18-7-4-7 4z" fill="#3e8bff" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg></div>`
            + `<div><div style="font-size:17px;font-weight:700">${fmtDist(Math.round(n.d / 100) * 100)}</div><div style="font-size:12px;opacity:.85">${escapeHtml(n.name || tr('destination'))}</div></div>`;
        if (navBox.firstChild.innerHTML !== html) navBox.firstChild.innerHTML = html;
    }

    function guide(now) {
        if (osmSim.free.on && osmSim.free.kind === 'plane') { airGuide(); return; }
        navBox.style.display = nav.on && osmSim.free.on ? 'flex' : 'none';
        if (!nav.on || !osmSim.free.on) return;
        const f = osmSim.free, P = nav.pts;
        // Where the car is along the route: the nearest point a little behind or ahead of the last one
        let best = { d: Infinity, i: nav.i, t: 0 };
        for (let i = Math.max(0, nav.i - 5); i < Math.min(P.length - 1, nav.i + 300); i++) {
            const a = P[i], b = P[i + 1], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1e-9;
            const t = Math.max(0, Math.min(1, ((f.x - a.x) * dx + (f.y - a.y) * dy) / l2));
            const d = Math.hypot(f.x - a.x - dx * t, f.y - a.y - dy * t);
            if (d < best.d) best = { d, i, t };
        }
        nav.i = best.i;
        const a = P[best.i], b = P[best.i + 1];
        nav.cur = { i: best.i, x: a.x + (b.x - a.x) * best.t, y: a.y + (b.y - a.y) * best.t };
        const s = nav.S[best.i] + (nav.S[best.i + 1] - nav.S[best.i]) * best.t, left = nav.S[nav.S.length - 1] - s;
        if (left < 25) {
            stopNav();
            flash(tr('arrived', nav.label));
            return;
        }
        // Off the route: on a road that isn't part of it, along it the wrong way, or away from it. After a moment, so
        // the GPS-like wobble at a junction doesn't trigger it, a new route from here
        const here = onRoad(f), moving = Math.abs(f.v) > 2;
        const off = best.d > 30 || (here && moving && (!nav.ways.has(here.e) ? best.d > 8 : nav.ways.get(here.e) !== here.fwd));
        if (off) {
            nav.off = nav.off || now;
            if (now - nav.off > 1500 && now - nav.routedAt > 3000) {
                if (route()) flash(tr('rerouted'));
                else flash(tr('noRoute'));
                return;
            }
        } else nav.off = 0;
        const m = nav.man.find(m => m.s > s - 5), meters = Math.max(0, m.s - s);
        setUpcomingTurn(m.dir ? { dir: m.dir, angle: m.angle, meters: roundDist(meters) } : null);
        const glyph = m.dir === 0 ? '⚑' : m.dir > 0 ? (m.angle > 120 ? '↶' : m.angle < 45 ? '↖' : '↰') : (m.angle > 120 ? '↷' : m.angle < 45 ? '↗' : '↱');
        const html = `<div style="font-size:24px;width:30px;text-align:center">${glyph}</div><div><div style="font-size:17px;font-weight:700">${fmtDist(meters)}</div>`
            + `<div style="font-size:12px;opacity:.85">${escapeHtml(m.text)}</div></div>`;
        if (navBox.firstChild.innerHTML !== html) navBox.firstChild.innerHTML = html;
        setTripInfo({ remainingLabel: tr('distance'), remaining: fmtDist(left) });
    }

    // Short message in the middle of the screen
    let toastBox;
    function flash(text) {
        toastBox.textContent = text;
        toastBox.style.opacity = '1';
        clearTimeout(toastBox.timer);
        toastBox.timer = setTimeout(() => { toastBox.style.opacity = '0'; }, 4000);
    }

    function buildExtras() {
        navBox = el('div', 'position:fixed;left:16px;top:16px;z-index:400;padding:6px 10px;display:none;gap:6px;align-items:center;max-width:300px;'
            + 'background:rgba(14,18,24,.5);border-radius:10px;color:#fff;font-family:system-ui,sans-serif');
        navBox.append(el('div', 'display:flex;gap:10px;align-items:center'));
        const stopBtn = el('button', 'background:transparent;border:0;color:#fff;font-size:20px;cursor:pointer;opacity:.7;margin-left:6px', '✕');
        stopBtn.title = tr('endNav');
        stopBtn.onclick = () => { stopBtn.blur(); if (osmSim.free.kind === 'plane') Air.clearNav(); else stopNav(); };
        navBox.append(stopBtn);
        document.body.appendChild(navBox);
        toastBox = el('div', 'position:fixed;left:50%;top:58px;transform:translateX(-50%);z-index:1500;padding:6px 14px;font:600 14px system-ui,sans-serif;'
            + 'color:#fff;background:rgba(14,18,24,.6);border-radius:10px;max-width:70%;text-align:center;opacity:0;transition:opacity .4s;pointer-events:none');
        document.body.appendChild(toastBox);
    }

    // ================= Touch controls on phones and tablets =================
    const touch = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || new URLSearchParams(location.search).has('touch');
    let touchPad = null, planePad = null;
    const planeTouch = { x: 0, y: 0, thr: 0 };
    // Flying on a phone: a stick on the left (down climbs, sideways banks) springing back to the middle, and a
    // throttle lever on the right that stays where it is left
    function buildPlanePad() {
        const pad = el('div', 'position:fixed;inset:0;z-index:450;pointer-events:none;display:none');
        const R = 70;
        const stick = el('div', CARD + ';position:absolute;left:24px;bottom:24px;width:' + 2 * R + 'px;height:' + 2 * R + 'px;border-radius:50%;'
            + 'pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none');
        const knob = el('div', 'position:absolute;left:50%;top:50%;width:54px;height:54px;margin:-27px 0 0 -27px;border-radius:50%;'
            + 'background:rgba(62,139,255,.85);box-shadow:0 2px 8px rgba(0,0,0,.4);pointer-events:none');
        stick.appendChild(knob);
        const move = e => {
            const r = stick.getBoundingClientRect();
            let dx = (e.clientX - r.left - R) / R, dy = (e.clientY - r.top - R) / R;
            const l = Math.hypot(dx, dy);
            if (l > 1) { dx /= l; dy /= l; }
            planeTouch.x = dx;
            planeTouch.y = dy;
            knob.style.transform = `translate(${dx * R * 0.7}px, ${dy * R * 0.7}px)`;
        };
        stick.addEventListener('pointerdown', e => { e.preventDefault(); stick.setPointerCapture(e.pointerId); move(e); });
        stick.addEventListener('pointermove', e => { if (stick.hasPointerCapture(e.pointerId)) move(e); });
        for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) stick.addEventListener(ev, () => { planeTouch.x = planeTouch.y = 0; knob.style.transform = ''; });
        const lever = el('div', CARD + ';position:absolute;right:16px;bottom:24px;width:70px;height:170px;overflow:hidden;'
            + 'pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none');
        const fill = el('div', 'position:absolute;left:0;right:0;bottom:0;background:rgba(62,139,255,.75);pointer-events:none');
        const label = el('div', 'position:absolute;left:0;right:0;top:8px;text-align:center;font:700 13px system-ui,sans-serif;pointer-events:none', tr('throttle').toUpperCase());
        lever.append(fill, label);
        const set = e => {
            const r = lever.getBoundingClientRect();
            planeTouch.thr = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
        };
        lever.addEventListener('pointerdown', e => { e.preventDefault(); lever.setPointerCapture(e.pointerId); set(e); });
        lever.addEventListener('pointermove', e => { if (lever.hasPointerCapture(e.pointerId)) set(e); });
        pad.append(stick, lever);
        pad.fill = fill;
        document.body.appendChild(pad);
        planePad = pad;
    }
    function buildTouch() {
        const meta = document.querySelector('meta[name=viewport]');
        if (meta) meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
        // Added to the home screen it opens without the browser's bars
        for (const [name, content] of [['apple-mobile-web-app-capable', 'yes'], ['mobile-web-app-capable', 'yes'], ['apple-mobile-web-app-status-bar-style', 'black-translucent']]) {
            const m = document.createElement('meta');
            m.name = name;
            m.content = content;
            document.head.appendChild(m);
        }
        // 100vh reaches under the phone browser's bottom bar: the visible height instead, and the speed above the notch
        const style = document.createElement('style');
        style.textContent = '#container{height:100dvh !important}'
            + '#bottomBar{bottom:calc(env(safe-area-inset-bottom, 0px) + 22px) !important}';
        document.head.appendChild(style);
        addEventListener('resize', () => setTimeout(onWindowResize, 100));
        document.body.style.touchAction = 'none';
        const pad = el('div', 'position:fixed;inset:0;z-index:450;pointer-events:none');
        const key = (label, code, css) => {
            const b = el('div', CARD + ';position:absolute;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:700;'
                + 'pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none;' + css, label);
            const idle = b.style.background;
            const press = on => e => {
                e.preventDefault();
                if (on) { b.setPointerCapture(e.pointerId); osmSim.free.keys.add(code); b.style.background = 'rgba(62,139,255,.85)'; }
                else { osmSim.free.keys.delete(code); b.style.background = idle; }
            };
            b.addEventListener('pointerdown', press(true));
            for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, press(false));
            b.addEventListener('contextmenu', e => e.preventDefault());
            pad.appendChild(b);
        };
        key('◀', 'ArrowLeft', 'left:16px;bottom:24px;width:84px;height:84px;border-radius:50%');
        key('▶', 'ArrowRight', 'left:112px;bottom:24px;width:84px;height:84px;border-radius:50%');
        key('FRENO', 'ArrowDown', 'right:112px;bottom:24px;width:96px;height:70px;font-size:15px');
        key('GAS', 'ArrowUp', 'right:16px;bottom:24px;width:84px;height:110px;font-size:15px');
        // The horn, above the brake: held down it sounds
        const hornBtn = el('div', CARD + ';position:absolute;right:124px;bottom:108px;width:58px;height:58px;border-radius:50%;display:flex;align-items:center;justify-content:center;'
            + 'pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none');
        hornBtn.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<path d="M3 10v4h3l6 4V6L6 10z" fill="#fff"/><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/></svg>';
        hornBtn.ariaLabel = tr('horn');
        const hornIdle = hornBtn.style.background;
        hornBtn.addEventListener('pointerdown', e => { e.preventDefault(); hornBtn.setPointerCapture(e.pointerId); hornBtn.style.background = 'rgba(62,139,255,.85)'; Net.horn(true); });
        for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) hornBtn.addEventListener(ev, () => { hornBtn.style.background = hornIdle; Net.horn(false); });
        hornBtn.addEventListener('contextmenu', e => e.preventDefault());
        pad.appendChild(hornBtn);
        document.body.appendChild(pad);
        touchPad = pad;
        buildPlanePad();
        // The minimap and the gear move up, out of the thumbs' way
        Object.assign(mini.box.style, { width: '130px', height: '130px', left: '16px', top: '16px', bottom: '' });
        Object.assign(mini.canvas.style, { width: '130px', height: '130px' });
        Object.assign(mini.zoom.style, { left: '156px', top: '16px', bottom: '' });
        // Directions on the left under the minimap, off the road ahead
        Object.assign(navBox.style, { left: '16px', top: '156px' });
        backBtn.style.top = '172px';
        fuelBtn.style.top = '226px';
        Object.assign(fuelBox.style, { bottom: '150px', right: '36px' });
        backBtn.textContent = tr('backToRoad');
    }

    function loop(now) {
        requestAnimationFrame(loop);
        const dt = Math.min(0.1, (now - (loop.last || now)) / 1000);
        loop.last = now;
        if (now - mini.at > 50) {
            mini.at = now;
            drawMini();
            drawHud(now);
            drawPeople(now);
            updateTown(now);
            carPlace(now);
            drawHornHint(now);
            guide(now);
            if (touchPad) {
                const f = osmSim.free, fly = f.on && !big.open && f.kind === 'plane';
                touchPad.style.display = f.on && !big.open && !fly ? 'block' : 'none';
                // The lever starts where the plane's throttle is: idle on a runway, cruising in the air
                if (fly && planePad.style.display === 'none') planeTouch.thr = Air.state().thr;
                planePad.style.display = fly ? 'block' : 'none';
                planePad.fill.style.height = planeTouch.thr * 100 + '%';
                Air.setTouch(fly ? planeTouch : null);
            }
        }
        updateRain(dt);
        if (now - sky.at > 60000) applySky(now);
        if (big.open && (big.dirty || osmSim.free.on)) drawBig();
    }

    function buildOptions() {
        // Only the map and a gear in the corner; the settings open in a window over the game, scrolling when the screen
        // is short, in two columns on phones held sideways
        const veil = el('div', 'position:fixed;inset:0;z-index:2500;background:rgba(0,0,0,.5);display:none;align-items:center;justify-content:center');
        const box = el('div', CARD + ';position:relative;width:min(340px, calc(100% - 32px));max-height:calc(100dvh - 32px);overflow:auto;box-sizing:border-box;'
            + 'padding:12px;display:flex;flex-direction:column;gap:8px;font-size:13px');
        const wide = innerHeight < 520 && innerWidth > 600;
        if (wide) box.style.width = 'min(640px, calc(100% - 32px))';
        const head = el('div', 'display:flex;justify-content:space-between;align-items:center;padding:0 2px 2px');
        const close = el('button', 'background:transparent;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;opacity:.75;padding:2px 6px', '\u2715');
        close.title = close.ariaLabel = tr('close');
        head.append(el('div', 'font-size:17px;font-weight:700', tr('options')), close);
        const body = el('div', 'display:grid;gap:6px 14px;align-items:start;grid-template-columns:' + (wide ? '1fr 1fr' : '1fr'));
        const col = () => el('div', 'display:flex;flex-direction:column;gap:6px;min-width:0');
        let pausedBefore = false;
        const show = on => {
            if (on === isOpen()) return;
            const f = osmSim.free;
            // While it is open the keys belong to it, not to the car
            if (on) { pausedBefore = f.paused; f.paused = true; f.keys.clear(); }
            else f.paused = pausedBefore;
            veil.style.display = on ? 'flex' : 'none';
            gear.style.background = on ? '#3e8bff' : 'rgba(14,18,24,.88)';
        };
        const isOpen = () => veil.style.display !== 'none';
        close.onclick = () => show(false);
        const seg = el('div', 'display:flex;background:rgba(255,255,255,.1);border-radius:9px;padding:2px');
        const modes = ['day', 'night', 'auto'].map(m => [m, tr(m)]).map(([m, label]) => {
            const b = el('button', 'flex:1;min-width:0;border:0;border-radius:7px;padding:6px 4px;color:#fff;font:13px system-ui,sans-serif;cursor:pointer;background:transparent;'
                + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap', label);
            b.onclick = () => { sky.mode = m; paint(); applySky(performance.now()); b.blur(); };
            seg.appendChild(b);
            return [m, b];
        });
        const paint = () => modes.forEach(([m, b]) => { b.style.background = sky.mode === m ? '#3e8bff' : 'transparent'; });
        paint();
        // A switch row: label on the left, on/off on the right
        const toggle = (label, get, set) => {
            const row = el('button', 'display:flex;justify-content:space-between;gap:14px;align-items:center;background:transparent;color:#fff;border:0;'
                + 'padding:6px 6px;border-radius:8px;font:13px system-ui,sans-serif;cursor:pointer');
            const dot = el('span', 'flex:none;width:30px;height:16px;border-radius:8px;position:relative'), knob = el('span', 'position:absolute;top:2px;width:12px;height:12px;border-radius:50%;background:#fff');
            dot.appendChild(knob);
            row.append(el('span', 'min-width:0;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', label), dot);
            const paint = () => { dot.style.background = get() ? '#3e8bff' : 'rgba(255,255,255,.25)'; knob.style.left = get() ? '16px' : '2px'; };
            row.onclick = () => { set(!get()); paint(); row.blur(); };
            paint();
            return row;
        };
        const audio = toggle(tr('engineSound'), () => Engine.on, v => { Engine.on = v; if (v) Engine.start(); });
        const places = toggle(tr('showPlaces'), () => Pois.on, v => { Pois.on = v; });
        const fuel = toggle(tr('fuel'), () => Fuel.on, v => { Fuel.on = v; if (v && Fuel.empty) Fuel.fill(); });
        const online = toggle(tr('online'), () => Net.on, v => { Net.on = v; });
        // The name over its field, the field as wide as the window
        const nameRow = el('label', 'display:flex;flex-direction:column;gap:5px;font-size:13px;padding:4px 6px');
        const nameIn = el('input', 'width:100%;box-sizing:border-box;background:#1b2028;color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:7px 9px;font:16px system-ui,sans-serif;outline:none');
        nameIn.maxLength = 20;
        nameIn.value = Net.name;
        nameIn.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') nameIn.blur(); });
        nameIn.addEventListener('change', () => { Net.name = nameIn.value; nameIn.value = Net.name; });
        nameIn.placeholder = 'Pilota';
        nameRow.append(el('span', 'opacity:.9', tr('playerName')), nameIn);
        netStatus = el('div', 'font-size:12px;opacity:.65;padding:0 6px 4px');
        const back = el('button', BTN + ';background:rgba(255,255,255,.1);padding:7px 10px;font-size:13px;font-weight:400', tr('backToRoadKey'));
        back.onclick = () => {
            back.blur();
            if (!osmSim.free.on) return;
            flash(tr(osmSim.backToRoad() ? 'backAgain' : 'noRoad1km'));
            show(false);
        };
        if (touch) back.textContent = tr('backToRoad');
        const fs = el('button', BTN + ';background:rgba(255,255,255,.1);padding:7px 10px;font-size:13px;font-weight:400', tr('fullscreen'));
        fs.onclick = () => { fs.blur(); fullscreen(!(document.fullscreenElement || document.webkitFullscreenElement)); };
        // Its name says what it will do, however full screen was entered or left (F, Esc, the start on phones)
        const fsName = () => { fs.textContent = tr(document.fullscreenElement || document.webkitFullscreenElement ? 'exitFullscreen' : 'fullscreen'); };
        for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, fsName);
        fsName();
        const invite = el('button', BTN + ';background:#1f8a4c;padding:7px 10px;font-size:13px', tr('invite'));
        invite.onclick = () => { invite.blur(); share(); show(false); };
        const left = col(), right = col();
        left.append(seg, audio, places, fuel, languagePicker('padding:4px 6px'));
        right.append(online, nameRow, netStatus, invite, back, fs);
        if (wide) body.append(left, right);
        else body.append(...left.children, ...right.children);
        box.append(head, body);
        veil.appendChild(box);
        document.body.appendChild(veil);
        // Outside the window closes it
        veil.addEventListener('pointerdown', e => { if (e.target === veil) show(false); });
        const bar = el('div', 'position:fixed;right:16px;top:16px;z-index:401;display:flex;gap:8px');
        const mapBtn = el('button', BTN + ';background:#3e8bff;padding:0 14px;height:40px;font-size:13px', tr(touch ? 'map' : 'mapKey'));
        mapBtn.onclick = () => { mapBtn.blur(); show(false); openMap(); };
        const gear = el('button', BTN + ';background:rgba(14,18,24,.88);width:40px;height:40px;padding:0;display:flex;align-items:center;justify-content:center',
            '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09'
            + 'A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09'
            + 'A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09'
            + 'a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09'
            + 'a1.65 1.65 0 0 0-1.51 1z"/></svg>');
        gear.title = gear.ariaLabel = tr('options');
        gear.onclick = () => { gear.blur(); show(!isOpen()); };
        // Players near: how many, opening their list (on computers only past the four listed on screen)
        peopleBtn = el('button', BTN + ';background:rgba(14,18,24,.88);height:40px;padding:0 11px;display:none;align-items:center;gap:6px;font-size:14px',
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><circle cx="17" cy="9" r="2.8"/><path d="M16 14.2c3.3-.4 5.5 1.9 5.5 5.3"/></svg><span></span>');
        peopleBtn.title = peopleBtn.ariaLabel = tr('nearbyPlayers');
        peopleBtn.onclick = () => { peopleBtn.blur(); showPeople(true); };
        bar.append(peopleBtn, mapBtn, gear);
        document.body.appendChild(bar);
        addEventListener('keydown', e => { if (e.code === 'Escape' && isOpen()) { e.stopPropagation(); show(false); } }, true);
    }

    // Fullscreen, and on phones locked sideways; needs a tap, and iPhones only allow it from the home screen
    function fullscreen(on) {
        const d = document, inFs = d.fullscreenElement || d.webkitFullscreenElement;
        if (on && !inFs) {
            const req = d.documentElement.requestFullscreen || d.documentElement.webkitRequestFullscreen;
            if (!req) return;
            Promise.resolve(req.call(d.documentElement, { navigationUI: 'hide' }))
                .then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape'))
                .catch(() => {});
        } else if (!on && inFs) {
            (d.exitFullscreen || d.webkitExitFullscreen).call(d);
        }
    }

    window.addEventListener('keydown', e => {
        if (e.target && e.target.tagName === 'INPUT') return;
        if (e.code === 'KeyM') big.open ? closeMap() : openMap();
        else if (e.code === 'Escape' && big.open) closeMap();
        else if (e.code === 'KeyR' && osmSim.free.on && !big.open) osmSim.backToRoad();
        else if (e.code === 'KeyF') fullscreen(!(document.fullscreenElement || document.webkitFullscreenElement));
        else if (e.code === 'KeyH' && !e.repeat && osmSim.free.on && !osmSim.free.paused && !big.open) Net.horn(true);
    });
    window.addEventListener('keyup', e => { if (e.code === 'KeyH') Net.horn(false); });
    window.addEventListener('blur', () => Net.horn(false));
    // Closed or reloaded while driving: where the car is now, not up to 5 s ago
    window.addEventListener('pagehide', () => { placeAt = 0; carPlace(performance.now()); });

    window.addEventListener('load', () => setTimeout(async () => {
        // Same setup as the bundled model in the app
        setModelConfig({
            yaw: 0, colors: {}, park: { az: -0.637, h: 0.662, d: 4.426 }, drive: { az: -3.14159, h: 1.62, d: 6.015 },
            roadYaw: 0, lights: { L: { f: 1.682, l: 0.482, y: 0.2256 }, R: { f: 1.682, l: -0.482, y: 0.2256 }, yaw: 0 }
        });
        loadModelFromUri('kiri10.glb');
        setRoadLinesConfig(true, 'left_dashed');
        setLocalizedStrings({ loading: tr('loading'), loadingProgress: tr('loadingProgress'), errorLoading: tr('error'), speedLabel: tr('speed'), speedUnit: 'km/h' });
        const credit = document.getElementById('mapAttribution');
        if (credit) credit.textContent = MAP_CREDIT;
        await osmSim.ready;
        buildBig();
        buildMini();
        buildHud();
        buildOptions();
        buildPeople();
        buildExtras();
        if (touch) buildTouch();
        [big.cx, big.cy] = world(START.lat, START.lon);
        invited() || lastPlace();
        applySky(performance.now());
        openMap();
        requestAnimationFrame(loop);
    }, 0));
})();
