// "Mundo 3D": rebuilds the map the game has loaded as a real 3D world, for Pokémon FireRed / LeafGreen (US 1.0).
//
// Instead of using the picture on screen, it reads the game's memory: the map grid (which metatile is in each
// 16x16 cell, and whether it can be walked on), the tileset graphics in VRAM and the colours in palette RAM.
// Cells that block the way (trees, houses, fences, signs) become blocks: the lower rows of each block stand up
// as a wall facing the viewer and the rows above lie on top as its roof, which undoes the game's top-down
// "oblique" drawing. Walkable cells stay on the ground. Characters are the sprites on screen, stood upright.
// Battles and other screens that are not the map fall back to the voxel style.
(function () {
  'use strict';
  var D = window.diorama, THREE = D.THREE;
  var PX = 1 / 240;                    // one GBA pixel in diorama units (the picture is 1 unit wide)
  var T = 16;                          // map cells are 16x16 pixels

  // FireRed (US 1.0) addresses, from the pret/pokefirered symbol map.
  var A = {
    mapHeader: 0x02036dfc,             // gMapHeader: +0 mapLayout
    vmap: 0x03005040,                  // VMap: s32 width, s32 height, u16 *map (the loaded map plus 7 cells of border)
    camX: 0x0300506c, camY: 0x03005068,// gTotalCameraPixelOffsetX/Y: change by one per pixel the camera scrolls
    objectEvents: 0x02036e38,          // gObjectEvents, 0x24 bytes each: +0x10 current x,y, +0x14 previous x,y
    playerAvatar: 0x02037078,          // gPlayerAvatar: +5 objectEventId
    callback2: 0x030030f4,             // gMain.callback2
    cb2Overworld: 0x080565b5           // CB2_Overworld (thumb)
  };
  var NUM_PRIMARY = 640;               // metatiles in a primary tileset
  var GAME_CODES = ['BPRE', 'BPGE'];   // FireRed, LeafGreen

  var WIN_X = 11, WIN_Y = 8;           // half size of the visible piece of world, in cells
  var WALL = 2;                        // how many rows of a tall block stand up as its front wall
  var WATER_DEPTH = 4;                 // water sits this many pixels below the ground

  var enabled = false, supported = null;
  var group = new THREE.Group();       // fixed under the stack: the slab and the clipped world
  var mapGroup = new THREE.Group();    // moves so that the camera's view stays centred
  group.add(mapGroup); group.visible = false;
  D.stack.add(group);

  // ---------- Atlas of metatile pictures, 32 x 32 metatiles of 16 x 16 pixels ----------
  var ATLAS = 512;
  var atlasData = new Uint8Array(ATLAS * ATLAS * 4);
  var atlas = new THREE.DataTexture(atlasData, ATLAS, ATLAS, THREE.RGBAFormat);
  atlas.magFilter = THREE.NearestFilter; atlas.minFilter = THREE.NearestFilter; atlas.generateMipmaps = false;

  var clip = [new THREE.Plane(), new THREE.Plane(), new THREE.Plane(), new THREE.Plane()];
  var mat = new THREE.MeshLambertMaterial({ map: atlas, vertexColors: true, side: THREE.DoubleSide, clippingPlanes: clip });
  var mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mapGroup.add(mesh);

  // The slab the world piece stands on.
  var slab = new THREE.Mesh(new THREE.BoxGeometry((2 * WIN_X + 0.3) * T * PX, (2 * WIN_Y + 0.3) * T * PX, 10 * PX),
    new THREE.MeshLambertMaterial({ color: 0x24202f }));
  slab.position.z = -5.6 * PX; slab.receiveShadow = true; slab.castShadow = true;
  group.add(slab);

  // ---------- Memory access ----------
  var gba, mmu, ewram, vram, pal;
  function bind() {
    gba = D.gba; mmu = gba.mmu;
    ewram = new Uint16Array(mmu.memory[2].buffer);
    vram = gba.video.renderPath.vram.buffer;
    pal = gba.video.renderPath.palette.colors[0];
    var code = ''; for (var i = 0; i < 4; i++) code += String.fromCharCode(mmu.loadU8(0x080000ac + i));
    supported = GAME_CODES.indexOf(code) >= 0;
  }
  function u32(a) { return mmu.load32(a) >>> 0; }
  function u16(a) { return mmu.loadU16(a); }
  function s16(a) { return mmu.load16(a); }

  // ---------- Reading the map ----------
  var map = null;          // { W, H, cells: Uint16Array, prim, sec, sig }, cells include EXTRA cells around the VMap
  var EXTRA = 6;           // the visible window reaches past the VMap's own 7-cell border, so add more border
  function readMap() {
    var VW = mmu.load32(A.vmap), VH = mmu.load32(A.vmap + 4), ptr = u32(A.vmap + 8);
    if (VW <= 0 || VH <= 0 || VW * VH > 0x2800 || (ptr >>> 24) !== 2) return null;
    var layout = u32(A.mapHeader);
    var prim = u32(layout + 16), sec = u32(layout + 20);
    var border = u32(layout + 8), bw = mmu.loadU8(layout + 24) || 2, bh = mmu.loadU8(layout + 25) || 2;
    var W = VW + 2 * EXTRA, H = VH + 2 * EXTRA;
    var cells = new Uint16Array(W * H), base = (ptr & 0x3ffff) >> 1, sig = VW * 31 + VH;
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var vx = x - EXTRA, vy = y - EXTRA, v = 0x3ff;
      if (vx >= 0 && vy >= 0 && vx < VW && vy < VH) { v = ewram[base + vy * VW + vx]; sig = (sig * 33 + v) | 0; }
      // Cells outside the map show the map's border pattern, like GetBorderBlockAt in the game.
      if ((v & 0x3ff) === 0x3ff) {
        var bx = ((vx - 7) % bw + bw * 64) % bw, by = ((vy - 7) % bh + bh * 64) % bh;
        v = u16(border + (by * bw + bx) * 2) | 0x0c00;
      }
      cells[y * W + x] = v;
    }
    // Indoors, everything outside the room is black void: leave it out so the room stands on the slab.
    var indoor = mmu.loadU8(A.mapHeader + 0x17) === 8, mw = mmu.load32(layout), mh = mmu.load32(layout + 4);
    var hidden = new Uint8Array(W * H);
    if (indoor) for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      vx = x - EXTRA - 7; vy = y - EXTRA - 7;
      hidden[y * W + x] = vx < 0 || vy < 0 || vx >= mw || vy >= mh ? 1 : 0;
    }
    return { W: W, H: H, cells: cells, hidden: hidden, sig: sig + ':' + prim + ':' + sec,
      prim: { metatiles: u32(prim + 12), attrs: u32(prim + 20) }, sec: { metatiles: u32(sec + 12), attrs: u32(sec + 20) } };
  }
  function tilesetOf(id) { return id < NUM_PRIMARY ? [map.prim, id] : [map.sec, id - NUM_PRIMARY]; }
  function attrsOf(id) { var t = tilesetOf(id); return t[0].attrs ? u32(t[0].attrs + t[1] * 4) : 0; }
  // True when the metatile's upper layer has pixels and is drawn above the characters (roof edges, tree tops).
  function coversSprites(id) {
    if ((attrsOf(id) >>> 29 & 3) !== 0) return false;
    var t = tilesetOf(id), mt = t[0].metatiles + t[1] * 16;
    for (var q = 4; q < 8; q++) {
      var tile = u16(mt + q * 2) & 0x3ff;
      for (var k = 0; k < 16; k++) if (vram[tile * 16 + k]) return true;
    }
    return false;
  }

  function isWater(b) { return b >= 0x10 && b <= 0x1b && b !== 0x17 && b !== 0x14; }
  function isDoor(b) { return b === 0x69 || b === 0x60 || b === 0x6c || b === 0x6d || b === 0x6e || b === 0x6f; }

  // ---------- Drawing metatiles into the atlas ----------
  var usedIds = [];
  function drawMetatile(id) {
    var t = tilesetOf(id), mt = t[0].metatiles + t[1] * 16;
    var ax = (id & 31) * 16, ay = (id >> 5) * 16, back = pal[0];
    for (var layer = 0; layer < 2; layer++) for (var q = 0; q < 4; q++) {
      var e = u16(mt + (layer * 4 + q) * 2), tile = e & 0x3ff, hf = e >> 10 & 1, vf = e >> 11 & 1, pb = (e >> 12) << 4;
      var tbase = tile * 16;   // 32 bytes per 4bpp tile = 16 halfwords
      for (var y = 0; y < 8; y++) {
        var sy = vf ? 7 - y : y;
        var row = (ay + (q >> 1) * 8 + y) * ATLAS;
        for (var x = 0; x < 8; x++) {
          var sx = hf ? 7 - x : x;
          var hw = vram[tbase + sy * 2 + (sx >> 2)], ci = (hw >> ((sx & 3) * 4)) & 15;
          if (!ci && layer) continue;
          var c = ci ? pal[pb + ci] : back, o = (row + ax + (q & 1) * 8 + x) * 4;
          atlasData[o] = (c & 31) << 3; atlasData[o + 1] = (c >> 5 & 31) << 3; atlasData[o + 2] = (c >> 10 & 31) << 3; atlasData[o + 3] = 255;
        }
      }
    }
  }
  function refreshAtlas() {
    for (var i = 0; i < usedIds.length; i++) drawMetatile(usedIds[i]);
    atlas.needsUpdate = true;
  }

  // ---------- Building the 3D world ----------
  // Shades multiply the texture: tops are full brightness, walls a little darker, sides and backs darker still.
  var SHADE_TOP = 1, SHADE_WALL = 0.93, SHADE_SIDE = 0.72, SHADE_BACK = 0.6;

  function build() {
    var W = map.W, H = map.H, cells = map.cells;
    var id = new Int16Array(W * H), solid = new Uint8Array(W * H), water = new Uint8Array(W * H), seen = {}, covers = {};
    usedIds = [];
    for (var i = 0; i < W * H; i++) {
      var v = cells[i], m = v & 0x3ff, b = attrsOf(m) & 0x1ff;
      id[i] = m;
      if (!seen[m]) { seen[m] = 1; usedIds.push(m); covers[m] = coversSprites(m); }
      water[i] = isWater(b) ? 1 : 0;
      solid[i] = !water[i] && !map.hidden[i] && (((v >> 10) & 3) !== 0 || isDoor(b)) ? 1 : 0;
    }
    // Walkable cells drawn over the characters just above a solid cell (the top row of a roof, tree tops)
    // belong to the same tall object.
    for (var x = 0; x < W; x++) for (var y = H - 2; y >= 0; y--) {
      i = y * W + x;
      if (!solid[i] && !water[i] && !map.hidden[i] && solid[i + W] && covers[id[i]]) solid[i] = 2;
    }
    // Every ground cell gets a height (pixels) and the metatile shown on its top face.
    var hgt = new Int16Array(W * H), top = new Int16Array(W * H), wallOf = new Int32Array(W * H).fill(-1);
    for (i = 0; i < W * H; i++) { top[i] = id[i]; hgt[i] = water[i] ? -WATER_DEPTH : 0; }
    for (x = 0; x < W; x++) {
      y = 0;
      while (y < H) {
        if (!solid[y * W + x]) { y++; continue; }
        var y0 = y; while (y < H && solid[y * W + x]) y++;
        var y1 = y - 1, L = y1 - y0 + 1, w = L >= 3 ? WALL : 1;
        var roofRows = L - w;                         // rows y0 .. y0+roofRows-1 lie on top, shifted south by w
        var fill = y0 > 0 ? id[(y0 - 1) * W + x] : id[y0 * W + x];
        for (var r = y0; r <= y1; r++) { top[r * W + x] = fill; hgt[r * W + x] = 0; }
        if (roofRows > 0) {
          for (r = 0; r < roofRows; r++) { var g = (y0 + r + w) * W + x; top[g] = id[(y0 + r) * W + x]; hgt[g] = w * T; }
        } else {
          top[y1 * W + x] = id[y0 * W + x]; hgt[y1 * W + x] = w * T;   // a short block gets a lid of its top row
        }
        wallOf[y1 * W + x] = y0;                       // the wall stands at the south edge of row y1
        if (y1 + 1 >= H) wallOf[y1 * W + x] = -1;
      }
    }

    var pos = [], nor = [], uv = [], col = [], idx = [];
    var e = 0.02 / ATLAS;
    function quad(p, n, mId, shade, vFrom, vTo) {
      // p: four corners [x,y,z] in pixels: top-left, top-right, bottom-right, bottom-left as seen from outside.
      var u0 = (mId & 31) * 16 / ATLAS + e, u1 = ((mId & 31) * 16 + 16) / ATLAS - e;
      var vb = (mId >> 5) * 16 / ATLAS;
      var v0 = vb + (vFrom === undefined ? 0 : vFrom) * 16 / ATLAS + e, v1 = vb + (vTo === undefined ? 1 : vTo) * 16 / ATLAS - e;
      var base = pos.length / 3;
      var uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
      for (var k = 0; k < 4; k++) {
        pos.push(p[k][0] * PX, -p[k][1] * PX, p[k][2] * PX);
        nor.push(n[0], n[1], n[2]); uv.push(uvs[k][0], uvs[k][1]); col.push(shade, shade, shade);
      }
      idx.push(base, base + 3, base + 1, base + 1, base + 3, base + 2);
    }
    // A vertical face from height hTop down to hBot; the texture repeats every 16 pixels.
    function vface(ax, ay, bx, by, hTop, hBot, n, mId, shade) {
      for (var h = hTop; h > hBot;) {
        var step = Math.min(T, h - hBot), frac = step / T;
        quad([[ax, ay, h], [bx, by, h], [bx, by, h - step], [ax, ay, h - step]], n, mId, shade, 0, frac);
        h -= step;
      }
    }

    var hidden = map.hidden;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      i = y * W + x;
      if (hidden[i]) continue;
      var x0 = x * T, x1 = x0 + T, yn = y * T, ys = yn + T, h0 = hgt[i];
      quad([[x0, yn, h0], [x1, yn, h0], [x1, ys, h0], [x0, ys, h0]], [0, 0, 1], top[i], SHADE_TOP);
      // South side: the block's front wall shows the original rows, other drops are shaded.
      var hs = y + 1 < H ? hgt[i + W] : 0;
      if (h0 > hs) {
        if (wallOf[i] >= 0) {
          var yr = y;   // texture row of the cell that ends the run, then upwards
          for (var k = 0; k * T < h0; k++) {
            var rowId = id[Math.max(0, yr - k) * W + x];
            quad([[x0, ys, (k + 1) * T], [x1, ys, (k + 1) * T], [x1, ys, k * T], [x0, ys, k * T]], [0, -1, 0], rowId, SHADE_WALL);
          }
        } else vface(x0, ys, x1, ys, h0, hs, [0, -1, 0], top[i], SHADE_WALL);
      }
      var hn = y > 0 ? hgt[i - W] : 0;
      if (h0 > hn) vface(x1, yn, x0, yn, h0, hn, [0, 1, 0], top[i], SHADE_BACK);
      var he = x + 1 < W ? hgt[i + 1] : 0;
      if (h0 > he) vface(x1, ys, x1, yn, h0, he, [1, 0, 0], top[i], SHADE_SIDE);
      var hw = x > 0 ? hgt[i - 1] : 0;
      if (h0 > hw) vface(x0, yn, x0, ys, h0, hw, [-1, 0, 0], top[i], SHADE_SIDE);
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    mesh.geometry.dispose();
    mesh.geometry = geo;
    refreshAtlas();
  }

  // ---------- Camera: which map pixel is at the top-left of the GBA screen ----------
  // The camera totals move with every scrolled pixel; when the player stands still, the screen's top-left is
  // a fixed distance from the player's cell, which pins down the constant between the two.
  var K = null, lastCur = null;
  function playerCoords() {
    var oe = A.objectEvents + mmu.loadU8(A.playerAvatar + 5) * 0x24;
    return { x: s16(oe + 0x10), y: s16(oe + 0x12), px: s16(oe + 0x14), py: s16(oe + 0x16) };
  }
  function screenOrigin(mapChanged) {
    var cx = s16(A.camX), cy = s16(A.camY), p = playerCoords();
    if (p.x === p.px && p.y === p.py) K = { x: p.x * T - 112 + cx, y: p.y * T - 72 + cy };
    else if (K && mapChanged && lastCur) { K.x += (p.x - lastCur.x) * T; K.y += (p.y - lastCur.y) * T; }
    lastCur = p;
    if (!K) K = { x: p.x * T - 112 + cx, y: p.y * T - 72 + cy };
    return { x: K.x - cx, y: K.y - cy };
  }

  // ---------- Per frame ----------
  var frame = 0, palSig = 0;
  var LOCAL = [[1, 0, 0, WIN_X], [-1, 0, 0, WIN_X], [0, 1, 0, WIN_Y], [0, -1, 0, WIN_Y]];

  function inOverworld() { return u32(A.callback2) === A.cb2Overworld; }

  // Returns false when the game is not showing a map, so the caller can fall back to another style.
  function update(rp) {
    if (!enabled) return false;
    if (!gba || gba !== D.gba) bind();
    if (!supported || !inOverworld()) { group.visible = false; return false; }
    frame++;
    var changed = false;
    if (!map || frame % 2 === 0) {
      var m = readMap();
      if (!m) { group.visible = false; return false; }
      if (!map || m.sig !== map.sig) { map = m; build(); changed = true; }
    }
    // Redraw the metatiles when the palette changes (fades) and now and then for animated water and flowers.
    var ps = 0; for (var c = 0; c < 208; c++) ps = (ps * 31 + pal[c]) | 0;
    if (!changed && (ps !== palSig || frame % 6 === 0)) refreshAtlas();
    palSig = ps;
    var o = screenOrigin(changed);
    mapGroup.position.set(-(o.x + 120 + EXTRA * T) * PX, (o.y + 80 + EXTRA * T) * PX, 0);

    // Clip the world to a rectangle around the view.
    D.stack.updateMatrixWorld(true);
    for (var k = 0; k < 4; k++) {
      var c = LOCAL[k];
      clip[k].normal.set(c[0], c[1], 0); clip[k].constant = c[3] * T * PX;
      clip[k].applyMatrix4(D.stack.matrixWorld);
    }
    group.visible = true;
    for (var s = 0; s < 8; s++) D.slots[s].mesh.visible = false;
    // Text boxes and menus float above the world.
    if (rp.slotUsedFrame[6]) { var ui = D.slots[6].mesh; ui.visible = true; ui.position.z = 3.2 * T * PX; }
    D.voxel.updateSprites(rp, 0);
    return true;
  }

  function setEnabled(on) {
    enabled = on;
    D.renderer.localClippingEnabled = true;
    if (!on) group.visible = false;
  }

  setEnabled(D.settings.style === 'world');
  D.world = { update: update, setEnabled: setEnabled, supported: function () { return supported; }, _map: function () { return map; } };
})();
