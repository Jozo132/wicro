typedef unsigned u32;
extern u32 _sidata, _sdata, _edata, _sbss, _ebss, _estack;
extern int main(void);
void Default_Handler(void) { for (;;) {} }
void Reset_Handler(void) {
  __asm__ volatile("cpsid i");
  u32 *from=&_sidata;
  for(u32 *to=&_sdata;to<&_edata;)*to++=*from++;
  for(u32 *to=&_sbss;to<&_ebss;)*to++=0;
  main(); for (;;) {}
}
__attribute__((section(".isr_vector"),used)) const u32 vectors[16]={
  (u32)&_estack,(u32)Reset_Handler,(u32)Default_Handler,(u32)Default_Handler,
  (u32)Default_Handler,(u32)Default_Handler,(u32)Default_Handler,0,0,0,0,
  (u32)Default_Handler,(u32)Default_Handler,0,(u32)Default_Handler,(u32)Default_Handler
};
