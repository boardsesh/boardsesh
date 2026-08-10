// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode, type RefObject } from 'react';
import type { Gym } from '@boardsesh/shared-schema';
import type { ManagedSheetHandle } from '../../../providers/sheet-presentation-provider';

type Children = { children?: ReactNode };
type PressProps = { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string };
type ButtonProps = { title?: string; onPress?: () => void };

vi.mock('react-native', () => ({
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetTextInput: (props: Record<string, unknown>) =>
    createElement('input', { 'aria-label': props.placeholder as string }),
}));

vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ children }: Children) => createElement('div', null, children),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: Children) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: ButtonProps) => createElement('button', { onClick: onPress, type: 'button' }, title),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, accessibilityLabel }: PressProps) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel, type: 'button' }, children),
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
  borderRadius: { sm: 6, md: 8, lg: 12, full: 9999 },
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#000', secondaryLabel: '#666', separator: '#ccc', tertiarySystemFill: '#eee' },
    brandColors: { success: '#0a0', primary: '#6D28D9' },
  }),
}));

// The i18n mock returns the key so assertions pin which branch rendered,
// independent of catalog copy (parity is covered by the catalog tests).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

const mockMutateAsync = vi.fn();
vi.mock('../../../lib/graphql/hooks', () => ({
  useRequestGymClaim: () => ({ mutateAsync: mockMutateAsync, reset: vi.fn(), isPending: false }),
}));

vi.mock('../../../lib/graphql/extract-error-message', () => ({
  extractGraphqlMessage: (error: unknown) => (error as Error)?.message ?? null,
}));

import { ClaimGymSheet } from '../ClaimGymSheet';

// No website, so the sheet opens in admin-review mode — the only path that can
// come back `approved`.
const gym = { uuid: 'gym-uuid-1', name: 'Bonsist', website: null } as unknown as Gym;
const sheetRef = { current: { dismiss: vi.fn() } } as unknown as RefObject<ManagedSheetHandle | null>;

const renderSheet = () => render(<ClaimGymSheet sheetRef={sheetRef} gym={gym} />);

const submit = () => fireEvent.click(screen.getByText('mobile.gymClaim.admin.submit'));

describe('ClaimGymSheet — claim outcome', () => {
  it('confirms ownership when the claim is auto-approved', async () => {
    mockMutateAsync.mockResolvedValueOnce({ status: 'approved', email: null });

    renderSheet();
    submit();

    await waitFor(() => expect(screen.getByText('mobile.gymClaim.approved.sent')).toBeTruthy());
  });

  it('shows the review message when the claim only queues', async () => {
    mockMutateAsync.mockResolvedValueOnce({ status: 'admin_review', email: null });

    renderSheet();
    submit();

    // The bug this pins: before `approved` existed, anything that wasn't
    // `email_sent` fell into this branch — so an approved claim told the user
    // to wait for a review that had already happened.
    await waitFor(() => expect(screen.getByText('mobile.gymClaim.admin.sent')).toBeTruthy());
    expect(screen.queryByText('mobile.gymClaim.approved.sent')).toBeNull();
  });
});
