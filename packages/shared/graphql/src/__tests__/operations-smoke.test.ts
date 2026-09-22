import { describe, it, expect, vi } from 'vitest';
import { parse } from 'graphql';
import { fetchAllPublicSupporters, PUBLIC_SUPPORTERS_PAGE_SIZE, type PublicSupporter } from '../operations/support';

// Smoke tests over the hand-written operation strings. The dedicated
// schema-validation suite at packages/backend/src/__tests__/operations-schema-validation.test.ts
// already validates queue-session operations against the live schema; here we
// just parse-check every per-feature file so a syntax error in a `gql` literal
// fails CI before it ever reaches the codegen step or a runtime fetch.
//
// Add new operation modules to the table below as they land.

const operationModules: Array<{ name: string; load: () => Promise<Record<string, unknown>> }> = [
  { name: 'account', load: () => import('../operations/account') },
  { name: 'activity-feed', load: () => import('../operations/activity-feed') },
  { name: 'beta-links', load: () => import('../operations/beta-links') },
  { name: 'boards', load: () => import('../operations/boards') },
  { name: 'climb-search', load: () => import('../operations/climb-search') },
  { name: 'climb-stats-history', load: () => import('../operations/climb-stats-history') },
  { name: 'climb-stats-for-angles', load: () => import('../operations/climb-stats-for-angles') },
  { name: 'comments-votes', load: () => import('../operations/comments-votes') },
  { name: 'create-session', load: () => import('../operations/create-session') },
  { name: 'favorites', load: () => import('../operations/favorites') },
  { name: 'feedback', load: () => import('../operations/feedback') },
  { name: 'gyms', load: () => import('../operations/gyms') },
  { name: 'live-sessions', load: () => import('../operations/live-sessions') },
  { name: 'new-climb-feed', load: () => import('../operations/new-climb-feed') },
  { name: 'notifications', load: () => import('../operations/notifications') },
  { name: 'playlists', load: () => import('../operations/playlists') },
  { name: 'proposals', load: () => import('../operations/proposals') },
  { name: 'qa', load: () => import('../operations/qa') },
  { name: 'queue-session', load: () => import('../operations/queue-session') },
  { name: 'sessions', load: () => import('../operations/sessions') },
  { name: 'social', load: () => import('../operations/social') },
  { name: 'support', load: () => import('../operations/support') },
  { name: 'ticks', load: () => import('../operations/ticks') },
];

function looksLikeOperationString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /\b(query|mutation|subscription)\b/.test(value);
}

describe('every operation string is valid GraphQL', () => {
  it.each(operationModules)('$name parses', async ({ load }) => {
    const mod = await load();
    const operationStrings = Object.values(mod).filter(looksLikeOperationString);
    expect(operationStrings.length).toBeGreaterThan(0);
    for (const operation of operationStrings) {
      // parse() throws on syntax errors; capturing the document name in the
      // failure message would require regex juggling, so let parse() report.
      expect(() => parse(operation)).not.toThrow();
    }
  });
});

describe('supporter pagination', () => {
  it('requests every page without dropping supporters', async () => {
    const supporters = Array.from({ length: PUBLIC_SUPPORTERS_PAGE_SIZE + 1 }, (_, index): PublicSupporter => ({
      userId: `user-${index}`,
      displayName: `Supporter ${index}`,
      supportedAt: new Date(index).toISOString(),
    }));
    const requestPage = vi.fn(async ({ limit, offset }: { limit: number; offset: number }) => ({
      publicSupporters: supporters.slice(offset, offset + limit),
    }));

    await expect(fetchAllPublicSupporters(requestPage)).resolves.toEqual(supporters);
    expect(requestPage).toHaveBeenNthCalledWith(1, { limit: PUBLIC_SUPPORTERS_PAGE_SIZE, offset: 0 });
    expect(requestPage).toHaveBeenNthCalledWith(2, {
      limit: PUBLIC_SUPPORTERS_PAGE_SIZE,
      offset: PUBLIC_SUPPORTERS_PAGE_SIZE,
    });
  });
});

describe('beta-links operations export the expected names', () => {
  it('exposes GET_BETA_LINKS, GET_RECENT_BETA_LINKS, GET_USER_BETA_LINKS, ATTACH_BETA_LINK', async () => {
    const mod = await import('../operations/beta-links');
    expect(mod).toHaveProperty('GET_BETA_LINKS');
    expect(mod).toHaveProperty('GET_RECENT_BETA_LINKS');
    expect(mod).toHaveProperty('GET_USER_BETA_LINKS');
    expect(mod).toHaveProperty('ATTACH_BETA_LINK');
  });
});

describe('activity-feed operations export the expected names', () => {
  it('exposes GET_ACTIVITY_FEED and GET_SESSION_GROUPED_FEED', async () => {
    const mod = await import('../operations/activity-feed');
    expect(mod).toHaveProperty('GET_ACTIVITY_FEED');
    expect(mod).toHaveProperty('GET_SESSION_GROUPED_FEED');
  });
});

describe('live-sessions operations export the expected names', () => {
  it('exposes FOLLOWED_LIVE_SESSIONS and BOARD_LIVE_SESSIONS', async () => {
    const mod = await import('../operations/live-sessions');
    expect(mod).toHaveProperty('FOLLOWED_LIVE_SESSIONS');
    expect(mod).toHaveProperty('BOARD_LIVE_SESSIONS');
  });
});
