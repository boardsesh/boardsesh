// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  privacy: { enabled: false } as { enabled: boolean } | undefined,
  viewer: 'viewer',
  database: { id: 1 } as { id: number } | null,
  online: true,
  state: 'active',
  credential: 0,
  mismatch: false,
  mismatchListener: undefined as (() => void) | undefined,
  handler: undefined as (() => Promise<void>) | undefined,
  databaseListener: undefined as (() => void) | undefined,
  onlineListener: undefined as ((online: boolean) => void) | undefined,
  foreground: undefined as ((state: string) => void) | undefined,
  subscribe: vi.fn((_operation: unknown, _callbacks: unknown) => vi.fn()),
  revalidate: vi.fn<(...args: unknown[]) => Promise<void>>(),
  require: vi.fn(),
  report: vi.fn(),
  queryClient: {},
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
  useQueryClient: () => mocks.queryClient,
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
vi.mock('../../../lib/graphql/hooks', () => ({ useProfile: () => ({ data: { id: mocks.viewer } }) }));
vi.mock('../../../lib/graphql/hooks/use-privacy', () => ({ usePrivacySettings: () => ({ data: mocks.privacy }) }));
vi.mock('../../../lib/graphql/ws-client', () => ({ getWsClient: () => ({ subscribe: mocks.subscribe }) }));
vi.mock('../../../lib/privacy/privacy-cache', () => ({
  getPrivacyCredentialGeneration: () => mocks.credential,
  invalidatePrivacyQueries: () => mocks.handler?.(),
  registerPrivacyRevalidation: (handler: () => Promise<void>) => {
    mocks.handler = handler;
    return () => {
      if (mocks.handler === handler) mocks.handler = undefined;
    };
  },
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

function revoke() {
  const callbacks = mocks.subscribe.mock.calls.at(-1)![1] as { next: () => void };
  callbacks.next();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.privacy = { enabled: false };
  mocks.viewer = 'viewer';
  mocks.database = { id: 1 };
  mocks.online = true;
  mocks.state = 'active';
  mocks.credential = 0;
  mocks.mismatch = false;
  mocks.revalidate.mockReset().mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('privacy revocation subscription', () => {
  it('repairs a refresh mismatch already observed before privacy capability was available', async () => {
    mocks.mismatch = true;
    mocks.privacy = undefined;
    const view = render(<PrivacySyncBridge />);
    expect(mocks.revalidate).not.toHaveBeenCalled();
    mocks.privacy = { enabled: false };
    await act(async () => view.rerender(<PrivacySyncBridge />));
    expect(mocks.revalidate).toHaveBeenCalledOnce();
  });

  it('stays subscribed when controls are disabled and capability cache is cleared', async () => {
    const view = render(<PrivacySyncBridge />);
    expect(mocks.subscribe).toHaveBeenCalledOnce();
    mocks.privacy = undefined;
    view.rerender(<PrivacySyncBridge />);
    expect(mocks.subscribe).toHaveBeenCalledOnce();
    await act(async () => revoke());
    expect(mocks.revalidate).toHaveBeenCalledOnce();
  });

  it('retries a transient local failure without another subscription event', async () => {
    mocks.revalidate.mockRejectedValueOnce(new Error('database is locked'));
    render(<PrivacySyncBridge />);
    await act(async () => revoke());
    expect(mocks.require).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(mocks.revalidate).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.revalidate).toHaveBeenCalledTimes(2);
  });

  it('bounds retries and resumes on foreground after exhaustion', async () => {
    mocks.revalidate.mockRejectedValue(new Error('database is locked'));
    render(<PrivacySyncBridge />);
    await act(async () => revoke());
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
    await act(async () => revoke());
    expect(mocks.require).toHaveBeenCalledOnce();
    expect(mocks.revalidate).not.toHaveBeenCalled();
    mocks.database = { id: 2 };
    await act(async () => mocks.databaseListener?.());
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    expect((mocks.revalidate.mock.calls[0][3] as () => boolean)()).toBe(false);
    expect(mocks.report).not.toHaveBeenCalled();
    mocks.online = true;
    await act(async () => mocks.onlineListener?.(true));
    expect(mocks.revalidate).toHaveBeenCalledTimes(2);
    expect(mocks.revalidate.mock.calls[0][0]).toBe(mocks.database);
  });

  it('coalesces events during a repair and revokes its completion guard immediately', async () => {
    let finish!: () => void;
    mocks.revalidate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<PrivacySyncBridge />);
    await act(async () => revoke());
    const originalCurrent = mocks.revalidate.mock.calls[0][2] as () => boolean;
    expect(originalCurrent()).toBe(true);
    await act(async () => {
      revoke();
      revoke();
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
    await act(async () => revoke());
    const originalCurrent = mocks.revalidate.mock.calls[0][2] as () => boolean;
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
    await act(async () => revoke());
    const originalCurrent = mocks.revalidate.mock.calls[0][2] as () => boolean;
    mocks.credential += 1;
    expect(originalCurrent()).toBe(false);
    view.unmount();
    await act(async () => finish());
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    expect(mocks.databaseListener).toBeUndefined();
  });

  it('defers a timer retry in the background until the next foreground', async () => {
    mocks.revalidate.mockRejectedValueOnce(new Error('database is locked'));
    render(<PrivacySyncBridge />);
    await act(async () => revoke());
    mocks.state = 'background';
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    mocks.state = 'active';
    await act(async () => mocks.foreground?.('active'));
    expect(mocks.revalidate).toHaveBeenCalledTimes(2);
  });
});
