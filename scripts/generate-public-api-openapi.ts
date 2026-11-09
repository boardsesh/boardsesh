/// <reference types="node" />

/**
 * Generate the committed OpenAPI document for the public /v1 API.
 *
 * Usage:
 *   vp run generate:public-api-openapi   # write the document
 *   vp run check:public-api-openapi      # fail if the committed document is stale
 *
 * Committed so a change to the public contract shows up in review as a JSON diff.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { renderPublicApiDocument } from '../packages/shared/public-api/src/document';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

export const OPENAPI_DOCUMENT_FILE = 'packages/shared/public-api/src/generated/openapi.json';

function main(): void {
  const documentPath = path.join(REPO_ROOT, OPENAPI_DOCUMENT_FILE);
  const rendered = renderPublicApiDocument();

  if (process.argv.includes('--check')) {
    if (existsSync(documentPath) && readFileSync(documentPath, 'utf8') === rendered) {
      console.log(`${OPENAPI_DOCUMENT_FILE} is up to date.`);
      return;
    }
    console.error(
      `${OPENAPI_DOCUMENT_FILE} is out of date.\n  run \`vp run generate:public-api-openapi\` and commit the result.`,
    );
    process.exitCode = 1;
    return;
  }

  writeFileSync(documentPath, rendered);
  console.log(`Wrote ${OPENAPI_DOCUMENT_FILE}.`);
}

main();
