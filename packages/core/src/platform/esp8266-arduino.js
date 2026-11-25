/** @typedef {{variant:string}} Esp8266ArduinoRecipe */
/** @param {import('../index.js').WicroHostAdapter} host @param {string} root @param {string} path */
const text = async (host, root, path) => {
  const value = await host.readFile(`${root}/${path}`, { encoding: 'utf8' });
  if (typeof value !== 'string') throw new Error(`Missing ESP8266 Arduino input ${path}`);
  return value;
};

/** Expand only the checksum-pinned upstream ESP8266 linker template's declared
 * vtable/FP branches. Unknown directives fail instead of running Python hooks.
 * @param {string} source @param {string} vtables
 */
export const prepareEsp8266ArduinoScript = (source, vtables) => {
  const active = [true], output = [];
  for (const line of source.split('\n')) {
    const condition = line.match(/^#if(?:def)?\s+(.+)$/);
    if (condition) {
      const expr = condition[1].trim();
      if (!['VTABLES_IN_DRAM','VTABLES_IN_FLASH','VTABLES_IN_IRAM','FP_IN_IROM','defined(VTABLES_IN_IRAM) || defined(VTABLES_IN_FLASH)'].includes(expr)) throw new Error(`Unknown ESP8266 linker condition ${expr}`);
      active.push(Boolean(active.at(-1)) && expr.includes('VTABLES_IN_FLASH')); continue;
    }
    if (line.startsWith('#endif')) { if (active.length === 1) throw new Error('Unbalanced linker template'); active.pop(); continue; }
    if (!active.at(-1)) continue;
    if (line.startsWith('#include "eagle.app.v6.common.ld.vtables.h"')) output.push(vtables);
    else if (line.startsWith('#')) throw new Error(`Unknown linker directive ${line}`);
    else output.push(line);
  }
  if (active.length !== 1) throw new Error('Unclosed linker template');
  return output.join('\n').replaceAll('MMU_IRAM_SIZE', '32768').replace('INCLUDE "../ld/eagle.rom.addr.v6.ld"', 'INCLUDE "rom.ld"');
};

/** @type {import('./registry.js').PlatformAdapter} */
export const esp8266ArduinoPlatformAdapter = Object.freeze({
  id:'espressif-esp8266-arduino', family:'esp8266', architectures:Object.freeze(['xtensa']), frameworks:Object.freeze(['arduino']), defaultFirmwareFormat:'esp8266-arduino',
  matchesBoard:(board)=>board.metadata.platform==='espressif-esp8266-arduino',
  async resolveCompileConfig({host,board,project,projectManifest,libraryFiles}) {
    const root=host.sdkCacheDirectory, recipe=/** @type {Esp8266ArduinoRecipe} */(board.metadata.esp8266Arduino);
    if(!root||!recipe?.variant)throw new Error('Genuine ESP8266 Arduino SDK and variant required');
    const inventory=/** @type {string[]} */(JSON.parse(await text(host,root,'inventory.json')));
    const core='framework/cores/esp8266', paths=inventory.filter((path)=>path.startsWith(core+'/')&&/\.(c|cpp|S)$/.test(path));
    const includeDirs=[`/sdk/${core}`,`/sdk/framework/variants/${recipe.variant}`,'/sdk/framework/tools/sdk/include','/sdk/framework/tools/sdk/lwip2/include','/sdk/sysroot/include/c++/10.3.0','/sdk/sysroot/include/c++/10.3.0/xtensa-lx106-elf','/sdk/gcc/include','/sdk/sysroot/include','/sdk/gcc/include-fixed','/sdk/tool/include'];
    const build=/** @type {{sources?:string[],flags?:string[],defines?:string[]}} */(projectManifest.build??{});
    let scan='';for(const path of build.sources??['main.ino'])scan+=await text(host,project,path);for(const value of Object.values(libraryFiles??{}))scan+='\n'+new TextDecoder().decode(value);
    const selected=new Set();
    for(;;){let added=false;for(const match of scan.matchAll(/^\s*#\s*include\s*[<"]([^">]+)[">]/gm)){
      const candidate=inventory.find((path)=>path.startsWith('framework/libraries/')&&path.endsWith('/'+match[1])&&!/\/(examples|tests?)\//.test(path));const library=candidate?.split('/')[2];
      if(!library||selected.has(library))continue;selected.add(library);added=true;includeDirs.push(`/sdk/framework/libraries/${library}/src`,`/sdk/framework/libraries/${library}`);
      for(const path of inventory.filter((path)=>path.startsWith(`framework/libraries/${library}/`)&&!/\/(examples|tests?)\//.test(path))){if(/\.(c|cpp|S)$/.test(path))paths.push(path);if(/\.(h|hpp|c|cpp)$/.test(path))scan+='\n'+await text(host,root,path);}
    }if(!added)break;}
    /** @type {Array<{name:string,source:string,language:'c'|'c++'|'assembly',includeDirs:string[],compilerFlags:string[]}>} */const extraUnits=[];
    for(const path of [...new Set(paths)].sort())extraUnits.push({name:path.replace(/\W/g,'_')+'.o',source:(await text(host,root,path)).replace(/, nothrow(?=\)\))/g,''),language:path.endsWith('.S')?'assembly':path.endsWith('.cpp')?'c++':'c',includeDirs:['/sdk/'+path.split('/').slice(0,-1).join('/')],compilerFlags:path.endsWith('.S')?['-x','assembler-with-cpp']:[]});
    return {compilerFlags:['-std=gnu++17','-Os','-fintegrated-as','-mlongcalls','-fno-rtti','-fno-exceptions','-fno-builtin','-ffunction-sections','-fdata-sections','-falign-functions=4','-Wno-unknown-attributes','-Wno-ignored-attributes',...(build.flags??[])],defines:['__ets__','ICACHE_FLASH','_GNU_SOURCE','ESP8266','ARDUINO=10819','ARDUINO_ARCH_ESP8266',`ARDUINO_BOARD="${board.id}"`,`F_CPU=${board.clockHz}L`,'NONOSDK22x_190703=1','LWIP_OPEN_SRC','TCP_MSS=1460','LWIP_FEATURES=1','LWIP_IPV6=0','VTABLES_IN_FLASH','MMU_IRAM_SIZE=0x8000','MMU_ICACHE_SIZE=0x8000',...(build.defines??[])],includeDirs,extraUnits,preopens:{'/sdk':root}};
  },
  async prepareLinkPlan({host,compiledObjects}) {
    const root=host.sdkCacheDirectory;if(!root)throw new Error('ESP8266 Arduino SDK missing');
    const common=prepareEsp8266ArduinoScript(await text(host,root,'framework/tools/sdk/ld/eagle.app.v6.common.ld.h'),await text(host,root,'framework/tools/sdk/ld/eagle.app.v6.common.ld.vtables.h'));
    const flash=(await text(host,root,'framework/tools/sdk/ld/eagle.flash.4m1m.ld')).replace('local.eagle.app.v6.common.ld','common.ld');
    const eboot=await host.readFile(`${root}/framework/bootloaders/eboot/eboot.elf`,{encoding:'binary'});if(!(eboot instanceof Uint8Array))throw new Error('Genuine ESP8266 eboot ELF required');
    return {objects:compiledObjects,preopens:{'/sdk':root},libraryPaths:['/sdk/framework/tools/sdk/lib/NONOSDK22x_190703','/sdk/framework/tools/sdk/lib','/sdk/lib'],libraries:['hal','phy','pp','net80211','lwip2-1460-feat','wpa','crypto','main','wps','bearssl','espnow','smartconfig','airkiss','wpa2','stdc++','m','c','gcc'],linkerScripts:{'flash.ld':flash,'common.ld':common,'rom.ld':await text(host,root,'framework/tools/sdk/ld/eagle.rom.addr.v6.ld')},entry:'app_entry',undefinedSymbols:['app_entry'],extraLinkerArgs:['--wrap=system_restart_local','--wrap=spi_flash_read'],firmwareFormat:'esp8266-arduino',imageOptions:{eboot}};
  }
});
