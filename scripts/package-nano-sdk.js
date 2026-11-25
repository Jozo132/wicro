import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { zipSync } from 'fflate';
import { sha256Bytes } from '../packages/registry/src/sdk.js';
const framework = join(homedir(), '.platformio/packages/framework-arduino-avr');
const toolchain = join(homedir(), '.platformio/packages/toolchain-atmelavr');
const frameworkInfo = JSON.parse(await readFile(join(framework, 'package.json'), 'utf8'));
const toolchainInfo = JSON.parse(await readFile(join(toolchain, 'package.json'), 'utf8'));
if (frameworkInfo.version !== '5.4.0' || toolchainInfo.version !== '1.70300.191015') throw new Error('Nano SDK packaging requires the tested AVR framework 5.4.0 and toolchain data 1.70300.191015');
/** @type {Record<string,Uint8Array>} */
const files = {};
/** @param {string} directory @param {string} prefix */
const collect = async (directory, prefix) => {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name), key = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await collect(path, key); else files[key] = new Uint8Array(await readFile(path));
  }
};
await collect(join(framework, 'cores/arduino'), 'core');
await collect(join(framework, 'variants/eightanaloginputs'), 'variant');
await collect(join(framework, 'variants/standard'), 'standard');
await collect(join(toolchain, 'avr/include'), 'avr/include');
await collect(join(toolchain, 'lib/gcc/avr/7.3.0/include'), 'gcc/include');
for (const name of ['crtatmega328p.o', 'libatmega328p.a', 'libc.a', 'libm.a']) files[`lib/${name}`] = new Uint8Array(await readFile(join(toolchain, 'avr/lib/avr5', name)));
files['lib/libgcc.a'] = new Uint8Array(await readFile(join(toolchain, 'lib/gcc/avr/7.3.0/avr5/libgcc.a')));
const sources = Object.keys(files).filter((name) => /^core\/[^/]+\.(c|cpp)$/.test(name) && !['core/CDC.cpp', 'core/USBCore.cpp', 'core/PluggableUSB.cpp'].includes(name)).map((name) => name.slice(5)).sort();
files['sources.json'] = new TextEncoder().encode(JSON.stringify(sources));
files['provenance.json'] = new TextEncoder().encode(JSON.stringify({ framework: JSON.parse(await readFile(join(framework, 'package.json'), 'utf8')), toolchain: JSON.parse(await readFile(join(toolchain, 'package.json'), 'utf8')), selection: 'ATmega328P AVR5 only; native executables excluded' }, null, 2));
for (const name of ['README.md', 'package.json']) files[`licenses/framework/${name}`] = new Uint8Array(await readFile(join(framework, name)));
const bytes = zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) });
await mkdir('dist/assets', { recursive: true });
await writeFile('dist/assets/nano-arduino-sdk-1.0.0.zip', bytes);
const manifest = { name: 'nano-arduino-sdk', version: '1.0.0', kind: 'platform', description: 'Curated genuine Arduino AVR core and AVR5 target runtime for Nano; distribution deployment pending', license: 'LGPL-2.1-or-later', metadata: { distribution: { url: '', mirrors: [], archiveType: 'zip', sha256: await sha256Bytes(bytes) }, deployment: 'local-development-only' } };
await mkdir('registry/nano-arduino-sdk', { recursive: true });
await writeFile(resolve('registry/nano-arduino-sdk/package.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ bytes: bytes.length, files: Object.keys(files).length, sha256: manifest.metadata.distribution.sha256 }));
