// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveCardModel } from '../live-session-model';

const spies = vi.hoisted(() => ({ press: vi.fn(), invite: vi.fn(), avatarGroup: vi.fn() }));

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
vi.mock('../../Button', () => ({
  Button: ({
    title,
    onPress,
    accessibilityLabel,
  }: {
    title: string;
    onPress: () => void;
    accessibilityLabel?: string;
  }) =>
    createElement(
      'button',
      { 'data-testid': 'invite-button', onClick: onPress, 'aria-label': accessibilityLabel },
      title,
    ),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) =>
    createElement(
      'button',
      { 'data-testid': 'card-press', onClick: onPress, 'aria-label': accessibilityLabel },
      children,
    ),
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
      nowMinute: 42,
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
});

describe('LiveSessionCard', () => {
  it('is one pressable element with a spoken label, and hands the card to onPress', () => {
    const { getByTestId } = renderCard(card());
    const surface = getByTestId('card-press');
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

  it('gives the viewer solo session a separate Invite button', () => {
    const { getByTestId, container } = renderCard(
      card({
        viewerIsMember: true,
        participantCount: 1,
        participants: [{ userId: 'viewer', displayName: 'Vic Viewer', avatarUrl: null }],
      }),
    );
    expect(container.textContent).toContain('mobile.liveSessions.names.justYou');
    const invite = getByTestId('invite-button');
    // Its own element, not a child of the card's press target.
    expect(getByTestId('card-press').contains(invite)).toBe(false);
    fireEvent.click(invite);
    expect(spies.invite).toHaveBeenCalledWith('s1');
    expect(spies.press).not.toHaveBeenCalled();
  });

  it('omits the sends segment at zero', () => {
    const { container } = renderCard(card({ sendCount: 0, hardestSendGrade: null }));
    expect(container.textContent).not.toContain('mobile.liveSessions.sends');
  });
});
