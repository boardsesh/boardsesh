// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  AuroraCredentialStatus,
  AuroraCredentialsResponse,
  UnsyncedCounts,
} from '../../../lib/aurora-credentials';

const mocks = vi.hoisted(() => ({
  credentialsResponse: {
    credentials: [],
    kilterSyncAllowed: false,
  } as AuroraCredentialsResponse,
  credentialsError: null as Error | null,
  unsyncedCounts: {} as UnsyncedCounts,
  kilterOauthLinkingEnabled: false,
  confirm: vi.fn<() => Promise<boolean>>(),
  showToast: vi.fn(),
  connectKilterAccount: vi.fn<() => Promise<'connected' | 'cancelled' | 'error' | 'not_allowed'>>(),
  deleteAuroraCredential: vi.fn(),
  getDocumentAsync: vi.fn<() => Promise<{ canceled: true }>>(),
  saveAuroraCredential: vi.fn(),
  streamAuroraImport: vi.fn(),
  openUrl: vi.fn<(url: string) => Promise<void>>(),
  alert: vi.fn(),
}));

type RNNodeProps = {
  children?: ReactNode;
  testID?: string;
};

vi.mock('react-native', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
  Alert: { alert: (...args: unknown[]) => mocks.alert(...args) },
  KeyboardAvoidingView: ({ children }: RNNodeProps) => createElement('div', {}, children),
  Linking: { openURL: (url: string) => mocks.openUrl(url) },
  Modal: ({ children, visible }: RNNodeProps & { visible?: boolean }) =>
    visible ? createElement('div', {}, children) : null,
  Platform: { OS: 'ios' },
  PlatformColor: (colorName: string) => colorName,
  ScrollView: ({ children }: RNNodeProps) => createElement('div', {}, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  TextInput: () => createElement('input'),
  View: ({ children, testID }: RNNodeProps) => createElement('div', testID ? { 'data-testid': testID } : {}, children),
}));

vi.mock('expo-file-system', () => ({
  File: class MockFile {
    async text(): Promise<string> {
      return '{}';
    }
  },
}));

vi.mock('expo-document-picker', () => ({
  getDocumentAsync: mocks.getDocumentAsync,
}));

vi.mock('react-i18next', () => ({
  useTranslation: (namespace: string) => ({
    t: (key: string, opts?: { boardName?: string; name?: string }) => {
      const commonTranslations: Record<string, string> = {
        'actions.cancel': 'Cancel',
        'actions.retry': 'Retry',
      };
      const settingsTranslations: Record<string, string> = {
        'aurora.card.import': 'Import',
        'aurora.card.kilterConnectButton': 'Connect Kilter account',
        'aurora.card.kilterConnectCopy':
          'Hook up your Kilter account to pull your sends, attempts, ratings and circuits into Boardsesh. Pushing changes back to Kilter is coming soon.',
        'aurora.card.link': 'Link',
        'aurora.card.notConnected': `Not connected. Link your ${opts?.boardName ?? ''} account.`,
        'aurora.card.requestData': 'Request your data',
        'aurora.card.unlink': 'Unlink',
        'aurora.card.unlinkConfirm.description': `Are you sure you want to unlink your ${
          opts?.boardName ?? ''
        } account?`,
        'aurora.card.unlinkConfirm.title': 'Remove account link',
        'aurora.import.parseError': 'Failed to parse JSON file.',
        'aurora.import.dialog.errorTitle': 'Import Failed',
        'aurora.mobile.connected': 'Connected',
        'aurora.mobile.connectedAs': `Connected as ${opts?.name ?? ''}`,
        'aurora.mobile.importMissingUser': 'Choose an Aurora JSON export file.',
        'aurora.mobile.kilterAuroraCopy':
          'You can still request and import your data from the old Kilter App built by Aurora',
        'aurora.mobile.kilterAuroraTitle': 'Kilter (Aurora)',
        'aurora.mobile.kilterConnectFailed': 'Could not connect Kilter. Try again.',
        'aurora.mobile.kilterConnected': 'Kilter connected',
        'aurora.mobile.kilterNewTitle': 'Kilter (new)',
        'aurora.mobile.kilterNotAllowed': 'Kilter sync is not enabled for this account yet.',
        'aurora.mobile.loadFailed': 'Failed to load your board accounts.',
        'aurora.mobile.notConnected': 'Not connected',
        'aurora.status.connected': 'Connected',
        'aurora.title': 'Board Accounts',
      };
      const translations = namespace === 'common' ? commonTranslations : settingsTranslations;
      return translations[key] ?? key;
    },
  }),
}));

vi.mock('../../../providers/feature-flags-provider', () => ({
  useFeatureFlag: (key: string) =>
    key === 'kilter-oauth-linking' && mocks.kilterOauthLinkingEnabled ? true : undefined,
}));

vi.mock('../../../providers/dialog-provider', () => ({
  useConfirm: () => mocks.confirm,
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    colorScheme: 'light',
    systemColors: {
      fill: '#eee',
      secondaryBackground: '#fff',
      secondaryLabel: '#777',
      tertiaryBackground: '#f6f6f6',
    },
    brandColors: {
      error: '#c00',
      onPrimary: '#fff',
      primaryFill: '#333',
      warning: '#d80',
    },
  }),
}));

vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));

vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { 'data-button': title, onClick: onPress }, title),
}));

vi.mock('../../Icon', () => ({
  Icon: () => createElement('span', { 'data-icon': 'true' }),
}));

vi.mock('../../SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => createElement('h2', {}, title),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', {}, children),
}));

vi.mock('../../../lib/aurora-credentials', async () => {
  class BoardAccountError extends Error {
    readonly code: string;

    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }

  return {
    BoardAccountError,
    connectKilterAccount: mocks.connectKilterAccount,
    deleteAuroraCredential: mocks.deleteAuroraCredential,
    getAuroraCredentials: () =>
      mocks.credentialsError ? Promise.reject(mocks.credentialsError) : Promise.resolve(mocks.credentialsResponse),
    getAuroraUnsyncedCounts: () => Promise.resolve(mocks.unsyncedCounts),
    saveAuroraCredential: mocks.saveAuroraCredential,
    streamAuroraImport: mocks.streamAuroraImport,
  };
});

import { BoardAccountsSection } from '../BoardAccountsSection';

function makeCredential(overrides: Partial<AuroraCredentialStatus> = {}): AuroraCredentialStatus {
  return {
    auroraUserId: null,
    auroraUsername: '',
    boardType: 'kilter',
    createdAt: '2026-06-17T00:00:00.000Z',
    lastSyncAt: null,
    syncError: null,
    syncStatus: 'pending',
    ...overrides,
  };
}

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <BoardAccountsSection />
    </QueryClientProvider>,
  );
}

describe('BoardAccountsSection', () => {
  beforeEach(() => {
    mocks.credentialsResponse = { credentials: [], kilterSyncAllowed: false };
    mocks.credentialsError = null;
    mocks.unsyncedCounts = {};
    mocks.kilterOauthLinkingEnabled = false;
    mocks.confirm.mockReset();
    mocks.confirm.mockResolvedValue(true);
    mocks.showToast.mockReset();
    mocks.connectKilterAccount.mockReset();
    mocks.connectKilterAccount.mockResolvedValue('cancelled');
    mocks.deleteAuroraCredential.mockReset();
    mocks.deleteAuroraCredential.mockResolvedValue({ success: true });
    mocks.getDocumentAsync.mockReset();
    mocks.getDocumentAsync.mockResolvedValue({ canceled: true });
    mocks.saveAuroraCredential.mockReset();
    mocks.streamAuroraImport.mockReset();
    mocks.openUrl.mockReset();
    mocks.openUrl.mockResolvedValue(undefined);
    mocks.alert.mockReset();
  });

  it('hides the new Kilter OAuth card when the feature flag is off', async () => {
    renderSection();

    expect(await screen.findByText('Kilter (Aurora)')).toBeTruthy();
    expect(screen.queryByText('Kilter (new)')).toBeNull();
    expect(screen.queryByText('Connect Kilter account')).toBeNull();
    expect(
      screen.getByText('You can still request and import your data from the old Kilter App built by Aurora'),
    ).toBeTruthy();
  });

  it('hides the new Kilter OAuth card when the feature flag is on but sync is not allowed', async () => {
    mocks.kilterOauthLinkingEnabled = true;

    renderSection();

    expect(await screen.findByText('Kilter (Aurora)')).toBeTruthy();
    expect(screen.queryByText('Kilter (new)')).toBeNull();
    expect(screen.queryByText('Connect Kilter account')).toBeNull();
  });

  it('shows the new Kilter OAuth card when the feature flag and sync allowlist are on', async () => {
    mocks.kilterOauthLinkingEnabled = true;
    mocks.credentialsResponse = { credentials: [], kilterSyncAllowed: true };

    renderSection();

    expect(await screen.findByText('Kilter (Aurora)')).toBeTruthy();
    expect(screen.getByText('Kilter (new)')).toBeTruthy();

    const kilterNewCard = screen.getByTestId('board-account-kilterNew-kilter');
    expect(within(kilterNewCard).getByText('Connect Kilter account')).toBeTruthy();
  });

  it('shows a Kilter credential only on the new Kilter card', async () => {
    mocks.kilterOauthLinkingEnabled = true;
    mocks.credentialsResponse = {
      credentials: [makeCredential({ auroraUsername: 'marco', syncStatus: 'active' })],
      kilterSyncAllowed: true,
    };

    renderSection();

    await waitFor(() => {
      expect(screen.getByText('Kilter (new)')).toBeTruthy();
    });

    const kilterAuroraCard = screen.getByTestId('board-account-kilterAurora-kilter');
    const kilterNewCard = screen.getByTestId('board-account-kilterNew-kilter');

    expect(within(kilterAuroraCard).queryByText('Connected as marco')).toBeNull();
    expect(within(kilterAuroraCard).getByText('Import')).toBeTruthy();
    expect(within(kilterAuroraCard).getByText('Request your data')).toBeTruthy();
    expect(within(kilterNewCard).getByText('Connected as marco')).toBeTruthy();
    expect(within(kilterNewCard).queryByText('Import')).toBeNull();
    expect(within(kilterNewCard).getByText('Unlink')).toBeTruthy();
  });

  it('opens the Aurora data request flow from the Kilter Aurora card', async () => {
    renderSection();

    const kilterAuroraCard = await screen.findByTestId('board-account-kilterAurora-kilter');
    fireEvent.click(within(kilterAuroraCard).getByText('Request your data'));

    expect(mocks.openUrl).toHaveBeenCalledWith(expect.stringContaining('mailto:peter@auroraclimbing.com'));
  });

  it('unlinks a connected Kilter account from the new Kilter card', async () => {
    mocks.kilterOauthLinkingEnabled = true;
    mocks.credentialsResponse = {
      credentials: [makeCredential({ auroraUsername: 'marco', syncStatus: 'active' })],
      kilterSyncAllowed: true,
    };

    renderSection();

    const kilterNewCard = await screen.findByTestId('board-account-kilterNew-kilter');
    fireEvent.click(within(kilterNewCard).getByText('Unlink'));

    await waitFor(() => {
      expect(mocks.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Are you sure you want to unlink your Kilter (new) account?',
        }),
      );
      expect(mocks.deleteAuroraCredential).toHaveBeenCalled();
      expect(mocks.deleteAuroraCredential.mock.calls[0]?.[0]).toBe('kilter');
    });
  });

  it('opens the Kilter Aurora import picker from the Kilter Aurora card', async () => {
    renderSection();

    const kilterAuroraCard = await screen.findByTestId('board-account-kilterAurora-kilter');
    fireEvent.click(within(kilterAuroraCard).getByText('Import'));

    await waitFor(() => {
      expect(mocks.getDocumentAsync).toHaveBeenCalledWith({
        type: 'application/json',
        copyToCacheDirectory: true,
      });
    });
  });

  it.each([
    ['connected' as const, 'Kilter connected', 'success'],
    ['not_allowed' as const, 'Kilter sync is not enabled for this account yet.', 'error'],
    ['error' as const, 'Could not connect Kilter. Try again.', 'error'],
  ])('surfaces the Kilter connect %s result', async (connectResult, toastMessage, toastType) => {
    mocks.kilterOauthLinkingEnabled = true;
    mocks.credentialsResponse = { credentials: [], kilterSyncAllowed: true };
    mocks.connectKilterAccount.mockResolvedValue(connectResult);

    renderSection();

    const kilterNewCard = await screen.findByTestId('board-account-kilterNew-kilter');
    fireEvent.click(within(kilterNewCard).getByText('Connect Kilter account'));

    await waitFor(() => {
      expect(mocks.connectKilterAccount).toHaveBeenCalledOnce();
      expect(mocks.showToast).toHaveBeenCalledWith(toastMessage, toastType);
    });
  });

  it('shows the load error instead of Kilter cards when the account request fails', async () => {
    mocks.kilterOauthLinkingEnabled = true;
    mocks.credentialsError = new Error('load failed');

    renderSection();

    expect(await screen.findByText('Failed to load your board accounts.')).toBeTruthy();
    expect(screen.queryByText('Kilter (Aurora)')).toBeNull();
    expect(screen.queryByText('Kilter (new)')).toBeNull();
    expect(screen.getByText('Retry')).toBeTruthy();
  });
});
