// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDetail } from '@boardsesh/shared-schema';

const mockFeedSocialRow = vi.hoisted(() => vi.fn());
const mockAvatarGroup = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-testid': 'card' }, children),
}));
vi.mock('../../you/AvatarGroup', () => ({
  AvatarGroup: (props: Record<string, unknown>) => {
    mockAvatarGroup(props);
    return createElement('div', { 'data-testid': 'avatar-group' });
  },
}));
vi.mock('../../you/FeedSocialRow', () => ({
  FeedSocialRow: (props: { entityId: string }) => {
    mockFeedSocialRow(props);
    return createElement('div', { 'data-testid': 'social-row', 'data-entity': props.entityId });
  },
}));
vi.mock('../../you/profile-chart-colors', () => ({ gradeBadgeColor: () => '#f00' }));
vi.mock('../../../theme/colors', () => ({ withAlpha: (c: string) => c }));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { md: 8 },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      secondaryLabel: '#888',
      fill: '#eee',
      label: '#000',
    },
  }),
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (g: string) => g }),
}));
vi.mock('@boardsesh/profile-stats', () => ({
  // Return a fixed sentinel distinct from any i18n key so assertions are stable.
  formatTickAbsoluteTime: () => '__ABSOLUTE_TIME__',
}));
vi.mock('../../../lib/format-session-when', () => ({
  formatSessionWhen: () => 'Sunday morning',
}));

import { SessionSummaryCard } from '../SessionSummaryCard';

beforeEach(() => {
  mockFeedSocialRow.mockClear();
  mockAvatarGroup.mockClear();
});

function session(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    sessionId: 'sess-1',
    sessionType: 'party',
    sessionName: null,
    ownerUserId: null,
    participants: [],
    totalSends: 5,
    totalFlashes: 2,
    totalAttempts: 12,
    tickCount: 5,
    gradeDistribution: [],
    boardTypes: ['kilter'],
    hardestGrade: 'V6',
    firstTickAt: '2026-06-15T09:00:00.000Z',
    lastTickAt: '2026-06-15T11:00:00.000Z',
    durationMinutes: 120,
    goal: null,
    ticks: [],
    upvotes: 3,
    downvotes: 0,
    voteScore: 3,
    commentCount: 1,
    ...overrides,
  };
}

function render_(sess: SessionDetail, title: string, titleIsDate: boolean) {
  return render(
    createElement(SessionSummaryCard, {
      session: sess,
      title,
      titleIsDate,
      onOpenComments: () => {},
    }),
  );
}

describe('SessionSummaryCard', () => {
  it('displays the title', () => {
    const { container } = render_(session(), 'Morning Sesh', false);
    expect(container.textContent).toContain('Morning Sesh');
  });

  it('uses formatTickAbsoluteTime for a named session (titleIsDate=false)', () => {
    const { container } = render_(session(), 'Morning Sesh', false);
    expect(container.textContent).toContain('__ABSOLUTE_TIME__');
  });

  it('uses formatSessionWhen for an unnamed session (titleIsDate=true)', () => {
    const { container } = render_(session(), 'Jun 15, 2026', true);
    expect(container.textContent).toContain('Sunday morning');
  });

  it('displays board types in the meta row', () => {
    const { container } = render_(session({ boardTypes: ['kilter', 'tension'] }), 'Sesh', false);
    expect(container.textContent).toContain('kilter · tension');
  });

  it('displays duration when durationMinutes > 0', () => {
    const { container } = render_(session({ durationMinutes: 90 }), 'Sesh', false);
    expect(container.textContent).toContain('1h 30m');
  });

  it('formats sub-60-minute duration as Xm', () => {
    const { container } = render_(session({ durationMinutes: 45 }), 'Sesh', false);
    expect(container.textContent).toContain('45m');
  });

  it('hides duration when durationMinutes is null', () => {
    const { container } = render_(session({ durationMinutes: null }), 'Sesh', false);
    expect(container.querySelector('[data-icon="clock"]')).toBeNull();
  });

  it('hides duration when durationMinutes is 0', () => {
    const { container } = render_(session({ durationMinutes: 0 }), 'Sesh', false);
    expect(container.querySelector('[data-icon="clock"]')).toBeNull();
  });

  it('shows the goal when set', () => {
    const { container } = render_(session({ goal: 'Flash the overhang' }), 'Sesh', false);
    expect(container.textContent).toContain('Flash the overhang');
  });

  it('omits the goal row when goal is null', () => {
    const { container } = render_(session({ goal: null }), 'Sesh', false);
    expect(container.textContent).not.toContain('Flash the overhang');
  });

  it('renders the stat tile values', () => {
    const { container } = render_(session({ totalSends: 7, totalFlashes: 3, totalAttempts: 20 }), 'Sesh', false);
    const text = container.textContent ?? '';
    // Assert value + i18n label key together to avoid matching stray digits elsewhere.
    expect(text).toContain('7mobile.sessions.weekly.sends');
    expect(text).toContain('3mobile.sessions.weekly.flashes');
    expect(text).toContain('20mobile.sessions.weekly.attempts');
  });

  it('renders the grade tile when hardestGrade is set', () => {
    const { container } = render_(session({ hardestGrade: 'V8' }), 'Sesh', false);
    expect(container.textContent).toContain('V8');
  });

  it('omits the grade tile when hardestGrade is null', () => {
    const { container } = render_(session({ hardestGrade: null }), 'Sesh', false);
    // hardest label key should not appear
    expect(container.textContent).not.toContain('sessionFeedCard.hardest');
  });

  it('passes the sessionId to FeedSocialRow', () => {
    render_(session({ sessionId: 'sess-42' }), 'Sesh', false);
    expect(mockFeedSocialRow).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'sess-42' }));
  });

  it('wires onOpenComments through to FeedSocialRow', () => {
    const onOpenComments = vi.fn();
    render(
      createElement(SessionSummaryCard, {
        session: session({ sessionId: 'sess-42' }),
        title: 'Sesh',
        titleIsDate: false,
        onOpenComments,
      }),
    );
    const capturedProps = mockFeedSocialRow.mock.calls[0][0] as {
      entityId: string;
      onOpenComments: (id: string) => void;
    };
    expect(typeof capturedProps.onOpenComments).toBe('function');
    capturedProps.onOpenComments('sess-42');
    expect(onOpenComments).toHaveBeenCalledWith('sess-42');
  });

  it('passes participants to AvatarGroup', () => {
    const participants = [{ userId: 'u1', displayName: 'Alice', avatarUrl: null, sends: 3, flashes: 1, attempts: 7 }];
    render_(session({ participants }), 'Party', false);
    expect(mockAvatarGroup).toHaveBeenCalledWith(expect.objectContaining({ participants }));
  });
});
