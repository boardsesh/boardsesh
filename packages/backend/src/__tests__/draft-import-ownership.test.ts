import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { rowsFromResult } from '@boardsesh/db/client';
import {
  auroraExportSchema,
  buildCoordinateMap,
  importJsonExportData,
  syncSharedData,
  upsertTableData,
} from '@boardsesh/aurora-sync/sync';
import { LAYOUTS } from '@boardsesh/board-constants/product-sizes';
import type { Climb } from '@boardsesh/aurora-sync/api';
import { db } from '../db/client';

// ---------------------------------------------------------------------------
// Who owns an imported draft (real Postgres).
//
// A draft is returned to its owner alone, and a draft with no owner to no one.
// So every import that writes one stamps the Boardsesh account it runs for,
// and nothing that re-sends the row afterwards may clear that owner: not the
// same import again, not a run with no account behind it, not a second account
// linked to the same manufacturer account, and not the catalogue sync. The
// owner stays when upstream publishes the draft too: a published, listed climb
// is public whoever owns it, so there is nothing to release.
//
// The draft import writes over drafts only. A climb that is already published
// is not turned back into a draft by it, whether or not it has an owner.
// ---------------------------------------------------------------------------

const { mockSharedSync } = vi.hoisted(() => ({ mockSharedSync: vi.fn() }));

// The only network call in syncSharedData; every write behind it is real.
vi.mock('../../../aurora-sync/src/api/shared-sync-api', () => ({ sharedSync: mockSharedSync }));

const BOARD = 'tension';
const AURORA_USER_ID = 880_001;
const IMPORTER = 'draft-import-owner';
const SECOND_LINKED_ACCOUNT = 'draft-import-second-account';
const USERS = [IMPORTER, SECOND_LINKED_ACCOUNT];

const describeWithDatabase = process.env.SKIP_TEST_INFRA === '1' ? describe.skip : describe;

type StoredClimb = {
  user_id: string | null;
  is_draft: boolean | null;
  is_listed: boolean | null;
  synced: boolean;
  name: string | null;
  setter_id: number | null;
};

async function storedClimb(uuid: string): Promise<StoredClimb> {
  const [row] = rowsFromResult<StoredClimb>(
    await db.execute(sql`
      SELECT user_id, is_draft, is_listed, synced, name, setter_id FROM board_climbs WHERE uuid = ${uuid}`),
  );
  if (!row) throw new Error(`no climb ${uuid}`);
  return row;
}

let tagCounter = 0;
function uniqueUuid(label: string): string {
  tagCounter += 1;
  return `draft-import-${process.pid}-${tagCounter}-${label}`;
}

/** One row of Aurora's `draft_climbs` user-sync table, as the API sends it: every value a string. */
function auroraDraft(uuid: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    uuid,
    layout_id: '9',
    setter_username: 'upstream-setter',
    name: 'Unfinished idea',
    description: '',
    hsm: '1',
    edge_left: '0',
    edge_right: '100',
    edge_bottom: '0',
    edge_top: '100',
    angle: '40',
    frames_count: '1',
    frames_pace: '0',
    frames: 'p1r5',
    created_at: '2026-06-01 10:00:00',
    ...overrides,
  };
}

/** One row of Aurora's shared `climbs` table. */
function catalogueClimb(uuid: string, overrides: Partial<Climb> = {}): Climb {
  return {
    uuid,
    name: 'Unfinished idea',
    description: '',
    hsm: 1,
    edge_left: 0,
    edge_right: 100,
    edge_bottom: 0,
    edge_top: 100,
    frames_count: 1,
    frames_pace: 0,
    frames: 'p1r5',
    setter_id: AURORA_USER_ID,
    setter_username: 'upstream-setter',
    layout_id: 9,
    is_draft: false,
    is_listed: true,
    created_at: '2026-06-01 10:00:00',
    updated_at: '2026-06-02 10:00:00',
    angle: 40,
    ...overrides,
  };
}

// The user sync pins the postgres-js driver in its own db type; the backend's
// handle is the same driver under a wider schema type.
const userSyncDb = db as unknown as Parameters<typeof upsertTableData>[0];

const importDraft = (accountId: string, draft: Record<string, string>) =>
  upsertTableData(userSyncDb, BOARD, 'draft_climbs', AURORA_USER_ID, accountId, [draft], () => {});

async function runCatalogueSync(climbs: Climb[]): Promise<void> {
  mockSharedSync.mockReset();
  mockSharedSync.mockResolvedValue({ _complete: true, climbs });
  await syncSharedData(db, BOARD, 'token', () => {});
}

async function removeFixtures(): Promise<void> {
  await db.execute(
    sql`DELETE FROM board_climbs WHERE uuid LIKE 'draft-import-%' OR user_id IN (${sql.join(USERS, sql`, `)})`,
  );
  await db.execute(sql`DELETE FROM users WHERE id IN (${sql.join(USERS, sql`, `)})`);
}

describeWithDatabase('imported drafts: the importing account is the owner (real DB)', () => {
  beforeAll(async () => {
    await removeFixtures();
    for (const userId of USERS) {
      await db.execute(
        sql`INSERT INTO users (id, name, email) VALUES (${userId}, ${userId}, ${`${userId}@example.test`})`,
      );
    }
  });
  afterAll(removeFixtures);
  beforeEach(() => {
    mockSharedSync.mockReset();
  });

  describe('the user sync’s draft import', () => {
    it('stamps the account the import runs for', async () => {
      const uuid = uniqueUuid('stamp');
      await importDraft(IMPORTER, auroraDraft(uuid));
      expect(await storedClimb(uuid)).toEqual({
        user_id: IMPORTER,
        is_draft: true,
        is_listed: false,
        // Still upstream's climb: Boardsesh did not mint it.
        synced: true,
        name: 'Unfinished idea',
        setter_id: AURORA_USER_ID,
      });
    });

    it('keeps the owner when the same account imports the draft again, and still takes the edit', async () => {
      const uuid = uniqueUuid('reimport');
      await importDraft(IMPORTER, auroraDraft(uuid));
      await importDraft(IMPORTER, auroraDraft(uuid, { name: 'Renamed upstream' }));
      expect(await storedClimb(uuid)).toMatchObject({ user_id: IMPORTER, is_draft: true, name: 'Renamed upstream' });
    });

    it('does not clear the owner when a run has no Boardsesh account behind it', async () => {
      const uuid = uniqueUuid('no-account');
      await importDraft(IMPORTER, auroraDraft(uuid));
      await importDraft('', auroraDraft(uuid));
      expect((await storedClimb(uuid)).user_id).toBe(IMPORTER);
    });

    it('does not hand the draft to a second account linked to the same manufacturer account', async () => {
      const uuid = uniqueUuid('second-account');
      await importDraft(IMPORTER, auroraDraft(uuid));
      await importDraft(SECOND_LINKED_ACCOUNT, auroraDraft(uuid));
      expect((await storedClimb(uuid)).user_id).toBe(IMPORTER);
    });

    it('does not take back to a draft a climb its owner has published in Boardsesh', async () => {
      const uuid = uniqueUuid('published-here');
      await importDraft(IMPORTER, auroraDraft(uuid));
      await db.execute(sql`UPDATE board_climbs SET is_draft = false, is_listed = true WHERE uuid = ${uuid}`);

      // Upstream still holds the draft it once was, and re-sends it edited.
      await importDraft(IMPORTER, auroraDraft(uuid, { name: 'Edited upstream', frames: 'p9r9' }));
      expect(await storedClimb(uuid)).toMatchObject({
        user_id: IMPORTER,
        is_draft: false,
        is_listed: true,
        name: 'Unfinished idea',
      });
    });

    it('leaves a published climb nobody owns as it is: still published, still nobody’s', async () => {
      const uuid = uniqueUuid('catalogue-published');
      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, name, frames, is_draft, is_listed, synced)
        VALUES (${uuid}, ${BOARD}, 9, 'Published upstream', 'p1r5', false, true, true)
      `);
      // A stale draft row for a climb the catalogue already holds as published.
      await importDraft(IMPORTER, auroraDraft(uuid, { frames: 'p9r9' }));
      expect(await storedClimb(uuid)).toEqual({
        user_id: null,
        is_draft: false,
        is_listed: true,
        synced: true,
        name: 'Published upstream',
        setter_id: null,
      });
    });

    it('leaves a draft with no owner when the run has no account, and gives it one on the next import', async () => {
      const uuid = uniqueUuid('ownerless');
      await importDraft('', auroraDraft(uuid));
      expect((await storedClimb(uuid)).user_id).toBeNull();

      await importDraft(IMPORTER, auroraDraft(uuid));
      expect((await storedClimb(uuid)).user_id).toBe(IMPORTER);
    });
  });

  describe('the catalogue sync, on a draft that has an owner', () => {
    it('keeps the owner and the draft flag while upstream still sends a draft', async () => {
      const uuid = uniqueUuid('still-draft');
      await importDraft(IMPORTER, auroraDraft(uuid));
      await runCatalogueSync([catalogueClimb(uuid, { is_draft: true, is_listed: false, name: 'Renamed upstream' })]);
      expect(await storedClimb(uuid)).toMatchObject({
        user_id: IMPORTER,
        is_draft: true,
        is_listed: false,
        name: 'Renamed upstream',
      });
    });

    it('publishes it when upstream does, and its owner keeps it', async () => {
      const uuid = uniqueUuid('published');
      await importDraft(IMPORTER, auroraDraft(uuid));
      await runCatalogueSync([catalogueClimb(uuid)]);
      // Published upstream: public from here on, and still its setter's climb.
      expect(await storedClimb(uuid)).toMatchObject({ user_id: IMPORTER, is_draft: false, is_listed: true });

      // Unlisted upstream afterwards: the owner still has it, and nobody else does.
      await runCatalogueSync([catalogueClimb(uuid, { is_listed: false })]);
      expect(await storedClimb(uuid)).toMatchObject({ user_id: IMPORTER, is_draft: false, is_listed: false });

      // Re-drafted upstream: the same.
      await runCatalogueSync([catalogueClimb(uuid, { is_draft: true, is_listed: false })]);
      expect(await storedClimb(uuid)).toMatchObject({ user_id: IMPORTER, is_draft: true, is_listed: false });
    });

    it('never touches the owner or the flags of a climb Boardsesh minted', async () => {
      const draftUuid = uniqueUuid('minted-draft');
      const publishedUuid = uniqueUuid('minted-published');
      for (const [uuid, isDraft] of [
        [draftUuid, true],
        [publishedUuid, false],
      ] as const) {
        await db.execute(sql`
          INSERT INTO board_climbs (uuid, board_type, layout_id, name, frames, is_draft, is_listed, user_id, synced)
          VALUES (${uuid}, ${BOARD}, 9, 'Set in Boardsesh', 'p1r5', ${isDraft}, ${!isDraft}, ${IMPORTER}, false)
        `);
      }
      // A uuid collision with upstream, in both directions.
      await runCatalogueSync([
        catalogueClimb(draftUuid, { is_draft: false, is_listed: true }),
        catalogueClimb(publishedUuid, { is_draft: true, is_listed: false }),
      ]);
      expect(await storedClimb(draftUuid)).toMatchObject({ user_id: IMPORTER, is_draft: true, is_listed: false });
      expect(await storedClimb(publishedUuid)).toMatchObject({ user_id: IMPORTER, is_draft: false, is_listed: true });
    });

    // An imported climb stays upstream's climb after its owner publishes it
    // here: the next time upstream re-sends the row, upstream's flags are the
    // ones stored. The owner is never part of that.
    it('takes upstream’s flags for an imported climb whatever was done to it here, and keeps its owner', async () => {
      const uuid = uniqueUuid('published-here');
      await importDraft(IMPORTER, auroraDraft(uuid));
      await db.execute(sql`UPDATE board_climbs SET is_draft = false, is_listed = true WHERE uuid = ${uuid}`);
      await runCatalogueSync([catalogueClimb(uuid, { is_draft: true, is_listed: false })]);
      expect(await storedClimb(uuid)).toMatchObject({ user_id: IMPORTER, is_draft: true, is_listed: false });
    });

    it('still takes upstream’s flags verbatim for a catalogue climb nobody owns', async () => {
      const uuid = uniqueUuid('catalogue');
      await runCatalogueSync([catalogueClimb(uuid)]);
      expect(await storedClimb(uuid)).toMatchObject({ user_id: null, is_draft: false, is_listed: true });
      await runCatalogueSync([catalogueClimb(uuid, { is_draft: true, is_listed: false })]);
      expect(await storedClimb(uuid)).toMatchObject({ user_id: null, is_draft: true, is_listed: false });
    });
  });

  describe('the account export import', () => {
    const importDb = db as unknown as Parameters<typeof importJsonExportData>[0];
    // A real layout and a real hold of it: the import drops a climb whose layout
    // name or hold coordinates it cannot resolve against the board catalogue.
    const [layout] = Object.values(LAYOUTS[BOARD]);
    const [coordinates] = [...buildCoordinateMap(BOARD, layout.id).keys()];
    const [holdX, holdY] = coordinates.split(',').map(Number);
    const exportWithDraft = (name: string) =>
      auroraExportSchema.parse({
        user: { username: 'upstream-setter' },
        climbs: [
          {
            name,
            layout: layout.name,
            created_at: '2026-06-01 10:00:00',
            is_draft: true,
            holds: [{ x: holdX, y: holdY, role: 'start' }],
          },
        ],
      });

    async function importedDrafts(name: string) {
      return rowsFromResult<{ uuid: string; user_id: string | null; is_draft: boolean | null }>(
        await db.execute(sql`
          SELECT uuid, user_id, is_draft FROM board_climbs
          WHERE board_type = ${BOARD} AND name = ${name} AND uuid LIKE 'json-import-climb-%' ORDER BY user_id`),
      );
    }

    it('stamps the importing account, keeps it on a second import, and never shares a row between accounts', async () => {
      const name = `Draft import ${process.pid}`;
      const first = await importJsonExportData(importDb, IMPORTER, BOARD, exportWithDraft(name));
      expect(first.climbs).toEqual({ imported: 1, skipped: 0, failed: 0 });
      await importJsonExportData(importDb, IMPORTER, BOARD, exportWithDraft(name));
      expect(await importedDrafts(name)).toEqual([{ uuid: expect.any(String), user_id: IMPORTER, is_draft: true }]);

      // Another account importing the same file writes its own row.
      await importJsonExportData(importDb, SECOND_LINKED_ACCOUNT, BOARD, exportWithDraft(name));
      const rows = await importedDrafts(name);
      expect(rows.map((row) => row.user_id)).toEqual([IMPORTER, SECOND_LINKED_ACCOUNT]);
      expect(new Set(rows.map((row) => row.uuid)).size).toBe(2);
    });
  });
});
