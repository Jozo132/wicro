/** Preserve quoted SDK-relative include resolution when compiling a staged source
 * buffer. Only existing files inside the verified SDK may become absolute paths.
 * @param {string} source @param {string} path @param {Set<string>} inventory
 */
export const resolveSdkSourceIncludes = (source, path, inventory) => source.replace(/^(\s*#\s*include\s*)"([^"\n]+)"/gm, (original, prefix, name) => {
  if (name.startsWith('/')) return original;
  const parts = path.split('/').slice(0,-1);
  for (const part of name.split('/')) { if (part === '..') { if (!parts.length) return original; parts.pop(); } else if (part !== '.' && part) parts.push(part); }
  const resolved = parts.join('/');
  return inventory.has(resolved) ? `${prefix}"/sdk/${resolved}"` : original;
});
