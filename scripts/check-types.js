import { spawnSync } from 'node:child_process';

const result = spawnSync('tsc', ['--noEmit', '--pretty', 'false', '-p', 'jsconfig.json'], {
  encoding: 'utf8',
  timeout: 120_000,
  maxBuffer: 2 * 1024 * 1024
});

if (result.error) {
  console.error(`Type check failed to start: ${result.error.message}`);
  process.exit(1);
}

if (result.status === null) {
  console.error('Type check timed out after 120 seconds');
  process.exit(124);
}

const ignoredFragments = ['/node_modules/', '/dist/', '/build/', '/toolchain/'];
const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`;
const diagnostics = raw
  .split(/\r?\n/)
  .filter((line) => line.length > 0)
  .filter((line) => !ignoredFragments.some((fragment) => `/${line}`.includes(fragment)));

const visible = diagnostics.slice(0, 100);
if (visible.length > 0) process.stdout.write(`${visible.join('\n')}\n`);

if (diagnostics.length > visible.length) {
  process.stdout.write(`... ${diagnostics.length - visible.length} more diagnostics omitted\n`);
}

if (result.status === 0) {
  if (visible.length === 0) process.stdout.write('Type check passed\n');
  process.exit(0);
}

if (diagnostics.length === 0) {
  process.stdout.write('Type check passed for source files; dependency/generated diagnostics suppressed\n');
  process.exit(0);
}

process.exit(result.status);
