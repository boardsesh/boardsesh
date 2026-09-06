// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardClimbRecentSender, BoardPresenceClimb } from '@boardsesh/shared-schema';

type HostProps = { children?: ReactNode };

vi.mock('react-native', () => ({
  View: ({ children }: HostProps) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      if (key === 'boardPresence.litByLine') return `Lit by ${values?.name}`;
      if (key === 'boardPresence.sentByLabel') return 'Sent by';
      if (key === 'mobile.boardPresence.setByLine') return `Set by ${values?.setter}`;
      if (key === 'mobile.boardPresence.drivenByA11y') return `${values?.name} is lighting the wall`;
      return key;
    },
  }),
}));

vi.mock('../../../Text', () => ({
  Text: ({ children }: HostProps) => createElement('span', null, children),
}));

const avatarGroupCapture = vi.hoisted(() => ({ participants: [] as BoardClimbRecentSender[][] }));
vi.mock('../../../you/AvatarGroup', () => ({
  AvatarGroup: ({ participants }: { participants: BoardClimbRecentSender[] }) => {
    avatarGroupCapture.participants.push(participants);
    return createElement(
      'div',
      { 'data-testid': 'recent-senders' },
      participants.map((participant) =>
        createElement('span', { key: participant.userId, 'data-user-id': participant.userId }, participant.displayName),
      ),
    );
  },
}));

vi.mock('../../BoardDriverAvatar', () => ({
  BoardDriverAvatar: ({ userId }: { userId?: string | null }) =>
    createElement('div', { 'data-testid': 'wall-lighter', 'data-user-id': userId ?? '' }),
}));

vi.mock('../../../grade/grade-chip-colors', () => ({ readableTextColor: () => '#000000' }));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { fill: '#eee', label: '#111', secondaryLabel: '#666' },
    brandColors: { historyFill: '#333' },
  }),
}));
vi.mock('../../../../hooks/use-display-grade', () => ({
  useDisplayGrade: () => ({ resolveGrade: () => ({ label: 'V5', color: '#ff0' }) }),
}));
vi.mock('../../../../theme/tokens', () => ({
  spacing: { 2: 8, 3: 12 },
  borderRadius: { sm: 4, md: 8, full: 9999 },
}));

import { WallIdentityBlock } from '../WallIdentityBlock';

const typeScale = {
  gradeFontSize: 64,
  gradeLineHeight: 68,
  nameFontSize: 40,
  nameLineHeight: 44,
  metaFontSize: 20,
  metaLineHeight: 26,
  stateFontSize: 20,
  stateLineHeight: 26,
};

const climb: BoardPresenceClimb = {
  climbUuid: 'climb-1',
  name: 'Moon Cheese',
  grade: 'V5',
  angle: 40,
  setter: 'Taylor',
  sentByUserId: 'lighter-1',
  sentByDisplayName: 'Marco',
  sentByAvatarUrl: null,
  sentAt: '2026-07-31T12:00:00.000Z',
  seq: 1,
};

const recentSenders: BoardClimbRecentSender[] = [
  {
    userId: 'sender-newest',
    displayName: 'Alex',
    avatarUrl: null,
    lastSentAt: '2026-07-31T11:00:00.000Z',
  },
  {
    userId: 'sender-older',
    displayName: 'Maya',
    avatarUrl: null,
    lastSentAt: '2026-07-30T11:00:00.000Z',
  },
];

beforeEach(() => {
  avatarGroupCapture.participants.length = 0;
});

describe('WallIdentityBlock attribution', () => {
  it('labels the wall activator as Lit by, then renders sender avatars below it', () => {
    const { container, getByText, getByTestId } = render(
      <WallIdentityBlock climb={climb} typeScale={typeScale} isPreviewing={false} recentSenders={recentSenders} />,
    );

    expect(getByText('Lit by Marco')).toBeTruthy();
    expect(getByText('Sent by')).toBeTruthy();
    expect(getByTestId('wall-lighter').getAttribute('data-user-id')).toBe('lighter-1');
    expect(container.textContent?.indexOf('Lit by Marco')).toBeLessThan(container.textContent?.indexOf('Sent by') ?? 0);
    expect(avatarGroupCapture.participants[0]?.map((recentSender) => recentSender.userId)).toEqual([
      'sender-newest',
      'sender-older',
    ]);
  });

  it('omits the sender row when nobody has sent this climb', () => {
    const { queryByText, queryByTestId } = render(
      <WallIdentityBlock climb={climb} typeScale={typeScale} isPreviewing={false} recentSenders={[]} />,
    );

    expect(queryByText('Lit by Marco')).toBeTruthy();
    expect(queryByText('Sent by')).toBeNull();
    expect(queryByTestId('recent-senders')).toBeNull();
  });

  it('hands both attribution rows off together when a band provides a sibling column', () => {
    const { queryByText, queryByTestId, getByText } = render(
      <WallIdentityBlock
        climb={climb}
        typeScale={typeScale}
        isPreviewing={false}
        recentSenders={recentSenders}
        showAttribution={false}
      />,
    );

    expect(getByText('Set by Taylor')).toBeTruthy();
    expect(queryByText('Lit by Marco')).toBeNull();
    expect(queryByText('Sent by')).toBeNull();
    expect(queryByTestId('recent-senders')).toBeNull();
  });

  it('sheds both attribution rows in compact chrome', () => {
    const { queryByText, queryByTestId } = render(
      <WallIdentityBlock
        climb={climb}
        typeScale={typeScale}
        isPreviewing={false}
        recentSenders={recentSenders}
        compact
      />,
    );

    expect(queryByText('Lit by Marco')).toBeNull();
    expect(queryByText('Sent by')).toBeNull();
    expect(queryByTestId('recent-senders')).toBeNull();
  });
});
