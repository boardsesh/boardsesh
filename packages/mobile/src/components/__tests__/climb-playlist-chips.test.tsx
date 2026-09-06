// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';

// Controls the hooks the chips read, set per-test before render.
const ctrl = vi.hoisted(() => ({
  enabled: true,
  variant: 'liquidGlass' as 'material' | 'liquidGlass',
  membership: new Set<string>(),
  playlistsById: undefined as Map<string, Playlist> | undefined,
}));

vi.mock('react-native', () => ({
  // Style and accessibility props ride through as data attributes so the
  // alignment and accessibility-treatment assertions can read them.
  View: ({
    children,
    style,
    accessibilityLabel,
    accessibilityElementsHidden,
  }: {
    children?: ReactNode;
    style?: unknown;
    accessibilityLabel?: string;
    accessibilityElementsHidden?: boolean;
  }) =>
    createElement(
      'div',
      {
        'data-view': 'true',
        'data-style': JSON.stringify(style ?? null),
        'aria-label': accessibilityLabel,
        'data-a11y-hidden': accessibilityElementsHidden ? 'true' : 'false',
      },
      children,
    ),
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

vi.mock('../../lib/show-playlist-tags-preference', () => ({
  useShowPlaylistTagsPreference: () => ({ enabled: ctrl.enabled, loaded: true, setEnabled: vi.fn() }),
}));

import { ClimbPlaylistChips, PlaylistChipsRow } from '../ClimbPlaylistChips';

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

function rowStyle(container: HTMLElement): string {
  return container.querySelector('[data-view]')?.getAttribute('data-style') ?? '';
}

describe('ClimbPlaylistChips', () => {
  beforeEach(() => {
    ctrl.enabled = true;
    ctrl.variant = 'liquidGlass';
    ctrl.membership = new Set();
    ctrl.playlistsById = new Map();
  });

  it('renders nothing when the setting is off', () => {
    ctrl.enabled = false;
    setMemberships([['p1', 'Project@30']]);
    const { container } = render(<ClimbPlaylistChips climbUuid="c1" />);
    expect(container.textContent).toBe('');
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

  it('hides the list-row strip from the accessibility tree', () => {
    setMemberships([['p1', 'Project@30']]);
    const { container } = render(<ClimbPlaylistChips climbUuid="c1" />);
    expect(container.querySelector('[data-view]')?.getAttribute('data-a11y-hidden')).toBe('true');
  });
});

describe('PlaylistChipsRow', () => {
  beforeEach(() => {
    ctrl.variant = 'liquidGlass';
    ctrl.playlistsById = new Map();
  });

  it('renders chips from an explicit uuid list, independent of the membership store', () => {
    // The play drawer feeds this from its own per-climb fetch — nothing in the
    // shared store, and no "show playlist tags" setting involved.
    ctrl.membership = new Set();
    ctrl.playlistsById = new Map([['p1', playlist('p1', 'Sunday sends')]]);
    const { container } = render(<PlaylistChipsRow playlistUuids={['p1']} />);
    expect(container.textContent).toContain('Sunday sends');
  });

  it('renders nothing when the uuid list is empty', () => {
    const { container } = render(<PlaylistChipsRow playlistUuids={[]} />);
    expect(container.textContent).toBe('');
  });

  it('drops uuids with no matching playlist', () => {
    ctrl.playlistsById = new Map([['p1', playlist('p1', 'Sunday sends')]]);
    const { container } = render(<PlaylistChipsRow playlistUuids={['p1', 'gone']} />);
    expect(container.textContent).toContain('Sunday sends');
    expect(container.textContent).not.toContain('+1');
  });

  it('keeps its own top margin on a list row and drops it when inline', () => {
    // The list row is the strip's own third line, so it owns the 4pt gap above
    // it. Inline in the play drawer's stats row it must add NO height at all —
    // the board art below is `flex: 1` in a fixed-height screen, so a stray
    // margin here comes straight off the board.
    //
    ctrl.playlistsById = new Map([['p1', playlist('p1', 'Sunday sends')]]);
    const listRow = render(<PlaylistChipsRow playlistUuids={['p1']} />);
    expect(rowStyle(listRow.container)).toContain('"marginTop":4');
    // The inline override is appended to the same style array, so the base row's
    // marginTop:4 is still in the serialized string — only its ABSENCE from the
    // list row's proves the two branches differ.
    expect(rowStyle(listRow.container)).not.toContain('"marginTop":0');
    const inline = render(<PlaylistChipsRow playlistUuids={['p1']} align="inline" />);
    expect(rowStyle(inline.container)).toContain('"marginTop":0');
  });

  it('collapses to "+N" past the caller\'s visible cap', () => {
    // The play drawer passes 1: its chips share a line with the sends/quality/
    // setter stats, so a second full name would ellipsize both to noise.
    ctrl.playlistsById = new Map([
      ['p1', playlist('p1', 'Sunday sends')],
      ['p2', playlist('p2', 'Project@40')],
    ]);
    const two = render(<PlaylistChipsRow playlistUuids={['p1', 'p2']} />);
    expect(two.container.textContent).toContain('Project@40');
    expect(two.container.textContent).not.toContain('+1');

    const capped = render(<PlaylistChipsRow playlistUuids={['p1', 'p2']} maxVisible={1} />);
    expect(capped.container.textContent).toContain('Sunday sends');
    expect(capped.container.textContent).not.toContain('Project@40');
    expect(capped.container.textContent).toContain('+1');
  });

  it('builds an accessibility label from every name, including the ones "+N" hides', () => {
    ctrl.playlistsById = new Map([
      ['p1', playlist('p1', 'Sunday sends')],
      ['p2', playlist('p2', 'Project@40')],
      ['p3', playlist('p3', 'Warmups')],
    ]);
    const { container } = render(
      <PlaylistChipsRow
        playlistUuids={['p1', 'p2', 'p3']}
        describeForAccessibility={(names) => `In playlists: ${names.join(', ')}`}
      />,
    );
    const row = container.querySelector('[data-view]');
    expect(row?.getAttribute('aria-label')).toBe('In playlists: Sunday sends, Project@40, Warmups');
    expect(row?.getAttribute('data-a11y-hidden')).toBe('false');
  });
});
