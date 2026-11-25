/* Standalone ESP8266 RAM firmware: UART0 heartbeat, watchdog feed, GPIO2 output.
 * Registers follow Espressif ESP8266 NONOS SDK eagle_soc.h/uart_register.h.
 * This exercises actual peripheral registers; it provides no Arduino or Wi-Fi API.
 */
#define REG(address) (*(volatile unsigned *)(address))
extern unsigned _bss_start, _bss_end;
static volatile unsigned ticks;
static void put_char(char value) {
  while (((REG(0x6000001c) >> 16) & 255) >= 120) REG(0x60000914) = 0x73;
  REG(0x60000000) = (unsigned char)value;
}
static void put_text(const char *text) { while (*text) put_char(*text++); }
static void delay(void) {
  for (volatile unsigned index = 0; index < 1200000; index++) {
    if ((index & 4095) == 0) REG(0x60000914) = 0x73;
  }
}
void app_main(void) {
  for (volatile unsigned *p = &_bss_start; p < &_bss_end; ++p) *p = 0;
  /* ROM early UART clock is 2 * 26 MHz on this explicit board profile. */
  REG(0x60000014) = 52000000 / 115200;
  REG(0x60000818) &= ~(0x13u << 4); /* UART0 TX pin function */
  REG(0x60000838) &= ~(0x13u << 4); /* GPIO2 pin function */
  REG(0x60000310) = 4;
  put_text("WICRO_ESP8266_READY\r\n");
  for (;;) {
    REG(0x60000914) = 0x73;
    ticks++;
    if (ticks & 1) { REG(0x60000308) = 4; put_text("WICRO_ESP8266_TICK GPIO2=LOW\r\n"); }
    else { REG(0x60000304) = 4; put_text("WICRO_ESP8266_TICK GPIO2=HIGH\r\n"); }
    delay();
  }
}
