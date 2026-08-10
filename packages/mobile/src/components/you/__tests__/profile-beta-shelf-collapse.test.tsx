// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { BetaLink } from '@boardsesh/shared-schema';

const collapse = vi.hoisted(() => ({ expanded: true }));
const links = vi.hoisted(() => ({
  videos: [] as Array<{ betaLink: BetaLink }>,
  isLoading: false,
  calls: 0,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
}));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../lib/beta-shelf-collapse', () => ({
  useBetaShelfCollapse: () => ({ expanded: collapse.expanded, toggle: vi.fn(), loaded: true }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useUserBetaLinks: () => {
    links.calls += 1;
    return { videos: links.videos, isLoading: links.isLoading, isLoadingMore: false, loadMore: vi.fn() };
  },
}));
vi.mock('../../play-drawer/BetaVideoCard', () => ({
  BETA_CARD_COMPACT_HEIGHT: 96,
  BetaVideoCard: ({ link }: { link: BetaLink }) =>
    createElement('div', { 'data-testid': 'beta-card', 'data-link': link.link }),
}));
// Mirrors the real wrapper's contract: header always, scroller only when open.
vi.mock('../../HorizontalScrollSection', () => ({
  HorizontalScrollSection: ({
    title,
    children,
    disclosure,
    actionLabel,
  }: {
    title: string;
    children?: ReactNode;
    disclosure?: { expanded: boolean };
    actionLabel?: string;
  }) =>
    createElement(
      'div',
      null,
      createElement('div', { 'data-testid': 'section-header', 'data-action': actionLabel }, title),
      disclosure?.expanded === false ? null : createElement('div', { 'data-testid': 'shelf-scroll' }, children),
    ),
}));

import { ProfileBetaShelf } from '../ProfileBetaShelf';

function betaLink(link: string): { betaLink: BetaLink } {
  return {
    betaLink: {
      link,
      climb_uuid: 'climb-1',
      angle: 40,
      foreign_username: 'setter',
      thumbnail: null,
      is_listed: true,
      created_at: '2026-06-12T00:00:00.000Z',
    } as unknown as BetaLink,
  };
}

describe('ProfileBetaShelf collapse', () => {
  beforeEach(() => {
    collapse.expanded = true;
    links.videos = [betaLink('https://www.instagram.com/reel/aaa/')];
    links.isLoading = false;
    links.calls = 0;
  });

  it('renders its cards while expanded', () => {
    const { getAllByTestId } = render(createElement(ProfileBetaShelf, { userId: 'user-1' }));
    expect(getAllByTestId('beta-card')).toHaveLength(1);
  });

  it('drops the cards but keeps the header when collapsed', () => {
    collapse.expanded = false;
    const { getByTestId, queryByTestId } = render(createElement(ProfileBetaShelf, { userId: 'user-1' }));

    expect(getByTestId('section-header')).toBeTruthy();
    expect(queryByTestId('shelf-scroll')).toBeNull();
    expect(queryByTestId('beta-card')).toBeNull();
  });

  it('keeps fetching while collapsed so the header survives', () => {
    // Load-bearing: the shelf self-hides when a climber has no beta, so gating
    // the query on `expanded` would strip the header too and leave no way to
    // unfold it. If this ever starts skipping the fetch, that guard is broken.
    collapse.expanded = false;
    render(createElement(ProfileBetaShelf, { userId: 'user-1' }));
    expect(links.calls).toBeGreaterThan(0);
  });

  it('still hides itself entirely for a climber with no beta', () => {
    // The self-hide predates this change and must survive it — no stray header
    // on profiles that have nothing to show.
    links.videos = [];
    links.isLoading = false;
    const { queryByTestId } = render(createElement(ProfileBetaShelf, { userId: 'user-1' }));
    expect(queryByTestId('section-header')).toBeNull();
  });
});
