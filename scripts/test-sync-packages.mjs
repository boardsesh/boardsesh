/** Rehearse a real installation outside the monorepo; no workspace links. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const artifacts = path.resolve(process.argv[2]);
const packages = JSON.parse(fs.readFileSync(path.join(artifacts, 'manifest.json'), 'utf8'));
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'boardsesh-sync-install-'));
try {
  const dependencies = Object.fromEntries(packages.map((pkg) => [pkg.name, `file:${path.join(artifacts, pkg.file)}`]));
  Object.assign(dependencies, { tsx: '4.23.12', typescript: '7.0.2', '@types/node': '25.9.5' });
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }));
  // npm resolves the exact internal versions from the root file dependencies.
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: folder, stdio: 'inherit' });
  fs.writeFileSync(
    path.join(folder, 'probe.ts'),
    `
    import { applyMoonBoardCatalog, applyMoonBoardBetaLinks, normalizeMoonBoardLogbook } from '@boardsesh/db/moonboard';
    import { decrypt } from '@boardsesh/crypto';
    import { DaemonLease } from '@boardsesh/sync-runtime';
    if (![applyMoonBoardCatalog, applyMoonBoardBetaLinks, normalizeMoonBoardLogbook, decrypt, DaemonLease].every(item => typeof item === 'function')) throw Error('Missing exports');
  `,
  );
  fs.writeFileSync(
    path.join(folder, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['probe.ts'],
    }),
  );
  execFileSync(path.join(folder, 'node_modules/.bin/tsc'), ['--project', 'tsconfig.json'], {
    cwd: folder,
    stdio: 'inherit',
  });
  execFileSync(process.execPath, ['--import', 'tsx', 'probe.ts'], { cwd: folder, stdio: 'inherit' });
} finally {
  fs.rmSync(folder, { recursive: true, force: true });
}
