import { describe, expect, it } from 'vitest';
import { boardseshLinkPathname } from '../board-deep-link';
import { parseScannedBoardCode } from '../scanned-board-code';

const INVITE_TOKEN = 'Ab3_dE-fGhIjKlMnOpQrSt';
const SESSION_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const CLIMB_PATH = '/kilter/1/7/1,20/40/view/the-proj-a1b2c3d4';

describe('parseScannedBoardCode', () => {
  it("opens a friend's board invite code with its token", () => {
    expect(parseScannedBoardCode(`https://www.boardsesh.com/b/the-garage?invite=${INVITE_TOKEN}`)).toEqual({
      kind: 'board',
      href: `/b/the-garage?invite=${INVITE_TOKEN}`,
    });
  });

  it('opens the apex host, the app scheme and a locale prefix the same way', () => {
    for (const url of [
      `https://boardsesh.com/b/the-garage?invite=${INVITE_TOKEN}`,
      `com.boardsesh.app://b/the-garage?invite=${INVITE_TOKEN}`,
      `https://www.boardsesh.com/es/b/the-garage?invite=${INVITE_TOKEN}`,
    ]) {
      expect(parseScannedBoardCode(url)).toEqual({ kind: 'board', href: `/b/the-garage?invite=${INVITE_TOKEN}` });
    }
  });

  it("keeps a gym poster's printed-code pair and opens a shared climb", () => {
    expect(parseScannedBoardCode('https://www.boardsesh.com/b/the-garage?src=qr&medium=board')).toEqual({
      kind: 'board',
      href: '/b/the-garage?src=qr&medium=board',
    });
    expect(parseScannedBoardCode(`https://www.boardsesh.com${CLIMB_PATH}`)).toEqual({
      kind: 'board',
      href: CLIMB_PATH,
    });
  });

  it('ignores whitespace a code carries around its link', () => {
    expect(parseScannedBoardCode(`  https://www.boardsesh.com/b/the-garage\n`)).toEqual({
      kind: 'board',
      href: '/b/the-garage',
    });
  });

  it("opens a crew session's join link", () => {
    for (const url of [
      `https://www.boardsesh.com/join/${SESSION_ID}`,
      `https://boardsesh.com/fr/join/${SESSION_ID}/`,
      `com.boardsesh.app://join/${SESSION_ID}`,
    ]) {
      expect(parseScannedBoardCode(url)).toEqual({ kind: 'join', sessionId: SESSION_ID });
    }
  });

  it.each([
    ['another site', 'https://example.com/b/the-garage'],
    ['a lookalike host', 'https://www.boardsesh.com.evil.example/b/the-garage'],
    ['a subdomain we do not serve links from', 'https://evil.boardsesh.com/b/the-garage'],
    ['plain http', 'http://www.boardsesh.com/b/the-garage'],
    ['userinfo before the host', 'https://www.boardsesh.com@evil.example/b/the-garage'],
    ['a Wi-Fi code', 'WIFI:T:WPA;S:Gym Guest;P:hangboard;;'],
    ['plain text', 'the garage'],
    ['an empty code', ''],
    ['a profile on our host', 'https://www.boardsesh.com/profile/someone'],
    ['a join link with a malformed id', 'https://www.boardsesh.com/join/not-a-session'],
    ['a join link with extra segments', `https://www.boardsesh.com/join/${SESSION_ID}/extra`],
    ['the auth callback', 'com.boardsesh.app://auth/callback?code=abc'],
  ])('refuses %s', (_label, url) => {
    expect(parseScannedBoardCode(url)).toEqual({ kind: 'not-boardsesh' });
  });

  it('refuses a code too long to be one of our links', () => {
    expect(parseScannedBoardCode(`https://www.boardsesh.com/b/the-garage?x=${'a'.repeat(3000)}`)).toEqual({
      kind: 'not-boardsesh',
    });
  });

  it('refuses a missing value', () => {
    expect(parseScannedBoardCode(null)).toEqual({ kind: 'not-boardsesh' });
    expect(parseScannedBoardCode(undefined)).toEqual({ kind: 'not-boardsesh' });
  });
});

describe('boardseshLinkPathname', () => {
  it('reads the path of our links only', () => {
    expect(boardseshLinkPathname(`https://www.boardsesh.com/de/join/${SESSION_ID}?x=1#top`)).toBe(
      `/join/${SESSION_ID}`,
    );
    expect(boardseshLinkPathname('https://example.com/join/x')).toBeNull();
  });
});
