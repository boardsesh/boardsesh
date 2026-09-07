import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { applyMoonBoardBetaLinks } from '../src/moonboard/beta.js';
import { getScriptDatabaseUrl } from './db-connection.js';
const VALUE_FLAGS = new Set<string>();
const BOOLEAN_FLAGS = new Set(['--dry-run']);
export type BetaLinksCliArgs = { positional: string[]; dryRun: boolean };

/**
 * Parse argv, rejecting anything unrecognised — a silently-ignored `-dry-run`
 * would commit a rehearsal to production. Mirrors the catalog importer.
 */
export function parseBetaLinksCliArgs(argv: string[]): BetaLinksCliArgs {
  const positional: string[] = [];
  let dryRun = false;

  for (const arg of argv) {
    // `vp run ... -- --dry-run` forwards the separator verbatim.
    if (arg === '--') continue;
    if (BOOLEAN_FLAGS.has(arg)) {
      dryRun = true;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) throw new Error(`${arg} needs a value`);
    if (arg.startsWith('-')) throw new Error(`Unknown flag: ${arg}`);
    positional.push(arg);
  }

  return { positional, dryRun };
}

async function main() {
  const args = parseBetaLinksCliArgs(process.argv.slice(2));
  if (!args.positional[0]) throw new Error('Provide the beta-video JSON path');
  const file = JSON.parse(fs.readFileSync(args.positional[0], 'utf8'));
  const client = postgres(getScriptDatabaseUrl(), { max: 1 });
  try {
    console.info(JSON.stringify(await applyMoonBoardBetaLinks(client, file, { dryRun: args.dryRun })));
  } finally {
    await client.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
