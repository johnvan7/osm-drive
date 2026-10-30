// Alternative speed camera icons (banner and post on the road), to compare in the simulator
(() => {
    const ICONS = {
        foto: { label: 'Macchina fotografica', svg: '<path d="M3 7h4l2-3h6l2 3h4v12H3z"/><circle cx="12" cy="13" r="4"/>' },
        cartello: { label: 'Cartello blu italiano', svg: '<path d="M3 7h4l2-3h6l2 3h4v12H3z"/><circle cx="12" cy="13" r="4"/>', bg: '#1565c0', fg: '#fff' },
        box: { label: 'Box su palo', svg: '<rect x="3" y="3" width="14" height="10" rx="1.5"/><circle cx="10" cy="8" r="3"/><path d="M17 6h3v4h-3M10 13v8M6 21h8"/>' },
        radar: { label: 'Radar', svg: '<circle cx="6" cy="12" r="3"/><path d="M11 8a6 6 0 0 1 0 8M14 5a10 10 0 0 1 0 14M17 2.5a14 14 0 0 1 0 19"/>' },
        flash: { label: 'Flash', svg: '<path d="M13 2L5 14h6l-1 8 8-12h-6z" fill="currentColor"/>' },
        tachimetro: { label: 'Tachimetro', svg: '<path d="M3 18a9 9 0 1 1 18 0"/><path d="M12 18l5-6"/><circle cx="12" cy="18" r="1.5" fill="currentColor"/>' },
        velook: { label: 'Colonnina Velo OK (3D)', svg: '<rect x="8" y="2" width="8" height="20" rx="4"/><path d="M8 7h8"/><circle cx="12" cy="12" r="2"/>', mesh: 'velook' },
        box3d: { label: 'Box su palo (3D)', svg: '<rect x="3" y="3" width="14" height="10" rx="1.5"/><circle cx="10" cy="8" r="3"/><path d="M17 6h3v4h-3M10 13v8M6 21h8"/>', mesh: 'box' },
    };
    let current = 'foto';
    const U = 1 / METERS_PER_UNIT;

    function bannerIcon(icon) {
        const inner = `<g fill="none" stroke="${icon.bg ? icon.fg : 'currentColor'}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" ${icon.bg ? 'transform="translate(3 3) scale(.75)"' : ''}>${icon.svg}</g>`;
        return `<svg width="22" height="22" viewBox="0 0 24 24">${icon.bg ? `<rect width="24" height="24" rx="4" fill="${icon.bg}"/>` : ''}${inner}</svg>`;
    }

    function spriteSign(icon) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="128" height="128">
            <rect x="1" y="1" width="22" height="22" rx="4" fill="${icon.bg || '#ffb300'}" stroke="#fff" stroke-width="${icon.bg ? 1 : 0}"/>
            <g transform="translate(4.5 4.5) scale(.625)" fill="none" stroke="${icon.fg || '#111'}" color="${icon.fg || '#111'}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${icon.svg}</g></svg>`;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 128;
        const texture = new THREE.CanvasTexture(canvas);
        const img = new Image();
        img.onload = () => { canvas.getContext('2d').drawImage(img, 0, 0); texture.needsUpdate = true; };
        img.src = 'data:image/svg+xml,' + encodeURIComponent(svg);
        const sign = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
        sign.scale.set(0.9 * U, 0.9 * U, 1);
        sign.position.y = (2.4 + 0.45) * U;
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.4 * U, 8), new THREE.MeshBasicMaterial({ color: 0x888888, transparent: true }));
        pole.position.y = 1.2 * U;
        return [sign, pole];
    }

    // Real sizes: Velo OK column 1.7 m x 0.36 m, camera box 0.6 m on a 2.6 m pole
    function meshes(kind) {
        const mat = (color) => new THREE.MeshLambertMaterial({ color, transparent: true });
        if (kind === 'velook') {
            const body = new THREE.Mesh(new THREE.CylinderGeometry(0.18 * U, 0.18 * U, 1.5 * U, 24), mat(0xff6d00));
            body.position.y = 0.75 * U;
            const top = new THREE.Mesh(new THREE.SphereGeometry(0.18 * U, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xff6d00));
            top.position.y = 1.5 * U;
            const band = new THREE.Mesh(new THREE.CylinderGeometry(0.185 * U, 0.185 * U, 0.12 * U, 24), mat(0xffffff));
            band.position.y = 1.2 * U;
            return [body, top, band];
        }
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05 * U, 0.05 * U, 2.6 * U, 10), mat(0x8a8a8a));
        pole.position.y = 1.3 * U;
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.45 * U, 0.5 * U, 0.7 * U), mat(0xb0b0b0));
        box.position.y = 2.85 * U;
        // Lens towards the approaching traffic (-z)
        const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.12 * U, 0.12 * U, 0.05 * U, 20), mat(0x111111));
        lens.rotation.x = Math.PI / 2;
        lens.position.set(0, 2.85 * U, -0.36 * U);
        const flash = new THREE.Mesh(new THREE.BoxGeometry(0.3 * U, 0.1 * U, 0.04 * U), mat(0xffe082));
        flash.position.set(0, 3.03 * U, -0.36 * U);
        return [pole, box, lens, flash];
    }

    window.createCameraPost = () => {
        const icon = ICONS[current];
        const group = new THREE.Group();
        group.add(...(icon.mesh ? meshes(icon.mesh) : spriteSign(icon)));
        roadPivot.add(group);
        return group;
    };

    function apply(name) {
        current = name;
        const svg = document.querySelector('#speedCamera svg');
        if (svg) svg.outerHTML = bannerIcon(ICONS[name]);
        if (cameraPost) {
            roadPivot.remove(cameraPost);
            cameraPost = null;
        }
    }

    window.camIcons = { apply, names: Object.keys(ICONS) };
    window.addEventListener('load', () => setTimeout(() => {
        const panel = document.querySelector('#osm-go').parentElement;
        const label = document.createElement('label');
        label.innerHTML = `icona autovelox <select id="cam-icon">${Object.entries(ICONS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>`;
        panel.insertBefore(label, panel.querySelector('#osm-go'));
        label.querySelector('select').onchange = e => apply(e.target.value);
    }, 200));
})();
