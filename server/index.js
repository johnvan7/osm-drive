// Realtime world for OSM Drive: every player on one map, each told precisely about the few players near them and
// roughly about the rest. The pace is the clients': each update a player sends is answered with what it should know,
// so there are no timers and the world sleeps (hibernates) when nobody is driving
import { DurableObject } from 'cloudflare:workers';

const NEAR = 500;          // m: within this, full updates
const PLANE_NEAR = 4000;   // m: planes are seen from much farther
const MAX_NEAR = 12;       // at most this many, the nearest; a crowd beyond them is only counted
const FAR_EVERY = 5000;    // ms between the rough list of everyone else, for the map
const FAR_MAX = 200;       // nearest players in that list
const STALE = 15000;       // ms without an update: left out
const MAX_PLAYERS = 1000;
const MAP_EXACT = 14;      // map zoom from which players are shown one by one, where they are
const MAP_MAX = 300;       // at most this many dots or groups in a map answer
const CELL_LAT = 0.005, CELL_LON = 0.007;   // about 550 m in Italy
const M_PER_DEG = 111320;
// Pages that may join: the game on this Worker, and on a local server
const ORIGINS = [/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/];

export default {
    async fetch(req, env) {
        const url = new URL(req.url);
        if (url.pathname === '/ws') {
            if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
            const origin = req.headers.get('Origin') || '';
            if (origin && origin !== url.origin && !ORIGINS.some(o => o.test(origin))) return new Response('Forbidden', { status: 403 });
            return env.WORLD.get(env.WORLD.idFromName('world')).fetch(req);
        }
        return new Response('Not found', { status: 404 });
    }
};

const cellOf = (lat, lon) => Math.floor(lat / CELL_LAT) + ',' + Math.floor(lon / CELL_LON);
const dist = (a, b) => Math.hypot((a.lat - b.lat) * M_PER_DEG, (a.lon - b.lon) * M_PER_DEG * Math.cos(a.lat * Math.PI / 180));
const round6 = x => Math.round(x * 1e6) / 1e6;
// Printable, short, no markup
const cleanName = s => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 20);

export class World extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.players = new Map();   // ws -> player
        this.cells = new Map();     // cell -> Set(player)
        this.flying = new Set();    // the players in a plane
        // Back from hibernation: who is connected is kept with each socket
        for (const ws of ctx.getWebSockets()) {
            const p = ws.deserializeAttachment();
            if (p) this.add(ws, { ...p, known: new Set(), farAt: 0, tokens: 10, tokenAt: Date.now() });
        }
        // Keep-alives answered without waking the world
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }

    async fetch() {
        if (this.players.size >= MAX_PLAYERS) return new Response('Full', { status: 503 });
        const [client, server] = Object.values(new WebSocketPair());
        const id = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
        // Tagged with the player's id: another player's message reaches it through the context, not this request
        this.ctx.acceptWebSocket(server, [id]);
        this.add(server, { id, name: '', lat: null, lon: null, b: 0, v: 0, g: 0, t: 0, known: new Set(), farAt: 0, tokens: 10, tokenAt: Date.now() });
        this.save(server);
        server.send(JSON.stringify({ t: 'w', id }));
        return new Response(null, { status: 101, webSocket: client });
    }

    add(ws, p) {
        this.players.set(ws, p);
        if (p.k) this.flying.add(p);
        if (p.lat != null) this.place(p);
    }

    save(ws) {
        const p = this.players.get(ws);
        ws.serializeAttachment({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, b: p.b, v: p.v, g: p.g, t: p.t, a: p.a, k: p.k });
    }

    place(p) {
        const c = cellOf(p.lat, p.lon);
        if (p.cell === c) return;
        if (p.cell) this.cells.get(p.cell)?.delete(p);
        if (!this.cells.has(c)) this.cells.set(c, new Set());
        this.cells.get(c).add(p);
        p.cell = c;
    }

    remove(ws) {
        const p = this.players.get(ws);
        if (!p) return;
        if (p.cell) {
            const s = this.cells.get(p.cell);
            s?.delete(p);
            if (s && !s.size) this.cells.delete(p.cell);
        }
        this.flying.delete(p);
        this.players.delete(ws);
    }

    async webSocketMessage(ws, data) {
        const p = this.players.get(ws);
        if (!p || typeof data !== 'string' || data.length > 300) return;
        // At most about 10 messages a second each
        const now = Date.now();
        p.tokens = Math.min(10, p.tokens + (now - p.tokenAt) / 100);
        p.tokenAt = now;
        if (p.tokens < 1) return;
        p.tokens--;
        let m;
        try { m = JSON.parse(data); } catch (err) { return; }
        if (m.t === 'hi') {
            const name = cleanName(m.name) || 'Pilota';
            // A new name: everyone who knew the old one is told again
            if (name !== p.name) for (const o of this.players.values()) o.known.delete(p.id);
            p.name = name;
            this.save(ws);
            return;
        }
        if (m.t === 'm' && Array.isArray(m.b)) {
            ws.send(JSON.stringify(this.map(p, m.b.map(Number), Number(m.z), now)));
            return;
        }
        // A horn, to whoever is near enough to hear it (they work out how loud and how late)
        if (m.t === 'h') {
            if (p.lat == null || now - p.t > STALE) return;
            const out = JSON.stringify({ t: 'h', id: p.id, on: m.on ? 1 : 0, lat: round6(p.lat), lon: round6(p.lon) });
            for (const o of this.around(p, now)) {
                if (o.d >= NEAR) continue;
                for (const to of this.ctx.getWebSockets(o.o.id)) try { to.send(out); } catch (err) { /* closing */ }
            }
            return;
        }
        if (m.t !== 's' || !Array.isArray(m.s)) return;
        const [lat, lon, b, v, g, a, k] = m.s.map(Number);
        if (!(Math.abs(lat) <= 85 && Math.abs(lon) <= 180) || !Number.isFinite(b) || !Number.isFinite(v)) return;
        // A plane also tells its altitude above the sea
        const plane = k === 1 && Number.isFinite(a);
        Object.assign(p, { lat, lon, b: ((b % 360) + 360) % 360, v: Math.max(-20, Math.min(100, v)), g: g ? 1 : 0, t: now, k: plane ? 1 : 0, a: plane ? Math.max(-500, Math.min(9000, Math.round(a))) : null });
        if (p.k) this.flying.add(p); else this.flying.delete(p);
        this.place(p);
        this.save(ws);
        ws.send(JSON.stringify(this.view(p, now)));
    }

    // The players in the 3 x 3 cells around p, with their distance
    around(p, now) {
        const out = [];
        const ci = Math.floor(p.lat / CELL_LAT), cj = Math.floor(p.lon / CELL_LON);
        for (let i = ci - 1; i <= ci + 1; i++) {
            for (let j = cj - 1; j <= cj + 1; j++) {
                for (const o of this.cells.get(i + ',' + j) || []) if (o !== p && now - o.t <= STALE) out.push({ o, d: dist(p, o) });
            }
        }
        return out;
    }

    // What p should know now: the nearest up to MAX_NEAR in full, how many are around, and now and then everyone else
    view(p, now) {
        const near = this.around(p, now).filter(n => n.d < NEAR);
        const crowd = near.length;
        // Planes, seen from farther than cars
        const seen = new Set(near.map(n => n.o));
        for (const o of this.flying) {
            if (o === p || seen.has(o) || o.lat == null || now - o.t > STALE) continue;
            const d = dist(p, o);
            if (d < PLANE_NEAR) near.push({ o, d });
        }
        near.sort((a, b) => a.d - b.d);
        const shown = near.slice(0, MAX_NEAR);
        const out = { t: 'u', c: crowd, n: shown.map(({ o }) => [o.id, round6(o.lat), round6(o.lon), Math.round(o.b), Math.round(o.v * 10) / 10, o.g, now - o.t, o.a ?? null, o.k || 0]) };
        const names = {};
        for (const { o } of shown) if (!p.known.has(o.id)) { names[o.id] = o.name; p.known.add(o.id); }
        if (now - p.farAt > FAR_EVERY) {
            p.farAt = now;
            const ids = new Set(shown.map(s => s.o.id)), far = [];
            for (const o of this.players.values()) if (o !== p && o.lat != null && now - o.t <= STALE && !ids.has(o.id)) far.push({ o, d: dist(p, o) });
            far.sort((a, b) => a.d - b.d);
            out.f = far.slice(0, FAR_MAX).map(({ o }) => {
                if (!p.known.has(o.id)) { names[o.id] = o.name; p.known.add(o.id); }
                return [o.id, round6(o.lat), round6(o.lon)];
            });
            out.total = [...this.players.values()].filter(o => o.lat != null && now - o.t <= STALE).length;
        }
        if (Object.keys(names).length) out.names = names;
        return out;
    }

    // The players in a map's view [south, west, north, east]: close up each one where it is, with its name; farther out
    // groups on a grid of about a sixteenth of the view (never under ~1 km), at the grid's centre, so nobody's exact
    // position shows
    map(p, [s, w, n, e], z, now) {
        const out = { t: 'm', total: 0 };
        if (![s, w, n, e, z].every(Number.isFinite) || n <= s) return out;
        const all = [...this.players.values()].filter(o => o.lat != null && now - o.t <= STALE);
        out.total = all.length;
        const inView = all.filter(o => o !== p && o.lat >= s && o.lat <= n && (w <= e ? o.lon >= w && o.lon <= e : o.lon >= w || o.lon <= e));
        if (z >= MAP_EXACT) {
            const cy = (s + n) / 2, cx = (w + e) / 2;
            inView.sort((a, b) => Math.hypot(a.lat - cy, a.lon - cx) - Math.hypot(b.lat - cy, b.lon - cx));
            out.p = inView.slice(0, MAP_MAX).map(o => [o.id, o.name, round6(o.lat), round6(o.lon), Math.round(o.b)]);
            return out;
        }
        const cell = Math.max(0.01, (n - s) / 16), groups = new Map();
        for (const o of inView) {
            const i = Math.floor(o.lat / cell), j = Math.floor(o.lon / cell), k = i + ',' + j;
            const g = groups.get(k) || { i, j, n: 0, id: o.id, name: o.name };
            g.n++;
            groups.set(k, g);
        }
        out.c = [...groups.values()].sort((a, b) => b.n - a.n).slice(0, MAP_MAX)
            .map(g => [round6((g.i + 0.5) * cell), round6((g.j + 0.5) * cell), g.n, g.n === 1 ? g.id : null, g.n === 1 ? g.name : null]);
        return out;
    }

    async webSocketClose(ws) { this.remove(ws); }
    async webSocketError(ws) { this.remove(ws); }
}
