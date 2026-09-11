import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  defaultMarkerPath,
  hasMatchingWorkersBuildMarker,
  writeWorkersBuildMarker,
} from '../scripts/cloudflare-build-marker.mjs';

const workersEnv = {
  ...process.env,
  WORKERS_CI: '1',
  WORKERS_CI_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567',
};

function cleanupMarker() {
  rmSync(defaultMarkerPath, { force: true });
}

test.afterEach(cleanupMarker);

test('Workers Build marker matches only the exact Cloudflare commit', () => {
  cleanupMarker();
  assert.equal(writeWorkersBuildMarker({ env: workersEnv }), true);
  assert.equal(hasMatchingWorkersBuildMarker({ env: workersEnv }), true);
  assert.equal(
    hasMatchingWorkersBuildMarker({
      env: { ...workersEnv, WORKERS_CI_COMMIT_SHA: 'fedcba9876543210fedcba9876543210fedcba98' },
    }),
    false,
  );
  assert.equal(
    hasMatchingWorkersBuildMarker({ env: { ...workersEnv, WORKERS_CI: '' } }),
    false,
  );
});

test('Wrangler custom build skips the duplicate build:web for the same Workers Build', () => {
  cleanupMarker();
  writeWorkersBuildMarker({ env: workersEnv });

  const result = spawnSync(process.execPath, ['scripts/wrangler-build.mjs'], {
    cwd: process.cwd(),
    env: workersEnv,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Skipping duplicate wrangler build:web/);
});

test('Wrangler config and build:web keep the deduplication hooks wired', () => {
  const wrangler = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

  assert.equal(wrangler.build.command, 'node scripts/wrangler-build.mjs');
  assert.match(
    packageJson.scripts['build:web'],
    /node scripts\/cloudflare-build-marker\.mjs --write$/,
  );
});
