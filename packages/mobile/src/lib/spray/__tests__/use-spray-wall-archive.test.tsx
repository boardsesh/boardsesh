// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearSprayWallRegistry,
  LIVE_SPRAY_WALL_ARCHIVE_STATE,
  markSprayWallArchived,
  registerSprayWall,
} from '../spray-wall-registry';
import { useSprayWallArchiveState, useSprayWallIsArchived } from '../use-spray-wall-archive';

function registerWall(holdsLocked = false) {
  registerSprayWall(55, {
    wallUuid: 'wall-55',
    angle: 40,
    version: 1,
    versionId: 1,
    photoWidth: 100,
    photoHeight: 100,
    photoUrl: 'https://example.invalid/wall.jpg',
    photoThumbUrl: null,
    photoExpiresAt: '2099-01-01T00:00:00.000Z',
    holds: [],
    archive: { ...LIVE_SPRAY_WALL_ARCHIVE_STATE, holdsLocked },
  });
}

afterEach(() => clearSprayWallRegistry());

describe('the archive readers', () => {
  it('read nothing until the wall registers, then follow it', () => {
    const { result } = renderHook(() => ({
      archive: useSprayWallArchiveState('spray', 55),
      archived: useSprayWallIsArchived('spray', 55),
    }));
    expect(result.current.archive).toBeNull();
    expect(result.current.archived).toBe(false);

    act(() => registerWall(true));
    expect(result.current.archive?.holdsLocked).toBe(true);
    expect(result.current.archived).toBe(false);

    act(() =>
      markSprayWallArchived(55, 'wall-55', { archivedAt: '2026-10-06T10:00:00.000Z', replacedByWallUuid: null }),
    );
    expect(result.current.archived).toBe(true);
    expect(result.current.archive?.archivedAt).toBe('2026-10-06T10:00:00.000Z');
  });

  it('never reads a catalogue board as archived', () => {
    registerWall(true);
    const { result } = renderHook(() => useSprayWallArchiveState('kilter', 55));
    expect(result.current).toBeNull();
  });
});
