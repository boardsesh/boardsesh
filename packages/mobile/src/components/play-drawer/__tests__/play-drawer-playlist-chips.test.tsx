// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';

type MembershipQueryArgs = { climbUuid: string; boardName: string; layoutId: number; enabled: boolean };

const ctrl = vi.hoisted(() => ({
  metadataRequest: vi.fn(),
  playlists: [] as Playlist[],
  isAuthenticated: true,
  // What the shared membership store (fed only by the Climbs tab) already holds.
  seeded: new Set<string>(),
  // What this climb's own fetch has returned, if anything.
  memberUuids: undefined as string[] | undefined,
  queryArgs: [] as MembershipQueryArgs[],
}));

vi.mock('../../../lib/graphql/client', () => ({
  getHttpClient: () => ({ request: ctrl.metadataRequest }),
}));

vi.mock('react-native', () => ({
  View: ({
    children,
    style,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    style?: unknown;
    accessibilityLabel?: string;
  }) =>
    createElement(
      'div',
      { 'data-view': 'true', 'data-style': JSON.stringify(style ?? null), 'aria-label': accessibilityLabel },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios ?? spec.default },
  PlatformColor: (name: string) => name,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      typeof options?.playlists === 'string' ? `${key}|${options.playlists}` : key,
  }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../../theme/variants', () => ({
  selectByVariant: (variant: 'material' | 'liquidGlass', byVariant: Record<string, unknown>) => byVariant[variant],
}));

// The real tokens module transitively loads ios-colors → PlatformColor, which
// isn't available under jsdom.
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8 },
  borderRadius: { md: 8, full: 9999 },
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: 'liquidGlass' as const,
    systemColors: { fill: '#222', secondaryLabel: '#aaa' },
    m3: { surfaceVariant: '#333', onSurfaceVariant: '#ccc' },
  }),
}));

vi.mock('../../../providers/playlists-provider', () => ({
  usePlaylistsContextOptional: () => ({
    playlists: ctrl.playlists,
    playlistsById: new Map(ctrl.playlists.map((entry) => [entry.uuid, entry] as const)),
    isAuthenticated: ctrl.isAuthenticated,
  }),
}));

vi.mock('../../../hooks/use-climb-playlist-memberships', () => ({
  useClimbPlaylistMemberships: () => ctrl.seeded,
}));

vi.mock('../../../hooks/use-climb-playlist-membership-query', () => ({
  useClimbPlaylistMembershipQuery: (args: MembershipQueryArgs) => {
    ctrl.queryArgs.push(args);
    return {
      membershipKey: ['playlistsForClimb', args.boardName, args.layoutId, args.climbUuid],
      memberUuids: ctrl.memberUuids,
    };
  },
}));

// The list variant lives in the same module as the shared chips row.
vi.mock('../../../lib/show-playlist-tags-preference', () => ({
  useShowPlaylistTagsPreference: () => ({ enabled: false, loaded: true, setEnabled: vi.fn() }),
}));

import { PlayDrawerPlaylistChips } from '../PlayDrawerPlaylistChips';

function playlist(uuid: string, name: string, layoutId: number | null = 1): Playlist {
  return {
    id: uuid,
    uuid,
    boardType: 'kilter',
    layoutId,
    name,
    isPublic: false,
    createdAt: '',
    updatedAt: '',
    climbCount: 0,
    followerCount: 0,
    isFollowedByMe: false,
    isPinnedByMe: false,
  };
}

const baseProps = { climbUuid: 'c1', boardName: 'kilter', layoutId: 1, fetchMembership: true };

function renderChips(
  overrides: Partial<typeof baseProps> = {},
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(PlayDrawerPlaylistChips, { ...baseProps, ...overrides }),
    ),
  );
}

function rowStyle(container: HTMLElement): string {
  return container.querySelector('[data-view]')?.getAttribute('data-style') ?? '';
}

describe('PlayDrawerPlaylistChips', () => {
  beforeEach(() => {
    ctrl.playlists = [playlist('p1', 'Sunday sends'), playlist('p2', 'Project@40')];
    ctrl.isAuthenticated = true;
    ctrl.seeded = new Set();
    ctrl.memberUuids = undefined;
    ctrl.queryArgs = [];
    ctrl.metadataRequest.mockReset();
    ctrl.metadataRequest.mockResolvedValue({ playlist: null });
  });

  it('renders nothing, and fetches nothing, when the climber is signed out', () => {
    ctrl.isAuthenticated = false;
    ctrl.memberUuids = ['p1'];
    const { container } = renderChips();
    expect(container.textContent).toBe('');
    // `some`, not `every`: "no request was enabled", asserted against a hook
    // that was definitely called (hooks run before the early return).
    expect(ctrl.queryArgs.length).toBeGreaterThan(0);
    expect(ctrl.queryArgs.some((args) => args.enabled)).toBe(false);
  });

  it('requests membership even when the metadata page contains only another board', () => {
    // A partial metadata page cannot prove absence of memberships on this board.
    ctrl.playlists = [{ ...playlist('p9', 'Tension list'), boardType: 'tension' }];
    const { container } = renderChips();
    expect(container.textContent).toBe('');
    expect(ctrl.queryArgs.length).toBeGreaterThan(0);
    expect(ctrl.queryArgs.some((args) => args.enabled)).toBe(true);
  });

  it('requests membership even when the metadata page contains only another layout', () => {
    // The matching layout's playlist may be outside the first metadata page.
    ctrl.playlists = [playlist('p8', 'Original layout list', 2)];
    const { container } = renderChips();
    expect(container.textContent).toBe('');
    expect(ctrl.queryArgs.length).toBeGreaterThan(0);
    expect(ctrl.queryArgs.some((args) => args.enabled)).toBe(true);
  });

  it('renders membership beyond the first 200 metadata entries', async () => {
    ctrl.playlists = Array.from({ length: 200 }, (_, index) => ({
      ...playlist(`early-${index}`, `Other ${index}`),
      boardType: 'tension',
    }));
    ctrl.memberUuids = ['later-kilter'];
    ctrl.metadataRequest.mockResolvedValue({ playlist: playlist('later-kilter', 'Beyond page one') });
    const { container } = renderChips();
    await waitFor(() => expect(container.textContent).toContain('Beyond page one'));
    expect(ctrl.queryArgs.some((args) => args.enabled)).toBe(true);
    expect(ctrl.metadataRequest).toHaveBeenCalledTimes(1);
    expect(ctrl.metadataRequest.mock.calls[0]?.[1]).toEqual({ playlistId: 'later-kilter' });
    expect(container.querySelector('[aria-label]')?.getAttribute('aria-label')).toContain('Beyond page one');
  });

  it('reuses previously fetched metadata for the offscreen peek', () => {
    ctrl.memberUuids = ['cached-playlist'];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['playlist', 'cached-playlist'], playlist('cached-playlist', 'Cached sends'));
    const { container } = renderChips({ fetchMembership: false }, client);
    expect(container.textContent).toContain('Cached sends');
    expect(ctrl.metadataRequest).not.toHaveBeenCalled();
  });

  it('does not fetch missing metadata for the offscreen peek', () => {
    ctrl.memberUuids = ['outside-page'];
    const { container } = renderChips({ fetchMembership: false });
    expect(container.textContent).toBe('');
    expect(ctrl.metadataRequest).not.toHaveBeenCalled();
  });

  it('does not request membership before a real layout is known', () => {
    // layoutId 0 is the "not resolved yet" placeholder; the resolver would reject
    // it, so the fetch waits rather than burning a round trip. A board-wide
    // playlist matches every layout, including 0 — so the layout guard is the only
    // thing that can be holding the request back here.
    ctrl.playlists = [playlist('p5', 'Kilter circuit', null)];
    renderChips({ layoutId: 0 });
    expect(ctrl.queryArgs.length).toBeGreaterThan(0);
    expect(ctrl.queryArgs.some((args) => args.enabled)).toBe(false);
  });

  it('sets no height and no margin of its own', () => {
    // Half of what keeps the board art whole. The strip rides inside the header's
    // existing stats line, so it must contribute no vertical space itself: no
    // fixed height, no top margin, and no chip `minHeight` taller than the caption
    // it sits in. That the header actually NESTS it in that line — rather than
    // dropping it below as a third line, the shape QA declined — is pinned by
    // `play-drawer-header-layout-budget.test.tsx`, which renders the real header.
    ctrl.memberUuids = ['p1'];
    const { container } = renderChips();
    expect(container.textContent).toContain('Sunday sends');
    expect(ctrl.metadataRequest).not.toHaveBeenCalled();
    expect(rowStyle(container)).toContain('"marginTop":0');
    expect(rowStyle(container)).not.toContain('"height"');
    // The chip itself: no capsule padding, no minHeight — a dot and a name, as
    // tall as the caption line and no taller.
    const chip = container.querySelectorAll('[data-view]')[1];
    expect(chip?.getAttribute('data-style') ?? '').not.toContain('minHeight');
  });

  it('shows one playlist by name and collapses the rest, to share the stats line', () => {
    // Two full names beside "42 sends · 3.2★ · setter" ellipsize both to noise on
    // a phone-width centre column, so the header caps at one and counts the rest.
    ctrl.memberUuids = ['p1', 'p2'];
    const { container } = renderChips();
    expect(container.textContent).toContain('Sunday sends');
    expect(container.textContent).not.toContain('Project@40');
    expect(container.textContent).toContain('+1');
  });

  it('paints from the shared store seed before its own fetch resolves', () => {
    // The Climbs-tab path: membership is already in the store, so the chips are
    // there on the first frame.
    ctrl.seeded = new Set(['p2']);
    const { container } = renderChips();
    expect(container.textContent).toContain('Project@40');
  });

  it('lets the fetch result win over a stale seed', () => {
    ctrl.seeded = new Set(['p2']);
    ctrl.memberUuids = ['p1'];
    const { container } = renderChips();
    expect(container.textContent).toContain('Sunday sends');
    expect(container.textContent).not.toContain('Project@40');
  });

  it('still paints, without requesting, when the header is a swipe peek', () => {
    // A fling passes many climbs; the peek header must not fire a request per one.
    // With nothing cached (`memberUuids` undefined, which is what a disabled query
    // returns on a cold entry) it falls through to the store seed rather than
    // going blank.
    ctrl.seeded = new Set(['p1']);
    const { container } = renderChips({ fetchMembership: false });
    expect(ctrl.queryArgs.length).toBeGreaterThan(0);
    expect(ctrl.queryArgs.some((args) => args.enabled)).toBe(false);
    expect(container.textContent).toContain('Sunday sends');
  });

  it('paints a warm cache entry on a peek header without requesting', () => {
    // A disabled React Query still serves cached data — the climb was the current
    // one a swipe ago, so swiping back must not blank its chips.
    ctrl.memberUuids = ['p2'];
    const { container } = renderChips({ fetchMembership: false });
    expect(ctrl.queryArgs.some((args) => args.enabled)).toBe(false);
    expect(container.textContent).toContain('Project@40');
  });

  it('requests membership for the climb on screen', () => {
    renderChips();
    expect(ctrl.queryArgs.some((args) => args.enabled && args.climbUuid === 'c1')).toBe(true);
  });

  it('announces every playlist by name, including the ones the "+N" token hides', () => {
    ctrl.playlists = [
      playlist('p1', 'Sunday sends'),
      playlist('p2', 'Project@40'),
      playlist('p3', 'Warmups'),
      playlist('p4', 'Benchmarks'),
    ];
    ctrl.memberUuids = ['p1', 'p2', 'p3', 'p4'];
    const { container } = renderChips();
    expect(container.textContent).toContain('+3');
    const label = container.querySelector('[aria-label]')?.getAttribute('aria-label') ?? '';
    expect(label).toBe('mobile.detail.inPlaylists|Sunday sends, Project@40, Warmups, Benchmarks');
  });

  it('matches a board-wide playlist with no layout of its own', () => {
    // Synced circuits arrive with a null layoutId and are legitimate on every
    // layout of their board — the same rule the backend resolver applies.
    ctrl.playlists = [playlist('p5', 'Kilter circuit', null)];
    ctrl.memberUuids = ['p5'];
    const { container } = renderChips();
    expect(container.textContent).toContain('Kilter circuit');
  });
});
