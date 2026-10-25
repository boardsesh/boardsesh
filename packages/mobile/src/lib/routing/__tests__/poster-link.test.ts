import { describe, expect, it } from 'vitest';
import { WEB_BASE_URL } from '../../env';
import { posterPageUrlFromRoute } from '../poster-link';

const WALL_UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('posterPageUrlFromRoute', () => {
  it('rebuilds a board poster link on www', () => {
    expect(posterPageUrlFromRoute({ rest: ['b', 'the-garage'] })).toBe(`${WEB_BASE_URL}/poster/b/the-garage`);
  });

  it("keeps an unlisted wall's capability and the layout choice", () => {
    expect(posterPageUrlFromRoute({ rest: ['b', 'the-garage'], wall: WALL_UUID, layout: 'photo' })).toBe(
      `${WEB_BASE_URL}/poster/b/the-garage?wall=${WALL_UUID}&layout=photo`,
    );
  });

  it('encodes what the router decoded', () => {
    expect(posterPageUrlFromRoute({ rest: ['b', 'marco/spray wall'], note: 'a&b=c' })).toBe(
      `${WEB_BASE_URL}/poster/b/marco%2Fspray%20wall?note=a%26b%3Dc`,
    );
  });

  it('keeps a repeated param as two', () => {
    expect(posterPageUrlFromRoute({ rest: ['b', 'x'], layout: ['photo', 'plain'] })).toBe(
      `${WEB_BASE_URL}/poster/b/x?layout=photo&layout=plain`,
    );
  });

  it('accepts a single segment as a string, and drops empty and dot segments', () => {
    expect(posterPageUrlFromRoute({ rest: 'b' })).toBe(`${WEB_BASE_URL}/poster/b`);
    expect(posterPageUrlFromRoute({ rest: ['..', 'b', '', '.', 'x'] })).toBe(`${WEB_BASE_URL}/poster/b/x`);
    expect(posterPageUrlFromRoute({})).toBe(`${WEB_BASE_URL}/poster`);
  });
});
