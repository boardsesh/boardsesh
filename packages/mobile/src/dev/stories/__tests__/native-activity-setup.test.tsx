// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
const state = vi.hoisted(() => ({
  params: {
    board: 'moonboard-2024',
    server: 'http://localhost:4812',
    shot: 'one',
    end: undefined as string | undefined,
  },
  native: { isAvailable: vi.fn(), startSession: vi.fn(), endSession: vi.fn(), updateActivity: vi.fn() },
  backgrounds: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => state.params }));
vi.mock('../../../../modules/live-activity/src', () => ({ liveActivityNative: state.native }));
vi.mock('../../../lib/background-image-cache', () => ({ ensureBackgroundsCached: state.backgrounds }));
vi.mock('../../fixtures/boards', () => ({
  STORY_BOARDS: {
    'moonboard-2024': {
      board: { boardName: 'moonboard', layoutId: 3, sizeId: 1, setIds: '2,3', angle: 40 },
      climbs: [
        {
          uuid: 'recorded-climb',
          name: 'Recorded climb',
          difficulty: 'V5',
          frames: 'p1r12',
          setter_username: 'Recorded setter',
        },
      ],
    },
  },
}));
import NativeActivitySetup from '../NativeActivitySetup';
afterEach(async () => {
  await act(async () => cleanup());
  vi.restoreAllMocks();
});
beforeEach(() => {
  state.params = { board: 'moonboard-2024', server: 'http://localhost:4812', shot: 'one', end: undefined };
  for (const method of Object.values(state.native)) method.mockReset().mockResolvedValue(undefined);
  state.native.isAvailable.mockResolvedValue({ available: true });
  state.backgrounds.mockReset().mockResolvedValue({ paths: ['/bundled/moonboard-thumb.webp'], missingCount: 0 });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
describe('actual native activity capture setup', () => {
  it('uses the exact board and queue without live auth or mutation endpoints', async () => {
    await act(async () => {
      render(<NativeActivitySetup />);
    });
    await waitFor(() => expect(state.native.startSession).toHaveBeenCalledOnce());
    const start = state.native.startSession.mock.calls[0][0];
    expect(start).toMatchObject({
      boardName: 'moonboard',
      layoutId: 3,
      serverUrl: 'http://localhost:4812',
      wsUrl: 'ws://127.0.0.1:1',
      widgetNavigationAllowed: false,
      isPartySession: false,
      boardBackgroundPaths: ['/bundled/moonboard-thumb.webp'],
    });
    expect(state.backgrounds).toHaveBeenCalledExactlyOnceWith({
      boardName: 'moonboard',
      layoutId: 3,
      sizeId: 1,
      setIds: [2, 3],
      variant: 'thumb',
    });
    expect(start.authToken).toBeUndefined();
    expect(start.graphqlUrl).toBeUndefined();
    expect(state.native.updateActivity.mock.calls[0][0].climbUuid).toBe('recorded-climb');
    expect(console.log).toHaveBeenCalledWith('[stories] native started moonboard-2024 recorded-climb-classic.webp');
  });
  it('refuses external servers and unsupported binaries', async () => {
    state.params.server = 'https://ws.boardsesh.com';
    await act(async () => {
      render(<NativeActivitySetup />);
    });
    expect(state.native.startSession).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('local read-only replay server'));
  });
  it('ends the session without starting a new one on cleanup route', async () => {
    state.params.end = '1';
    await act(async () => {
      render(<NativeActivitySetup />);
    });
    expect(state.native.endSession).toHaveBeenCalledOnce();
    expect(state.native.startSession).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('[stories] native ended');
  });

  it.each([null, { paths: [], missingCount: 0 }, { paths: ['/bundled/one.webp'], missingCount: 1 }])(
    'fails capture rather than starting with incomplete backgrounds: %j',
    async (backgrounds) => {
      state.backgrounds.mockResolvedValue(backgrounds);
      render(<NativeActivitySetup />);
      await waitFor(() =>
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Missing bundled board backgrounds')),
      );
      expect(state.native.startSession).not.toHaveBeenCalled();
      expect(state.native.updateActivity).not.toHaveBeenCalled();
      expect(console.log).not.toHaveBeenCalled();
    },
  );

  it('does not start after unmount during background resolution', async () => {
    let resolveBackgrounds!: (backgrounds: { paths: string[]; missingCount: number }) => void;
    state.backgrounds.mockReturnValue(
      new Promise((resolve) => {
        resolveBackgrounds = resolve;
      }),
    );
    const view = render(<NativeActivitySetup />);
    await waitFor(() => expect(state.backgrounds).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => resolveBackgrounds({ paths: ['/bundled/late.webp'], missingCount: 0 }));
    expect(state.native.startSession).not.toHaveBeenCalled();
    expect(state.native.updateActivity).not.toHaveBeenCalled();
  });

  it('finishes a cancelled native start and teardown before starting the next shot', async () => {
    let finishStart!: () => void;
    state.native.startSession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        }),
    );
    const view = render(<NativeActivitySetup />);
    await waitFor(() => expect(state.native.startSession).toHaveBeenCalledOnce());
    state.params = { ...state.params, shot: 'two' };
    view.rerender(<NativeActivitySetup />);
    expect(state.native.startSession).toHaveBeenCalledOnce();
    await act(async () => finishStart());
    await waitFor(() => expect(state.native.startSession).toHaveBeenCalledTimes(2));
    expect(state.native.updateActivity).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: 'native-capture-two' }),
    );
    expect(state.native.endSession.mock.invocationCallOrder.at(-1)).toBeLessThan(
      state.native.startSession.mock.invocationCallOrder[1],
    );
    expect(console.log).toHaveBeenCalledOnce();
  });
});
