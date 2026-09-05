// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { typeDefs } from '../src/schema/index';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', 'src', 'generated', 'schema.graphql');

// Source typeDef chunks are written as 2-space-indented template literals so
// they read naturally inside `.ts` files. Strip the leading indent and trim
// surrounding blank lines so the emitted SDL matches what oxfmt would
// otherwise rewrite, keeping codegen output stable across CI and local
// `vp fmt`.
function normalize(input: string): string {
  return input
    .split('\n')
    .map((line) => (line.startsWith('  ') ? line.slice(2) : line))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${typeDefs.map(normalize).join('\n\n')}\n`, 'utf-8');

console.info(`[print-schema] Wrote SDL to ${outPath}`);
