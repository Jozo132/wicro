/* Bare-metal RP2040 USB diagnostics. Register/endpoint sequencing follows the
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
  typedef void *(*lookup_fn)(u16 *,u32);
  lookup_fn lookup=(lookup_fn)((u32)(*(volatile u16 *)0x18)|1u);
  void (*boot)(u32,u32)=(void (*)(u32,u32))lookup((u16 *)(u32)(*(volatile u16 *)0x14),0x4255);
  boot(0,0);
}
#ifdef WICRO_RP2040_DIAGNOSTIC
#define DEBUG ((volatile u32 *)0x20041000)
#endif
static u32 seq, heartbeat, last_tick;
static u8 address_pending, next_address, configured, out_pid, in_pid, boot_pending;
static const u8 device[] = {18,1,0x10,1,0,0,0,64, 0,0,1,0,0,1,1,2,3,1};
static const u8 config[] = {9,2,32,0,1,1,0,0x80,50, 9,4,0,0,2,0xff,0,0,0, 7,5,1,2,64,0,0, 7,5,0x82,2,64,0,0};
static const char *strings[] = {"Wicro", "Wicro RP2040-Zero", "WICRO-RP2040-ZERO"};
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
#ifdef WICRO_RP2040_DIAGNOSTIC
  DEBUG[20]++;DEBUG[21]=REG(DPRAM);DEBUG[22]=REG(DPRAM+4);
#endif
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
  u8 data[40]={0}; const char *banner="WICRO_RP2040_READY";
  for(u32 i=0;banner[i];i++)data[i]=(u8)banner[i];
  data[19]=1; seq++;
  u32 fields[5]={seq,REG(0x40054028),0,heartbeat,0x20400001};
  volatile u8 *rx=(volatile u8 *)(DPRAM+0x180);
  for(u32 i=0;i<4;i++)((u8 *)&fields[2])[i]=rx[i];
  for(u32 i=0;i<20;i++)data[20+i]=((u8 *)fields)[i];
  copy((volatile u8 *)(DPRAM+0x1c0),data,40);
  BUF(2,0)=40|(1u<<10)|(1u<<15)|((u32)in_pid<<13);in_pid^=1;
}
/* RP2040-E5 workaround adapted from Pico SDK 2.1.0 (BSD-3-Clause,
 * Copyright (c) 2020 Raspberry Pi (Trading) Ltd.). GPIO15 is restored afterward. */
static u32 fix_stage, fix_started, gpio15_saved, pad15_saved;
static void enumeration_fix(void) {
  if(fix_stage==1){
    if(((REG(USB+0x50)>>2)&3)==0)return;
    gpio15_saved=REG(0x4001407c);pad15_saved=REG(0x4001c040);
    REG(0x4001c040)=pad15_saved|12;
    REG(0x4001407c)=(gpio15_saved&~0x0003301fu)|0x00032008;
    REG(USB+0x207c)=2;REG(USB+0x2080)=4;REG(USB+0x74)=12;
    fix_started=REG(0x40054028);fix_stage=2;
  }else if(fix_stage==2 && (u32)(REG(0x40054028)-fix_started)>=1000 && (REG(USB+0x50)&0x10000)){
    REG(USB+0x74)=9;REG(USB+0x3080)=4;
    REG(0x4001407c)=gpio15_saved;REG(0x4001c040)=pad15_saved;fix_stage=0;
  }
}
static void poll_usb(void) {
  u32 status=REG(USB+0x98);
  if(status&0x1000){if((REG(0x40000000)>>28)==1)fix_stage=1;REG(USB+0x50)=0x80000;REG(USB)=0;address_pending=configured=0;out_pid=in_pid=0;}
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
  REG(0x4002400c)=47;REG(0x40024000)=0x00fabaa0;
  while(!(REG(0x40024004)&0x80000000u)){}
  REG(0x40008030)=2;REG(0x4000803c)=0;
  REG(0x4000f000)=1u<<13;
  while(!(REG(0x4000c008)&(1u<<13))){}
  REG(0x4002c000)=1;REG(0x4002c008)=40;REG(0x4002c004)=0x0c;
  while(!(REG(0x4002c000)&0x80000000u)){}
  REG(0x4002c00c)=0x00052000;REG(0x4002f004)=8;
  REG(0x4000803c)=0x20;REG(0x4000803c)=0x21;
  REG(0x40008058)=256;REG(0x40008054)=0x800;
  REG(0x4005802c)=0x20c;
  REG(0x4000f000)=(1u<<5)|(1u<<8)|(1u<<21)|(1u<<24);
  while((REG(0x4000c008)&((1u<<21)|(1u<<24)))!=((1u<<21)|(1u<<24))){}
}
extern u32 _sidata,_sdata,_edata,_sbss,_ebss;
void Reset_Handler(void) {
  __asm__ volatile("cpsid i");
#ifdef WICRO_RP2040_DIAGNOSTIC
  for(u32 i=0;i<64;i++)DEBUG[i]=0;DEBUG[0]=0x57494352;DEBUG[1]=1;
#endif
  u32 *from=&_sidata;for(u32 *to=&_sdata;to<&_edata;)*to++=*from++;
  for(u32 *to=&_sbss;to<&_ebss;)*to++=0;
  clocks();
#ifdef WICRO_RP2040_DIAGNOSTIC
  DEBUG[1]=2;
#endif
  for(u32 i=0;i<4096;i++)((volatile u8 *)DPRAM)[i]=0;
  REG(USB+0x74)=9;REG(USB+0x78)=12;REG(USB+0x40)=1;
  REG(USB+0x4c)=0x20000000;REG(USB+0x90)=0x11010;REG(USB+0x204c)=0x10000;
#ifdef WICRO_RP2040_DIAGNOSTIC
  u32 loops=0;
#endif
  for(;;){poll_usb();enumeration_fix();
#ifdef WICRO_RP2040_DIAGNOSTIC
    DEBUG[1]=3;DEBUG[2]=REG(USB+0x8c);DEBUG[3]=REG(USB+0x98);DEBUG[4]=REG(USB+0x50);DEBUG[5]=BUF(0,0);DEBUG[6]=BUF(0,1);DEBUG[7]=REG(USB);DEBUG[8]=REG(0x40008054);DEBUG[9]=REG(0x4002c004);DEBUG[10]=REG(0x4002c00c);DEBUG[11]=REG(0x4002c000);DEBUG[12]=REG(0x40000000);DEBUG[13]=fix_stage;
    if(++loops==2000000){DEBUG[1]=4;return_to_rom();}
#endif
    u32 now=REG(0x40054028);if(now-last_tick>=1000000u){last_tick=now;heartbeat++;}}
}
__attribute__((used,section(".vectors"))) const u32 vectors[2]={0x20042000,(u32)Reset_Handler};
/* ARM EABI helper emitted by LLVM for aligned automatic-object initialization. */
void __aeabi_memclr4(void *destination, unsigned length) {
  volatile unsigned char *bytes=(volatile unsigned char *)destination;
  while(length--)*bytes++=0;
}
