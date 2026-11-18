import { createRequire } from 'node:module';
import { rcompare, satisfies } from 'semver';
import { readFile } from 'node:fs/promises';

/** @typedef {'toolchain'|'platform'|'framework'|'microcontroller'|'board'|'library'|'programmer'|'tool'|'template'} PackageKind */

/**
 * @typedef {object} WicroPackageManifest
 * @property {string} name
 * @property {string} version
 * @property {PackageKind} kind
 * @property {string} description
 * @property {string} license
 * @property {string} [homepage]
 * @property {string} [repository]
 * @property {string} [sha256]
 * @property {Record<string, string>} [dependencies]
 * @property {Record<string, unknown>} [metadata]
 * @property {{browser?: boolean, node?: boolean, vscode?: boolean}} [host]
 */

/** @returns {Promise<(value: unknown) => {ok: boolean, value?: WicroPackageManifest, errors?: import('ajv').ErrorObject[]}>} */
export const createManifestValidator = async () => {
  const schemaUrl = new URL('../../../schemas/package.schema.json', import.meta.url);
  const schema = JSON.parse(await readFile(schemaUrl, 'utf8'));
  const require = createRequire(import.meta.url);
  /** @type {any} */
  const Ajv = require('ajv/dist/2020');
  /** @type {(instance: any) => void} */
  const addFormats = require('ajv-formats');
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  return (value) => {
    const ok = Boolean(validate(value));
    if (!ok) {
      return { ok: false, errors: validate.errors ?? [] };
    }

    return { ok: true, value: /** @type {WicroPackageManifest} */ (value) };
  };
};

export class PackageRegistry {
  constructor() {
    /** @type {Map<string, WicroPackageManifest[]>} */
    this.packages = new Map();
  }

  /** @param {WicroPackageManifest} manifest */
  async add(manifest) {
    const validate = await createManifestValidator();
    const result = validate(manifest);
    if (!result.ok) throw new Error(formatValidationErrors(result.errors ?? []));

    const versions = this.packages.get(manifest.name) ?? [];
    if (versions.some((item) => item.version === manifest.version)) {
      throw new Error(`Package version already exists: ${manifest.name}@${manifest.version}`);
    }

    versions.push(manifest);
    versions.sort((left, right) => rcompare(left.version, right.version));
    this.packages.set(manifest.name, versions);
  }

  /** @param {string} name @param {string} range */
  resolve(name, range) {
    const versions = this.packages.get(name);
    if (!versions) return undefined;

    return versions.find((item) => satisfies(item.version, range));
  }

  /** @param {string} name */
  list(name) {
    if (name) return [...(this.packages.get(name) ?? [])];
    return [...this.packages.values()].flatMap((versions) => [...versions]);
  }
}

/** @param {import('ajv').ErrorObject[]} errors */
const formatValidationErrors = (errors) => {
  return errors.map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('; ');
};
