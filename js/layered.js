// Splits the GBA picture into depth slices instead of one flat image.
//
// The GBA draws 4 backgrounds and the sprites, each with a priority from 0 (front) to 3 (back).
// Every (priority, background-or-sprite) pair gets its own slot, so there are 8 fixed slots:
//   slot 0 = BGs with priority 3, slot 1 = sprites with priority 3, ..., slot 7 = sprites with priority 0.
// In Pokémon FireRed's overworld that gives: ground (BG3), lower scenery (BG2), characters,
// tree tops and roofs (BG1), and text boxes (BG0), each on its own plane.
(function () {
  var R = GameBoyAdvanceSoftwareRenderer.prototype;
  var W = 240, H = 160, SLOTS = 8;

  function makeBacking() {
    return { color: new Uint16Array(W), stencil: new Uint8Array(W) };
  }

  R.SLOTS = SLOTS;

  R.initSlices = function () {
    this.slotBacking = [];
    this.slotPixels = [];
    for (var s = 0; s < SLOTS; ++s) {
      this.slotBacking.push(makeBacking());
      this.slotPixels.push(new Uint8Array(W * H * 4));
    }
    this.objwinBacking = makeBacking();
    this.slotUsed = new Uint8Array(SLOTS);
    this.slotUsedFrame = new Uint8Array(SLOTS);
    this.backdropColor = 0;
    this.frameCount = 0;
  };

  R.slotOf = function (layer) {
    return (3 - layer.priority) * 2 + (layer.bg ? 0 : 1);
  };

  // Same window handling as the original drawScanline, for one layer into one backing.
  R.drawLayerWindowed = function (layer, backing, y) {
    var firstStart, firstEnd, lastStart, lastEnd;
    this.objwinActive = false;
    if (!(this.win0 || this.win1 || this.objwin)) {
      this.setBlendEnabled(layer.index, this.target1[layer.index], this.blendMode);
      layer.drawScanline(backing, layer, 0, W);
      return;
    }
    firstStart = 0; firstEnd = W; lastStart = 0; lastEnd = W;
    if (this.win0 && y >= this.win0Top && y < this.win0Bottom) {
      if (this.windows[0].enabled[layer.index]) {
        this.setBlendEnabled(layer.index, this.windows[0].special && this.target1[layer.index], this.blendMode);
        layer.drawScanline(backing, layer, this.win0Left, this.win0Right);
      }
      firstStart = Math.max(firstStart, this.win0Left);
      firstEnd = Math.min(firstEnd, this.win0Left);
      lastStart = Math.max(lastStart, this.win0Right);
      lastEnd = Math.min(lastEnd, this.win0Right);
    }
    if (this.win1 && y >= this.win1Top && y < this.win1Bottom) {
      if (this.windows[1].enabled[layer.index]) {
        this.setBlendEnabled(layer.index, this.windows[1].special && this.target1[layer.index], this.blendMode);
        if (!this.windows[0].enabled[layer.index] && (this.win1Left < firstStart || this.win1Right < lastStart)) {
          layer.drawScanline(backing, layer, this.win1Left, firstStart);
          layer.drawScanline(backing, layer, lastEnd, this.win1Right);
        } else {
          layer.drawScanline(backing, layer, this.win1Left, this.win1Right);
        }
      }
      firstStart = Math.max(firstStart, this.win1Left);
      firstEnd = Math.min(firstEnd, this.win1Left);
      lastStart = Math.max(lastStart, this.win1Right);
      lastEnd = Math.min(lastEnd, this.win1Right);
    }
    if (this.windows[2].enabled[layer.index] || (this.objwin && this.windows[3].enabled[layer.index])) {
      this.objwinActive = this.objwin;
      this.setBlendEnabled(layer.index, this.windows[2].special && this.target1[layer.index], this.blendMode);
      if (firstEnd > lastStart) {
        layer.drawScanline(backing, layer, 0, W);
      } else {
        if (firstEnd) layer.drawScanline(backing, layer, 0, firstEnd);
        if (lastStart < W) layer.drawScanline(backing, layer, lastStart, W);
        if (lastEnd < firstStart) layer.drawScanline(backing, layer, lastEnd, firstStart);
      }
    }
    this.setBlendEnabled(this.LAYER_BACKDROP, this.target1[this.LAYER_BACKDROP] && this.windows[2].special, this.blendMode);
  };

  R.drawScanline = function (y) {
    if (!this.slotBacking) this.initSlices();
    this.vcount = y;
    // Frames the app will not show (it runs several per screen refresh when the phone is slow) are not drawn;
    // only the affine backgrounds' per-line movement is kept.
    if (this.skip) {
      for (var j = 0; j < this.drawLayers.length; ++j) {
        var l = this.drawLayers[j];
        if (l.bg && l.enabled) { l.sx += l.dmx; l.sy += l.dmy; }
      }
      return;
    }
    var s, x, i, layer, backing;
    var rowStart = y * W * 4;

    if (this.forcedBlank) {
      for (s = 0; s < SLOTS; ++s) {
        var px = this.slotPixels[s];
        for (i = rowStart + 3; i < rowStart + W * 4; i += 4) px[i] = 0;
      }
      var out = this.pixelData.data;
      for (i = rowStart; i < rowStart + W * 4; ++i) out[i] = 0xFF;
      return;
    }

    for (s = 0; s < SLOTS; ++s) this.prepareScanline(this.slotBacking[s]);

    // The OBJ window is a mask for the other layers, so compute it once and copy it into every slot.
    if (this.objwin && this.objwinLayer.enabled) {
      this.prepareScanline(this.objwinBacking);
      this.drawLayerWindowed(this.objwinLayer, this.objwinBacking, y);
      var ow = this.objwinBacking.stencil;
      for (s = 0; s < SLOTS; ++s) {
        var st = this.slotBacking[s].stencil;
        for (x = 0; x < W; ++x) st[x] |= ow[x] & this.OBJWIN_MASK;
      }
    }

    for (i = 0; i < this.drawLayers.length; ++i) {
      layer = this.drawLayers[i];
      if (!layer.enabled || layer === this.objwinLayer || layer === this.drawBackdrop) continue;
      backing = this.slotBacking[this.slotOf(layer)];
      this.drawLayerWindowed(layer, backing, y);
      if (layer.bg) {
        layer.sx += layer.dmx;
        layer.sy += layer.dmy;
      }
    }

    this.finishSlices(y);
  };

  R.finishSlices = function (y) {
    var rowStart = y * W * 4;
    var WRITTEN = this.WRITTEN_MASK;
    var bd = this.palette.accessColor(this.LAYER_BACKDROP, 0);
    if (y === 80) this.backdropColor = bd;
    var out = this.pixelData.data;
    var s, x, o, c, stencil, color, px;

    for (s = 0; s < SLOTS; ++s) {
      stencil = this.slotBacking[s].stencil;
      color = this.slotBacking[s].color;
      px = this.slotPixels[s];
      var any = 0;
      for (x = 0, o = rowStart; x < W; ++x, o += 4) {
        if (stencil[x] & WRITTEN) {
          c = color[x];
          px[o] = (c & 0x1F) << 3;
          px[o + 1] = (c & 0x3E0) >> 2;
          px[o + 2] = (c & 0x7C00) >> 7;
          px[o + 3] = 255;
          any = 1;
        } else {
          px[o + 3] = 0;
        }
      }
      if (any) this.slotUsed[s] = 1;
    }

    // Flat composite (front-most written slot wins), used for the 2D view.
    for (x = 0, o = rowStart; x < W; ++x, o += 4) {
      c = bd;
      for (s = SLOTS - 1; s >= 0; --s) {
        if (this.slotBacking[s].stencil[x] & WRITTEN) { c = this.slotBacking[s].color[x]; break; }
      }
      out[o] = (c & 0x1F) << 3;
      out[o + 1] = (c & 0x3E0) >> 2;
      out[o + 2] = (c & 0x7C00) >> 7;
      out[o + 3] = 255;
    }
  };

  var originalFinishDraw = R.finishDraw;
  R.finishDraw = function (caller) {
    if (this.slotUsed) {
      this.slotUsedFrame.set(this.slotUsed);
      this.slotUsed.fill(0);
      this.frameCount++;
    }
    originalFinishDraw.call(this, caller);
  };
})();
