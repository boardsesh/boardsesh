import { describe, expect, it } from 'vitest';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { isBoardLinkPath, parseBoardLinkPath } from '../board-deep-link';
import { MAX_RETURN_HREF_LENGTH } from '../read-only-routes';

const CLIMB_PATH = '/kilter/1/7/1,20/40/view/the-proj-a1b2c3d4';
const WALL_UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('parseBoardLinkPath', () => {
  it('reads the climb a shared link points at', () => {
    expect(parseBoardLinkPath(`https://www.boardsesh.com${CLIMB_PATH}`)).toBe(CLIMB_PATH);
  });

  it.each(SUPPORTED_BOARDS)('accepts a %s climb link', (boardName) => {
    const path = `/${boardName}/1/7/1,20/40/view/the-proj-a1b2c3d4`;
    expect(parseBoardLinkPath(`https://www.boardsesh.com${path}`)).toBe(path);
  });

  it.each([
    ['the apex host', `https://boardsesh.com${CLIMB_PATH}`],
    ['the app scheme', `com.boardsesh.app://${CLIMB_PATH.slice(1)}`],
    ['the app scheme with an empty host', `com.boardsesh.app://${CLIMB_PATH}`],
    ['an upper-case host', `HTTPS://WWW.BOARDSESH.COM${CLIMB_PATH}`],
    ['a trailing slash', `https://www.boardsesh.com${CLIMB_PATH}/`],
    ['a fragment', `https://www.boardsesh.com${CLIMB_PATH}#beta`],
  ])('reads the same climb from %s', (_label, url) => {
    expect(parseBoardLinkPath(url)).toBe(CLIMB_PATH);
  });

  it.each(['es', 'fr', 'de'])('drops the /%s locale prefix the app has no route for', (locale) => {
    expect(parseBoardLinkPath(`https://www.boardsesh.com/${locale}${CLIMB_PATH}`)).toBe(CLIMB_PATH);
  });

  it.each([
    '/kilter/1/7/1,20/40/list',
    '/kilter/1/7/1,20/-15/play/the-proj-a1b2c3d4',
    '/b/the-garage',
    '/b/the-garage/40/list',
    '/b/the-garage/40/view/the-proj-a1b2c3d4',
    '/b/the-garage/40/play/the-proj-a1b2c3d4',
  ])('accepts the board route %s', (path) => {
    expect(parseBoardLinkPath(`https://www.boardsesh.com${path}`)).toBe(path);
  });

  it('keeps the wall an unlisted spray-wall link names', () => {
    expect(parseBoardLinkPath(`https://www.boardsesh.com/b/the-garage/40/list?wall=${WALL_UUID}`)).toBe(
      `/b/the-garage/40/list?wall=${WALL_UUID}`,
    );
  });

  it("keeps a home board share link's token, so the join survives sign-in", () => {
    const token = 'Ab3_dE-fGhIjKlMnOpQrSt';
    expect(parseBoardLinkPath(`https://www.boardsesh.com/b/the-garage?invite=${token}`)).toBe(
      `/b/the-garage?invite=${token}`,
    );
    expect(parseBoardLinkPath(`com.boardsesh.app://b/the-garage?utm_source=chat&invite=${token}`)).toBe(
      `/b/the-garage?invite=${token}`,
    );
    expect(isBoardLinkPath(`/b/the-garage?invite=${token}`)).toBe(true);
  });

  it('drops an invite that is not shaped like a share-link token', () => {
    for (const invite of ['short', 'Ab3_dE-fGhIjKlMnOpQrSt0', '../../auth/login', 'Ab3_dE-fGhIjKlMnOpQr%2F']) {
      expect(parseBoardLinkPath(`https://www.boardsesh.com/b/the-garage?invite=${invite}`)).toBe('/b/the-garage');
    }
  });

  it('drops every other query param, and a wall that is not a uuid', () => {
    expect(
      parseBoardLinkPath(`https://www.boardsesh.com${CLIMB_PATH}?utm_source=reddit&next=https://evil.example`),
    ).toBe(CLIMB_PATH);
    expect(parseBoardLinkPath('https://www.boardsesh.com/b/the-garage?wall=../../auth/login')).toBe('/b/the-garage');
    expect(parseBoardLinkPath(`https://www.boardsesh.com/b/the-garage?wall=${WALL_UUID}&x=1`)).toBe(
      `/b/the-garage?wall=${WALL_UUID}`,
    );
  });

  // #4415: a signed-out scanner's poster link is replayed after sign-in, and
  // the scan is counted then. Only a pair the strict parser accepts survives.
  it.each(['board', 'kiosk'])('keeps a printed code’s src=qr&medium=%s pair', (medium) => {
    expect(parseBoardLinkPath(`https://www.boardsesh.com/b/the-garage?src=qr&medium=${medium}`)).toBe(
      `/b/the-garage?src=qr&medium=${medium}`,
    );
  });

  it("keeps an unlisted wall's poster link whole, in canonical order", () => {
    expect(parseBoardLinkPath(`https://www.boardsesh.com/b/the-garage?wall=${WALL_UUID}&src=qr&medium=board`)).toBe(
      `/b/the-garage?wall=${WALL_UUID}&src=qr&medium=board`,
    );
    expect(
      parseBoardLinkPath(`com.boardsesh.app://b/the-garage/40/list?medium=board&utm_source=x&src=qr&wall=${WALL_UUID}`),
    ).toBe(`/b/the-garage/40/list?wall=${WALL_UUID}&src=qr&medium=board`);
  });

  it('reads an encoded pair and writes it back plainly', () => {
    expect(parseBoardLinkPath('https://www.boardsesh.com/b/the-garage?%73rc=q%72&medium=%62oard')).toBe(
      '/b/the-garage?src=qr&medium=board',
    );
  });

  it.each([
    ['src without medium', '?src=qr'],
    ['medium without src', '?medium=board'],
    ['another src', '?src=email&medium=board'],
    ['an upper-case src', '?src=QR&medium=board'],
    ['an unknown medium', '?src=qr&medium=flyer'],
    ['the gym poster medium, which no board code prints', '?src=qr&medium=poster'],
    ['an empty medium', '?src=qr&medium='],
    ['a repeated medium', '?src=qr&medium=board&medium=kiosk'],
    ['a repeated src', '?src=qr&src=qr&medium=board'],
    ['a malformed escape', '?src=qr&medium=%E0%A4%A'],
    ['a plus that decodes to a space', '?src=qr&medium=board+'],
    ['a repeated pair', '?src=qr&medium=board&src=qr&medium=board'],
  ])('drops the pair with %s', (_label, query) => {
    expect(parseBoardLinkPath(`https://www.boardsesh.com/b/the-garage${query}`)).toBe('/b/the-garage');
  });

  it.each([
    ['another host', `https://evil.example${CLIMB_PATH}`],
    ['a look-alike host', `https://www.boardsesh.com.evil.example${CLIMB_PATH}`],
    ['a host with our name as a prefix', `https://www.boardsesh.community${CLIMB_PATH}`],
    ['plain http', `http://www.boardsesh.com${CLIMB_PATH}`],
    ['the browser app host', `https://app.boardsesh.com${CLIMB_PATH}`],
    ['a join link', 'https://www.boardsesh.com/join/0f8fad5b-d9cb-469f-a165-70867728950e'],
    ['a profile', 'https://www.boardsesh.com/profile/someone'],
    ['a gym page', 'https://www.boardsesh.com/gym/the-gym'],
    ['the home page', 'https://www.boardsesh.com/'],
    ['an auth route in a board-shaped path', 'https://www.boardsesh.com/auth/1/7/1,20/40/list'],
    ['a first segment that is not a board', 'https://www.boardsesh.com/settings/1/7/1,20/40/list'],
    ['a board path with no surface', 'https://www.boardsesh.com/kilter/1/7/1,20/40'],
    ['a surface the app has no route for', 'https://www.boardsesh.com/kilter/1/7/1,20/40/edit/the-proj'],
    ['an angle that is not a number', 'https://www.boardsesh.com/kilter/1/7/1,20/steep/list'],
    ['a route group segment', 'https://www.boardsesh.com/b/(tabs)/40/list'],
    ['a relative segment', 'https://www.boardsesh.com/b/../40/list'],
    ['a space in the path', 'https://www.boardsesh.com/b/the garage/40/list'],
    ['a backslash in the path', 'https://www.boardsesh.com/b/the\\garage/40/list'],
    ['a protocol-relative path on the app scheme', 'com.boardsesh.app:////evil.example/1/7/1,20/40/list'],
    ['an empty string', ''],
  ])('refuses %s', (_label, url) => {
    expect(parseBoardLinkPath(url)).toBeNull();
  });

  it('refuses null and undefined', () => {
    expect(parseBoardLinkPath(null)).toBeNull();
    expect(parseBoardLinkPath(undefined)).toBeNull();
  });

  it('refuses a path longer than the router is ever handed', () => {
    const longSlug = 'a'.repeat(MAX_RETURN_HREF_LENGTH);
    expect(parseBoardLinkPath(`https://www.boardsesh.com/b/${longSlug}/40/list`)).toBeNull();
  });
});

describe('isBoardLinkPath', () => {
  it('accepts exactly what parseBoardLinkPath produces', () => {
    expect(isBoardLinkPath(CLIMB_PATH)).toBe(true);
    expect(isBoardLinkPath(`/b/the-garage/40/list?wall=${WALL_UUID}`)).toBe(true);
    expect(isBoardLinkPath('/b/the-garage?src=qr&medium=board')).toBe(true);
    expect(isBoardLinkPath(`/b/the-garage?wall=${WALL_UUID}&src=qr&medium=board`)).toBe(true);
  });

  // The stash is read back through this check, so every shape the parser can
  // write has to pass it, or a stored poster scan would be thrown away.
  it.each([
    'https://www.boardsesh.com/b/the-garage?medium=kiosk&src=qr',
    `https://www.boardsesh.com/b/the-garage/40/list?src=qr&medium=board&wall=${WALL_UUID}`,
    `com.boardsesh.app://b/the-garage?invite=Ab3_dE-fGhIjKlMnOpQrSt&medium=kiosk&src=qr`,
  ])('round-trips what the parser writes for %s', (url) => {
    const path = parseBoardLinkPath(url);
    expect(path).not.toBeNull();
    expect(isBoardLinkPath(path)).toBe(true);
  });

  it.each([
    ['a path the parser would have rewritten', `/es${CLIMB_PATH}`],
    ['a path with a query the parser would have dropped', `${CLIMB_PATH}?utm_source=reddit`],
    ['a QR pair out of canonical order', '/b/the-garage?medium=board&src=qr'],
    ['a QR pair the parser would refuse', '/b/the-garage?src=qr&medium=flyer'],
    ['a route that is not a board', '/auth/login'],
    ['a tab route', '/(tabs)/home'],
    ['a full URL', `https://www.boardsesh.com${CLIMB_PATH}`],
    ['a protocol-relative URL', `//evil.example${CLIMB_PATH}`],
    ['a path that smuggles a host', `.evil.example${CLIMB_PATH}`],
    ['an empty string', ''],
  ])('refuses %s', (_label, href) => {
    expect(isBoardLinkPath(href)).toBe(false);
  });

  it('refuses null and undefined', () => {
    expect(isBoardLinkPath(null)).toBe(false);
    expect(isBoardLinkPath(undefined)).toBe(false);
  });
});
