import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  recordOpenedSprayWall,
  resolveSprayWallCapability,
  forgetSprayWallCapability,
  rememberSprayWallDownloadCapability,
} from '../opened-spray-wall-pins';
import type { UserBoard } from '@boardsesh/shared-schema';

const stored = vi.hoisted(() => new Map<string, unknown>());
const identity = vi.hoisted(() => ({ userId: 'climber' }));
vi.mock('../../settings/hooks', () => ({
  getSetting: (key: string) => stored.get(key) ?? null,
  setSetting: (key: string, content: unknown) => stored.set(key, content),
}));
vi.mock('../../lib/local-user-id', () => ({ readLocalUserId: async () => identity.userId }));
vi.mock('../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => 1,
  isAuthCredentialGenerationCurrent: () => true,
}));

const wall = (layoutId = 42) => ({ boardType: 'spray', uuid: `wall-${layoutId}`, layoutId, sizeId: layoutId });

describe('opened spray wall offline identities', () => {
  beforeEach(() => {
    stored.clear();
    stored.set('syncEnabledBoards', []);
    identity.userId = 'climber';
  });

  it('downloads the first actual opening once and respects later disabling', () => {
    expect(recordOpenedSprayWall('climber', wall())).toBe(true);
    expect(recordOpenedSprayWall('climber', wall())).toBe(false);
  });

  it('preserves an owned wall explicitly disabled before upgrading', () => {
    stored.set('offlineOwnedSprayWallsV1', { userId: 'climber', wallUuids: ['wall-42'] });
    expect(recordOpenedSprayWall('climber', wall())).toBe(false);
  });

  it('keeps every downloaded link capability independently of the recent-card cap', async () => {
    for (let layoutId = 1; layoutId <= 30; layoutId++) recordOpenedSprayWall('climber', wall(layoutId));
    expect(await resolveSprayWallCapability({ boardType: 'spray', layoutId: 1, sizeId: 1 })).toBe('wall-1');
    expect(await resolveSprayWallCapability({ boardType: 'spray', layoutId: 30, sizeId: 30 })).toBe('wall-30');
  });

  it('never supplies another account or layout with the held capability', async () => {
    recordOpenedSprayWall('climber', wall());
    identity.userId = 'next-climber';
    expect(await resolveSprayWallCapability({ boardType: 'spray', layoutId: 42, sizeId: 42 })).toBeUndefined();
    identity.userId = 'climber';
    expect(await resolveSprayWallCapability({ boardType: 'spray', layoutId: 43, sizeId: 43 })).toBeUndefined();
  });

  it('removes the capability while retaining the explicit removal choice', async () => {
    recordOpenedSprayWall('climber', wall());
    forgetSprayWallCapability({ boardType: 'spray', layoutId: 42, sizeId: 42 });
    expect(recordOpenedSprayWall('climber', wall())).toBe(false);
    expect(await resolveSprayWallCapability({ boardType: 'spray', layoutId: 42, sizeId: 42 })).toBeUndefined();
  });

  it('does not let a delayed enable restore a removed link or erase another opening', async () => {
    recordOpenedSprayWall('climber', wall());
    const pending = rememberSprayWallDownloadCapability([wall() as UserBoard]);
    recordOpenedSprayWall('climber', wall(43));
    forgetSprayWallCapability({ boardType: 'spray', layoutId: 42, sizeId: 42 });
    await pending;
    expect(await resolveSprayWallCapability({ boardType: 'spray', layoutId: 42, sizeId: 42 })).toBeUndefined();
    expect(await resolveSprayWallCapability({ boardType: 'spray', layoutId: 43, sizeId: 43 })).toBe('wall-43');
  });
});
