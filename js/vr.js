// VR view for phone headsets (Cardboard style): side-by-side stereo picture, head tracking from the gyroscope.
// Needs no ARCore. Play with a Bluetooth controller, since the screen is inside the headset.
(function () {
  'use strict';
  var D = window.diorama, THREE = D.THREE;
  var $ = function (id) { return document.getElementById(id); };

  var IPD = 0.064, VR_SIZE = 1.0;
  var head = new THREE.Object3D();
  var eyeL = new THREE.PerspectiveCamera(80, 1, 0.01, 40), eyeR = eyeL.clone();
  eyeL.position.x = -IPD / 2; eyeR.position.x = IPD / 2;
  head.add(eyeL); head.add(eyeR);

  var orient = null, active = false;
  var aim = new THREE.PerspectiveCamera();  // cameras look down -Z, unlike Object3D.lookAt
  var sensorQuat = new THREE.Quaternion(), yawFix = new THREE.Quaternion();
  var euler = new THREE.Euler(), zee = new THREE.Vector3(0, 0, 1);
  var q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // camera looks out the back of the device
  var deg = Math.PI / 180;

  function onOrientation(e) { if (e.alpha !== null) orient = e; }

  function screenAngle() {
    return ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * deg;
  }

  function readSensor() {
    if (!orient) return false;
    euler.set(orient.beta * deg, orient.alpha * deg, -orient.gamma * deg, 'YXZ');
    sensorQuat.setFromEuler(euler);
    sensorQuat.multiply(q1);
    sensorQuat.multiply(q0.setFromAxisAngle(zee, -screenAngle()));
    return true;
  }

  // Turns the view so that wherever the user is looking now becomes "facing the table".
  function recenter() {
    if (!readSensor()) return;
    var e = new THREE.Euler().setFromQuaternion(sensorQuat, 'YXZ');
    yawFix.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -e.y);
  }

  var vrMode = {
    update: function () {
      // In VR the diorama is shown at 1 m wide, like a big model on a table in front of you.
      var size = VR_SIZE;
      D.root.scale.setScalar(size);
      head.position.set(0, 0.25 + size * 0.25, 0.2 + size * 0.6);
      if (readSensor()) {
        head.quaternion.copy(yawFix).multiply(sensorQuat);
      } else {
        aim.position.copy(head.position); aim.lookAt(0, 0.12, -0.15);   // no gyroscope: fixed view of the table
        head.quaternion.copy(aim.quaternion);
      }
      head.updateMatrixWorld(true);
    },
    render: function () {
      var r = D.renderer, w = window.innerWidth, h = window.innerHeight, half = Math.floor(w / 2);
      eyeL.aspect = eyeR.aspect = half / h;
      eyeL.updateProjectionMatrix(); eyeR.updateProjectionMatrix();
      r.setScissorTest(true);
      r.setViewport(0, 0, half, h); r.setScissor(0, 0, half, h); r.render(D.scene, eyeL);
      r.setViewport(half, 0, w - half, h); r.setScissor(half, 0, w - half, h); r.render(D.scene, eyeR);
      r.setScissorTest(false);
      r.setViewport(0, 0, w, h);
    }
  };

  function start() {
    active = true;
    D.scene.add(head);
    window.addEventListener('deviceorientation', onOrientation);
    var ask = window.DeviceOrientationEvent && DeviceOrientationEvent.requestPermission ? DeviceOrientationEvent.requestPermission() : Promise.resolve();
    ask.catch(function () {}).then(function () {
      var el = document.documentElement;
      return (el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : Promise.resolve()).catch(function () {});
    }).then(function () {
      if (screen.orientation && screen.orientation.lock) return screen.orientation.lock('landscape').catch(function () {});
    }).then(function () {
      setTimeout(recenter, 300);
    });
    D.setEnvironment('vr');
    D.setMode(vrMode);
    document.body.classList.add('vr-mode');
    if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(function () {});
  }

  function stop() {
    active = false;
    window.removeEventListener('deviceorientation', onOrientation);
    D.scene.remove(head);
    document.body.classList.remove('vr-mode');
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {});
    if (screen.orientation && screen.orientation.unlock) try { screen.orientation.unlock(); } catch (e) {}
    D.setEnvironment('preview');
    D.setMode(null);
    D.applyTransform();
  }

  // A tap on the screen (or the headset's button) recenters the view.
  $('view').addEventListener('pointerdown', function () { if (active) recenter(); });

  D.vr = { start: start, stop: stop, active: function () { return active; }, recenter: recenter };
})();
