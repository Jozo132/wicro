import { preprocessIno } from '../../../arduino/src/index.js';

/** @param {string} sourcePath @returns {'c'|'c++'|'assembly'} */
const detectLanguage = (sourcePath) => {
  if (/\.(cpp|cxx|cc)$/i.test(sourcePath)) return 'c++';
  if (/\.(s|S|asm)$/i.test(sourcePath)) return 'assembly';
  return 'c';
};

/** @param {import('./registry.js').BoardDescriptor} board */
const defaultBoardDefines = (board) => {
  const boardDefine = board.id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  const archDefine = String(board.architecture ?? '').replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  return [
    `F_CPU=${board.clockHz}L`,
    'ARDUINO=10808',
    `ARDUINO_${boardDefine}`,
    `ARDUINO_ARCH_${archDefine}`
  ].filter((value) => !value.endsWith('_'));
};

/** @type {import('./registry.js').FrameworkAdapter} */
export const arduinoFrameworkAdapter = Object.freeze({
  id: 'arduino',
  name: 'Arduino Framework',
  supportedExtensions: Object.freeze(['.ino', '.pde', '.c', '.cc', '.cpp', '.cxx', '.s', '.S', '.asm']),
  prepareSources({ sourcePaths, sourceFiles, board }) {
    const inoPaths = sourcePaths
      .filter((path) => /\.(ino|pde)$/i.test(path))
      .sort((left, right) => {
        const leftMain = /(?:^|\/)(?:main|sketch)\.(?:ino|pde)$/i.test(left);
        const rightMain = /(?:^|\/)(?:main|sketch)\.(?:ino|pde)$/i.test(right);
        if (leftMain !== rightMain) return leftMain ? -1 : 1;
        const leftBase = left.split('/').pop() ?? left;
        const rightBase = right.split('/').pop() ?? right;
        if (leftBase.length !== rightBase.length) return leftBase.length - rightBase.length;
        return leftBase.localeCompare(rightBase);
      });

    /** @type {Array<{path:string,source:string,language:'c'|'c++'|'assembly',generated?:boolean}>} */
    const units = [];
    let generatedCpp;
    let sourceMap;

    if (inoPaths.length > 0) {
      const tabs = Object.fromEntries(inoPaths.map((path) => [path, sourceFiles[path] ?? '']));
      const sketch = preprocessIno(tabs);
      generatedCpp = board.build.kind === 'bare-metal'
        ? `${sketch.cpp}\nextern "C" int main(void) { setup(); for (;;) { loop(); } return 0; }\n`
        : sketch.cpp;
      sourceMap = sketch.sourceMap;
      units.push({ path: inoPaths[0] ?? 'sketch.cpp', source: generatedCpp, language: 'c++', generated: true });
    }

    for (const sourcePath of sourcePaths.filter((path) => !/\.(ino|pde)$/i.test(path))) {
      if (!/\.(c|cpp|cxx|cc|s|S|asm)$/i.test(sourcePath)) continue;
      units.push({
        path: sourcePath,
        source: sourceFiles[sourcePath] ?? '',
        language: detectLanguage(sourcePath)
      });
    }

    return { units, generatedCpp, sourceMap };
  },
  defaultDefines({ board }) {
    return defaultBoardDefines(board);
  }
});

/** @type {import('./registry.js').FrameworkAdapter} */
export const bareMetalFrameworkAdapter = Object.freeze({
  id: 'bare-metal',
  name: 'Bare-Metal C/C++',
  supportedExtensions: Object.freeze(['.c', '.cc', '.cpp', '.cxx', '.s', '.S', '.asm']),
  prepareSources({ sourcePaths, sourceFiles }) {
    const units = sourcePaths
      .filter((path) => /\.(c|cpp|cxx|cc|s|S|asm)$/i.test(path))
      .map((path) => ({
        path,
        source: sourceFiles[path] ?? '',
        language: detectLanguage(path)
      }));
    return { units };
  },
  defaultDefines({ board }) {
    return [`F_CPU=${board.clockHz}L`];
  }
});

/** @type {import('./registry.js').FrameworkAdapter} */
export const espIdfFrameworkAdapter = Object.freeze({
  id: 'esp-idf',
  name: 'ESP-IDF',
  supportedExtensions: Object.freeze(['.c', '.cc', '.cpp', '.cxx', '.s', '.S', '.asm']),
  prepareSources({ sourcePaths, sourceFiles }) {
    const units = sourcePaths
      .filter((path) => /\.(c|cpp|cxx|cc|s|S|asm)$/i.test(path))
      .map((path) => ({
        path,
        source: sourceFiles[path] ?? '',
        language: detectLanguage(path)
      }));
    return { units };
  },
  defaultDefines({ board }) {
    return [`F_CPU=${board.clockHz}L`];
  }
});

export const BUILTIN_FRAMEWORKS = Object.freeze([
  arduinoFrameworkAdapter,
  bareMetalFrameworkAdapter,
  espIdfFrameworkAdapter
]);
