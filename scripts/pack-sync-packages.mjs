/** Build source-distributed ESM packages consumed using the same tsx runtime as Boardsesh daemons. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(version ?? '')) throw new Error('Provide an explicit package version');
const output = path.resolve(process.argv[3] ?? path.join(root, 'artifacts/sync-packages'));
fs.mkdirSync(output, { recursive: true });
const catalog = new Map();
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || ['node_modules', 'dist', '.git'].includes(entry.name)) continue;
    const folder = path.join(dir, entry.name),
      manifest = path.join(folder, 'package.json');
    if (fs.existsSync(manifest)) {
      const data = JSON.parse(fs.readFileSync(manifest));
      catalog.set(data.name, { folder, data });
    } else scan(folder);
  }
}
scan(path.join(root, 'packages'));
const required = new Set();
function include(name) {
  if (required.has(name)) return;
  const pkg = catalog.get(name);
  if (!pkg) throw new Error(`Missing workspace package ${name}`);
  required.add(name);
  for (const deps of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [dep, range] of Object.entries(pkg.data[deps] ?? {})) if (range.startsWith('workspace:')) include(dep);
  }
}
for (const name of ['@boardsesh/db', '@boardsesh/crypto', '@boardsesh/sync-runtime']) include(name);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boardsesh-sync-pack-'));
const results = [];
try {
  for (const name of required) {
    const { folder, data } = catalog.get(name),
      stage = path.join(directory, name.split('/')[1]);
    fs.mkdirSync(stage);
    for (const item of ['src', 'README.md', 'LICENSE']) {
      if (fs.existsSync(path.join(folder, item)))
        fs.cpSync(path.join(folder, item), path.join(stage, item), { recursive: true });
    }
    const manifest = {
      ...data,
      version,
      private: false,
      scripts: {},
      files: ['src', 'README.md', 'LICENSE'],
      publishConfig: { registry: 'https://npm.pkg.github.com' },
      repository: { type: 'git', url: 'https://github.com/boardsesh/boardsesh.git' },
    };
    delete manifest.devDependencies;
    for (const deps of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      if (manifest[deps])
        manifest[deps] = Object.fromEntries(
          Object.entries(manifest[deps]).map(([dep, range]) => [dep, required.has(dep) ? version : range]),
        );
    }
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2));
    const result = JSON.parse(
      execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], {
        cwd: stage,
        encoding: 'utf8',
      }),
    );
    results.push({ name, version, file: result[0].filename, integrity: result[0].integrity });
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
