import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

const invalidateRenderData = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../spray-wall-loader', () => ({
  invalidateSprayWallRenderData: invalidateRenderData,
  sprayWallRenderDataQueryKey: (wallUuid: string) => ['sprayWallRenderData', wallUuid, 'privacy-0'],
}));
vi.mock('../use-create-spray-wall', () => ({
  mySprayWallsQueryKey: ['mySprayWalls'],
  sprayWallWithVersionsQueryKey: (wallUuid: string) => ['sprayWallWithVersions', wallUuid],
}));

import { clearSprayWallRegistry, registerSprayWall, sprayWallArchiveState } from '../spray-wall-registry';
import { settleArchivedSprayWall } from '../settle-archived-spray-wall';

function registerOldWall() {
  registerSprayWall(31, {
    wallUuid: 'old-wall',
    angle: 40,
    version: 3,
    versionId: 3,
    photoWidth: 100,
    photoHeight: 100,
    photoUrl: 'https://example.invalid/wall.jpg',
    photoThumbUrl: null,
    photoExpiresAt: '2099-01-01T00:00:00.000Z',
    holds: [],
  });
}

beforeEach(() => {
  clearSprayWallRegistry();
  invalidateRenderData.mockClear();
});
afterEach(() => clearSprayWallRegistry());

describe('settleArchivedSprayWall', () => {
  // The replacement just published here: the old wall reads as archived in the
  // same frame, and is re-read so the server's own stamp replaces this one.
  it('marks a registered old wall archived at once and re-reads it', () => {
    registerOldWall();
    const client = new QueryClient();
    settleArchivedSprayWall(client, 'old-wall', 'new-wall');
    expect(sprayWallArchiveState('spray', 31)).toMatchObject({
      replacedByWallUuid: 'new-wall',
      holdsLocked: true,
      archivedAt: expect.any(String),
    });
    expect(invalidateRenderData).toHaveBeenCalledExactlyOnceWith(client, 'old-wall', 31);
  });

  it('refreshes the board lists either way, and the render cache of a wall it does not hold', () => {
    const client = new QueryClient();
    for (const key of [
      ['myBoards', undefined],
      ['mySprayWalls'],
      ['sprayWallWithVersions', 'old-wall'],
      ['sprayWallRenderData', 'old-wall', 'privacy-0'],
    ]) {
      client.setQueryData(key, {});
    }
    settleArchivedSprayWall(client, 'old-wall', 'new-wall');
    expect(invalidateRenderData).not.toHaveBeenCalled();
    expect(client.getQueryState(['myBoards', undefined])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['mySprayWalls'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['sprayWallWithVersions', 'old-wall'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['sprayWallRenderData', 'old-wall', 'privacy-0'])?.isInvalidated).toBe(true);
  });
});
