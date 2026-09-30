/// <reference types="node" />
/** Validate maps against the exact embedded Hermes bytes, then wait for processing. */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { uploadMobileSourceMaps } from './mobile-upload-sourcemaps';

export function validateEmbeddedDebugId(bundle: Buffer, sourceMap: Record<string, unknown>): string {
  const declaredId = sourceMap.debugId ?? sourceMap.debug_id;
  // Hermes string tables retain the UUID injected by Sentry's Metro plugin.
  if (typeof declaredId !== 'string' || !bundle.includes(Buffer.from(declaredId)))
    throw new Error('Packaged Hermes bundle and source map have no matching Debug ID.');
  const debugId = declaredId;
  return debugId;
}

export function uploadEmbeddedSourceMaps(platform: 'ios' | 'android', bundlePath: string, mapPath: string): void {
  const mobileDir = resolve('packages/mobile');
  const bundle = readFileSync(bundlePath);
  const sourceMap = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, unknown>;
  const debugId = validateEmbeddedDebugId(bundle, sourceMap);
  const outputDir = join(mobileDir, 'diagnostic-artifacts', `${platform}-embedded`);
  mkdirSync(outputDir, { recursive: true });
  copyFileSync(bundlePath, join(outputDir, 'embedded.hbc'));
  writeFileSync(join(outputDir, 'embedded.hbc.map'), JSON.stringify({ ...sourceMap, debug_id: debugId, debugId }));
  writeFileSync(
    join(outputDir, 'metadata.json'),
    JSON.stringify({
      version: 0,
      bundler: 'metro',
      fileMetadata: { [platform]: { bundle: 'embedded.hbc', assets: [] } },
    }),
  );
  uploadMobileSourceMaps({ mobileDir, platform, outputDir });
}

if (process.argv[1]?.endsWith('mobile-upload-embedded-sourcemaps.ts')) {
  const [platform, bundlePath, mapPath] = process.argv.slice(2);
  if ((platform !== 'ios' && platform !== 'android') || !bundlePath || !mapPath)
    throw new Error('Usage: mobile-upload-embedded-sourcemaps.ts ios|android bundle map');
  uploadEmbeddedSourceMaps(platform, bundlePath, mapPath);
}
