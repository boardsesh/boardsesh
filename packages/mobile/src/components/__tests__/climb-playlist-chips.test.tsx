// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';

// Controls the hooks the chips read, set per-test before render.
const ctrl = vi.hoisted(() => ({
  variant: 'liquidGlass' as 'material' | 'liquidGlass',
  membership: new Set<string>(),
  playlistsById: undefined as Map<string, Playlist> | undefined,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-view': 'true' }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../theme/variants', () => ({
  selectByVariant: (variant: 'material' | 'liquidGlass', byVariant: Record<string, unknown>) => byVariant[variant],
}));

// Avoid pulling the real tokens module (it transitively loads ios-colors →
// PlatformColor, which isn't available under jsdom).
vi.mock('../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8 },
  borderRadius: { md: 8, full: 9999 },
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: ctrl.variant,
    systemColors: { fill: '#222', secondaryLabel: '#aaa' },
    m3: { surfaceVariant: '#333', onSurfaceVariant: '#ccc' },
  }),
}));

vi.mock('../../providers/playlists-provider', () => ({
  usePlaylistsContextOptional: () => (ctrl.playlistsById ? { playlistsById: ctrl.playlistsById } : undefined),
}));

vi.mock('../../hooks/use-climb-playlist-memberships', () => ({
  useClimbPlaylistMemberships: () => ctrl.membership,
}));

import { ClimbPlaylistChips, ClimbPlaylistChipsView } from '../ClimbPlaylistChips';

function playlist(uuid: string, name: string, color?: string): Playlist {
  return {
    id: uuid,
    uuid,
    boardType: 'kilter',
    layoutId: 1,
    name,
    isPublic: false,
    color,
    createdAt: '',
    updatedAt: '',
    climbCount: 0,
    followerCount: 0,
    isFollowedByMe: false,
    isPinnedByMe: false,
  };
}

function setMemberships(entries: Array<[string, string]>, colors: Record<string, string | undefined> = {}) {
  ctrl.membership = new Set(entries.map(([uuid]) => uuid));
  ctrl.playlistsById = new Map(entries.map(([uuid, name]) => [uuid, playlist(uuid, name, colors[uuid])]));
}

describe('ClimbPlaylistChips', () => {
  beforeEach(() => {
    ctrl.variant = 'liquidGlass';
    ctrl.membership = new Set();
    ctrl.playlistsById = new Map();
  });

  it('renders nothing when the climb is in no playlists', () => {
    const { container } = render(<ClimbPlaylistChips climbUuid="c1" />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing when no playlists provider is mounted', () => {
    ctrl.membership = new Set(['p1']);
    ctrl.playlistsById = undefined;
    const { container } = render(<ClimbPlaylistChips climbUuid="c1" />);
    expect(container.textContent).toBe('');
  });

  it('renders a chip per membership when there are two or fewer', () => {
    setMemberships([
      ['p1', 'Project@30'],
      ['p2', 'Next@25'],
    ]);
    const { container } = render(<ClimbPlaylistChips climbUuid="c1" />);
    expect(container.textContent).toContain('Project@30');
    expect(container.textContent).toContain('Next@25');
    expect(container.textContent).not.toContain('+');
  });

  it('shows the first two chips and a "+N" overflow token beyond two', () => {
    setMemberships([
      ['p1', 'Project@30'],
      ['p2', 'Next@25'],
      ['p3', 'Regression@30'],
      ['p4', 'Warmups'],
    ]);
    const { container } = render(<ClimbPlaylistChips climbUuid="c1" />);
    expect(container.textContent).toContain('Project@30');
    expect(container.textContent).toContain('Next@25');
    // The 3rd and 4th collapse into the overflow counter, not their own chips.
    expect(container.textContent).not.toContain('Regression@30');
    expect(container.textContent).not.toContain('Warmups');
    expect(container.textContent).toContain('+2');
  });

  it('renders on the Material variant too', () => {
    ctrl.variant = 'material';
    setMemberships([['p1', 'Project@30']]);
    const { container } = render(<ClimbPlaylistChips climbUuid="c1" />);
    expect(container.textContent).toContain('Project@30');
  });
});

// The "Show playlist tags" setting is not read here any more: the row decides
// whether to mount the strip at all (climb-row-default-output.test.tsx).
//
// The view is what the Climb list settings preview draws from staged data, so it
// has to work with no membership store and no playlists provider behind it.
describe('ClimbPlaylistChipsView', () => {
  const chip = (key: string, name: string, emoji: string | null = null) => ({ key, name, dotColor: '#FF0000', emoji });

  beforeEach(() => {
    ctrl.variant = 'liquidGlass';
    ctrl.membership = new Set();
    ctrl.playlistsById = undefined;
  });

  it('draws the chips it is handed', () => {
    const { container } = render(<ClimbPlaylistChipsView chips={[chip('p1', 'Project@30'), chip('p2', 'Next@25')]} />);
    expect(container.textContent).toBe('Project@30Next@25');
  });

  it('shows a playlist’s emoji in place of its colour dot', () => {
    const { container } = render(<ClimbPlaylistChipsView chips={[chip('p1', 'Project@30', '🔥')]} />);
    expect(container.textContent).toBe('🔥Project@30');
  });

  it('collapses everything past the second chip into "+N"', () => {
    const { container } = render(
      <ClimbPlaylistChipsView chips={[chip('p1', 'One'), chip('p2', 'Two'), chip('p3', 'Three')]} />,
    );
    expect(container.textContent).toBe('OneTwo+1');
  });

  it('draws nothing, not an empty strip, for a climb in no playlists', () => {
    const { container } = render(<ClimbPlaylistChipsView chips={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
