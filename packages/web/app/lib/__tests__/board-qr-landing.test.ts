import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { __resetBoardQrLandingForTests, readBoardQrLandingMedium, searchToGymQrParams } from '../board-qr-landing';

beforeEach(() => {
  __resetBoardQrLandingForTests();
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

describe('readBoardQrLandingMedium', () => {
  it('reads the medium of a scan off the address bar', () => {
    window.history.replaceState(null, '', '/b/garage-wall/40/list?src=qr&medium=board');

    expect(readBoardQrLandingMedium()).toBe('board');
  });

  it('reads null for a plain visit and for anything the parser refuses', () => {
    for (const search of [
      '',
      '?wall=abc',
      '?src=qr&medium=flyer',
      '?src=qr&medium=board&medium=kiosk',
      '?src=QR&medium=board',
    ]) {
      __resetBoardQrLandingForTests();
      window.history.replaceState(null, '', `/b/garage-wall/40/list${search}`);
      expect(readBoardQrLandingMedium(), search).toBeNull();
    }
  });

  it('remembers the scan on its page after the pair has left the address bar', () => {
    window.history.replaceState(null, '', '/b/garage-wall/40/list?src=qr&medium=board&wall=abc');
    expect(readBoardQrLandingMedium()).toBe('board');

    window.history.replaceState(null, '', '/b/garage-wall/40/list?wall=abc');

    expect(readBoardQrLandingMedium()).toBe('board');
  });

  it('answers null on another page, and the scan again back on its own', () => {
    window.history.replaceState(null, '', '/b/garage-wall/40/list?src=qr&medium=board');
    readBoardQrLandingMedium();

    window.history.replaceState(null, '', '/gyms');
    expect(readBoardQrLandingMedium()).toBeNull();

    window.history.replaceState(null, '', '/b/garage-wall/40/list');
    expect(readBoardQrLandingMedium()).toBe('board');
  });

  it('takes a newer scan over the one it remembered', () => {
    window.history.replaceState(null, '', '/b/garage-wall/40/list?src=qr&medium=board');
    readBoardQrLandingMedium();

    window.history.replaceState(null, '', '/b/the-kilter/40/list?src=qr&medium=kiosk');

    expect(readBoardQrLandingMedium()).toBe('kiosk');
  });
});
