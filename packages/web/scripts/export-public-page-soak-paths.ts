/** Export real public fixture paths; never connect this helper to a deployment database. */
import { writeFile } from 'node:fs/promises';
import { and, asc, eq, gte, isNotNull, ne, notExists, sql } from 'drizzle-orm';
import { closePool, createDb } from '@boardsesh/db/client';
import { boardClimbAliases, boardClimbs, boardClimbStats } from '@boardsesh/db/schema';
import { getDefaultRenderBoard } from '@boardsesh/board-config/resolve-render-board';
import { tryBuildReadableClimbViewPath } from '@boardsesh/play-view/readable-url-utils';

async function main() {
  const output = process.argv[2];
  if (!output) throw new Error('Pass the output JSON path');
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the isolated seeded fixture');
  for (const variable of ['DATABASE_URL', 'WEB_DATABASE_URL', 'READ_REPLICA_URL']) {
    const configured = process.env[variable];
    if (configured && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(configured).hostname)) {
      throw new Error(`${variable} must point to a loopback fixture`);
    }
  }

  const database = createDb();
  try {
    const climbs = await database.transaction(
      async (transaction) => {
        await transaction.execute(sql`set local statement_timeout = '60s'`);
        return transaction
          .select({
            uuid: boardClimbs.uuid,
            name: boardClimbs.name,
            layoutId: boardClimbs.layoutId,
            requiredSetIds: boardClimbs.requiredSetIds,
          })
          .from(boardClimbs)
          .innerJoin(
            boardClimbStats,
            and(eq(boardClimbStats.boardType, boardClimbs.boardType), eq(boardClimbStats.climbUuid, boardClimbs.uuid)),
          )
          .where(
            and(
              eq(boardClimbs.boardType, 'moonboard'),
              eq(boardClimbs.isListed, true),
              eq(boardClimbs.isDraft, false),
              eq(boardClimbs.isHidden, false),
              isNotNull(boardClimbs.name),
              ne(boardClimbs.name, ''),
              eq(boardClimbStats.angle, 40),
              gte(boardClimbStats.ascensionistCount, 1),
              notExists(
                transaction
                  .select({ uuid: boardClimbAliases.aliasUuid })
                  .from(boardClimbAliases)
                  .where(
                    and(
                      eq(boardClimbAliases.boardType, boardClimbs.boardType),
                      eq(boardClimbAliases.aliasUuid, boardClimbs.uuid),
                      ne(boardClimbAliases.aliasUuid, boardClimbAliases.canonicalUuid),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(asc(boardClimbs.uuid))
          .limit(10_000);
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    const paths = new Set<string>();
    for (const climb of climbs) {
      const config = getDefaultRenderBoard('moonboard', climb.layoutId);
      if (!config || !(climb.requiredSetIds ?? []).every((setId) => config.setIds.includes(setId))) continue;
      const path = tryBuildReadableClimbViewPath({
        boardName: 'moonboard',
        ...config,
        setIds: config.setIds.join(','),
        angle: 40,
        climbUuid: climb.uuid,
        climbName: climb.name ?? undefined,
      });
      if (path) paths.add(path);
      if (paths.size === 5_000) break;
    }
    if (paths.size < 5_000) throw new Error(`Expected 5,000 public fixture paths, found ${paths.size}`);
    await writeFile(output, JSON.stringify([...paths]));
    console.info(`Exported ${paths.size} distinct canonical MoonBoard fixture paths`);
  } finally {
    await closePool();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
