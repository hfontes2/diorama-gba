// AR with a printed marker: works on phones without ARCore. The camera picture is shown behind the 3D view,
// an ArUco marker (ARUCO_MIP_36h12, id 0) or Hugo's JIM BIM AR marker is found, and the diorama is placed on it.
(function () {
  'use strict';
  var D = window.diorama, THREE = D.THREE;
  var $ = function (id) { return document.getElementById(id); };

  var DETECT_WIDTH = 480;
  var FOCAL = 0.815;          // focal length / image width, about 63° horizontal field of view

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
  var detector = null, stream = null, hasPose = false;
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
    processFrame(sctx.getImageData(0, 0, sw, sh));
  }

  // One camera frame: the table tracking carries the marker corners along, then a marker seen in the frame
  // replaces them. Returns true when the diorama has a place on the table.
  function processFrame(image) {
    var sw = image.width, sh = image.height, m;
    var tracked = trackTable(image);
    if (markerType() === 'jim') m = detectJim(image);
    else {
      var markers = detector.detect(image);
      m = markers.filter(function (x) { return x.id === 0; })[0] || markers[0];
    }
    if (m) {
      corners = m.corners.map(function (c) { return { x: c.x, y: c.y }; });
      replacePoints();
    } else if (!tracked) corners = null;
    if (corners) addFeatures(sw, sh);
    if (corners && poseFromCorners(corners, sw, sh, D.settings.markerSize / 100)) {
      target.decompose(tPos, tQuat, tScale);
      if (!hasPose) { curPos.copy(tPos); curQuat.copy(tQuat); }
      hasPose = true;
      return true;
    }
    corners = null;
    return false;
  }

  // ---------- Table tracking ----------
  // Once the marker has been found, the table's own texture keeps the diorama in place: points around the
  // marker are followed from frame to frame (optical flow), each one remembering where it lies on the table
  // in marker units. The homography from those table positions to where the points are now (RANSAC drops
  // points that are not on the table, like hands) gives the marker's 4 corners even when it is covered or
  // out of view, so the camera can walk all round the table. Seeing the marker again removes any drift.
  var TRACK_MAX = 200, TRACK_MIN = 80, TRACK_LOST = 10, TRACK_RADIUS = 0.6;  // radius in metres around the marker
  var MARKER_PLANE = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];  // corners in marker units
  var corners = null;          // marker corners in detection-image pixels, seen or carried by tracking
  var pyrA, pyrB, ptsPrev, ptsCur, ptsBack, ptsPlane, ptOk, ptBack, inFrom = [], inTo = [], nPts = 0, kps, fromPts = [], toPts = [], homo, inMask, hKernel;
  function trackSetup(w, h) {
    if (pyrA && pyrA.data[0].cols === w && pyrA.data[0].rows === h) return;
    var t = jsfeat.U8_t | jsfeat.C1_t;
    pyrA = new jsfeat.pyramid_t(3); pyrA.allocate(w, h, t);
    pyrB = new jsfeat.pyramid_t(3); pyrB.allocate(w, h, t);
    ptsPrev = new Float32Array(TRACK_MAX * 2); ptsCur = new Float32Array(TRACK_MAX * 2);
    ptsPlane = new Float32Array(TRACK_MAX * 2); ptsBack = new Float32Array(TRACK_MAX * 2);
    ptOk = new Uint8Array(TRACK_MAX); ptBack = new Uint8Array(TRACK_MAX);
    kps = []; for (var i = 0; i < w * h; i++) kps.push(new jsfeat.keypoint_t(0, 0, 0, 0));
    for (i = 0; i < TRACK_MAX; i++) { fromPts.push({ x: 0, y: 0 }); toPts.push({ x: 0, y: 0 }); }
    homo = new jsfeat.matrix_t(3, 3, jsfeat.F32_t | jsfeat.C1_t);
    inMask = new jsfeat.matrix_t(TRACK_MAX, 1, t);
    hKernel = new jsfeat.motion_model.homography2d();
    nPts = 0;
  }

  function trackTable(image) {
    var w = image.width, h = image.height;
    trackSetup(w, h);
    var t = pyrA; pyrA = pyrB; pyrB = t;           // pyrB: previous frame, pyrA: this frame
    jsfeat.imgproc.grayscale(image.data, w, h, pyrA.data[0]);
    pyrA.build(pyrA.data[0], true);
    if (!corners || nPts < TRACK_LOST) { nPts = 0; return false; }
    // Tracked forwards, then back again: a point that does not come back to where it started slipped.
    jsfeat.optical_flow_lk.track(pyrB, pyrA, ptsPrev, ptsCur, nPts, 15, 25, ptOk, 0.01, 0.0005);
    jsfeat.optical_flow_lk.track(pyrA, pyrB, ptsCur, ptsBack, nPts, 15, 25, ptBack, 0.01, 0.0005);
    var n = 0, i;
    for (i = 0; i < nPts; i++) {
      var ex = ptsBack[i * 2] - ptsPrev[i * 2], ey = ptsBack[i * 2 + 1] - ptsPrev[i * 2 + 1];
      if (!ptOk[i] || !ptBack[i] || ex * ex + ey * ey > 0.8) continue;
      fromPts[n].x = ptsPlane[i * 2]; fromPts[n].y = ptsPlane[i * 2 + 1];
      toPts[n].x = ptsCur[i * 2]; toPts[n].y = ptsCur[i * 2 + 1]; n++;
    }
    nPts = 0;
    if (n < TRACK_LOST || !ransac(n)) return false;
    // RANSAC keeps the homography of its best 4 points; fitting it again to all the points on the table is
    // much more precise, which matters because new points take their table position from it.
    var inl = 0;
    for (var pass = 0; pass < 2; pass++) {
      inl = 0;
      for (i = 0; i < n; i++) if (inMask.data[i]) { inFrom[inl] = fromPts[i]; inTo[inl] = toPts[i]; inl++; }
      if (inl < TRACK_LOST) return false;
      inFrom.length = inTo.length = inl;
      hKernel.run(inFrom, inTo, homo, inl);
      countInliers(homo.data, n, inMask.data);
    }
    inl = 0;
    for (i = 0; i < n; i++) if (inMask.data[i]) {
      ptsPrev[inl * 2] = toPts[i].x; ptsPrev[inl * 2 + 1] = toPts[i].y;
      ptsPlane[inl * 2] = fromPts[i].x; ptsPlane[inl * 2 + 1] = fromPts[i].y; inl++;
    }
    if (inl < TRACK_LOST) return false;
    nPts = inl;
    var H = homo.data;
    var found = MARKER_PLANE.map(function (c) {
      var z = H[6] * c[0] + H[7] * c[1] + H[8];
      return { x: (H[0] * c[0] + H[1] * c[1] + H[2]) / z, y: (H[3] * c[0] + H[4] * c[1] + H[5]) / z };
    });
    if (!sane(found, w, h)) { nPts = 0; return false; }
    corners = found;
    return true;
  }

  // Best homography from 4 random point pairs, by number of points within 2 pixels (marks them in inMask).
  // (jsfeat's own RANSAC gives up now and then when its sample check rejects too many subsets.)
  function ransac(n) {
    var best = 0, bestH = null, idx = [0, 0, 0, 0], it, i, j;
    for (it = 0; it < 150; it++) {
      for (i = 0; i < 4; i++) {
        do { idx[i] = (Math.random() * n) | 0; for (j = 0; j < i && idx[j] !== idx[i]; j++); } while (j < i);
      }
      var Hc = homography(idx.map(function (k) { return [fromPts[k].x, fromPts[k].y]; }), idx.map(function (k) { return [toPts[k].x, toPts[k].y]; }));
      if (!Hc) continue;
      var c = countInliers(Hc, n, null);
      if (c > best) { best = c; bestH = Hc; if (c > n * 0.9) break; }
    }
    if (!bestH || best < TRACK_LOST) return false;
    countInliers(bestH, n, inMask.data);
    return true;
  }
  function countInliers(H, n, mask) {
    var c = 0;
    for (var i = 0; i < n; i++) {
      var f = fromPts[i], z = H[6] * f.x + H[7] * f.y + H[8];
      var dx = (H[0] * f.x + H[1] * f.y + H[2]) / z - toPts[i].x, dy = (H[3] * f.x + H[4] * f.y + H[5]) / z - toPts[i].y;
      var ok = dx * dx + dy * dy < 4;
      if (mask) mask[i] = ok ? 1 : 0;
      if (ok) c++;
    }
    return c;
  }

  // The 4 corners must still make a convex quadrilateral of reasonable size.
  function sane(c, w, h) {
    var sign = 0;
    for (var i = 0; i < 4; i++) {
      var a = c[i], b = c[(i + 1) % 4], d = c[(i + 2) % 4];
      var cr = (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x);
      if (!isFinite(cr) || Math.abs(cr) < 4) return false;
      if (sign && Math.sign(cr) !== sign) return false;
      sign = Math.sign(cr);
      if (Math.abs(a.x) > w * 20 || Math.abs(a.y) > h * 20) return false;
    }
    return true;
  }

  // Image pixels to marker units on the table, through the homography of the current corners.
  function imageToPlane() {
    var Hm = homography(MARKER_PLANE, corners.map(function (c) { return [c.x, c.y]; }));
    return Hm && invert3(Hm);
  }

  // A marker seen in the frame gives the exact table positions of the tracked points again.
  function replacePoints() {
    var Hi = imageToPlane();
    if (!Hi) return;
    for (var i = 0; i < nPts; i++) {
      var x = ptsPrev[i * 2], y = ptsPrev[i * 2 + 1], z = Hi[6] * x + Hi[7] * y + Hi[8];
      ptsPlane[i * 2] = (Hi[0] * x + Hi[1] * y + Hi[2]) / z; ptsPlane[i * 2 + 1] = (Hi[3] * x + Hi[4] * y + Hi[5]) / z;
    }
  }

  // Tops the tracked points up with new corners (FAST) that lie on the table near the marker: each candidate
  // is taken back to the table plane through the marker's homography and kept only if it falls within
  // TRACK_RADIUS of the marker, in front of the camera (this leaves out walls and things behind the table).
  function addFeatures(w, h) {
    if (nPts >= TRACK_MIN) return;
    var Hi = imageToPlane();
    if (!Hi) return;
    var r = TRACK_RADIUS / (D.settings.markerSize / 100), front = Math.sign(Hi[8]);
    jsfeat.fast_corners.set_threshold(18);
    var count = jsfeat.fast_corners.detect(pyrA.data[0], kps, 6), cands = [], i;
    for (i = 0; i < count; i++) {
      var k = kps[i], z = Hi[6] * k.x + Hi[7] * k.y + Hi[8];
      if (Math.sign(z) !== front) continue;
      k.u = (Hi[0] * k.x + Hi[1] * k.y + Hi[2]) / z; k.v = (Hi[3] * k.x + Hi[4] * k.y + Hi[5]) / z;
      if (k.u * k.u + k.v * k.v < r * r) cands.push(k);
    }
    cands.sort(function (p, q) { return q.score - p.score; });
    var MIN_D2 = 10 * 10;
    for (i = 0; i < cands.length && nPts < TRACK_MAX; i++) {
      var x = cands[i].x, y = cands[i].y, near = false;
      for (var j = 0; j < nPts && !near; j++) {
        var dx = ptsPrev[j * 2] - x, dy = ptsPrev[j * 2 + 1] - y;
        near = dx * dx + dy * dy < MIN_D2;
      }
      if (!near) { ptsPrev[nPts * 2] = x; ptsPrev[nPts * 2 + 1] = y; ptsPlane[nPts * 2] = cands[i].u; ptsPlane[nPts * 2 + 1] = cands[i].v; nPts++; }
    }
  }

  function invert3(m) {
    var a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
    var A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) return null;
    return [A / det, (c * h - b * i) / det, (b * f - c * e) / det,
            B / det, (a * i - c * g) / det, (c * d - a * f) / det,
            C / det, (b * g - a * h) / det, (a * e - b * d) / det];
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

  // "Fixar": keeps the diorama at its last place when the camera loses both the marker and the table.
  var locked = false;
  function setLocked(on) {
    locked = on;
    var b = $('marker-lock');
    b.setAttribute('aria-pressed', String(on)); b.textContent = on ? 'Fixado' : 'Fixar';
  }

  var markerMode = {
    update: function () {
      layoutCamera();
      detect();
      // With "Fixar" on, the diorama stays at its last place even when neither the marker nor the table is seen.
      var seen = !!corners || (locked && hasPose);
      D.anchor.visible = seen;
      $('ar-hint').hidden = !!corners;
      if (!corners) $('ar-hint').textContent = hasPose ? 'Aponta outra vez para o marcador' : 'Aponta a câmara para o marcador';
      if (!seen) { hasPose = false; return; }
      curPos.lerp(tPos, 0.5); curQuat.slerp(tQuat, 0.5);
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
        hasPose = false; corners = null; nPts = 0;
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

  D.marker = { start: start, stop: stop, active: function () { return !!stream; }, poseFromCorners: poseFromCorners, target: target,
    _process: function (image) { detector = detector || new AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12' }); var ok = processFrame(image); return { ok: ok, corners: corners, points: nPts }; } };
})();
