// Voxel style: every background pixel becomes a column of blocks rising from the ground, and the sprites
// (player, people, Pokémon) stand upright on the map instead of lying flat.
//
// Columns are drawn as stacks of thin alpha-tested slices of the same layer texture, so a pixel's sides
// show its own colour. Heights, in GBA pixels, per background slot (see layered.js for slot numbers):
(function () {
  'use strict';
  var D = window.diorama, THREE = D.THREE;
  var PX = 1 / 240;                // one GBA pixel in diorama units
  var SLICES_PER_PX = 2;
  var COLUMNS = [                  // slot, bottom, top (pixels above the base)
    { slot: 0, from: 0, to: 3 },   // ground (priority 3)
    { slot: 2, from: 0, to: 10 },   // lower scenery: walls, trunks, fences (priority 2)
    { slot: 4, from: 0, to: 24 },  // roofs and tree tops (priority 1)
    { slot: 6, from: 30, to: 31 }  // text boxes and menus float above everything (priority 0)
  ];
  var GROUND = 3;                  // sprites stand on top of the ground slab
  var SPRITE_SLOTS = [7, 5, 3, 1]; // by OBJ priority 0..3
  var MAX_SPRITES = 48;

  var enabled = false;
  var root = new THREE.Group();
  root.visible = false;
  D.stack.add(root);

  // ---------- Background columns ----------
  var columns = COLUMNS.map(function (c) {
    var g = new THREE.Group();
    var n = Math.max(1, Math.round((c.to - c.from) * SLICES_PER_PX));
    var tex = D.slots[c.slot].tex;
    var top = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide });
    var side = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, color: 0xa8a8b4 });
    for (var i = 0; i < n; i++) {
      var m = new THREE.Mesh(D.slots[c.slot].mesh.geometry, i === n - 1 ? top : side);
      m.position.z = (c.from + (i + 1) / SLICES_PER_PX) * PX;
      m.receiveShadow = i === n - 1;
      m.castShadow = i === n - 1 || i === 0;
      g.add(m);
    }
    root.add(g);
    return { slot: c.slot, group: g };
  });

  // ---------- Upright sprites ----------
  var sprites = [];
  for (var i = 0; i < MAX_SPRITES; i++) {
    var geo = new THREE.PlaneGeometry(1, 1);
    var front = new THREE.MeshLambertMaterial({ map: D.slots[3].tex, alphaTest: 0.5, side: THREE.DoubleSide });
    var back = new THREE.MeshLambertMaterial({ map: D.slots[3].tex, alphaTest: 0.5, side: THREE.DoubleSide, color: 0x9a9aa8 });
    var g = new THREE.Group();
    // Three slices give the sprite a little thickness, like a voxel figure.
    for (var k = 0; k < 3; k++) {
      var m = new THREE.Mesh(geo, k === 0 ? front : back);
      m.position.z = -k * 0.6 * PX;
      m.castShadow = true;
      g.add(m);
    }
    g.rotation.x = Math.PI / 2;   // stand up: plane's +Y becomes height
    g.visible = false;
    root.add(g);
    sprites.push({ group: g, geo: geo, front: front, back: back });
  }

  function setUV(geo, u0, v0, u1, v1) {
    // PlaneGeometry vertex order: top-left, top-right, bottom-left, bottom-right. v = 0 is the top GBA row.
    var uv = geo.attributes.uv;
    uv.setXY(0, u0, v0); uv.setXY(1, u1, v0); uv.setXY(2, u0, v1); uv.setXY(3, u1, v1);
    uv.needsUpdate = true;
  }

  function updateSprites(rp) {
    var objs = rp.oam.objs, used = 0, top = D.aspectH / 2;
    for (var i = 0; i < objs.length && used < MAX_SPRITES; i++) {
      var o = objs[i];
      if (o.disable || (o.mode & rp.OBJWIN_MASK)) continue;
      var w = o.cachedWidth << (o.scalerot && o.doublesize ? 1 : 0);
      var h = o.cachedHeight << (o.scalerot && o.doublesize ? 1 : 0);
      var x = o.x >= 240 ? o.x - 512 : o.x, y = o.y >= 160 ? o.y - 256 : o.y;
      var x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(240, x + w), y1 = Math.min(160, y + h);
      if (x1 <= x0 || y1 <= y0) continue;
      var sp = sprites[used++];
      var tex = D.slots[SPRITE_SLOTS[o.priority & 3]].tex;
      sp.front.map = tex; sp.back.map = tex;
      setUV(sp.geo, x0 / 240, y0 / 160, x1 / 240, y1 / 160);
      var g = sp.group;
      g.scale.set((x1 - x0) * PX, (y1 - y0) * PX, 1);
      // Bottom edge of the sprite rests on the ground at the sprite's feet.
      g.position.set((x0 + x1) / 2 * PX - 0.5, top - y1 * PX + 1.5 * PX, (GROUND * heightScale() + (y1 - y0) / 2) * PX);
      g.visible = true;
    }
    for (var j = used; j < sprites.length; j++) sprites[j].group.visible = false;
  }

  // The "depth between layers" slider also sets how tall the blocks are (14 mm = normal height).
  function heightScale() { return Math.max(0.05, D.settings.gap / 14); }

  function update(rp) {
    var used = rp.slotUsedFrame, hs = heightScale();
    for (var s = 0; s < 8; s++) D.slots[s].mesh.visible = false;
    columns.forEach(function (c) { c.group.visible = !!used[c.slot]; c.group.scale.z = hs; });
    updateSprites(rp);
  }

  function setEnabled(on) {
    enabled = on;
    root.visible = on;
    if (!on) for (var j = 0; j < sprites.length; j++) sprites[j].group.visible = false;
  }

  D.voxel = { update: update, setEnabled: setEnabled, enabled: function () { return enabled; } };
  setEnabled(!!D.settings.voxel);
})();
