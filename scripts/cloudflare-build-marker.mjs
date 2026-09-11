import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const defaultMarkerPath = resolve(
  repositoryRoot,
  'node_modules/.cache/moyo-workers-build.json',
);

export function workersBuildSha(env = process.env) {
  if (env.WORKERS_CI !== '1') return '';
  return (env.WORKERS_CI_COMMIT_SHA || '').trim();
}

export function hasMatchingWorkersBuildMarker({
  env = process.env,
  markerPath = defaultMarkerPath,
} = {}) {
  const sha = workersBuildSha(env);
  if (!sha) return false;

  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    return marker?.commitSha === sha;
  } catch {
    return false;
  }
}

export function writeWorkersBuildMarker({
  env = process.env,
  markerPath = defaultMarkerPath,
} = {}) {
  const sha = workersBuildSha(env);
  if (!sha) return false;

  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(
    markerPath,
    `${JSON.stringify({ commitSha: sha })}\n`,
    'utf8',
  );
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--write') {
  if (writeWorkersBuildMarker()) {
    console.log('Recorded completed Workers Build artifact for Wrangler deploy deduplication.');
  }
}
