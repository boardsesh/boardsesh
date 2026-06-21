import { describe, expect, it } from 'vite-plus/test';
import { getInstagramMediaId, isInstagramUrl } from '@boardsesh/shared-schema';
import type { BetaLink } from '@/app/lib/api-wrappers/sync-api-types';
import { dedupeBetaLinks } from '../beta-video-url';

function makeBetaLink(overrides: Partial<BetaLink>): BetaLink {
  return {
    climb_uuid: 'climb-1',
    link: 'https://www.instagram.com/reel/ABC123xyz/',
    foreign_username: null,
    angle: null,
    thumbnail: null,
    is_listed: true,
    created_at: '2026-04-16T00:00:00.000Z',
    tick_uuid: null,
    board_id: null,
    ...overrides,
  };
}

describe('instagram-url', () => {
  it('extracts the Instagram media id from post and reel links', () => {
    expect(getInstagramMediaId('https://www.instagram.com/reel/DJ5Cw5OIS82/')).toBe('DJ5Cw5OIS82');
    expect(getInstagramMediaId('https://www.instagram.com/p/DEdQNTzScjp/?img_index=1')).toBe('DEdQNTzScjp');
  });

  describe('isInstagramUrl', () => {
    it('accepts valid Instagram post and reel URLs', () => {
      expect(isInstagramUrl('https://www.instagram.com/reel/DJ5Cw5OIS82/')).toBe(true);
      expect(isInstagramUrl('https://www.instagram.com/p/DEdQNTzScjp/')).toBe(true);
      expect(isInstagramUrl('https://instagram.com/reel/DJ5Cw5OIS82/')).toBe(true);
      expect(isInstagramUrl('https://instagr.am/p/DEdQNTzScjp/')).toBe(true);
      expect(isInstagramUrl('https://www.instagram.com/p/DEdQNTzScjp/?img_index=1')).toBe(true);
      expect(isInstagramUrl('HTTPS://WWW.INSTAGRAM.COM/reel/DJ5Cw5OIS82/')).toBe(true);
    });

    it('rejects URLs with extra path segments after the media ID', () => {
      expect(isInstagramUrl('https://instagram.com/reel/ABC/extra-garbage')).toBe(false);
      expect(isInstagramUrl('https://www.instagram.com/p/ABC/comments')).toBe(false);
    });

    it('rejects URLs that contain instagram.com as a path or query parameter', () => {
      expect(isInstagramUrl('https://evil.com?ref=instagram.com/reel/ABC')).toBe(false);
      expect(isInstagramUrl('https://evil.com/redirect?url=https://instagram.com/p/ABC')).toBe(false);
      expect(isInstagramUrl('https://notinstagram.com/reel/ABC')).toBe(false);
    });

    it('rejects non-URL strings', () => {
      expect(isInstagramUrl('instagram.com/reel/ABC')).toBe(false);
      expect(isInstagramUrl('just some text')).toBe(false);
      expect(isInstagramUrl('')).toBe(false);
    });
  });

  it('dedupes beta links that point to the same Instagram media and preserves richer metadata', () => {
    const deduped = dedupeBetaLinks([
      makeBetaLink({
        link: 'https://www.instagram.com/reel/DJ5Cw5OIS82/',
        foreign_username: null,
        angle: null,
        thumbnail: null,
      }),
      makeBetaLink({
        link: 'https://www.instagram.com/p/DJ5Cw5OIS82/?img_index=1',
        foreign_username: 'climber',
        angle: 35,
        thumbnail: 'https://cdn.example.com/thumb.jpg',
      }),
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.foreign_username).toBe('climber');
    expect(deduped[0]?.angle).toBe(35);
    expect(deduped[0]?.thumbnail).toBe('https://cdn.example.com/thumb.jpg');
  });

  it('keeps first entry metadata when both entries are equally populated', () => {
    const deduped = dedupeBetaLinks([
      makeBetaLink({
        link: 'https://www.instagram.com/reel/DJ5Cw5OIS82/',
        foreign_username: 'first_climber',
        angle: 30,
      }),
      makeBetaLink({
        link: 'https://www.instagram.com/p/DJ5Cw5OIS82/',
        foreign_username: 'second_climber',
        angle: 40,
      }),
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.foreign_username).toBe('first_climber');
    expect(deduped[0]?.angle).toBe(30);
  });

  it('keeps distinct Instagram media as separate videos', () => {
    const deduped = dedupeBetaLinks([
      makeBetaLink({ link: 'https://www.instagram.com/reel/FIRST123/' }),
      makeBetaLink({ link: 'https://www.instagram.com/reel/SECOND456/' }),
    ]);

    expect(deduped).toHaveLength(2);
  });

  it('dedupes TikTok links that point to the same video by numeric id', () => {
    const deduped = dedupeBetaLinks([
      makeBetaLink({
        link: 'https://www.tiktok.com/@climber/video/123456789',
        foreign_username: null,
      }),
      makeBetaLink({
        link: 'https://tiktok.com/@climber/video/123456789?utm=share',
        foreign_username: 'climber',
        thumbnail: 'https://cdn.example.com/tt.jpg',
      }),
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.foreign_username).toBe('climber');
    expect(deduped[0]?.thumbnail).toBe('https://cdn.example.com/tt.jpg');
  });

  it('keeps Instagram and TikTok links as separate videos', () => {
    const deduped = dedupeBetaLinks([
      makeBetaLink({ link: 'https://www.instagram.com/reel/ABC/' }),
      makeBetaLink({ link: 'https://www.tiktok.com/@a/video/1' }),
    ]);

    expect(deduped).toHaveLength(2);
  });
});
