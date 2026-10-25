import { describe, expect, it } from 'vitest';
import { WEB_BASE_URL } from '../../env';
import { posterPageUrlFromRoute } from '../poster-link';

const WALL_UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('posterPageUrlFromRoute', () => {
  it('rebuilds a board poster link on www', () => {
    expect(posterPageUrlFromRoute({ rest: ['b', 'the-garage'] })).toBe(`${WEB_BASE_URL}/poster/b/the-garage`);
  });

  it("keeps an unlisted wall's capability and the layout choice", () => {
    expect(posterPageUrlFromRoute({ rest: ['b', 'the-garage'], layout: 'photo', wall: WALL_UUID })).toBe(
      `${WEB_BASE_URL}/poster/b/the-garage?wall=${WALL_UUID}&layout=photo`,
    );
  });

  it.each(['photo', 'plain', 'cards'])('keeps the %s layout', (layout) => {
    expect(posterPageUrlFromRoute({ rest: ['b', 'x'], layout })).toBe(`${WEB_BASE_URL}/poster/b/x?layout=${layout}`);
  });

  it('writes an upper-case wall uuid in lower case', () => {
    expect(posterPageUrlFromRoute({ rest: ['b', 'x'], wall: WALL_UUID.toUpperCase() })).toBe(
      `${WEB_BASE_URL}/poster/b/x?wall=${WALL_UUID}`,
    );
  });

  // Only the two params the page reads, in their known shapes.
  it.each([
    ['any other param', { utm_source: 'mail', invite: 'Ab3_dE-fGhIjKlMnOpQrSt', src: 'qr' }],
    ['a wall that is not a uuid', { wall: '../../auth/login' }],
    ['an unknown layout', { layout: 'giant' }],
    ['a repeated wall', { wall: [WALL_UUID, WALL_UUID] }],
    ['a repeated layout', { layout: ['photo', 'plain'] }],
  ])('drops %s', (_label, query) => {
    expect(posterPageUrlFromRoute({ rest: ['b', 'x'], ...query })).toBe(`${WEB_BASE_URL}/poster/b/x`);
  });

  it('encodes the segments the router decoded', () => {
    expect(posterPageUrlFromRoute({ rest: ['b', 'marco/spray wall'] })).toBe(
      `${WEB_BASE_URL}/poster/b/marco%2Fspray%20wall`,
    );
  });

  it('accepts a single segment as a string, and drops empty and dot segments', () => {
    expect(posterPageUrlFromRoute({ rest: 'b' })).toBe(`${WEB_BASE_URL}/poster/b`);
    expect(posterPageUrlFromRoute({ rest: ['..', 'b', '', '.', 'x'] })).toBe(`${WEB_BASE_URL}/poster/b/x`);
    expect(posterPageUrlFromRoute({})).toBe(`${WEB_BASE_URL}/poster`);
  });
});
