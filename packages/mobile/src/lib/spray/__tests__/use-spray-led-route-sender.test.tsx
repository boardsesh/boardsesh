// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';

const mocks = vi.hoisted(() => ({
  uuid: vi.fn(),
  payload: vi.fn(),
  settings: vi.fn(),
  layout: vi.fn(),
  mapping: vi.fn(),
  show: vi.fn(),
  clear: vi.fn(),
  close: vi.fn(),
  detach: vi.fn(),
  create: vi.fn(),
  invalidate: vi.fn(),
  failure: vi.fn(),
  credential: 0,
  privacy: 'current',
  removal: 0,
  registered: null as null | { wallUuid: string },
  background: null as ((state: string) => void) | null,
  credentialChanged: null as (() => void) | null,
  configuration: null as ((wallUuid: string) => void) | null,
  withdrawal: null as ((layoutId?: number) => void) | null,
}));
vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.background = listener;
      return { remove: vi.fn() };
    },
  },
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => 'query-client' }));
vi.mock('@boardsesh/spray-wall-geometry', () => ({ buildSprayLedMapping: mocks.mapping }));
vi.mock('@boardsesh/led-controller', () => ({
  createLedPreviewSession: mocks.create,
  getLedControllerDriver: () => 'wled-driver',
}));
vi.mock('../../privacy/privacy-cache', () => ({
  getCredentialGeneration: () => mocks.credential,
  subscribeToCredentialChanges: (listener: () => void) => {
    mocks.credentialChanged = listener;
    return vi.fn();
  },
}));
vi.mock('../../hold-color-overrides', () => ({
  hexToRgb: (color: string) => {
    const hex = color.replace('#', '');
    return /^[\da-f]{6}$/i.test(hex)
      ? {
          red: parseInt(hex.slice(0, 2), 16),
          green: parseInt(hex.slice(2, 4), 16),
          blue: parseInt(hex.slice(4, 6), 16),
        }
      : null;
  },
}));
vi.mock('../spray-led-config-events', () => ({
  subscribeSprayLedConfiguration: (listener: (wallUuid: string) => void) => {
    mocks.configuration = listener;
    return vi.fn();
  },
}));
vi.mock('../spray-wall-registry', () => ({
  getSprayWall: () => mocks.registered,
  sprayWallRemovalGeneration: () => mocks.removal,
  subscribeToSprayWallWithdrawals: (listener: (layoutId?: number) => void) => {
    mocks.withdrawal = listener;
    return vi.fn();
  },
}));
vi.mock('../spray-privacy-generation', () => ({ sprayPrivacyGeneration: () => mocks.privacy }));
vi.mock('../spray-wall-loader', () => ({ fetchSprayWallUuid: mocks.uuid, fetchSprayWallRenderData: mocks.payload }));
vi.mock('../use-spray-wall-led-settings', () => ({ loadSprayWallLedSettings: mocks.settings }));
vi.mock('../spray-wall-tnut-store', () => ({ loadSprayWallTnutLayout: mocks.layout }));

import { useSprayLedRouteSender } from '../use-spray-led-route-sender';
import { sprayLedPhotoKey } from '../spray-led-photo-key';

const homography = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const payload = {
  wall: { layoutId: 42, currentVersion: { id: 3 } },
  boardWidth: 1000,
  boardHeight: 800,
  homography,
  holds: [{ id: 7, cx: 500, cy: 400, r: 60 }],
  photo: { url: 'https://private/photo', width: 1200, height: 900, expiresAt: 'later' },
};
const layout = {
  photoKey: sprayLedPhotoKey({ frame: { width: 1000, height: 800 }, homography }),
  wiring: { initialSkip: 2 },
};
const useSender = (boardName = 'spray', layoutId = 42) =>
  useSprayLedRouteSender({ boardName, layoutId, onInvalidated: mocks.invalidate, onFailure: mocks.failure });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.credential = 0;
  mocks.privacy = 'current';
  mocks.removal = 0;
  mocks.registered = null;
  mocks.uuid.mockResolvedValue('spray-wall');
  mocks.settings.mockResolvedValue({ enabled: true, controller: { type: 'wled', url: 'http://wall.local' } });
  mocks.payload.mockResolvedValue(payload);
  mocks.layout.mockResolvedValue(layout);
  mocks.mapping.mockReturnValue({
    holes: [],
    holds: [{ holdId: 7, holeIndices: [0], ledIds: ['a', 'b'], indices: [2, 5] }],
  });
  mocks.show.mockResolvedValue(true);
  mocks.clear.mockResolvedValue(true);
  mocks.close.mockResolvedValue(undefined);
  mocks.detach.mockResolvedValue(undefined);
  mocks.create.mockReturnValue({ show: mocks.show, clear: mocks.clear, close: mocks.close, detach: mocks.detach });
});
afterEach(cleanup);

describe('spray route transport', () => {
  it('keeps catalog boards outside LAN setup', async () => {
    const { result } = renderHook(() => useSender('kilter'));
    expect(await result.current.send('p7r1')).toBeNull();
    expect(mocks.uuid).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('keeps a disabled registered wall virtual without a network identity read', async () => {
    mocks.registered = { wallUuid: 'spray-wall' };
    mocks.settings.mockResolvedValue({ enabled: false });
    const { result } = renderHook(() => useSender());
    expect(await result.current.send('p7r1')).toBeNull();
    expect(mocks.uuid).not.toHaveBeenCalled();
    expect(mocks.payload).not.toHaveBeenCalled();
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.failure).not.toHaveBeenCalled();
  });

  it('addresses mapped physical indices with the route role color', async () => {
    const { result } = renderHook(() => useSender());
    expect(await result.current.send('p7r1')).toBe(true);
    expect(mocks.mapping).toHaveBeenCalledWith(layout, { width: 1000, height: 800 }, payload.holds);
    const hex = HOLD_STATE_MAP.spray[1].color.slice(1);
    const color = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
    expect(mocks.show).toHaveBeenCalledWith(
      [2, 5],
      [
        { index: 2, color },
        { index: 5, color },
      ],
    );
  });

  it('uses the same role overrides as other board lights', async () => {
    const { result } = renderHook(() =>
      useSprayLedRouteSender({
        boardName: 'spray',
        layoutId: 42,
        onInvalidated: mocks.invalidate,
        colorOverrides: { STARTING: '#010203' },
      }),
    );
    expect(await result.current.send('p7r1')).toBe(true);
    expect(mocks.show.mock.calls[0][1]).toEqual([
      { index: 2, color: [1, 2, 3] },
      { index: 5, color: [1, 2, 3] },
    ]);
  });

  it.each([
    ['a stale calibration', 'p7r1', true],
    ['a missing hold', 'p8r1', false],
    ['a malformed route', 'not-frames', false],
  ])('refuses %s and says so', async (_refusal, frames, staleLayout) => {
    if (staleLayout) mocks.layout.mockResolvedValueOnce({ ...layout, photoKey: 'old-version' });
    const { result } = renderHook(() => useSender());
    expect(await result.current.send(frames)).toBe(false);
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.failure).toHaveBeenCalledTimes(1);
  });

  it('can explicitly clear before any route has been written', async () => {
    const { result } = renderHook(() => useSender());
    expect(await result.current.send('')).toBe(true);
    expect(mocks.clear).toHaveBeenCalledTimes(1);
    expect(mocks.payload).not.toHaveBeenCalled();
  });

  it('refuses failure acknowledgements and closes the owned session', async () => {
    mocks.show.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useSender());
    expect(await result.current.send('p7r1')).toBe(false);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.failure).toHaveBeenCalledTimes(1);
  });

  it('does not show a failure when a setup preview takes the controller lane', async () => {
    mocks.show.mockResolvedValueOnce(false);
    const { result } = renderHook(() => useSender());
    expect(await result.current.send('p7r1')).toBe(false);
    expect(mocks.failure).not.toHaveBeenCalled();
  });

  it('fences a late private payload after access is withdrawn', async () => {
    let complete!: (answer: typeof payload) => void;
    mocks.payload.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const { result } = renderHook(() => useSender());
    const pending = result.current.send('p7r1');
    await vi.waitFor(() => expect(mocks.payload).toHaveBeenCalled());
    act(() => {
      mocks.privacy = 'withdrawn';
      mocks.removal++;
      mocks.withdrawal?.(42);
    });
    complete(payload);
    expect(await pending).toBe(false);
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.failure).not.toHaveBeenCalled();
  });

  it('does not confirm an old wall after a board switch', async () => {
    let complete!: (answer: boolean) => void;
    mocks.show.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const { result, rerender } = renderHook(({ id }) => useSender('spray', id), { initialProps: { id: 42 } });
    const pending = result.current.send('p7r1');
    await vi.waitFor(() => expect(mocks.show).toHaveBeenCalled());
    rerender({ id: 43 });
    complete(true);
    expect(await pending).toBe(false);
    expect(mocks.detach).toHaveBeenCalledTimes(1);
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it('shows one failure toast until a write succeeds again', async () => {
    mocks.show.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useSender());
    expect(await result.current.send('p7r1')).toBe(false);
    expect(await result.current.send('p7r1')).toBe(false);
    expect(mocks.failure).toHaveBeenCalledTimes(1);
    expect(await result.current.send('p7r1')).toBe(true);
    mocks.show.mockRejectedValueOnce(new Error('offline'));
    expect(await result.current.send('p7r1')).toBe(false);
    expect(mocks.failure).toHaveBeenCalledTimes(2);
  });

  it('reads no controller settings until a write is asked for', () => {
    renderHook(() => useSender());
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('keeps the wall lit through a lock and does not rewrite it on return', async () => {
    const { result } = renderHook(() => useSender());
    expect(await result.current.send('p7r1')).toBe(true);
    mocks.invalidate.mockClear();
    act(() => mocks.background?.('inactive'));
    act(() => mocks.background?.('background'));
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.detach).not.toHaveBeenCalled();
    act(() => mocks.background?.('active'));
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('keeps lighting climbs while the app is in the background', async () => {
    const { result } = renderHook(() => useSender());
    act(() => mocks.background?.('background'));
    expect(await result.current.send('p7r1')).toBe(true);
    expect(mocks.show).toHaveBeenCalledTimes(1);
  });

  it('retries a write that failed while away once, without a toast', async () => {
    const { result } = renderHook(() => useSender());
    act(() => mocks.background?.('background'));
    mocks.show.mockRejectedValueOnce(new Error('suspended'));
    expect(await result.current.send('p7r1')).toBe(false);
    expect(mocks.failure).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
    act(() => mocks.background?.('active'));
    expect(mocks.invalidate).toHaveBeenCalledWith(true);
    mocks.invalidate.mockClear();
    act(() => mocks.background?.('background'));
    act(() => mocks.background?.('active'));
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('lets go of the wall without touching its lights', async () => {
    const { result } = renderHook(() => useSender());
    expect(await result.current.send('p7r1')).toBe(true);
    act(() => result.current.release());
    expect(mocks.detach).toHaveBeenCalledTimes(1);
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it('aborts in-flight writes and closes on a credential change', async () => {
    let complete!: (answer: boolean) => void;
    mocks.show.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const { result } = renderHook(() => useSender());
    const controller = new AbortController();
    const pending = result.current.send('p7r1', false, controller.signal);
    await vi.waitFor(() => expect(mocks.show).toHaveBeenCalled());
    controller.abort();
    complete(true);
    expect(await pending).toBe(false);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(await result.current.send('p7r1')).toBe(true);
    act(() => {
      mocks.credential++;
      mocks.credentialChanged?.();
    });
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });

  it('invalidates identical route frames when configuration is saved', async () => {
    const { result } = renderHook(() => useSender());
    expect(await result.current.send('p7r1')).toBe(true);
    act(() => mocks.configuration?.('spray-wall'));
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate).toHaveBeenLastCalledWith(true);
    expect(await result.current.send('p7r1')).toBe(true);
    expect(mocks.layout).toHaveBeenCalledTimes(2);
  });
});
