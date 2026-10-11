import { describe, it, expect } from 'vitest';
import {
  buildCommunityPlaylistsInput,
  clearCommunityPlaylistFilters,
  effectiveCommunityCreatorScope,
  hasActiveCommunityPlaylistFilters,
  COMMUNITY_PLAYLIST_MAX_CLIMBS,
  COMMUNITY_PLAYLIST_SEARCH_MAX_LENGTH,
  DEFAULT_COMMUNITY_PLAYLIST_FILTERS,
  type CommunityPlaylistFilters,
} from '../community-playlist-filters';

const VIEWER = 'user-1';
const BOARD = { boardType: 'kilter', layoutId: 8 };

function filtersWith(overrides: Partial<CommunityPlaylistFilters>): CommunityPlaylistFilters {
  return { ...DEFAULT_COMMUNITY_PLAYLIST_FILTERS, ...overrides };
}

describe('buildCommunityPlaylistsInput', () => {
  it('maps the defaults to a popular, climber-made list without the viewer', () => {
    expect(buildCommunityPlaylistsInput(DEFAULT_COMMUNITY_PLAYLIST_FILTERS, { viewerId: VIEWER, ...BOARD })).toEqual({
      boardType: 'kilter',
      layoutId: 8,
      generatedRecommendation: false,
      sortBy: 'popular',
      excludeCreatorIds: [VIEWER],
      maxClimbs: COMMUNITY_PLAYLIST_MAX_CLIMBS,
    });
  });

  it('sends no creator filter for a signed-out viewer', () => {
    const input = buildCommunityPlaylistsInput(DEFAULT_COMMUNITY_PLAYLIST_FILTERS, { viewerId: null });
    expect(input).toEqual({
      generatedRecommendation: false,
      sortBy: 'popular',
      maxClimbs: COMMUNITY_PLAYLIST_MAX_CLIMBS,
    });
  });

  it('asks the server for followed creators for "following", with no client-side id list', () => {
    const input = buildCommunityPlaylistsInput(filtersWith({ creator: 'following' }), { viewerId: VIEWER });
    expect(input.followedOnly).toBe(true);
    expect(input.creatorIds).toBeUndefined();
    expect(input.excludeCreatorIds).toBeUndefined();
  });

  it('falls back to everyone when "following" is picked but nobody is signed in', () => {
    const input = buildCommunityPlaylistsInput(filtersWith({ creator: 'following' }), { viewerId: null });
    expect(input).not.toHaveProperty('followedOnly');
  });

  it('maps the grade range to minGrade / maxGrade, sending only the bounds that are set', () => {
    expect(buildCommunityPlaylistsInput(filtersWith({ minGrade: 16, maxGrade: 20 }), { viewerId: null })).toMatchObject(
      { minGrade: 16, maxGrade: 20 },
    );
    const floorOnly = buildCommunityPlaylistsInput(filtersWith({ minGrade: 22 }), { viewerId: null });
    expect(floorOnly.minGrade).toBe(22);
    expect(floorOnly).not.toHaveProperty('maxGrade');
    const unset = buildCommunityPlaylistsInput(DEFAULT_COMMUNITY_PLAYLIST_FILTERS, { viewerId: null });
    expect(unset).not.toHaveProperty('minGrade');
    expect(unset).not.toHaveProperty('maxGrade');
  });

  it('scopes to the viewer for "mine"', () => {
    const input = buildCommunityPlaylistsInput(filtersWith({ creator: 'mine' }), { viewerId: VIEWER });
    expect(input.creatorIds).toEqual([VIEWER]);
    expect(input.excludeCreatorIds).toBeUndefined();
  });

  it('falls back to everyone when "mine" is picked but nobody is signed in', () => {
    const input = buildCommunityPlaylistsInput(filtersWith({ creator: 'mine' }), { viewerId: null });
    expect(input.creatorIds).toBeUndefined();
    expect(input.excludeCreatorIds).toBeUndefined();
  });

  it('maps the sort straight through', () => {
    expect(buildCommunityPlaylistsInput(filtersWith({ sort: 'recent' }), { viewerId: null }).sortBy).toBe('recent');
  });

  it('trims the search, drops it when blank, and caps it at the server limit', () => {
    expect(buildCommunityPlaylistsInput(filtersWith({ search: '  crimps ' }), { viewerId: null }).name).toBe('crimps');
    expect(buildCommunityPlaylistsInput(filtersWith({ search: '   ' }), { viewerId: null })).not.toHaveProperty('name');
    const long = 'a'.repeat(COMMUNITY_PLAYLIST_SEARCH_MAX_LENGTH + 20);
    expect(buildCommunityPlaylistsInput(filtersWith({ search: long }), { viewerId: null }).name).toHaveLength(
      COMMUNITY_PLAYLIST_SEARCH_MAX_LENGTH,
    );
  });

  it.each([
    ['any', undefined, 150],
    ['short', undefined, 10],
    ['session', 11, 30],
    ['big', 31, 150],
  ] as const)('maps size %s to minClimbs %s / maxClimbs %s', (size, minClimbs, maxClimbs) => {
    const input = buildCommunityPlaylistsInput(filtersWith({ size }), { viewerId: null });
    expect(input.minClimbs).toBe(minClimbs);
    expect(input.maxClimbs).toBe(maxClimbs);
    if (minClimbs === undefined) expect(input).not.toHaveProperty('minClimbs');
    if (maxClimbs === undefined) expect(input).not.toHaveProperty('maxClimbs');
  });

  it('leaves out board fields the context does not carry', () => {
    const input = buildCommunityPlaylistsInput(DEFAULT_COMMUNITY_PLAYLIST_FILTERS, { viewerId: null });
    expect(input).not.toHaveProperty('boardType');
    expect(input).not.toHaveProperty('layoutId');
  });
});

describe('effectiveCommunityCreatorScope', () => {
  it('keeps "mine" and "following" only with a viewer', () => {
    expect(effectiveCommunityCreatorScope(filtersWith({ creator: 'mine' }), { viewerId: VIEWER })).toBe('mine');
    expect(effectiveCommunityCreatorScope(filtersWith({ creator: 'mine' }), { viewerId: null })).toBe('everyone');
    expect(effectiveCommunityCreatorScope(filtersWith({ creator: 'following' }), { viewerId: VIEWER })).toBe(
      'following',
    );
    expect(effectiveCommunityCreatorScope(filtersWith({ creator: 'following' }), { viewerId: null })).toBe('everyone');
  });

  it('caps every size band at the community maximum', () => {
    expect(COMMUNITY_PLAYLIST_MAX_CLIMBS).toBe(150);
  });
});

describe('hasActiveCommunityPlaylistFilters / clearCommunityPlaylistFilters', () => {
  it('is false for the defaults and for a sort change alone', () => {
    expect(hasActiveCommunityPlaylistFilters(DEFAULT_COMMUNITY_PLAYLIST_FILTERS)).toBe(false);
    expect(hasActiveCommunityPlaylistFilters(filtersWith({ sort: 'recent' }))).toBe(false);
    expect(hasActiveCommunityPlaylistFilters(filtersWith({ search: '  ' }))).toBe(false);
  });

  it('is true for a search, a creator scope, a size band, or either grade bound', () => {
    expect(hasActiveCommunityPlaylistFilters(filtersWith({ search: 'crimps' }))).toBe(true);
    expect(hasActiveCommunityPlaylistFilters(filtersWith({ creator: 'mine' }))).toBe(true);
    expect(hasActiveCommunityPlaylistFilters(filtersWith({ creator: 'following' }))).toBe(true);
    expect(hasActiveCommunityPlaylistFilters(filtersWith({ size: 'big' }))).toBe(true);
    expect(hasActiveCommunityPlaylistFilters(filtersWith({ minGrade: 16 }))).toBe(true);
    expect(hasActiveCommunityPlaylistFilters(filtersWith({ maxGrade: 20 }))).toBe(true);
  });

  it('clears everything that narrows the list but keeps the sort', () => {
    const cleared = clearCommunityPlaylistFilters({
      search: 'crimps',
      creator: 'following',
      sort: 'recent',
      size: 'short',
      minGrade: 16,
      maxGrade: 20,
    });
    expect(cleared).toEqual({ ...DEFAULT_COMMUNITY_PLAYLIST_FILTERS, sort: 'recent' });
    expect(hasActiveCommunityPlaylistFilters(cleared)).toBe(false);
  });
});
