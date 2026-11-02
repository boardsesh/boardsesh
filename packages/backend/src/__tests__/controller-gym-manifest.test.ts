import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const mocked = vi.hoisted(() => ({
  select: vi.fn(),
  requireGymOwnerOrAdmin: vi.fn(),
  byUuid: vi.fn(),
  bySlug: vi.fn(),
  preview: vi.fn(),
}));
vi.mock('../db/client', () => ({ db: { select: mocked.select } }));
vi.mock('../graphql/resolvers/social/gyms', () => ({
  requireGymOwnerOrAdmin: mocked.requireGymOwnerOrAdmin,
  resolveCanonicalGymByUuid: mocked.byUuid,
  resolveCanonicalGymBySlug: mocked.bySlug,
}));
vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn(async () => undefined) }));
vi.mock('../services/controller-preview', async (original) => ({
  ...(await original<typeof import('../services/controller-preview')>()),
  getControllerPreview: mocked.preview,
}));
import { controllerGymQueries, validateControllerGymBoards } from '../graphql/resolvers/controller/gym-manifest';

const gym = {
  id: 8,
  uuid: 'e52f8478-d7c8-4464-9462-7120cdbb783c',
  slug: 'boardsesh-qa',
  name: 'Boardsesh QA',
  isPublic: true,
  isListed: false,
};
const board = {
  uuid: 'first-board',
  name: 'QA Kilter',
  boardType: 'kilter',
  serialNumber: 'QA-KILTER-01',
  layoutId: 8,
  sizeId: 25,
  setIds: '26,27,28,29',
  angle: 40,
};
const context = {
  connectionId: 'controller-connection',
  isAuthenticated: false,
  controllerId: 'controller-id',
  controllerApiKey: 'registered-key',
} as ConnectionContext;

function rows(...responses: unknown[][]) {
  mocked.select.mockImplementation(() => {
    const result = responses.shift() ?? [];
    const chain = { from: () => chain, where: () => chain, orderBy: () => chain, limit: async () => result };
    return chain;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.bySlug.mockResolvedValue(gym);
  mocked.byUuid.mockResolvedValue(gym);
  mocked.requireGymOwnerOrAdmin.mockResolvedValue(gym);
  mocked.preview.mockResolvedValue({
    image: Buffer.from('jpeg'),
    geometry: Buffer.from('geometry'),
    width: 237,
    height: 330,
    positionCount: 499,
    imageSha256: 'a'.repeat(64),
    geometrySha256: 'b'.repeat(64),
  });
});

describe('controller gym manifest', () => {
  it('checks the registered owner/admin identity without upgrading the controller to a user session', async () => {
    rows([{ userId: 'maintainer-user' }], [board]);
    const result = await controllerGymQueries.controllerGymManifest(null, { gymRef: 'boardsesh-qa' }, context);
    expect(mocked.requireGymOwnerOrAdmin).toHaveBeenCalledWith(gym.uuid, 'maintainer-user');
    expect(result).toMatchObject({
      version: 1,
      gymUuid: gym.uuid,
      name: gym.name,
      slug: gym.slug,
      boards: [{ serialNumber: 'QA-KILTER-01', advertisedName: 'Kilter Board#QA-KILTER-01@3' }],
    });
    expect(context.isAuthenticated).toBe(false);
    expect(context.userId).toBeUndefined();
  });

  it('fails closed after revocation or for an unowned registration', async () => {
    for (const registrations of [[], [{ userId: null }]]) {
      rows(registrations);
      await expect(controllerGymQueries.controllerGymManifest(null, { gymRef: gym.slug }, context)).rejects.toThrow(
        'owner',
      );
    }
    expect(mocked.preview).not.toHaveBeenCalled();
  });

  it('refuses editor-only or stranger registrations before returning serials or building art', async () => {
    rows([{ userId: 'editor-user' }]);
    mocked.requireGymOwnerOrAdmin.mockRejectedValueOnce(new Error('Not authorized: must be gym owner or admin'));
    await expect(controllerGymQueries.controllerGymManifest(null, { gymRef: gym.uuid }, context)).rejects.toMatchObject(
      {
        extensions: { code: 'FORBIDDEN' },
      },
    );
    expect(mocked.preview).not.toHaveBeenCalled();
  });

  it('requires controller authentication even when a normal user session exists', async () => {
    await expect(
      controllerGymQueries.controllerGymManifest(null, { gymRef: gym.slug }, {
        connectionId: 'user',
        userId: 'maintainer-user',
        isAuthenticated: true,
      } as ConnectionContext),
    ).rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } });
    expect(mocked.select).not.toHaveBeenCalled();
  });

  it.each([
    { controllerId: undefined, controllerApiKey: undefined },
    { controllerId: 'controller-id', controllerApiKey: undefined },
    { controllerId: undefined, controllerApiKey: 'rejected-key' },
  ])('explicitly denies an initial WS context lacking valid controller authentication %#', async (credentials) => {
    await expect(
      controllerGymQueries.controllerGymManifest(null, { gymRef: gym.slug }, { ...context, ...credentials }),
    ).rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } });
    expect(mocked.preview).not.toHaveBeenCalled();
  });

  it('sorts deterministically and preserves the MoonBoard prefix with an optional fixture serial', () => {
    const moonboard = {
      ...board,
      uuid: 'moon',
      boardType: 'moonboard',
      serialNumber: 'QA-MOON-01',
      layoutId: 3,
      sizeId: 1,
      setIds: '5,6,7,8,9,10',
    };
    expect(validateControllerGymBoards([moonboard, board]).map((entry) => entry.advertisedName)).toEqual([
      'Kilter Board#QA-KILTER-01@3',
      'MoonBoard A#QA-MOON-01',
    ]);
  });

  it('rejects oversized, missing, duplicate, and unsupported manifests as a whole', () => {
    expect(() => validateControllerGymBoards([])).toThrow();
    expect(() => validateControllerGymBoards(Array.from({ length: 4 }, () => board))).toThrow();
    expect(() => validateControllerGymBoards([{ ...board, serialNumber: null }])).toThrow();
    expect(() =>
      validateControllerGymBoards([board, { ...board, uuid: 'other', serialNumber: 'QA-OTHER-01' }]),
    ).toThrow('duplicate');
    expect(() =>
      validateControllerGymBoards([
        board,
        { ...board, boardType: 'tension', layoutId: 10, sizeId: 6, setIds: '12,13' },
      ]),
    ).toThrow('duplicate');
    expect(() => validateControllerGymBoards([{ ...board, boardType: 'spray' }])).toThrow();
    expect(() => validateControllerGymBoards([{ ...board, serialNumber: 'A'.repeat(32) }])).toThrow('advertisement');
  });

  it('reserves the local-name AD overhead in the 31-byte scan response', () => {
    expect(validateControllerGymBoards([{ ...board, serialNumber: 'A'.repeat(14) }])[0].advertisedName).toHaveLength(
      29,
    );
    expect(() => validateControllerGymBoards([{ ...board, serialNumber: 'A'.repeat(15) }])).toThrow('advertisement');
  });

  it('does not turn a storage outage into an explicit permission revocation', async () => {
    rows([{ userId: 'maintainer-user' }]);
    const outage = new Error('Database connection lost');
    mocked.requireGymOwnerOrAdmin.mockRejectedValueOnce(outage);
    await expect(controllerGymQueries.controllerGymManifest(null, { gymRef: gym.uuid }, context)).rejects.toBe(outage);
  });
});
