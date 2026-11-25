/**
 * Canonical, host-independent platform architecture types and extension registries.
 * Contains zero Node.js-specific dependencies so it runs identically in Node.js,
 * browsers, and VS Code.
 */

/**
 * @typedef {object} TargetOptions
 * @property {string} [march]
 * @property {string} [mabi]
 * @property {string} [mcpu]
 * @property {string} [mcu]
 */

/**
 * @typedef {object} ArchitectureDescriptor
 * @property {string} id
 * @property {string} name
 * @property {string} triple
 * @property {number} elfMachine
 * @property {readonly string[]} [defaultFlags]
 * @property {readonly string[]} [capabilities]
 * @property {(targetOptions?: TargetOptions) => string[]} buildTargetArgs
 */

/**
 * @typedef {object} FirmwareValidationResult
 * @property {boolean} valid
 * @property {string[]} errors
 * @property {number} [entry]
 * @property {number} [chipId]
 * @property {number} [segmentCount]
 * @property {boolean} [hasAppDesc]
 * @property {number} [checksum]
 * @property {number} [expectedChecksum]
 * @property {boolean} [sha256Valid]
 * @property {Array<{index:number,loadAddr:number,length:number,fileOffset:number,mapped:boolean}>} [segments]
 */

/**
 * @typedef {object} FirmwareFormatHandler
 * @property {string} id
 * @property {string} extension
 * @property {string} description
 * @property {(elf: Uint8Array, options?: Record<string, unknown>) => Uint8Array|Promise<Uint8Array>} convert
 * @property {(image: Uint8Array, options?: Record<string, unknown>) => FirmwareValidationResult|Promise<FirmwareValidationResult>} validate
 */

/**
 * @typedef {object} FrameworkSourceResult
 * @property {Array<{path:string,source:string,language:'c'|'c++'|'assembly',generated?:boolean}>} units
 * @property {string} [generatedCpp]
 * @property {Array<{generatedLine:number,source:string,sourceLine:number}>} [sourceMap]
 */

/**
 * @typedef {object} FrameworkAdapter
 * @property {string} id
 * @property {string} name
 * @property {readonly string[]} supportedExtensions
 * @property {(context: {sourcePaths:string[],sourceFiles:Record<string,string>,board:BoardDescriptor,projectManifest:Record<string,unknown>}) => FrameworkSourceResult} prepareSources
 * @property {(context: {board:BoardDescriptor,projectManifest:Record<string,unknown>}) => string[]} defaultDefines
 */

/**
 * @typedef {object} BoardBuildRecipe
 * @property {'object'|'bare-metal'|'firmware'} kind
 * @property {string} target
 * @property {TargetOptions} [targetOptions]
 * @property {string} [source]
 * @property {string} [startupSource]
 * @property {string} [linkerScript]
 * @property {string} [output]
 * @property {Record<string,unknown>} [imageOptions]
 * @property {string} [firmwareFormat]
 */

/**
 * @typedef {object} BoardDescriptor
 * @property {string} id
 * @property {string} name
 * @property {string} mcu
 * @property {string} platform
 * @property {string} architecture
 * @property {string} framework
 * @property {number} clockHz
 * @property {BoardBuildRecipe} build
 * @property {Record<string, unknown>} metadata
 * @property {import('../../../registry/src/index.js').WicroPackageManifest} manifest
 */

/**
 * @typedef {object} ProgrammerDescriptor
 * @property {string} id
 * @property {string} name
 * @property {readonly string[]} [browserProtocols]
 * @property {readonly string[]} protocols
 * @property {readonly string[]} [platforms]
 * @property {(options?: Record<string, unknown>) => unknown} [create]
 */

/**
 * @typedef {object} PlatformCompileConfig
 * @property {string[]} compilerFlags
 * @property {string[]} includeDirs
 * @property {string[]} defines
 * @property {Record<string,string>} [preopens]
 * @property {Record<string,string|Uint8Array>} [files]
 * @property {Array<{name:string,source:string,language:'c'|'c++'|'assembly',includeDirs?:string[],compilerFlags?:string[]}>} [extraUnits]
 */

/**
 * @typedef {object} PlatformLinkPlan
 * @property {Record<string,Uint8Array>} [preObjects]
 * @property {Record<string,Uint8Array>} objects
 * @property {Record<string,Uint8Array>} [archives]
 * @property {string[]} [archivePaths]
 * @property {Record<string,string|Uint8Array>} [linkerScripts]
 * @property {string[]} [linkerScriptPaths]
 * @property {string[]} [libraryPaths]
 * @property {string[]} [libraries]
 * @property {string[]} [undefinedSymbols]
 * @property {string[]} [extraLinkerArgs]
 * @property {string} [entry]
 * @property {Record<string,string>} [preopens]
 * @property {Record<string,unknown>} [imageOptions]
 * @property {string} firmwareFormat
 */

/**
 * @typedef {object} PlatformAdapter
 * @property {string} id
 * @property {string} family
 * @property {readonly string[]} architectures
 * @property {readonly string[]} frameworks
 * @property {string} defaultFirmwareFormat
 * @property {string} [programmerId]
 * @property {(board: BoardDescriptor) => boolean} matchesBoard
 * @property {(context: {host:import('../index.js').WicroHostAdapter,board:BoardDescriptor,project:string,projectManifest:Record<string,unknown>,libraryFiles?:Record<string,Uint8Array>,sdk:{files:Record<string,string|Uint8Array>,includeDirs:string[],archives:Record<string,Uint8Array>,linkerScripts:Record<string,string>}}) => Promise<PlatformCompileConfig>} resolveCompileConfig
 * @property {(context: {host:import('../index.js').WicroHostAdapter,board:BoardDescriptor,project:string,projectManifest:Record<string,unknown>,compiledObjects:Record<string,Uint8Array>,sdk:{files:Record<string,string|Uint8Array>,includeDirs:string[],archives:Record<string,Uint8Array>,linkerScripts:Record<string,string>}}) => Promise<PlatformLinkPlan>} prepareLinkPlan
 */

export class WicroPlatformRegistry {
  constructor() {
    /** @type {Map<string, ArchitectureDescriptor>} */
    this.architectures = new Map();
    /** @type {Map<string, PlatformAdapter>} */
    this.platforms = new Map();
    /** @type {Map<string, FrameworkAdapter>} */
    this.frameworks = new Map();
    /** @type {Map<string, FirmwareFormatHandler>} */
    this.firmwareFormats = new Map();
    /** @type {Map<string, ProgrammerDescriptor>} */
    this.programmers = new Map();
  }

  /** @param {ArchitectureDescriptor} descriptor */
  registerArchitecture(descriptor) {
    if (!descriptor?.id) throw new Error('Architecture descriptor requires an id');
    this.architectures.set(descriptor.id, descriptor);
    return this;
  }

  /** @param {PlatformAdapter} adapter */
  registerPlatform(adapter) {
    if (!adapter?.id) throw new Error('Platform adapter requires an id');
    this.platforms.set(adapter.id, adapter);
    return this;
  }

  /** @param {FrameworkAdapter} adapter */
  registerFramework(adapter) {
    if (!adapter?.id) throw new Error('Framework adapter requires an id');
    this.frameworks.set(adapter.id, adapter);
    return this;
  }

  /** @param {FirmwareFormatHandler} handler */
  registerFirmwareFormat(handler) {
    if (!handler?.id) throw new Error('Firmware format handler requires an id');
    this.firmwareFormats.set(handler.id, handler);
    return this;
  }

  /** @param {ProgrammerDescriptor} descriptor */
  registerProgrammer(descriptor) {
    if (!descriptor?.id) throw new Error('Programmer descriptor requires an id');
    this.programmers.set(descriptor.id, descriptor);
    return this;
  }

  /** @param {string} id */
  getArchitecture(id) {
    return this.architectures.get(id);
  }

  /** @param {string} id */
  getPlatform(id) {
    return this.platforms.get(id);
  }

  /** @param {BoardDescriptor} board */
  resolvePlatformForBoard(board) {
    if (board.platform && this.platforms.has(board.platform)) {
      return this.platforms.get(board.platform);
    }
    for (const adapter of this.platforms.values()) {
      if (adapter.matchesBoard(board)) return adapter;
    }
    return undefined;
  }

  /** @param {string} id */
  getFramework(id) {
    return this.frameworks.get(id);
  }

  /** @param {string} id */
  getFirmwareFormat(id) {
    return this.firmwareFormats.get(id);
  }

  /** @param {string} id */
  getProgrammer(id) {
    return this.programmers.get(id);
  }

  summary() {
    return {
      architectures: [...this.architectures.keys()].sort(),
      platforms: [...this.platforms.keys()].sort(),
      frameworks: [...this.frameworks.keys()].sort(),
      firmwareFormats: [...this.firmwareFormats.keys()].sort(),
      programmers: [...this.programmers.keys()].sort()
    };
  }
}
