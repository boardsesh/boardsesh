import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { applyMoonBoardCatalog } from '../src/moonboard/catalog.js';
import { getScriptDatabaseUrl } from './db-connection.js';
const VALUE_FLAGS = new Set(['--holdsetup']);
const BOOLEAN_FLAGS = new Set(['--dry-run']);
export type CatalogCliArgs = { positional: string[]; holdsetup?: number; dryRun: boolean };

/**
 * Parse argv, rejecting anything unrecognised.
 *
 * Failing closed on an unknown flag is the whole point: a typo'd `-dry-run`
 * (one dash) or `--dryrun` would otherwise be silently ignored and the
 * rehearsal would commit to production instead.
 */
export function parseCatalogCliArgs(argv: string[]): CatalogCliArgs {
  const positional: string[] = [];
  let holdsetup: number | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      // `vp run '@boardsesh/db#db:import-moonboard-catalog' -- --dry-run`
      // forwards the separator verbatim, so skip it rather than rejecting it as
      // an unknown flag. Both invocation styles then work.
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg)) {
      dryRun = true;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) throw new Error(`${arg} needs an integer, got "${value}"`);
      holdsetup = parsed;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown flag: ${arg}`);
    positional.push(arg);
  }

  return { positional, holdsetup, dryRun };
}

async function main() {
  const args = parseCatalogCliArgs(process.argv.slice(2));
  const directory = args.positional[0] ?? fileURLToPath(new URL('../data/moonboard/app-catalog', import.meta.url));
  const client = postgres(getScriptDatabaseUrl(), { max: 1 });
  try {
    for (const file of fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .sort()) {
      const catalog = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
      if (!Array.isArray(catalog.problems)) continue;
      if (args.holdsetup !== undefined && catalog.holdsetup !== args.holdsetup) continue;
      const counters = await applyMoonBoardCatalog(client, catalog, { dryRun: args.dryRun });
      console.info(JSON.stringify({ holdsetup: catalog.holdsetup, dryRun: args.dryRun, counters }));
    }
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
