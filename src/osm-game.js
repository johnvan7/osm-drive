// Browser game screen: full map to search or choose where to start, minimap, road and town name, gear,
// back-to-road button, day/night/auto and engine sound
(() => {
    const RAD = Math.PI / 180;
    const START = { lat: 41.2709, lon: 14.9201 };
    const CARD = 'background:rgba(14,18,24,.88);color:#fff;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.45);font:14px system-ui,sans-serif';
    const BTN = 'border:0;border-radius:10px;font:600 14px system-ui,sans-serif;cursor:pointer;padding:10px 16px;color:#fff';
    const CREDITS = '\u00a9 OpenStreetMap contributors \u00b7 \u00a9 OpenMapTiles \u00b7 OpenFreeMap \u00b7 Ricerca: Photon \u00b7 Altitudine: Terrain Tiles (AWS)';

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
    const big = { open: false, cx: 0, cy: 0, zoom: 14, spawn: null, drag: null, dirty: true };
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

    function buildBig() {
        big.box = el('div', 'position:fixed;inset:0;z-index:2000;background:#1b2028;display:none;cursor:grab;user-select:none');
        big.canvas = el('canvas', 'position:absolute;inset:0;width:100%;height:100%');
        big.box.appendChild(big.canvas);

        // Search, my position
        const side = el('div', CARD + ';position:absolute;left:20px;top:20px;width:min(360px, calc(100% - 100px));box-sizing:border-box;padding:14px');
        side.innerHTML = '<div style="font-size:18px;font-weight:700;margin-bottom:10px">Da dove parti?</div>';
        big.search = el('input', 'width:100%;box-sizing:border-box;padding:11px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.18);'
            + 'background:rgba(255,255,255,.08);color:#fff;font:15px system-ui,sans-serif;outline:none');
        big.search.placeholder = 'Cerca un indirizzo o un luogo';
        big.results = el('div', 'margin-top:6px;display:flex;flex-direction:column');
        const here = el('button', BTN + ';margin-top:10px;width:100%;background:rgba(255,255,255,.12)', 'La mia posizione');
        side.append(big.search, big.results, here,
            el('div', 'margin-top:10px;opacity:.65;font-size:12px', 'Trascina per spostarti, rotella per ingrandire, clic sulla mappa per mettere la partenza'));
        big.box.appendChild(side);

        const zoom = el('div', 'position:absolute;right:20px;top:20px;display:flex;flex-direction:column;gap:8px');
        for (const [label, d] of [['+', 1], ['\u2212', -1]]) {
            const b = el('button', CARD + ';width:44px;height:44px;border:0;font-size:24px;cursor:pointer', label);
            b.onclick = e => { e.stopPropagation(); zoomAt(big.canvas.clientWidth / 2, big.canvas.clientHeight / 2, d); };
            zoom.appendChild(b);
        }
        big.box.appendChild(zoom);

        big.bar = el('div', CARD + ';position:absolute;left:50%;bottom:34px;transform:translateX(-50%);padding:10px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;max-width:92%;box-sizing:border-box');
        big.msg = el('div', 'padding:0 8px;opacity:.9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', 'Cerca un luogo o fai clic sulla mappa');
        big.go = el('button', BTN + ';background:#3e8bff', 'Parti da qui');
        big.go.dataset.simStart = '';
        big.go.disabled = true;
        big.close = el('button', BTN + ';background:rgba(255,255,255,.12)', 'Chiudi (M)');
        big.nav = el('button', BTN + ';background:#1f8a4c;display:none', 'Naviga fin qui');
        big.nav.disabled = true;
        big.bar.append(big.msg, big.nav, big.go, big.close);
        big.box.appendChild(big.bar);
        big.credits = el('div', 'position:absolute;right:10px;bottom:6px;font-size:11px;opacity:.6;color:#fff;pointer-events:none', CREDITS);
        big.box.appendChild(big.credits);
        document.body.appendChild(big.box);
        // Phones held sideways have little height: everything smaller, the bar in a corner
        if (innerHeight < 520) {
            side.style.cssText += ';padding:10px;width:min(300px, 44%);top:10px;left:10px';
            side.firstChild.style.display = 'none';
            side.lastChild.style.display = 'none';
            here.style.marginTop = '6px';
            big.search.style.padding = '9px 10px';
            Object.assign(big.bar.style, { left: '', right: '10px', bottom: '22px', transform: 'none', maxWidth: '52%', padding: '8px', gap: '6px' });
            big.msg.style.cssText += ';width:100%;padding:0 4px;font-size:13px';
            for (const b of [big.nav, big.go, big.close]) Object.assign(b.style, { padding: '9px 12px', fontSize: '13px' });
            Object.assign(big.credits.style, { fontSize: '9px', left: '10px', right: '', maxWidth: '45%' });
            Object.assign(zoom.style, { top: '10px', right: '10px' });
        }

        big.close.onclick = () => closeMap();
        big.nav.onclick = () => navigate(big.spawn, big.label);
        big.go.onclick = async () => {
            Engine.start();
            if (touch) fullscreen(true);
            closeMap(true);
            if (!await osmSim.startFree({ lat: big.spawn[0], lon: big.spawn[1] })) {
                openMap();
                big.msg.textContent = 'Nessuna strada entro 300 m: scegli un altro punto';
            }
            town.at = 0;
        };
        here.onclick = () => {
            big.msg.textContent = 'Cerco la tua posizione\u2026';
            navigator.geolocation.getCurrentPosition(
                p => jump(p.coords.latitude, p.coords.longitude, 'La tua posizione'),
                () => { big.msg.textContent = 'Posizione non disponibile: cerca un luogo'; },
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
                    // lang=default keeps the local names; Photon has no Italian setting
                    const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=default&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`);
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
                            jump(f.geometry.coordinates[1], f.geometry.coordinates[0], label.main + (label.sub ? ', ' + label.sub : ''));
                        };
                        big.results.appendChild(item);
                    }
                    if (!feats.length) big.results.innerHTML = '<div style="opacity:.6;padding:8px">Nessun risultato</div>';
                } catch (err) {
                    big.results.innerHTML = '<div style="opacity:.6;padding:8px">Ricerca non disponibile</div>';
                }
            }, 350);
        });

        big.canvas.addEventListener('wheel', e => {
            e.preventDefault();
            zoomAt(e.offsetX, e.offsetY, -e.deltaY * 0.003);
        }, { passive: false });
        // Mouse, touch and pen alike: one pointer drags, two pinch, a tap without moving picks the point
        const pointers = new Map();
        big.canvas.style.touchAction = 'none';
        big.canvas.addEventListener('pointerdown', e => {
            big.canvas.setPointerCapture(e.pointerId);
            pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
            if (pointers.size === 1) big.drag = { x: e.clientX, y: e.clientY, cx: big.cx, cy: big.cy, moved: false };
            else if (pointers.size === 2) {
                const [a, b] = [...pointers.values()];
                big.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: big.zoom };
                if (big.drag) big.drag.moved = true;
            }
            big.box.style.cursor = 'grabbing';
        });
        big.canvas.addEventListener('pointermove', e => {
            if (!pointers.has(e.pointerId)) return;
            pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
            if (pointers.size === 2 && big.pinch) {
                const [a, b] = [...pointers.values()];
                const want = big.pinch.zoom + Math.log2(Math.hypot(a.x - b.x, a.y - b.y) / big.pinch.d);
                zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, want - big.zoom);
                return;
            }
            const d = big.drag;
            if (!d) return;
            if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) d.moved = true;
            const scale = TILE_PX * 2 ** big.zoom;
            big.cx = d.cx - (e.clientX - d.x) / scale;
            big.cy = d.cy - (e.clientY - d.y) / scale;
            big.dirty = true;
        });
        const release = e => {
            if (!pointers.has(e.pointerId)) return;
            pointers.delete(e.pointerId);
            if (pointers.size) return;
            const d = big.drag;
            big.drag = big.pinch = null;
            big.box.style.cursor = 'grab';
            if (!d || d.moved || e.type === 'pointercancel') return;
            // Only roads can be picked: the point moves onto the nearest one in reach
            const p = snapToRoad(e.offsetX, e.offsetY);
            if (!p) {
                big.msg.textContent = 'Tocca una strada';
                return;
            }
            const scale = TILE_PX * 2 ** big.zoom, W = big.canvas.clientWidth, H = big.canvas.clientHeight;
            setSpawn(latLon(big.cx + (p[0] - W / 2) / scale, big.cy + (p[1] - H / 2) / scale), null);
        };
        big.canvas.addEventListener('pointerup', release);
        big.canvas.addEventListener('pointercancel', release);
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
        big.label = label || '';
        big.go.disabled = big.nav.disabled = false;
        big.dirty = true;
        big.msg.textContent = label || 'Punto scelto';
        if (label) return;
        const p = await reverse(ll[0], ll[1]);
        if (p && big.spawn === ll) big.msg.textContent = big.label = [p.street || p.name, p.city].filter(Boolean).join(', ');
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
        // Labels: street names when close, places always
        const taken = [];
        const free = (x, y, w, h) => {
            if (taken.some(r => x < r[0] + r[2] && x + w > r[0] && y < r[1] + r[3] && y + h > r[1])) return false;
            taken.push([x, y, w, h]);
            return true;
        };
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        for (const { x, y, t } of tiles) {
            const l = t.ready && t.layers.place;
            if (!l) continue;
            const P = tileProjector(x, y, z, l.extent, scale, W, H);
            for (const f of l.features) {
                const name = f.props.name, cls = f.props.class;
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
                    const name = f.props.name || f.props.ref;
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
                    if (f.props.name && big.zoom >= 16.5) {
                        const w = g.measureText(f.props.name).width;
                        if (free(sx + 8, sy - 7, w, 14)) halo(g, f.props.name, sx + 8, sy, '#e8ecf1');
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
        if (nav.on) {
            g.strokeStyle = '#3e8bff';
            g.lineWidth = 6;
            g.beginPath();
            nav.ll.forEach((p, i) => { const [sx, sy] = toScreen(p[0], p[1]); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); });
            g.stroke();
            const [dx, dy] = toScreen(nav.dest[0], nav.dest[1]);
            g.fillStyle = '#1f8a4c';
            g.beginPath();
            g.arc(dx, dy, 9, 0, 7);
            g.fill();
        }
        const f = osmSim.free;
        if (f.on) {
            const ll = OsmMatch.unproject(f.x, f.y), [sx, sy] = toScreen(ll.lat, ll.lon);
            arrow(g, sx, sy, f.brg * RAD, 1.2);
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
        big.box.style.display = 'block';
        big.close.style.display = f.on ? '' : 'none';
        // Before a drive there is one thing to do; while driving, going somewhere comes first and starting over second
        big.nav.style.display = f.on ? '' : 'none';
        big.go.textContent = f.on ? 'Riparti da qui' : 'Parti da qui';
        big.go.style.background = f.on ? 'rgba(255,255,255,.12)' : '#3e8bff';
        // Keys go to the map while it is open, not to the car
        f.paused = true;
        f.keys.clear();
    }

    // Without a drive there is nothing behind the map: it stays until a start is chosen
    function closeMap(force) {
        if (!osmSim.free.on && !force) return;
        big.open = false;
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
        const b = f.brg * RAD, cos = Math.cos(b), sin = Math.sin(b), s = dpr / mini.mpp;
        // Heading up: the direction of travel maps to the top of the circle
        const P = (px, py) => {
            const dx = (px - f.x) * s, dy = (py - f.y) * s;
            return [R + dx * cos - dy * sin, R - (dx * sin + dy * cos)];
        };
        const edges = OsmMatch.edgesNear(f.x, f.y, R / s * 1.42), k = dpr * Math.min(1.8, Math.max(0.5, 2.2 / mini.mpp));
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
        if (nav.on) {
            g.strokeStyle = 'rgba(62,139,255,.9)';
            g.lineWidth = 5 * dpr;
            g.beginPath();
            nav.pts.forEach((p, i) => { const [x, y] = P(p.x, p.y); i ? g.lineTo(x, y) : g.moveTo(x, y); });
            g.stroke();
        }
        arrow(g, R, R, 0, dpr);
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

    // ================= Road and town, gear, back to the road =================
    const town = { name: '', at: 0, x: 0, y: 0 };
    async function reverse(lat, lon) {
        try {
            const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&lang=default&limit=1`);
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
        if (p) town.name = p.city || (p.type === 'city' ? p.name : '') || p.county || '';
    }

    let roadBox, backBtn;
    // Plain text with a shadow, no card: it informs without competing with the road
    const QUIET = 'color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.9),0 0 10px rgba(0,0,0,.6);font-family:system-ui,sans-serif;pointer-events:none';
    function buildHud() {
        roadBox = el('div', QUIET + ';position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:400;display:none;text-align:center;white-space:nowrap;opacity:.9');
        document.body.appendChild(roadBox);
        backBtn = el('button', BTN + ';position:fixed;left:50%;top:96px;transform:translateX(-50%);z-index:400;background:#3e8bff;display:none;'
            + 'box-shadow:0 6px 24px rgba(0,0,0,.45)', 'Torna sulla strada (R)');
        backBtn.onclick = () => { backBtn.blur(); osmSim.backToRoad(); };
        document.body.appendChild(backBtn);
    }

    function drawHud(now) {
        const f = osmSim.free, t = f.on && f.road;
        roadBox.style.display = f.on && (t || town.name) ? 'block' : 'none';
        if (f.on) {
            let line = '';
            if (t) {
                const ref = t.ref ? `<span style="background:${/^A\d/.test(t.ref) ? '#1f8a4c' : '#2a6fdb'};border-radius:4px;padding:1px 6px;font-size:12px;margin-right:6px;text-shadow:none">${escapeHtml(t.ref)}</span>` : '';
                line = ref + escapeHtml(t.name || (t.ref ? '' : 'Strada senza nome'));
            } else {
                line = '<span style="opacity:.75">Fuori strada</span>';
            }
            const html = `<div style="font-size:15px;font-weight:600">${line}</div>`
                + (town.name ? `<div style="font-size:12px;opacity:.8;margin-top:1px">${escapeHtml(town.name)}</div>` : '');
            if (roadBox.innerHTML !== html) roadBox.innerHTML = html;
        }
        backBtn.style.display = f.on && f.offSince && now - f.offSince > 4000 ? 'block' : 'none';
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
    const nav = { on: false, dest: null, label: '', pts: [], S: [], T: [], man: [], ll: [], i: 0, off: 0, arrivedAt: 0 };
    let navBox;

    async function navigate(dest, label) {
        const f = osmSim.free;
        if (!f.on || !dest) return;
        const from = OsmMatch.unproject(f.x, f.y), to = OsmMatch.project(dest[0], dest[1]);
        const dist = Math.hypot(to.x - f.x, to.y - f.y);
        if (dist > 60000) { big.msg.textContent = 'Troppo lontano: scegli una meta entro 60 km'; return; }
        closeMap(true);
        // Roads along the straight line, wider for longer trips, before searching the route
        const pts = [], n = Math.max(1, Math.ceil(dist / 1500));
        for (let k = 0; k <= n; k++) pts.push({ lat: from.lat + (dest[0] - from.lat) * k / n, lon: from.lon + (dest[1] - from.lon) * k / n });
        f.paused = true;
        await osmSim.prepare(pts, dist > 3000 ? 2 : 1, 0);
        f.paused = false;
        Object.assign(nav, { dest, label: label || 'Destinazione' });
        if (!route()) flash('Percorso non trovato verso ' + nav.label);
    }

    function route() {
        const f = osmSim.free, to = OsmMatch.project(nav.dest[0], nav.dest[1]);
        const path = OsmMatch.route({ x: f.x, y: f.y }, to);
        if (!path || !path.length) { stopNav(); return false; }
        const pts = [], S = [0], T = [0];
        const first = path[0];
        pts.push(first.fwd ? { x: first.e.ax, y: first.e.ay } : { x: first.e.bx, y: first.e.by });
        for (const st of path) {
            const p = st.fwd ? { x: st.e.bx, y: st.e.by } : { x: st.e.ax, y: st.e.ay };
            const v = OsmMatch.roadSpeed(st.e) / 3.6;
            st.s0 = S[S.length - 1];
            pts.push(p);
            S.push(S[S.length - 1] + st.e.len);
            T.push(T[T.length - 1] + st.e.len / v);
        }
        // Turns at junctions, like a navigation app says them
        const man = [];
        for (let k = 1; k < path.length; k++) {
            const a = path[k - 1], b = path[k], id = a.fwd ? a.e.b : a.e.a;
            if ((OsmMatch.nodes.get(id) || { edges: [] }).edges.length < 3) continue;
            const turn = OsmMatch.turnOf(a.fwd ? a.e.brg : a.e.brg + 180, b.fwd ? b.e.brg : b.e.brg + 180);
            if (Math.abs(turn) < 25) continue;
            const name = b.e.tags.name || b.e.tags.ref;
            man.push({ s: b.s0, dir: turn < 0 ? 1 : -1, angle: Math.round(Math.abs(turn)), text: `Svolta a ${turn < 0 ? 'sinistra' : 'destra'}${name ? ' in ' + name : ''}` });
        }
        man.push({ s: S[S.length - 1], dir: 0, angle: 0, text: 'Arrivo a ' + nav.label });
        Object.assign(nav, { on: true, pts, S, T, man, i: 0, off: 0, ll: pts.map(p => (q => [q.lat, q.lon])(OsmMatch.unproject(p.x, p.y))) });
        big.dirty = true;
        return true;
    }

    function stopNav() {
        nav.on = false;
        setUpcomingTurn(null);
        setTripInfo(null);
    }

    const roundDist = m => m >= 1000 ? Math.round(m / 100) * 100 : m >= 300 ? Math.round(m / 50) * 50 : Math.round(m / 10) * 10;
    const fmtDist = m => m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : roundDist(m) + ' m';

    function guide(now) {
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
        const s = nav.S[best.i] + (nav.S[best.i + 1] - nav.S[best.i]) * best.t, left = nav.S[nav.S.length - 1] - s;
        if (left < 25) {
            stopNav();
            flash('Sei arrivato a ' + nav.label);
            return;
        }
        // Off the route for a few seconds: a new route from here
        if (best.d > 40) {
            nav.off = nav.off || now;
            if (now - nav.off > 4000 && !route()) flash('Percorso non trovato');
        } else nav.off = 0;
        const m = nav.man.find(m => m.s > s - 5), meters = Math.max(0, m.s - s);
        setUpcomingTurn(m.dir ? { dir: m.dir, angle: m.angle, meters: roundDist(meters) } : null);
        const glyph = m.dir === 0 ? '⚑' : m.dir > 0 ? (m.angle > 120 ? '↶' : m.angle < 45 ? '↖' : '↰') : (m.angle > 120 ? '↷' : m.angle < 45 ? '↗' : '↱');
        const html = `<div style="font-size:24px;width:30px;text-align:center">${glyph}</div><div><div style="font-size:17px;font-weight:700">${fmtDist(meters)}</div>`
            + `<div style="font-size:12px;opacity:.85">${escapeHtml(m.text)}</div></div>`;
        if (navBox.firstChild.innerHTML !== html) navBox.firstChild.innerHTML = html;
        const k = nav.T.length - 1, timeLeft = nav.T[k] - (nav.T[best.i] + (nav.T[best.i + 1] - nav.T[best.i]) * best.t);
        const eta = new Date(Date.now() + timeLeft * 1000);
        setTripInfo({ arrivalLabel: 'ARRIVO', arrival: eta.toTimeString().slice(0, 5), remainingLabel: 'DISTANZA', remaining: fmtDist(left) });
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
        stopBtn.title = 'Termina la navigazione';
        stopBtn.onclick = () => { stopBtn.blur(); stopNav(); };
        navBox.append(stopBtn);
        document.body.appendChild(navBox);
        toastBox = el('div', 'position:fixed;left:50%;top:58px;transform:translateX(-50%);z-index:1500;padding:6px 14px;font:600 14px system-ui,sans-serif;'
            + 'color:#fff;background:rgba(14,18,24,.6);border-radius:10px;max-width:70%;text-align:center;opacity:0;transition:opacity .4s;pointer-events:none');
        document.body.appendChild(toastBox);
    }

    // ================= Touch controls on phones and tablets =================
    const touch = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || new URLSearchParams(location.search).has('touch');
    let touchPad = null;
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
        document.body.appendChild(pad);
        touchPad = pad;
        // The minimap and the gear move up, out of the thumbs' way
        Object.assign(mini.box.style, { width: '130px', height: '130px', left: '16px', top: '16px', bottom: '' });
        Object.assign(mini.canvas.style, { width: '130px', height: '130px' });
        Object.assign(mini.zoom.style, { left: '156px', top: '16px', bottom: '' });
        // Directions on the left under the minimap, off the road ahead
        Object.assign(navBox.style, { left: '16px', top: '156px' });
        backBtn.style.top = '172px';
        backBtn.textContent = 'Torna sulla strada';
    }

    function loop(now) {
        requestAnimationFrame(loop);
        const dt = Math.min(0.1, (now - (loop.last || now)) / 1000);
        loop.last = now;
        if (now - mini.at > 50) {
            mini.at = now;
            drawMini();
            drawHud(now);
            updateTown(now);
            guide(now);
            if (touchPad) touchPad.style.display = osmSim.free.on && !big.open ? 'block' : 'none';
        }
        updateRain(dt);
        if (now - sky.at > 60000) applySky(now);
        if (big.open && (big.dirty || osmSim.free.on)) drawBig();
    }

    function buildOptions() {
        const box = el('div', CARD + ';position:fixed;right:16px;top:16px;z-index:400;padding:8px;display:flex;flex-direction:column;gap:6px;font-size:13px');
        const mapBtn = el('button', BTN + ';background:#3e8bff;padding:8px 10px;font-size:13px', 'Mappa (M)');
        mapBtn.onclick = () => { mapBtn.blur(); openMap(); };
        const seg = el('div', 'display:flex;background:rgba(255,255,255,.1);border-radius:9px;padding:2px');
        const modes = [['day', 'Giorno'], ['night', 'Notte'], ['auto', 'Auto']].map(([m, label]) => {
            const b = el('button', 'flex:1;border:0;border-radius:7px;padding:6px 9px;color:#fff;font:13px system-ui,sans-serif;cursor:pointer;background:transparent', label);
            b.onclick = () => { sky.mode = m; paint(); applySky(performance.now()); b.blur(); };
            seg.appendChild(b);
            return [m, b];
        });
        const paint = () => modes.forEach(([m, b]) => { b.style.background = sky.mode === m ? '#3e8bff' : 'transparent'; });
        paint();
        const audio = el('button', 'display:flex;justify-content:space-between;gap:14px;align-items:center;background:transparent;color:#fff;border:0;'
            + 'padding:6px 6px;border-radius:8px;font:13px system-ui,sans-serif;cursor:pointer');
        const dot = el('span', 'width:30px;height:16px;border-radius:8px;position:relative'), knob = el('span', 'position:absolute;top:2px;width:12px;height:12px;border-radius:50%;background:#fff');
        dot.appendChild(knob);
        audio.append(el('span', '', 'Audio motore'), dot);
        const paintAudio = () => { dot.style.background = Engine.on ? '#3e8bff' : 'rgba(255,255,255,.25)'; knob.style.left = Engine.on ? '16px' : '2px'; };
        audio.onclick = () => { Engine.on = !Engine.on; if (Engine.on) Engine.start(); paintAudio(); audio.blur(); };
        paintAudio();
        const wseg = el('div', 'display:flex;background:rgba(255,255,255,.1);border-radius:9px;padding:2px');
        const wmodes = [['clear', 'Sereno'], ['fog', 'Nebbia'], ['rain', 'Pioggia']].map(([m, label]) => {
            const b = el('button', 'flex:1;border:0;border-radius:7px;padding:6px 9px;color:#fff;font:13px system-ui,sans-serif;cursor:pointer;background:transparent', label);
            b.onclick = () => { weather.mode = m; paintW(); applySky(performance.now()); b.blur(); };
            wseg.appendChild(b);
            return [m, b];
        });
        const paintW = () => wmodes.forEach(([m, b]) => { b.style.background = weather.mode === m ? '#3e8bff' : 'transparent'; });
        paintW();
        const back = el('button', BTN + ';background:rgba(255,255,255,.1);padding:7px 10px;font-size:13px;font-weight:400', 'Torna sulla strada (R)');
        back.onclick = () => {
            back.blur();
            if (!osmSim.free.on) return;
            flash(osmSim.backToRoad() ? 'Di nuovo sulla strada pi\u00f9 vicina' : 'Nessuna strada entro 1 km');
            if (touch) box.style.display = 'none';
        };
        if (touch) back.textContent = 'Torna sulla strada';
        const fs = el('button', BTN + ';background:rgba(255,255,255,.1);padding:7px 10px;font-size:13px;font-weight:400', 'Schermo intero');
        fs.onclick = () => { fs.blur(); fullscreen(!(document.fullscreenElement || document.webkitFullscreenElement)); };
        box.append(mapBtn, seg, wseg, audio, back, fs);
        document.body.appendChild(box);
        // On phones the options fold behind a button next to the map's
        if (touch) {
            box.style.display = 'none';
            box.style.top = '64px';
            box.style.zIndex = '460';
            const bar = el('div', 'position:fixed;right:16px;top:16px;z-index:401;display:flex;gap:8px');
            const map2 = el('button', BTN + ';background:#3e8bff;padding:9px 14px;font-size:13px', 'Mappa');
            const more = el('button', BTN + ';background:rgba(14,18,24,.88);padding:9px 14px;font-size:13px', 'Opzioni');
            map2.onclick = () => openMap();
            more.onclick = () => { box.style.display = box.style.display === 'none' ? 'flex' : 'none'; };
            bar.append(map2, more);
            document.body.appendChild(bar);
            mapBtn.style.display = 'none';
        }
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
    });

    window.addEventListener('load', () => setTimeout(async () => {
        // Same setup as the bundled model in the app
        setModelConfig({
            yaw: 0, colors: {}, park: { az: -0.637, h: 0.662, d: 4.426 }, drive: { az: -3.14159, h: 1.62, d: 6.015 },
            roadYaw: 0, lights: { L: { f: 1.682, l: 0.482, y: 0.2256 }, R: { f: 1.682, l: -0.482, y: 0.2256 }, yaw: 0 }
        });
        loadModelFromUri('kiri10.glb');
        setRoadLinesConfig(true, 'left_dashed');
        setLocalizedStrings({ loading: 'Caricamento...', loadingProgress: 'Caricamento... {0}%', errorLoading: 'Errore', speedLabel: 'VELOCIT\u00c0', speedUnit: 'km/h' });
        const credit = document.getElementById('mapAttribution');
        if (credit) credit.textContent = '\u00a9 OpenStreetMap contributors \u00b7 \u00a9 OpenMapTiles \u00b7 OpenFreeMap';
        await osmSim.ready;
        buildBig();
        buildMini();
        buildHud();
        buildOptions();
        buildExtras();
        if (touch) buildTouch();
        [big.cx, big.cy] = world(START.lat, START.lon);
        applySky(performance.now());
        openMap();
        requestAnimationFrame(loop);
    }, 0));
})();
