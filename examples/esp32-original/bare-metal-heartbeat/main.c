/* Standalone original ESP32 PRO CPU runtime. APP CPU remains in ROM reset.
 * Register definitions follow ESP-IDF components/soc/esp32; no SDK runtime.
 * Preserve ROM clock and UART configuration, disable boot watchdogs.
 */
#define REG(address) (*(volatile unsigned *)(address))
extern unsigned _bss_start, _bss_end;
static unsigned ticks;
static void put_char(char value) {
  while (((REG(0x3ff4001c) >> 16) & 255) >= 120) {}
  REG(0x3ff40000) = (unsigned char)value;
}
static void put_text(const char *text) { while (*text) put_char(*text++); }
static void put_hex(unsigned value) {
  const char *digits="0123456789abcdef";
  for(int shift=28;shift>=0;shift-=4)put_char(digits[(value>>shift)&15]);
}
static void delay(void) {
  for (volatile unsigned index=0;index<1500000;index++) {}
}
void app_main(void) {
  for(volatile unsigned *p=&_bss_start;p<&_bss_end;p++)*p=0;
  REG(0x3ff480a4)=0x50d83aa1;REG(0x3ff4808c)=0;REG(0x3ff480a4)=0;
  REG(0x3ff5f064)=0x50d83aa1;REG(0x3ff5f048)=0;REG(0x3ff5f064)=0;
  REG(0x3ff60064)=0x50d83aa1;REG(0x3ff60048)=0;REG(0x3ff60064)=0;
  put_text("WICRO_ESP32_READY\r\n");
  for(;;){put_text("WICRO_ESP32_TICK ");put_hex(++ticks);put_text("\r\n");delay();}
}
