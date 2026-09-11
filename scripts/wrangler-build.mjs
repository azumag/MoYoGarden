import { spawnSync } from 'node:child_process';
import { hasMatchingWorkersBuildMarker } from './cloudflare-build-marker.mjs';

// Workers Builds already runs the dashboard Build command before the Deploy
// command. `wrangler deploy` then evaluates wrangler.jsonc's custom build hook.
// Without this guard, Cloudflare runs the expensive `build:web` pipeline twice
// in the same build (tests, model generation, asset vendoring and validation).
// Reuse the artifact only when Cloudflare's system commit SHA matches the marker
// written by the first build. Outside Workers Builds, or if the marker is
// missing/stale, fail safe by rebuilding as before.
if (hasMatchingWorkersBuildMarker()) {
  console.log(
    'Skipping duplicate wrangler build:web: this Workers Build commit was already prepared.',
  );
  process.exit(0);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['run', 'build:web'], {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
