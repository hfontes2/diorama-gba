ENTRY(_start)
MEMORY { rom (rx) : ORIGIN = 0x08000000, LENGTH = 32M
         iwram (rwx) : ORIGIN = 0x03000000, LENGTH = 32K }
SECTIONS {
  .text : { KEEP(*(.header)) *(.text*) *(.rodata*) . = ALIGN(4); } > rom
  .data : { __data_start = .; *(.data*) . = ALIGN(4); __data_end = .; } > iwram AT > rom
  __data_lma = LOADADDR(.data);
  .bss (NOLOAD) : { __bss_start = .; *(.bss*) *(COMMON) . = ALIGN(4); __bss_end = .; } > iwram
  /DISCARD/ : { *(.ARM.exidx*) *(.ARM.attributes) *(.comment) }
}
