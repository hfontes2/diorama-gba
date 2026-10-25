// AR with a printed marker: works on phones without ARCore. The camera picture is shown behind the 3D view,
// an ArUco marker (ARUCO_MIP_36h12, id 0) is found in each frame, and the diorama is placed on it.
(function () {
  'use strict';
  var D = window.diorama, THREE = D.THREE;
  var $ = function (id) { return document.getElementById(id); };

  var DETECT_WIDTH = 480;
  var FOCAL = 0.815;          // focal length / image width, about 63° horizontal field of view
  var LOST_MS = 700;

  // Hugo's "JIM BIM AR" marker (ARToolKit style): a black square with a 25% border and a white inner square
  // holding this pattern, 16 x 16 cells, top row first, 1 = white. Printed from its PDF at 100%, the black
  // square measures 10.5 cm.
  var JIM_PATTERN = [
    '1111111111111111', '1111111111111111', '1100011000000011', '1100011000000011',
    '1100011000000011', '1100011111000111', '1100011111000111', '1100000011000111',
    '1100000011000111', '1100000011111111', '1100011111111111', '1100000000001111',
    '1100000000001111', '1100000000001111', '1111111111111111', '1111111111111111'
  ].map(function (r) { return r.split('').map(Number); });
  var JIM_MIN_MATCH = 0.86;   // share of pattern cells that must agree
  var WARP = 64;

  var video = $('camera-feed');
  var small = document.createElement('canvas');
  var sctx = small.getContext('2d', { willReadFrequently: true });
  var cam = new THREE.PerspectiveCamera(50, 1, 0.01, 30);
  var detector = null, stream = null, lastSeen = 0, hasPose = false;
  var curPos = new THREE.Vector3(), curQuat = new THREE.Quaternion();
  var tPos = new THREE.Vector3(), tQuat = new THREE.Quaternion(), tScale = new THREE.Vector3();
  var target = new THREE.Matrix4();

  // Solves the 8x8 system for the homography that maps marker-plane points (u, v) to normalised image points.
  function homography(src, dst) {
    var A = [], i, j, k;
    for (i = 0; i < 4; i++) {
      var u = src[i][0], v = src[i][1], x = dst[i][0], y = dst[i][1];
      A.push([u, v, 1, 0, 0, 0, -x * u, -x * v, x]);
      A.push([0, 0, 0, u, v, 1, -y * u, -y * v, y]);
    }
    for (i = 0; i < 8; i++) {
      var piv = i;
      for (j = i + 1; j < 8; j++) if (Math.abs(A[j][i]) > Math.abs(A[piv][i])) piv = j;
      var tmp = A[i]; A[i] = A[piv]; A[piv] = tmp;
      if (Math.abs(A[i][i]) < 1e-12) return null;
      for (j = 0; j < 8; j++) {
        if (j === i) continue;
        var f = A[j][i] / A[i][i];
        for (k = i; k < 9; k++) A[j][k] -= f * A[i][k];
      }
    }
    var h = [];
    for (i = 0; i < 8; i++) h.push(A[i][8] / A[i][i]);
    h.push(1);
    return h; // row-major 3x3
  }

  // Marker pose from its 4 corners (top-left, top-right, bottom-right, bottom-left in image pixels).
  function poseFromCorners(corners, w, h, size) {
    var f = FOCAL * w, cx = w / 2, cy = h / 2, a = size / 2;
    var src = [[-a, -a], [a, -a], [a, a], [-a, a]];
    var dst = corners.map(function (c) { return [(c.x - cx) / f, (c.y - cy) / f]; });
    var H = homography(src, dst);
    if (!H) return false;
    var h1 = new THREE.Vector3(H[0], H[3], H[6]), h2 = new THREE.Vector3(H[1], H[4], H[7]), h3 = new THREE.Vector3(H[2], H[5], H[8]);
    var lambda = 2 / (h1.length() + h2.length());
    var r1 = h1.multiplyScalar(lambda), r2 = h2.multiplyScalar(lambda), t = h3.multiplyScalar(lambda);
    if (t.z < 0) { r1.negate(); r2.negate(); t.negate(); }
    r1.normalize();
    r2.sub(r1.clone().multiplyScalar(r1.dot(r2))).normalize();
    var r3 = new THREE.Vector3().crossVectors(r1, r2);
    // Camera frame (x right, y down, z forward) to three.js (x right, y up, z backward).
    var C = function (v) { return new THREE.Vector3(v.x, -v.y, -v.z); };
    // Diorama axes: x along the marker's top edge, y out of the paper, z towards the marker's bottom edge.
    target.makeBasis(C(r1), C(r3.clone().negate()), C(r2));
    target.setPosition(C(t));
    return true;
  }

  function layoutCamera() {
    var W = window.innerWidth, Hh = window.innerHeight, vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    var k = Math.max(W / vw, Hh / vh), dw = vw * k, dh = vh * k;
    cam.aspect = vw / vh;
    cam.fov = 2 * Math.atan(vh / 2 / (FOCAL * vw)) * 180 / Math.PI;
    cam.setViewOffset(dw, dh, (dw - W) / 2, (dh - Hh) / 2, W, Hh);
    cam.updateProjectionMatrix();
  }

  function detect() {
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || video.readyState < 2) return;
    var sw = DETECT_WIDTH, sh = Math.round(DETECT_WIDTH * vh / vw);
    if (small.width !== sw || small.height !== sh) { small.width = sw; small.height = sh; }
    sctx.drawImage(video, 0, 0, sw, sh);
    var m;
    if (markerType() === 'jim') m = detectJim(sctx.getImageData(0, 0, sw, sh));
    else {
      var markers = detector.detect(sctx.getImageData(0, 0, sw, sh));
      m = markers.filter(function (x) { return x.id === 0; })[0] || markers[0];
    }
    if (m && poseFromCorners(m.corners, sw, sh, D.settings.markerSize / 100)) {
      target.decompose(tPos, tQuat, tScale);
      if (!hasPose || performance.now() - lastSeen > LOST_MS) { curPos.copy(tPos); curQuat.copy(tQuat); }
      lastSeen = performance.now(); hasPose = true;
      $('ar-hint').hidden = true;
    }
  }

  function markerType() { return D.settings.markerType === 'aruco' ? 'aruco' : 'jim'; }

  // Finds the JIM marker: js-aruco2 finds the dark squares, then each one is straightened, its border
  // checked and its inner pattern compared with JIM_PATTERN in the 4 rotations.
  var warped = null;
  function detectJim(image) {
    detector.detect(image);   // fills detector.grey and detector.candidates
    warped = warped || new CV.Image();
    var best = null, cands = detector.candidates || [];
    for (var c = 0; c < cands.length; c++) {
      CV.warp(detector.grey, warped, cands[c], WARP);
      CV.threshold(warped, warped, CV.otsu(warped));
      var d = warped.data, q = WARP / 4, cell = WARP / 2 / 16, x, y;
      // the border (outer quarter) must be nearly all black
      var white = 0, total = 0;
      for (y = 2; y < WARP - 2; y += 2) for (x = 2; x < WARP - 2; x += 2) {
        if (x >= q && x < WARP - q && y >= q && y < WARP - q) continue;
        total++; if (d[y * WARP + x]) white++;
      }
      if (white > total * 0.12) continue;
      // Sample one extra cell all round, so a pattern seen a cell off (small markers, rough corners) still matches.
      var bits = [];
      for (var i = 0; i < 18; i++) {
        bits[i] = [];
        for (var j = 0; j < 18; j++) {
          var sx = Math.min(WARP - 1, Math.max(0, (q + (j - 0.5) * cell) | 0)), sy = Math.min(WARP - 1, Math.max(0, (q + (i - 0.5) * cell) | 0));
          bits[i][j] = d[sy * WARP + sx] ? 1 : 0;
        }
      }
      var rot = bits;
      for (var r = 0; r < 4; r++) {
        for (var oy = 0; oy <= 2; oy++) for (var ox = 0; ox <= 2; ox++) {
          var same = 0;
          for (i = 0; i < 16; i++) for (j = 0; j < 16; j++) if (rot[i + oy][j + ox] === JIM_PATTERN[i][j]) same++;
          var score = same / 256;
          if (score >= JIM_MIN_MATCH && (!best || score > best.score)) best = { score: score, corners: detector.rotate2(cands[c], 4 - r) };
        }
        rot = detector.rotate(rot);
      }
    }
    return best;
  }

  // "Fixar": keeps the diorama where it is, even when the marker is covered or out of view.
  var locked = false;
  function setLocked(on) {
    locked = on;
    var b = $('marker-lock');
    b.setAttribute('aria-pressed', String(on)); b.textContent = on ? 'Fixado' : 'Fixar';
  }

  var markerMode = {
    update: function () {
      layoutCamera();
      if (locked && hasPose) { D.anchor.visible = true; $('ar-hint').hidden = true; return; }
      detect();
      var seen = hasPose && performance.now() - lastSeen < LOST_MS;
      D.anchor.visible = seen;
      if (!seen) { $('ar-hint').hidden = false; return; }
      curPos.lerp(tPos, 0.45); curQuat.slerp(tQuat, 0.45);
      D.anchor.matrixAutoUpdate = false;
      D.anchor.matrix.compose(curPos, curQuat, new THREE.Vector3(1, 1, 1));
      D.anchor.matrixWorldNeedsUpdate = true;
    },
    render: function () { D.renderer.render(D.scene, cam); }
  };

  function start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('ar-status').textContent = 'Este browser não dá acesso à câmara.'; return;
    }
    detector = detector || new AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12' });
    navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } })
      .then(function (s) {
        stream = s; video.srcObject = s; video.hidden = false;
        return video.play();
      }).then(function () {
        hasPose = false;
        D.setEnvironment('camera');
        D.setMode(markerMode);
        document.body.classList.add('camera-mode');
        $('ar-hint').textContent = 'Aponta a câmara para o marcador';
        $('ar-hint').hidden = false;
        $('mode-exit').hidden = false;
        $('marker-lock').hidden = false; setLocked(false);
      }).catch(function (e) {
        $('layers-info').textContent = 'Não consegui abrir a câmara: ' + e.message;
        $('menu').hidden = false;
      });
  }

  function stop() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null; video.srcObject = null; video.hidden = true;
    document.body.classList.remove('camera-mode');
    $('ar-hint').hidden = true;
    $('marker-lock').hidden = true; setLocked(false);
    D.setEnvironment('preview');
    D.setMode(null);
  }

  $('marker-lock').addEventListener('click', function () { setLocked(!locked); });

  D.marker = { start: start, stop: stop, active: function () { return !!stream; }, poseFromCorners: poseFromCorners, target: target };
})();
