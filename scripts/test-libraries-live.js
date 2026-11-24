import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['--test', 'tests/library-import-live.test.js'], {
  env: { ...process.env, WICRO_LIVE_LIBRARIES: '1' }, stdio: 'inherit', timeout: 360000
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
