/* STM32F103 C8: 8 MHz internal HSI, polling SysTick, PB2 and SRAM diagnostics.
 * No external crystal, UART connection, interrupts or SDK runtime required.
 * Register sequencing follows ST RM0008 and ARM Cortex-M3 SysTick definitions.
 */
typedef unsigned u32;
#define REG(address) (*(volatile u32 *)(address))
__attribute__((section(".mailbox"),used)) volatile u32 mailbox[8];
int main(void) {
  REG(0x40021000) |= 1;
  while(!(REG(0x40021000)&2)){}
  REG(0x40021004) &= ~3u;
  while(REG(0x40021004)&12){}
  REG(0x40021004) &= ~0x3ff0u; /* AHB/APB prescalers /1. */
  REG(0xe000ed08)=0x08000000;
  REG(0x40021018)|=1u<<3;
  REG(0x40010c00)=(REG(0x40010c00)&~(15u<<8))|(2u<<8);
  REG(0x40010c10)=1u<<2;
  for(u32 i=0;i<8;i++)mailbox[i]=0;
  mailbox[1]=1;mailbox[0]=0x57463133;
  REG(0xe000e014)=7999;REG(0xe000e018)=0;REG(0xe000e010)=5;
  for(;;){
    if(mailbox[4]!=mailbox[5]){u32 nonce=mailbox[4];mailbox[6]++;mailbox[5]=nonce;}
    if(REG(0xe000e010)&0x10000){
      u32 ms=mailbox[2]+1;mailbox[2]=ms;
      if(ms%500==0){u32 tick=mailbox[3]+1;mailbox[3]=tick;mailbox[7]=tick&1;REG(0x40010c10)=(tick&1)?(1u<<18):(1u<<2);}
    }
  }
}
