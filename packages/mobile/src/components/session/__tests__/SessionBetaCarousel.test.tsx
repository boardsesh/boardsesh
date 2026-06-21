// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BetaLink, SessionDetailTick, SessionFeedParticipant, BetaLinksGqlRow } from '@boardsesh/shared-schema';

// Capture what each (mocked) BetaVideoCard renders so we can assert exactly one
// card per deduped video and its crew attribution. The real beta-video-url
// helpers (filter + dedupe) stay in play so the carousel's selection logic is
// what's under test.
const cards = vi.hoisted(() => ({
  rendered: [] as Array<{ link: string; uploaderName: string | null | undefined }>,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'beta-scroll' }, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => createElement('div', { 'data-testid': 'section-header' }, title),
}));
vi.mock('../../play-drawer/BetaVideoCard', () => ({
  BETA_CARD_WIDTH: 140,
  BetaVideoCard: ({ link, uploaderName }: { link: BetaLink; uploaderName?: string | null }) => {
    cards.rendered.push({ link: link.link, uploaderName });
    return createElement('div', { 'data-testid': 'beta-card', 'data-link': link.link });
  },
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 3: 12, 4: 16 } }));

import { SessionBetaCarousel } from '../SessionBetaCarousel';

function betaRow(overrides: Partial<BetaLinksGqlRow> = {}): BetaLinksGqlRow {
  return {
    climbUuid: 'climb-1',
    link: 'https://www.instagram.com/reel/aaa/',
    foreignUsername: 'setter',
    angle: 40,
    thumbnail: null,
    isListed: true,
    createdAt: '2026-06-12T00:00:00.000Z',
    tickUuid: null,
    boardId: null,
    ...overrides,
  };
}

function tick(betaLinks: BetaLinksGqlRow[], overrides: { uuid?: string; userId?: string } = {}): SessionDetailTick {
  return {
    uuid: overrides.uuid ?? 'tick-1',
    userId: overrides.userId ?? 'user-1',
    climbUuid: 'climb-1',
    climbName: 'Test Climb',
    boardType: 'kilter',
    layoutId: 1,
    angle: 40,
    status: 'send',
    attemptCount: 2,
    difficulty: 12,
    difficultyName: 'V4',
    quality: null,
    isMirror: false,
    isBenchmark: false,
    isNoMatch: false,
    comment: null,
    frames: null,
    setterUsername: null,
    climbedAt: '2026-06-01T10:00:00.000Z',
    upvotes: 0,
    totalAttempts: 5,
    betaLinks,
  };
}

function participant(userId: string, displayName: string): SessionFeedParticipant {
  return { userId, displayName, avatarUrl: null, sends: 1, flashes: 0, attempts: 0 };
}

const SOLO = { participantById: new Map<string, SessionFeedParticipant>(), isMultiUser: false };

beforeEach(() => {
  cards.rendered = [];
});

describe('SessionBetaCarousel', () => {
  it('renders one BetaVideoCard per deduped video link across ticks', () => {
    const { getAllByTestId } = render(
      createElement(SessionBetaCarousel, {
        ...SOLO,
        ticks: [
          tick([betaRow({ link: 'https://www.instagram.com/reel/aaa/' })], { uuid: 't1' }),
          tick([betaRow({ link: 'https://www.tiktok.com/@user/video/12345' })], { uuid: 't2' }),
          // Same Instagram reel id as the first — deduped away.
          tick([betaRow({ link: 'https://instagram.com/reel/aaa/?igsh=tracking' })], { uuid: 't3' }),
        ],
      }),
    );

    const renderedCards = getAllByTestId('beta-card');
    expect(renderedCards).toHaveLength(2);
    expect(cards.rendered.map((card) => card.link)).toEqual([
      'https://www.instagram.com/reel/aaa/',
      'https://www.tiktok.com/@user/video/12345',
    ]);
  });

  it('filters out unsupported platforms (e.g. YouTube)', () => {
    const { getAllByTestId } = render(
      createElement(SessionBetaCarousel, {
        ...SOLO,
        ticks: [
          tick([
            betaRow({ link: 'https://www.instagram.com/reel/bbb/' }),
            betaRow({ link: 'https://www.youtube.com/watch?v=abcdefg' }),
            betaRow({ link: 'https://example.com/beta' }),
          ]),
        ],
      }),
    );

    expect(getAllByTestId('beta-card')).toHaveLength(1);
    expect(cards.rendered.map((card) => card.link)).toEqual(['https://www.instagram.com/reel/bbb/']);
  });

  it('renders nothing when no tick has beta links', () => {
    const { container } = render(createElement(SessionBetaCarousel, { ...SOLO, ticks: [tick([]), tick([])] }));
    expect(container.querySelector('[data-testid="beta-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="beta-scroll"]')).toBeNull();
    expect(cards.rendered).toHaveLength(0);
  });

  it('attributes each clip to the participant who logged its tick (multi-user only)', () => {
    const participantById = new Map<string, SessionFeedParticipant>([
      ['user-a', participant('user-a', 'Cata')],
      ['user-b', participant('user-b', 'Marco')],
    ]);
    render(
      createElement(SessionBetaCarousel, {
        participantById,
        isMultiUser: true,
        ticks: [
          tick([betaRow({ link: 'https://www.instagram.com/reel/aaa/' })], { uuid: 't1', userId: 'user-a' }),
          tick([betaRow({ link: 'https://www.tiktok.com/@user/video/12345' })], { uuid: 't2', userId: 'user-b' }),
        ],
      }),
    );

    expect(cards.rendered).toEqual([
      { link: 'https://www.instagram.com/reel/aaa/', uploaderName: 'Cata' },
      { link: 'https://www.tiktok.com/@user/video/12345', uploaderName: 'Marco' },
    ]);
  });

  it('omits attribution in solo sessions', () => {
    render(
      createElement(SessionBetaCarousel, {
        ...SOLO,
        ticks: [tick([betaRow({ link: 'https://www.instagram.com/reel/aaa/' })], { userId: 'user-1' })],
      }),
    );
    expect(cards.rendered).toEqual([{ link: 'https://www.instagram.com/reel/aaa/', uploaderName: null }]);
  });
});
