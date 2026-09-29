// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { BOARD_DISPLAY_ORDER, type UserDataExportStatus } from '@boardsesh/shared-schema';

const mocks = vi.hoisted(() => ({
  authenticated: true,
  profileId: 'climber-a',
  profileError: false,
  generation: 1,
  offline: false,
  status: undefined as UserDataExportStatus | undefined,
  statusError: false,
  statusLoading: false,
  pollStopped: false,
  request: vi.fn(),
  download: vi.fn(),
  refresh: vi.fn(),
  confirm: vi.fn(),
  outbox: vi.fn(),
  database: {},
  useExport: vi.fn(),
}));

type ComponentProps = Record<string, unknown> & { children?: ReactNode };
vi.mock('react-native', () => ({
  View: ({ children }: ComponentProps) => createElement('div', null, children),
  ScrollView: ({ children }: ComponentProps) => createElement('div', null, children),
  ActivityIndicator: () => createElement('div', { role: 'progressbar' }),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios },
  PlatformColor: (name: string) => name,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      key === 'export.unsyncedMessage' ? `${key}:${options?.count}` : key,
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('@boardsesh/board-constants', () => ({ boardTypeLabel: (boardName: string) => boardName }));
vi.mock('@boardsesh/offline-sync', () => ({ getOutboxSummary: mocks.outbox }));
vi.mock('../../db', () => ({ getDatabaseHandle: () => mocks.database }));
vi.mock('../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: mocks.authenticated }) }));
vi.mock('../../providers/dialog-provider', () => ({ useConfirm: () => mocks.confirm }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#555', secondaryBackground: '#fff' },
    brandColors: { error: '#c00', warning: '#960' },
  }),
}));
vi.mock('../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => mocks.generation,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === mocks.generation,
}));
vi.mock('../../lib/graphql/hooks', () => ({
  useProfile: () => ({
    data: mocks.profileId ? { id: mocks.profileId } : null,
    isError: mocks.profileError,
    refetch: mocks.refresh,
  }),
}));
vi.mock('../../lib/graphql/extract-error-message', () => ({
  isGraphqlRateLimitedError: (error: unknown) => error instanceof Error && error.message === 'rate_limited',
}));
vi.mock('../../lib/graphql/hooks/use-user-data-export', () => ({
  UserDataExportActionError: class UserDataExportActionError extends Error {
    reason = 'offline';
  },
  useUserDataExport: (userId: string, boardType: string) => {
    mocks.useExport(userId, boardType);
    return {
      statusQuery: {
        data: mocks.status,
        isError: mocks.statusError,
        isLoading: mocks.statusLoading,
        isFetching: false,
      },
      requestMutation: { mutateAsync: mocks.request, isPending: false },
      downloadMutation: { mutateAsync: mocks.download, isPending: false },
      refresh: mocks.refresh,
      pollLimitReached: mocks.pollStopped,
      isOffline: mocks.offline,
    };
  },
}));
vi.mock('../Text', () => ({ Text: ({ children }: ComponentProps) => createElement('span', null, children) }));
vi.mock('../SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => createElement('h2', null, title),
}));
vi.mock('../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) =>
    createElement('button', { onClick: onPress, disabled }, title),
}));
vi.mock('../RadioGroup', () => ({
  RadioGroup: ({
    options,
    value,
    onChange,
  }: {
    options: { value: string; label: string; disabled?: boolean }[];
    value: string;
    onChange: (next: string) => void;
  }) =>
    createElement(
      'fieldset',
      { 'data-current': value },
      options.map((option) =>
        // iOS ignores option.disabled; the screen must also guard its change handler.
        createElement(
          'button',
          { key: option.value, 'data-value': option.value, onClick: () => onChange(option.value) },
          option.label,
        ),
      ),
    ),
}));

import { UserDataExportScreen } from '../UserDataExportScreen';

function exportStatus(overrides: Partial<UserDataExportStatus> = {}): UserDataExportStatus {
  return {
    boardType: 'kilter',
    period: '2026-W40',
    status: 'not_requested',
    files: [],
    refreshAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    ...overrides,
  };
}
function readyExport(overrides: Partial<UserDataExportStatus> = {}): UserDataExportStatus {
  return exportStatus({
    status: 'ready',
    files: [
      {
        format: 'boardsesh',
        filename: 'kilter-boardsesh.json',
        exportedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      },
    ],
    ...overrides,
  });
}

beforeEach(() => {
  mocks.authenticated = true;
  mocks.profileId = 'climber-a';
  mocks.profileError = false;
  mocks.generation = 1;
  mocks.offline = false;
  mocks.status = exportStatus();
  mocks.statusError = false;
  mocks.statusLoading = false;
  mocks.pollStopped = false;
  mocks.request.mockReset().mockResolvedValue(exportStatus({ status: 'generating' }));
  mocks.download.mockReset().mockResolvedValue(undefined);
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.outbox.mockReset().mockResolvedValue({ pendingCount: 0, deadLetterCount: 0 });
  mocks.useExport.mockReset();
});
afterEach(cleanup);

describe('export screen and board choices', () => {
  it('offers all nine board families in display order, including spray walls', () => {
    render(<UserDataExportScreen />);
    const boardGroup = screen.getAllByRole('group')[0];
    expect(
      within(boardGroup)
        .getAllByRole('button')
        .map((button) => button.getAttribute('data-value')),
    ).toEqual([...BOARD_DISPLAY_ORDER]);
    expect(screen.getByRole('button', { name: 'export.sprayWalls' })).not.toBeNull();
    expect(screen.getAllByRole('group')[1].getAttribute('data-current')).toBe('boardsesh');
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.outbox).not.toHaveBeenCalled();
  });

  it('offers Aurora for its six boards and only Boardsesh for the other three', () => {
    render(<UserDataExportScreen />);
    for (const boardType of BOARD_DISPLAY_ORDER) {
      fireEvent.click(screen.getByRole('button', { name: boardType === 'spray' ? 'export.sprayWalls' : boardType }));
      expect(mocks.useExport).toHaveBeenLastCalledWith('climber-a', boardType);
      expect(screen.queryByRole('button', { name: 'export.auroraFormat' }) !== null).toBe(
        !['moonboard', 'woods', 'spray'].includes(boardType),
      );
    }
  });

  it('requires authentication even for a direct settings/export link', () => {
    mocks.authenticated = false;
    render(<UserDataExportScreen />);
    expect(screen.getByText('export.signIn')).not.toBeNull();
    expect(mocks.useExport).not.toHaveBeenCalled();
  });

  it('resets selection and local errors when a different account becomes active', () => {
    const { rerender } = render(<UserDataExportScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'tension' }));
    expect(mocks.useExport).toHaveBeenLastCalledWith('climber-a', 'tension');
    mocks.generation = 2;
    mocks.profileId = 'climber-b';
    rerender(<UserDataExportScreen />);
    expect(mocks.useExport).toHaveBeenLastCalledWith('climber-b', 'kilter');
  });
});

describe('generation preflight', () => {
  it('reads the current outbox once and prevents duplicate taps and board changes', async () => {
    let finishProbe: ((summary: { pendingCount: number; deadLetterCount: number }) => void) | undefined;
    mocks.outbox.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishProbe = resolve;
        }),
    );
    render(<UserDataExportScreen />);
    const generate = screen.getByRole('button', { name: 'export.generate' });
    fireEvent.click(generate);
    fireEvent.click(generate);
    fireEvent.click(screen.getByRole('button', { name: 'tension' }));
    expect(mocks.useExport).toHaveBeenLastCalledWith('climber-a', 'kilter');
    finishProbe?.({ pendingCount: 0, deadLetterCount: 0 });
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    expect(mocks.outbox).toHaveBeenCalledTimes(1);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('includes pending changes and dead letters in the wait/export choice', async () => {
    mocks.outbox.mockResolvedValue({ pendingCount: 2, deadLetterCount: 3 });
    render(<UserDataExportScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'export.generate' }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    expect(mocks.confirm).toHaveBeenCalledWith({
      title: 'export.unsyncedTitle',
      message: 'export.unsyncedMessage:5',
      confirmLabel: 'export.exportSynced',
      cancelLabel: 'export.waitForSync',
    });
  });

  it('does not request an export when the climber chooses to wait for sync', async () => {
    mocks.outbox.mockResolvedValue({ pendingCount: 1, deadLetterCount: 0 });
    mocks.confirm.mockResolvedValue(false);
    render(<UserDataExportScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'export.generate' }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'export.generate' }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('does not pretend a failed outbox read means all changes have synced', async () => {
    mocks.outbox.mockRejectedValue(new Error('database locked'));
    render(<UserDataExportScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'export.generate' }));
    await waitFor(() => expect(screen.getByText('export.outboxReadFailed')).not.toBeNull());
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('displays a request error and leaves an explicit retry available', async () => {
    mocks.request.mockRejectedValue(new Error('backend unavailable'));
    render(<UserDataExportScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'export.generate' }));
    await waitFor(() => expect(screen.getByText('export.requestFailed')).not.toBeNull());
    expect((screen.getByRole('button', { name: 'export.generate' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('cached export states and browser download', () => {
  it('shows the snapshot dates and downloads the default Boardsesh file without regenerating', async () => {
    mocks.status = readyExport();
    render(<UserDataExportScreen />);
    expect(screen.getByText('export.weekly')).not.toBeNull();
    expect(screen.getByText('export.expiry')).not.toBeNull();
    expect(screen.getByText('export.exportedAt')).not.toBeNull();
    expect(screen.getByText('export.expiresAt')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'export.generate' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'export.download' }));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledWith({ period: '2026-W40', format: 'boardsesh' }));
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each(['generating', 'failed'] as const)(
    'lets the complete archive download while its Aurora companion is %s',
    async (status) => {
      mocks.status = readyExport({ status });
      render(<UserDataExportScreen />);
      fireEvent.click(screen.getByRole('button', { name: 'export.download' }));
      await waitFor(() => expect(mocks.download).toHaveBeenCalledWith({ period: '2026-W40', format: 'boardsesh' }));
    },
  );

  it('downloads the Aurora alternative only when that file exists', async () => {
    const ready = readyExport();
    mocks.status = {
      ...ready,
      files: [...ready.files, { ...ready.files[0], format: 'aurora', filename: 'kilter-aurora.json' }],
    };
    render(<UserDataExportScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'export.auroraFormat' }));
    fireEvent.click(screen.getByRole('button', { name: 'export.download' }));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledWith({ period: '2026-W40', format: 'aurora' }));
  });

  it('disables network actions while offline', () => {
    mocks.offline = true;
    const { rerender } = render(<UserDataExportScreen />);
    expect((screen.getByRole('button', { name: 'export.generate' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'export.refresh' }) as HTMLButtonElement).disabled).toBe(true);
    mocks.status = readyExport();
    rerender(<UserDataExportScreen />);
    expect((screen.getByRole('button', { name: 'export.download' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows manual refresh after the automatic polling limit', async () => {
    mocks.status = exportStatus({ status: 'generating' });
    mocks.pollStopped = true;
    render(<UserDataExportScreen />);
    expect(screen.getByText('export.pollStopped')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'export.refresh' }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('shows the allowed retry date and disables retry during the weekly budget lock', () => {
    mocks.status = exportStatus({ status: 'failed', retryAt: new Date(Date.now() + 86_400_000).toISOString() });
    render(<UserDataExportScreen />);
    expect(screen.getByText('export.retryAt')).not.toBeNull();
    expect((screen.getByRole('button', { name: 'export.retry' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a visible error if the browser cannot open a fresh link', async () => {
    mocks.status = readyExport();
    mocks.download.mockRejectedValue(new Error('browser blocked'));
    render(<UserDataExportScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'export.download' }));
    await waitFor(() => expect(screen.getByText('export.downloadFailed')).not.toBeNull());
    expect((screen.getByRole('button', { name: 'export.download' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
