import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(scriptDirectory, '..');
const maplibreDirectory = path.dirname(createRequire(import.meta.url).resolve('maplibre-gl/package.json'));
const publicMapDirectory = path.join(webDirectory, 'public', 'maplibre');

await mkdir(publicMapDirectory, { recursive: true });

// MapLibre's worker imports its sibling shared module at runtime. Next serves
// both from public so neither Turbopack nor webpack rewrites that relationship.
await Promise.all(
  ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'].map((fileName) =>
    copyFile(path.join(maplibreDirectory, 'dist', fileName), path.join(publicMapDirectory, fileName)),
  ),
);
