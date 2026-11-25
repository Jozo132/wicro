/** Apply declarative framework-specific dependencies and board metadata consistently
 * before SDK acquisition, build planning and rendering target choices.
 * @template {{dependencies?:Record<string,string>,metadata?:Record<string,any>}} T
 * @param {T} manifest @param {string|undefined} framework
 * @returns {T}
 */
export const applyFrameworkConfiguration = (manifest, framework) => {
  const selected = framework ?? manifest.metadata?.framework;
  const config = manifest.metadata?.frameworkConfigurations?.[selected];
  if (!config) return manifest;
  return { ...manifest, dependencies: { ...manifest.dependencies, ...config.dependencies }, metadata: { ...manifest.metadata, ...config.metadata, build: { ...manifest.metadata?.build, ...config.metadata?.build } } };
};
