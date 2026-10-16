// @vitest-environment jsdom
//
// What this file pins is the CONTRACT of the sign-out confirm: it always asks, it
// only claims what is actually true for this device, and it never signs out on a
// cancel. Sign-out deletes the downloaded catalogs and the offline logbook and drops
// unsynced writes, so a dialog that fails open — or that lies about downloads a
// flag-off user never had — is the bug.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement } from 'react';

const confirmMock = vi.hoisted(() => vi.fn(async (_options: unknown) => true));
vi.mock('../../providers/dialog-provider', () => ({ useConfirm: () => confirmMock }));

const signOutMock = vi.hoisted(() => vi.fn(async (_method?: string) => {}));
vi.mock('../../providers/auth-provider', () => ({ useAuth: () => ({ signOut: signOutMock }) }));

const databaseHandle = vi.hoisted(() => ({ current: {} as unknown }));
vi.mock('../../db', () => ({ getDatabaseHandle: () => databaseHandle.current }));

const schemaDowngrade = vi.hoisted(() => ({
  current: null as { storedVersion: number; supportedVersion: number } | null,
}));
vi.mock('../../db/schema-downgrade', () => ({ getSchemaDowngrade: () => schemaDowngrade.current }));

const hasDownloadedBoardDataMock = vi.hoisted(() => vi.fn(async (): Promise<boolean> => false));
vi.mock('../../db/queries/board-download-status', () => ({
  hasDownloadedBoardData: hasDownloadedBoardDataMock,
}));

// One grouped gauge for the whole outbox — the same read the sign-out drain gate and
// the outbox telemetry use, so the dialog cannot report a different queue than they do.
type OutboxSummary = {
  pendingCount: number;
  deadLetterCount: number;
  oldestPendingAt: string | null;
  oldestDeadLetterAt: string | null;
};
const getOutboxSummaryMock = vi.hoisted(() =>
  vi.fn(async (): Promise<OutboxSummary> => ({
    pendingCount: 0,
    deadLetterCount: 0,
    oldestPendingAt: null,
    oldestDeadLetterAt: null,
  })),
);
vi.mock('@boardsesh/offline-sync', () => ({ getOutboxSummary: getOutboxSummaryMock }));

function outbox(pendingCount: number, deadLetterCount: number): OutboxSummary {
  return { pendingCount, deadLetterCount, oldestPendingAt: null, oldestDeadLetterAt: null };
}

const reportErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/error-reporting', () => ({ reportError: reportErrorMock }));

const showSignOutFailureMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/sign-out-failure-alert', () => ({ showSignOutFailure: showSignOutFailureMock }));

// The real catalogs are long; echo the key back so assertions can name the exact
// string the dialog would show without pinning its wording.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}#${options.count}`),
  }),
}));

import { useConfirmSignOut } from '../use-confirm-sign-out';

// The hook holds a ref, so it needs a render tree; this drives it as a real
// component. `press` awaits the whole flow inside act(); `tap` fires without
// awaiting, for the double-tap case where the first call must still be in flight.
function renderConfirmSignOut(): {
  press: (signal?: AbortSignal) => Promise<void>;
  tap: (signal?: AbortSignal) => Promise<void>;
} {
  const hookRef = { current: null as ((signal?: AbortSignal) => Promise<void>) | null };
  function Probe() {
    hookRef.current = useConfirmSignOut();
    return null;
  }
  render(createElement(Probe));
  const invoke = (signal?: AbortSignal) => hookRef.current?.(signal) ?? Promise.resolve();
  return {
    press: async (signal?: AbortSignal) => {
      await act(async () => {
        await invoke(signal);
      });
    },
    tap: invoke,
  };
}

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Result>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function messageOf(call = 0): string {
  const options = confirmMock.mock.calls[call]?.[0] as { message?: string } | undefined;
  if (!options) throw new Error(`confirm was not called ${call + 1} time(s)`);
  return options.message ?? '';
}

beforeEach(() => {
  confirmMock.mockClear();
  confirmMock.mockResolvedValue(true);
  signOutMock.mockClear();
  signOutMock.mockResolvedValue(undefined);
  getOutboxSummaryMock.mockClear();
  getOutboxSummaryMock.mockResolvedValue(outbox(0, 0));
  hasDownloadedBoardDataMock.mockClear();
  hasDownloadedBoardDataMock.mockResolvedValue(false);
  reportErrorMock.mockClear();
  showSignOutFailureMock.mockClear();
  databaseHandle.current = {};
  schemaDowngrade.current = null;
});

describe('useConfirmSignOut', () => {
  it('confirms before signing out, and signs out as manual once confirmed', async () => {
    const { press } = renderConfirmSignOut();

    await press();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0][0]).toMatchObject({
      title: 'mobile.settings.signOut.title',
      confirmLabel: 'mobile.settings.signOut.confirm',
      cancelLabel: 'mobile.settings.signOut.cancel',
      destructive: true,
    });
    expect(signOutMock).toHaveBeenCalledWith('manual');
  });

  it('does not sign out when the user cancels', async () => {
    confirmMock.mockResolvedValue(false);
    const { press } = renderConfirmSignOut();

    await press();

    expect(signOutMock).not.toHaveBeenCalled();
  });

  // The offline sentence keys off whether a catalog is actually on disk, NOT the
  // syncEnabledBoards toggle list — a flag rollback clears the list while the rows
  // remain, and those users lose the most.
  it('warns about downloaded boards only when a catalog is on disk', async () => {
    hasDownloadedBoardDataMock.mockResolvedValue(true);
    const withDownloads = renderConfirmSignOut();
    await withDownloads.press();
    expect(messageOf()).toBe('mobile.settings.signOut.messageOffline');

    confirmMock.mockClear();
    hasDownloadedBoardDataMock.mockResolvedValue(false);
    const withoutDownloads = renderConfirmSignOut();
    await withoutDownloads.press();
    expect(messageOf()).toBe('mobile.settings.signOut.message');
  });

  it('names the unsynced changes that signing out would discard', async () => {
    getOutboxSummaryMock.mockResolvedValue(outbox(3, 0));
    const { press } = renderConfirmSignOut();

    await press();

    expect(messageOf()).toContain('mobile.settings.signOut.pendingMessage#3');
  });

  it('says both when there are downloads and unsynced changes', async () => {
    hasDownloadedBoardDataMock.mockResolvedValue(true);
    getOutboxSummaryMock.mockResolvedValue(outbox(1, 0));
    const { press } = renderConfirmSignOut();

    await press();

    expect(messageOf()).toContain('mobile.settings.signOut.messageOffline');
    expect(messageOf()).toContain('mobile.settings.signOut.pendingMessage#1');
  });

  it('omits the unsynced warning when the queue is empty', async () => {
    const { press } = renderConfirmSignOut();

    await press();

    expect(messageOf()).not.toContain('mobile.settings.signOut.pendingMessage');
    expect(messageOf()).not.toContain('mobile.settings.signOut.failedMessage');
  });

  // The regression this pair exists for: the wipe DELETEs pending_mutations whole, but
  // the dialog counted only status = 'pending'. A user whose entire queue had
  // dead-lettered — the writes the More tab was already showing a Retry button for —
  // was told the neutral "you'll need to sign in again" and then lost them.
  it('warns about writes that already failed to sync, even with nothing pending', async () => {
    getOutboxSummaryMock.mockResolvedValue(outbox(0, 2));
    const { press } = renderConfirmSignOut();

    await press();

    expect(messageOf()).toContain('mobile.settings.signOut.failedMessage#2');
  });

  // Two counts, two sentences: a pending write still gets sign-out's drain, a dead
  // letter never will. Collapsing them into one number would promise an attempt that
  // cannot happen.
  it('counts pending and failed writes separately', async () => {
    getOutboxSummaryMock.mockResolvedValue(outbox(3, 1));
    const { press } = renderConfirmSignOut();

    await press();

    expect(messageOf()).toContain('mobile.settings.signOut.pendingMessage#3');
    expect(messageOf()).toContain('mobile.settings.signOut.failedMessage#1');
  });

  it('still confirms when the outbox read fails', async () => {
    getOutboxSummaryMock.mockRejectedValue(new Error('database is locked'));
    const { press } = renderConfirmSignOut();

    await press();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(messageOf()).not.toContain('mobile.settings.signOut.pendingMessage');
    expect(messageOf()).not.toContain('mobile.settings.signOut.failedMessage');
    expect(signOutMock).toHaveBeenCalledWith('manual');
  });

  // The probes are independent because they fail independently: SQLite hands out
  // "database is locked" per statement, and one grouped catch let a locked board query
  // erase an outbox count that had already come back — the dialog then said nothing
  // about writes the wipe was seconds from deleting.
  it('keeps the unsynced-writes warning when the downloads read fails', async () => {
    getOutboxSummaryMock.mockResolvedValue(outbox(2, 1));
    hasDownloadedBoardDataMock.mockRejectedValue(new Error('database is locked'));
    const { press } = renderConfirmSignOut();

    await press();

    expect(messageOf()).toContain('mobile.settings.signOut.pendingMessage#2');
    expect(messageOf()).toContain('mobile.settings.signOut.failedMessage#1');
    expect(messageOf()).toContain('mobile.settings.signOut.message');
    expect(signOutMock).toHaveBeenCalledWith('manual');
  });

  it('still checks for downloaded boards when the outbox read fails', async () => {
    getOutboxSummaryMock.mockRejectedValue(new Error('database is locked'));
    hasDownloadedBoardDataMock.mockResolvedValue(true);
    const { press } = renderConfirmSignOut();

    await press();

    expect(hasDownloadedBoardDataMock).toHaveBeenCalledTimes(1);
    expect(messageOf()).toBe('mobile.settings.signOut.messageOffline');
  });

  it('still confirms when offline storage never initialised', async () => {
    databaseHandle.current = null;
    const { press } = renderConfirmSignOut();

    await press();

    expect(getOutboxSummaryMock).not.toHaveBeenCalled();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(signOutMock).toHaveBeenCalledWith('manual');
  });

  it('raises one dialog and one sign-out for a double-tap', async () => {
    // Hold the dialog open so the second tap lands while the first is still in
    // flight — the exact race the in-flight guard exists for.
    let releaseConfirm: (value: boolean) => void = () => {};
    const dialogShown = new Promise<void>((ready) => {
      confirmMock.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            releaseConfirm = resolve;
            ready();
          }),
      );
    });
    const { tap } = renderConfirmSignOut();

    await act(async () => {
      const first = tap();
      await dialogShown;
      const second = tap();
      releaseConfirm(true);
      await Promise.all([first, second]);
    });

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it('lets the user retry after cancelling', async () => {
    confirmMock.mockResolvedValue(false);
    const { press } = renderConfirmSignOut();
    await press();

    confirmMock.mockResolvedValue(true);
    await press();

    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(signOutMock).toHaveBeenCalledWith('manual');
  });

  // A durable sign-out that never confirmed must stay visible: the account may still
  // be live on this device.
  it('surfaces a failed sign-out instead of swallowing it', async () => {
    const failure = new Error('NextAuth sign-out unavailable');
    signOutMock.mockRejectedValue(failure);
    const { press } = renderConfirmSignOut();

    await press();

    expect(reportErrorMock).toHaveBeenCalledWith(failure);
    expect(showSignOutFailureMock).toHaveBeenCalledWith(
      'mobile.settings.signOut.failureTitle',
      'mobile.settings.signOut.failure',
    );
  });

  it('lets the user confirm and retry after a failed sign-out', async () => {
    signOutMock.mockRejectedValueOnce(new Error('NextAuth sign-out unavailable'));
    const { press } = renderConfirmSignOut();

    await press();
    expect(showSignOutFailureMock).toHaveBeenCalledTimes(1);

    await press();

    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(signOutMock).toHaveBeenCalledTimes(2);
    expect(signOutMock).toHaveBeenLastCalledWith('manual');
    expect(showSignOutFailureMock).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending outbox probe and permits retry while that read never settles', async () => {
    getOutboxSummaryMock.mockReturnValueOnce(new Promise<OutboxSummary>(() => {}));
    const controller = new AbortController();
    const { tap, press } = renderConfirmSignOut();
    let settled = false;
    const abortedAttempt = tap(controller.signal).then(() => {
      settled = true;
    });

    controller.abort();
    await vi.waitFor(() => expect(settled).toBe(true));
    await abortedAttempt;

    expect(hasDownloadedBoardDataMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(signOutMock).not.toHaveBeenCalled();

    await press();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(showSignOutFailureMock).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('ignores late outbox %s after cancellation', async (outcome) => {
    const outboxRead = deferred<OutboxSummary>();
    getOutboxSummaryMock.mockReturnValueOnce(outboxRead.promise);
    const controller = new AbortController();
    const { tap } = renderConfirmSignOut();
    let settled = false;
    const attempt = tap(controller.signal).then(() => {
      settled = true;
    });

    controller.abort();
    await vi.waitFor(() => expect(settled).toBe(true));
    await attempt;
    if (outcome === 'resolve') outboxRead.resolve(outbox(2, 1));
    else outboxRead.reject(new Error('late read failure'));
    await Promise.resolve();
    await Promise.resolve();

    expect(hasDownloadedBoardDataMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(signOutMock).not.toHaveBeenCalled();
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)(
    'cancels a pending downloads probe and ignores its late %s',
    async (outcome) => {
      const downloadsRead = deferred<boolean>();
      hasDownloadedBoardDataMock.mockReturnValueOnce(downloadsRead.promise);
      const controller = new AbortController();
      const { tap } = renderConfirmSignOut();
      let settled = false;
      const attempt = tap(controller.signal).then(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(hasDownloadedBoardDataMock).toHaveBeenCalledTimes(1));

      controller.abort();
      await vi.waitFor(() => expect(settled).toBe(true));
      await attempt;
      if (outcome === 'resolve') downloadsRead.resolve(true);
      else downloadsRead.reject(new Error('late downloads failure'));
      await Promise.resolve();
      await Promise.resolve();

      expect(confirmMock).not.toHaveBeenCalled();
      expect(signOutMock).not.toHaveBeenCalled();
      expect(reportErrorMock).not.toHaveBeenCalled();
    },
  );

  it('keeps the retry single-flight when an aborted attempt finishes its old read', async () => {
    const oldRead = deferred<OutboxSummary>();
    const retryRead = deferred<OutboxSummary>();
    getOutboxSummaryMock.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(retryRead.promise);
    const controller = new AbortController();
    const { tap } = renderConfirmSignOut();
    let settled = false;
    const original = tap(controller.signal).then(() => {
      settled = true;
    });
    controller.abort();
    await vi.waitFor(() => expect(settled).toBe(true));
    await original;

    const retry = tap();
    oldRead.resolve(outbox(1, 0));
    await oldRead.promise;
    await tap();
    expect(getOutboxSummaryMock).toHaveBeenCalledTimes(2);
    expect(confirmMock).not.toHaveBeenCalled();

    retryRead.resolve(outbox(0, 0));
    await retry;
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it('finishes confirmed sign-out after cancellation during the pending sign-out', async () => {
    const signOut = deferred<void>();
    signOutMock.mockReturnValueOnce(signOut.promise);
    const controller = new AbortController();
    const { tap } = renderConfirmSignOut();
    const attempt = tap(controller.signal);
    await vi.waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));

    controller.abort();
    signOut.resolve(undefined);
    await attempt;

    expect(signOutMock).toHaveBeenCalledWith('manual');
    expect(showSignOutFailureMock).not.toHaveBeenCalled();
  });
});

describe('useConfirmSignOut when the offline database belongs to a newer app version', () => {
  beforeEach(() => {
    // The init chain never publishes a handle in this state.
    databaseHandle.current = null;
    schemaDowngrade.current = { storedVersion: 11, supportedVersion: 10 };
  });

  it('does not show a downgrade warning for a pre-aborted attempt', async () => {
    const controller = new AbortController();
    controller.abort();
    const { press } = renderConfirmSignOut();

    await press(controller.signal);

    expect(confirmMock).not.toHaveBeenCalled();
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it('warns about the sends waiting on this phone, with staying as the safe choice', async () => {
    const { press } = renderConfirmSignOut();

    await press();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).toHaveBeenCalledWith({
      title: 'mobile.settings.signOut.title',
      message: 'mobile.settings.signOut.downgradeMessage',
      confirmLabel: 'mobile.settings.signOut.downgradeConfirm',
      cancelLabel: 'mobile.settings.signOut.downgradeCancel',
      destructive: true,
    });
  });

  it('stays signed in when the climber backs out', async () => {
    confirmMock.mockResolvedValue(false);
    const { press } = renderConfirmSignOut();

    await press();

    expect(signOutMock).not.toHaveBeenCalled();
  });

  it('signs out when the climber chooses to anyway', async () => {
    const { press } = renderConfirmSignOut();

    await press();

    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(signOutMock).toHaveBeenCalledWith('manual');
  });

  it('never reads the refused database to compose the message', async () => {
    const { press } = renderConfirmSignOut();

    await press();

    expect(getOutboxSummaryMock).not.toHaveBeenCalled();
    expect(hasDownloadedBoardDataMock).not.toHaveBeenCalled();
  });
});
