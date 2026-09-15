import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

const request = vi.fn();
vi.mock('../../graphql/client', () => ({
  getHttpClient: () => ({ request }),
}));

import { adoptSprayWallFromLink, sprayWallByLayoutQueryKey } from '../spray-wall-loader';
import { isWallUuidParam } from '../use-spray-wall-link';
import {
  clearSprayWallRegistry,
  getSprayWallLoadState,
  setSprayWallLoader,
  unregisterSprayWall,
} from '../spray-wall-registry';

const WALL_UUID = '11111111-2222-3333-4444-555555555555';

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  request.mockReset();
  clearSprayWallRegistry();
});

describe('adoptSprayWallFromLink', () => {
  it('seeds the by-layout cache so a later reader never asks the refusing query', async () => {
    const wall = { uuid: WALL_UUID, layoutId: 4242 };
    request.mockResolvedValue({ sprayWall: wall });
    const queryClient = makeQueryClient();

    await expect(adoptSprayWallFromLink(queryClient, WALL_UUID)).resolves.toBe(4242);

    expect(queryClient.getQueryData(sprayWallByLayoutQueryKey(4242))).toEqual({ sprayWallByLayout: wall });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toEqual({ uuid: WALL_UUID });
  });

  // The race this exists for: the handoff navigates while adoption is in flight,
  // so `ensureSprayWallLoaded` can resolve `sprayWallByLayout` to null first —
  // correctly, for a non-member — and leave the registry `unavailable` behind a
  // 30-second cooldown that nothing would re-ask past. Adoption therefore has to
  // kick the registry itself, past both the cooldown and the stale window.
  it('forces a registration after seeding, so a lost race still draws the wall', async () => {
    const wall = { uuid: WALL_UUID, layoutId: 4242 };
    request.mockResolvedValue({ sprayWall: wall });
    const queryClient = makeQueryClient();
    const loader = vi.fn(async () => {});
    setSprayWallLoader(loader);

    // The handoff got there first and the wall is sitting in its failure cooldown.
    unregisterSprayWall(4242);
    expect(getSprayWallLoadState(4242)).toBe('unavailable');

    await adoptSprayWallFromLink(queryClient, WALL_UUID);

    expect(loader).toHaveBeenCalledWith(4242, { force: true });
  });

  it('returns null and writes nothing when the wall does not resolve', async () => {
    request.mockResolvedValue({ sprayWall: null });
    const queryClient = makeQueryClient();

    await expect(adoptSprayWallFromLink(queryClient, WALL_UUID)).resolves.toBeNull();

    // Nothing at all in the by-layout cache — not an entry holding null, which a
    // later `fetchSprayWallUuid` would read as "this wall is gone" and stop asking.
    expect(queryClient.getQueryCache().findAll({ queryKey: ['sprayWallByLayout'] })).toHaveLength(0);
  });
});

describe('isWallUuidParam', () => {
  it('accepts a uuid and rejects everything else', () => {
    expect(isWallUuidParam(WALL_UUID)).toBe(true);
    expect(isWallUuidParam(WALL_UUID.toUpperCase())).toBe(true);
    expect(isWallUuidParam('4242')).toBe(false);
    expect(isWallUuidParam('')).toBe(false);
    expect(isWallUuidParam(undefined)).toBe(false);
  });
});
