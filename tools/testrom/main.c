// Test town for the AR diorama: same BG/priority split as FireRed's overworld.
typedef unsigned char u8; typedef unsigned short u16; typedef unsigned int u32; typedef short s16;
#include "assets.h"

#define REG16(a) (*(volatile u16*)(a))
#define DISPCNT REG16(0x04000000)
#define VCOUNT  REG16(0x04000006)
#define BGCNT(n) REG16(0x04000008 + 2*(n))
#define BGHOFS(n) REG16(0x04000010 + 4*(n))
#define BGVOFS(n) REG16(0x04000012 + 4*(n))
#define KEYS    REG16(0x04000130)
#define BG_PAL  ((volatile u16*)0x05000000)
#define OBJ_PAL ((volatile u16*)0x05000200)
#define VRAM32  ((volatile u32*)0x06000000)
#define OBJ_VRAM32 ((volatile u32*)0x06010000)
#define SCREEN(n) ((volatile u16*)(0x06000000 + (n)*0x800))
#define OAM ((volatile u16*)0x07000000)

enum { K_A=1, K_B=2, K_RIGHT=16, K_LEFT=32, K_UP=64, K_DOWN=128 };

void *memset(void *d, int c, unsigned n) { u8 *p = d; while (n--) *p++ = (u8)c; return d; }
void *memcpy(void *d, const void *s, unsigned n) { u8 *p = d; const u8 *q = s; while (n--) *p++ = *q++; return d; }

static void vsync(void) { while (VCOUNT >= 160); while (VCOUNT < 160); }

static int blocked(int x, int y) {  // x,y = player feet box in pixels
  int pts[4][2] = {{x+3,y+10},{x+12,y+10},{x+3,y+15},{x+12,y+15}};
  for (int i = 0; i < 4; i++) {
    int mx = pts[i][0] >> 4, my = pts[i][1] >> 4;
    if (mx < 0 || my < 0 || mx >= MAP_W || my >= MAP_W) return 1;
    if (solid[my*MAP_W + mx]) return 1;
  }
  return 0;
}

static void set_obj(int i, int x, int y, int tile, int prio) {
  volatile u16 *o = OAM + i*4;
  if (x < -16 || x >= 240 || y < -16 || y >= 160) { o[0] = 0x0200; return; }  // hidden
  o[0] = (y & 0xFF);
  o[1] = (x & 0x1FF) | (1 << 14);          // 16x16
  o[2] = tile | (prio << 10);
}

int main(void) {
  DISPCNT = 0x0080;  // forced blank while loading
  for (int i = 0; i < 16; i++) { BG_PAL[i] = bg_pal[i]; OBJ_PAL[i] = obj_pal[i]; }
  BG_PAL[0] = bg_pal[15];
  for (int i = 0; i < BG_TILE_WORDS; i++) VRAM32[i] = bg_tiles[i];
  for (int i = 0; i < OBJ_TILE_WORDS; i++) OBJ_VRAM32[i] = obj_tiles[i];
  const u16 *maps[4] = {bg_map0, bg_map1, bg_map2, bg_map3};
  for (int l = 0; l < 4; l++) {
    volatile u16 *s = SCREEN(28 + l);
    for (int i = 0; i < 1024; i++) s[i] = maps[l][i];
    BGCNT(l) = l | ((28 + l) << 8);  // priority == bg number, like FireRed
  }
  for (int i = 0; i < 128; i++) OAM[i*4] = 0x0200;
  DISPCNT = 0x1F40;  // mode 0, BG0-3, OBJ, 1D mapping

  int px = 7*16 + 8, py = 8*16, frame = 0, box = 1, prevA = 0;
  for (;;) {
    vsync();
    u16 k = ~KEYS;
    int dx = 0, dy = 0;
    if (k & K_LEFT) dx = -1; else if (k & K_RIGHT) dx = 1;
    if (k & K_UP) dy = -1; else if (k & K_DOWN) dy = 1;
    if (dx && !blocked(px + dx, py)) px += dx;
    if (dy && !blocked(px, py + dy)) py += dy;
    if ((k & K_A) && !prevA) box = !box;
    prevA = k & K_A;
    if (dx || dy) frame++;

    int cx = px + 8 - 120, cy = py + 8 - 80;
    if (cx < 0) cx = 0; if (cy < 0) cy = 0;
    if (cx > 256 - 240) cx = 256 - 240; if (cy > 256 - 160) cy = 256 - 160;
    for (int l = 1; l < 4; l++) { BGHOFS(l) = cx; BGVOFS(l) = cy; }
    DISPCNT = box ? 0x1F40 : 0x1E40;
    set_obj(0, px - cx, py - cy, ((frame >> 3) & 1) ? 4 : 0, 2);
    set_obj(1, 11*16 - cx, 7*16 - cy, 8, 2);
  }
}
