// @vitest-environment jsdom
//
// What this file pins is the CONTRACT of the sign-out confirm: it always asks, it
// only claims what is actually true for this user, and it never signs out on a
// cancel. Sign-out deletes the downloaded catalogs and the offline logbook and drops
// unsynced writes, so a dialog that fails open (or lies about downloads a flag-off
// user never had) is the bug.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement } from 'react';

const mockStorage = new Map<string, string>();
vi.mock('react-native-mmkv', () => {
  const createMockInstance = () => ({
    getString: (key: string) => mockStorage.get(key),
    set: (key: string, value: string) => void mockStorage.set(key, value),
    remove: (key: string) => void mockStorage.delete(key),
    clearAll: () => mockStorage.clear(),
  });
  return { createMMKV: vi.fn(() => createMockInstance()) };
});

const confirmMock = vi.fn(async (_options: unknown) => true);
vi.mock('../../providers/dialog-provider', () => ({
  useConfirm: () => confirmMock,
}));

const signOutMock = vi.fn(async (_method?: string) => {});
vi.mock('../../providers/auth-provider', () => ({
  useAuth: () => ({ signOut: signOutMock }),
}));

const databaseHandle = { current: {} as unknown };
vi.mock('../../db', () => ({
  getDatabaseHandle: () => databaseHandle.current,
}));

const getPendingCountMock = vi.fn(async (..._args: unknown[]) => 0);
vi.mock('@boardsesh/offline-sync', () => ({
  getPendingCount: (...args: unknown[]) => getPendingCountMock(...args),
}));

const reportErrorMock = vi.fn();
vi.mock('../../lib/error-reporting', () => ({
  reportError: (...args: unknown[]) => reportErrorMock(...args),
}));

// The real catalogs are large; echo the key back so assertions can name the exact
// string the dialog would show without pinning its wording.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}#${options.count}`),
  }),
}));

import { useConfirmSignOut } from '../use-confirm-sign-out';
import { setSetting } from '../../settings/hooks';

// The hook needs a render tree (it holds a ref); this drives it as a real component.
// `press` awaits the whole flow inside act(); `tap` fires it without awaiting, for the
// double-tap case where the first call must still be in flight when the second lands.
function renderConfirmSignOut(): { press: () => Promise<void>; tap: () => Promise<void> } {
  const hookRef = { current: null as (() => Promise<void>) | null };
  function Probe() {
    hookRef.current = useConfirmSignOut();
    return null;
  }
  render(createElement(Probe));
  const invoke = () => hookRef.current?.() ?? Promise.resolve();
  return {
    press: async () => {
      await act(async () => {
        await invoke();
      });
    },
    tap: invoke,
  };
}

function messageOf(call: number = 0): string {
  const options = confirmMock.mock.calls[call]?.[0] as { message?: string } | undefined;
  if (!options) throw new Error(`confirm was not called ${call + 1} time(s)`);
  return options.message ?? '';
}

beforeEach(() => {
  mockStorage.clear();
  confirmMock.mockClear();
  confirmMock.mockResolvedValue(true);
  signOutMock.mockClear();
  getPendingCountMock.mockClear();
  getPendingCountMock.mockResolvedValue(0);
  reportErrorMock.mockClear();
  databaseHandle.current = {};
});

describe('useConfirmSignOut', () => {
  it('confirms before signing out, and signs out as manual once confirmed', async () => {
    const { press } = renderConfirmSignOut();

    await press();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0][0]).toMatchObject({
      title: 'mobile.signOut.title',
      confirmLabel: 'mobile.signOut.confirm',
      cancelLabel: 'mobile.signOut.cancel',
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

  // Whether the offline sentence appears keys off the downloaded-boards list, NOT the
  // feature flag: the wipe isn't flag-gated, so a user whose flag was rolled back can
  // still be holding boards and still loses them.
  it('warns about downloaded boards only when the user has some', async () => {
    setSetting('syncEnabledBoards', ['kilter:1:1']);
    const withDownloads = renderConfirmSignOut();
    await withDownloads.press();
    expect(messageOf()).toContain('mobile.signOut.messageOffline');
    expect(messageOf()).not.toContain('mobile.signOut.message\n');

    confirmMock.mockClear();
    setSetting('syncEnabledBoards', []);
    const withoutDownloads = renderConfirmSignOut();
    await withoutDownloads.press();
    expect(messageOf()).toBe('mobile.signOut.message');
  });

  it('names the unsynced changes that signing out would discard', async () => {
    getPendingCountMock.mockResolvedValue(3);
    const { press } = renderConfirmSignOut();

    await press();

    expect(messageOf()).toContain('mobile.signOut.pending#3');
  });

  it('omits the unsynced warning when the queue is empty', async () => {
    const { press } = renderConfirmSignOut();

    await press();

    expect(messageOf()).not.toContain('mobile.signOut.pending');
  });

  it('still confirms when the pending-count read fails', async () => {
    getPendingCountMock.mockRejectedValue(new Error('database is locked'));
    const { press } = renderConfirmSignOut();

    await press();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(messageOf()).not.toContain('mobile.signOut.pending');
    expect(signOutMock).toHaveBeenCalledWith('manual');
  });

  it('still confirms when offline storage never initialised', async () => {
    databaseHandle.current = null;
    const { press } = renderConfirmSignOut();

    await press();

    expect(getPendingCountMock).not.toHaveBeenCalled();
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
});
