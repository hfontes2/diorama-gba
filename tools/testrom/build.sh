set -e
T="--target=armv4t-none-eabi -marm -mfloat-abi=soft"
clang $T -c crt0.s -o crt0.o
clang $T -O2 -ffreestanding -fno-builtin -nostdlib -Wno-everything -c main.c -o main.o
ld.lld -T gba.ld crt0.o main.o -o vila.elf
llvm-objcopy -O binary vila.elf vila.gba
python3 fix.py vila.gba
