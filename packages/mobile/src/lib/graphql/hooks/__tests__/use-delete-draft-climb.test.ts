import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations, enqueue, climbMutationEntityKey } from '@boardsesh/offline-sync';
import { createTestDatabase, __resetDrainerStateForTests, type TestSqliteDb } from '@boardsesh/offline-sync/testing';

const invalidateQueries = vi.fn();
vi.mock('@tanstack/react-query', () => ({
  useMutation: (config: unknown) => config,
  useQueryClient: () => ({ invalidateQueries }),
}));
const request = vi.fn();
vi.mock('../../client', () => ({ getHttpClient: () => ({ request }) }));
let db: TestSqliteDb;
vi.mock('../../../../db', () => ({ getDatabaseHandle: () => db }));
vi.mock('../../../auth-store', () => ({
  captureAuthCredentialGeneration: () => 7,
  isAuthCredentialGenerationCurrent: () => true,
}));
vi.mock('../../../offline-engine', () => ({ isOfflineEngineEnabled: () => true }));
vi.mock('../../../error-reporting', () => ({ reportHandledError: vi.fn() }));
import { useDeleteDraftClimb } from '../use-delete-draft-climb';

type MutationConfig<TVariables> = {
  mutationFn: (variables: TVariables) => Promise<unknown>;
  onSuccess?: (result: unknown, variables: TVariables) => void;
};
const asConfig = <TVariables>(hook: unknown): MutationConfig<TVariables> => hook as MutationConfig<TVariables>;

beforeEach(async () => {
  invalidateQueries.mockClear();
  request.mockReset();
  __resetDrainerStateForTests();
  db = createTestDatabase();
  await runMigrations(db);
});

describe('downloaded draft deletion', () => {
  const variables = { uuid: 'spray-draft', boardType: 'spray' };

  it('removes the downloaded draft before the final list invalidation', async () => {
    await db.runAsync(
      "INSERT INTO board_climbs (uuid, board_type, layout_id, is_draft) VALUES ('spray-draft', 'spray', 42, 1)",
    );
    request.mockResolvedValue({ deleteDraftClimb: true });
    const { mutationFn, onSuccess } = asConfig<typeof variables>(useDeleteDraftClimb());
    const result = await mutationFn(variables);
    expect(await db.getFirstAsync('SELECT uuid FROM board_climbs WHERE uuid = ?', [variables.uuid])).not.toBeNull();
    onSuccess?.(result, variables);
    await vi.waitFor(async () => {
      expect(await db.getFirstAsync('SELECT uuid FROM board_climbs WHERE uuid = ?', [variables.uuid])).toBeNull();
      expect(invalidateQueries.mock.calls.filter(([options]) => options.queryKey[0] === 'searchClimbs')).toHaveLength(
        2,
      );
    });
  });

  it.each(['pending', 'dead_letter'])('refuses deletion with a %s climb write', async (status) => {
    await enqueue(db, 'board_climbs', 'update', {}, 'climb-edit', {
      entityKey: climbMutationEntityKey('spray', variables.uuid),
    });
    await db.runAsync('UPDATE pending_mutations SET status = ?', [status]);
    const { mutationFn } = asConfig<typeof variables>(useDeleteDraftClimb());
    await expect(mutationFn(variables)).rejects.toThrow('Sync your saved climb');
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['pending', 'dead_letter'])('refuses deletion while a %s draft tick can still be synced', async (status) => {
    await enqueue(db, 'boardsesh_ticks', 'create', { boardType: 'spray', climbUuid: variables.uuid }, 'queued-tick');
    await db.runAsync('UPDATE pending_mutations SET status = ?', [status]);
    const { mutationFn } = asConfig<typeof variables>(useDeleteDraftClimb());
    await expect(mutationFn(variables)).rejects.toMatchObject({ extensions: { code: 'CLIMB_HAS_TICKS' } });
    expect(request).not.toHaveBeenCalled();
  });
});
