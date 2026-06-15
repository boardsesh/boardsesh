import { describe, it, expect } from 'vitest';
import {
  BETA_VIDEO_URL_REGEX,
  BETA_VIDEO_URL_VALIDATION_MESSAGE,
  betaLinkIdentity,
  dedupeBetaLinks,
  getInstagramMediaId,
  getTikTokVideoId,
  isBetaVideoUrl,
  isInstagramUrl,
  isTikTokUrl,
  mapBetaLinkRow,
  mapBetaLinksResponse,
  type BetaLink,
  type BetaLinksGqlRow,
} from '../beta-video-url';

const IG_REEL = 'https://www.instagram.com/reel/CAbCdEfGhIj/';
const IG_POST = 'https://instagram.com/p/Xyz123/';
const IG_TV = 'https://www.instagram.com/tv/AbCdE12/';
const TIKTOK_LONG = 'https://www.tiktok.com/@some.user/video/7359000000000000000';
const TIKTOK_SHORT = 'https://vm.tiktok.com/ZShortcode/';

describe('isInstagramUrl', () => {
  it.each([IG_REEL, IG_POST, IG_TV, 'https://instagr.am/reel/abc/'])('accepts %s', (url) => {
    expect(isInstagramUrl(url)).toBe(true);
  });

  it.each(['http://instagram.com/reel/abc/', 'https://example.com/p/xyz', 'https://youtube.com/watch?v=abc', ''])(
    'rejects %s',
    (url) => {
      expect(isInstagramUrl(url)).toBe(false);
    },
  );

  it('preserves anchoring (no prefix slip-through)', () => {
    expect(isInstagramUrl('javascript:alert(1);https://instagram.com/p/abc/')).toBe(false);
  });
});

describe('isTikTokUrl', () => {
  it.each([TIKTOK_LONG, TIKTOK_SHORT, 'https://t.tiktok.com/abc'])('accepts %s', (url) => {
    expect(isTikTokUrl(url)).toBe(true);
  });

  it.each(['http://www.tiktok.com/@some.user/video/7359000000000000000', 'https://example.com/tiktok', ''])(
    'rejects %s',
    (url) => {
      expect(isTikTokUrl(url)).toBe(false);
    },
  );
});

describe('isBetaVideoUrl', () => {
  it('accepts both platforms', () => {
    expect(isBetaVideoUrl(IG_REEL)).toBe(true);
    expect(isBetaVideoUrl(TIKTOK_LONG)).toBe(true);
  });

  it('rejects insecure platform urls', () => {
    expect(isBetaVideoUrl('http://instagram.com/p/abc/')).toBe(false);
    expect(isBetaVideoUrl('http://vm.tiktok.com/ZShortcode/')).toBe(false);
  });

  it('rejects other hosts', () => {
    expect(isBetaVideoUrl('https://youtube.com/watch?v=abc')).toBe(false);
    expect(isBetaVideoUrl('https://kayaclimb.com/route/123')).toBe(false);
  });

  it('rejects empty', () => {
    expect(isBetaVideoUrl('')).toBe(false);
  });
});

describe('BETA_VIDEO_URL_REGEX', () => {
  it('matches Instagram + TikTok', () => {
    expect(BETA_VIDEO_URL_REGEX.test(IG_REEL)).toBe(true);
    expect(BETA_VIDEO_URL_REGEX.test(TIKTOK_LONG)).toBe(true);
  });

  it('keeps a stable validation message exported', () => {
    expect(BETA_VIDEO_URL_VALIDATION_MESSAGE).toMatch(/Instagram.*TikTok|TikTok.*Instagram/i);
  });
});

describe('getInstagramMediaId', () => {
  it('extracts media id from reel url', () => {
    expect(getInstagramMediaId(IG_REEL)).toBe('CAbCdEfGhIj');
  });

  it('extracts media id from post url', () => {
    expect(getInstagramMediaId(IG_POST)).toBe('Xyz123');
  });

  it('extracts media id from tv url', () => {
    expect(getInstagramMediaId(IG_TV)).toBe('AbCdE12');
  });

  it('returns null for non-instagram url', () => {
    expect(getInstagramMediaId(TIKTOK_LONG)).toBeNull();
    expect(getInstagramMediaId('')).toBeNull();
  });
});

describe('getTikTokVideoId', () => {
  it('extracts numeric id from long-form url', () => {
    expect(getTikTokVideoId(TIKTOK_LONG)).toBe('7359000000000000000');
  });

  it('returns null for short links (we do not unfold them)', () => {
    expect(getTikTokVideoId(TIKTOK_SHORT)).toBeNull();
  });

  it('returns null for non-tiktok url', () => {
    expect(getTikTokVideoId(IG_REEL)).toBeNull();
  });
});

describe('betaLinkIdentity', () => {
  it('uses instagram media id for IG urls', () => {
    expect(betaLinkIdentity(IG_REEL)).toBe('instagram:CAbCdEfGhIj');
  });

  it('uses tiktok video id for long-form TikTok urls', () => {
    expect(betaLinkIdentity(TIKTOK_LONG)).toBe('tiktok:7359000000000000000');
  });

  it('falls back to raw url for unknown hosts', () => {
    const url = 'https://example.com/video/abc';
    expect(betaLinkIdentity(url)).toBe(`raw:${url}`);
  });

  it('falls back to raw url for tiktok short links (cannot extract id)', () => {
    expect(betaLinkIdentity(TIKTOK_SHORT)).toBe(`raw:${TIKTOK_SHORT}`);
  });

  it('produces the same identity for two IG urls with different tracking params', () => {
    const a = 'https://www.instagram.com/reel/SameId/';
    const b = 'https://instagram.com/reel/SameId/?utm_source=share';
    expect(betaLinkIdentity(a)).toBe(betaLinkIdentity(b));
  });
});

function makeLink(overrides: Partial<BetaLink> = {}): BetaLink {
  return {
    climb_uuid: 'climb-1',
    link: IG_REEL,
    foreign_username: 'alice',
    angle: 40,
    thumbnail: '/static/beta-link-thumbnails/abc.jpg',
    is_listed: true,
    created_at: '2026-01-01T00:00:00Z',
    tick_uuid: null,
    board_id: null,
    ...overrides,
  };
}

describe('dedupeBetaLinks', () => {
  it('returns the input unchanged when all identities are unique', () => {
    const links = [
      makeLink({ link: IG_REEL }),
      makeLink({ link: TIKTOK_LONG }),
      makeLink({ link: 'https://www.instagram.com/p/Other/' }),
    ];
    const result = dedupeBetaLinks(links);
    expect(result).toHaveLength(3);
    expect(result.map((link) => link.link)).toEqual(links.map((link) => link.link));
  });

  it('collapses duplicates sharing the same identity', () => {
    const a = makeLink({ link: 'https://www.instagram.com/reel/Dup/?utm=a' });
    const b = makeLink({ link: 'https://instagram.com/reel/Dup/?utm=b' });
    const result = dedupeBetaLinks([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0].link).toBe(a.link);
  });

  it('preserves the first occurrence and fills missing metadata from later copies', () => {
    const first = makeLink({
      link: 'https://www.instagram.com/reel/Merge/',
      foreign_username: null,
      angle: null,
      thumbnail: null,
      created_at: '',
    });
    const second = makeLink({
      link: 'https://instagram.com/reel/Merge/?x=1',
      foreign_username: 'bob',
      angle: 30,
      thumbnail: '/static/beta-link-thumbnails/merged.jpg',
      created_at: '2026-02-02T00:00:00Z',
    });
    const result = dedupeBetaLinks([first, second]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      link: first.link,
      foreign_username: 'bob',
      angle: 30,
      thumbnail: '/static/beta-link-thumbnails/merged.jpg',
      created_at: '2026-02-02T00:00:00Z',
    });
  });

  it('preserves the first occurrence when both copies have richer metadata', () => {
    const first = makeLink({ link: 'https://www.instagram.com/reel/Both/', foreign_username: 'first' });
    const second = makeLink({ link: 'https://instagram.com/reel/Both/?x=1', foreign_username: 'second' });
    const result = dedupeBetaLinks([first, second]);
    expect(result[0].foreign_username).toBe('first');
  });

  it('returns an empty array for empty input', () => {
    expect(dedupeBetaLinks([])).toEqual([]);
  });
});

function makeRow(overrides: Partial<BetaLinksGqlRow> = {}): BetaLinksGqlRow {
  return {
    climbUuid: 'climb-1',
    link: IG_REEL,
    foreignUsername: 'alice',
    angle: 40,
    thumbnail: '/static/beta-link-thumbnails/abc.jpg',
    isListed: true,
    createdAt: '2026-01-01T00:00:00Z',
    tickUuid: null,
    boardId: null,
    ...overrides,
  };
}

describe('mapBetaLinkRow', () => {
  it('converts camelCase fields to snake_case', () => {
    const result = mapBetaLinkRow(makeRow());
    expect(result).toEqual({
      climb_uuid: 'climb-1',
      link: IG_REEL,
      foreign_username: 'alice',
      angle: 40,
      thumbnail: '/static/beta-link-thumbnails/abc.jpg',
      is_listed: true,
      created_at: '2026-01-01T00:00:00Z',
      tick_uuid: null,
      board_id: null,
    });
  });

  it('defaults isListed to false when null', () => {
    const result = mapBetaLinkRow(makeRow({ isListed: null }));
    expect(result.is_listed).toBe(false);
  });

  it('defaults createdAt to empty string when null', () => {
    const result = mapBetaLinkRow(makeRow({ createdAt: null }));
    expect(result.created_at).toBe('');
  });

  it('applies the absolutizeThumbnail resolver when provided', () => {
    const result = mapBetaLinkRow(makeRow({ thumbnail: '/static/foo.jpg' }), (thumbnail) =>
      thumbnail ? `https://cdn.example.com${thumbnail}` : null,
    );
    expect(result.thumbnail).toBe('https://cdn.example.com/static/foo.jpg');
  });

  it('passes null thumbnail through the resolver', () => {
    const seen: (string | null)[] = [];
    mapBetaLinkRow(makeRow({ thumbnail: null }), (thumbnail) => {
      seen.push(thumbnail);
      return thumbnail;
    });
    expect(seen).toEqual([null]);
  });

  it('uses identity thumbnail resolver when none provided', () => {
    const result = mapBetaLinkRow(makeRow({ thumbnail: '/static/foo.jpg' }));
    expect(result.thumbnail).toBe('/static/foo.jpg');
  });
});

describe('mapBetaLinksResponse', () => {
  it('maps an array of rows preserving order', () => {
    const rows = [makeRow({ link: IG_REEL }), makeRow({ link: TIKTOK_LONG })];
    const result = mapBetaLinksResponse(rows);
    expect(result.map((link) => link.link)).toEqual([IG_REEL, TIKTOK_LONG]);
  });

  it('threads the absolutize resolver through every row', () => {
    const rows = [makeRow({ thumbnail: '/static/a.jpg' }), makeRow({ thumbnail: '/static/b.jpg' })];
    const result = mapBetaLinksResponse(rows, (thumbnail) =>
      thumbnail ? `https://cdn.example.com${thumbnail}` : null,
    );
    expect(result.map((link) => link.thumbnail)).toEqual([
      'https://cdn.example.com/static/a.jpg',
      'https://cdn.example.com/static/b.jpg',
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(mapBetaLinksResponse([])).toEqual([]);
  });
});
