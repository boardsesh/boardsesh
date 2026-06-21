// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionDetailTick, SessionFeedParticipant } from '@boardsesh/shared-schema';

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../Avatar', () => ({ Avatar: () => createElement('span', { 'data-testid': 'avatar' }) }));
vi.mock('../../ListRow', () => ({
  ListRow: ({ title, leading, trailing }: { title: string; leading?: ReactNode; trailing?: ReactNode }) =>
    createElement('div', { 'data-row': title }, leading, trailing),
}));
vi.mock('../../SectionHeader', () => ({ SectionHeader: () => createElement('div', { 'data-testid': 'header' }) }));
vi.mock('../../you/profile-chart-colors', () => ({ gradeBadgeColor: () => '#000' }));
vi.mock('../../../theme/colors', () => ({ withAlpha: (c: string) => c }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemGray: '#888', white: '#fff' } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { success: '#0a0', warning: '#fa0', accent: '#f83' } }),
}));
vi.mock('../../../hooks/use-grade-format', () => ({ useGradeFormat: () => ({ formatGrade: (g: string) => g }) }));

import { SessionLeaderboard } from '../SessionLeaderboard';

function participant(
  userId: string,
  name: string,
  sends: number,
  flashes: number,
  attempts: number,
): SessionFeedParticipant {
  return { userId, displayName: name, avatarUrl: null, sends, flashes, attempts };
}

function tick(userId: string, status: string, difficulty: number, difficultyName: string): SessionDetailTick {
  return {
    uuid: `${userId}-${difficultyName}-${status}`,
    userId,
    climbUuid: 'c',
    climbName: 'Climb',
    boardType: 'kilter',
    layoutId: 1,
    angle: 40,
    status,
    attemptCount: 1,
    difficulty,
    difficultyName,
    quality: null,
    isMirror: false,
    isBenchmark: false,
    isNoMatch: false,
    comment: null,
    frames: null,
    setterUsername: null,
    climbedAt: '2026-06-01T10:00:00.000Z',
    upvotes: 0,
    totalAttempts: 1,
    betaLinks: [],
  };
}

describe('SessionLeaderboard', () => {
  it('renders nothing for a solo session', () => {
    const { container } = render(
      createElement(SessionLeaderboard, { participants: [participant('a', 'Solo', 5, 0, 0)], ticks: [] }),
    );
    expect(container.querySelector('[data-row]')).toBeNull();
  });

  it('ranks by sends (then flashes), crowns the leader, and shows each climber hardest send-grade', () => {
    const participants = [
      participant('a', 'Alex', 5, 2, 1),
      participant('b', 'Bea', 8, 1, 0),
      participant('c', 'Cy', 5, 3, 2),
    ];
    const ticks = [
      tick('b', 'send', 20, 'V8'),
      tick('a', 'send', 12, 'V4'),
      tick('c', 'flash', 16, 'V6'),
      tick('c', 'attempt', 99, 'V17'), // attempts must NOT count toward hardest
    ];
    const { container } = render(createElement(SessionLeaderboard, { participants, ticks }));

    const order = Array.from(container.querySelectorAll('[data-row]')).map((node) => node.getAttribute('data-row'));
    // Bea (8 sends) first; Cy and Alex tie at 5 sends → Cy's extra flash breaks it.
    expect(order).toEqual(['Bea', 'Cy', 'Alex']);

    // Exactly one crown — on the leader.
    expect(container.querySelectorAll('[data-icon="crown"]')).toHaveLength(1);

    // Hardest grades from sends/flashes are shown; the attempt's V17 is excluded.
    const text = container.textContent ?? '';
    expect(text).toContain('V8');
    expect(text).toContain('V6');
    expect(text).toContain('V4');
    expect(text).not.toContain('V17');
  });
});
