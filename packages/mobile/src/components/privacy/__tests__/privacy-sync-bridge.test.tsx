// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  viewer: 'viewer' as string | undefined,
  database: { id: 1 } as { id: number } | null,
  online: true,
  state: 'active',
  credential: 0,
  mismatch: false,
  unstamped: false as boolean | Promise<boolean>,
  mismatchListener: undefined as (() => void) | undefined,
  databaseListener: undefined as (() => void) | undefined,
  onlineListener: undefined as ((online: boolean) => void) | undefined,
  foreground: undefined as ((state: string) => void) | undefined,
  subscribe: vi.fn((_operation: unknown, _callbacks: unknown) => vi.fn()),
  revalidate: vi.fn<(...args: unknown[]) => Promise<void>>(),
  require: vi.fn(),
  report: vi.fn(),
}));
vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return mocks.state;
    },
    addEventListener: (_event: string, callback: (state: string) => void) => {
      mocks.foreground = callback;
      return {
        remove: () => {
          mocks.foreground = undefined;
        },
      };
    },
  },
}));
vi.mock('@tanstack/react-query', () => ({
  onlineManager: {
    isOnline: () => mocks.online,
    subscribe: (callback: (online: boolean) => void) => {
      mocks.onlineListener = callback;
      return () => {
        mocks.onlineListener = undefined;
      };
    },
  },
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: mocks.viewer ? { id: mocks.viewer } : undefined }),
}));
// Nothing in the bridge may open a realtime subscription; this spy proves it.
vi.mock('../../../lib/graphql/ws-client', () => ({ getWsClient: () => ({ subscribe: mocks.subscribe }) }));
vi.mock('../../../lib/privacy/privacy-cache', () => ({
  getPrivacyCredentialGeneration: () => mocks.credential,
}));
vi.mock('../../../lib/spray/spray-privacy-cleanup', () => ({ clearSprayWallPrivateCaches: vi.fn() }));
vi.mock('../../../lib/spray/spray-photo-store', () => ({ clearStoredSprayPhotos: vi.fn() }));
vi.mock('../../../offline/privacy-revalidation', () => ({
  PrivacyRevalidationDeferredError: class extends Error {},
  revalidatePrivateCatalog: mocks.revalidate,
  requirePrivacyRevalidation: mocks.require,
}));
vi.mock('../../../db/connection', () => ({
  getDatabaseHandle: () => mocks.database,
  subscribeDatabaseHandle: (callback: () => void) => {
    mocks.databaseListener = callback;
    return () => {
      mocks.databaseListener = undefined;
    };
  },
}));
vi.mock('../../../offline/catalog-access', () => ({
  canReadPrivateCatalog: async () => {
    if (mocks.mismatch) mocks.mismatchListener?.();
    return !mocks.mismatch;
  },
  isCatalogViewerUnstamped: async () => mocks.unstamped,
  subscribeCatalogCredentialMismatch: (listener: () => void) => {
    mocks.mismatchListener = listener;
    return () => {
      mocks.mismatchListener = undefined;
    };
  },
}));
vi.mock('../../../settings', () => ({ getSetting: () => [] }));
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: mocks.report }));
import { PrivacySyncBridge } from '../PrivacySyncBridge';
import { PrivacyRevalidationDeferredError } from '../../../offline/privacy-revalidation';

/** A local read found a marker for an older credential. */
function reportMismatch() {
  mocks.mismatchListener?.();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.viewer = 'viewer';
  mocks.database = { id: 1 };
  mocks.online = true;
  mocks.state = 'active';
  mocks.credential = 0;
  mocks.mismatch = false;
  mocks.unstamped = false;
  mocks.revalidate.mockReset().mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('catalogue authorization without privacyChanged', () => {
  it('never opens a realtime subscription', async () => {
    mocks.unstamped = true;
    await act(async () => {
      render(<PrivacySyncBridge />);
    });
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it('stamps a catalogue with no marker once the signed-in session is known', async () => {
    mocks.unstamped = true;
    mocks.viewer = undefined;
    const view = render(<PrivacySyncBridge />);
    await act(async () => {});
    expect(mocks.revalidate).not.toHaveBeenCalled();
    mocks.viewer = 'viewer';
    await act(async () => view.rerender(<PrivacySyncBridge />));
    expect(mocks.require).toHaveBeenCalledOnce();
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    expect(mocks.revalidate.mock.calls[0][1]).toBe('viewer');
  });

  it('leaves a catalogue whose marker matches the credential alone', async () => {
    await act(async () => {
      render(<PrivacySyncBridge />);
    });
    await act(async () => mocks.onlineListener?.(true));
    await act(async () => mocks.foreground?.('active'));
    expect(mocks.require).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('checks a database handle published after the session started', async () => {
    mocks.database = null;
    mocks.unstamped = true;
    await act(async () => {
      render(<PrivacySyncBridge />);
    });
    expect(mocks.revalidate).not.toHaveBeenCalled();
    mocks.database = { id: 2 };
    await act(async () => mocks.databaseListener?.());
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    expect(mocks.revalidate.mock.calls[0][0]).toBe(mocks.database);
  });

  it('does not restart a repair because its own withdrawal deleted the marker', async () => {
    let answerUnstamped!: (unstamped: boolean) => void;
    mocks.unstamped = new Promise<boolean>((resolve) => {
      answerUnstamped = resolve;
    });
    render(<PrivacySyncBridge />);
    await act(async () => reportMismatch());
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    await act(async () => answerUnstamped(true));
    expect(mocks.require).toHaveBeenCalledOnce();
    expect(mocks.revalidate).toHaveBeenCalledOnce();
  });

  it('repairs a marker for an older credential observed during startup', async () => {
    mocks.mismatch = true;
    await act(async () => {
      render(<PrivacySyncBridge />);
    });
    expect(mocks.revalidate).toHaveBeenCalledOnce();
  });

  it('retries a transient local failure without another request', async () => {
    mocks.revalidate.mockRejectedValueOnce(new Error('database is locked'));
    render(<PrivacySyncBridge />);
    await act(async () => reportMismatch());
    expect(mocks.require).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(mocks.revalidate).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.revalidate).toHaveBeenCalledTimes(2);
  });

  it('bounds retries and resumes on foreground after exhaustion', async () => {
    mocks.revalidate.mockRejectedValue(new Error('database is locked'));
    render(<PrivacySyncBridge />);
    await act(async () => reportMismatch());
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.revalidate).toHaveBeenCalledTimes(4);
    mocks.revalidate.mockResolvedValue();
    await act(async () => mocks.foreground?.('active'));
    expect(mocks.revalidate).toHaveBeenCalledTimes(5);
  });

  it('holds withdrawal through late schema availability and connectivity', async () => {
    mocks.database = null;
    mocks.online = false;
    mocks.revalidate.mockRejectedValueOnce(new PrivacyRevalidationDeferredError());
    render(<PrivacySyncBridge />);
    await act(async () => reportMismatch());
    expect(mocks.require).toHaveBeenCalledOnce();
    expect(mocks.revalidate).not.toHaveBeenCalled();
    mocks.database = { id: 2 };
    await act(async () => mocks.databaseListener?.());
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    expect((mocks.revalidate.mock.calls[0][4] as () => boolean)()).toBe(false);
    expect(mocks.report).not.toHaveBeenCalled();
    mocks.online = true;
    await act(async () => mocks.onlineListener?.(true));
    expect(mocks.revalidate).toHaveBeenCalledTimes(2);
    expect(mocks.revalidate.mock.calls[0][0]).toBe(mocks.database);
  });

  it('coalesces requests during a repair and revokes its completion guard immediately', async () => {
    let finish!: () => void;
    mocks.revalidate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<PrivacySyncBridge />);
    await act(async () => reportMismatch());
    const originalCurrent = mocks.revalidate.mock.calls[0][3] as () => boolean;
    expect(originalCurrent()).toBe(true);
    await act(async () => {
      reportMismatch();
      reportMismatch();
    });
    expect(originalCurrent()).toBe(false);
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(mocks.revalidate).toHaveBeenCalledTimes(2);
  });

  it('replaces an in-flight database without allowing the old repair to authorize it', async () => {
    let finish!: () => void;
    mocks.revalidate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<PrivacySyncBridge />);
    await act(async () => reportMismatch());
    const originalCurrent = mocks.revalidate.mock.calls[0][3] as () => boolean;
    mocks.database = { id: 2 };
    await act(async () => mocks.databaseListener?.());
    expect(originalCurrent()).toBe(false);
    await act(async () => finish());
    expect(mocks.revalidate.mock.calls[1][0]).toBe(mocks.database);
  });

  it('cancels timers and rejects obsolete account and credential attempts', async () => {
    let finish!: () => void;
    mocks.revalidate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<PrivacySyncBridge />);
    await act(async () => reportMismatch());
    const originalCurrent = mocks.revalidate.mock.calls[0][3] as () => boolean;
    mocks.credential += 1;
    expect(originalCurrent()).toBe(false);
    view.unmount();
    await act(async () => finish());
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    expect(mocks.databaseListener).toBeUndefined();
    expect(mocks.mismatchListener).toBeUndefined();
  });

  it('defers a timer retry in the background until the next foreground', async () => {
    mocks.revalidate.mockRejectedValueOnce(new Error('database is locked'));
    render(<PrivacySyncBridge />);
    await act(async () => reportMismatch());
    mocks.state = 'background';
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    mocks.state = 'active';
    await act(async () => mocks.foreground?.('active'));
    expect(mocks.revalidate).toHaveBeenCalledTimes(2);
  });
});
