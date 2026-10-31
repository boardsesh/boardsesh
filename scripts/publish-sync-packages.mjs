import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const folder = path.resolve(process.argv[2]);
const packages = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
for (const pkg of packages) {
  // An interrupted release may have published a prefix. Never replace an
  // immutable version: verify its exact integrity before treating it as done.
  const archive = path.join(folder, path.basename(pkg.file));
  let published;
  try {
    published = execFileSync(
      'npm',
      ['view', `${pkg.name}@${pkg.version}`, 'dist.integrity', '--registry=https://npm.pkg.github.com'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch (error) {
    if (!String(error.stderr).includes('E404')) throw new Error(`Cannot check package ${pkg.name}`);
  }
  if (published) {
    if (published !== pkg.integrity) throw new Error(`Version already exists with different content: ${pkg.name}`);
    console.log(`Verified existing ${pkg.name}@${pkg.version}`);
    continue;
  }
  execFileSync(
    'npm',
    ['publish', archive, '--registry=https://npm.pkg.github.com', '--ignore-scripts', '--tag', 'sync'],
    { stdio: 'inherit' },
  );
}
