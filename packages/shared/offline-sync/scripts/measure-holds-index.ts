// Measures what the device-derived holds index costs on a real board — bytes on
// disk, WAL written, build time, and the similar-climbs candidate query — against
// a published snapshot artifact loaded into node:sqlite with the real migrations
// and the real parser.
//
// Usage (from the repo root):
//   node --import tsx packages/shared/offline-sync/scripts/measure-holds-index.ts --artifact <file.db | file.db.gz>
//   node --import tsx packages/shared/offline-sync/scripts/measure-holds-index.ts \
//     --manifest-url <.../manifest.json> --board kilter --layout 1 [--download-dir <dir>]
//
// Optional: --size <id> measures one size scope instead of the layout's largest,
// and --all-sizes builds every size scope of the layout one after another (the
// cost of a climber downloading every size; shared climbs are derived once).
//
// Work files go under os.tmpdir(); on the dev box TMPDIR is ~/.cache/claude-tmp,
// which is disk, not the /tmp RAM disk. Nothing here writes to the artifact.

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { parseArgs } from 'node:util';
// A relative import on purpose: @boardsesh/offline-sync keeps zero runtime deps
// (the parser is injected), and this script should not add a workspace devDep.
import { HOLD_STATE_MAP, parseFramesToHoldRows } from '../../../board-constants/src/hold-states';
import type { BoardName } from '@boardsesh/shared-schema';
import { runMigrations } from '../src/db/migrations';
import { configureMainConnection } from '../src/db/pragmas';
import { markScopeDownloadComplete } from '../src/sync/checkpoints';
import { parseSnapshotManifest } from '../src/sync/snapshot-manifest';
import { ensureHoldIndex, type HoldRowParser } from '../src/holds-index/hold-index';
import { decodeHoldSetIds, findSimilarClimbCandidates, HOLD_SET_ENTRY_BYTES } from '../src/holds-index/query';
import { offlineBoardKey, type OfflineBoardScope } from '../src/offline-board-key';
import { createTestDatabase, type TestSqliteDb } from '../src/testing/sqlite-test-db';

const parseHoldRows: HoldRowParser = (boardType, frames) =>
  Object.prototype.hasOwnProperty.call(HOLD_STATE_MAP, boardType)
    ? parseFramesToHoldRows(boardType as BoardName, frames)
    : [];

const { values: args } = parseArgs({
  options: {
    artifact: { type: 'string' },
    'manifest-url': { type: 'string' },
    board: { type: 'string' },
    layout: { type: 'string' },
    size: { type: 'string' },
    'all-sizes': { type: 'boolean', default: false },
    'download-dir': { type: 'string' },
  },
});

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function isGzip(path: string): Promise<boolean> {
  const stream = createReadStream(path, { start: 0, end: 1 });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const head = Buffer.concat(chunks);
  return head[0] === 0x1f && head[1] === 0x8b;
}

async function resolveArtifactPath(workDir: string): Promise<string> {
  if (args.artifact) return args.artifact;
  const manifestUrl = args['manifest-url'];
  if (!manifestUrl || !args.board || !args.layout) {
    throw new Error('Pass --artifact <path>, or --manifest-url with --board and --layout.');
  }
  const manifest = parseSnapshotManifest(await (await fetch(manifestUrl)).json());
  if (!manifest) throw new Error(`Unreadable manifest at ${manifestUrl}`);
  const entry = manifest.entries.find(
    (candidate) => candidate.boardType === args.board && candidate.layoutId === Number(args.layout),
  );
  if (!entry) throw new Error(`No manifest entry for ${args.board}:${args.layout}`);
  const downloadDir = args['download-dir'] ?? workDir;
  mkdirSync(downloadDir, { recursive: true });
  const target = join(downloadDir, basename(entry.key));
  if (!existsSync(target)) {
    console.log(`Downloading ${entry.url} (${megabytes(entry.bytes)})`);
    const response = await fetch(entry.url);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    // Buffered, not streamed: a few hundred MB at most, and it keeps DOM and
    // Node stream typings out of each other's way.
    writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  }
  return target;
}

async function decodedArtifact(path: string, workDir: string): Promise<string> {
  if (!(await isGzip(path))) return path;
  const target = join(workDir, 'artifact.db');
  await pipeline(createReadStream(path), createGunzip(), createWriteStream(target));
  return target;
}

async function databaseBytes(db: TestSqliteDb): Promise<number> {
  const pageCount = await db.getFirstAsync<{ page_count: number }>('PRAGMA page_count');
  const pageSize = await db.getFirstAsync<{ page_size: number }>('PRAGMA page_size');
  return (pageCount?.page_count ?? 0) * (pageSize?.page_size ?? 0);
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), 'measure-holds-index-'));
  try {
    const artifactPath = await decodedArtifact(await resolveArtifactPath(workDir), workDir);
    console.log(`Artifact: ${artifactPath} (${megabytes(statSync(artifactPath).size)} decoded)`);

    const db = createTestDatabase(join(workDir, 'device.db'));
    // WAL, like the app's main connection: the builder reads on this connection
    // while each chunk writes on its own, exactly as expo-sqlite does.
    await configureMainConnection(db);
    await runMigrations(db);

    // Import the artifact's climbs the way a device holds them: every column the
    // two schemas share. Stats are imported too so "before" is a real device DB.
    await db.execAsync(`ATTACH DATABASE '${artifactPath.replaceAll("'", "''")}' AS artifact`);
    for (const table of ['board_climbs', 'board_climb_stats']) {
      const local = await db.getAllAsync<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`);
      const remote = await db.getAllAsync<{ name: string }>(
        `SELECT name FROM pragma_table_info('${table}', 'artifact')`,
      );
      const remoteNames = new Set(remote.map((column) => column.name));
      const columns = local.map((column) => column.name).filter((name) => remoteNames.has(name));
      await db.execAsync(
        `INSERT INTO main.${table} (${columns.join(', ')}) SELECT ${columns.join(', ')} FROM artifact.${table}`,
      );
    }
    await db.execAsync('DETACH DATABASE artifact');
    await db.execAsync('VACUUM');

    const layout = await db.getFirstAsync<{ board_type: string; layout_id: number; climbs: number }>(
      'SELECT board_type, layout_id, COUNT(*) AS climbs FROM board_climbs GROUP BY board_type, layout_id ORDER BY climbs DESC LIMIT 1',
    );
    if (!layout) throw new Error('The artifact has no climbs.');
    const listed = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM board_climbs WHERE is_listed = 1 AND is_draft = 0 AND COALESCE(is_hidden, 0) = 0',
    );

    const sizeCounts = await db.getAllAsync<{ size_id: number; climbs: number }>(
      `SELECT CAST(sizes.value AS INTEGER) AS size_id, COUNT(*) AS climbs
       FROM board_climbs, json_each(board_climbs.compatible_size_ids) AS sizes
       WHERE board_climbs.compatible_size_ids IS NOT NULL
       GROUP BY size_id ORDER BY climbs DESC`,
    );
    const sizeScoped = layout.board_type !== 'moonboard';
    let sizeIds: number[];
    if (!sizeScoped) sizeIds = [1];
    else if (args.size) sizeIds = [Number(args.size)];
    else if (args['all-sizes']) sizeIds = sizeCounts.map((row) => row.size_id);
    else sizeIds = sizeCounts.length > 0 ? [sizeCounts[0].size_id] : [];

    console.log(
      `Layout ${layout.board_type}:${layout.layout_id}: ${layout.climbs} climbs, ${listed?.n ?? 0} listed + published + visible`,
    );
    if (sizeScoped) {
      console.log(`Sizes by climb count: ${sizeCounts.map((row) => `${row.size_id}=${row.climbs}`).join(', ')}`);
    }

    const bytesBefore = await databaseBytes(db);
    console.log(`Database before the index: ${megabytes(bytesBefore)}`);

    // WAL accounting. Each write transaction runs on its own connection, as on
    // the device. Checkpoints are switched off for the build and the WAL starts
    // empty, so the file only grows: each commit's growth is the pages it
    // appended, and the sum is everything the build wrote to the WAL.
    const devicePath = join(workDir, 'device.db');
    await db.execAsync('PRAGMA wal_autocheckpoint = 0');
    await db.getFirstAsync('PRAGMA wal_checkpoint(TRUNCATE)');
    let walBytes = 0;
    let largestCommitWalBytes = 0;
    db.withExclusiveTransactionAsync = async (task) => {
      const connection = createTestDatabase(devicePath);
      try {
        await connection.execAsync('PRAGMA wal_autocheckpoint = 0');
        const walPath = `${devicePath}-wal`;
        const walBefore = existsSync(walPath) ? statSync(walPath).size : 0;
        await connection.execAsync('BEGIN');
        try {
          await task(connection);
          await connection.execAsync('COMMIT');
        } catch (error) {
          await connection.execAsync('ROLLBACK');
          throw error;
        }
        const commitWalBytes = Math.max(0, (existsSync(walPath) ? statSync(walPath).size : 0) - walBefore);
        walBytes += commitWalBytes;
        largestCommitWalBytes = Math.max(largestCommitWalBytes, commitWalBytes);
      } finally {
        connection.close();
      }
    };

    const startedAll = performance.now();
    const cpuBefore = process.cpuUsage();
    for (const sizeId of sizeIds) {
      const scope: OfflineBoardScope = { boardType: layout.board_type, layoutId: layout.layout_id, sizeId };
      await markScopeDownloadComplete(db, offlineBoardKey(scope));
      const started = performance.now();
      const result = await ensureHoldIndex(db, scope, { parseHoldRows });
      const seconds = (performance.now() - started) / 1000;
      console.log(
        `  scope ${offlineBoardKey(scope)}: ${result.status}, ${result.climbsProcessed} climbs read, ` +
          `${result.holdSetsWritten} hold sets, ${result.postingsWritten} postings, ${result.chunks} chunks, ${seconds.toFixed(1)} s`,
      );
    }
    const totalSeconds = (performance.now() - startedAll) / 1000;
    const cpu = process.cpuUsage(cpuBefore);
    const cpuSeconds = (cpu.user + cpu.system) / 1e6;

    const holdSets = await db.getFirstAsync<{ n: number; holds: number; bytes: number }>(
      'SELECT COUNT(*) AS n, SUM(length(holds)) / 5 AS holds, SUM(length(holds)) AS bytes FROM board_climb_hold_sets',
    );
    const postings = await db.getFirstAsync<{ n: number; bytes: number }>(
      'SELECT COUNT(*) AS n, SUM(length(climb_ids)) AS bytes FROM board_climb_hold_postings',
    );
    // Deletes during a build leave free pages; VACUUM so "after" is what a
    // steady-state device file holds, not build scratch.
    await db.execAsync('VACUUM');
    const bytesAfter = await databaseBytes(db);

    console.log('');
    console.log(
      `Hold sets:                  ${holdSets?.n ?? 0} climbs, ${holdSets?.holds ?? 0} holds ` +
        `(${((holdSets?.holds ?? 0) / Math.max(holdSets?.n ?? 0, 1)).toFixed(1)} per climb), ${megabytes(holdSets?.bytes ?? 0)} of blobs`,
    );
    console.log(`Postings:                   ${postings?.n ?? 0} holds, ${megabytes(postings?.bytes ?? 0)} of blobs`);
    console.log(`Database after the index:   ${megabytes(bytesAfter)}`);
    console.log(`Index cost on disk:         ${megabytes(bytesAfter - bytesBefore)}`);
    // Wall time on a slow-fsync disk is mostly I/O wait; CPU time is the part
    // that transfers to another machine.
    console.log(`Build wall time (this box): ${totalSeconds.toFixed(1)} s`);
    console.log(`Build CPU time:             ${cpuSeconds.toFixed(1)} s`);
    console.log(
      `WAL appended by the build:  ${megabytes(walBytes)} (largest single commit ${megabytes(largestCommitWalBytes)})`,
    );

    // The similar-climbs candidate query, for a typical climb and a busy one.
    for (const holdCount of [13, 40]) {
      const target = await db.getFirstAsync<{ uuid: string; holds: Uint8Array }>(
        `SELECT hic.uuid, hs.holds FROM board_climb_hold_sets hs JOIN holds_index_climbs hic ON hic.id = hs.climb_id
         WHERE length(hs.holds) >= ? ORDER BY length(hs.holds), hs.climb_id LIMIT 1`,
        [holdCount * HOLD_SET_ENTRY_BYTES],
      );
      if (!target) continue;
      const targetHoldIds = [...decodeHoldSetIds(target.holds)];
      const looser = await findSimilarClimbCandidates(db, {
        boardType: layout.board_type,
        layoutId: layout.layout_id,
        targetHoldIds,
        threshold: 0.3,
        excludeUuid: target.uuid,
        limit: 1000,
      });
      const timings: number[] = [];
      let candidates = 0;
      for (let run = 0; run < 5; run += 1) {
        const started = performance.now();
        const found = await findSimilarClimbCandidates(db, {
          boardType: layout.board_type,
          layoutId: layout.layout_id,
          targetHoldIds,
          threshold: 0.5,
          excludeUuid: target.uuid,
          limit: 12,
        });
        timings.push(performance.now() - started);
        candidates = found.length;
      }
      timings.sort((left, right) => left - right);
      console.log(
        `Similar candidates, ${targetHoldIds.length}-hold climb: median ${timings[2].toFixed(1)} ms ` +
          `(slowest of 5 runs ${timings[timings.length - 1].toFixed(1)} ms), ${candidates} at Jaccard ≥ 0.5, ` +
          `${looser.length} at ≥ 0.3`,
      );
    }
    db.close();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

await main();
