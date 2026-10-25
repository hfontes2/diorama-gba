# Generates assets.h for the test ROM: tiles, palettes, and 4 BG maps that mimic how FireRed splits its overworld.
import random
random.seed(7)
PAL_BG = {  # index: (r,g,b) 0-31
 1:(13,24,9), 2:(10,20,7), 3:(28,25,18), 4:(24,21,14), 5:(7,17,28), 6:(15,23,31),
 7:(13,8,4), 8:(4,12,5), 9:(6,16,6), 10:(10,22,10), 11:(24,7,5), 12:(18,5,4),
 13:(30,28,24), 14:(19,27,31), 15:(4,4,6)}
PAL_OBJ = {1:(27,7,6), 2:(20,4,3), 3:(31,25,19), 4:(3,3,4), 5:(6,12,26), 6:(7,7,9), 7:(31,31,31), 8:(13,8,4), 9:(8,21,15)}
def bgr(c): r,g,b=c; return r|(g<<5)|(b<<10)

def blank(w=16,h=16,v=0): return [[v]*w for _ in range(h)]
def rect(img,x,y,w,h,c):
    for j in range(y,y+h):
        for i in range(x,x+w):
            if 0<=j<len(img) and 0<=i<len(img[0]): img[j][i]=c

def grass():
    m=blank(v=1)
    for _ in range(6):
        x,y=random.randrange(15),random.randrange(14); m[y][x]=2; m[y+1][x]=2; m[y+1][x+1]=2
    return m
def path():
    m=blank(v=3)
    for _ in range(5): rect(m,random.randrange(15),random.randrange(16),2,1,4)
    return m
def water():
    m=blank(v=5); rect(m,2,4,6,1,6); rect(m,9,11,5,1,6); return m
def flower():
    m=grass()
    for x,y,c in [(3,3,11),(10,5,13),(5,10,13),(11,11,11)]: rect(m,x,y,2,2,c)
    return m
def tree():  # 16x32: top half -> BG1 (crown over player), bottom half -> BG2
    m=blank(16,32)
    rect(m,6,22,4,8,7)
    rect(m,2,3,12,19,8); rect(m,1,6,14,13,8); rect(m,3,1,10,2,8)
    rect(m,3,4,10,15,9); rect(m,4,5,5,4,10); rect(m,9,10,3,3,10)
    return m
def house():  # 48x48: rows 0-31 roof (BG1), rows 32-47 walls (BG2)
    m=blank(48,48)
    rect(m,0,2,48,30,11)
    for y in range(5,30,4): rect(m,0,y,48,1,12)
    rect(m,0,30,48,2,15)
    rect(m,2,32,44,16,13); rect(m,2,46,44,2,4)
    rect(m,20,36,8,12,7); rect(m,26,42,1,1,13)
    for x in (6,34):
        rect(m,x,36,9,7,15); rect(m,x+1,37,7,5,14)
    return m

FONT={'V':["10001","10001","10001","10001","01010","01010","00100"],
'I':["11111","00100","00100","00100","00100","00100","11111"],
'L':["10000","10000","10000","10000","10000","10000","11111"],
'A':["01110","10001","10001","11111","10001","10001","10001"],
'D':["11110","10001","10001","10001","10001","10001","11110"],
'E':["11111","10000","10000","11110","10000","10000","11111"],
'T':["11111","00100","00100","00100","00100","00100","00100"],
'S':["01111","10000","10000","01110","00001","00001","11110"],
'R':["11110","10001","10001","11110","10100","10010","10001"],
' ':["00000"]*7}

tiles=[[0]*64]; index={tuple([0]*64):0}
def tile_of(img,x,y):
    t=tuple(img[y+j][x+i] for j in range(8) for i in range(8))
    if t not in index: index[t]=len(tiles); tiles.append(list(t))
    return index[t]
def place(mapl,img,mx,my):  # img placed at 8px tile coords (mx,my)
    for ty in range(len(img)//8):
        for tx in range(len(img[0])//8):
            mapl[(my+ty)%32][(mx+tx)%32]=tile_of(img,tx*8,ty*8)

N=16
ground=[['g']*N for _ in range(N)]
for y in range(0,13): ground[y][7]=ground[y][8]='p'
for x in range(3,13): ground[5][x]=ground[6][x]='p'
for y in range(9,12):
    for x in range(9,13): ground[y][x]='w'
for x,y in [(2,8),(4,11),(13,7),(5,9),(1,12)]: ground[y][x]='f'
trees=[]
for x in range(N):
    if x not in (7,8): trees.append((x,0))
    trees.append((x,14))
for y in range(2,14,2): trees += [(0,y),(15,y)]
trees += [(5,12),(13,12)]
houses=[(2,2),(10,2)]

bg=[[[0]*32 for _ in range(32)] for _ in range(4)]
gen={'g':grass,'p':path,'w':water,'f':flower}
for y in range(N):
    for x in range(N): place(bg[3],gen[ground[y][x]](),x*2,y*2)
solid=[[0]*N for _ in range(N)]
for y in range(N):
    for x in range(N):
        if ground[y][x]=='w': solid[y][x]=1
for x,y in trees:
    t=tree(); place(bg[1],t[:16],x*2,y*2); place(bg[2],t[16:],x*2,y*2+2)
    if y+1<N: solid[y+1][x]=1
for hx,hy in houses:
    h=house(); place(bg[1],h[:32],hx*2,hy*2); place(bg[2],h[32:],hx*2,(hy+2)*2)
    for j in range(3):
        for i in range(3): solid[hy+j][hx+i]=1
# text box on BG0 (screen rows 16-19, fixed)
box=blank(240,32,0)
rect(box,4,2,232,28,15); rect(box,6,4,228,24,13)
txt="VILA DE TESTE AR"; x0=16
for ch in txt:
    g=FONT[ch]
    for j,row in enumerate(g):
        for i,b in enumerate(row):
            if b=='1': rect(box,x0+i,12+j,1,1,15)
    x0+=7
place(bg[0],box,0,16)

def obj16(rows):
    return [[int(c,16) if c!='.' else 0 for c in r] for r in rows]
hero=[
"....111111......",
"...11177111.....",
"..1111111111....",
"..2222222222....",
"...33333333.....",
"...34333343.....",
"...33333333.....",
"....333333......",
"...55555555.....",
"..3555555553....",
"..3555555553....",
"...55555555.....",
"...666..666.....",
"...666..666.....",
"...44...44......",
"................"]
hero=[r[:16] for r in hero]
hero2=hero[:12]+["...666..666.....","...666...666....","...44.....44....","................"]
npc=[
"....888888......","...88888888.....","...83333338.....","...34333343.....","...33333333.....","....333333......",
"...99999999.....","..3999999993....","..3999999993....","..9999999999....","..9999999999....","...99999999.....",
"....66..66......","....66..66......","....44..44......","................"]
objtiles=[]
for spr in (hero,hero2,npc):
    img=obj16(spr)
    for ty in range(2):
        for tx in range(2):
            objtiles.append([img[ty*8+j][tx*8+i] for j in range(8) for i in range(8)])

def pack(t):
    out=[]
    for k in range(0,64,8):
        w=0
        for i in range(8): w|=(t[k+i]&15)<<(4*i)
        out.append(w)
    return out
with open('assets.h','w') as f:
    f.write('// generated by gen.py\n#define MAP_W %d\n'%N)
    f.write('static const u16 bg_pal[16]={%s};\n'%','.join(str(bgr(PAL_BG.get(i,(0,0,0)))) for i in range(16)))
    f.write('static const u16 obj_pal[16]={%s};\n'%','.join(str(bgr(PAL_OBJ.get(i,(0,0,0)))) for i in range(16)))
    words=[w for t in tiles for w in pack(t)]
    f.write('#define BG_TILE_WORDS %d\nstatic const u32 bg_tiles[]={%s};\n'%(len(words),','.join('0x%08x'%w for w in words)))
    words=[w for t in objtiles for w in pack(t)]
    f.write('#define OBJ_TILE_WORDS %d\nstatic const u32 obj_tiles[]={%s};\n'%(len(words),','.join('0x%08x'%w for w in words)))
    for l in range(4):
        f.write('static const u16 bg_map%d[1024]={%s};\n'%(l,','.join(str(v) for row in bg[l] for v in row)))
    f.write('static const u8 solid[%d]={%s};\n'%(N*N,','.join(str(v) for row in solid for v in row)))
print('bg tiles',len(tiles),'obj tiles',len(objtiles))
