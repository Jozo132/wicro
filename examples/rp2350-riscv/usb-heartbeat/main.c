/* Bare-metal RP2350 USB diagnostics. Register/endpoint sequencing follows the
 * Raspberry Pi Pico SDK 2.1.0 and pico-examples dev_lowlevel documentation.
 * No SDK API, Arduino runtime, native tool or substitute peripheral is used.
 */
typedef unsigned u32;
typedef unsigned short u16;
typedef unsigned char u8;
#define REG(a) (*(volatile u32 *)(a))
#define USB 0x50110000u
#define DPRAM 0x50100000u
#define BUF(n, out) REG(DPRAM + 0x80 + (n)*8 + ((out)?4:0))
#define EPCTRL(n, out) REG(DPRAM + 8 + ((n)-1)*8 + ((out)?4:0))
static void return_to_rom(void) {
  typedef void *(*lookup_fn)(u32,u32);
#ifdef __riscv
  lookup_fn lookup=(lookup_fn)(u32)*(volatile u16 *)0x7dfa;
  u32 mask=1;
#else
  lookup_fn lookup=(lookup_fn)(u32)*(volatile u16 *)0x16;
  u32 mask=4;
#endif
  int (*reboot)(u32,u32,u32,u32)=(int (*)(u32,u32,u32,u32))lookup(0x4252,mask);
  reboot(0x102,10,0,0);
  for(;;){}
}
static u32 seq, heartbeat, last_tick;
static u8 address_pending, next_address, configured, out_pid, in_pid, boot_pending;
static const u8 device[] = {18,1,0x10,1,0,0,0,64, 0,0,1,0,0,1,1,2,3,1};
static const u8 config[] = {9,2,32,0,1,1,0,0x80,50, 9,4,0,0,2,0xff,0,0,0, 7,5,1,2,64,0,0, 7,5,0x82,2,64,0,0};
static const char *strings[] = {"Wicro", "Wicro RP2350", "WICRO-RP2350"};
static void copy(volatile u8 *to, const u8 *from, u32 n) { for (u32 i=0;i<n;i++) to[i]=from[i]; }
static void ep0(const u8 *bytes, u32 length) {
  if (length) copy((volatile u8 *)(DPRAM+0x100),bytes,length);
  BUF(0,0)=length | (1u<<10) | (1u<<13) | (1u<<15);
}
static void arm_out(void) { BUF(1,1)=64 | (1u<<10) | ((u32)out_pid<<13); out_pid^=1; }
static void endpoints(void) {
  EPCTRL(1,1)=0xa8000180u; EPCTRL(2,0)=0xa80001c0u;
  out_pid=in_pid=0; arm_out();
}
static void stall(void) { REG(USB+0x68)=3; BUF(0,0)=1u<<11; BUF(0,1)=1u<<11; }
static void setup(void) {
  volatile u8 *p=(volatile u8 *)DPRAM;
  u8 direction=p[0], request=p[1];
  u16 value=(u16)p[2]|((u16)p[3]<<8), length=(u16)p[6]|((u16)p[7]<<8);
  REG(USB+0x50)=0x00020000u;
  BUF(0,0)=0; BUF(0,1)=0;
  if (direction==0x40 && request==0x5b && length==0) {boot_pending=1;ep0((const u8 *)0,0);}
  else if (direction==0 && request==5 && value<128) { next_address=(u8)value; address_pending=1; ep0((const u8 *)0,0); }
  else if (direction==0 && request==9 && value<=1) { configured=(u8)value; if(configured)endpoints(); ep0((const u8 *)0,0); }
  else if (direction==0x80 && request==6) {
    u8 kind=(u8)(value>>8), index=(u8)value;
    if(kind==1) ep0(device,length<sizeof(device)?length:sizeof(device));
    else if(kind==2) ep0(config,length<sizeof(config)?length:sizeof(config));
    else if(kind==3) {
      u8 text[64]; u32 size;
      if(index==0){ text[0]=4;text[1]=3;text[2]=9;text[3]=4;size=4; }
      else if(index<=3){const char *s=strings[index-1];size=2;while(*s && size<62){text[size++]=(u8)*s++;text[size++]=0;}text[0]=(u8)size;text[1]=3;}
      else {stall();return;}
      ep0(text,length<size?length:size);
    } else stall();
  } else if (direction==0x80 && request==8) { u8 value=configured;ep0(&value,length?1:0); }
  else if ((direction&0x80) && request==0) { u8 status[2]={0,0};ep0(status,length<2?length:2); }
  else if (direction==1 && request==11 && value==0) ep0((const u8 *)0,0);
  else stall();
}
static void response(void) {
  u8 data[40]={0}; const char *banner="WICRO_RP2350_READY";
  for(u32 i=0;banner[i];i++)data[i]=(u8)banner[i];
  data[19]=1; seq++;
  u32 fields[5]={seq,REG(0x400b0028),0,heartbeat,
#ifdef __riscv
  0x23500002
#else
  0x23500001
#endif
  };
  volatile u8 *rx=(volatile u8 *)(DPRAM+0x180);
  for(u32 i=0;i<4;i++)((u8 *)&fields[2])[i]=rx[i];
  for(u32 i=0;i<20;i++)data[20+i]=((u8 *)fields)[i];
  copy((volatile u8 *)(DPRAM+0x1c0),data,40);
  BUF(2,0)=40|(1u<<10)|(1u<<15)|((u32)in_pid<<13);in_pid^=1;
}
static void poll_usb(void) {
  u32 status=REG(USB+0x98);
  if(status&0x1000){REG(USB+0x50)=0x80000;REG(USB)=0;address_pending=configured=0;out_pid=in_pid=0;}
  if(status&0x10000)setup();
  if(status&0x10){
    u32 done=REG(USB+0x58);REG(USB+0x58)=done;
    if(done&1){if(boot_pending){return_to_rom();}if(address_pending){REG(USB)=next_address;address_pending=0;}else BUF(0,1)=(1u<<10)|(1u<<13);}
    if(done&2)BUF(0,1)=0;
    if(done&(1u<<3))response();
    if(done&(1u<<4))arm_out();
  }
}
static void clocks(void) {
  REG(0x40010084)=0;
  REG(0x4004800c)=47;REG(0x40048000)=0x00fabaa0;
  while(!(REG(0x40048004)&0x80000000u)){}
  REG(0x40010030)=2;REG(0x4001003c)=0;
  REG(0x40023000)=1u<<15;
  while(!(REG(0x40020008)&(1u<<15))){}
  REG(0x40058000)=1;REG(0x40058008)=40;REG(0x40058004)=0x0c;
  while(!(REG(0x40058000)&0x80000000u)){}
  REG(0x4005800c)=0x00052000;REG(0x4005b004)=8;
  REG(0x4001003c)=0x20;REG(0x4001003c)=0x21;
  REG(0x40010064)=0x10000;REG(0x40010060)=0x800;
  REG(0x4010801c)=12;REG(0x40108018)=1;
  REG(0x40022000)=(1u<<23)|(1u<<28);
  REG(0x40023000)=(1u<<23)|(1u<<28);
  while((REG(0x40020008)&((1u<<23)|(1u<<28)))!=((1u<<23)|(1u<<28))){}
}
extern u32 _sidata,_sdata,_edata,_sbss,_ebss;
void Reset_Handler(void) {
  #ifdef __riscv
  __asm__ volatile("csrci mstatus, 8");
#else
  __asm__ volatile("cpsid i");
#endif
  u32 *from=&_sidata;for(u32 *to=&_sdata;to<&_edata;)*to++=*from++;
  for(u32 *to=&_sbss;to<&_ebss;)*to++=0;
  clocks();
  for(u32 i=0;i<4096;i++)((volatile u8 *)DPRAM)[i]=0;
  REG(USB+0x74)=9;REG(USB+0x78)=12;REG(USB+0x40)=1;
  REG(USB+0x4c)=0x20000000;REG(USB+0x90)=0x11010;REG(USB+0x204c)=0x10000;
  for(;;){poll_usb();
    u32 now=REG(0x400b0028);if(now-last_tick>=1000000u){last_tick=now;heartbeat++;}}
}
#ifdef __riscv
extern void _start(void);
__attribute__((used,section(".vectors"))) const u32 vectors[2]={0x20082000,(u32)_start};
__attribute__((used,aligned(4),section(".image_def"))) const u32 image_def[]={0xffffded3,0x11010142,0x00000344,(u32)_start,0x20082000,0x000004ff,0,0xab123579};
#else
__attribute__((used,section(".vectors"))) const u32 vectors[2]={0x20082000,(u32)Reset_Handler};
__attribute__((used,aligned(4),section(".image_def"))) const u32 image_def[]={0xffffded3,0x10210142,0x000001ff,0,0xab123579};
#endif
/* ARM EABI helper emitted by LLVM for aligned automatic-object initialization. */
void __aeabi_memclr4(void *destination, unsigned length) {
  volatile unsigned char *bytes=(volatile unsigned char *)destination;
  while(length--)*bytes++=0;
}

/* LLVM may lower automatic aggregate initialization to this real byte routine. */
void *memset(void *destination, int value, unsigned length) {
  volatile u8 *bytes=(volatile u8 *)destination;
  for(unsigned i=0;i<length;i++)bytes[i]=(u8)value;
  return destination;
}
