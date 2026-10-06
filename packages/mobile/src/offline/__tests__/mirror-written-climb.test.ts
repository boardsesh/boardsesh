import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
const mocks = vi.hoisted(() => ({
  epoch: 7,
  downloaded: true,
  enabled: true,
  purged: false,
  board: { uuid: 'wall', boardType: 'spray', layoutId: 12, sizeId: 12 },
  mirror: vi.fn(),
  request: vi.fn(),
  report: vi.fn(),
}));
vi.mock('@boardsesh/offline-sync', () => ({
  capturePurgeToken: () => ({}),
  hasPurgeLanded: () => mocks.purged,
  isSigningOut: () => false,
  isScopeDownloadComplete: () => Promise.resolve(mocks.downloaded),
  mirrorSavedClimb: mocks.mirror,
  offlineBoardKeyForBoard: () => 'spray:12:12',
  purgeNamespaceKey: () => 'spray:12',
}));
vi.mock('../../db', () => ({ getDatabaseHandle: () => ({}) }));
vi.mock('../../lib/active-board-store', () => ({ getStoredActiveBoard: () => Promise.resolve(mocks.board) }));
vi.mock('../../lib/auth-store', () => ({
  isAuthCredentialGenerationCurrent: (epoch: number) => epoch === mocks.epoch,
}));
vi.mock('../../lib/graphql/client', () => ({ getOfflineSyncHttpClient: () => ({ request: mocks.request }) }));
vi.mock('../../lib/error-reporting', () => ({ reportHandledError: mocks.report }));
vi.mock('../../lib/offline-engine', () => ({ isOfflineEngineEnabled: () => mocks.enabled }));
import { mirrorWrittenClimb } from '../mirror-written-climb';
const write = { boardType: 'spray', climbUuid: 'saved-climb', layoutId: 12, sizeId: 12, authEpoch: 7 };
const documents = { viewerId: 'viewer', climb: { uuid: 'saved-climb' }, stats: [] };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.epoch = 7;
  mocks.downloaded = true;
  mocks.enabled = true;
  mocks.purged = false;
  mocks.request.mockResolvedValue({ syncClimbDocuments: documents });
  mocks.mirror.mockResolvedValue(true);
});

describe('mirror a written climb on the downloaded active board', () => {
  it('fetches the exact saved UUID and unlisted capability before local mirroring', async () => {
    await mirrorWrittenClimb(write);
    expect(mocks.request).toHaveBeenCalledWith(expect.any(String), {
      boardType: 'spray',
      layoutId: 12,
      climbUuid: 'saved-climb',
      sprayWallUuid: 'wall',
    });
    expect(mocks.mirror).toHaveBeenCalledWith(
      expect.any(Object),
      mocks.board,
      'saved-climb',
      documents,
      expect.any(Function),
    );
  });
  it('skips undownloaded or different scopes', async () => {
    mocks.downloaded = false;
    await mirrorWrittenClimb(write);
    mocks.downloaded = true;
    await mirrorWrittenClimb({ ...write, layoutId: 13 });
    await mirrorWrittenClimb({ ...write, boardType: 'kilter' });
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.mirror).not.toHaveBeenCalled();
  });
  it('does not write a late response after an account transition or scope purge', async () => {
    mocks.request.mockImplementation(async () => {
      mocks.epoch += 1;
      return { syncClimbDocuments: documents };
    });
    await mirrorWrittenClimb(write);
    mocks.epoch = 7;
    mocks.request.mockImplementation(async () => {
      mocks.purged = true;
      return { syncClimbDocuments: documents };
    });
    await mirrorWrittenClimb(write);
    expect(mocks.mirror).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it('reports an unavailable canonical response without writing local rows', async () => {
    mocks.request.mockResolvedValue({ syncClimbDocuments: null });
    await expect(mirrorWrittenClimb(write)).rejects.toThrow('Saved climb is unavailable for local mirroring');
    expect(mocks.mirror).not.toHaveBeenCalled();
    expect(mocks.report).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Saved climb is unavailable for local mirroring' }),
      { tags: { source: 'offline-sync', kind: 'saved-climb-mirror' } },
    );
  });
  it('reports a mirror failure to the shared successful-save fallback', async () => {
    const failure = new Error('SQLite unavailable');
    mocks.mirror.mockRejectedValue(failure);
    await expect(mirrorWrittenClimb(write)).rejects.toBe(failure);
    expect(mocks.report).toHaveBeenCalledWith(failure, expect.any(Object));
  });
});
