// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';

/**
 * The play drawer banner's Remix: it reaches the create route through the
 * shared handoff with the shown climb and its render board, counts the remix
 * only when the action is accepted, works again for the next climb, and is
 * absent on an archived wall.
 */

const router = vi.hoisted(() => ({ push: vi.fn() }));
const archive = vi.hoisted(() => ({ archived: false }));
const track = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('../../../lib/sentry', () => ({ captureToSentry: vi.fn() }));
vi.mock('../../../lib/spray/use-spray-wall-archive', () => ({ useSprayWallIsArchived: () => archive.archived }));
vi.mock('../../../lib/spray/spray-telemetry', () => ({ trackSprayEvent: track }));

const { useLostHoldRemix } = await import('../use-lost-hold-remix');

const board = { boardName: 'spray', layoutId: 4200, sizeId: 4200, setIds: '1', angle: 40 };
const climbOf = (uuid: string) =>
  ({ uuid, name: `Climb ${uuid}`, frames: 'p1r12', description: '', missingHoldCount: 2 }) as unknown as Climb;

beforeEach(() => {
  router.push.mockReset();
  track.mockReset();
  archive.archived = false;
});

describe('useLostHoldRemix', () => {
  it('remixes the shown climb on its render board, and counts it once accepted', async () => {
    const dismissPlayerAndWait = vi.fn(async () => ({ status: 'dismissed' as const }));
    const { result } = renderHook(() =>
      useLostHoldRemix({ displayedClimb: climbOf('a'), renderBoardConfig: board, dismissPlayerAndWait }),
    );
    expect(result.current.lostHoldCount).toBe(2);

    act(() => result.current.onRemix?.());
    await act(async () => {});

    expect(router.push).toHaveBeenCalledExactlyOnceWith({
      pathname: '/(tabs)/climbs/create',
      params: expect.objectContaining({ forkParentUuid: 'a', forkFrames: 'p1r12', layoutId: '4200' }),
    });
    expect(track).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ properties: { lostHoldCount: 2, source: 'play_drawer' } }),
    );
  });

  // The drawer can outlive a handoff; the banner must not go dead after one.
  it('navigates again for the next climb', async () => {
    const dismissPlayerAndWait = vi.fn(async () => ({ status: 'dismissed' as const }));
    const { result, rerender } = renderHook(
      ({ climb }: { climb: Climb }) =>
        useLostHoldRemix({ displayedClimb: climb, renderBoardConfig: board, dismissPlayerAndWait }),
      { initialProps: { climb: climbOf('a') } },
    );
    act(() => result.current.onRemix?.());
    await act(async () => {});
    rerender({ climb: climbOf('b') });
    act(() => result.current.onRemix?.());
    await act(async () => {});

    expect(router.push).toHaveBeenCalledTimes(2);
    expect(router.push.mock.calls[1][0]).toEqual(
      expect.objectContaining({ params: expect.objectContaining({ forkParentUuid: 'b' }) }),
    );
  });

  it('takes a second tap after the player dismissal aborted', async () => {
    const dismissPlayerAndWait = vi
      .fn<() => Promise<{ status: 'aborted' | 'dismissed' }>>()
      .mockResolvedValueOnce({ status: 'aborted' })
      .mockResolvedValueOnce({ status: 'dismissed' });
    const { result } = renderHook(() =>
      useLostHoldRemix({ displayedClimb: climbOf('a'), renderBoardConfig: board, dismissPlayerAndWait }),
    );
    act(() => result.current.onRemix?.());
    await act(async () => {});
    act(() => result.current.onRemix?.());
    await act(async () => {});

    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it('counts a double tap once', async () => {
    let finish: (value: { status: 'dismissed' }) => void = () => {};
    const dismissPlayerAndWait = vi.fn(
      () =>
        new Promise<{ status: 'dismissed' }>((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useLostHoldRemix({ displayedClimb: climbOf('a'), renderBoardConfig: board, dismissPlayerAndWait }),
    );
    act(() => {
      result.current.onRemix?.();
      result.current.onRemix?.();
    });
    await act(async () => finish({ status: 'dismissed' }));

    expect(track).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it('offers no Remix on an archived wall', () => {
    archive.archived = true;
    const { result } = renderHook(() => useLostHoldRemix({ displayedClimb: climbOf('a'), renderBoardConfig: board }));
    expect(result.current.onRemix).toBeNull();
    expect(result.current.lostHoldCount).toBe(2);
  });
});
