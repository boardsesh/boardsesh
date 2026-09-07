/**
 * Load the Climb2Vec similarity export (per-climb cosine top-K neighbours, JSONL
 * from ml/climb2vec/similarity_export.py) into board_climb_similar. Identified
 * combined artifacts are filtered by their own boardType; incumbent untyped
 * artifacts remain accepted when --board and --model are both explicit. The
 * selected board is rebuilt atomically.
 *
 * Run: `node --import tsx packages/db/scripts/load-similarity.ts \
 *        --board=kilter --model=climb2vec-v1 \
 *        --in=ml/climb2vec/data/kilter-similar.jsonl`
 * Flags: --board=<name> (default kilter) · --in=<path> · --model=<version>.
 */
import { eq } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { boardClimbSimilar } from '../src/schema/app/climb-similar.js';
import {
  assertUnchangedSimilaritySelection,
  inspectSimilarityArtifact,
  readSimilarityArtifact,
  similarityArtifactKey,
} from './load-similarity-records.js';

const DEFAULT_IN = 'ml/climb2vec/data/kilter-similar.jsonl';
const DEFAULT_MODEL = 'climb2vec-v1';
const INSERT_CHUNK = 5000;

type Row = typeof boardClimbSimilar.$inferInsert;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined =>
    argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
  const boardArgument = get('--board');
  const modelArgument = get('--model');
  const board = boardArgument ?? 'kilter';
  const inPath = get('--in') ?? DEFAULT_IN;
  const modelVersion = modelArgument ?? DEFAULT_MODEL;

  console.log(`[load-similarity] board=${board} model=${modelVersion} ← ${inPath}`);
  const identity = {
    boardType: board,
    modelVersion,
    allowLegacy: boardArgument !== undefined && modelArgument !== undefined,
  };
  const artifact = await inspectSimilarityArtifact(inPath, identity);
  console.log(
    `[load-similarity] validated ${artifact.artifactRows} ${artifact.mode} artifact rows; ` +
      `selected ${artifact.selectedRows} for ${board}.`,
  );

  const { db, close } = createScriptDb();
  try {
    const total = await db.transaction(async (transaction) => {
      await transaction.delete(boardClimbSimilar).where(eq(boardClimbSimilar.boardType, board));
      let batch: Row[] = [];
      let inserted = 0;
      const loadedKeys = new Set<string>();
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        await transaction.insert(boardClimbSimilar).values(batch);
        inserted += batch.length;
        batch = [];
      };

      for await (const { record } of readSimilarityArtifact(inPath, identity)) {
        if (record.boardType !== board) continue;
        loadedKeys.add(similarityArtifactKey(record.climbUuid, record.angle));
        record.neighbours.forEach(([neighborUuid, score], index) => {
          batch.push({
            boardType: record.boardType,
            climbUuid: record.climbUuid,
            angle: record.angle,
            neighborUuid,
            score,
            rank: index + 1,
            modelVersion: record.modelVersion,
          });
        });
        if (batch.length >= INSERT_CHUNK) await flush();
      }
      await flush();
      assertUnchangedSimilaritySelection(artifact.keys, loadedKeys);
      return inserted;
    });
    console.log(`[load-similarity] rebuilt ${board} with ${total} neighbour rows.`);
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error('[load-similarity] failed:', error);
  process.exit(1);
});
