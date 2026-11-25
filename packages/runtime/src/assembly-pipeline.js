/** Clang's WASI driver cannot spawn a separate preprocessor/assembler process.
 * Execute both genuine WASM stages explicitly when a .S input needs CPP.
 * @param {string[]} args @param {string} language
 */
export const assemblyPipeline = (args, language) => {
  if (language !== 'assembly' || !args.includes('assembler-with-cpp')) return { compile: args };
  const preprocess = args.map((arg, index) => arg === '-c' ? '-E' : args[index - 1] === '-o' ? '/tmp/main.pp.s' : arg);
  preprocess.push('-P');
  const compile = args.map((arg) => arg === 'assembler-with-cpp' ? 'assembler' : arg === '/tmp/main.s' ? '/tmp/main.pp.s' : arg);
  compile.push('-fintegrated-as');
  return { preprocess, compile };
};
