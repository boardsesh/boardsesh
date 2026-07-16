/**
 * Load a Climb2Vec artifact into board_climb_embeddings. Identified Stage-3
 * artifacts can combine boards and atomically replace one complete board.
 * Incumbent untyped climb2vec-v1 artifacts retain their original upsert-only
 * behavior when --board and --model are both explicit.
 *
 * Run: `node --import tsx packages/db/scripts/load-content-model.ts \
 *        --board=kilter --model=climb2vec-v1 \
 *        --in=ml/climb2vec/data/kilter-content.jsonl`
 * Flags: --board=<name> (default kilter) · --in=<path> · --model=<version>.
 */
import { createScriptDb } from './db-connection.js';
import { boardClimbEmbeddings } from '../src/schema/app/climb-embeddings.js';
import { eq, sql } from 'drizzle-orm';
import { moonBoardPlacementCoverageSql } from '../src/queries/climbs/placement-match.js';
import { rowsOf } from '../src/queries/util/rows.js';
import {
  assertCompleteArtifactCoverage,
  contentArtifactKey,
  inspectContentArtifact,
  readContentArtifact,
  type EligibleContentCell,
} from './load-content-model-records.js';

const DEFAULT_IN = 'ml/climb2vec/data/kilter-content.jsonl';
const DEFAULT_MODEL = 'climb2vec-v1';
const UPSERT_CHUNK = 500;

type Row = typeof boardClimbEmbeddings.$inferInsert;
type Db = ReturnType<typeof createScriptDb>['db'];

async function upsertLegacyRows(db: Db, rows: Row[]): Promise<void> {
  await db
    .insert(boardClimbEmbeddings)
    .values(rows)
    .onConflictDoUpdate({
      target: [boardClimbEmbeddings.boardType, boardClimbEmbeddings.climbUuid, boardClimbEmbeddings.angle],
      set: {
        contentPrior: sql`excluded.content_prior`,
        contentSd: sql`excluded.content_sd`,
        embedding: sql`excluded.embedding`,
        modelVersion: sql`excluded.model_version`,
        updatedAt: sql`now()`,
      },
    });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined =>
    argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
  const boardArgument = get('--board');
  const modelArgument = get('--model');
  const board = boardArgument ?? 'kilter';
  const inPath = get('--in') ?? DEFAULT_IN;
  const modelVersion = modelArgument ?? DEFAULT_MODEL;

  console.log(`[load-content] board=${board} model=${modelVersion} ← ${inPath}`);

  // Validate the complete artifact before opening the database. The second pass
  // is validated again inside the transaction, so a read/parse failure can only
  // roll the rebuild back; it can never leave a partially replaced board.
  const identity = {
    boardType: board,
    modelVersion,
    allowLegacy: boardArgument !== undefined && modelArgument !== undefined,
  };
  const artifact = await inspectContentArtifact(inPath, identity);
  console.log(
    `[load-content] validated ${artifact.artifactRows} ${artifact.mode} artifact rows; selected ` +
      `${artifact.selectedRows} for ${board} ` +
      `(${artifact.supported} supported, ${artifact.unsupported} unsupported).`,
  );

  const { db, close } = createScriptDb();
  try {
    if (artifact.mode === 'legacy') {
      let batch: Row[] = [];
      let total = 0;
      for await (const { record } of readContentArtifact(inPath, identity)) {
        batch.push({
          boardType: record.boardType,
          climbUuid: record.climbUuid,
          angle: record.angle,
          contentPrior: record.contentPrior,
          contentSd: record.contentSd,
          embedding: record.embedding,
          modelVersion: record.modelVersion,
        });
        if (batch.length >= UPSERT_CHUNK) {
          await upsertLegacyRows(db, batch);
          total += batch.length;
          batch = [];
        }
      }
      if (batch.length > 0) {
        await upsertLegacyRows(db, batch);
        total += batch.length;
      }
      console.log(`[load-content] legacy upserted ${total} ${board} rows; existing omitted rows were preserved.`);
      return;
    }

    const counts = await db.transaction(
      async (transaction) => {
        const placementCoverage = moonBoardPlacementCoverageSql({
          boardType: sql.raw('climb.board_type'),
          climbUuid: sql.raw('climb.uuid'),
          layoutId: sql.raw('climb.layout_id'),
        });
        const eligibleCells = rowsOf<{ climb_uuid: string; angle: number }>(
          await transaction.execute(sql`
            SELECT stat.climb_uuid, stat.angle
            FROM board_climb_stats stat
            JOIN board_climbs climb
              ON climb.board_type = stat.board_type
             AND climb.uuid = stat.climb_uuid
            WHERE stat.board_type = ${board}
              AND climb.is_listed = true
              AND COALESCE(climb.is_draft, false) = false
              AND ${placementCoverage}
            ORDER BY stat.climb_uuid, stat.angle
          `),
        ).map(
          (cell): EligibleContentCell => ({
            climbUuid: cell.climb_uuid,
            angle: Number(cell.angle),
          }),
        );
        assertCompleteArtifactCoverage(artifact.keys, eligibleCells);

        await transaction.delete(boardClimbEmbeddings).where(eq(boardClimbEmbeddings.boardType, board));
        let batch: Row[] = [];
        let supported = 0;
        let unsupported = 0;
        let total = 0;
        const insertedKeys = new Set<string>();

        const flush = async (): Promise<void> => {
          if (batch.length === 0) return;
          await transaction.insert(boardClimbEmbeddings).values(batch);
          total += batch.length;
          batch = [];
        };

        for await (const { record } of readContentArtifact(inPath, identity)) {
          if (record.boardType !== board) continue;
          insertedKeys.add(contentArtifactKey(record.climbUuid, record.angle));
          batch.push({
            boardType: record.boardType,
            climbUuid: record.climbUuid,
            angle: record.angle,
            contentPrior: record.contentPrior,
            contentSd: record.contentSd,
            embedding: record.embedding,
            modelVersion: record.modelVersion,
          });
          if (record.supported) supported += 1;
          else unsupported += 1;
          if (batch.length >= UPSERT_CHUNK) await flush();
        }
        await flush();
        // Close the validation/write TOCTOU window: if the local artifact
        // changed after the preflight pass, this throws and rolls the complete
        // delete+insert transaction back before readers can observe it.
        assertCompleteArtifactCoverage(insertedKeys, eligibleCells);
        return { total, supported, unsupported };
      },
      { isolationLevel: 'repeatable read' },
    );
    console.log(
      `[load-content] rebuilt ${board}: ${counts.total} rows ` +
        `(${counts.supported} supported, ${counts.unsupported} unsupported).`,
    );
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error('[load-content] failed:', error);
  process.exit(1);
});
