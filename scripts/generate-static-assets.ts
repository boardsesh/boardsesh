import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMarketingImageVariants } from './lib/marketing-image-variants';
import {
  buildStaticAssetManifest,
  renderStaticAssetObjectKeyCatalogJson,
  renderStaticAssetShellTypeScript,
  renderStaticAssetMarketingTypeScript,
} from './lib/static-asset-catalog';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generatedRoot = resolve(repoRoot, 'packages/shared/static-assets/src/generated');
const checkOnly = process.argv.includes('--check');

async function main(): Promise<void> {
  // Check derivatives before cataloging them: changing the source frame must
  // never leave an otherwise current catalog pointing at old responsive images.
  const imageVariants = await buildMarketingImageVariants(repoRoot);
  let staleImages = false;
  for (const variant of imageVariants) {
    if (checkOnly) {
      let current: Buffer | undefined;
      try {
        current = readFileSync(variant.path);
      } catch {
        // Missing derivatives get the same actionable message as stale ones.
      }
      if (!current?.equals(variant.contents)) {
        console.error(`Static marketing image is stale: ${variant.path}`);
        staleImages = true;
      }
    } else {
      writeFileSync(variant.path, variant.contents);
    }
  }
  if (staleImages) {
    console.error('Run `vp run generate:static-assets` and commit the responsive images and catalogs.');
    process.exitCode = 1;
    return;
  }
  const manifest = buildStaticAssetManifest(repoRoot);
  const outputs = [
    {
      path: resolve(generatedRoot, 'catalog.json'),
      contents: renderStaticAssetObjectKeyCatalogJson(manifest),
    },
    {
      path: resolve(generatedRoot, 'marketing.ts'),
      contents: renderStaticAssetMarketingTypeScript(manifest),
    },
    {
      path: resolve(generatedRoot, 'shell.ts'),
      contents: renderStaticAssetShellTypeScript(manifest),
    },
  ];

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
    console.error('Run `vp run generate:static-assets` and commit the generated catalog files.');
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
