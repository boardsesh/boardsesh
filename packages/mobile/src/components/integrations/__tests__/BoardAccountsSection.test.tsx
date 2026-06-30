// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { AuroraCredentialStatus, AuroraCredentialsResponse } from '../../../lib/aurora-credentials';

// --- Hoisted mock state, mutated per-test before render ---
const mocks = vi.hoisted(() => ({
  saveAurora: vi.fn(),
  saveKilterViaPassword: vi.fn(() => Promise.resolve()),
  deleteAurora: vi.fn(),
  streamImport: vi.fn(),
  showToast: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  invalidate: vi.fn(() => Promise.resolve()),
  refetch: vi.fn(() => Promise.resolve()),
  flags: {} as Record<string, boolean | undefined>,
  credentials: [] as AuroraCredentialStatus[],
}));

vi.mock('../../../lib/aurora-credentials', () => ({
  BoardAccountError: class BoardAccountError extends Error {},
  getAuroraCredentials: () => Promise.resolve({ credentials: [] }),
  getAuroraUnsyncedCounts: () => Promise.resolve({}),
  saveAuroraCredential: mocks.saveAurora,
  saveKilterCredentialViaPassword: mocks.saveKilterViaPassword,
  deleteAuroraCredential: mocks.deleteAurora,
  streamAuroraImport: mocks.streamImport,
}));

type MutationOptions = {
  mutationFn: (vars: unknown) => unknown;
  onSuccess?: (result: unknown, vars: unknown) => unknown;
  onError?: (error: unknown) => unknown;
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
        .catch((error) => opts.onError?.(error));
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
  Linking: { openURL: () => Promise.resolve() },
}));

vi.mock('expo-file-system', () => ({ File: class File {} }));

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

type TextProps = { children?: ReactNode };
vi.mock('../../Text', () => ({
  Text: ({ children }: TextProps) => createElement('span', {}, children),
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

const button = (root: HTMLElement, title: string) =>
  root.querySelector(`[data-button="${title}"]`) as HTMLButtonElement | null;

const input = (root: HTMLElement, placeholder: string) =>
  root.querySelector(`[data-input="${placeholder}"]`) as HTMLInputElement | null;

describe('BoardAccountsSection — Kilter password card', () => {
  beforeEach(() => {
    mocks.saveAurora.mockReset();
    mocks.saveKilterViaPassword.mockReset().mockResolvedValue(undefined);
    mocks.showToast.mockReset();
    mocks.invalidate.mockClear();
    mocks.flags = {};
    mocks.credentials = [];
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

    fireEvent.change(input(container, 'aurora.linkDialog.usernamePlaceholder')!, {
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
});
