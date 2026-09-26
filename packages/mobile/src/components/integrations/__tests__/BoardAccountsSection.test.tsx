// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR } from '@boardsesh/shared-schema/sync-error-codes';
import {
  BoardAccountError,
  type AuroraCredentialStatus,
  type AuroraCredentialsResponse,
} from '../../../lib/aurora-credentials';

// --- Hoisted mock state, mutated per-test before render ---
const mocks = vi.hoisted(() => ({
  saveAurora: vi.fn(),
  saveKilterViaPassword: vi.fn(() => Promise.resolve()),
  deleteAurora: vi.fn(),
  streamImport: vi.fn(),
  streamMoonBoardImport: vi.fn(),
  parseMoonBoardCsv: vi.fn(),
  pickDocument: vi.fn(),
  fileText: vi.fn(),
  showToast: vi.fn(),
  openURL: vi.fn((_url: string) => Promise.resolve()),
  setClipboard: vi.fn((_text: string) => Promise.resolve()),
  confirm: vi.fn(() => Promise.resolve(true)),
  invalidate: vi.fn(() => Promise.resolve()),
  refetch: vi.fn(() => Promise.resolve()),
  flags: {} as Record<string, boolean | undefined>,
  credentials: [] as AuroraCredentialStatus[],
  auroraBoards: ['kilter', 'tension'],
  linkStarted: vi.fn(),
  linkSucceeded: vi.fn(),
  linkFailed: vi.fn(),
}));

vi.mock('../../../lib/integrations/board-link-analytics', () => ({
  trackLinkStarted: mocks.linkStarted,
  trackLinkSucceeded: mocks.linkSucceeded,
  trackLinkFailed: mocks.linkFailed,
}));

vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock('../../../lib/auth-interceptor', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../../lib/env', () => ({ BACKEND_URL: 'https://backend.test' }));

vi.mock('../../../lib/aurora-credentials', async (importOriginal) => {
  const { BoardAccountError } = await importOriginal<typeof import('../../../lib/aurora-credentials')>();
  return {
    BoardAccountError,
    getAuroraCredentials: () => Promise.resolve({ credentials: [] }),
    getAuroraUnsyncedCounts: () => Promise.resolve({}),
    saveAuroraCredential: mocks.saveAurora,
    saveKilterCredentialViaPassword: mocks.saveKilterViaPassword,
    deleteAuroraCredential: mocks.deleteAurora,
    streamAuroraImport: mocks.streamImport,
    streamMoonBoardImport: mocks.streamMoonBoardImport,
  };
});

vi.mock('@boardsesh/shared-schema', () => ({
  AURORA_BOARDS: mocks.auroraBoards,
  parseAuroraExportJson: vi.fn(() => ({
    data: { user: { username: 'aurora' }, ascents: [], attempts: [], circuits: [], climbs: [] },
    preview: { username: 'aurora', ascents: 0, attempts: 0, circuits: 0, climbs: 0 },
  })),
  parseMoonBoardExportCsv: mocks.parseMoonBoardCsv,
}));

type MutationOptions = {
  mutationFn: (vars: unknown) => unknown;
  onSuccess?: (result: unknown, vars: unknown) => unknown;
  onError?: (error: unknown, variables: unknown) => unknown;
};

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
  useQuery: (opts: { queryKey: readonly unknown[] }) => {
    const isCredentials = opts.queryKey[0] === 'auroraCredentials' && opts.queryKey[1] !== 'unsynced';
    return {
      data: isCredentials ? ({ credentials: mocks.credentials } as AuroraCredentialsResponse) : {},
      isPending: false,
      isError: false,
      isSuccess: true,
      isFetching: false,
      refetch: mocks.refetch,
    };
  },
  useMutation: (opts: MutationOptions) => ({
    mutate: (vars: unknown) => {
      void Promise.resolve(opts.mutationFn(vars))
        .then((result) => opts.onSuccess?.(result, vars))
        .catch((error) => opts.onError?.(error, vars));
    },
    isPending: false,
    variables: undefined,
  }),
}));

type RNProps = { children?: ReactNode; visible?: boolean };
vi.mock('react-native', () => ({
  View: ({ children }: RNProps) => createElement('div', {}, children),
  ScrollView: ({ children }: RNProps) => createElement('div', {}, children),
  KeyboardAvoidingView: ({ children }: RNProps) => createElement('div', {}, children),
  Modal: ({ visible, children }: RNProps) => (visible ? createElement('div', {}, children) : null),
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
  TextInput: ({
    value,
    onChangeText,
    placeholder,
  }: {
    value?: string;
    onChangeText?: (next: string) => void;
    placeholder?: string;
  }) =>
    createElement('input', {
      value: value ?? '',
      'data-input': placeholder,
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
    }),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios' },
  Linking: { openURL: mocks.openURL },
}));

vi.mock('expo-document-picker', () => ({ getDocumentAsync: mocks.pickDocument }));
vi.mock('expo-file-system', () => ({
  File: class File {
    private readonly uri: string;

    constructor(uri: string) {
      this.uri = uri;
    }

    text() {
      return mocks.fileText(this.uri);
    }
  },
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: mocks.setClipboard }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { name?: string }) => (opts?.name != null ? `${key}:${opts.name}` : key),
  }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      secondaryBackground: '#fff',
      secondaryLabel: '#888',
      tertiaryBackground: '#eee',
      fill: '#ddd',
    },
    brandColors: { primary: '#6D28D9', primaryFill: '#eee', onPrimary: '#fff', error: '#C81E1E', warning: '#F59E0B' },
    colorScheme: 'light',
  }),
}));

vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: mocks.showToast }) }));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => mocks.confirm }));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useFeatureFlag: (key: string) => mocks.flags[key],
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
  borderRadius: { md: 8, lg: 12, full: 999 },
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { white: '#fff' } }));

type TextProps = { children?: ReactNode; variant?: string };
vi.mock('../../Text', () => ({
  Text: ({ children, variant }: TextProps) => createElement('span', { 'data-text-variant': variant }, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('span', { 'data-icon': 'true' }) }));
vi.mock('../../SectionHeader', () => ({
  SectionHeader: () => createElement('div', { 'data-section-header': 'true' }),
}));

type ButtonProps = { title: string; onPress?: () => void; disabled?: boolean };
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: ButtonProps) =>
    createElement('button', { 'data-button': title, disabled: !!disabled, onClick: onPress }),
}));

import { BoardAccountsSection } from '../BoardAccountsSection';
import { LinkBoardAccountModal } from '../LinkBoardAccountModal';

const button = (root: HTMLElement, title: string) =>
  root.querySelector(`[data-button="${title}"]`) as HTMLButtonElement | null;

const input = (root: HTMLElement, placeholder: string) =>
  root.querySelector(`[data-input="${placeholder}"]`) as HTMLInputElement | null;

beforeEach(() => {
  mocks.auroraBoards.splice(0, mocks.auroraBoards.length, 'kilter', 'tension');
});

describe('BoardAccountsSection — board cards', () => {
  beforeEach(() => {
    mocks.saveAurora.mockReset();
    mocks.saveKilterViaPassword.mockReset().mockResolvedValue(undefined);
    mocks.showToast.mockReset();
    mocks.invalidate.mockClear();
    mocks.flags = {};
    mocks.credentials = [];
  });

  it('renders the So iLL card heading with its canonical brand name', () => {
    mocks.auroraBoards.push('soill');
    const { getByText } = render(<BoardAccountsSection />);
    expect(getByText('So iLL', { selector: '[data-text-variant="headline"]' })).toBeTruthy();
  });

  it('shows the Kilter (new) sign-in card when the flag is on', () => {
    mocks.flags = { 'kilter-oauth-linking': true };
    const { container } = render(<BoardAccountsSection />);
    expect(button(container, 'aurora.card.kilterSignIn')).not.toBeNull();
  });

  it('hides the Kilter (new) card when the flag is off and nothing is linked', () => {
    mocks.flags = { 'kilter-oauth-linking': false };
    const { container } = render(<BoardAccountsSection />);
    expect(button(container, 'aurora.card.kilterSignIn')).toBeNull();
    // The legacy Kilter (Aurora) import path is still offered.
    expect(button(container, 'aurora.card.requestData')).not.toBeNull();
  });

  it('keeps the Kilter (new) card when the flag is off but an account is already linked', () => {
    // The core UX promise: a linked Kilter account stays manageable even after
    // the flag is switched off (showKilterNew = flag || hasKilterCredential).
    mocks.flags = { 'kilter-oauth-linking': false };
    mocks.credentials = [
      {
        boardType: 'kilter',
        auroraUsername: 'kilteruser',
        auroraUserId: null,
        lastSyncAt: null,
        syncStatus: 'synced',
        syncError: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const { container } = render(<BoardAccountsSection />);
    // The connected card (Unlink) shows; the sign-in button does not.
    expect(button(container, 'aurora.card.unlink')).not.toBeNull();
    expect(button(container, 'aurora.card.kilterSignIn')).toBeNull();
  });

  it('links Kilter via the password grant when the sign-in form is submitted', async () => {
    mocks.flags = { 'kilter-oauth-linking': true };
    const { container } = render(<BoardAccountsSection />);

    fireEvent.click(button(container, 'aurora.card.kilterSignIn')!);

    fireEvent.change(input(container, 'aurora.kilterLinkDialog.emailPlaceholder')!, {
      target: { value: 'climber' },
    });
    fireEvent.change(input(container, 'aurora.linkDialog.passwordPlaceholder')!, {
      target: { value: 'secret' },
    });

    fireEvent.click(button(container, 'aurora.linkDialog.submit')!);

    await waitFor(() => {
      expect(mocks.saveKilterViaPassword).toHaveBeenCalledWith({ username: 'climber', password: 'secret' });
    });
    expect(mocks.saveAurora).not.toHaveBeenCalled();
  });

  it('reports invalid Kilter credentials as an email problem, not a username one', async () => {
    mocks.flags = { 'kilter-oauth-linking': true };
    mocks.saveKilterViaPassword.mockRejectedValue(new BoardAccountError('invalid_credentials'));
    const { container } = render(<BoardAccountsSection />);

    fireEvent.click(button(container, 'aurora.card.kilterSignIn')!);
    fireEvent.change(input(container, 'aurora.kilterLinkDialog.emailPlaceholder')!, {
      target: { value: 'climber@example.com' },
    });
    fireEvent.change(input(container, 'aurora.linkDialog.passwordPlaceholder')!, {
      target: { value: 'wrong' },
    });
    fireEvent.click(button(container, 'aurora.linkDialog.submit')!);

    await waitFor(() => {
      expect(mocks.showToast).toHaveBeenCalledWith('aurora.mobile.invalidCredentialsKilter', 'error');
    });
    expect(mocks.showToast).not.toHaveBeenCalledWith('aurora.mobile.invalidCredentials', 'error');
  });
});

describe('BoardAccountsSection — link funnel', () => {
  beforeEach(() => {
    mocks.saveAurora.mockReset().mockResolvedValue(null);
    mocks.showToast.mockReset();
    mocks.invalidate.mockClear();
    mocks.linkStarted.mockReset();
    mocks.linkSucceeded.mockReset();
    mocks.linkFailed.mockReset();
    mocks.flags = {};
    mocks.credentials = [];
  });

  const submitTensionLink = (container: HTMLElement) => {
    fireEvent.click(button(container, 'aurora.card.link')!);
    fireEvent.change(input(container, 'aurora.linkDialog.usernamePlaceholder')!, {
      target: { value: 'climber' },
    });
    fireEvent.change(input(container, 'aurora.linkDialog.passwordPlaceholder')!, {
      target: { value: 'secret' },
    });
    fireEvent.click(button(container, 'aurora.linkDialog.submit')!);
  };

  it('reports a start and a success, tagged with the board and the surface', async () => {
    const { container } = render(<BoardAccountsSection />);
    submitTensionLink(container);

    await waitFor(() => expect(mocks.linkSucceeded).toHaveBeenCalledTimes(1));
    expect(mocks.linkStarted).toHaveBeenCalledWith({ boardType: 'tension', source: 'integrations' });
    expect(mocks.linkSucceeded).toHaveBeenCalledWith({ boardType: 'tension', source: 'integrations' });
    expect(mocks.linkFailed).not.toHaveBeenCalled();
  });

  it('reports a failure with its reason, on the board the attempt was for', async () => {
    mocks.saveAurora.mockRejectedValue(new Error('offline'));
    const { container } = render(<BoardAccountsSection />);
    submitTensionLink(container);

    await waitFor(() => expect(mocks.linkFailed).toHaveBeenCalledTimes(1));
    expect(mocks.linkFailed).toHaveBeenCalledWith({ boardType: 'tension', source: 'integrations' }, 'request_failed');
    expect(mocks.linkStarted).toHaveBeenCalledTimes(1);
    expect(mocks.linkSucceeded).not.toHaveBeenCalled();
  });

  it.each(['invalid_credentials', 'account_already_linked'] as const)(
    'reports the server %s error code once without a success',
    async (code) => {
      mocks.saveAurora.mockRejectedValue(new BoardAccountError(code));
      const { container } = render(<BoardAccountsSection />);
      submitTensionLink(container);

      await waitFor(() => expect(mocks.linkFailed).toHaveBeenCalledTimes(1));
      expect(mocks.linkFailed).toHaveBeenCalledWith({ boardType: 'tension', source: 'integrations' }, code);
      expect(mocks.linkStarted).toHaveBeenCalledTimes(1);
      expect(mocks.linkSucceeded).not.toHaveBeenCalled();
    },
  );

  it('does not report a start when the dialog is opened but never submitted', () => {
    const { container } = render(<BoardAccountsSection />);
    fireEvent.click(button(container, 'aurora.card.link')!);
    expect(mocks.linkStarted).not.toHaveBeenCalled();
  });
});

describe('BoardAccountsSection — MoonBoard card', () => {
  beforeEach(() => {
    mocks.showToast.mockReset();
    mocks.openURL.mockReset().mockResolvedValue(undefined);
    mocks.setClipboard.mockReset().mockResolvedValue(undefined);
    mocks.streamMoonBoardImport.mockReset().mockResolvedValue(undefined);
    mocks.parseMoonBoardCsv.mockReset().mockReturnValue({
      data: { rows: [{ problemId: 123 }] },
      preview: { username: 'moonuser', rows: 3, sends: 1, flashes: 1, attempts: 2, projects: 1, fails: 0, angle: 40 },
    });
    mocks.pickDocument.mockReset().mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file://moonboard.csv', size: 128 }],
    });
    mocks.fileText
      .mockReset()
      .mockResolvedValue('ProblemId,Grade,Tries,Attempts,Rating,Date\n123,6B+,Send,1,3,2026-01-01');
    mocks.confirm.mockReset().mockResolvedValue(true);
    mocks.flags = {};
    mocks.credentials = [];
  });

  it('renders the MoonBoard card with import and request-data actions', () => {
    const { container } = render(<BoardAccountsSection />);
    expect(button(container, 'aurora.moonboard.import')).not.toBeNull();
    expect(button(container, 'aurora.moonboard.requestData')).not.toBeNull();
  });

  it('copies the request body and opens a subject-only MoonBoard email after confirming', async () => {
    const { container } = render(<BoardAccountsSection />);
    fireEvent.click(button(container, 'aurora.moonboard.requestData')!);
    await waitFor(() => {
      expect(mocks.setClipboard).toHaveBeenCalledWith('aurora.moonboard.email.body');
      expect(mocks.openURL).toHaveBeenCalledTimes(1);
    });
    // The paste instruction is shown in a dialog before the app switches away.
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    const mailto = mocks.openURL.mock.calls[0]?.[0] ?? '';
    expect(mailto).toContain('mailto:moonboardsupport@moonclimbing.com');
    // The long GDPR letter rides the clipboard, so it must not be encoded into
    // the mailto: body (which would blow past client URI limits).
    expect(mailto).not.toContain('body=');
  });

  it('opens a CSV picker and shows the MoonBoard preview from the selected file', async () => {
    const { container } = render(<BoardAccountsSection />);

    fireEvent.click(button(container, 'aurora.moonboard.import')!);

    await waitFor(() => {
      expect(mocks.pickDocument).toHaveBeenCalledWith({
        type: ['text/csv', 'text/plain', 'application/vnd.ms-excel'],
        copyToCacheDirectory: true,
      });
      expect(mocks.fileText).toHaveBeenCalledWith('file://moonboard.csv');
      expect(mocks.parseMoonBoardCsv).toHaveBeenCalledWith(
        'ProblemId,Grade,Tries,Attempts,Rating,Date\n123,6B+,Send,1,3,2026-01-01',
      );
      expect(button(container, 'aurora.import.dialog.confirm')).not.toBeNull();
      expect(container.textContent).toContain('aurora.moonboard.importDialog.flashes');
    });
  });

  it('copies the letter but leaves email unopened when the dialog is dismissed', async () => {
    mocks.confirm.mockReset().mockResolvedValueOnce(false);
    const { container } = render(<BoardAccountsSection />);
    fireEvent.click(button(container, 'aurora.moonboard.requestData')!);
    await waitFor(() => {
      expect(mocks.setClipboard).toHaveBeenCalledWith('aurora.moonboard.email.body');
      expect(mocks.confirm).toHaveBeenCalledTimes(1);
    });
    expect(mocks.openURL).not.toHaveBeenCalled();
  });

  it('shows an error toast when the mail draft fails to open after confirming', async () => {
    mocks.openURL.mockReset().mockRejectedValueOnce(new Error('no mail handler'));
    const { container } = render(<BoardAccountsSection />);
    fireEvent.click(button(container, 'aurora.moonboard.requestData')!);
    await waitFor(() => {
      expect(mocks.showToast).toHaveBeenCalledWith('aurora.mobile.requestDataFailed', 'error');
    });
  });

  it('shows a copy-failed toast and skips the dialog and email when the clipboard write fails', async () => {
    mocks.setClipboard.mockReset().mockRejectedValueOnce(new Error('no clipboard'));
    const { container } = render(<BoardAccountsSection />);
    fireEvent.click(button(container, 'aurora.moonboard.requestData')!);
    await waitFor(() => {
      expect(mocks.showToast).toHaveBeenCalledWith('aurora.mobile.requestDataCopyFailed', 'error');
    });
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.openURL).not.toHaveBeenCalled();
  });

  it('streams the MoonBoard import after preview confirmation', async () => {
    mocks.streamMoonBoardImport.mockImplementation(
      async (_data: unknown, onEvent: (event: { type: 'complete'; results: unknown }) => void) => {
        onEvent({
          type: 'complete',
          results: {
            ascents: { imported: 1, skipped: 0, failed: 0 },
            attempts: { imported: 2, skipped: 0, failed: 0 },
            unresolvedClimbs: [],
          },
        });
      },
    );
    const { container } = render(<BoardAccountsSection />);
    fireEvent.click(button(container, 'aurora.moonboard.import')!);
    await waitFor(() => {
      expect(button(container, 'aurora.import.dialog.confirm')).not.toBeNull();
    });

    fireEvent.click(button(container, 'aurora.import.dialog.confirm')!);

    await waitFor(() => {
      expect(mocks.streamMoonBoardImport).toHaveBeenCalledWith({ rows: [{ problemId: 123 }] }, expect.any(Function));
      expect(mocks.showToast).toHaveBeenCalledWith('aurora.moonboard.csvImport.successCount', 'success');
    });
  });

  it('shows the localized failed copy when the MoonBoard import stream rejects', async () => {
    mocks.streamMoonBoardImport.mockRejectedValueOnce(new Error('moonboard_import_failed'));
    const { container } = render(<BoardAccountsSection />);
    fireEvent.click(button(container, 'aurora.moonboard.import')!);
    await waitFor(() => {
      expect(button(container, 'aurora.import.dialog.confirm')).not.toBeNull();
    });

    fireEvent.click(button(container, 'aurora.import.dialog.confirm')!);

    await waitFor(() => {
      expect(mocks.showToast).toHaveBeenCalledWith('aurora.moonboard.csvImport.failed', 'error');
      expect(container.textContent).toContain('aurora.moonboard.csvImport.failed');
    });
    expect(container.textContent).not.toContain('aurora.moonboard.csvImport.interrupted');
  });

  it('closes the MoonBoard preview dialog via the Cancel button', async () => {
    const { container } = render(<BoardAccountsSection />);
    fireEvent.click(button(container, 'aurora.moonboard.import')!);
    await waitFor(() => {
      expect(button(container, 'actions.cancel')).not.toBeNull();
    });

    fireEvent.click(button(container, 'actions.cancel')!);
    expect(button(container, 'aurora.import.dialog.confirm')).toBeNull();
  });
});

describe('BoardAccountsSection — sync_error on a connected board card (#3526)', () => {
  const connectedCredential = (syncError: string | null): AuroraCredentialStatus => ({
    boardType: 'tension',
    auroraUsername: 'climber',
    auroraUserId: 144574,
    lastSyncAt: '2026-07-25T00:00:00.000Z',
    // Actively syncing. The circuits guard refuses the playlist mirror without
    // failing the credential, so `active` + a sync_error is the normal shape.
    syncStatus: 'active',
    syncError,
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  beforeEach(() => {
    mocks.flags = {};
    mocks.credentials = [];
  });

  it('explains the duplicate board-account link instead of a bare red Error pill', () => {
    mocks.credentials = [connectedCredential(DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR)];
    const { container } = render(<BoardAccountsSection />);

    expect(container.textContent).toContain('aurora.status.duplicateAccountCircuits');
    // The account is healthy and syncing — the generic failure copy would tell
    // this climber their board login is broken, with nothing to act on.
    expect(container.textContent).not.toContain('aurora.status.error');
    // And it never leaks the raw code to the card.
    expect(container.textContent).not.toContain(DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR);
  });

  it('still shows the generic error copy for a sync_error it does not recognise', () => {
    // Legacy free-text values are written by other paths; swallowing them would
    // hide a real failure.
    mocks.credentials = [connectedCredential('Refresh token rejected by Keycloak')];
    const { container } = render(<BoardAccountsSection />);

    expect(container.textContent).toContain('aurora.status.error');
    expect(container.textContent).not.toContain('aurora.status.duplicateAccountCircuits');
  });

  it('shows no error affordance at all on a clean credential', () => {
    mocks.credentials = [connectedCredential(null)];
    const { container } = render(<BoardAccountsSection />);

    expect(container.textContent).not.toContain('aurora.status.error');
    expect(container.textContent).not.toContain('aurora.status.duplicateAccountCircuits');
  });
});

describe('LinkBoardAccountModal host lifecycle', () => {
  beforeEach(() => {
    mocks.saveAurora.mockReset().mockResolvedValue(undefined);
    mocks.saveKilterViaPassword.mockReset().mockResolvedValue(undefined);
    mocks.invalidate.mockReset().mockResolvedValue(undefined);
    mocks.showToast.mockClear();
    mocks.linkStarted.mockClear();
    mocks.linkSucceeded.mockClear();
    mocks.linkFailed.mockClear();
  });

  it('clears credentials after closing and when changing the selected board', () => {
    const onClose = vi.fn();
    const { container, rerender } = render(
      <LinkBoardAccountModal boardType="tension" source="integrations" onClose={onClose} />,
    );
    fireEvent.change(input(container, 'aurora.linkDialog.usernamePlaceholder')!, { target: { value: 'first-user' } });
    fireEvent.change(input(container, 'aurora.linkDialog.passwordPlaceholder')!, { target: { value: 'first-secret' } });
    fireEvent.click(button(container, 'actions.cancel')!);
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<LinkBoardAccountModal boardType={null} source="integrations" onClose={onClose} />);
    rerender(<LinkBoardAccountModal boardType="tension" source="integrations" onClose={onClose} />);
    expect(input(container, 'aurora.linkDialog.usernamePlaceholder')?.value).toBe('');
    expect(input(container, 'aurora.linkDialog.passwordPlaceholder')?.value).toBe('');

    fireEvent.change(input(container, 'aurora.linkDialog.usernamePlaceholder')!, { target: { value: 'second-user' } });
    fireEvent.change(input(container, 'aurora.linkDialog.passwordPlaceholder')!, {
      target: { value: 'second-secret' },
    });
    rerender(<LinkBoardAccountModal boardType="kilter" source="integrations" onClose={onClose} />);
    expect(input(container, 'aurora.kilterLinkDialog.emailPlaceholder')?.value).toBe('');
    expect(input(container, 'aurora.linkDialog.passwordPlaceholder')?.value).toBe('');
    expect(mocks.linkStarted).not.toHaveBeenCalled();
    expect(mocks.saveAurora).not.toHaveBeenCalled();
    expect(mocks.saveKilterViaPassword).not.toHaveBeenCalled();
  });

  it('shows the username field for a non-Kilter board, not the Kilter email field', () => {
    const { container } = render(<LinkBoardAccountModal boardType="tension" source="integrations" onClose={vi.fn()} />);
    expect(input(container, 'aurora.linkDialog.usernamePlaceholder')).not.toBeNull();
    expect(input(container, 'aurora.kilterLinkDialog.emailPlaceholder')).toBeNull();
  });

  it('shows the Kilter email field, not the generic username field', () => {
    const { container } = render(<LinkBoardAccountModal boardType="kilter" source="integrations" onClose={vi.fn()} />);
    expect(input(container, 'aurora.kilterLinkDialog.emailPlaceholder')).not.toBeNull();
    expect(input(container, 'aurora.linkDialog.usernamePlaceholder')).toBeNull();
  });

  it('notifies the host after both credential caches refresh with one linked outcome', async () => {
    let releaseInvalidations: () => void = () => {
      throw new Error('Invalidation promise not initialized');
    };
    const invalidations = new Promise<void>((resolve) => {
      releaseInvalidations = resolve;
    });
    mocks.invalidate.mockReturnValue(invalidations);
    const onClose = vi.fn();
    const onLinked = vi.fn();
    const { container } = render(
      <LinkBoardAccountModal boardType="tension" source="onboarding" onClose={onClose} onLinked={onLinked} />,
    );
    fireEvent.change(input(container, 'aurora.linkDialog.usernamePlaceholder')!, { target: { value: '  user  ' } });
    fireEvent.change(input(container, 'aurora.linkDialog.passwordPlaceholder')!, { target: { value: 'secret' } });
    fireEvent.click(button(container, 'aurora.linkDialog.submit')!);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mocks.saveAurora).toHaveBeenCalledWith({ boardType: 'tension', username: 'user', password: 'secret' });
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ['auroraCredentials'] });
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ['auroraCredentials', 'unsynced'] });
    expect(onLinked).not.toHaveBeenCalled();
    await act(async () => {
      releaseInvalidations();
      await invalidations;
    });
    expect(onLinked).toHaveBeenCalledExactlyOnceWith('tension');
    expect(mocks.linkStarted).toHaveBeenCalledExactlyOnceWith({ boardType: 'tension', source: 'onboarding' });
    expect(mocks.linkSucceeded).toHaveBeenCalledExactlyOnceWith({ boardType: 'tension', source: 'onboarding' });
    expect(mocks.linkFailed).not.toHaveBeenCalled();
  });
});
