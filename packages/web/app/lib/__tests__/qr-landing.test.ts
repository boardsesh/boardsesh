import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { __resetQrLandingForTests, captureQrLanding, captureQrLandingMedium, searchToGymQrParams } from '../qr-landing';

const captureBoardQrLandingMedium = () => captureQrLandingMedium('board');

beforeEach(() => {
  __resetQrLandingForTests();
  window.history.replaceState(null, '', '/');
});

describe('searchToGymQrParams', () => {
  it('reads a search string, with or without its question mark', () => {
    expect(searchToGymQrParams('?src=qr&medium=board')).toEqual({ src: 'qr', medium: 'board' });
    expect(searchToGymQrParams('src=qr&medium=board')).toEqual({ src: 'qr', medium: 'board' });
    expect(searchToGymQrParams('')).toEqual({});
  });

  it('keeps a repeated param as an array, so the strict parser can refuse it', () => {
    expect(searchToGymQrParams('?medium=board&medium=kiosk&medium=poster')).toEqual({
      medium: ['board', 'kiosk', 'poster'],
    });
  });
});

describe('captureQrLandingMedium on a board page', () => {
  it('reads the medium of a scan off the address bar', () => {
    window.history.replaceState(null, '', '/b/garage-wall/40/list?src=qr&medium=board');

    expect(captureBoardQrLandingMedium()).toBe('board');
  });

  it('reads null for a plain visit and for anything the parser refuses', () => {
    for (const search of [
      '',
      '?wall=abc',
      '?src=qr&medium=flyer',
      '?src=qr&medium=board&medium=kiosk',
      '?src=QR&medium=board',
      // The gym poster's medium: no board code prints it.
      '?src=qr&medium=poster',
    ]) {
      __resetQrLandingForTests();
      window.history.replaceState(null, '', `/b/garage-wall/40/list${search}`);
      expect(captureBoardQrLandingMedium(), search).toBeNull();
    }
  });

  it('remembers the scan on its page after the pair has left the address bar', () => {
    window.history.replaceState(null, '', '/b/garage-wall/40/list?src=qr&medium=board&wall=abc');
    expect(captureBoardQrLandingMedium()).toBe('board');

    window.history.replaceState(null, '', '/b/garage-wall/40/list?wall=abc');

    expect(captureBoardQrLandingMedium()).toBe('board');
  });

  it('answers null on another page, and the scan again back on its own', () => {
    window.history.replaceState(null, '', '/b/garage-wall/40/list?src=qr&medium=board');
    captureBoardQrLandingMedium();

    window.history.replaceState(null, '', '/gyms');
    expect(captureBoardQrLandingMedium()).toBeNull();

    window.history.replaceState(null, '', '/b/garage-wall/40/list');
    expect(captureBoardQrLandingMedium()).toBe('board');
  });

  it('takes a newer scan over the one it remembered', () => {
    window.history.replaceState(null, '', '/b/garage-wall/40/list?src=qr&medium=board');
    captureBoardQrLandingMedium();

    window.history.replaceState(null, '', '/b/the-kilter/40/list?src=qr&medium=kiosk');

    expect(captureBoardQrLandingMedium()).toBe('kiosk');
  });
});

describe('captureQrLandingMedium on a climb page', () => {
  const CLIMB_PATH = '/b/the-kilter/40/view/abc-the-climb';

  it('reads the desktop code a climb page shows', () => {
    window.history.replaceState(null, '', `${CLIMB_PATH}?src=qr&medium=desktop`);

    expect(captureQrLandingMedium('climb')).toBe('desktop');
    expect(captureQrLanding('climb')).toEqual({ kind: 'climb', medium: 'desktop' });
  });

  it.each([
    '?src=qr&medium=board',
    '?src=qr&medium=kiosk',
    '?src=qr&medium=poster',
    '?src=qr&medium=desktop&medium=desktop',
  ])('reads null for %s, which no climb page prints', (search) => {
    window.history.replaceState(null, '', `${CLIMB_PATH}${search}`);

    expect(captureQrLandingMedium('climb')).toBeNull();
  });

  it('keeps the kinds apart: a board landing reads null to a climb reader, and back', () => {
    window.history.replaceState(null, '', `${CLIMB_PATH}?src=qr&medium=desktop`);
    expect(captureQrLandingMedium('board')).toBeNull();
    expect(captureQrLandingMedium('climb')).toBe('desktop');

    window.history.replaceState(null, '', CLIMB_PATH);
    expect(captureQrLandingMedium('board')).toBeNull();
    expect(captureQrLandingMedium('climb')).toBe('desktop');
  });
});

describe('captureQrLandingMedium on a board list', () => {
  const LIST_PATH = '/b/the-kilter/40/list';

  it("reads the list's own desktop code", () => {
    window.history.replaceState(null, '', `${LIST_PATH}?src=qr&medium=desktop`);

    expect(captureQrLandingMedium('list')).toBe('desktop');
    expect(captureQrLanding('list')).toEqual({ kind: 'list', medium: 'desktop' });
  });

  it.each(['?src=qr&medium=board', '?src=qr&medium=kiosk', '?src=qr&medium=poster'])(
    'reads null for %s, which the board tracker on the same page owns',
    (search) => {
      window.history.replaceState(null, '', `${LIST_PATH}${search}`);

      expect(captureQrLandingMedium('list')).toBeNull();
    },
  );

  it('keeps a printed board code and the laptop code apart on the one page', () => {
    window.history.replaceState(null, '', `${LIST_PATH}?src=qr&medium=kiosk`);
    expect(captureQrLandingMedium('board')).toBe('kiosk');
    expect(captureQrLandingMedium('list')).toBeNull();

    window.history.replaceState(null, '', `${LIST_PATH}?src=qr&medium=desktop`);
    expect(captureQrLandingMedium('list')).toBe('desktop');
    expect(captureQrLandingMedium('board')).toBeNull();
  });
});

describe.each([
  ['setter', '/setter/jimmy%20webb'],
  ['playlist', '/playlists/5d3b1c7e-2a4f'],
] as const)('captureQrLandingMedium on a %s page', (kind, pagePath) => {
  it('reads its own desktop code', () => {
    window.history.replaceState(null, '', `${pagePath}?src=qr&medium=desktop`);

    expect(captureQrLanding(kind)).toEqual({ kind, medium: 'desktop' });
  });

  it('reads null for a printed code, which no setter or playlist page shows', () => {
    window.history.replaceState(null, '', `${pagePath}?src=qr&medium=poster`);

    expect(captureQrLandingMedium(kind)).toBeNull();
  });
});
