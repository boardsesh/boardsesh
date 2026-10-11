// The snapshot half of the two-stream sync (issue #6306): what an artifact
// import leaves behind, how the pull carries on from it, and what a device that
// arrives from an earlier bundle, or goes back to one, ends up doing.
//
// An artifact holds a layout's reference rows: every published and listed
// climb, whoever set it, as of its build. For a while artifacts left out every
// owned climb, and the import made up for that by stamping its cursors at the
// epoch, so the whole board was crawled again behind every import and again
// after every privacy event. Here the import stamps the artifact's real
// watermark, and the only rows that come another way are the climber's own
// drafts and unlisted climbs, through the protected stream.
//
// File-backed SQLite throughout: the import ATTACHes the artifact inside an
// exclusive transaction, which only a file-backed double runs the way a phone
// does.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueryInvalidator } from '../../database';
import { runMigrations } from '../../db/migrations';
import { __resetDrainerStateForTests } from '../../mutation-queue/drainer';
import { ensureMutationQueueTable } from '../../mutation-queue/schema';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import { holdIndexKey } from '../../holds-index/hold-index';
import {
  getCheckpoint,
  getProtectedCheckpoint,
  getReferenceRuleGaps,
  isScopeDownloadComplete,
  isScopeProtectedComplete,
  setProtectedCheckpoint,
} from '../checkpoints';
import { stampLocalUserId } from '../local-user-owner';
import { pullSync, type ScopeDownloadCompleteInfo, type SyncOptions } from '../pull-client';
import {
  bootstrapScopeFromSnapshot,
  getGradesBootstrapAttempts,
  MAX_GRADES_BOOTSTRAP_ATTEMPTS,
  getBootstrapDoneMarker,
  getBootstrapMetadataByScope,
  getRuleCatchUpState,
  MAX_RULE_CATCH_UP_FAILURES,
  RULE_CATCH_UP_RETRY_DELAYS_MS,
} from '../snapshot-bootstrap';
import type { SnapshotManifestEntry } from '../snapshot-manifest';
import {
  buildSnapshotArtifacts,
  createSnapshotSource,
  createTwoStreamBackend,
  cursorAt,
  EPOCH,
  leftReferenceMarker,
  manifestOf,
  olderBundleSetCheckpoint,
  simulateOlderBundleRevalidation,
  simulatePrivacyRevalidation,
  type ServerClimb,
  type ServerDeletion,
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
// Published and listed, so public and in the artifact, whoever set them.
const ownClimb: ServerClimb = { uuid: 'viewer-own', ownerId: VIEWER, cursor: cursorAt(40), stats: {}, grade: true };
const friendClimb: ServerClimb = {
  uuid: 'friend-climb',
  ownerId: 'friend',
  cursor: cursorAt(41),
  stats: {},
  grade: true,
};
// A draft: sent to its owner alone, and never in an artifact.
const DRAFT = { is_draft: true, is_listed: false };
const ownDraft: ServerClimb = {
  uuid: 'viewer-draft',
  ownerId: VIEWER,
  cursor: cursorAt(45),
  fields: DRAFT,
  stats: {},
  grade: true,
};

// What the artifact was built from, and one manufacturer climb set since.
const ARTIFACT_CLIMBS = [catalogueClimb(10), catalogueClimb(11), ownClimb, friendClimb, catalogueClimb(50)];
const ARTIFACT_WATERMARK = cursorAt(50);
const newerCatalogueClimb = catalogueClimb(90);
const SERVER_CLIMBS = [...ARTIFACT_CLIMBS, newerCatalogueClimb, ownDraft];
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
  await stampLocalUserId(db, VIEWER);
  queryClient = { invalidateQueries: vi.fn() };
  __resetDrainerStateForTests();
  layoutPath = join(workDirectory, 'kilter-1.db');
  gradesPath = join(workDirectory, 'kilter-1-grades.db');
  artifactEntry = await buildSnapshotArtifacts({ layoutPath, gradesPath, climbs: [...ARTIFACT_CLIMBS, ownDraft] });
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
const localStats = async (): Promise<string[]> =>
  (await db.getAllAsync<{ climb_uuid: string }>('SELECT climb_uuid FROM board_climb_stats ORDER BY climb_uuid')).map(
    (row) => row.climb_uuid,
  );

function backend(
  climbs: ServerClimb[] | (() => ServerClimb[]) = SERVER_CLIMBS,
  extra: Partial<TwoStreamBackendOptions> = {},
) {
  return createTwoStreamBackend({ climbs: typeof climbs === 'function' ? climbs : () => climbs, ...extra });
}

/** A source that publishes the manifest listing the two artifacts. */
const artifactSource = (extra: Partial<Parameters<typeof createSnapshotSource>[0]> = {}) =>
  createSnapshotSource({ manifest: () => manifestOf([artifactEntry]), layoutPath, gradesPath, ...extra });

const sync = (fetch: ReturnType<typeof backend>['fetch'], options: SyncOptions = {}) =>
  pullSync(db, queryClient, fetch, { enabledBoards: [SCOPE_KEY], ...options });

/**
 * See every write an import issues, before it runs, and optionally fail one. The
 * import works on the connection its exclusive transaction hands it, which for
 * a database on disk is not `db` itself.
 */
function onImportStatement(observe: (source: string) => void): void {
  const exclusive = db.withExclusiveTransactionAsync.bind(db);
  vi.spyOn(db, 'withExclusiveTransactionAsync').mockImplementation((task) =>
    exclusive(async (transaction) => {
      const run = transaction.runAsync.bind(transaction);
      vi.spyOn(transaction, 'runAsync').mockImplementation((source, ...params) => {
        observe(source);
        return run(source, ...params);
      });
      await task(transaction);
    }),
  );
}

describe('downloading a board from a snapshot', () => {
  it('stamps the artifact’s real watermark and pulls only what the artifact does not hold', async () => {
    const server = backend();
    const snapshot = artifactSource();
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
    // The climber's own draft is not in an artifact: it comes from the epoch.
    expect(server.requestsFor('syncClimbs', 'PROTECTED').map((request) => request.cursor)).toEqual([undefined]);
    expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
    expect(await localGrades()).toEqual(ALL_CLIMB_UUIDS);
    // Other climbers' published climbs came out of the file, with their owner.
    expect(await db.getFirstAsync("SELECT user_id FROM board_climbs WHERE uuid = 'friend-climb'")).toEqual({
      user_id: 'friend',
    });
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(newerCatalogueClimb.cursor);
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
    expect(await isScopeProtectedComplete(db, SCOPE_KEY)).toBe(true);
    expect(await getBootstrapDoneMarker(db, SCOPE_KEY)).toBe('2');
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ method: 'snapshot', audienceMode: 'split' });
    // The draft, its stats row and its grade row.
    expect(completions[0].phases.protectedRows).toBe(3);
  });

  // The file carries the stored upstream credit; it is the public dataset too.
  // The device stores neither column, and the two are not drift.
  it('does not store the first-ascent credit the artifact carries, and does not report it as drift', async () => {
    const onSchemaDrift = vi.fn();
    const snapshot = artifactSource();

    await sync(backend().fetch, { snapshotSource: snapshot.source, onSchemaDrift });

    const artifact = createTestDatabase(layoutPath);
    expect(
      await artifact.getAllAsync('SELECT DISTINCT fa_username FROM board_climb_stats WHERE fa_username IS NOT NULL'),
    ).toEqual([{ fa_username: 'Manufacturer Setter' }]);
    artifact.close();
    expect(await db.getAllAsync('SELECT DISTINCT fa_username, fa_at FROM board_climb_stats')).toEqual([
      { fa_username: null, fa_at: null },
    ]);
    expect(await localStats()).toEqual(ALL_CLIMB_UUIDS);
    expect(onSchemaDrift).not.toHaveBeenCalled();
  });

  it('settles: the cycles that follow import nothing and start no stream over', async () => {
    const server = backend();
    const snapshot = artifactSource();
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
    it('keeps the board downloaded, downloads neither artifact again, and starts no stream over', async () => {
      const server = backend();
      const snapshot = artifactSource();
      const fetchManifest = vi.spyOn(snapshot.source, 'fetchManifest');
      const onScopeDownloadComplete = vi.fn();
      const options = { snapshotSource: snapshot.source, onScopeDownloadComplete };
      await sync(server.fetch, options);
      const manifestFetchesForTheDownload = fetchManifest.mock.calls.length;
      server.requests.length = 0;

      const artifactDownloads: number[] = [];
      const gradesDownloads: number[] = [];
      for (let event = 0; event < 4; event += 1) {
        await simulatePrivacyRevalidation(db, VIEWER);
        expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
        expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
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
      expect(await getBootstrapDoneMarker(db, SCOPE_KEY)).toBe('2');
      // Every request after the download resumed from a cursor, protected ones
      // included: an event resets nothing on a catalogue board.
      expect(server.requestsFor().every((request) => request.cursor !== undefined)).toBe(true);
    });

    it('imports and finishes in the same cycle when the event lands during the artifact transfer', async () => {
      const server = backend();
      const onSnapshotBootstrapError = vi.fn();
      const onScopeDownloadComplete = vi.fn();
      let eventFired = false;
      const snapshot = artifactSource({
        duringLayoutDownload: async () => {
          if (eventFired) return;
          eventFired = true;
          await simulatePrivacyRevalidation(db, VIEWER);
        },
      });

      await sync(server.fetch, { snapshotSource: snapshot.source, onSnapshotBootstrapError, onScopeDownloadComplete });

      // The 110 MB transfer was not thrown away, and nothing waited for a
      // second cycle.
      expect(onSnapshotBootstrapError).not.toHaveBeenCalled();
      expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(1);
      expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
      expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);
    });
  });

  // The reconcile removes local rows the artifact does not carry: at or below
  // the watermark and missing from the file means deleted, or no longer public.
  describe('over rows the device already holds', () => {
    const takenBackToDraft: ServerClimb = {
      uuid: 'friend-unpublished',
      ownerId: 'friend',
      cursor: cursorAt(30),
      stats: {},
      grade: true,
    };

    /** A scope part-way through a paged download. */
    async function seedPartialDownload(climbs: ServerClimb[]): Promise<void> {
      await sync(backend(climbs).fetch);
      await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [`scope-complete:${SCOPE_KEY}`]);
    }
    /** A cycle whose protected streams cannot be reached, so what is left is what the import kept. */
    const importOnly = async (snapshot: ReturnType<typeof artifactSource>) => {
      const server = backend(SERVER_CLIMBS, {
        onRequest: (request) => {
          if (request.audience === 'PROTECTED') throw new Error('connection dropped');
        },
      });
      await sync(server.fetch, { snapshotSource: snapshot.source }).catch(() => {});
    };

    it('keeps the climber’s own draft, which no artifact holds', async () => {
      await seedPartialDownload([catalogueClimb(10), ownDraft]);
      const snapshot = artifactSource();

      await importOnly(snapshot);

      expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(1);
      expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
      expect(await localStats()).toContain('viewer-draft');
      expect(await localGrades()).toContain('viewer-draft');
    });

    it('removes another climber’s climb that is no longer in the catalogue, with its stats and grades', async () => {
      // On the device as a published climb. Its setter has since taken it back
      // to a draft, so the artifact, built after that, does not have it.
      await seedPartialDownload([catalogueClimb(10), takenBackToDraft]);
      expect(await localGrades()).toEqual(['catalogue-10', 'friend-unpublished']);
      const snapshot = artifactSource();

      await importOnly(snapshot);

      expect(await localClimbs()).not.toContain('friend-unpublished');
      expect(await localStats()).not.toContain('friend-unpublished');
      expect(await localGrades()).not.toContain('friend-unpublished');
    });

    describe('when the climber’s own climb has become a draft since the artifact was built', () => {
      // The file holds the published copy (40). The server holds the draft (70)
      // and a marker for the copy; the device already has both.
      const ownAsDraft: ServerClimb = { ...ownClimb, cursor: cursorAt(70), fields: DRAFT };
      const climbsNow = [catalogueClimb(10), catalogueClimb(11), friendClimb, catalogueClimb(50), ownAsDraft];
      const deletions: ServerDeletion[] = [leftReferenceMarker(ownAsDraft)];
      const ownRow = () => db.getAllAsync("SELECT is_draft, sync_seq FROM board_climbs WHERE uuid = 'viewer-own'");

      beforeEach(async () => {
        await sync(backend([catalogueClimb(10), ownAsDraft], { deletions: () => deletions }).fetch);
        await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [`scope-complete:${SCOPE_KEY}`]);
        expect(await ownRow()).toEqual([{ is_draft: 1, sync_seq: 70 }]);
        expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toMatchObject({ ...cursorAt(70), complete: true });
      });

      it('puts the draft back after the import wrote the older published copy over it', async () => {
        const server = backend(climbsNow, { deletions: () => deletions });

        await sync(server.fetch, { snapshotSource: artifactSource().source });

        // The import rewound the deletions cursor, the marker removed the
        // published copy, and the protected replay it asked for brought the
        // draft back.
        expect(server.requestsFor('syncClimbs', 'PROTECTED').map((request) => request.cursor)).toEqual([undefined]);
        expect(await ownRow()).toEqual([{ is_draft: 1, sync_seq: 70 }]);
        expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
      });

      // DATA LOSS found in review of #6329. The protected reset used to sit in
      // the import's last transaction only, so an import that died after its
      // climbs batch left the published copy on the device, under a protected
      // cursor that had already passed the draft.
      it('puts the draft back when the import fails after its reconcile', async () => {
        const server = backend(climbsNow, { deletions: () => deletions });
        const onSnapshotBootstrapError = vi.fn();
        onImportStatement((source) => {
          if (source.includes('INSERT OR REPLACE INTO main.board_climb_stats')) throw new Error('disk I/O error');
        });

        await sync(server.fetch, { snapshotSource: artifactSource().source, onSnapshotBootstrapError });

        expect(onSnapshotBootstrapError).toHaveBeenCalledTimes(1);
        // No reference cursor was stamped by the failed import...
        expect(await getBootstrapDoneMarker(db, SCOPE_KEY)).toBeNull();
        // ...and the replay it had already asked for restored the draft.
        expect(server.requestsFor('syncClimbs', 'PROTECTED').map((request) => request.cursor)).toEqual([undefined]);
        expect(await ownRow()).toEqual([{ is_draft: 1, sync_seq: 70 }]);
        expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toMatchObject({ ...cursorAt(70), complete: true });
      });
    });
  });
});

// The artifact rule this client imports is exactly one (`SNAPSHOT_PRIVACY_VERSION`).
describe('an artifact built under another rule', () => {
  it.each([
    ['the rule before it, with every owned climb left out', 1],
    ['no rule at all', undefined],
    ['a rule this build has not heard of', 3],
  ])('is not downloaded (%s): the board comes through the paged pull instead', async (_label, privacyVersion) => {
    const entry = {
      ...artifactEntry,
      privacyVersion,
      grades: artifactEntry.grades && { ...artifactEntry.grades, privacyVersion },
    };
    const snapshot = createSnapshotSource({ manifest: () => manifestOf([entry]), layoutPath, gradesPath });
    const server = backend();
    const completions: ScopeDownloadCompleteInfo[] = [];

    await sync(server.fetch, {
      snapshotSource: snapshot.source,
      onScopeDownloadComplete: (info) => completions.push(info),
    });

    expect(snapshot.downloadArtifact).not.toHaveBeenCalled();
    expect(snapshot.downloadGradesArtifact).not.toHaveBeenCalled();
    expect(server.requestsFor('syncClimbs', 'REFERENCE').map((request) => request.cursor)).toEqual([undefined]);
    // Importing a rule-1 file at its watermark would have skipped these for good.
    expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
    expect(completions.map((info) => info.method)).toEqual(['paged']);
  });

  it('does not take a grades file of another rule beside a layout file of this one', async () => {
    const entry = { ...artifactEntry, grades: artifactEntry.grades && { ...artifactEntry.grades, privacyVersion: 1 } };
    const snapshot = createSnapshotSource({ manifest: () => manifestOf([entry]), layoutPath, gradesPath });

    await sync(backend().fetch, { snapshotSource: snapshot.source });

    expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(1);
    expect(snapshot.downloadGradesArtifact).not.toHaveBeenCalled();
    expect(await localGrades()).toEqual(ALL_CLIMB_UUIDS);
  });
});

// One row per case in the mixed-version table. A device gets here from a bundle
// that pulled one stream per table and reset every cursor on each privacy event,
// and it may go back to one.
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

  // Every board downloaded before this bundle. Its cursors are at the tail of
  // the one stream an earlier bundle pulled, under the rule the server applied
  // then: a published climb was withheld from a viewer its author's privacy
  // settings excluded. The current rule makes that climb public, but it has not
  // changed since, so it sits behind the cursor and no delta carries it.
  describe('a board that finished downloading under an earlier rule', () => {
    // Withheld then, public now: the friend's published climb, its stats row
    // and its grade.
    const withheldThen = friendClimb;
    const deliveredThen = SERVER_CLIMBS.filter((climb) => climb !== withheldThen);
    const HOLDS_INDEX_KEY = holdIndexKey(SCOPE_KEY);
    let server: ReturnType<typeof backend>;
    let snapshot: ReturnType<typeof artifactSource>;
    let onScopeDownloadComplete: Mock<(info: ScopeDownloadCompleteInfo) => void>;
    let options: SyncOptions;

    beforeEach(async () => {
      await seedRowsThrough(LAST_SEQUENCE, deliveredThen);
      await olderBundleCursors(cursorAt(LAST_SEQUENCE));
      await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [`scope-complete:${SCOPE_KEY}`, '1']);
      await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [`bootstrap-done:${SCOPE_KEY}`, '1']);
      // A holds index built over what the board held.
      await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [HOLDS_INDEX_KEY, String(LAST_SEQUENCE)]);
      // And a deletions stream consumed to the same point.
      await olderBundleSetCheckpoint(db, 'checkpoint:deletions', cursorAt(LAST_SEQUENCE));
      expect(await localClimbs()).not.toContain(withheldThen.uuid);
      server = backend();
      snapshot = artifactSource();
      onScopeDownloadComplete = vi.fn<(info: ScopeDownloadCompleteInfo) => void>();
      options = { snapshotSource: snapshot.source, onScopeDownloadComplete };
    });
    const referenceCursorsAsked = (queryName: string) =>
      server.requestsFor(queryName, 'REFERENCE').map((request) => request.cursor);

    it('has the climb the rule now makes public after one import over it, and crawls nothing', async () => {
      await sync(server.fetch, options);

      expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(1);
      expect(snapshot.downloadGradesArtifact).toHaveBeenCalledTimes(1);
      expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
      expect(await localStats()).toContain(withheldThen.uuid);
      expect(await localGrades()).toContain(withheldThen.uuid);
      // One request per reference stream, from the artifact's watermark: the
      // delta since the build. A request with no cursor would be the crawl.
      for (const queryName of REFERENCE_QUERIES) {
        expect(referenceCursorsAsked(queryName)).toEqual([ARTIFACT_WATERMARK]);
      }
      // The board was downloaded all along: it is not announced again, and it
      // was never anything but complete.
      expect(onScopeDownloadComplete).not.toHaveBeenCalled();
      expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
      expect(await isScopeProtectedComplete(db, SCOPE_KEY)).toBe(true);
      // Climbs arrived behind the index's watermark, so it builds again.
      expect(await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [HOLDS_INDEX_KEY])).toBeNull();
      expect(await getReferenceRuleGaps(db, SCOPE_KEY)).toEqual({ layout: false, grades: false });
    });

    it('does it once: later cycles download nothing and pull only the delta', async () => {
      await sync(server.fetch, options);
      server.requests.length = 0;

      await sync(server.fetch, options);
      await sync(server.fetch, options);

      expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(1);
      expect(snapshot.downloadGradesArtifact).toHaveBeenCalledTimes(1);
      for (const queryName of REFERENCE_QUERIES) {
        expect(referenceCursorsAsked(queryName)).toEqual([cursorAt(LAST_SEQUENCE), cursorAt(LAST_SEQUENCE)]);
      }
      expect(onScopeDownloadComplete).not.toHaveBeenCalled();
    });

    it('waits for a link that is not metered, and the board carries on as it was meanwhile', async () => {
      await sync(server.fetch, { ...options, isOnUnmeteredNetwork: () => false });

      expect(snapshot.downloadArtifact).not.toHaveBeenCalled();
      expect(snapshot.downloadGradesArtifact).not.toHaveBeenCalled();
      for (const queryName of REFERENCE_QUERIES) {
        expect(referenceCursorsAsked(queryName)).toEqual([cursorAt(LAST_SEQUENCE)]);
      }
      expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
      expect(await localClimbs()).not.toContain(withheldThen.uuid);
      expect(await getReferenceRuleGaps(db, SCOPE_KEY)).toEqual({ layout: true, grades: true });

      await sync(server.fetch, options);
      expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(1);
      expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
    });

    it('does nothing until an artifact built under the rule is published', async () => {
      const builtUnderAnEarlierRule = createSnapshotSource({
        manifest: () => manifestOf([{ ...artifactEntry, privacyVersion: 1 }]),
        layoutPath,
        gradesPath,
      });

      await sync(server.fetch, { ...options, snapshotSource: builtUnderAnEarlierRule.source });

      expect(builtUnderAnEarlierRule.downloadArtifact).not.toHaveBeenCalled();
      expect(builtUnderAnEarlierRule.downloadGradesArtifact).not.toHaveBeenCalled();
      expect(await getRuleCatchUpState(db, SCOPE_KEY)).toEqual({ failures: 0, retryAfter: null });
      expect(await localClimbs()).not.toContain(withheldThen.uuid);
    });

    it('recovers omitted old climbs and overwritten newer rows after the second batch fails', async () => {
      const newer = { ...catalogueClimb(10), cursor: cursorAt(85), fields: { name: 'Fresh title' } };
      await db.runAsync('UPDATE board_climbs SET name = ?, updated_at = ?, sync_seq = ? WHERE uuid = ?', [
        'Fresh title',
        newer.cursor.updatedAt,
        newer.cursor.syncSeq,
        newer.uuid,
      ]);
      let batches = 0;
      onImportStatement((statement) => {
        if (statement.includes('INSERT OR REPLACE INTO main.board_climbs') && ++batches === 2)
          throw new Error('disk I/O error');
      });
      await expect(
        bootstrapScopeFromSnapshot({
          db,
          scope: { boardType: 'kilter', layoutId: 1, sizeId: 12 },
          scopeKey: SCOPE_KEY,
          filePath: layoutPath,
          overFinishedScope: true,
          batchRows: 1,
        }),
      ).rejects.toThrow('disk I/O error');
      expect(await localClimbs()).not.toContain(withheldThen.uuid);
      expect(await db.getFirstAsync('SELECT name FROM board_climbs WHERE uuid = ?', [newer.uuid])).toEqual({
        name: newer.uuid,
      });
      expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(EPOCH);
      expect(await getCheckpoint(db, STATS_KEY)).toEqual(EPOCH);
      expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
      const currentServer = backend(SERVER_CLIMBS.map((climb) => (climb.uuid === newer.uuid ? newer : climb)));
      await sync(currentServer.fetch);
      expect(currentServer.requestsFor('syncClimbs', 'REFERENCE')[0].cursor).toEqual(EPOCH);
      expect(currentServer.requestsFor('syncClimbStats', 'REFERENCE')[0].cursor).toEqual(EPOCH);
      expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
      expect(await localStats()).toContain(withheldThen.uuid);
      expect(await db.getFirstAsync('SELECT name, updated_at FROM board_climbs WHERE uuid = ?', [newer.uuid])).toEqual({
        name: 'Fresh title',
        updated_at: newer.cursor.updatedAt,
      });
      expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
    });

    it('rearms an exhausted older grades budget when the layout catches up to the rule', async () => {
      await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
        `grades-bootstrap-attempts:${SCOPE_KEY}`,
        String(MAX_GRADES_BOOTSTRAP_ATTEMPTS),
      ]);
      await sync(server.fetch, options);
      expect(snapshot.downloadGradesArtifact).toHaveBeenCalledTimes(1);
      expect(await localGrades()).toContain(withheldThen.uuid);
      expect(await getGradesBootstrapAttempts(db, SCOPE_KEY)).toBe(0);
      expect(
        await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [`grades-rule-catch-up:${SCOPE_KEY}`]),
      ).toEqual({ value: '2' });
    });

    describe('when the import fails part-way', () => {
      const NOW = Date.parse('2026-10-11T08:00:00Z');
      let failNextImport: boolean;
      beforeEach(() => {
        failNextImport = true;
        onImportStatement((source) => {
          if (failNextImport && source.includes('INSERT OR REPLACE INTO main.board_climbs')) {
            throw new Error('disk I/O error');
          }
        });
      });

      it('has already moved the cursors back, so the same cycle pulls again what the artifact was written over', async () => {
        const onRuleCatchUp = vi.fn();

        await sync(server.fetch, { ...options, onRuleCatchUp, now: () => NOW });

        // Ordinary paging starts at the epoch to recover rows below the artifact watermark,
        // although the import never reached its last transaction.
        expect(referenceCursorsAsked('syncClimbs')).toEqual([EPOCH]);
        expect(referenceCursorsAsked('syncClimbStats')).toEqual([EPOCH]);
        // So did the deletions: one of a row the artifact brought back must be
        // applied again. They page on time alone, from the artifact's boundary.
        expect(
          server.requests.filter((request) => request.queryName === 'syncDeletions').map((request) => request.cursor),
        ).toEqual([{ updatedAt: ARTIFACT_WATERMARK.updatedAt, syncSeq: '0' }]);
        expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(cursorAt(LAST_SEQUENCE));
        expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
        // The reference crawl repairs the layout in this cycle. Grades are still owed.
        expect(await getReferenceRuleGaps(db, SCOPE_KEY)).toEqual({ layout: false, grades: true });
        expect(await getRuleCatchUpState(db, SCOPE_KEY)).toEqual({
          failures: 1,
          retryAfter: NOW + RULE_CATCH_UP_RETRY_DELAYS_MS[0],
        });
        expect(onRuleCatchUp).toHaveBeenCalledWith(
          expect.objectContaining({
            scopeKey: SCOPE_KEY,
            outcome: 'failed',
            stage: 'import',
            failures: 1,
            gaveUp: false,
          }),
        );
        expect(onScopeDownloadComplete).not.toHaveBeenCalled();
      });

      it('does not retry an artifact once epoch paging repaired the layout', async () => {
        await sync(server.fetch, { ...options, now: () => NOW });
        failNextImport = false;
        await sync(server.fetch, { ...options, now: () => NOW + 1 });
        expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(1);
        expect(snapshot.downloadGradesArtifact).toHaveBeenCalledTimes(1);
        expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
        expect(await localGrades()).toContain(withheldThen.uuid);
        expect(await getReferenceRuleGaps(db, SCOPE_KEY)).toEqual({ layout: false, grades: false });
      });

      it('keeps the repaired board complete without repeatedly spending the artifact budget', async () => {
        const onRuleCatchUp = vi.fn();
        let clock = NOW;
        for (let attempt = 1; attempt <= MAX_RULE_CATCH_UP_FAILURES + 2; attempt += 1) {
          await sync(server.fetch, { ...options, onRuleCatchUp, now: () => clock });
          clock += 7 * 24 * 60 * 60 * 1000;
        }

        expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(1);
        expect(onRuleCatchUp).toHaveBeenLastCalledWith(
          expect.objectContaining({ outcome: 'failed', failures: 1, gaveUp: false }),
        );
        expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
        expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
      });
    });

    it('charges a download that does not land', async () => {
      const NOW = Date.parse('2026-10-11T08:00:00Z');
      const noFile = createSnapshotSource({ manifest: () => manifestOf([artifactEntry]) });
      const onRuleCatchUp = vi.fn();

      await sync(server.fetch, { ...options, snapshotSource: noFile.source, onRuleCatchUp, now: () => NOW });

      expect(noFile.downloadArtifact).toHaveBeenCalledTimes(1);
      expect(await getRuleCatchUpState(db, SCOPE_KEY)).toEqual({
        failures: 1,
        retryAfter: NOW + RULE_CATCH_UP_RETRY_DELAYS_MS[0],
      });
      expect(onRuleCatchUp).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', stage: 'download' }));
      expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
      // Nothing was written over, so no cursor moved.
      expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(cursorAt(LAST_SEQUENCE));
    });

    // The grades file is filtered through the climbs on the device. Imported
    // over a board that is still missing the withheld climbs, it drops their
    // grades, so its cursor must not claim the rule until the climbs are in.
    it('does not call the grades caught up while the climbs are not', async () => {
      await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [GRADES_KEY]);
      await db.runAsync('DELETE FROM board_climb_grades');

      // No link for the layout file yet: the grades retro-fit runs alone.
      await sync(server.fetch, { ...options, isOnUnmeteredNetwork: () => false });
      expect(snapshot.downloadGradesArtifact).toHaveBeenCalledTimes(1);
      expect(await localGrades()).not.toContain(withheldThen.uuid);
      // An unstamped cursor past the start is a gap, and is asked about again.
      expect(await getReferenceRuleGaps(db, SCOPE_KEY)).toEqual({ layout: true, grades: true });

      // The layout import goes through, and this time the grades file does not come down.
      const layoutOnly = createSnapshotSource({ manifest: () => manifestOf([artifactEntry]), layoutPath });
      await sync(server.fetch, { ...options, snapshotSource: layoutOnly.source });
      // No grades artifact landed, so the prepared epoch reference pull fills
      // every grade now that the complete climb catalogue is here.
      expect(await getReferenceRuleGaps(db, SCOPE_KEY)).toEqual({ layout: false, grades: false });
      expect(await localGrades()).toContain(withheldThen.uuid);

      await sync(server.fetch, options);
      expect(snapshot.downloadArtifact).not.toHaveBeenCalled();
      expect(snapshot.downloadGradesArtifact).toHaveBeenCalledTimes(1);
      expect(await localGrades()).toContain(withheldThen.uuid);
      expect(await getReferenceRuleGaps(db, SCOPE_KEY)).toEqual({ layout: false, grades: false });
    });
  });

  it('never imports over a board this bundle downloaded page by page', async () => {
    const paged = backend(SERVER_CLIMBS, { pageSize: 2 });
    await sync(paged.fetch, {});
    expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
    expect(await getReferenceRuleGaps(db, SCOPE_KEY)).toEqual({ layout: false, grades: false });
    const snapshot = artifactSource();

    await sync(paged.fetch, { snapshotSource: snapshot.source });

    expect(snapshot.downloadArtifact).not.toHaveBeenCalled();
    expect(snapshot.downloadGradesArtifact).not.toHaveBeenCalled();
  });

  it('catches up the grades alone when only their cursor predates the rule', async () => {
    const snapshot = artifactSource();
    await sync(backend().fetch, { snapshotSource: snapshot.source });
    // An earlier bundle then advanced the grades cursor, and only that one.
    await olderBundleSetCheckpoint(db, GRADES_KEY, cursorAt(95));
    await db.runAsync("DELETE FROM board_climb_grades WHERE climb_uuid = 'friend-climb'");
    expect(await getReferenceRuleGaps(db, SCOPE_KEY)).toEqual({ layout: false, grades: true });

    await sync(backend().fetch, { snapshotSource: snapshot.source, isOnUnmeteredNetwork: () => false });
    expect(snapshot.downloadGradesArtifact).toHaveBeenCalledTimes(1);

    await sync(backend().fetch, { snapshotSource: snapshot.source });
    expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(1);
    expect(snapshot.downloadGradesArtifact).toHaveBeenCalledTimes(2);
    expect(await localGrades()).toContain('friend-climb');
    expect(await getReferenceRuleGaps(db, SCOPE_KEY)).toEqual({ layout: false, grades: false });
  });

  it('rearms capped grades-only catch-up once and repairs a failed artifact through epoch paging', async () => {
    const snapshot = artifactSource();
    await sync(backend().fetch, { snapshotSource: snapshot.source });
    const protectedCursor = await getProtectedCheckpoint(db, GRADES_KEY);
    expect(protectedCursor).not.toBeNull();
    await olderBundleSetCheckpoint(db, GRADES_KEY, cursorAt(95));
    await setProtectedCheckpoint(db, GRADES_KEY, protectedCursor!);
    await db.runAsync("DELETE FROM board_climb_grades WHERE climb_uuid = 'friend-climb'");
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      `grades-bootstrap-attempts:${SCOPE_KEY}`,
      String(MAX_GRADES_BOOTSTRAP_ATTEMPTS),
    ]);
    snapshot.source.downloadGradesArtifact = vi.fn(async () => {
      throw new TypeError('Network request failed');
    });
    await sync(backend().fetch, { snapshotSource: snapshot.source, isOnUnmeteredNetwork: () => false });
    expect(await getGradesBootstrapAttempts(db, SCOPE_KEY)).toBe(MAX_GRADES_BOOTSTRAP_ATTEMPTS);
    expect(await getCheckpoint(db, GRADES_KEY)).toEqual(cursorAt(95));
    const server = backend();
    await sync(server.fetch, { snapshotSource: snapshot.source });
    expect(server.requestsFor('syncClimbGrades', 'REFERENCE')[0].cursor).toEqual(EPOCH);
    expect(await localGrades()).toContain('friend-climb');
    expect(await getGradesBootstrapAttempts(db, SCOPE_KEY)).toBe(1);
    expect(await getProtectedCheckpoint(db, GRADES_KEY)).toEqual(protectedCursor);
    expect(await getReferenceRuleGaps(db, SCOPE_KEY)).toEqual({ layout: false, grades: false });
    // An earlier bundle loses the stamp again: restart paging, but do not re-arm
    // the artifact budget repeatedly for the same publication rule.
    await olderBundleSetCheckpoint(db, GRADES_KEY, cursorAt(95));
    await sync(backend().fetch, { snapshotSource: snapshot.source });
    expect(await getGradesBootstrapAttempts(db, SCOPE_KEY)).toBe(2);
    await olderBundleSetCheckpoint(db, GRADES_KEY, cursorAt(95));
    const cappedServer = backend();
    await sync(cappedServer.fetch, { snapshotSource: snapshot.source });
    expect(await getGradesBootstrapAttempts(db, SCOPE_KEY)).toBe(2);
    expect(cappedServer.requestsFor('syncClimbGrades', 'REFERENCE')[0].cursor).toEqual(EPOCH);
    expect(await getReferenceRuleGaps(db, SCOPE_KEY)).toEqual({ layout: false, grades: false });
  });

  describe('a board that was part-way through a paged download', () => {
    // Through sequence 40: two manufacturer climbs and the climber's own published one.
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
      const snapshot = artifactSource();
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

  // A bundle with the privacy work imported an artifact and stamped its cursors
  // at the epoch, to crawl the owned climbs artifacts then left out.
  describe('a board an earlier bundle imported with epoch stamps', () => {
    beforeEach(async () => {
      await seedRowsThrough(50, ARTIFACT_CLIMBS);
      await olderBundleCursors(EPOCH);
      await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [`bootstrap-done:${SCOPE_KEY}`, '1']);
    });

    it('imports the artifact again for its real watermark, and never crawls the board from the epoch', async () => {
      const server = backend();
      const snapshot = artifactSource();
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
      const snapshot = artifactSource();

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
      const snapshot = artifactSource();
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

    // Found in review of #6329: with the marker set aside and no cursor, the
    // board read as a fresh download, and only a heal asks whether the link is
    // metered. 110 MB plus 27 MB of grades over cellular, which nobody chose.
    it.each(['1', 'heal'])(
      'does not download it on a metered link, where nobody confirmed the size (marker %s)',
      async (marker) => {
        await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [`bootstrap-done:${SCOPE_KEY}`, marker]);
        const server = backend();
        const snapshot = artifactSource();
        const completions: ScopeDownloadCompleteInfo[] = [];
        const options = {
          snapshotSource: snapshot.source,
          isOnUnmeteredNetwork: () => false,
          onScopeDownloadComplete: (info: ScopeDownloadCompleteInfo) => completions.push(info),
        };
        // My Boards does not call this a board downloaded the fast way.
        expect((await getBootstrapMetadataByScope(db, [SCOPE_KEY])).get(SCOPE_KEY)?.isBootstrapDone).toBe(false);

        await sync(server.fetch, options);
        await sync(server.fetch, options);

        expect(snapshot.downloadArtifact).not.toHaveBeenCalled();
        expect(snapshot.downloadGradesArtifact).not.toHaveBeenCalled();
        // The paged pull got it there instead, and says so.
        expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
        expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
        expect(await getBootstrapDoneMarker(db, SCOPE_KEY)).toBeNull();
        expect(completions.map((info) => info.method)).toEqual(['paged']);
      },
    );

    it('keeps the marker it set aside until something replaces it, so a later cycle still knows', async () => {
      await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [`bootstrap-done:${SCOPE_KEY}`, '1']);
      const snapshot = artifactSource();
      // The crawl cannot finish this cycle either.
      const server = backend(SERVER_CLIMBS, {
        onRequest: (request) => {
          if (request.queryName === 'syncClimbStats') throw new Error('connection dropped');
        },
      });

      await sync(server.fetch, { snapshotSource: snapshot.source, isOnUnmeteredNetwork: () => false }).catch(() => {});
      // A board with a cursor now, and still a download nobody confirmed.
      expect(await getCheckpoint(db, CLIMBS_KEY)).not.toBeNull();
      expect(await getBootstrapDoneMarker(db, SCOPE_KEY)).toBe('1');
      await sync(backend().fetch, { snapshotSource: snapshot.source, isOnUnmeteredNetwork: () => false });

      expect(snapshot.downloadArtifact).not.toHaveBeenCalled();
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

  // A manifest in the older format. This client cannot use it and must not try.
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
        cursorAt(41),
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
    let snapshot: ReturnType<typeof artifactSource>;
    let completions: ScopeDownloadCompleteInfo[];
    let options: SyncOptions;

    beforeEach(async () => {
      snapshot = artifactSource();
      completions = [];
      options = { snapshotSource: snapshot.source, onScopeDownloadComplete: (info) => completions.push(info) };
      await sync(backend().fetch, options);
    });

    describe('when the earlier bundle only pulled a delta', () => {
      // Its `setCheckpoint` replaced each row it advanced, which dropped the
      // protected cursor and the rule stamp that were in it.
      const pulledByEarlierBundle = cursorAt(95);
      beforeEach(async () => {
        for (const key of [CLIMBS_KEY, STATS_KEY, GRADES_KEY])
          await olderBundleSetCheckpoint(db, key, pulledByEarlierBundle);
      });

      it('costs one protected replay, at once and on any link', async () => {
        const server = backend();

        await sync(server.fetch, { ...options, isOnUnmeteredNetwork: () => false });

        for (const queryName of REFERENCE_QUERIES) {
          expect(server.requestsFor(queryName, 'REFERENCE').map((request) => request.cursor)).toEqual([
            pulledByEarlierBundle,
          ]);
          expect(server.requestsFor(queryName, 'PROTECTED').map((request) => request.cursor)).toEqual([undefined]);
        }
        expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(1);
        expect(await isScopeProtectedComplete(db, SCOPE_KEY)).toBe(true);
        expect(completions).toHaveLength(1);
      });

      // Nothing on the device says which rule the server that bundle reached was
      // applying, so its delta may have passed a climb it was not sent.
      it('and one more import over the board, on a link that is not metered', async () => {
        const server = backend();

        await sync(server.fetch, options);
        await sync(server.fetch, options);

        expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(2);
        expect(server.requestsFor('syncClimbs', 'REFERENCE').map((request) => request.cursor)).toEqual([
          ARTIFACT_WATERMARK,
          cursorAt(LAST_SEQUENCE),
        ]);
        expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
        expect(completions).toHaveLength(1);
      });
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

    it('does not import once more on a metered link: the paged pull brings the board back instead', async () => {
      await simulateOlderBundleRevalidation(db, VIEWER);
      const server = backend();

      await sync(server.fetch, { ...options, isOnUnmeteredNetwork: () => false });

      expect(snapshot.downloadArtifact).toHaveBeenCalledTimes(1);
      expect(server.requestsFor('syncClimbs', 'REFERENCE').map((request) => request.cursor)).toEqual([undefined]);
      expect(await localClimbs()).toEqual(ALL_CLIMB_UUIDS);
      expect(await isScopeDownloadComplete(db, SCOPE_KEY)).toBe(true);
    });
  });
});

// The retro-fit imports a grades artifact into a board that is already
// downloaded and has never pulled a grade. It keeps the rows whose climb is on
// the device and stamps the grades cursor at the file's real watermark, so the
// device has to hold every climb the build knew of first.
describe('retro-fitting grades into a board that is already downloaded', () => {
  /** A finished board whose grades were never pulled, with its climbs cursor at `climbsThrough`. */
  async function seedBoardWithoutGrades(climbsThrough: number): Promise<void> {
    const delivered = SERVER_CLIMBS.filter((climb) => Number(climb.cursor.syncSeq) <= climbsThrough).map((climb) => ({
      ...climb,
      grade: false,
    }));
    await sync(backend(delivered).fetch);
    await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [GRADES_KEY]);
    expect(await localGrades()).toEqual([]);
  }

  it('imports them once the board holds every climb of the build', async () => {
    await seedBoardWithoutGrades(50);
    const server = backend();
    const snapshot = artifactSource();

    await sync(server.fetch, { snapshotSource: snapshot.source });

    expect(snapshot.downloadGradesArtifact).toHaveBeenCalledTimes(1);
    expect(snapshot.downloadArtifact).not.toHaveBeenCalled();
    // The grades stream resumes from the file's watermark.
    expect(server.requestsFor('syncClimbGrades', 'REFERENCE').map((request) => request.cursor)).toEqual([
      ARTIFACT_WATERMARK,
    ]);
    expect(await localGrades()).toEqual(ALL_CLIMB_UUIDS);
  });

  it('crawls them instead while a climb the build knew of is not on the device yet', async () => {
    // The board last pulled its climbs at 11. The file was built at 50, and has
    // grade rows for climbs 40, 41 and 50, which are not here to match them to.
    await seedBoardWithoutGrades(11);
    const server = backend();
    const snapshot = artifactSource();

    await sync(server.fetch, { snapshotSource: snapshot.source });

    expect(snapshot.downloadGradesArtifact).not.toHaveBeenCalled();
    expect(server.requestsFor('syncClimbGrades', 'REFERENCE').map((request) => request.cursor)).toEqual([undefined]);
    // Every grade row arrived, the late climbs' included.
    expect(await localGrades()).toEqual(ALL_CLIMB_UUIDS);
  });
});
