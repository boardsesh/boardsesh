// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';

type MembershipQueryArgs = { climbUuid: string; boardName: string; layoutId: number; enabled: boolean };

const ctrl = vi.hoisted(() => ({
  playlists: [] as Playlist[],
  isAuthenticated: true,
  // What the shared membership store (fed only by the Climbs tab) already holds.
  seeded: new Set<string>(),
  // What this climb's own fetch has returned, if anything.
  memberUuids: undefined as string[] | undefined,
  queryArgs: [] as MembershipQueryArgs[],
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
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.playlists == null ? key : `${key}|${String(options.playlists)}`,
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

import { PlayDrawerPlaylistChips, PLAY_DRAWER_CHIPS_SLOT_HEIGHT } from '../PlayDrawerPlaylistChips';

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

function renderChips(overrides: Partial<typeof baseProps> = {}) {
  return render(createElement(PlayDrawerPlaylistChips, { ...baseProps, ...overrides }));
}

function slotStyle(container: HTMLElement): string {
  return container.querySelector('[data-view]')?.getAttribute('data-style') ?? '';
}

describe('PlayDrawerPlaylistChips', () => {
  beforeEach(() => {
    ctrl.playlists = [playlist('p1', 'Sunday sends'), playlist('p2', 'Project@40')];
    ctrl.isAuthenticated = true;
    ctrl.seeded = new Set();
    ctrl.memberUuids = undefined;
    ctrl.queryArgs = [];
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

  it('renders nothing, and fetches nothing, when the climber has no playlist on this board', () => {
    // Playlists on another board can never produce a chip here, so no slot and
    // no request.
    ctrl.playlists = [{ ...playlist('p9', 'Tension list'), boardType: 'tension' }];
    const { container } = renderChips();
    expect(container.textContent).toBe('');
    expect(ctrl.queryArgs.length).toBeGreaterThan(0);
    expect(ctrl.queryArgs.some((args) => args.enabled)).toBe(false);
  });

  it('renders nothing, and fetches nothing, for a playlist on another layout of this board', () => {
    // Layout-scoped playlists don't cross layouts, so this climber still can't
    // see a chip here — the slot must not appear and eat board art.
    ctrl.playlists = [playlist('p8', 'Original layout list', 2)];
    const { container } = renderChips();
    expect(container.textContent).toBe('');
    expect(ctrl.queryArgs.length).toBeGreaterThan(0);
    expect(ctrl.queryArgs.some((args) => args.enabled)).toBe(false);
  });

  it('keeps the reserved slot the same height whether or not the climb is in a playlist', () => {
    // Load-bearing: the board art below is `flex: 1` inside a fixed-height first
    // screen, so a per-climb header height would resize the board on every swipe.
    const empty = renderChips();
    expect(slotStyle(empty.container)).toContain(`"height":${PLAY_DRAWER_CHIPS_SLOT_HEIGHT}`);

    ctrl.memberUuids = ['p1'];
    const filled = renderChips();
    expect(slotStyle(filled.container)).toContain(`"height":${PLAY_DRAWER_CHIPS_SLOT_HEIGHT}`);
    expect(filled.container.textContent).toContain('Sunday sends');
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
    expect(container.textContent).toContain('+2');
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
