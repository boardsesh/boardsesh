import { describe, it, expect, vi } from 'vitest';

// Mock the env module before importing the SUT so we can pin BACKEND_URL.
vi.mock('../env', () => ({
  BACKEND_URL: 'https://ws.boardsesh.test',
  WEB_BASE_URL: 'https://www.boardsesh.test',
}));

import { absolutizeThumbnail, mapBetaLink, mapBetaLinks } from '../beta-video-url';
import type { BetaLinksGqlRow } from '@boardsesh/shared-schema';

const IG_REEL = 'https://www.instagram.com/reel/CAbCdEfGhIj/';
const TIKTOK_LONG = 'https://www.tiktok.com/@some.user/video/7359000000000000000';

function makeRow(overrides: Partial<BetaLinksGqlRow> = {}): BetaLinksGqlRow {
  return {
    climbUuid: 'climb-1',
    link: IG_REEL,
    foreignUsername: 'alice',
    angle: 40,
    thumbnail: '/static/beta-link-thumbnails/abc.jpg',
    isListed: true,
    createdAt: '2026-01-01T00:00:00Z',
    attachedByUser: null,
    ...overrides,
  };
}

describe('absolutizeThumbnail (mobile)', () => {
  it('prepends BACKEND_URL and requests a sized variant for a backend-relative thumbnail path', () => {
    expect(absolutizeThumbnail('/static/beta-link-thumbnails/abc.jpg')).toBe(
      'https://ws.boardsesh.test/static/beta-link-thumbnails/abc.jpg?size=280',
    );
  });

  it('returns null for null input', () => {
    expect(absolutizeThumbnail(null)).toBeNull();
  });

  it('returns empty string unchanged', () => {
    // Falsy short-circuits before the path branch; preserves the original value.
    expect(absolutizeThumbnail('')).toBe('');
  });

  it('passes through already-absolute https urls', () => {
    expect(absolutizeThumbnail('https://cdn.example.com/foo.jpg')).toBe('https://cdn.example.com/foo.jpg');
  });

  it('passes through already-absolute http urls', () => {
    expect(absolutizeThumbnail('http://cdn.example.com/foo.jpg')).toBe('http://cdn.example.com/foo.jpg');
  });

  it('treats paths without a leading slash as already-absolute (pass through)', () => {
    expect(absolutizeThumbnail('static/abc.jpg')).toBe('static/abc.jpg');
  });
});

describe('mapBetaLink (mobile)', () => {
  it('converts the row to snake_case and absolutizes the thumbnail path', () => {
    const result = mapBetaLink(makeRow({ thumbnail: '/static/abc.jpg' }));
    expect(result).toEqual({
      climb_uuid: 'climb-1',
      link: IG_REEL,
      foreign_username: 'alice',
      angle: 40,
      thumbnail: 'https://ws.boardsesh.test/static/abc.jpg?size=280',
      is_listed: true,
      created_at: '2026-01-01T00:00:00Z',
      attached_by_user: null,
    });
  });

  it('leaves a null thumbnail null', () => {
    expect(mapBetaLink(makeRow({ thumbnail: null })).thumbnail).toBeNull();
  });

  it('defaults null isListed to false', () => {
    expect(mapBetaLink(makeRow({ isListed: null })).is_listed).toBe(false);
  });
});

describe('mapBetaLinks (mobile)', () => {
  it('maps every row and preserves order', () => {
    const rows = [makeRow({ link: IG_REEL }), makeRow({ link: TIKTOK_LONG })];
    const result = mapBetaLinks(rows);
    expect(result.map((link) => link.link)).toEqual([IG_REEL, TIKTOK_LONG]);
  });

  it('returns an empty array for empty input', () => {
    expect(mapBetaLinks([])).toEqual([]);
  });
});

// Trailing-slash normalisation is checked in its own block at the END of the
// file because it has to mutate the module registry to swap in a different
// BACKEND_URL. Keeping it isolated stops it from leaking state into earlier
// tests if anyone later reorders the file.
describe('absolutizeThumbnail trailing-slash normalisation', () => {
  it('strips a trailing slash from BACKEND_URL before joining the path', async () => {
    vi.resetModules();
    vi.doMock('../env', () => ({
      BACKEND_URL: 'https://ws.boardsesh.test/',
      WEB_BASE_URL: 'https://www.boardsesh.test',
    }));
    const reloaded = await import('../beta-video-url');
    expect(reloaded.absolutizeThumbnail('/static/abc.jpg')).toBe('https://ws.boardsesh.test/static/abc.jpg?size=280');
  });
});
