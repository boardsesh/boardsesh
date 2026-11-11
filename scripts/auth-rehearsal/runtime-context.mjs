import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getServiceSourcePackageDirs, getWorkspacePackageJsonPaths } from '../create-service-docker-context.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function contextPathAllowed(path) {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.split('/').some((part) => part.startsWith('.') || part === 'node_modules') &&
    !/\.(pem|key|p12|pfx|log)$/i.test(path) &&
    !path.includes('Private/')
  );
}
/** The Dockerfile follows the same no-symlink rule as every other build input. */
export function copyBuildFile(source, destination) {
  let descriptor;
  try {
    descriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error('REHEARSAL_BUILD_INPUT_REFUSED');
    writeFileSync(destination, readFileSync(descriptor), { mode: metadata.mode & 0o777 });
  } catch {
    throw new Error('REHEARSAL_BUILD_INPUT_REFUSED');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
/** Only tracked source/manifests and the explicitly-owned pending fixture enter the image. */
export function createRuntimeContext() {
  const parent = resolve(root, '.boardsesh');
  mkdirSync(parent, { recursive: true });
  const destination = mkdtempSync(resolve(parent, 'auth-rehearsal-build-'));
  function copy(path, layer) {
    if (!contextPathAllowed(path)) throw new Error('REHEARSAL_BUILD_INPUT_REFUSED');
    const source = resolve(root, path);
    if (!lstatSync(source).isFile()) throw new Error('REHEARSAL_BUILD_INPUT_REFUSED');
    const target = resolve(destination, layer, path);
    mkdirSync(dirname(target), { recursive: true });
    copyBuildFile(source, target);
  }
  for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', ...getWorkspacePackageJsonPaths(root)])
    copy(path, 'manifests');
  const sourceDirectories = getServiceSourcePackageDirs('backend', root);
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const path of tracked) {
    if (!contextPathAllowed(path)) continue;
    if (path.endsWith('.patch')) copy(path, 'manifests');
    if (sourceDirectories.some((directory) => path.startsWith(`${directory}/`))) copy(path, 'source');
  }
  for (const directory of ['scripts/auth-rehearsal', 'packages/backend/src/__tests__/auth-rehearsal']) {
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.ts')) copy(`${directory}/${entry.name}`, 'source');
    }
  }
  copyBuildFile(resolve(root, 'scripts/auth-rehearsal/Dockerfile'), resolve(destination, 'Dockerfile'));
  return { directory: destination, relativeDirectory: relative(root, destination) };
}
