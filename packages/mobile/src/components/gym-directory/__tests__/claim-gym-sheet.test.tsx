// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const openUrl = vi.hoisted(() => ({ openValidatedUrl: vi.fn().mockResolvedValue(true) }));
vi.mock('../../../lib/open-external-link', () => openUrl);
vi.mock('../../../lib/env', () => ({ WEB_BASE_URL: 'https://www.boardsesh.com' }));

import { ClaimGymSheet } from '../ClaimGymSheet';

// No website, so the sheet opens in admin-review mode — the only path that can
// come back `approved`.
const gym = {
  uuid: 'gym-uuid-1',
  slug: null,
  name: 'Bonsist',
  website: null,
  canClaimByDomain: false,
} as unknown as Gym;
const dismissMock = vi.fn();
const sheetRef = { current: { dismiss: dismissMock } } as unknown as RefObject<ManagedSheetHandle | null>;

const renderSheet = (overrides?: Partial<Gym>) =>
  render(<ClaimGymSheet sheetRef={sheetRef} gym={{ ...gym, ...overrides } as Gym} />);

const submit = () => fireEvent.click(screen.getByText('mobile.gymClaim.admin.submit'));

describe('ClaimGymSheet — claim outcome', () => {
  beforeEach(() => {
    dismissMock.mockClear();
    openUrl.openValidatedUrl.mockClear();
    openUrl.openValidatedUrl.mockResolvedValue(true);
  });

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

  it('offers a manage-gym hand-off on an approved claim and dismisses the sheet on success', async () => {
    mockMutateAsync.mockResolvedValueOnce({ status: 'approved', email: null });

    renderSheet();
    submit();
    await waitFor(() => expect(screen.getByText('mobile.gymClaim.approved.sent')).toBeTruthy());

    fireEvent.click(screen.getByText('mobile.gymClaim.approved.manageCta'));

    expect(openUrl.openValidatedUrl).toHaveBeenCalledWith(
      'https://www.boardsesh.com/gym/gym-uuid-1/manage',
      expect.any(Function),
    );
    await waitFor(() => expect(dismissMock).toHaveBeenCalled());
  });

  it('prefers the gym slug over the uuid in the hand-off URL', async () => {
    mockMutateAsync.mockResolvedValueOnce({ status: 'approved', email: null });

    renderSheet({ slug: 'bonsist-amsterdam' });
    submit();
    await waitFor(() => expect(screen.getByText('mobile.gymClaim.approved.sent')).toBeTruthy());

    fireEvent.click(screen.getByText('mobile.gymClaim.approved.manageCta'));

    expect(openUrl.openValidatedUrl).toHaveBeenCalledWith(
      'https://www.boardsesh.com/gym/bonsist-amsterdam/manage',
      expect.any(Function),
    );
  });

  it('shows an inline error and keeps the sheet open when the hand-off fails to open', async () => {
    openUrl.openValidatedUrl.mockResolvedValue(false);
    mockMutateAsync.mockResolvedValueOnce({ status: 'approved', email: null });

    renderSheet();
    submit();
    await waitFor(() => expect(screen.getByText('mobile.gymClaim.approved.sent')).toBeTruthy());

    fireEvent.click(screen.getByText('mobile.gymClaim.approved.manageCta'));

    await waitFor(() => expect(screen.getByText('mobile.gymClaim.approved.manageError')).toBeTruthy());
    expect(dismissMock).not.toHaveBeenCalled();
  });

  it('does not offer the manage-gym hand-off on a review-queued claim', async () => {
    mockMutateAsync.mockResolvedValueOnce({ status: 'admin_review', email: null });

    renderSheet();
    submit();
    await waitFor(() => expect(screen.getByText('mobile.gymClaim.admin.sent')).toBeTruthy());

    expect(screen.queryByText('mobile.gymClaim.approved.manageCta')).toBeNull();
  });
});

// A company-looking website is only half the rule: the gym's OWNER has to have
// put it there. The sheet used to read only the first half off `gym.website`,
// so an un-vouched listing opened the email form and the climber only heard
// "no" after typing their work address (#4018).
describe('ClaimGymSheet — which form opens comes from canClaimByDomain, not the website', () => {
  beforeEach(() => {
    mockMutateAsync.mockClear();
  });

  it('opens admin review on an un-vouched gym, even though the website looks claimable', () => {
    renderSheet({ website: 'https://bonsist.bg', canClaimByDomain: false });

    expect(screen.queryByText('mobile.gymClaim.domain.emailLabel')).toBeNull();
    expect(screen.queryByText('mobile.gymClaim.domain.submit')).toBeNull();
    // …and no offer to switch to a path that would be refused.
    expect(screen.queryByText('mobile.gymClaim.switchToDomain')).toBeNull();
    expect(screen.getByText('mobile.gymClaim.admin.submit')).toBeTruthy();
  });

  it('sends an admin-review claim with no claimEmail from that state', async () => {
    mockMutateAsync.mockResolvedValueOnce({ status: 'admin_review', email: null });

    renderSheet({ website: 'https://bonsist.bg', canClaimByDomain: false });
    submit();

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    const [input] = mockMutateAsync.mock.calls[0] as [Record<string, unknown>];
    expect(input.gymUuid).toBe('gym-uuid-1');
    expect('claimEmail' in input).toBe(false);
  });

  it('opens the email form on the same website once it is owner-vouched', () => {
    renderSheet({ website: 'https://bonsist.bg', canClaimByDomain: true });

    expect(screen.getByText('mobile.gymClaim.domain.submit')).toBeTruthy();
  });
});
