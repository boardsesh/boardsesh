// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  privacy: { enabled: false } as { enabled: boolean } | undefined,
  viewer: 'viewer',
  database: { id: 1 } as { id: number } | null,
  online: true,
  offlineMode: false,
  transportRevision: 0,
  authorizedViewer: 'viewer' as string | null,
  markerRead: vi.fn<() => Promise<string | null>>(),
  connectedListener: undefined as (() => void) | undefined,
  stopConnected: vi.fn(),
  state: 'active',
  credential: 0,
  mismatch: false,
  outboxRepairRequired: false,
  mutationListener: undefined as ((event: { status: string }) => void) | undefined,
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
vi.mock('../../../lib/graphql/ws-client', () => ({
  getWsClient: () => ({
    on: (_event: string, callback: () => void) => {
      mocks.connectedListener = callback;
      return () => {
        mocks.stopConnected();
        if (mocks.connectedListener === callback) mocks.connectedListener = undefined;
      };
    },
    subscribe: mocks.subscribe,
  }),
}));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({
  selectOfflineMode: () => mocks.offlineMode,
  useConnectivityField: () => mocks.offlineMode,
}));
vi.mock('../../../lib/auth-transport-revision', () => ({
  useAuthTransportRevision: () => mocks.transportRevision,
}));
vi.mock('../../../lib/privacy/privacy-cache', () => ({
  getPrivacyCredentialGeneration: () => mocks.credential,
  invalidatePrivacyQueries: (_queryClient: unknown, beforeRefetch?: () => Promise<void>) =>
    beforeRefetch ? beforeRefetch() : (mocks.handler?.() ?? Promise.resolve()),
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
  needsCatalogOutboxRepair: () => mocks.outboxRepairRequired,
}));
vi.mock('../../../offline/offline-sync-adapter', () => ({
  subscribeMutationDelivery: (listener: (event: { status: string }) => void) => {
    mocks.mutationListener = listener;
    return () => {
      mocks.mutationListener = undefined;
    };
  },
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
  getAuthorizedCatalogViewerId: () => mocks.markerRead(),
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
  mocks.offlineMode = false;
  mocks.transportRevision = 0;
  mocks.authorizedViewer = 'viewer';
  mocks.connectedListener = undefined;
  mocks.markerRead.mockReset().mockImplementation(async () => {
    if (mocks.mismatch) mocks.mismatchListener?.();
    return mocks.mismatch ? null : mocks.authorizedViewer;
  });
  mocks.state = 'active';
  mocks.credential = 0;
  mocks.mismatch = false;
  mocks.outboxRepairRequired = false;
  mocks.revalidate.mockReset().mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('privacy revocation subscription', () => {
  it.each([null, 'another-viewer'])(
    'repairs the startup marker %j without a server first event',
    async (authorizedViewer) => {
      mocks.authorizedViewer = authorizedViewer;
      render(<PrivacySyncBridge />);
      await act(async () => {});
      expect(mocks.revalidate).toHaveBeenCalledOnce();
      expect(mocks.revalidate.mock.calls[0][1]).toBe('viewer');
    },
  );

  it('keeps a matching startup marker until a connection needs fresh authorization', async () => {
    render(<PrivacySyncBridge />);
    await act(async () => {});
    expect(mocks.markerRead).toHaveBeenCalledOnce();
    expect(mocks.revalidate).not.toHaveBeenCalled();
    await act(async () => mocks.connectedListener?.());
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    await act(async () => mocks.connectedListener?.());
    expect(mocks.revalidate).toHaveBeenCalledTimes(2);
  });

  it('probes a missing startup marker when the database is first published', async () => {
    mocks.database = null;
    mocks.authorizedViewer = null;
    render(<PrivacySyncBridge />);
    await act(async () => {});
    expect(mocks.markerRead).not.toHaveBeenCalled();
    mocks.database = { id: 2 };
    await act(async () => mocks.databaseListener?.());
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    expect(mocks.revalidate.mock.calls[0][0]).toBe(mocks.database);
  });

  it('discards a startup marker probe after the credential changes', async () => {
    let finishProbe: ((viewer: string | null) => void) | undefined;
    mocks.markerRead.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishProbe = resolve;
        }),
    );
    render(<PrivacySyncBridge />);
    mocks.credential += 1;
    await act(async () => finishProbe?.(null));
    expect(mocks.revalidate).not.toHaveBeenCalled();
    await act(async () => mocks.connectedListener?.());
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    expect((mocks.revalidate.mock.calls[0][2] as () => boolean)()).toBe(true);
  });

  it('discards an old-account startup probe after the next account installs its bridge', async () => {
    let finishProbe: ((viewer: string | null) => void) | undefined;
    mocks.markerRead.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishProbe = resolve;
        }),
    );
    const view = render(<PrivacySyncBridge />);
    mocks.viewer = 'next-viewer';
    mocks.authorizedViewer = null;
    await act(async () => view.rerender(<PrivacySyncBridge />));
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    expect(mocks.revalidate.mock.calls[0][1]).toBe('next-viewer');
    await act(async () => finishProbe?.(null));
    expect(mocks.revalidate).toHaveBeenCalledOnce();
  });

  it('discards an old-handle startup probe while checking the replacement handle', async () => {
    let finishProbe: ((viewer: string | null) => void) | undefined;
    mocks.markerRead.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishProbe = resolve;
        }),
    );
    render(<PrivacySyncBridge />);
    mocks.database = { id: 2 };
    mocks.authorizedViewer = null;
    await act(async () => mocks.databaseListener?.());
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    expect(mocks.revalidate.mock.calls[0][0]).toBe(mocks.database);
    await act(async () => finishProbe?.(null));
    expect(mocks.revalidate).toHaveBeenCalledOnce();
  });

  it('coalesces reconnects and the compatibility first event while a repair runs', async () => {
    let finishRepair: (() => void) | undefined;
    mocks.revalidate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRepair = resolve;
        }),
    );
    render(<PrivacySyncBridge />);
    await act(async () => mocks.connectedListener?.());
    const oldCurrent = mocks.revalidate.mock.calls[0][2] as () => boolean;
    await act(async () => {
      mocks.connectedListener?.();
      revoke();
    });
    expect(oldCurrent()).toBe(false);
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    await act(async () => finishRepair?.());
    expect(mocks.revalidate).toHaveBeenCalledTimes(2);
  });

  it('rebinds the replaced socket after offline mode without invalidating valid offline downloads', async () => {
    const view = render(<PrivacySyncBridge />);
    await act(async () => {});
    const oldConnected = mocks.connectedListener;
    mocks.offlineMode = true;
    await act(async () => view.rerender(<PrivacySyncBridge />));
    expect(mocks.connectedListener).toBeUndefined();
    expect(mocks.revalidate).not.toHaveBeenCalled();
    mocks.offlineMode = false;
    await act(async () => view.rerender(<PrivacySyncBridge />));
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
    await act(async () => oldConnected?.());
    expect(mocks.revalidate).not.toHaveBeenCalled();
    await act(async () => mocks.connectedListener?.());
    expect(mocks.revalidate).toHaveBeenCalledOnce();
  });

  it('retires connection callbacks and a pending startup probe on unmount', async () => {
    let finishProbe: ((viewer: string | null) => void) | undefined;
    mocks.markerRead.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishProbe = resolve;
        }),
    );
    const view = render(<PrivacySyncBridge />);
    const oldConnected = mocks.connectedListener;
    view.unmount();
    expect(mocks.stopConnected).toHaveBeenCalledOnce();
    expect(mocks.connectedListener).toBeUndefined();
    await act(async () => {
      oldConnected?.();
      finishProbe?.(null);
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('withdraws on a connection before privacy readiness, then repairs once capability arrives', async () => {
    mocks.privacy = undefined;
    const view = render(<PrivacySyncBridge />);
    await act(async () => mocks.connectedListener?.());
    expect(mocks.require).toHaveBeenCalledOnce();
    expect(mocks.revalidate).not.toHaveBeenCalled();
    mocks.privacy = { enabled: false };
    await act(async () => view.rerender(<PrivacySyncBridge />));
    expect(mocks.revalidate).toHaveBeenCalledOnce();
  });

  it('withdraws on a connection before the profile is ready, then repairs its current viewer', async () => {
    mocks.viewer = '';
    const view = render(<PrivacySyncBridge />);
    await act(async () => mocks.connectedListener?.());
    expect(mocks.require).toHaveBeenCalledOnce();
    expect(mocks.revalidate).not.toHaveBeenCalled();
    mocks.viewer = 'viewer';
    await act(async () => view.rerender(<PrivacySyncBridge />));
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    expect(mocks.revalidate.mock.calls[0][1]).toBe('viewer');
  });

  it('rebinds the connection listener when the native viewer changes', async () => {
    const view = render(<PrivacySyncBridge />);
    await act(async () => {});
    const oldConnected = mocks.connectedListener;
    mocks.viewer = 'next-viewer';
    mocks.authorizedViewer = 'next-viewer';
    await act(async () => view.rerender(<PrivacySyncBridge />));
    expect(mocks.stopConnected).toHaveBeenCalledOnce();
    await act(async () => oldConnected?.());
    expect(mocks.revalidate).not.toHaveBeenCalled();
    await act(async () => mocks.connectedListener?.());
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    expect(mocks.revalidate.mock.calls[0][1]).toBe('next-viewer');
  });

  it('rebinds a same-viewer browser auth transport replacement', async () => {
    const view = render(<PrivacySyncBridge />);
    await act(async () => {});
    const oldConnected = mocks.connectedListener;
    mocks.transportRevision += 1;
    await act(async () => view.rerender(<PrivacySyncBridge />));
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
    expect(mocks.stopConnected).toHaveBeenCalledOnce();
    await act(async () => oldConnected?.());
    expect(mocks.revalidate).not.toHaveBeenCalled();
    await act(async () => mocks.connectedListener?.());
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    expect((mocks.revalidate.mock.calls[0][2] as () => boolean)()).toBe(true);
  });

  it('coalesces delivered writes into one repair of a preserved foreign row', async () => {
    render(<PrivacySyncBridge />);
    await act(async () => revoke());
    mocks.outboxRepairRequired = true;
    await act(async () => {
      mocks.mutationListener?.({ status: 'acknowledged' });
      mocks.mutationListener?.({ status: 'acknowledged' });
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(mocks.revalidate).toHaveBeenCalledTimes(2);
    mocks.outboxRepairRequired = false;
    await act(async () => {
      mocks.mutationListener?.({ status: 'acknowledged' });
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(mocks.revalidate).toHaveBeenCalledTimes(2);
  });

  it('repairs an acknowledgment that lands before a long initial cleanup marks itself blocked', async () => {
    let finishInitialRepair: (() => void) | undefined;
    mocks.revalidate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishInitialRepair = () => {
            mocks.outboxRepairRequired = true;
            resolve();
          };
        }),
    );
    render(<PrivacySyncBridge />);
    await act(async () => revoke());
    await act(async () => {
      mocks.mutationListener?.({ status: 'acknowledged' });
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    await act(async () => finishInitialRepair?.());
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(mocks.revalidate).toHaveBeenCalledTimes(2);
  });

  it('waits for foreground before repairing a delivered preserved write', async () => {
    render(<PrivacySyncBridge />);
    await act(async () => revoke());
    mocks.outboxRepairRequired = true;
    mocks.state = 'background';
    await act(async () => {
      mocks.mutationListener?.({ status: 'acknowledged' });
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(mocks.revalidate).toHaveBeenCalledOnce();
    mocks.state = 'active';
    await act(async () => mocks.foreground?.('active'));
    expect(mocks.revalidate).toHaveBeenCalledTimes(2);
  });

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
    mocks.offlineMode = false;
    mocks.authorizedViewer = 'viewer';
    mocks.connectedListener = undefined;
    mocks.markerRead.mockReset().mockImplementation(async () => {
      if (mocks.mismatch) mocks.mismatchListener?.();
      return mocks.mismatch ? null : mocks.authorizedViewer;
    });
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
