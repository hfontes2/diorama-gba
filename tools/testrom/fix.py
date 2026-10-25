import sys
d=bytearray(open(sys.argv[1],'rb').read())
d[0xA0:0xAC]=b'VILATESTE AR'
c=0
for b in d[0xA0:0xBD]: c=(c-b)&0xFF
d[0xBD]=(c-0x19)&0xFF
while len(d)%4: d.append(0)
open(sys.argv[1],'wb').write(d)
