#!/usr/bin/env node
/**
 * OpenAPI Specification Generator Script
 *
 * Run this script to generate the OpenAPI specification file.
 * This is typically run as part of the build process or CI pipeline.
 *
 * Usage:
 *   vp exec tsx scripts/generate-openapi.ts
 *
 * Output:
 *   public/openapi.json
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadWebLocalEnvironment } from './load-local-env';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname, '..');
const outputPath = join(__dirname, '../public/openapi.json');

async function main(): Promise<void> {
  // Bun used to load .env.local implicitly for this package script. Node does
  // not, so preserve that contract explicitly before importing code that reads
  // process.env at module evaluation or generation time. Deploy-time values win.
  loadWebLocalEnvironment(webRoot);
  const { generateOpenApiDocument } = await import('../app/lib/api-docs/generate-openapi');

  console.info('Generating OpenAPI specification...');

  const spec = generateOpenApiDocument();

  // Ensure public directory exists
  mkdirSync(dirname(outputPath), { recursive: true });

  // Write the spec to file
  writeFileSync(outputPath, JSON.stringify(spec, null, 2));

  console.info(`OpenAPI specification written to: ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
