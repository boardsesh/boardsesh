import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  enabled: [] as string[],
  forgetOfflineBoard: vi.fn(),
  forgetSprayWallArchive: vi.fn(),
  setOfflineBoardEnabled: vi.fn(),
  forgetOfflineBoardScope: vi.fn(),
  forgetDownloadTrigger: vi.fn(),
}));
vi.mock('../../../settings', () => ({
  getSetting: () => settings.enabled,
  offlineBoardKey: (scope: { boardType: string; layoutId: number; sizeId: number }) =>
    `${scope.boardType}:${scope.layoutId}:${scope.sizeId}`,
  forgetOfflineBoard: settings.forgetOfflineBoard,
  forgetSprayWallArchive: settings.forgetSprayWallArchive,
  setOfflineBoardEnabled: settings.setOfflineBoardEnabled,
  forgetOfflineBoardScope: settings.forgetOfflineBoardScope,
  forgetDownloadTrigger: settings.forgetDownloadTrigger,
}));
const clearCaches = vi.hoisted(() => vi.fn());
vi.mock('../spray-privacy-cleanup', () => ({ clearSprayWallPrivateCaches: clearCaches }));
const reportAbandoned = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../../offline/abandoned-download-terminals', () => ({ reportAbandonedDownloadOnDisable: reportAbandoned }));

import { forgetDeletedSprayWall } from '../forget-deleted-spray-wall';

const db = {} as Parameters<typeof forgetDeletedSprayWall>[1];

beforeEach(() => {
  vi.clearAllMocks();
  settings.enabled = [];
});

describe('forgetDeletedSprayWall', () => {
  it('forgets the card, the archive state and the private caches', async () => {
    await forgetDeletedSprayWall({ uuid: 'old-wall', layoutId: 77 }, db);
    expect(settings.forgetOfflineBoard).toHaveBeenCalledWith('old-wall');
    expect(settings.forgetSprayWallArchive).toHaveBeenCalledWith('old-wall');
    expect(clearCaches).toHaveBeenCalledWith(77);
    expect(settings.setOfflineBoardEnabled).not.toHaveBeenCalled();
  });

  // A wall's scope is its own, so turning it off takes no sibling's climbs.
  it('turns its own download off and closes the download funnel', async () => {
    settings.enabled = ['spray:77:77'];
    await forgetDeletedSprayWall({ uuid: 'old-wall', layoutId: 77 }, db);
    const scope = { boardType: 'spray', layoutId: 77, sizeId: 77 };
    expect(settings.setOfflineBoardEnabled).toHaveBeenCalledWith(scope, false);
    expect(settings.forgetOfflineBoardScope).toHaveBeenCalledWith(scope);
    expect(settings.forgetDownloadTrigger).toHaveBeenCalledWith('spray:77:77');
    expect(reportAbandoned).toHaveBeenCalledWith(db, 'spray:77:77');
  });
});
