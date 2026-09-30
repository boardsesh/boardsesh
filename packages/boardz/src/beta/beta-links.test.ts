import { describe, expect, it } from 'vitest';
import type { BetaLinksGqlRow } from '@boardsesh/shared-schema';
import { betaForClimb, thumbnailUrl } from './beta-links';

const ORIGIN = 'https://ws.boardsesh.com';

function row(overrides: Partial<BetaLinksGqlRow>): BetaLinksGqlRow {
  return {
    climbUuid: 'climb-1',
    link: 'https://www.instagram.com/p/AAA/',
    foreignUsername: 'luca.boulders',
    angle: null,
    thumbnail: '/static/beta-link-thumbnails/instagram/AAA.jpg',
    isListed: true,
    createdAt: '2026-09-07T04:22:08.485Z',
    tickUuid: null,
    boardId: null,
    ...overrides,
  };
}

describe('thumbnailUrl', () => {
  it('puts backend paths on the backend and asks for a card-sized image', () => {
    expect(thumbnailUrl('/static/beta-link-thumbnails/instagram/AAA.jpg', ORIGIN)).toBe(
      'https://ws.boardsesh.com/static/beta-link-thumbnails/instagram/AAA.jpg?size=280',
    );
  });

  it('leaves absolute URLs and missing thumbnails alone', () => {
    expect(thumbnailUrl('https://cdn.example.com/a.jpg', ORIGIN)).toBe('https://cdn.example.com/a.jpg');
    expect(thumbnailUrl(null, ORIGIN)).toBeNull();
  });
});

describe('betaForClimb', () => {
  it('shows listed videos once each, filmed at your angle first', () => {
    const videos = betaForClimb(
      [
        row({ link: 'https://www.instagram.com/p/AAA/', angle: 25 }),
        row({ link: 'https://www.instagram.com/p/BBB/', angle: null }),
        row({ link: 'https://www.instagram.com/p/CCC/', angle: 40 }),
        // The same video again, with tracking parameters.
        row({ link: 'https://www.instagram.com/p/CCC/?igsh=xyz', angle: 40 }),
        row({ link: 'https://www.instagram.com/p/DDD/', isListed: false }),
        row({ link: 'https://example.com/not-a-video' }),
      ],
      40,
      ORIGIN,
    );
    expect(videos.map((video) => video.link)).toEqual([
      'https://www.instagram.com/p/CCC/',
      'https://www.instagram.com/p/BBB/',
      'https://www.instagram.com/p/AAA/',
    ]);
    expect(videos[0].thumbnail).toMatch(/^https:\/\/ws\.boardsesh\.com\/static\/.*\?size=280$/);
  });
});
