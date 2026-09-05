/** Repair existing catalog rules. Defaults to a read-only transaction; --apply opts into writes. */
import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, isNull } from 'drizzle-orm';
import { applyWoodsRuleUpdates } from '../src/queries/climbs/woods-rule-repair.js';
import { boardClimbs } from '../src/schema/boards/unified.js';
import { parseWoodsCatalogFile } from './woods-catalog-helpers.js';
import { buildWoodsRuleCatalog, planWoodsRuleRepair, parseWoodsRuleRepairArgs } from './woods-rule-repair.js';
import { describeDatabaseHost, getScriptDatabaseUrl } from './db-connection.js';
import { assertWoodsImportAllowed } from './woods-import-guard.js';

async function main() {
  const { directory, apply } = parseWoodsRuleRepairArgs(process.argv.slice(2), process.env.WOODS_CATALOG_DIR);
  const catalogDir = path.resolve(process.env.INIT_CWD ?? process.cwd(), directory);
  const catalogs = ['8x10', '12x12'].map((dimension) => {
    const fileName = `woodsboard_${dimension}.json`;
    const catalog = parseWoodsCatalogFile(fs.readFileSync(path.join(catalogDir, fileName), 'utf8'), fileName);
    if (catalog.boardDimension !== dimension || catalog.problems.length === 0) {
      throw new Error(`Catalog ${fileName} has an incorrect size or no problems`);
    }
    return catalog;
  });
  const catalog = buildWoodsRuleCatalog(catalogs);
  const databaseUrl = getScriptDatabaseUrl();
  console.info(`Woods rules ${apply ? 'apply' : 'dry-run'}: ${describeDatabaseHost(databaseUrl)}`);
  if (apply) assertWoodsImportAllowed(databaseUrl, 'repair-woods-rules.ts');
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 15 });
  const db = drizzle(client);
  try {
    await db.transaction(
      async (transaction) => {
        const stored = await transaction
          .select({
            uuid: boardClimbs.uuid,
            boardType: boardClimbs.boardType,
            userId: boardClimbs.userId,
            frames: boardClimbs.frames,
            compatibleSizeIds: boardClimbs.compatibleSizeIds,
            characteristics: boardClimbs.characteristics,
          })
          .from(boardClimbs)
          .where(and(eq(boardClimbs.boardType, 'woods'), isNull(boardClimbs.userId)));
        const { updates, ...counts } = planWoodsRuleRepair(catalog, stored);
        console.info(
          JSON.stringify({
            mode: apply ? 'apply' : 'dry-run',
            catalogClimbs: catalog.size,
            ...counts,
            updates: updates.length,
          }),
        );
        if (!apply) return;
        await applyWoodsRuleUpdates(transaction, updates);
      },
      { accessMode: apply ? 'read write' : 'read only', isolationLevel: 'repeatable read' },
    );
  } finally {
    await client.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
