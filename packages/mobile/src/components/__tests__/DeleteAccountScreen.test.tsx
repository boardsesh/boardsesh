// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// DeleteAccountScreen drives the App Store-required account-deletion flow, so
// pin its risk areas: the confirm button gates on the exact "DELETE" phrase AND
// on the climb-info fetch finishing, the setter-name toggle only appears when
// there are published climbs, and the success/error branches sign out / toast.
// Following the repo's component-test convention: mock react-native to DOM and
// stub the leaf components + providers so this stays a focused unit test.

const ctrl = vi.hoisted(() => ({
  infoData: undefined as number | undefined,
  infoLoading: false,
  mutateAsync: vi.fn(),
  signOut: vi.fn(),
  showToast: vi.fn(),
  back: vi.fn(),
  reportError: vi.fn(),
}));

type AnyProps = Record<string, unknown> & { children?: ReactNode };

vi.mock('react-native', () => ({
  View: ({ children }: AnyProps) => createElement('div', {}, children),
  ScrollView: ({ children }: AnyProps) => createElement('div', {}, children),
  TextInput: ({ value, onChangeText, editable, placeholder, accessibilityLabel }: AnyProps) =>
    createElement('input', {
      'aria-label': accessibilityLabel as string,
      placeholder: placeholder as string,
      value: value as string,
      disabled: editable === false,
      onChange: (event: { target: { value: string } }) => (onChangeText as (next: string) => void)(event.target.value),
    }),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  // theme/tokens transitively imports theme/colors, which reads Platform.OS and
  // PlatformColor at module load — provide enough for that to evaluate.
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios },
  PlatformColor: (name: string) => name,
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ back: ctrl.back }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('graphql-request', () => ({ ClientError: class ClientError extends Error {} }));
vi.mock('../../lib/error-reporting', () => ({ reportError: (...args: unknown[]) => ctrl.reportError(...args) }));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      label: '#000',
      secondaryLabel: '#555',
      tertiaryLabel: '#999',
      secondaryBackground: '#fff',
      tertiaryBackground: '#eee',
      separator: '#ccc',
    },
    brandColors: { error: '#c00' },
  }),
}));
vi.mock('../../providers/toast-provider', () => ({ useToast: () => ({ showToast: ctrl.showToast }) }));
vi.mock('../../providers/auth-provider', () => ({ useAuth: () => ({ signOut: ctrl.signOut }) }));
vi.mock('../../lib/graphql/hooks', () => ({
  useDeleteAccountInfo: () => ({ data: ctrl.infoData, isLoading: ctrl.infoLoading }),
  useDeleteAccount: () => ({ mutateAsync: ctrl.mutateAsync }),
}));

// Leaf components → minimal DOM exposing the props the assertions need.
vi.mock('../Text', () => ({ Text: ({ children }: AnyProps) => createElement('span', {}, children) }));
vi.mock('../SwitchRow', () => ({
  SwitchRow: ({ label, value, onValueChange, disabled }: AnyProps) =>
    createElement(
      'button',
      {
        'data-testid': 'setter-toggle',
        disabled: disabled as boolean,
        onClick: () => (onValueChange as (next: boolean) => void)(!(value as boolean)),
      },
      label as string,
    ),
}));
vi.mock('../Button', () => ({
  Button: ({ title, onPress, disabled }: AnyProps) =>
    createElement(
      'button',
      { 'data-testid': title as string, disabled: disabled as boolean, onClick: onPress as () => void },
      title as string,
    ),
}));

import { DeleteAccountScreen } from '../DeleteAccountScreen';

const CONFIRM_BTN = 'deleteAccount.dialog.confirm';
const CONFIRM_PLACEHOLDER = 'deleteAccount.dialog.confirmPlaceholder';

beforeEach(() => {
  ctrl.infoData = 0;
  ctrl.infoLoading = false;
  ctrl.mutateAsync.mockReset().mockResolvedValue(true);
  ctrl.signOut.mockReset().mockResolvedValue(undefined);
  ctrl.showToast.mockReset();
  ctrl.back.mockReset();
  ctrl.reportError.mockReset();
});

function typeConfirm(getByPlaceholderText: (text: string) => HTMLElement, value: string) {
  fireEvent.change(getByPlaceholderText(CONFIRM_PLACEHOLDER), { target: { value } });
}

describe('DeleteAccountScreen', () => {
  it('enables the confirm button only once "DELETE" is typed exactly', () => {
    const { getByTestId, getByPlaceholderText } = render(<DeleteAccountScreen />);
    const confirm = getByTestId(CONFIRM_BTN) as HTMLButtonElement;

    expect(confirm.disabled).toBe(true);
    typeConfirm(getByPlaceholderText, 'delete'); // wrong case
    expect(confirm.disabled).toBe(true);
    typeConfirm(getByPlaceholderText, 'DELETE');
    expect(confirm.disabled).toBe(false);
  });

  it('keeps the confirm button disabled while climb info is still loading', () => {
    // Regression guard for the slow-connection race: count reads as 0 (toggle
    // hidden) until the fetch resolves, so deletion must stay blocked meanwhile.
    ctrl.infoLoading = true;
    const { getByTestId, getByPlaceholderText, queryByTestId } = render(<DeleteAccountScreen />);

    typeConfirm(getByPlaceholderText, 'DELETE');
    expect((getByTestId(CONFIRM_BTN) as HTMLButtonElement).disabled).toBe(true);
    expect(queryByTestId('setter-toggle')).toBeNull();
  });

  it('shows the setter-name toggle only when there are published climbs', () => {
    ctrl.infoData = 0;
    const withoutClimbs = render(<DeleteAccountScreen />);
    expect(withoutClimbs.queryByTestId('setter-toggle')).toBeNull();
    withoutClimbs.unmount();

    ctrl.infoData = 3;
    const withClimbs = render(<DeleteAccountScreen />);
    expect(withClimbs.queryByTestId('setter-toggle')).not.toBeNull();
  });

  it('deletes with the chosen setter-name option then signs out', async () => {
    ctrl.infoData = 2;
    const { getByTestId, getByPlaceholderText } = render(<DeleteAccountScreen />);

    fireEvent.click(getByTestId('setter-toggle')); // opt in to removing setter name
    typeConfirm(getByPlaceholderText, 'DELETE');
    fireEvent.click(getByTestId(CONFIRM_BTN));

    await waitFor(() => expect(ctrl.signOut).toHaveBeenCalledWith('account_deleted'));
    expect(ctrl.mutateAsync).toHaveBeenCalledWith({ input: { removeSetterName: true } });
  });

  it('does not show a deletion-failed toast when only the post-delete signOut fails', async () => {
    // Deletion succeeded server-side; only local cleanup threw. Re-labelling that
    // as "deletion failed" (and re-enabling the form) would be misleading.
    ctrl.signOut.mockRejectedValue(new Error('keychain locked'));
    const { getByTestId, getByPlaceholderText } = render(<DeleteAccountScreen />);

    typeConfirm(getByPlaceholderText, 'DELETE');
    fireEvent.click(getByTestId(CONFIRM_BTN));

    await waitFor(() => expect(ctrl.reportError).toHaveBeenCalled());
    expect(ctrl.mutateAsync).toHaveBeenCalled();
    expect(ctrl.showToast).not.toHaveBeenCalled();
    // Form stays in its deleting state — the account is gone, no retry.
    expect((getByTestId(CONFIRM_BTN) as HTMLButtonElement).disabled).toBe(true);
  });

  it('surfaces a deletion failure as an error toast and stays signed in', async () => {
    ctrl.mutateAsync.mockRejectedValue(new Error('server exploded'));
    const { getByTestId, getByPlaceholderText } = render(<DeleteAccountScreen />);

    typeConfirm(getByPlaceholderText, 'DELETE');
    fireEvent.click(getByTestId(CONFIRM_BTN));

    await waitFor(() => expect(ctrl.showToast).toHaveBeenCalledWith('deleteAccount.error', 'error'));
    expect(ctrl.signOut).not.toHaveBeenCalled();
    expect(ctrl.reportError).toHaveBeenCalled();
  });
});
