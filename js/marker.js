// AR with a printed marker: works on phones without ARCore. The camera picture is shown behind the 3D view,
// an ArUco marker (ARUCO_MIP_36h12, id 0) is found in each frame, and the diorama is placed on it.
(function () {
  'use strict';
  var D = window.diorama, THREE = D.THREE;
  var $ = function (id) { return document.getElementById(id); };

  var DETECT_WIDTH = 480;
  var FOCAL = 0.815;          // focal length / image width, about 63° horizontal field of view
  var LOST_MS = 700;

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
    var markers = detector.detect(sctx.getImageData(0, 0, sw, sh));
    var m = markers.filter(function (x) { return x.id === 0; })[0] || markers[0];
    if (m && poseFromCorners(m.corners, sw, sh, D.settings.markerSize / 100)) {
      target.decompose(tPos, tQuat, tScale);
      if (!hasPose || performance.now() - lastSeen > LOST_MS) { curPos.copy(tPos); curQuat.copy(tQuat); }
      lastSeen = performance.now(); hasPose = true;
      $('ar-hint').hidden = true;
    }
  }

  var markerMode = {
    update: function () {
      layoutCamera();
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
    D.setEnvironment('preview');
    D.setMode(null);
  }

  D.marker = { start: start, stop: stop, active: function () { return !!stream; }, poseFromCorners: poseFromCorners, target: target };
})();
