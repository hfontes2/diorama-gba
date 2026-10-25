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
    lastImage = image;
    var tracked = trackTable(image);
    if (markerType() === 'jim') m = detectJim(image);
    else {
      var markers = detector.detect(image);
      m = markers.filter(function (x) { return x.id === 0; })[0] || markers[0];
    }
    if (m) {
      // The table's many tracked points place the marker more steadily than its 4 detected corners, so while
      // the two agree the detection only nudges the tracked corners (removing drift); otherwise it wins.
      lastMarkerAt = performance.now();
      var det = m.corners, far = !tracked;
      for (var k = 0; k < 4 && !far; k++) far = Math.hypot(det[k].x - corners[k].x, det[k].y - corners[k].y) > SNAP_PX;
      corners = det.map(function (c, k) {
        return far ? { x: c.x, y: c.y } : { x: corners[k].x + (c.x - corners[k].x) * NUDGE, y: corners[k].y + (c.y - corners[k].y) * NUDGE };
      });
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
  var SNAP_PX = 6, NUDGE = 0.1;   // detection vs tracking, in detection-image pixels
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
      if (table ? inside(table, k.u, k.v) : k.u * k.u + k.v * k.v < r * r) cands.push(k);
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

  // ---------- Without a marker: gravity and a tap ----------
  // The phone's accelerometer says which way is up, so the table's tilt relative to the camera is known; its
  // distance is not, so it is taken as CAM_HEIGHT. A tap on the table puts a virtual marker square there
  // (projected into the picture as 4 corners), and from then on the table tracking above keeps it in place,
  // exactly as after a real marker.
  var CAM_HEIGHT = 0.5;                  // metres from the camera down to the table, a guess
  var up = null, lastMarkerAt = 0;       // up: smoothed gravity reaction in device axes (x right, y top, z out of screen)
  function onMotion(e) {
    var g = e.accelerationIncludingGravity;
    if (!g || g.x === null) return;
    if (!up) up = { x: g.x, y: g.y, z: g.z };
    else { up.x += (g.x - up.x) * 0.2; up.y += (g.y - up.y) * 0.2; up.z += (g.z - up.z) * 0.2; }
  }
  // Up, in camera axes (x right, y down, z forward), allowing for the screen being turned.
  function upInCamera() {
    if (!up) return null;
    var a = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * Math.PI / 180;
    var sx = up.x * Math.cos(a) + up.y * Math.sin(a), sy = -up.x * Math.sin(a) + up.y * Math.cos(a);
    var v = new THREE.Vector3(sx, -sy, -up.z), L = v.length();
    return L > 3 ? v.divideScalar(L) : null;   // no reading, or the phone is being shaken
  }
  // Puts the game where the screen point (detection-image pixels) meets the table. Returns false if it cannot.
  function placeOnTable(x, y) {
    var n = upInCamera();
    if (!n || !small.width) return false;
    var f = FOCAL * small.width, cx = small.width / 2, cy = small.height / 2;
    var d = new THREE.Vector3((x - cx) / f, (y - cy) / f, 1), nd = n.dot(d);
    if (nd > -0.05) return false;                 // looking at or above the horizon
    var P = d.multiplyScalar(-CAM_HEIGHT / nd);
    var e1 = new THREE.Vector3(1, 0, 0).sub(n.clone().multiplyScalar(n.x)).normalize(), e2 = e1.clone().cross(n);
    // The game sits behind its anchor (see applyTransform in app.js): move the anchor so the game's centre is at the tap.
    P.addScaledVector(e2, (D.aspectH / 2 + 0.02) * D.settings.size / 100);
    var a = D.settings.markerSize / 200;
    var pts = [[-a, -a], [a, -a], [a, a], [-a, a]].map(function (q) {
      var X = P.clone().addScaledVector(e1, q[0]).addScaledVector(e2, q[1]);
      return { x: f * X.x / X.z + cx, y: f * X.y / X.z + cy };
    });
    if (!sane(pts, small.width, small.height)) return false;
    corners = pts; nPts = 0; hasPose = false; table = null;
    addFeatures(small.width, small.height);
    return true;
  }
  $('view').addEventListener('click', function (e) {
    if (!stream || editPts || performance.now() - lastMarkerAt < 1500) return;   // a real marker in view wins
    var q = fromScreen(e.clientX, e.clientY);
    if (!placeOnTable(q[0], q[1])) { $('ar-hint').textContent = up ? 'Aponta mais para baixo, para a mesa, e toca outra vez' : 'Este telemóvel não deu o sensor de gravidade: usa o marcador'; $('ar-hint').hidden = false; }
  });

  // ---------- Table outline (like a document scanner) ----------
  // "Mesa" finds the table top around the marker: the camera picture is straightened onto the table plane
  // (seen from above), the region with the table's colour is grown outwards from around the marker, and
  // the smallest rectangle around it gives 4 corners, which can then be dragged. Once confirmed, the game
  // is centred on the table and sized to fit it, and only points on the table are tracked.
  var table = null, tableOffset = new THREE.Matrix4(), lastImage = null;
  var GRID = 160, SEARCH_M = 1.0;   // straightened picture: GRID x GRID cells over +-SEARCH_M metres

  function inside(poly, u, v) {
    var c = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var a = poly[i], b = poly[j];
      if ((a[1] > v) !== (b[1] > v) && u < (b[0] - a[0]) * (v - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }

  function detectTable() {
    if (!corners || !lastImage) return null;
    var Hm = homography(MARKER_PLANE, corners.map(function (c) { return [c.x, c.y]; }));
    if (!Hm) return null;
    var w = lastImage.width, h = lastImage.height, d = lastImage.data, N = GRID;
    var R = SEARCH_M / (D.settings.markerSize / 100), cell = 2 * R / N, front = Math.sign(Hm[8]);
    var col = new Float32Array(N * N * 3), ok = new Uint8Array(N * N), gx, gy, i, k;
    for (gy = 0; gy < N; gy++) for (gx = 0; gx < N; gx++) {
      var u = -R + (gx + 0.5) * cell, v = -R + (gy + 0.5) * cell, z = Hm[6] * u + Hm[7] * v + Hm[8];
      if (Math.sign(z) !== front) continue;
      var x = (Hm[0] * u + Hm[1] * v + Hm[2]) / z, y = (Hm[3] * u + Hm[4] * v + Hm[5]) / z;
      if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) continue;
      var o = ((y | 0) * w + (x | 0)) * 4; i = gy * N + gx;
      col[i * 3] = d[o]; col[i * 3 + 1] = d[o + 1]; col[i * 3 + 2] = d[o + 2]; ok[i] = 1;
    }
    // Blur twice (3 x 3) so wood grain and noise do not stop the region from growing.
    for (var pass = 0; pass < 2; pass++) {
      var out = new Float32Array(col.length);
      for (gy = 0; gy < N; gy++) for (gx = 0; gx < N; gx++) {
        i = gy * N + gx; if (!ok[i]) continue;
        var sr = 0, sg = 0, sb = 0, n = 0;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          var X = gx + dx, Y = gy + dy; if (X < 0 || Y < 0 || X >= N || Y >= N) continue;
          var j = Y * N + X; if (!ok[j]) continue;
          sr += col[j * 3]; sg += col[j * 3 + 1]; sb += col[j * 3 + 2]; n++;
        }
        out[i * 3] = sr / n; out[i * 3 + 1] = sg / n; out[i * 3 + 2] = sb / n;
      }
      col = out;
    }
    // The table's colour: the median of a ring around the marker, past the paper it is printed on.
    var ring = [], inner = 2.6, outer = 3.6, seeds = [];
    for (i = 0; i < N * N; i++) {
      if (!ok[i]) continue;
      var uu = -R + ((i % N) + 0.5) * cell, vv = -R + (((i / N) | 0) + 0.5) * cell, rr = Math.hypot(uu, vv);
      if (rr >= inner && rr <= outer) { ring.push(i); }
    }
    if (ring.length < 20) return null;
    var med = [0, 1, 2].map(function (c) { var a = ring.map(function (i) { return col[i * 3 + c]; }).sort(function (p, q) { return p - q; }); return a[a.length >> 1]; });
    function dist(i, c) { return Math.hypot(col[i * 3] - c[0], col[i * 3 + 1] - c[1], col[i * 3 + 2] - c[2]); }
    var devs = ring.map(function (i) { return dist(i, med); }).sort(function (p, q) { return p - q; });
    var tol = Math.max(35, Math.min(110, devs[(devs.length * 0.8) | 0] * 1.8));
    var region = new Uint8Array(N * N), queue = [];
    for (i = 0; i < N * N; i++) {
      if (!ok[i]) continue;
      var cu = -R + ((i % N) + 0.5) * cell, cv = -R + (((i / N) | 0) + 0.5) * cell, cr = Math.hypot(cu, cv);
      if (cr < inner || (cr <= outer && dist(i, med) < tol)) { region[i] = 1; queue.push(i); }
    }
    // Grow: a neighbour joins when it looks like the cell next to it and not too far from the table's colour.
    for (k = 0; k < queue.length; k++) {
      i = queue[k]; gx = i % N; gy = (i / N) | 0;
      var nb = [gx > 0 ? i - 1 : -1, gx < N - 1 ? i + 1 : -1, gy > 0 ? i - N : -1, gy < N - 1 ? i + N : -1];
      for (var q = 0; q < 4; q++) {
        var j2 = nb[q];
        if (j2 < 0 || region[j2] || !ok[j2]) continue;
        if (dist(j2, [col[i * 3], col[i * 3 + 1], col[i * 3 + 2]]) < tol * 0.35 && dist(j2, med) < tol) { region[j2] = 1; queue.push(j2); }
      }
    }
    var pts = [];
    for (i = 0; i < N * N; i++) if (region[i]) pts.push([-R + ((i % N) + 0.5) * cell, -R + (((i / N) | 0) + 0.5) * cell]);
    return minAreaRect(hull(pts));
  }

  function hull(p) {
    p = p.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    var lo = [], up = [], i;
    for (i = 0; i < p.length; i++) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p[i]) <= 0) lo.pop(); lo.push(p[i]); }
    for (i = p.length - 1; i >= 0; i--) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p[i]) <= 0) up.pop(); up.push(p[i]); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }

  // Smallest rectangle around a convex polygon: one of its sides lies along an edge of the polygon.
  function minAreaRect(h) {
    if (h.length < 3) return null;
    var best = null;
    for (var i = 0; i < h.length; i++) {
      var a = h[i], b = h[(i + 1) % h.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 1e-9) continue;
      var ex = (b[0] - a[0]) / L, ey = (b[1] - a[1]) / L, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (var j = 0; j < h.length; j++) {
        var px = h[j][0] * ex + h[j][1] * ey, py = -h[j][0] * ey + h[j][1] * ex;
        x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      }
      var area = (x1 - x0) * (y1 - y0);
      if (!best || area < best.area) best = { area: area, ex: ex, ey: ey, x0: x0, x1: x1, y0: y0, y1: y1 };
    }
    var r = best;
    return [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]].map(function (p) {
      return [p[0] * r.ex - p[1] * r.ey, p[0] * r.ey + p[1] * r.ex];
    });
  }

  // Centres the game on the table, turned to the nearest table side facing the camera, as big as fits.
  function fitTable(poly) {
    var s = D.settings.markerSize / 100, c = [0, 0], i;
    poly.forEach(function (p) { c[0] += p[0] / 4; c[1] += p[1] / 4; });
    var e0 = [poly[1][0] - poly[0][0], poly[1][1] - poly[0][1]], e1 = [poly[2][0] - poly[1][0], poly[2][1] - poly[1][1]];
    var L0 = (Math.hypot(e0[0], e0[1]) + Math.hypot(poly[2][0] - poly[3][0], poly[2][1] - poly[3][1])) / 2;
    var L1 = (Math.hypot(e1[0], e1[1]) + Math.hypot(poly[3][0] - poly[0][0], poly[3][1] - poly[0][1])) / 2;
    // Where the camera is, on the table plane in marker units.
    var inv = new THREE.Matrix4().compose(curPos, curQuat, new THREE.Vector3(1, 1, 1)).invert();
    var camL = new THREE.Vector3().applyMatrix4(inv), dc = [camL.x / s - c[0], camL.z / s - c[1]];
    var best = null;
    [[e0, L0, L1], [e1, L1, L0]].forEach(function (e) {
      var n = Math.hypot(e[0][0], e[0][1]);
      [1, -1].forEach(function (sg) {
        var a = [sg * e[0][0] / n, sg * e[0][1] / n], zd = [-a[1], a[0]], score = zd[0] * dc[0] + zd[1] * dc[1];
        if (!best || score > best.score) best = { score: score, a: a, Lx: e[1], Lz: e[2] };
      });
    });
    var aspectH = D.aspectH, size = Math.min(0.92 * best.Lx * s, 0.92 * best.Lz * s / (aspectH + 0.04));
    size = Math.max(0.15, Math.min(1, size));
    var el = $('size'); el.value = Math.round(size * 100); el.dispatchEvent(new Event('input'));
    size = D.settings.size / 100;
    var alpha = Math.atan2(-best.a[1], best.a[0]);
    // The diorama sits behind its anchor (see applyTransform in app.js); move it back onto the centre.
    var back = new THREE.Vector3(0, 0, (aspectH / 2 + 0.02) * size).applyAxisAngle(new THREE.Vector3(0, 1, 0), alpha);
    tableOffset.makeRotationY(alpha).setPosition(c[0] * s + back.x, 0, c[1] * s + back.z);
  }

  // Detection-image pixels <-> screen pixels (the video fills the screen like object-fit: cover).
  function toScreen(x, y) {
    var W = window.innerWidth, H = window.innerHeight, vw = video.videoWidth, vh = video.videoHeight, k = Math.max(W / vw, H / vh);
    return [x * vw / small.width * k + (W - vw * k) / 2, y * vh / small.height * k + (H - vh * k) / 2];
  }
  function fromScreen(X, Y) {
    var W = window.innerWidth, H = window.innerHeight, vw = video.videoWidth, vh = video.videoHeight, k = Math.max(W / vw, H / vh);
    return [(X - (W - vw * k) / 2) / k * small.width / vw, (Y - (H - vh * k) / 2) / k * small.height / vh];
  }

  var editPts = null, dragK = -1;
  function startEdit() {
    if (!corners) { $('ar-hint').textContent = 'Aponta primeiro para o marcador'; $('ar-hint').hidden = false; return; }
    var a = 4;
    editPts = table ? table.map(function (p) { return p.slice(); }) : (detectTable() || [[-a, -a], [a, -a], [a, a], [-a, a]]);
    $('table-edit').hidden = false; document.body.classList.add('table-editing');
  }
  function endEdit(ok) {
    if (ok && editPts) { table = editPts; fitTable(table); nPts = 0; }
    editPts = null; dragK = -1;
    $('table-edit').hidden = true; document.body.classList.remove('table-editing');
  }
  function drawEdit() {
    if (!editPts) return;
    var poly = $('table-poly'), circles = $('table-svg').querySelectorAll('circle');
    var Hm = corners && homography(MARKER_PLANE, corners.map(function (c) { return [c.x, c.y]; }));
    poly.style.display = Hm ? '' : 'none';
    if (!Hm) return;
    var sp = editPts.map(function (p) {
      var z = Hm[6] * p[0] + Hm[7] * p[1] + Hm[8];
      return toScreen((Hm[0] * p[0] + Hm[1] * p[1] + Hm[2]) / z, (Hm[3] * p[0] + Hm[4] * p[1] + Hm[5]) / z);
    });
    poly.setAttribute('points', sp.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '));
    // A corner outside the picture is shown at its edge, so it can still be grabbed and dragged in.
    var W = window.innerWidth, H = window.innerHeight, top = 70, bottom = H - 120;
    sp.forEach(function (p, k) {
      circles[k].setAttribute('cx', Math.max(20, Math.min(W - 20, p[0])).toFixed(1));
      circles[k].setAttribute('cy', Math.max(top, Math.min(bottom, p[1])).toFixed(1));
    });
  }
  (function () {
    var svg = $('table-svg');
    Array.prototype.forEach.call(svg.querySelectorAll('circle'), function (c, k) {
      c.addEventListener('pointerdown', function (e) { e.preventDefault(); dragK = k; try { c.setPointerCapture(e.pointerId); } catch (err) {} });
      c.addEventListener('pointermove', function (e) {
        if (dragK !== k || !corners) return;
        var Hi = imageToPlane(); if (!Hi) return;
        var q = fromScreen(e.clientX, e.clientY), z = Hi[6] * q[0] + Hi[7] * q[1] + Hi[8];
        editPts[k] = [(Hi[0] * q[0] + Hi[1] * q[1] + Hi[2]) / z, (Hi[3] * q[0] + Hi[4] * q[1] + Hi[5]) / z];
        drawEdit();
      });
      c.addEventListener('pointerup', function () { dragK = -1; });
    });
    $('table-btn').addEventListener('click', startEdit);
    $('table-ok').addEventListener('click', function () { endEdit(true); });
    $('table-cancel').addEventListener('click', function () { endEdit(false); });
  })();

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
    b.setAttribute('aria-pressed', String(on)); b.title = on ? 'Fixado' : 'Fixar';
  }

  var markerMode = {
    update: function () {
      layoutCamera();
      detect();
      drawEdit();
      // With "Fixar" on, the diorama stays at its last place even when neither the marker nor the table is seen.
      var seen = (!!corners || (locked && hasPose)) && !editPts;   // the game is hidden while the table is outlined
      D.anchor.visible = seen;
      $('ar-hint').hidden = !!corners;
      if (!corners) $('ar-hint').textContent = hasPose ? 'Aponta outra vez para o marcador' : (up ? 'Aponta para o marcador, ou toca na mesa' : 'Aponta a câmara para o marcador');
      if (!seen) { if (!editPts) hasPose = false; return; }
      // Smooth more while the phone is nearly still (small differences are noise) and follow quickly when it moves.
      var a = Math.min(0.85, Math.max(0.2, curPos.distanceTo(tPos) / 0.01, curQuat.angleTo(tQuat) / 0.035));
      curPos.lerp(tPos, a); curQuat.slerp(tQuat, a);
      D.anchor.matrixAutoUpdate = false;
      D.anchor.matrix.compose(curPos, curQuat, new THREE.Vector3(1, 1, 1));
      if (table) D.anchor.matrix.multiply(tableOffset);
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
        hasPose = false; corners = null; nPts = 0; up = null;
        window.addEventListener('devicemotion', onMotion);
        D.setEnvironment('camera');
        D.setMode(markerMode);
        document.body.classList.add('camera-mode');
        $('ar-hint').textContent = 'Aponta a câmara para o marcador';
        $('ar-hint').hidden = false;
        $('marker-lock').hidden = false; setLocked(false);
        $('table-btn').hidden = false; table = null;
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
    $('table-btn').hidden = true; endEdit(false); table = null;
    window.removeEventListener('devicemotion', onMotion);
    D.setEnvironment('preview');
    D.setMode(null);
  }

  $('marker-lock').addEventListener('click', function () { setLocked(!locked); });

  D.marker = { start: start, stop: stop, active: function () { return !!stream; }, poseFromCorners: poseFromCorners, target: target,
    _place: function (x, y) { return placeOnTable(x, y); }, _detectTable: function () { return detectTable(); }, _process: function (image) { detector = detector || new AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12' }); var ok = processFrame(image); return { ok: ok, corners: corners, points: nPts }; } };
})();
