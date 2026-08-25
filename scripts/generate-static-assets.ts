import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildStaticAssetManifest,
  renderStaticAssetJson,
  renderStaticAssetTypeScript,
} from './lib/static-asset-catalog';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generatedRoot = resolve(repoRoot, 'packages/shared/static-assets/src/generated');
const manifest = buildStaticAssetManifest(repoRoot);
const outputs = [
  {
    path: resolve(generatedRoot, 'catalog.ts'),
    contents: renderStaticAssetTypeScript(manifest),
  },
  {
    path: resolve(generatedRoot, 'catalog.json'),
    contents: renderStaticAssetJson(manifest),
  },
];

const checkOnly = process.argv.includes('--check');
let stale = false;
for (const output of outputs) {
  if (checkOnly) {
    let current = '';
    try {
      current = readFileSync(output.path, 'utf8');
    } catch {
      // Report a missing output through the same actionable stale-catalog error.
    }
    if (current !== output.contents) {
      console.error(`Static asset catalog is stale: ${output.path}`);
      stale = true;
    }
  } else {
    writeFileSync(output.path, output.contents, 'utf8');
    console.log(`Wrote ${output.path}`);
  }
}

if (stale) {
  console.error('Run `vp run generate:static-assets` and commit both generated catalog files.');
  process.exit(1);
}
