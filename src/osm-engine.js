// Engine sound for the simulator, synthesized with Web Audio: a four-cylinder following the car's revs and shifts
(() => {
    const REDLINE = 6300;
    const E = { on: true, ctx: null };

    function init() {
        const ctx = E.ctx = new AudioContext();
        E.master = ctx.createGain();
        E.master.gain.value = 0;
        E.master.connect(ctx.destination);
        E.filter = ctx.createBiquadFilter();
        E.filter.type = 'lowpass';
        E.filter.Q.value = 3;
        E.filter.connect(E.master);
        // Soft clipping gives the exhaust its grit
        const shaper = ctx.createWaveShaper(), curve = new Float32Array(1024);
        for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(3 * (i / 512 - 1));
        shaper.curve = curve;
        shaper.connect(E.filter);
        // Firing pulses, the half-order rumble and a slightly detuned overtone
        E.oscs = [['sawtooth', 1, 0.45], ['square', 0.5, 0.3], ['sawtooth', 2.003, 0.12]].map(([type, mul, level]) => {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.type = type;
            g.gain.value = level;
            o.connect(g);
            g.connect(shaper);
            o.start();
            return { o, mul };
        });
        // Intake hiss, louder with the throttle open
        const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = noise.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource(), band = ctx.createBiquadFilter();
        src.buffer = noise;
        src.loop = true;
        band.type = 'bandpass';
        band.frequency.value = 1400;
        band.Q.value = 0.7;
        E.hiss = ctx.createGain();
        E.hiss.gain.value = 0;
        src.connect(band);
        band.connect(E.hiss);
        E.hiss.connect(E.master);
        src.start();

        // Road and weather, on the same noise: wind and tyres grow with speed, squeal under hard braking, rain
        const chain = (type, freq, q) => {
            const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
            s.buffer = noise;
            s.loop = true;
            s.playbackRate.value = 0.5 + Math.random();
            f.type = type;
            f.frequency.value = freq;
            f.Q.value = q;
            g.gain.value = 0;
            s.connect(f);
            f.connect(g);
            g.connect(ctx.destination);
            s.start();
            return g;
        };
        E.wind = chain('lowpass', 500, 0.7);
        E.tyres = chain('bandpass', 260, 1.2);
        E.squeal = chain('bandpass', 2300, 8);
        E.rainGain = chain('highpass', 2500, 0.5);
        E.noise = noise;
    }

    // One-off bursts: a crash thud, the fuel pump
    function burst(freq, q, dur, level) {
        if (!E.ctx) return;
        const ctx = E.ctx, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(), t = ctx.currentTime;
        s.buffer = E.noise;
        f.type = 'bandpass';
        f.frequency.value = freq;
        f.Q.value = q;
        g.gain.setValueAtTime(level, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        s.connect(f);
        f.connect(g);
        g.connect(ctx.destination);
        s.start(t);
        s.stop(t + dur);
    }
    E.crash = strength => burst(120, 0.8, 0.5, Math.min(1.2, 0.3 + strength * 0.08));
    // Filling up: the nozzle's clunk, and a chime when the tank is full
    E.pump = () => burst(500, 3, 0.25, 0.4);
    E.ding = () => { burst(1700, 25, 0.25, 0.35); setTimeout(() => burst(2270, 25, 0.35, 0.3), 140); };

    // A horn: two tones a major third apart, like a car's pair. Far away it comes later (sound at 343 m/s), quieter
    // and duller, from its side. Returns the stop, also heard `delay` late
    E.horn = ({ gain = 0.22, pan = 0, delay = 0, cutoff = 3500, pitch = 1 } = {}) => {
        if (!E.ctx) return () => {};
        const ctx = E.ctx, t = ctx.currentTime + delay, out = ctx.createGain(), lp = ctx.createBiquadFilter(), side = ctx.createStereoPanner();
        lp.type = 'lowpass';
        lp.frequency.value = cutoff;
        side.pan.value = Math.max(-1, Math.min(1, pan));
        out.gain.setValueAtTime(0, t);
        out.gain.linearRampToValueAtTime(gain, t + 0.02);
        out.connect(lp);
        lp.connect(side);
        side.connect(ctx.destination);
        const oscs = [415, 520].map(hz => {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.type = 'square';
            o.frequency.value = hz * pitch;
            g.gain.value = 0.5;
            o.connect(g);
            g.connect(out);
            o.start(t);
            return o;
        });
        let stopped = false;
        return () => {
            if (stopped) return;
            stopped = true;
            const end = Math.max(ctx.currentTime + delay, t + 0.08);
            out.gain.setValueAtTime(gain, end);
            out.gain.linearRampToValueAtTime(0, end + 0.06);
            for (const o of oscs) o.stop(end + 0.08);
        };
    };

    // Needs a user gesture: called from the click that starts a drive
    E.start = () => {
        if (!E.ctx) init();
        E.ctx.resume();
    };

    function tick() {
        requestAnimationFrame(tick);
        if (!E.ctx) return;
        const f = window.osmSim && osmSim.free, now = E.ctx.currentTime;
        E.rainGain.gain.setTargetAtTime(E.rain && E.on ? 0.05 : 0, now, 0.5);
        if (!E.on || !f || !f.on) {
            E.master.gain.setTargetAtTime(0, now, 0.15);
            for (const g of [E.wind, E.tyres, E.squeal]) g.gain.setTargetAtTime(0, now, 0.15);
            return;
        }
        const v = Math.abs(f.v);
        E.wind.gain.setTargetAtTime(Math.min(0.25, (v / 40) ** 2 * 0.2), now, 0.1);
        // Off the road the tyres rumble on the ground, louder than on asphalt
        E.tyres.gain.setTargetAtTime(f.air ? 0 : Math.min(0.12, v / 40 * 0.1) * (1 + 2.5 * (f.off || 0)) + (f.off || 0) * Math.min(0.08, v / 10 * 0.08), now, 0.1);
        E.squeal.gain.setTargetAtTime(!f.air && f.brk > 0.85 && v > 6 ? 0.06 : 0, now, 0.05);
        // Out of fuel the engine is silent; the wind and the tyres go on
        if (window.Fuel && Fuel.empty) {
            E.master.gain.setTargetAtTime(0, now, 0.3);
            E.hiss.gain.setTargetAtTime(0, now, 0.3);
            return;
        }
        // During a shift the throttle is cut for a moment
        const load = performance.now() < f.shiftUntil ? 0.1 : f.thr, rpm = f.rpm, fire = rpm / 60 * 2;
        for (const { o, mul } of E.oscs) o.frequency.setTargetAtTime(fire * mul, now, 0.015);
        E.filter.frequency.setTargetAtTime(350 + 1600 * load + rpm * 0.35, now, 0.03);
        E.master.gain.setTargetAtTime(0.06 + 0.1 * load + 0.05 * rpm / REDLINE, now, 0.05);
        E.hiss.gain.setTargetAtTime(0.015 + 0.05 * load * rpm / REDLINE, now, 0.05);
    }

    E.REDLINE = REDLINE;
    window.Engine = E;
    requestAnimationFrame(tick);
})();
