// Alternative speed camera warnings, to compare in the simulator before one goes into the viewer
(() => {
    const ICON = '<svg width="{s}" height="{h}" viewBox="0 0 24 18"><path d="M2 4h4l2-3h8l2 3h4v13H2z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="10" r="4" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
    const icon = (s) => ICON.replace('{s}', s).replace('{h}', Math.round(s * 0.75));
    const WARN_FROM = 600;
    const original = window.setSpeedCamera;
    let style = 'pill', cam = null, camAt = 0;

    const css = document.createElement('style');
    css.textContent = `
      .cs { display: none; text-shadow: none; font-family: 'Segoe UI', system-ui, sans-serif; }
      .cs.on { display: block; }
      .cs.over { --accent: #e53935; }
      #cs-sign { position: absolute; left: 100%; bottom: 0; margin-left: 14px; text-align: center; --accent: #1565c0; }
      #cs-sign .box { width: 42px; height: 42px; border-radius: 8px; background: var(--accent); color: #fff; display: flex; align-items: center; justify-content: center; border: 2px solid #fff; box-sizing: border-box; }
      #cs-sign .d { font-size: 13px; font-weight: 600; margin-top: 3px; }
      #cs-sign .bar { height: 4px; border-radius: 2px; background: rgba(128,128,128,.4); overflow: hidden; margin-top: 2px; }
      #cs-sign .bar i { display: block; height: 100%; background: var(--accent); }
      #cs-banner { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); z-index: 150; --accent: #ffb300;
        background: var(--accent); color: #111; border-radius: 12px; padding: 8px 16px; font-size: 18px; font-weight: 600;
        box-shadow: 0 4px 16px rgba(0,0,0,.4); white-space: nowrap; }
      #cs-banner.over { color: #fff; }
      #cs-banner .lim { display: inline-block; width: 30px; height: 30px; line-height: 24px; border-radius: 50%; border: 3px solid #d32f2f;
        background: #fff; color: #111; text-align: center; font-size: 13px; box-sizing: border-box; margin-left: 10px; vertical-align: middle; }
      #cs-ring { position: absolute; left: 50%; top: 50%; width: 104px; height: 104px; transform: translate(-50%, -58%); pointer-events: none; --accent: #ffb300; }
      #cs-ring svg.r { position: absolute; inset: 0; }
      #cs-ring .ic { position: absolute; left: 50%; top: -14px; transform: translateX(-50%); background: var(--accent); color: #111; border-radius: 10px; padding: 1px 7px; font-size: 12px; font-weight: 700; white-space: nowrap; }
      #cs-edge { position: fixed; inset: 0; pointer-events: none; z-index: 90; --accent: #ffb300;
        box-shadow: inset 0 0 0 0 transparent; transition: box-shadow .3s; }
      #cs-edge.on { box-shadow: inset 0 0 60px 10px var(--accent); animation: cs-pulse 1.2s ease-in-out infinite; }
      @keyframes cs-pulse { 50% { opacity: .45; } }
      #cs-edge.over { --accent: #e53935; }
      #cs-road-label { position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); margin-bottom: 6px; font-size: 14px; font-weight: 600; white-space: nowrap; color: #ffb300; text-shadow: 0 0 4px #000; }
    `;
    document.head.appendChild(css);

    const speed = document.getElementById('speedOverlay');
    const add = (html, parent) => { const d = document.createElement('div'); d.innerHTML = html; const el = d.firstElementChild; parent.appendChild(el); return el; };
    const sign = add(`<div id="cs-sign" class="cs"><div class="box">${icon(24)}</div><div class="d"></div><div class="bar"><i></i></div></div>`, speed);
    const banner = add(`<div id="cs-banner" class="cs"></div>`, document.body);
    const ring = add(`<div id="cs-ring" class="cs"><svg class="r" viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" fill="none" stroke="rgba(128,128,128,.3)" stroke-width="5"/><circle class="p" cx="50" cy="50" r="46" fill="none" stroke="var(--accent)" stroke-width="5" stroke-linecap="round" transform="rotate(-90 50 50)" stroke-dasharray="289" stroke-dashoffset="0"/></svg><div class="ic"></div></div>`, speed);
    const edge = add(`<div id="cs-edge"></div>`, document.body);
    const roadLabel = add(`<div id="cs-road-label" class="cs"></div>`, speed);

    // Marker standing on the right side of the road, where the camera is
    let marker = null;
    function makeMarker() {
        const c = document.createElement('canvas');
        c.width = c.height = 128;
        const g = c.getContext('2d');
        g.fillStyle = '#ffb300';
        g.beginPath();
        g.roundRect(8, 8, 112, 112, 22);
        g.fill();
        g.strokeStyle = '#111';
        g.lineWidth = 9;
        g.strokeRect(22, 42, 84, 60);
        g.beginPath();
        g.arc(64, 72, 20, 0, 7);
        g.stroke();
        g.fillStyle = '#111';
        g.fillRect(44, 28, 40, 14);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true }));
        sprite.scale.set(0.9, 0.9, 1);
        sprite.position.y = 1.1;
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.2, 8), new THREE.MeshBasicMaterial({ color: 0x888888, transparent: true }));
        pole.position.y = 0.1;
        const group = new THREE.Group();
        group.add(sprite, pole);
        group.visible = false;
        roadPivot.add(group);
        return group;
    }

    function metersNow() {
        return cam ? Math.max(0, cam.meters - (currentKmh / 3.6) * (performance.now() - camAt) / 1000) : 0;
    }

    function tick() {
        requestAnimationFrame(tick);
        const on = !!cam;
        const m = metersNow();
        const over = on && cam.limitKmh && currentKmh > cam.limitKmh + 5;
        const progress = on ? Math.max(0, Math.min(1, 1 - m / WARN_FROM)) : 0;
        const dist = m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(m / 10) * 10 + ' m';
        for (const el of [sign, banner, ring, roadLabel]) el.classList.toggle('over', !!over);
        edge.classList.toggle('over', !!over);

        sign.classList.toggle('on', on && style === 'sign');
        if (on && style === 'sign') {
            sign.querySelector('.d').textContent = dist;
            sign.querySelector('.bar i').style.width = (progress * 100) + '%';
        }
        banner.classList.toggle('on', on && style === 'banner');
        if (on && style === 'banner') {
            banner.innerHTML = `${icon(20)} Autovelox tra ${dist}${cam.limitKmh ? `<span class="lim">${cam.limitKmh}</span>` : ''}`;
        }
        ring.classList.toggle('on', on && style === 'ring');
        if (on && style === 'ring') {
            ring.querySelector('.p').setAttribute('stroke-dashoffset', String(289 * progress));
            ring.querySelector('.ic').innerHTML = `${icon(12)} ${dist}`;
        }
        edge.classList.toggle('on', on && style === 'edge');
        roadLabel.classList.toggle('on', on && (style === 'road' || style === 'edge'));
        if (on && (style === 'road' || style === 'edge')) roadLabel.innerHTML = `${icon(14)} ${dist}${cam.limitKmh ? ' · ' + cam.limitKmh : ''}`;

        if (!marker && typeof roadPivot !== 'undefined' && roadPivot) marker = makeMarker();
        if (marker) {
            const v = currentKmh / 3.6;
            const u = m * (FAR_Z - TURN_Z) / Math.min(600, Math.max(120, v * 12));
            const show = on && style === 'road' && u < FAR_Z && roadMesh && roadMesh.visible;
            marker.visible = !!show;
            if (show) {
                const c = centerline(u);
                const side = -2.6;   // + is left: the camera stands on the right
                marker.position.set(c.x + side * Math.cos(c.phi), -0.5, c.z - side * Math.sin(c.phi));
                marker.children.forEach(o => { o.material.opacity = roadMesh.material.opacity; });
            }
        }
    }

    window.setSpeedCamera = (c) => {
        cam = c && c.meters != null ? c : null;
        camAt = performance.now();
        original(style === 'pill' ? c : null);
    };

    window.addEventListener('load', () => setTimeout(() => {
        const panel = document.querySelector('#osm-go').parentElement;
        const label = document.createElement('label');
        label.innerHTML = `avviso autovelox <select id="cs-style">
            <option value="pill">A · pillola sopra la velocità</option>
            <option value="sign">B · cartello blu con barra</option>
            <option value="banner">C · banner in alto</option>
            <option value="ring">D · anello attorno alla velocità</option>
            <option value="road">E · paletto sulla strada 3D</option>
            <option value="edge">F · bordo schermo che pulsa</option>
          </select>`;
        panel.insertBefore(label, panel.querySelector('#osm-go'));
        label.querySelector('select').onchange = e => {
            style = e.target.value;
            original(style === 'pill' && cam ? cam : null);
        };
        tick();
    }, 200));
})();
