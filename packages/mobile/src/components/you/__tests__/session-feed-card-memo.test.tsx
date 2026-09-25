// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { SessionFeedItem } from '@boardsesh/shared-schema';

// Count how many times SessionFeedCard's body actually runs. The body renders a
// `Card` exactly once, so a counter in the Card mock is a faithful proxy: if
// React.memo bails an identical-props re-render, this must NOT bump.
const renderCounter = vi.hoisted(() => ({ count: 0 }));

vi.mock('react-native', () => {
  const passthrough =
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children);
  return {
    Platform: { OS: 'ios' },
    PlatformColor: (name: string) => name,
    View: passthrough('div'),
    StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  };
});

vi.mock('expo-image', () => ({
  Image: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// SessionFeedCard calls the mobile wrapper (`lib/format-relative-time.ts`),
// which itself imports these from @boardsesh/profile-stats — tickTimeMs only
// gates the empty-string guard, so any finite return keeps it a no-op.
vi.mock('@boardsesh/profile-stats', () => ({
  formatTickRelativeTime: () => '2h ago',
  tickTimeMs: () => 0,
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#666', tertiaryLabel: '#999', separator: '#ccc', fill: '#eee' },
    brandColors: { primary: '#6D28D9' },
  }),
}));

vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (grade: string) => grade }),
}));

vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openClimbActions: vi.fn() }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn(), hapticMedium: vi.fn() }));

vi.mock('../../../lib/beta-video-url', () => ({ mapBetaLink: () => null }));
vi.mock('../../../lib/open-external-link', () => ({ openValidatedUrl: vi.fn() }));
vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({ getBoardConfigForPlaylist: () => null }));
vi.mock('../../../lib/tick-to-climb', () => ({ tickToClimb: () => null }));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('span', { 'data-icon': 'true' }) }));
vi.mock('../../Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => {
    renderCounter.count += 1;
    return createElement('div', { 'data-card': 'true' }, children);
  },
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../ClimbListThumbnail', () => ({
  ClimbListThumbnail: () => createElement('div', { 'data-thumb': 'true' }),
}));
vi.mock('../AvatarGroup', () => ({ AvatarGroup: () => createElement('div', { 'data-avatars': 'true' }) }));
vi.mock('../FeedSocialRow', () => ({ FeedSocialRow: () => createElement('div', { 'data-social': 'true' }) }));
vi.mock('../SessionGradeStrip', () => ({ SessionGradeStrip: () => null }));
vi.mock('../profile-chart-colors', () => ({ gradeBadgeColor: () => '#000' }));

import { SessionFeedCard } from '../SessionFeedCard';

function makeSession(overrides: Partial<SessionFeedItem> = {}): SessionFeedItem {
  return {
    sessionId: 's1',
    sessionType: 'party',
    participants: [{ userId: 'u1', displayName: 'Alex', avatarUrl: null }],
    totalSends: 4,
    totalFlashes: 1,
    totalAttempts: 6,
    tickCount: 5,
    gradeDistribution: [],
    boardTypes: ['Kilter'],
    hardestGrade: null,
    hardestSend: null,
    featuredBeta: null,
    socialEntityType: 'session',
    socialEntityId: 'entity-1',
    firstTickAt: '2026-01-01T10:00:00',
    lastTickAt: '2026-01-01T12:00:00',
    durationMinutes: 90,
    goal: null,
    upvotes: 3,
    downvotes: 0,
    voteScore: 3,
    commentCount: 2,
    ...overrides,
  } as SessionFeedItem;
}

// Stable handlers — the home screen passes useCallback-stable ones.
const onOpenComments = vi.fn();
const onPress = vi.fn();
const onOpenClimb = vi.fn();

describe('SessionFeedCard React.memo', () => {
  beforeEach(() => {
    renderCounter.count = 0;
    vi.clearAllMocks();
  });

  it('skips re-render when props (incl. the same voteSummary object) are referentially equal', () => {
    const session = makeSession();
    const voteSummary = { upvotes: 3, userVote: 1 };
    const element = (
      <SessionFeedCard
        session={session}
        voteSummary={voteSummary}
        onOpenComments={onOpenComments}
        onPress={onPress}
        onOpenClimb={onOpenClimb}
      />
    );

    const { rerender } = render(element);
    expect(renderCounter.count).toBe(1);

    // Same element identity → identical props. A working memo skips the body.
    rerender(element);
    expect(renderCounter.count).toBe(1);
  });

  it('bails when a fresh render passes the SAME voteSummary object (identity-preserving map case)', () => {
    const session = makeSession();
    // This is exactly what buildVoteSummaryMap yields for an unchanged entity:
    // a brand-new SessionFeedCard element, but the same voteSummary reference.
    const voteSummary = { upvotes: 3, userVote: 1 };
    const props = { session, onOpenComments, onPress, onOpenClimb };

    const { rerender } = render(<SessionFeedCard {...props} voteSummary={voteSummary} />);
    expect(renderCounter.count).toBe(1);

    rerender(<SessionFeedCard {...props} voteSummary={voteSummary} />);
    expect(renderCounter.count).toBe(1);
  });

  it('re-renders when the voteSummary object changes (a vote landed for this row)', () => {
    const session = makeSession();
    const props = { session, onOpenComments, onPress, onOpenClimb };

    const { rerender } = render(<SessionFeedCard {...props} voteSummary={{ upvotes: 3, userVote: 1 }} />);
    expect(renderCounter.count).toBe(1);

    // A new object (buildVoteSummaryMap mints one only when the vote actually moved).
    rerender(<SessionFeedCard {...props} voteSummary={{ upvotes: 4, userVote: 1 }} />);
    expect(renderCounter.count).toBe(2);
  });
});
