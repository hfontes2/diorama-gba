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
  var MENU_HEIGHT = 0.25;          // block height on screens that are not a map (FireRed/LeafGreen only)

  var enabled = false;
  var root = new THREE.Group();
  root.visible = false;
  D.stack.add(root);
  var spriteRoot = new THREE.Group();   // shared with the 3D world style (world.js)
  D.stack.add(spriteRoot);

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
    spriteRoot.add(g);
    sprites.push({ group: g, geo: geo, front: front, back: back });
  }

  function setUV(geo, u0, v0, u1, v1) {
    // PlaneGeometry vertex order: top-left, top-right, bottom-left, bottom-right. v = 0 is the top GBA row.
    var uv = geo.attributes.uv;
    uv.setXY(0, u0, v0); uv.setXY(1, u1, v0); uv.setXY(2, u0, v1); uv.setXY(3, u1, v1);
    uv.needsUpdate = true;
  }

  // Sprites drawn over the view with the dialogs (see app.js): in battles, the health boxes and other
  // small sprites, which would be unreadable standing up.
  var hudData = new Uint8Array(240 * 160 * 4);
  var hudTex = new THREE.DataTexture(hudData, 240, 160, THREE.RGBAFormat);
  hudTex.magFilter = THREE.NearestFilter; hudTex.minFilter = THREE.NearestFilter; hudTex.generateMipmaps = false;
  var hud = { tex: hudTex, used: false };

  function copyToHud(rp, slot, x0, y0, x1, y1) {
    var src = rp.slotPixels[slot];
    for (var y = y0; y < y1; y++) {
      var o = (y * 240 + x0) * 4, e = (y * 240 + x1) * 4;
      for (var k = o; k < e; k += 4) if (src[k + 3]) { hudData[k] = src[k]; hudData[k + 1] = src[k + 1]; hudData[k + 2] = src[k + 2]; hudData[k + 3] = 255; }
    }
  }

  // groundPx: height of the ground the sprites stand on, in GBA pixels.
  // standUp(obj): optional; sprites it rejects are drawn over the view instead (battles).
  // place(x0, y1, x1): optional; returns { lift, shift } in pixels to raise a sprite and move it south.
  function updateSprites(rp, groundPx, standUp, place) {
    var objs = rp.oam.objs, used = 0, top = D.aspectH / 2;
    if (hud.used) { hudData.fill(0); hud.used = false; hudTex.needsUpdate = true; }
    for (var i = 0; i < objs.length && used < MAX_SPRITES; i++) {
      var o = objs[i];
      if (o.disable || (o.mode & rp.OBJWIN_MASK)) continue;
      var w = o.cachedWidth << (o.scalerot && o.doublesize ? 1 : 0);
      var h = o.cachedHeight << (o.scalerot && o.doublesize ? 1 : 0);
      var x = o.x >= 240 ? o.x - 512 : o.x, y = o.y >= 160 ? o.y - 256 : o.y;
      var x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(240, x + w), y1 = Math.min(160, y + h);
      if (x1 <= x0 || y1 <= y0) continue;
      if (standUp && !standUp(o)) {
        copyToHud(rp, SPRITE_SLOTS[o.priority & 3], x0, y0, x1, y1);
        hud.used = true; hudTex.needsUpdate = true;
        continue;
      }
      var sp = sprites[used++];
      var tex = D.slots[SPRITE_SLOTS[o.priority & 3]].tex;
      sp.front.map = tex; sp.back.map = tex;
      setUV(sp.geo, x0 / 240, y0 / 160, x1 / 240, y1 / 160);
      var g = sp.group;
      g.scale.set((x1 - x0) * PX, (y1 - y0) * PX, 1);
      // Bottom edge of the sprite rests on the ground at the sprite's feet.
      var pl = place && place(x0, y1, x1), up = pl ? pl.lift : 0, south = pl ? pl.shift : 0;
      g.position.set((x0 + x1) / 2 * PX - 0.5, top - (y1 + south) * PX + 1.5 * PX, (groundPx + up + (y1 - y0) / 2) * PX);
      g.visible = true;
    }
    for (var j = used; j < sprites.length; j++) sprites[j].group.visible = false;
  }
  function hideSprites() {
    for (var j = 0; j < sprites.length; j++) sprites[j].group.visible = false;
    if (hud.used) { hudData.fill(0); hud.used = false; hudTex.needsUpdate = true; }
  }

  // The "depth between layers" slider also sets how tall the blocks are (14 mm = normal height).
  function heightScale() { return Math.max(0.05, D.settings.gap / 14); }

  function update(rp) {
    var used = rp.slotUsedFrame, hs = heightScale(), menu = D.world && D.world.menuScreen();
    // Menus get low blocks, so tall panels don't hide the text and cursors next to them.
    if (menu) hs *= MENU_HEIGHT;
    for (var s = 0; s < 8; s++) D.slots[s].mesh.visible = false;
    columns.forEach(function (c) { c.group.visible = !!used[c.slot]; c.group.scale.z = hs; });
    // In battles the Pokémon and trainers (large sprites behind the health boxes, OBJ priority 2 or 3)
    // stand on their platforms; health boxes, balls and small effects go over the view.
    if (menu && D.world.inBattle() && D.settings.hud && !(D.vr && D.vr.active())) {
      hideSlotPlanes();
      updateSprites(rp, 0.5, function (o) { return o.priority >= 2 && o.cachedWidth >= 32 && o.cachedHeight >= 32; });
      return;
    }
    if (menu) { flatSprites(used, hs); return; }
    updateSprites(rp, GROUND * hs);
  }

  // On screens that are not a map (naming screen, menus, battles) the sprites are cursors, arrows and
  // panels: standing them up would bury them inside the blocks, so they lie flat on top of the
  // background column of the same priority, like on the GBA screen.
  function hideSlotPlanes() { for (var s = 0; s < 8; s++) D.slots[s].mesh.visible = false; }
  function flatSprites(used, hs) {
    hideSprites();
    COLUMNS.forEach(function (c) {
      var sl = D.slots[c.slot + 1];
      sl.mesh.visible = !!used[c.slot + 1];
      sl.mesh.position.z = (c.to + 0.5) * hs * PX;
      sl.edge.visible = sl.glass.visible = false;
    });
  }

  // Hides the blocks and flat sprites of these slots this frame (they are drawn over the view instead).
  function hideSlots(list) {
    columns.forEach(function (c) { if (list.indexOf(c.slot) >= 0) c.group.visible = false; });
  }

  function setEnabled(on) {
    enabled = on;
    root.visible = on;
    if (!on) hideSprites();
  }

  D.voxel = { update: update, hideSlots: hideSlots, hud: hud, setEnabled: setEnabled, updateSprites: updateSprites, hideSprites: hideSprites, enabled: function () { return enabled; } };
  setEnabled(D.settings.style === 'voxel');
})();
