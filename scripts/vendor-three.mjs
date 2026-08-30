import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const EXPECTED_THREE_VERSION = "0.185.1";
const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "node_modules/three");
const destination = resolve(root, "public/vendor/three");
const packageMetadata = JSON.parse(await readFile(resolve(source, "package.json"), "utf8"));
if (packageMetadata.version !== EXPECTED_THREE_VERSION) {
  throw new Error(`Expected three@${EXPECTED_THREE_VERSION}, received ${packageMetadata.version}`);
}

await rm(destination, { recursive: true, force: true });

const files = [
  "LICENSE",
  "build/three.module.js",
  "build/three.core.js",
  "examples/jsm/loaders/GLTFLoader.js",
  "examples/jsm/environments/RoomEnvironment.js",
  "examples/jsm/utils/BufferGeometryUtils.js",
  "examples/jsm/utils/SkeletonUtils.js",
];

for (const relative of files) {
  const output = resolve(destination, relative);
  await mkdir(dirname(output), { recursive: true });
  await copyFile(resolve(source, relative), output);
}
console.log(`Three.js ${packageMetadata.version} runtime copied to ${destination}`);
