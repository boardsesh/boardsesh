// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveCardModel } from '../live-session-model';

const spies = vi.hoisted(() => ({
  press: vi.fn(),
  invite: vi.fn(),
  avatarGroup: vi.fn(),
  surfaces: [] as Array<{
    testID?: string;
    accessibilityActions?: ReadonlyArray<{ name: string; label?: string }>;
    onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
  }>,
}));

vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}(${Object.values(options).join('|')})` : key,
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../PressableSurface', () => ({
  // React Native presses don't bubble to an enclosing pressable; stop the DOM
  // click here so the nested Invite behaves the same way in jsdom.
  PressableSurface: ({
    children,
    onPress,
    testID,
    accessibilityLabel,
    accessibilityActions,
    onAccessibilityAction,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    testID?: string;
    accessibilityLabel?: string;
    accessibilityActions?: ReadonlyArray<{ name: string; label?: string }>;
    onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
  }) => {
    spies.surfaces.push({ testID, accessibilityActions, onAccessibilityAction });
    return createElement(
      'button',
      {
        'data-testid': testID,
        'aria-label': accessibilityLabel,
        onClick: (event: { stopPropagation: () => void }) => {
          event.stopPropagation();
          onPress?.();
        },
      },
      children,
    );
  },
}));
vi.mock('../../you/AvatarGroup', () => ({
  AvatarGroup: (props: Record<string, unknown>) => {
    spies.avatarGroup(props);
    return null;
  },
}));
vi.mock('../LiveDot', () => ({ LiveDot: () => null }));
vi.mock('../use-live-session-colors', () => ({ useLiveSessionColors: () => ({ live: '#FBBF24' }) }));
vi.mock('../../../theme/typography', () => ({ CHROME_LABEL_MAX_FONT_SCALE: 1.2 }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 4: 16 }, borderRadius: { lg: 12, full: 999 } }));

import { LiveSessionCard } from '../LiveSessionCard';

function card(overrides: Partial<LiveCardModel> = {}): LiveCardModel {
  return {
    sessionId: 's1',
    startedAtMs: 0,
    host: { userId: 'host', displayName: 'Priya Nair', avatarUrl: null },
    participants: [
      { userId: 'host', displayName: 'Priya Nair', avatarUrl: null },
      { userId: 'b', displayName: 'Tom Reed', avatarUrl: null },
    ],
    participantCount: 4,
    followedParticipantIds: ['host'],
    viewerIsMember: false,
    boardName: 'Kilter Original',
    boardType: 'kilter',
    gymName: 'Crux Collective',
    angle: 40,
    sendCount: 7,
    hardestSendGrade: 'V6',
    currentClimbName: null,
    currentClimbGrade: null,
    reasons: ['FOLLOWING_USER'],
    ...overrides,
  };
}

function renderCard(model: LiveCardModel) {
  return render(
    createElement(LiveSessionCard, {
      card: model,
      nowMs: 42 * 60_000 + 30_000,
      viewerUserId: 'viewer',
      height: 192,
      stacked: false,
      formatGrade: (grade: string | null | undefined) => grade ?? null,
      onPress: spies.press,
      onInvite: spies.invite,
    }),
  );
}

beforeEach(() => {
  spies.press.mockReset();
  spies.invite.mockReset();
  spies.avatarGroup.mockReset();
  spies.surfaces = [];
});

describe('LiveSessionCard', () => {
  it('is one pressable element with a spoken label, and hands the card to onPress', () => {
    const { getByTestId } = renderCard(card());
    const surface = getByTestId('live-session-card');
    expect(surface.getAttribute('aria-label')).toContain('mobile.liveSessions.a11y.namesOthers(Priya N.|3)');
    expect(surface.getAttribute('aria-label')).toContain('mobile.liveSessions.a11y.hardest(V6)');
    fireEvent.click(surface);
    expect(spies.press).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }));
  });

  it('draws plain avatars with the host ringed and "+N" from the roster size', () => {
    renderCard(card());
    expect(spies.avatarGroup).toHaveBeenCalledWith(
      expect.objectContaining({ interactive: false, total: 4, highlightUserId: 'host', highlightColor: '#FBBF24' }),
    );
  });

  it('labels a stranger session on a followed board Join, and Open otherwise', () => {
    const joined = renderCard(card({ reasons: ['FOLLOWED_BOARD'], followedParticipantIds: [] }));
    expect(joined.container.textContent).toContain('mobile.liveSessions.actions.join');
    expect(joined.container.textContent).toContain('mobile.liveSessions.boardYouFollow');
    joined.unmount();

    const opened = renderCard(card());
    expect(opened.container.textContent).toContain('mobile.liveSessions.actions.open');
    expect(opened.queryByTestId('invite-button')).toBeNull();
  });

  it('gives the viewer solo session an Invite pill in the footer, reachable as a card action', () => {
    const { getByTestId, container } = renderCard(
      card({
        viewerIsMember: true,
        participantCount: 1,
        participants: [{ userId: 'viewer', displayName: 'Vic Viewer', avatarUrl: null }],
      }),
    );
    expect(container.textContent).toContain('mobile.liveSessions.names.justYou');
    const invite = getByTestId('live-session-invite');
    expect(invite.textContent).toBe('mobile.liveSessions.actions.invite');
    expect(invite.getAttribute('aria-label')).toBe('mobile.liveSessions.a11y.invite');
    fireEvent.click(invite);
    expect(spies.invite).toHaveBeenCalledWith('s1');
    expect(spies.press).not.toHaveBeenCalled();

    // VoiceOver / TalkBack: the card is one element, so Invite is its custom action.
    const cardSurface = spies.surfaces.find((surface) => surface.testID === 'live-session-card');
    expect(cardSurface?.accessibilityActions).toEqual([{ name: 'invite', label: 'mobile.liveSessions.a11y.invite' }]);
    cardSurface?.onAccessibilityAction?.({ nativeEvent: { actionName: 'invite' } });
    expect(spies.invite).toHaveBeenCalledTimes(2);
  });

  it('offers no custom action on a card without Invite', () => {
    renderCard(card());
    const cardSurface = spies.surfaces.find((surface) => surface.testID === 'live-session-card');
    expect(cardSurface?.accessibilityActions).toBeUndefined();
  });

  it('says "Just started" instead of 0m inside the first minute', () => {
    const { container } = renderCard(card({ startedAtMs: 42 * 60_000 }));
    expect(container.textContent).toContain('mobile.liveSessions.elapsed.justStarted');
    expect(container.textContent).not.toContain('mobile.liveSessions.elapsed.minutes(0)');
  });

  it('shows a static Quiet pill, not a pulsing Live one, when nobody is connected', () => {
    const quiet = renderCard(card({ participantCount: 0, participants: [] }));
    expect(quiet.container.textContent).toContain('mobile.liveSessions.quiet');
    expect(quiet.container.textContent).not.toContain('mobile.liveSessions.live');
    expect(quiet.getByTestId('live-status-dot-static')).not.toBeNull();
    expect(quiet.getByTestId('live-session-card').getAttribute('aria-label')).toContain(
      'mobile.liveSessions.a11y.quietOn',
    );
    quiet.unmount();

    const live = renderCard(card());
    expect(live.container.textContent).toContain('mobile.liveSessions.live');
    expect(live.queryByTestId('live-status-dot-static')).toBeNull();
  });

  it('omits the sends segment at zero', () => {
    const { container } = renderCard(card({ sendCount: 0, hardestSendGrade: null }));
    expect(container.textContent).not.toContain('mobile.liveSessions.sends');
  });
});
