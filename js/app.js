// Diorama GBA: runs a GBA game and shows its picture as stacked layers, on screen or on a real table (WebXR).
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var GBA_W = 240, GBA_H = 160, FRAME_MS = 1000 / 59.7275;
  var SLOT_COLORS = [0x8fd16a, 0x8fd16a, 0x6ac1d1, 0xe2574c, 0xf0c35a, 0xe2574c, 0xc79bf2, 0xe2574c];

  var settings = loadSettings();
  var gba, romBuffer = null, running = false, turbo = false;

  // ---------- Settings ----------
  function loadSettings() {
    var d = { gap: 14, tilt: 35, size: 36, markerSize: 10.5, markerType: '', style: '', hud: true, glass: true, shadows: true, sound: true };
    try { Object.assign(d, JSON.parse(localStorage.getItem('diorama.settings') || '{}')); } catch (e) {}
    if (!d.style) d.style = d.voxel ? 'voxel' : 'layers';   // older settings had a voxel on/off switch
    if (!d.markerType) { d.markerType = 'jim'; d.markerSize = 10.5; }   // the JIM marker became the default
    delete d.voxel;
    return d;
  }
  function saveSettings() { try { localStorage.setItem('diorama.settings', JSON.stringify(settings)); } catch (e) {} }

  // ---------- ROM storage (IndexedDB, so the ROM survives a reload) ----------
  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open('diorama-gba', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('roms'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function storeRom(name, buf) {
    return idb().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction('roms', 'readwrite');
        tx.objectStore('roms').put({ name: name, data: buf }, 'last');
        tx.oncomplete = res; tx.onerror = res;
      });
    }).catch(function () {});
  }
  function loadStoredRom() {
    return idb().then(function (db) {
      return new Promise(function (res) {
        var g = db.transaction('roms').objectStore('roms').get('last');
        g.onsuccess = function () { res(g.result || null); };
        g.onerror = function () { res(null); };
      });
    }).catch(function () { return null; });
  }

  // Binary files come from the server, or from base64 globals when the page is hosted where only text files are allowed.
  function getBinary(url, global) {
    if (window[global]) {
      var bin = atob(window[global]), out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return Promise.resolve(out.buffer);
    }
    return fetch(url).then(function (r) { return r.arrayBuffer(); });
  }

  // ---------- Emulator ----------
  function createGba() {
    gba = new GameBoyAdvance();
    gba.keypad.touchBits = 0;
    gba.logLevel = gba.LOG_ERROR;
    gba.setCanvasDirect($('gba'));
    return getBinary('vendor/gbajs/bios.bin', 'DIORAMA_BIOS').then(function (bios) {
      gba.setBios(bios);
    });
  }

  function startRom(buf, name) {
    romBuffer = buf;
    if (!gba.setRom(buf.slice(0))) { alertBox('Este ficheiro não parece ser uma ROM de GBA.'); return false; }
    running = true;
    gba.audio.masterEnable = settings.sound;
    try { gba.audio.pause(false); if (gba.audio.context) gba.audio.context.resume(); } catch (e) {}
    $('start').hidden = true; $('menu').hidden = true; $('hud').hidden = false;
    document.title = (name ? name.replace(/\.[^.]+$/, '') + ' · ' : '') + 'Diorama GBA';
    lastTime = performance.now(); acc = 0;
    return true;
  }

  function alertBox(msg) { $('ar-status').textContent = msg; $('start').hidden = false; }

  var lastTime = 0, acc = 0, fpsFrames = 0, fpsTime = 0;
  function runEmulator(now) {
    if (!running) return;
    var dt = Math.min(now - lastTime, 100);
    lastTime = now;
    acc += dt * (turbo ? 3 : 1);
    var max = turbo ? 9 : 4, n = Math.min(max, Math.floor(acc / FRAME_MS)), rp = gba.video.renderPath;
    // Only the last frame of the batch is drawn; the others are skipped (see layered.js).
    for (var k = 0; k < n; k++) { rp.skip = k < n - 1; gba.advanceFrame(); }
    rp.skip = false;
    acc = n === max ? 0 : acc - n * FRAME_MS;
    fpsFrames += n; fpsTime += dt;
    if (fpsTime > 1000) { $('fps').textContent = Math.round(fpsFrames * 1000 / fpsTime) + ' fps'; fpsFrames = 0; fpsTime = 0; }
  }

  // ---------- Touch controls ----------
  var touchKeys = 0, dpadBits = 0;
  function applyKeys() { if (gba) gba.keypad.touchBits = touchKeys | dpadBits; }
  Array.prototype.forEach.call(document.querySelectorAll('.key'), function (el) {
    var bit = 1 << Number(el.dataset.key);
    function down(e) { e.preventDefault(); el.setPointerCapture && el.setPointerCapture(e.pointerId); touchKeys |= bit; el.classList.add('down'); applyKeys(); vibrate(); }
    function up(e) { touchKeys &= ~bit; el.classList.remove('down'); applyKeys(); }
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  });
  (function () {
    var pad = $('dpad'), active = null;
    function update(e) {
      var r = pad.getBoundingClientRect();
      var x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
      var dead = r.width * 0.12, bits = 0;
      var ax = Math.abs(x), ay = Math.abs(y);
      if (ax > dead && ax > ay * 0.5) bits |= x > 0 ? 1 << 4 : 1 << 5;
      if (ay > dead && ay > ax * 0.5) bits |= y > 0 ? 1 << 7 : 1 << 6;
      if (bits !== dpadBits) vibrate();
      dpadBits = bits;
      pad.className = (bits & 16 ? 'right ' : '') + (bits & 32 ? 'left ' : '') + (bits & 64 ? 'up ' : '') + (bits & 128 ? 'down' : '');
      applyKeys();
    }
    pad.addEventListener('pointerdown', function (e) { e.preventDefault(); active = e.pointerId; pad.setPointerCapture(e.pointerId); update(e); });
    pad.addEventListener('pointermove', function (e) { if (e.pointerId === active) update(e); });
    function end(e) { if (e.pointerId !== active) return; active = null; dpadBits = 0; pad.className = ''; applyKeys(); }
    pad.addEventListener('pointerup', end);
    pad.addEventListener('pointercancel', end);
  })();
  function vibrate() { if (navigator.vibrate) try { navigator.vibrate(8); } catch (e) {} }

  // Buttons inside the AR overlay must not also count as a tap on the table.
  $('ui').addEventListener('beforexrselect', function (e) {
    if (e.target.closest('button, .button, #dpad, .sheet, input, label')) e.preventDefault();
  });

  // ---------- 3D scene ----------
  var renderer = new THREE.WebGLRenderer({ canvas: $('view'), antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.xr.enabled = true;

  var scene = new THREE.Scene();
  var previewBg = new THREE.Color(0x1d1a26);
  scene.background = previewBg;
  var camera = new THREE.PerspectiveCamera(50, 1, 0.01, 50);

  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  var sun = new THREE.DirectionalLight(0xffffff, 0.26);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0008;
  scene.add(sun); scene.add(sun.target);

  // Preview-only table so the diorama has something to stand on before AR.
  var table = new THREE.Mesh(new THREE.CircleGeometry(1.2, 64), new THREE.MeshLambertMaterial({ color: 0x3a3347 }));
  table.rotation.x = -Math.PI / 2; table.receiveShadow = true; scene.add(table);
  var grid = new THREE.GridHelper(2.4, 48, 0x4c4460, 0x2c2738); grid.position.y = 0.0005; scene.add(grid);
  // AR-only shadow catcher.
  var shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.ShadowMaterial({ opacity: 0.28 }));
  shadowCatcher.rotation.x = -Math.PI / 2; shadowCatcher.receiveShadow = true; shadowCatcher.visible = false;

  var root = new THREE.Group();        // placed on the table
  var tiltPivot = new THREE.Group();   // hinge at the bottom edge of the picture
  var stack = new THREE.Group();       // the picture, centred, layers along +Z
  root.add(tiltPivot); tiltPivot.add(stack);
  // The anchor is where the diorama sits: identity on screen and in WebXR, the marker pose in marker mode.
  var anchor = new THREE.Group();
  anchor.add(root); anchor.add(shadowCatcher); scene.add(anchor);

  // Extra props shown only in the VR view.
  var vrRoom = new THREE.Group();
  (function () {
    var floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshLambertMaterial({ color: 0x17141f }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.75; vrRoom.add(floor);
    var floorGrid = new THREE.GridHelper(30, 60, 0x3b3450, 0x241f31); floorGrid.position.y = -0.749; vrRoom.add(floorGrid);
    var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.12, 0.75, 24), new THREE.MeshLambertMaterial({ color: 0x2c2638 }));
    leg.position.y = -0.375; vrRoom.add(leg);
    var edge = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 0.04, 64), new THREE.MeshLambertMaterial({ color: 0x2c2638 }));
    edge.position.y = -0.021; vrRoom.add(edge);
  })();
  vrRoom.visible = false; scene.add(vrRoom);

  // 'preview': studio table on screen; 'camera': transparent over the camera picture; 'vr': table in a dark room.
  function setEnvironment(kind) {
    scene.background = kind === 'camera' ? null : previewBg;
    scene.fog = kind === 'vr' ? new THREE.Fog(0x1d1a26, 4, 16) : null;
    table.visible = grid.visible = kind !== 'camera';
    vrRoom.visible = kind === 'vr';
    shadowCatcher.visible = kind === 'camera';
    shadowCatcher.position.set(0, 0.001, 0);
  }

  var mode = null;  // optional { update(), render() } that replaces the preview camera

  var planeGeo = new THREE.PlaneGeometry(1, GBA_H / GBA_W);
  (function flipV(g) { var uv = g.attributes.uv; for (var i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i)); })(planeGeo);
  var aspectH = GBA_H / GBA_W;

  var backdropMat = new THREE.MeshLambertMaterial({ color: 0x000000 });
  var backdrop = new THREE.Mesh(planeGeo, backdropMat);
  backdrop.receiveShadow = true; stack.add(backdrop);
  var base = new THREE.Mesh(new THREE.BoxGeometry(1.04, aspectH + 0.04, 0.03), new THREE.MeshLambertMaterial({ color: 0x24202f }));
  base.position.z = -0.0152; base.castShadow = true; base.receiveShadow = true; stack.add(base);

  var slots = [];
  for (var s = 0; s < 8; s++) {
    var tex = new THREE.DataTexture(new Uint8Array(GBA_W * GBA_H * 4), GBA_W, GBA_H, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false;
    var mat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });
    var mesh = new THREE.Mesh(planeGeo, mat);
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.visible = false;
    mesh.renderOrder = s + 1;
    var edge = new THREE.LineSegments(new THREE.EdgesGeometry(planeGeo), new THREE.LineBasicMaterial({ color: SLOT_COLORS[s], transparent: true, opacity: 0.55 }));
    var glass = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({ color: 0xcfe8ff, transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide }));
    mesh.add(edge); mesh.add(glass);
    stack.add(mesh);
    slots.push({ tex: tex, mesh: mesh, edge: edge, glass: glass, depth: 0, shown: 0 });
  }

  var lastUploaded = -1;
  function updateLayers() {
    if (!gba || !running) return;
    var rp = gba.video.renderPath;
    if (!rp.slotPixels) return;
    if (rp.frameCount !== lastUploaded) {
      lastUploaded = rp.frameCount;
      for (var i = 0; i < 8; i++) {
        if (rp.slotUsedFrame[i]) { slots[i].tex.image.data.set(rp.slotPixels[i]); slots[i].tex.needsUpdate = true; }
      }
      var c = rp.backdropColor;
      backdropMat.color.setRGB(((c & 31) << 3) / 255, ((c >> 5 & 31) << 3) / 255, ((c >> 10 & 31) << 3) / 255);
    }
    if (applyStyle(rp)) return;
    backdrop.visible = true;
    // Used slots get consecutive depths, so an empty layer never leaves a hole.
    var rank = 0, gap = settings.gap / 1000 / (settings.size / 100); // gap is in mm, stack is 1 unit wide
    var info = [];
    for (var j = 0; j < 8; j++) {
      var sl = slots[j], used = !!rp.slotUsedFrame[j];
      if (used) { rank++; info.push(j); }
      var target = used ? rank * gap : sl.depth;
      sl.depth += (target - sl.depth) * 0.25;
      sl.mesh.position.z = sl.depth + 0.0004 * j;
      sl.mesh.visible = used;
      sl.edge.visible = sl.glass.visible = settings.glass && gap > 0.001;
    }
    layersInfo = info;
  }
  var layersInfo = [];

  // Voxel and 3D world styles (voxel.js, world.js). The 3D world only exists while the game shows a map;
  // battles and menus fall back to voxel. Returns true when one of them drew this frame.
  function applyStyle(rp) {
    var V = window.diorama.voxel, W = window.diorama.world, style = settings.style;
    base.visible = true;
    if (style === 'world' && W) {
      if (V.enabled()) V.setEnabled(false);
      if (W.update(rp)) { backdrop.visible = false; base.visible = false; return true; }
    }
    if (style === 'voxel' || style === 'world') {
      if (!V.enabled()) V.setEnabled(true);
      V.update(rp);
      backdrop.visible = false;
      return true;
    }
    if (V.enabled()) V.setEnabled(false);
    return false;
  }
  var SLOT_NAMES = ['Fundo de prioridade 3', 'Sprites prioridade 3', 'Fundo de prioridade 2', 'Sprites prioridade 2', 'Fundo de prioridade 1', 'Sprites prioridade 1', 'Fundo de prioridade 0', 'Sprites prioridade 0'];

  function applyTransform() {
    var size = settings.size / 100;
    root.scale.setScalar(size);
    tiltPivot.rotation.x = -Math.PI / 2 + settings.tilt * Math.PI / 180;
    stack.position.set(0, aspectH / 2 + 0.02, 0.03);
    renderer.shadowMap.enabled = settings.shadows;
    slots.forEach(function (sl) { sl.mesh.castShadow = settings.shadows; });
  }

  // ---------- Preview camera (drag to orbit, pinch or wheel to zoom) ----------
  var orbit = { az: 0.35, el: 0.75, dist: 0.62 };
  (function () {
    var cv = $('view'), pts = {}, lastPinch = 0;
    cv.addEventListener('pointerdown', function (e) { pts[e.pointerId] = { x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', function (e) {
      var p = pts[e.pointerId]; if (!p) return;
      var ids = Object.keys(pts);
      if (ids.length === 1) {
        orbit.az -= (e.clientX - p.x) * 0.008;
        orbit.el = Math.max(0.05, Math.min(1.5, orbit.el + (e.clientY - p.y) * 0.006));
      }
      p.x = e.clientX; p.y = e.clientY;
      if (ids.length === 2) {
        var a = pts[ids[0]], b = pts[ids[1]], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (lastPinch) orbit.dist = Math.max(0.25, Math.min(3, orbit.dist * lastPinch / d));
        lastPinch = d;
      }
    });
    function up(e) { delete pts[e.pointerId]; lastPinch = 0; }
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', function (e) { orbit.dist = Math.max(0.25, Math.min(3, orbit.dist * (1 + e.deltaY * 0.001))); }, { passive: true });
  })();

  function updatePreviewCamera() {
    var size = settings.size / 100;
    var target = new THREE.Vector3(0, size * aspectH * 0.45 * Math.sin(settings.tilt * Math.PI / 180) + 0.02, 0);
    var d = orbit.dist * Math.max(0.6, size / 0.36);
    camera.position.set(Math.sin(orbit.az) * Math.cos(orbit.el) * d, target.y + Math.sin(orbit.el) * d, Math.cos(orbit.az) * Math.cos(orbit.el) * d);
    camera.lookAt(target);
  }

  function resize() {
    if (renderer.xr.isPresenting) return;
    var w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize); resize();

  // When the phone cannot keep up, the 3D view is drawn at a lower resolution (and back up when it can),
  // which leaves more time for the emulator.
  var MAX_RATIO = Math.min(window.devicePixelRatio || 1, 2), pixelRatio = MAX_RATIO, qFrames = 0, qStart = 0;
  function adaptQuality(now) {
    if (renderer.xr.isPresenting || document.visibilityState !== 'visible') { qStart = 0; return; }
    if (!qStart) { qStart = now; qFrames = 0; return; }
    qFrames++;
    if (now - qStart < 2000) return;
    var fps = qFrames * 1000 / (now - qStart), r = pixelRatio;
    if (fps < 45 && r > 1) r = Math.max(1, r - 0.25);
    else if (fps > 58 && r < MAX_RATIO) r = Math.min(MAX_RATIO, r + 0.25);
    qStart = now; qFrames = 0;
    if (r !== pixelRatio) { pixelRatio = r; renderer.setPixelRatio(r); resize(); }
  }

  // ---------- AR (WebXR) ----------
  var xrSession = null, hitSource = null, placed = false;
  var reticle = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.075, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x8fd16a }));
  reticle.matrixAutoUpdate = false; reticle.visible = false; scene.add(reticle);

  function checkAR() {
    if (!navigator.xr || !window.isSecureContext) {
      $('ar-status').textContent = 'O modo AR precisa do Chrome no Android e de um endereço https. Aqui só funciona a vista 3D no ecrã.';
      return;
    }
    navigator.xr.isSessionSupported('immersive-ar').then(function (ok) {
      $('ar-btn').hidden = !ok;
      $('ar-status').textContent = ok ? 'Realidade aumentada disponível neste telemóvel.' :
        'Este telemóvel não tem ARCore. Usa o modo Marcador (AR com uma folha impressa) ou o modo VR.';
    }).catch(function () {});
  }

  function startAR() {
    navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'local-floor'],
      domOverlay: { root: $('ui') }
    }).then(function (session) {
      xrSession = session; placed = false;
      renderer.xr.setReferenceSpaceType('local');
      renderer.xr.setSession(session);
      setEnvironment('camera'); root.visible = false;
      $('ar-hint').hidden = false;
      session.requestReferenceSpace('viewer').then(function (viewer) {
        return session.requestHitTestSource({ space: viewer });
      }).then(function (src) { hitSource = src; });
      session.addEventListener('select', function () {
        if (placed || !reticle.visible) return;
        placeAt(reticle.matrix);
      });
      session.addEventListener('end', function () {
        xrSession = null; hitSource = null; reticle.visible = false;
        setEnvironment('preview'); root.visible = true;
        root.position.set(0, 0, 0); root.rotation.set(0, 0, 0);
        $('ar-hint').hidden = true;
        resize();
      });
    }).catch(function (e) { $('ar-status').textContent = 'Não consegui abrir o AR: ' + e.message; });
  }

  var tmpPos = new THREE.Vector3(), tmpQuat = new THREE.Quaternion(), tmpScale = new THREE.Vector3();
  function placeAt(matrix) {
    matrix.decompose(tmpPos, tmpQuat, tmpScale);
    root.position.copy(tmpPos);
    var cam = renderer.xr.getCamera(camera);
    var dx = cam.position.x - tmpPos.x, dz = cam.position.z - tmpPos.z;
    root.rotation.set(0, Math.atan2(dx, dz), 0);
    shadowCatcher.position.set(tmpPos.x, tmpPos.y + 0.001, tmpPos.z);
    root.visible = true; placed = true; reticle.visible = false; $('ar-hint').hidden = true;
  }

  function updateHitTest(frame) {
    if (!frame || !hitSource || placed) return;
    var ref = renderer.xr.getReferenceSpace();
    var hits = frame.getHitTestResults(hitSource);
    if (hits.length) {
      var pose = hits[0].getPose(ref);
      reticle.visible = true;
      reticle.matrix.fromArray(pose.transform.matrix);
    } else {
      reticle.visible = false;
    }
  }

  var tmpSun = new THREE.Vector3();
  function updateSun() {
    var p = root.getWorldPosition(tmpSun);
    var r = settings.size / 100 * 1.2;
    sun.position.set(p.x - 0.4 * r, p.y + 1.2 * r, p.z + 0.5 * r);
    sun.target.position.copy(p);
    var c = sun.shadow.camera; c.left = -r; c.right = r; c.top = r; c.bottom = -r; c.near = 0.01; c.far = 4 * r; c.updateProjectionMatrix();
  }

  // ---------- Dialogs and menus in front ----------
  // The top background layer (BG0) and the top sprites hold the game's text boxes and menus. With the
  // "hud" setting they are drawn flat over the 3D picture, the same size whatever the view, instead of in
  // the diorama. Not in VR, where a flat overlay can't be seen in stereo.
  var HUD_SLOTS = [6, 7];
  var hudScene = new THREE.Scene(), hudCam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
  var hudMeshes = HUD_SLOTS.map(function (s) {
    var m = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({ map: slots[s].tex, transparent: true, alphaTest: 0.5, depthTest: false }));
    m.renderOrder = s; hudScene.add(m); return m;
  });
  // Sprites the voxel style sends to the overlay (battle health boxes), drawn under the dialogs.
  var hudSpriteMesh = null;
  function hudActive() {
    return settings.hud && running && !renderer.xr.isPresenting && !(window.diorama.vr && window.diorama.vr.active());
  }
  // The free part of the screen between the touch controls, in CSS pixels from the top-left.
  var hudBox = null, hudBoxAt = 0;
  function hudRect(w, h) {
    if (hudBox && hudBox.w0 === w && hudBox.h0 === h && performance.now() - hudBoxAt < 1000) return hudBox;
    var top = 8, bottom = h - 8, left = 8, right = w - 8;
    var bar = document.querySelector('.topbar'), dpad = $('dpad'), mid = document.querySelector('.controls .mid'), ab = document.querySelector('.controls .ab');
    if (bar && dpad && mid && ab && !$('hud').hidden) {
      var B = bar.getBoundingClientRect(), Dp = dpad.getBoundingClientRect(), M = mid.getBoundingClientRect(), Ab = ab.getBoundingClientRect();
      top = B.bottom + 6;
      if (Math.min(Dp.top, Ab.top) > h * 0.6) bottom = Math.min(Dp.top, M.top, Ab.top) - 6;   // controls below the picture
      else { left = Dp.right + 8; right = Ab.left - 8; bottom = M.top - 6; }                  // controls at the sides
    }
    hudBox = { x: left, y: top, w: Math.max(60, right - left), h: Math.max(40, bottom - top), w0: w, h0: h };
    hudBoxAt = performance.now();
    return hudBox;
  }
  // In VR there is no screen to draw over, so the same things go on a panel standing at the far edge of the
  // diorama, like a TV behind it.
  var vrHud = null;
  function updateVrHud() {
    var on = settings.hud && running && window.diorama.vr && window.diorama.vr.active(), rp = gba && gba.video.renderPath, V = window.diorama.voxel;
    if (!vrHud) {
      if (!on) return;
      vrHud = new THREE.Group();
      [slots[6].tex, slots[7].tex, V.hud.tex].forEach(function (tex, k) {
        var m = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide }));
        m.position.z = k * 0.002; m.renderOrder = 6 + k; vrHud.add(m);
      });
      vrHud.rotation.x = Math.PI / 2;   // stand up: the picture's top is up
      stack.add(vrHud);
    }
    vrHud.visible = !!(on && rp && rp.slotUsedFrame);
    if (!vrHud.visible) return;
    vrHud.position.set(0, aspectH / 2 + 0.03, aspectH / 2 + 0.01);
    HUD_SLOTS.forEach(function (s, k) { vrHud.children[k].visible = !!rp.slotUsedFrame[s]; slots[s].mesh.visible = false; });
    V.hideSlots(HUD_SLOTS);
    vrHud.children[2].visible = V.hud.used && V.enabled();
  }

  function updateHud() {
    updateVrHud();
    var on = hudActive(), rp = gba && gba.video.renderPath;
    if (!on || !rp || !rp.slotUsedFrame) return false;
    var w = window.innerWidth, h = window.innerHeight, r = hudRect(w, h);
    var scale = Math.min(r.w / GBA_W, r.h / GBA_H);
    hudCam.left = 0; hudCam.right = w; hudCam.top = h; hudCam.bottom = 0; hudCam.updateProjectionMatrix();
    var any = false;
    HUD_SLOTS.forEach(function (s, k) {
      var used = !!rp.slotUsedFrame[s], m = hudMeshes[k];
      slots[s].mesh.visible = false;
      m.visible = used; any = any || used;
      m.scale.set(GBA_W * scale, GBA_W * scale, 1);
      m.position.set(r.x + r.w / 2, h - (r.y + r.h - GBA_H * scale / 2), 0);   // bottom of the free area
    });
    var V = window.diorama.voxel;
    if (V) {
      V.hideSlots(HUD_SLOTS);
      if (!hudSpriteMesh) {
        hudSpriteMesh = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({ map: V.hud.tex, transparent: true, alphaTest: 0.5, depthTest: false }));
        hudSpriteMesh.renderOrder = 5; hudScene.add(hudSpriteMesh);
      }
      hudSpriteMesh.visible = V.hud.used && V.enabled();
      hudSpriteMesh.scale.copy(hudMeshes[0].scale); hudSpriteMesh.position.copy(hudMeshes[0].position);
      any = any || hudSpriteMesh.visible;
    }
    return any;
  }

  // ---------- Main loop ----------
  renderer.setAnimationLoop(function (time, frame) {
    runEmulator(performance.now());
    adaptQuality(performance.now());
    refreshModeButtons();
    updateLayers();
    if (renderer.xr.isPresenting) updateHitTest(frame);
    else if (mode) mode.update();
    else updatePreviewCamera();
    updateSun();
    var hud = updateHud();
    if (mode && !renderer.xr.isPresenting) mode.render(); else renderer.render(scene, camera);
    if (hud) {
      renderer.autoClear = false; renderer.clearDepth();
      renderer.render(hudScene, hudCam);
      renderer.autoClear = true;
    }
  });

  // ---------- UI wiring ----------
  function bindRange(id, key, fmt) {
    var input = $(id), out = $(id + '-out');
    input.value = settings[key];
    function show() { out.textContent = fmt(Number(input.value)); }
    input.addEventListener('input', function () { settings[key] = Number(input.value); show(); applyTransform(); saveSettings(); });
    show();
  }
  bindRange('gap', 'gap', function (v) { return v === 0 ? 'plano' : v + ' mm'; });
  bindRange('tilt', 'tilt', function (v) { return v + '°'; });
  bindRange('size', 'size', function (v) { return v + ' cm'; });
  bindRange('markerSize', 'markerSize', function (v) { return v + ' cm'; });
  (function () {
    var el = $('markerType'); el.value = settings.markerType;
    el.addEventListener('change', function () {
      settings.markerType = el.value;
      settings.markerSize = el.value === 'jim' ? 10.5 : 10;   // printed sizes of the two markers
      $('markerSize').value = settings.markerSize; $('markerSize').dispatchEvent(new Event('input'));
      saveSettings();
    });
  })();
  (function () {
    var el = $('style'); el.value = settings.style;
    el.addEventListener('change', function () {
      settings.style = el.value; saveSettings();
      // Blocks and the 3D world read best lying flat on the table.
      settings.tilt = el.value === 'layers' ? 35 : 0; $('tilt').value = settings.tilt; $('tilt').dispatchEvent(new Event('input'));
      if (window.diorama.world) window.diorama.world.setEnabled(el.value === 'world');
    });
  })();
  [['ui-front', 'hud'], ['glass', 'glass'], ['shadows', 'shadows'], ['sound', 'sound']].forEach(function (p) {
    var el = $(p[0]); el.checked = settings[p[1]];
    el.addEventListener('change', function () {
      settings[p[1]] = el.checked; saveSettings(); applyTransform();
      if (gba && p[1] === 'sound') gba.audio.masterEnable = el.checked;
    });
  });

  function readFile(file) {
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsArrayBuffer(file); });
  }
  // Reads the first .gba file out of a .zip (stored or deflate), using the browser's own decompressor.
  function unzipGba(buf) {
    var v = new DataView(buf), u8 = new Uint8Array(buf);
    var eocd = -1;
    for (var i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return Promise.reject(new Error('zip inválido'));
    var count = v.getUint16(eocd + 10, true), p = v.getUint32(eocd + 16, true);
    for (var n = 0; n < count; n++) {
      var method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
      var nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
      var local = v.getUint32(p + 42, true);
      var name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (!/\.(gba|agb|bin)$/i.test(name)) continue;
      var start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      var data = u8.slice(start, start + csize);
      if (method === 0) return Promise.resolve({ name: name, data: data.buffer });
      if (method !== 8 || !window.DecompressionStream) return Promise.reject(new Error('este zip não é suportado'));
      var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).arrayBuffer().then(function (out) { return { name: name, data: out }; });
    }
    return Promise.reject(new Error('não encontrei nenhum ficheiro .gba dentro do zip'));
  }

  $('rom-file').addEventListener('change', function (e) {
    var f = e.target.files[0]; if (!f) return;
    readFile(f).then(function (buf) {
      var head = new Uint8Array(buf, 0, 4);
      var isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4;
      return isZip ? unzipGba(buf) : { name: f.name, data: buf };
    }).then(function (rom) {
      if (startRom(rom.data, rom.name)) storeRom(rom.name, rom.data);
    }).catch(function (err) { alertBox('Não consegui abrir o ficheiro: ' + err.message); });
    e.target.value = '';
  });
  $('demo').addEventListener('click', function () {
    getBinary('roms/vila-teste.gba', 'DIORAMA_DEMO').then(function (buf) { startRom(buf, 'Vila de teste'); });
  });
  $('continue').addEventListener('click', function () {
    loadStoredRom().then(function (rec) { if (rec) startRom(rec.data, rec.name); });
  });
  $('menu-btn').addEventListener('click', function () {
    $('menu').hidden = false;
    $('layers-info').textContent = (layersInfo.length ? 'Camadas neste momento: ' + layersInfo.map(function (i) { return SLOT_NAMES[i]; }).join(', ') + '. ' : '') +
      ($('fps').textContent ? 'Velocidade: ' + $('fps').textContent + ' (60 é a normal).' : '');
  });
  $('close-menu').addEventListener('click', function () { $('menu').hidden = true; });
  $('turbo').addEventListener('click', function () { turbo = !turbo; $('turbo').setAttribute('aria-pressed', String(turbo)); });
  // Mode buttons: the current mode's button is pressed, and choosing another one leaves the current mode first.
  var MODES = ['screen', 'ar', 'marker', 'vr'], shownMode = '';
  function currentMode() {
    var D = window.diorama;
    return xrSession ? 'ar' : D.marker && D.marker.active() ? 'marker' : D.vr && D.vr.active() ? 'vr' : 'screen';
  }
  function switchMode(m) {
    if (m === currentMode()) return;
    if (diorama.marker.active()) diorama.marker.stop();
    if (diorama.vr.active()) diorama.vr.stop();
    if (xrSession) xrSession.end();
    if (m === 'ar') startAR(); else if (m === 'marker') diorama.marker.start(); else if (m === 'vr') diorama.vr.start();
  }
  function refreshModeButtons() {
    var m = currentMode();
    if (m === shownMode) return;
    shownMode = m;
    MODES.forEach(function (k) { $(k + '-btn').setAttribute('aria-pressed', String(k === m)); });
  }
  MODES.forEach(function (k) { $(k + '-btn').addEventListener('click', function () { switchMode(k); }); });
  $('replace').addEventListener('click', function () {
    $('menu').hidden = true;
    if (xrSession) { placed = false; root.visible = false; $('ar-hint').hidden = false; }
  });
  $('change-rom').addEventListener('click', function () {
    running = false; $('menu').hidden = true; $('hud').hidden = true; $('start').hidden = false;
    try { gba.audio.pause(true); } catch (e) {}
    refreshContinue();
  });
  $('export-save').addEventListener('click', function () {
    var save = gba && gba.mmu.save;
    if (!save) { $('layers-info').textContent = 'Este jogo ainda não tem nada guardado.'; return; }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([save.buffer], { type: 'application/octet-stream' }));
    a.download = ((gba.mmu.cart && gba.mmu.cart.title) || 'jogo').trim() + '.sav';
    document.body.appendChild(a); a.click(); a.remove();
  });
  $('save-file').addEventListener('change', function (e) {
    var f = e.target.files[0]; if (!f || !romBuffer) return;
    readFile(f).then(function (buf) {
      gba.setSavedata(buf); gba.storeSavedata();
      startRom(romBuffer);   // restart so the game reads the imported save
    });
    e.target.value = '';
  });

  // Keep the screen on while playing.
  function wakeLock() { if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(function () {}); }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { wakeLock(); lastTime = performance.now(); }
  });
  document.addEventListener('pointerdown', function () {
    wakeLock();
    try { if (gba && gba.audio.context && gba.audio.context.state !== 'running') gba.audio.context.resume(); } catch (e) {}
  }, { once: false, passive: true });

  function refreshContinue() {
    loadStoredRom().then(function (rec) {
      if (rec) { $('continue').hidden = false; $('continue').textContent = 'Continuar: ' + rec.name.replace(/\.[^.]+$/, ''); }
    });
  }

  applyTransform();
  checkAR();
  refreshContinue();
  createGba().catch(function (e) { $('ar-status').textContent = 'Erro a preparar o emulador: ' + e.message; });

  window.diorama = {
    get gba() { return gba; }, settings: settings, orbit: orbit,
    THREE: THREE, scene: scene, renderer: renderer, anchor: anchor, root: root,
    setEnvironment: setEnvironment, saveSettings: saveSettings, resize: resize, applyTransform: applyTransform,
    slots: slots, stack: stack, aspectH: aspectH,
    setMode: function (m) { mode = m; if (!m) { anchor.matrixAutoUpdate = true; anchor.position.set(0, 0, 0); anchor.quaternion.identity(); anchor.visible = true; resize(); } }
  };
})();
