// The snapshot half of the two-stream sync (issue #6306): what an artifact
// import leaves behind, how the pull carries on from it, and what a device that
// arrives from an earlier bundle, or goes back to one, ends up doing.
//
// An artifact holds a layout's reference rows. Since the privacy work it holds
// nothing with a Boardsesh author, and for a while the import made up for that
// by stamping its cursors at the epoch, so the whole board was crawled again
// behind every import and again after every privacy event. Here the import
// stamps the artifact's real watermark, and the authored rows come through the
// protected stream.
//
// File-backed SQLite throughout: the import ATTACHes the artifact inside an
// exclusive transaction, which only a file-backed double runs the way a phone
// does.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueryInvalidator } from '../../database';
import { runMigrations } from '../../db/migrations';
import { __resetDrainerStateForTests } from '../../mutation-queue/drainer';
import { ensureMutationQueueTable } from '../../mutation-queue/schema';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import {
  getCheckpoint,
  getProtectedCheckpoint,
  isScopeDownloadComplete,
  isScopeProtectedComplete,
} from '../checkpoints';
import { pullSync, type ScopeDownloadCompleteInfo, type SyncOptions } from '../pull-client';
import { getBootstrapDoneMarker } from '../snapshot-bootstrap';
import type { SnapshotManifestEntry } from '../snapshot-manifest';
import {
  buildSnapshotArtifacts,
  createSnapshotSource,
  createTwoStreamBackend,
  cursorAt,
  EPOCH,
  manifestOf,
  olderBundleSetCheckpoint,
  simulateOlderBundleRevalidation,
  simulatePrivacyRevalidation,
  type ServerClimb,
  type TwoStreamBackendOptions,
} from './helpers/two-stream-fixtures';

const SCOPE_KEY = 'kilter:1:12';
const VIEWER = 'viewer';
const CLIMBS_KEY = `checkpoint:board_climbs:${SCOPE_KEY}`;
const STATS_KEY = `checkpoint:board_climb_stats:${SCOPE_KEY}`;
const GRADES_KEY = `checkpoint:board_climb_grades:${SCOPE_KEY}`;

const catalogueClimb = (sequence: number): ServerClimb => ({
  uuid: `catalogue-${sequence}`,
  ownerId: null,
  cursor: cursorAt(sequence),
  stats: { faUsername: 'Manufacturer Setter' },
  grade: true,
});
const ownClimb: ServerClimb = { uuid: 'viewer-own', ownerId: VIEWER, cursor: cursorAt(40), stats: {}, grade: true };
const friendClimb: ServerClimb = {
  uuid: 'friend-climb',
  ownerId: 'friend',
  cursor: cursorAt(41),
  stats: {},
  grade: true,
};

// What the artifact was built from, and one manufacturer climb set since.
const ARTIFACT_CLIMBS = [catalogueClimb(10), catalogueClimb(11), catalogueClimb(50)];
const ARTIFACT_WATERMARK = cursorAt(50);
const newerCatalogueClimb = catalogueClimb(90);
const SERVER_CLIMBS = [...ARTIFACT_CLIMBS, newerCatalogueClimb, ownClimb, friendClimb];
const ALL_CLIMB_UUIDS = SERVER_CLIMBS.map((climb) => climb.uuid).sort();
const REFERENCE_QUERIES = ['syncClimbs', 'syncClimbStats', 'syncClimbGrades'];

let workDirectory: string;
let db: TestSqliteDb;
let queryClient: QueryInvalidator;
let layoutPath: string;
let gradesPath: string;
let artifactEntry: SnapshotManifestEntry;

beforeEach(async () => {
  workDirectory = mkdtempSync(join(tmpdir(), 'two-stream-import-'));
  db = createTestDatabase(join(workDirectory, 'client.db'));
  await runMigrations(db);
  await ensureMutationQueueTable(db);
  queryClient = { invalidateQueries: vi.fn() };
  __resetDrainerStateForTests();
  layoutPath = join(workDirectory, 'kilter-1.db');
  gradesPath = join(workDirectory, 'kilter-1-grades.db');
  artifactEntry = await buildSnapshotArtifacts({
    layoutPath,
    gradesPath,
    climbs: SERVER_CLIMBS.filter((climb) => climb !== newerCatalogueClimb),
  });
});

afterEach(() => {
  __resetDrainerStateForTests();
  db.close();
  rmSync(workDirectory, { recursive: true, force: true });
});

const localClimbs = async (): Promise<string[]> =>
  (await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM board_climbs ORDER BY uuid')).map((row) => row.uuid);
const localGrades = async (): Promise<string[]> =>
  (await db.getAllAsync<{ climb_uuid: string }>('SELECT climb_uuid FROM board_climb_grades ORDER BY climb_uuid')).map(
    (row) => row.climb_uuid,
  );

function backend(
  climbs: ServerClimb[] | (() => ServerClimb[]) = SERVER_CLIMBS,
  extra: Partial<TwoStreamBackendOptions> = {},
) {
  return createTwoStreamBackend({ climbs: typeof climbs === 'function' ? climbs : () => climbs, ...extra });
}

/** A source that publishes the format-2 manifest listing the two artifacts. */
const formatTwoSource = (extra: Partial<Parameters<typeof createSnapshotSource>[0]> = {}) =>
  createSnapshotSource({ manifest: () => manifestOf([artifactEntry]), layoutPath, gradesPath, ...extra });

const sync = (fetch: ReturnType<typeof backend>['fetch'], options: SyncOptions = {}) =>
  pullSync(db, queryClient, fetch, { enabledBoards: [SCOPE_KEY], ...options });

describe('downloading a board from a snapshot', () => {
  it('stamps the artifact’s real watermark and pulls only what the artifact does not hold', async () => {
    const server = backend();
    const snapshot = formatTwoSource();
    const completions: ScopeDownloadCompleteInfo[] = [];

    await sync(server.fetch, {
      snapshotSource: snapshot.source,
      onScopeDownloadComplete: (info) => completions.push(info),
    });

    expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(1);
    expect(snapshot.downloadGradesArtifact).toHaveBeenCalledTimes(1);
    // Every reference stream was asked ONCE, from the artifact's watermark. This
    // is the request that used to start at the epoch and page the whole board.
    for (const queryName of REFERENCE_QUERIES) {
      expect(server.requestsFor(queryName, 'REFERENCE').map((request) => request.cursor)).toEqual([ARTIFACT_WATERMARK]);
    }
    // The authored rows are not in the artifact: they come from the epoch.
    expect(server.requestsFor('syncClimbs', 'PROTECTED').map((request) => request.cursor)).toEqual([undefined]);
    expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
    expect(await localGrades()).toEqual(ALL_CLIMB_UUIDS);
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(newerCatalogueClimb.cursor);
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
    expect(await isScopeProtectedComplete(db, SCOPE_KEY)).toBe(true);
    expect(await getBootstrapDoneMarker(db, SCOPE_KEY)).toBe('2');
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ method: 'snapshot', audienceMode: 'split' });
    expect(completions[0].phases.protectedRows).toBe(6);
  });

  it('settles: the cycles that follow import nothing and start no stream over', async () => {
    const server = backend();
    const snapshot = formatTwoSource();
    const options = { snapshotSource: snapshot.source };
    await sync(server.fetch, options);
    server.requests.length = 0;

    await sync(server.fetch, options);
    await sync(server.fetch, options);

    expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(1);
    expect(snapshot.downloadGradesArtifact).toHaveBeenCalledTimes(1);
    expect(server.requestsFor().every((request) => request.cursor !== undefined)).toBe(true);
    expect(await getBootstrapDoneMarker(db, SCOPE_KEY)).toBe('2');
  });

  describe('and then living through privacy events', () => {
    it('keeps the board downloaded and never downloads either artifact again', async () => {
      const server = backend();
      const snapshot = formatTwoSource();
      const fetchManifest = vi.spyOn(snapshot.source, 'fetchManifest');
      const onScopeDownloadComplete = vi.fn();
      const options = { snapshotSource: snapshot.source, onScopeDownloadComplete };
      await sync(server.fetch, options);
      const manifestFetchesForTheDownload = fetchManifest.mock.calls.length;

      const artifactDownloads: number[] = [];
      const gradesDownloads: number[] = [];
      for (let event = 0; event < 4; event += 1) {
        await simulatePrivacyRevalidation(db, VIEWER);
        expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
        await sync(server.fetch, options);
        artifactDownloads.push(snapshot.downloadArtifact.mock.calls.length);
        gradesDownloads.push(snapshot.downloadGradesArtifact.mock.calls.length);
      }

      // The grades artifact is 27 MB for Kilter. It used to come down after
      // every event (1, 2, 3, 4...), because the event deleted the cursor whose
      // absence means "grades were never imported".
      expect(gradesDownloads).toEqual([1, 1, 1, 1]);
      expect(artifactDownloads).toEqual([1, 1, 1, 1]);
      // Not even the manifest is asked for again.
      expect(fetchManifest).toHaveBeenCalledTimes(manifestFetchesForTheDownload);
      expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);
      expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
      expect(await getBootstrapDoneMarker(db, SCOPE_KEY)).toBe('2');
      // Reference: asked from the watermark for the download, then only ever
      // from the tail it reached. Never from the epoch.
      for (const queryName of REFERENCE_QUERIES) {
        expect(server.requestsFor(queryName, 'REFERENCE').every((request) => request.cursor !== undefined)).toBe(true);
      }
    });

    it('carries on importing when the event lands during the artifact transfer', async () => {
      const server = backend();
      const onSnapshotBootstrapError = vi.fn();
      const onScopeDownloadComplete = vi.fn();
      let eventFired = false;
      const snapshot = formatTwoSource({
        duringLayoutDownload: async () => {
          if (eventFired) return;
          eventFired = true;
          await simulatePrivacyRevalidation(db, VIEWER);
        },
      });
      const options = { snapshotSource: snapshot.source, onSnapshotBootstrapError, onScopeDownloadComplete };

      await sync(server.fetch, options);

      // The 110 MB transfer was not thrown away: it imported, in this cycle.
      expect(onSnapshotBootstrapError).not.toHaveBeenCalled();
      expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(1);
      expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(newerCatalogueClimb.cursor);
      expect(await localClimbs()).toEqual([...ARTIFACT_CLIMBS, newerCatalogueClimb].map((climb) => climb.uuid).sort());
      // Only the protected rows wait for the next cycle.
      expect(server.requestsFor(undefined, 'PROTECTED')).toHaveLength(0);
      expect(onScopeDownloadComplete).not.toHaveBeenCalled();

      await sync(server.fetch, options);

      expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(1);
      expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
      expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);
    });
  });

  // The reconcile removes local rows the artifact does not carry. The watermark
  // is real, so that is true of every authored climb on the device.
  describe('over rows the device already holds', () => {
    /** A scope part-way through a paged download: reference rows up to `cursor`, and some authored ones. */
    async function seedPartialDownload(): Promise<void> {
      await sync(backend([catalogueClimb(10), ownClimb, friendClimb]).fetch);
      await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [`scope-complete:${SCOPE_KEY}`]);
    }

    it('keeps the climber’s own and other climbers’ climbs through the import', async () => {
      await seedPartialDownload();
      const snapshot = formatTwoSource();
      // No protected pull this cycle, so what is left is what the import kept.
      await sync(backend().fetch, { snapshotSource: snapshot.source, isProtectedSyncAllowed: () => false });

      expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(1);
      expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
      expect(await localGrades()).toEqual(ALL_CLIMB_UUIDS);
    });

    it('replays the protected streams afterwards, which restores an ownerless authored climb the reconcile took', async () => {
      // A climb whose author deleted their account: still protected, still
      // public, and with no `user_id` nothing on the device can tell it from a
      // reference row the artifact has dropped.
      const orphanedClimb: ServerClimb = {
        uuid: 'authored-then-orphaned',
        ownerId: 'deleted-account',
        cursor: cursorAt(30),
        fields: { user_id: null },
        stats: {},
      };
      const climbs = [...SERVER_CLIMBS, orphanedClimb];
      await sync(backend([catalogueClimb(10), ownClimb, orphanedClimb]).fetch);
      await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [`scope-complete:${SCOPE_KEY}`]);
      expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toMatchObject({ complete: true });
      const server = backend(climbs);

      await sync(server.fetch, { snapshotSource: formatTwoSource().source });

      // The import reset the scope's protected cursors, so the replay started
      // from the epoch and brought the row back.
      expect(server.requestsFor('syncClimbs', 'PROTECTED').map((request) => request.cursor)).toEqual([undefined]);
      expect(await localClimbs()).toEqual([...ALL_CLIMB_UUIDS, orphanedClimb.uuid].sort());
      expect(await isScopeProtectedComplete(db, SCOPE_KEY)).toBe(true);
    });
  });
});

// One row per case in the design's mixed-version table. A device gets here from
// a bundle that pulled one stream per table and reset every cursor on each
// privacy event, and it may go back to one.
describe('arriving from, and returning to, a bundle from before the split', () => {
  /** The single cursor an earlier bundle kept per table: a position in the one stream of every visible row. */
  const olderBundleCursors = async (
    cursor: typeof EPOCH,
    tables = ['board_climbs', 'board_climb_stats', 'board_climb_grades'],
  ) => {
    for (const tableName of tables) {
      await olderBundleSetCheckpoint(db, `checkpoint:${tableName}:${SCOPE_KEY}`, cursor);
    }
  };
  /** Rows as an earlier bundle's single stream left them, up to and including `throughSequence`. */
  async function seedRowsThrough(throughSequence: number, climbs: ServerClimb[] = SERVER_CLIMBS): Promise<void> {
    const delivered = climbs.filter((climb) => Number(climb.cursor.syncSeq) <= throughSequence);
    await pullSync(db, queryClient, backend(delivered).fetch, { enabledBoards: [SCOPE_KEY] });
    // Strip everything this bundle wrote about how they got here.
    await db.runAsync(
      "DELETE FROM sync_meta WHERE key LIKE 'checkpoint:board_%' OR key LIKE 'scope-%' OR key LIKE 'schema-refresh:%'",
    );
  }
  const LAST_SEQUENCE = 90;

  it('a board that finished downloading: keeps it, crawls nothing, replays the protected rows once', async () => {
    await seedRowsThrough(LAST_SEQUENCE);
    await olderBundleCursors(cursorAt(LAST_SEQUENCE));
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [`scope-complete:${SCOPE_KEY}`, '1']);
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [`bootstrap-done:${SCOPE_KEY}`, '1']);
    const server = backend();
    const snapshot = formatTwoSource();
    const onScopeDownloadComplete = vi.fn();

    await sync(server.fetch, { snapshotSource: snapshot.source, onScopeDownloadComplete });

    // Its one cursor is a valid place to resume the reference stream from: every
    // reference row at or before it was in the stream it came from.
    for (const queryName of REFERENCE_QUERIES) {
      expect(server.requestsFor(queryName, 'REFERENCE').map((request) => request.cursor)).toEqual([
        cursorAt(LAST_SEQUENCE),
      ]);
    }
    expect(server.requestsFor('syncClimbs', 'PROTECTED').map((request) => request.cursor)).toEqual([undefined]);
    expect(snapshot.downloadArtifact).not.toHaveBeenCalled();
    expect(snapshot.downloadGradesArtifact).not.toHaveBeenCalled();
    expect(onScopeDownloadComplete).not.toHaveBeenCalled();
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
    expect(await isScopeProtectedComplete(db, SCOPE_KEY)).toBe(true);
    expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
  });

  describe('a board that was part-way through a paged download', () => {
    // Through sequence 40: three manufacturer climbs and the climber's own.
    const MID_CRAWL = 40;
    beforeEach(async () => {
      await seedRowsThrough(MID_CRAWL);
      await olderBundleCursors(cursorAt(MID_CRAWL), ['board_climbs']);
    });

    it('resumes the reference crawl from its cursor instead of starting over', async () => {
      const server = backend();
      const completions: ScopeDownloadCompleteInfo[] = [];

      await sync(server.fetch, { onScopeDownloadComplete: (info) => completions.push(info) });

      expect(server.requestsFor('syncClimbs', 'REFERENCE').map((request) => request.cursor)).toEqual([
        cursorAt(MID_CRAWL),
      ]);
      expect(server.requestsFor('syncClimbs', 'PROTECTED').map((request) => request.cursor)).toEqual([undefined]);
      expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
      expect(completions.map((info) => info.method)).toEqual(['paged']);
    });

    it('heals from an artifact once one is published', async () => {
      const server = backend();
      const snapshot = formatTwoSource();
      const completions: ScopeDownloadCompleteInfo[] = [];

      await sync(server.fetch, {
        snapshotSource: snapshot.source,
        onScopeDownloadComplete: (info) => completions.push(info),
      });

      expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(1);
      // The reference stream never asks for anything the artifact brought.
      expect(server.requestsFor('syncClimbs', 'REFERENCE').map((request) => request.cursor)).toEqual([
        ARTIFACT_WATERMARK,
      ]);
      expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
      expect(completions).toEqual([expect.objectContaining({ method: 'snapshot', bootstrapHealed: true })]);
      expect(await getBootstrapDoneMarker(db, SCOPE_KEY)).toBe('heal2');
    });
  });

  // A bundle with the privacy work imported a format-2 artifact and stamped its
  // cursors at the epoch, to crawl the authored rows the artifact left out.
  describe('a board an earlier bundle imported with epoch stamps', () => {
    beforeEach(async () => {
      await seedRowsThrough(50, ARTIFACT_CLIMBS);
      await olderBundleCursors(EPOCH);
      await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [`bootstrap-done:${SCOPE_KEY}`, '1']);
    });

    it('imports the artifact again for its real watermark, and never crawls the board from the epoch', async () => {
      const server = backend();
      const snapshot = formatTwoSource();
      const onBootstrapMetadataChanged = vi.fn();

      await sync(server.fetch, { snapshotSource: snapshot.source, onBootstrapMetadataChanged });

      expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(1);
      for (const queryName of REFERENCE_QUERIES) {
        const cursors = server.requestsFor(queryName, 'REFERENCE').map((request) => request.cursor);
        expect(cursors).toEqual([ARTIFACT_WATERMARK]);
      }
      expect(await getBootstrapDoneMarker(db, SCOPE_KEY)).toBe('heal2');
      expect(onBootstrapMetadataChanged).toHaveBeenCalledWith({ scopeKey: SCOPE_KEY });
      expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
      expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
    });

    it('waits for an unmetered link to do it, and crawls on meanwhile', async () => {
      const server = backend();
      const snapshot = formatTwoSource();

      await sync(server.fetch, { snapshotSource: snapshot.source, isOnUnmeteredNetwork: () => false });

      // The marker is set aside either way; the artifact waits.
      expect(snapshot.downloadArtifact).not.toHaveBeenCalled();
      expect(await getBootstrapDoneMarker(db, SCOPE_KEY)).toBeNull();
      expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
      expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
    });
  });

  // The state the issue is named for. An earlier bundle's revalidation deleted
  // every board checkpoint and kept `bootstrap-done:`, and before #6316 the
  // engine skipped such a scope on every cycle: "Waiting to download", for good.
  describe('a stuck board: a bootstrap-done marker and no cursor', () => {
    beforeEach(async () => {
      await seedRowsThrough(50, ARTIFACT_CLIMBS);
    });

    it.each(['1', 'heal'])('imports again when an artifact is published (marker %s)', async (marker) => {
      await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [`bootstrap-done:${SCOPE_KEY}`, marker]);
      const server = backend();
      const snapshot = formatTwoSource();
      const completions: ScopeDownloadCompleteInfo[] = [];

      await sync(server.fetch, {
        snapshotSource: snapshot.source,
        onScopeDownloadComplete: (info) => completions.push(info),
      });

      expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(1);
      expect(await getBootstrapDoneMarker(db, SCOPE_KEY)).toBe('2');
      expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(newerCatalogueClimb.cursor);
      expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
      expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
      expect(completions.map((info) => info.method)).toEqual(['snapshot']);
    });

    it('crawls its way out when there is no artifact to import', async () => {
      await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [`bootstrap-done:${SCOPE_KEY}`, '1']);
      const server = backend();
      const snapshot = createSnapshotSource({ manifest: () => null });
      const completions: ScopeDownloadCompleteInfo[] = [];

      await sync(server.fetch, {
        snapshotSource: snapshot.source,
        onScopeDownloadComplete: (info) => completions.push(info),
      });

      expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
      expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
      // Honestly labelled: nothing was imported for this completion.
      expect(await getBootstrapDoneMarker(db, SCOPE_KEY)).toBeNull();
      expect(completions.map((info) => info.method)).toEqual(['paged']);
    });
  });

  // Production still publishes format 1 until the release sequence replaces it
  // (docs/privacy.md). This client cannot use it and must not try.
  describe('a manifest in the format from before the privacy split', () => {
    const formatOneSource = () =>
      createSnapshotSource({
        manifest: () => ({ ...manifestOf([artifactEntry]), formatVersion: 1 }),
        layoutPath,
        gradesPath,
      });

    it('downloads nothing from it and crawls the reference catalogue once', async () => {
      const server = backend(SERVER_CLIMBS, { pageSize: 2 });
      const snapshot = formatOneSource();
      const completions: ScopeDownloadCompleteInfo[] = [];

      await sync(server.fetch, {
        snapshotSource: snapshot.source,
        onScopeDownloadComplete: (info) => completions.push(info),
      });

      expect(snapshot.downloadArtifact).not.toHaveBeenCalled();
      expect(snapshot.downloadGradesArtifact).not.toHaveBeenCalled();
      expect(server.requestsFor('syncClimbs', 'REFERENCE').map((request) => request.cursor)).toEqual([
        undefined,
        cursorAt(11),
        cursorAt(90),
      ]);
      expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
      expect(completions.map((info) => info.method)).toEqual(['paged']);
    });

    it('does not crawl it again after a privacy event', async () => {
      const server = backend(SERVER_CLIMBS, { pageSize: 2 });
      const snapshot = formatOneSource();
      const onScopeDownloadComplete = vi.fn();
      const options = { snapshotSource: snapshot.source, onScopeDownloadComplete };
      await sync(server.fetch, options);
      server.requests.length = 0;

      await simulatePrivacyRevalidation(db, VIEWER);
      await sync(server.fetch, options);

      // This is the cycle that used to be about 2,200 requests for Kilter.
      for (const queryName of REFERENCE_QUERIES) {
        expect(server.requestsFor(queryName, 'REFERENCE').map((request) => request.cursor)).toEqual([cursorAt(90)]);
      }
      expect(snapshot.downloadArtifact).not.toHaveBeenCalled();
      expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);
      expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
    });
  });

  describe('going back to an earlier bundle after this one wrote the new shape', () => {
    let snapshot: ReturnType<typeof formatTwoSource>;
    let completions: ScopeDownloadCompleteInfo[];
    let options: SyncOptions;

    beforeEach(async () => {
      snapshot = formatTwoSource();
      completions = [];
      options = { snapshotSource: snapshot.source, onScopeDownloadComplete: (info) => completions.push(info) };
      await sync(backend().fetch, options);
    });

    it('costs one protected replay when the earlier bundle only pulled a delta', async () => {
      // Its `setCheckpoint` replaced each row it advanced, which dropped the
      // protected cursor that was in it. The row it wrote on the way carried a
      // first-ascent name filled in for this viewer.
      const pulledByEarlierBundle = cursorAt(95);
      for (const key of [CLIMBS_KEY, STATS_KEY, GRADES_KEY])
        await olderBundleSetCheckpoint(db, key, pulledByEarlierBundle);
      await db.runAsync(
        "UPDATE board_climb_stats SET fa_username = 'A Private Climber' WHERE climb_uuid = 'friend-climb'",
      );
      const server = backend();

      await sync(server.fetch, options);

      for (const queryName of REFERENCE_QUERIES) {
        expect(server.requestsFor(queryName, 'REFERENCE').map((request) => request.cursor)).toEqual([
          pulledByEarlierBundle,
        ]);
        expect(server.requestsFor(queryName, 'PROTECTED').map((request) => request.cursor)).toEqual([undefined]);
      }
      expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(1);
      expect(await isScopeProtectedComplete(db, SCOPE_KEY)).toBe(true);
      expect(
        await db.getAllAsync("SELECT fa_username FROM board_climb_stats WHERE climb_uuid = 'friend-climb'"),
      ).toEqual([{ fa_username: null }]);
      expect(completions).toHaveLength(1);
    });

    it('resumes an earlier bundle’s re-crawl from where it got to, without importing again', async () => {
      // Its revalidation wiped the board's cursors and its crawl (with #6316)
      // started again from the epoch, getting as far as sequence 11.
      await simulateOlderBundleRevalidation(db, VIEWER);
      await olderBundleSetCheckpoint(db, CLIMBS_KEY, cursorAt(11));
      const server = backend();

      await sync(server.fetch, options);

      // This bundle's marker, with a cursor behind it: the import still stands.
      expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(1);
      expect(server.requestsFor('syncClimbs', 'REFERENCE').map((request) => request.cursor)).toEqual([cursorAt(11)]);
      expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
      expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
    });

    it('imports once more when the earlier bundle left the board with no cursor at all', async () => {
      await simulateOlderBundleRevalidation(db, VIEWER);
      expect(await getBootstrapDoneMarker(db, SCOPE_KEY)).toBe('2');
      const server = backend();

      await sync(server.fetch, options);

      expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(2);
      expect(server.requestsFor('syncClimbs', 'REFERENCE').map((request) => request.cursor)).toEqual([
        ARTIFACT_WATERMARK,
      ]);
      expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
      expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
      // The earlier bundle deleted the completion marker, so this download is
      // announced as one. That is the only way the event fires twice.
      expect(completions).toHaveLength(2);

      await sync(server.fetch, options);
      expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(2);
    });
  });
});
