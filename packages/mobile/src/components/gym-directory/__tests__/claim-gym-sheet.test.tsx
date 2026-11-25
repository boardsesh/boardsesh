// @vitest-environment jsdom
vi.mock('../../AccessibleBottomSheetTextInput', async () => {
  const { BottomSheetTextInput } = await import('@expo/ui/community/bottom-sheet');
  return { AccessibleBottomSheetTextInput: BottomSheetTextInput };
});
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

// The sheet's close callback, so a test can play the slide-down finishing.
const sheetCallbacks = vi.hoisted(() => ({ onFullyDismissed: null as null | (() => void) }));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({
    children,
    header,
    onFullyDismissed,
  }: Children & { header?: ReactNode; onFullyDismissed?: () => void }) => {
    sheetCallbacks.onFullyDismissed = onFullyDismissed ?? null;
    return createElement('div', null, header, children);
  },
}));

const router = vi.hoisted(() => ({ push: vi.fn(), segments: [] as string[], params: {} as Record<string, string> }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: router.push }),
  useSegments: () => router.segments,
  useLocalSearchParams: () => router.params,
}));
vi.mock('../../SheetTopBar', async () => (await import('../../../test/sheet-top-bar-stub')).sheetTopBarModule);
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
import { GymRouteStackContext } from '../../gym-page/use-gym-route-stack';
import type { GymPageStack } from '../../gym-page/gym-page-route';

// No website, so the sheet opens in admin-review mode — the only path that can
// come back `approved`.
const gym = { uuid: 'gym-uuid-1', slug: null, name: 'Bonsist', website: null } as unknown as Gym;
// Dismissing plays the slide-down to its end, as the real sheet does.
const dismissMock = vi.fn(() => sheetCallbacks.onFullyDismissed?.());
const sheetRef = { current: { dismiss: dismissMock } } as unknown as RefObject<ManagedSheetHandle | null>;

const renderSheet = (overrides?: Partial<Gym>, onCheckBoards?: () => void, stack: GymPageStack = 'root') =>
  render(
    <GymRouteStackContext.Provider value={stack}>
      <ClaimGymSheet sheetRef={sheetRef} gym={{ ...gym, ...overrides } as Gym} onCheckBoards={onCheckBoards} />
    </GymRouteStackContext.Provider>,
  );

const submit = () => fireEvent.click(screen.getByLabelText('mobile.gymClaim.admin.submit'));

describe('ClaimGymSheet — claim outcome', () => {
  beforeEach(() => {
    dismissMock.mockClear();
    router.push.mockClear();
    router.segments = [];
    router.params = {};
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

  it("opens the gym's page in the app once the sheet has gone", async () => {
    mockMutateAsync.mockResolvedValueOnce({ status: 'approved', email: null });

    renderSheet();
    submit();
    await waitFor(() => expect(screen.getByText('mobile.gymClaim.approved.sent')).toBeTruthy());

    fireEvent.click(screen.getByText('mobile.gymClaim.approved.manageCta'));

    expect(dismissMock).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({ pathname: '/gyms/[gym]', params: { gym: 'gym-uuid-1' } });
  });

  // The stack the sheet's screen is registered in, not the focused route: the
  // focused route here says root, the sheet stands in the picker.
  it("opens the board picker's copy of the page from inside the picker's stack", async () => {
    router.segments = ['gyms'];
    mockMutateAsync.mockResolvedValueOnce({ status: 'approved', email: null });

    renderSheet(undefined, undefined, 'boards');
    submit();
    await waitFor(() => expect(screen.getByText('mobile.gymClaim.approved.manageCta')).toBeTruthy());

    fireEvent.click(screen.getByText('mobile.gymClaim.approved.manageCta'));

    expect(router.push).toHaveBeenCalledWith({ pathname: '/boards/gym/[gym]', params: { gym: 'gym-uuid-1' } });
  });

  it("hands Check your boards to the gym's own page instead of pushing it again", async () => {
    const onCheckBoards = vi.fn();
    mockMutateAsync.mockResolvedValueOnce({ status: 'approved', email: null });

    renderSheet(undefined, onCheckBoards);
    submit();
    await waitFor(() => expect(screen.getByText('mobile.gymClaim.approved.manageCta')).toBeTruthy());

    fireEvent.click(screen.getByText('mobile.gymClaim.approved.manageCta'));

    expect(onCheckBoards).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("pushes nothing from the gym's own page, which refreshes into its staff view", async () => {
    router.segments = ['gyms', '[gym]'];
    router.params = { gym: 'gym-uuid-1' };
    mockMutateAsync.mockResolvedValueOnce({ status: 'approved', email: null });

    renderSheet();
    submit();
    await waitFor(() => expect(screen.getByText('mobile.gymClaim.approved.manageCta')).toBeTruthy());

    fireEvent.click(screen.getByText('mobile.gymClaim.approved.manageCta'));

    expect(dismissMock).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('opens nothing when the sheet is closed with Done', async () => {
    mockMutateAsync.mockResolvedValueOnce({ status: 'approved', email: null });

    renderSheet();
    submit();
    await waitFor(() => expect(screen.getByText('mobile.gymClaim.approved.sent')).toBeTruthy());

    dismissMock();

    expect(router.push).not.toHaveBeenCalled();
  });

  it('does not offer the manage-gym hand-off on a review-queued claim', async () => {
    mockMutateAsync.mockResolvedValueOnce({ status: 'admin_review', email: null });

    renderSheet();
    submit();
    await waitFor(() => expect(screen.getByText('mobile.gymClaim.admin.sent')).toBeTruthy());

    expect(screen.queryByText('mobile.gymClaim.approved.manageCta')).toBeNull();
  });
});

describe('ClaimGymSheet — a refused claim', () => {
  it("says a gym its staff run can't be claimed in the app's words, not the server's English", async () => {
    mockMutateAsync.mockRejectedValueOnce(
      Object.assign(new Error('Refused: staff-run listing'), {
        response: { errors: [{ extensions: { code: 'GYM_RUN_BY_STAFF' } }] },
      }),
    );

    renderSheet();
    submit();

    await waitFor(() => expect(screen.getByText('mobile.gymClaim.errorRunByStaff')).toBeTruthy());
    expect(screen.queryByText('Refused: staff-run listing')).toBeNull();
  });

  it("keeps the server's message for any other refusal", async () => {
    mockMutateAsync.mockRejectedValueOnce(new Error('This gym is private and cannot be claimed'));

    renderSheet();
    submit();

    await waitFor(() => expect(screen.getByText('This gym is private and cannot be claimed')).toBeTruthy());
  });
});

describe('ClaimGymSheet — which form opens', () => {
  it('opens admin review when the server says the website cannot prove a claim, whatever the website looks like', () => {
    renderSheet({ website: 'https://bonsist.nl', canClaimByDomain: false });
    expect(screen.getByText('mobile.gymClaim.admin.description')).toBeTruthy();
    expect(screen.queryByText('mobile.gymClaim.switchToDomain')).toBeNull();
  });

  it('opens the work-email form when the server says the website can prove one', () => {
    renderSheet({ website: 'https://bonsist.nl', canClaimByDomain: true });
    expect(screen.getByText('mobile.gymClaim.domain.description')).toBeTruthy();
    expect(screen.getByText('mobile.gymClaim.switchToAdmin')).toBeTruthy();
  });

  it('falls back to admin review when the flag is set but there is no website to name', () => {
    renderSheet({ website: null, canClaimByDomain: true });
    expect(screen.getByText('mobile.gymClaim.admin.description')).toBeTruthy();
  });
});
