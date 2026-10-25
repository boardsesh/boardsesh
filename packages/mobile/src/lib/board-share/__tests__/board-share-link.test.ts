import { describe, expect, it, vi } from 'vitest';
import type { HomeBoardShareBoard } from '../board-share-link';

vi.mock('../../env', () => ({ WEB_BASE_URL: 'https://www.boardsesh.com' }));

const {
  buildBoardShareUrl,
  buildHomeBoardPosterUrl,
  buildPlainBoardShareUrl,
  homeBoardShareTarget,
  isBoardInviteToken,
} = await import('../board-share-link');

const OWNER = 'owner-1';
const homeBoard = (overrides: Partial<HomeBoardShareBoard> = {}): HomeBoardShareBoard => ({
  uuid: 'board-1',
  slug: 'the-garage',
  boardType: 'kilter',
  ownerId: OWNER,
  isPublic: false,
  isUnlisted: false,
  ...overrides,
});

describe('homeBoardShareTarget', () => {
  it('hands out the plain link for a Public board, to anyone who can see it', () => {
    expect(homeBoardShareTarget(homeBoard({ isPublic: true }), 'someone-else', null)).toEqual({
      kind: 'plain',
      url: 'https://www.boardsesh.com/b/the-garage',
      visibility: 'public',
      posterUrl: 'https://www.boardsesh.com/poster/b/the-garage',
    });
  });

  it('hands out the plain link for an Unlisted board, which wins over a stale Public flag', () => {
    expect(homeBoardShareTarget(homeBoard({ isPublic: true, isUnlisted: true }), OWNER, 'unlisted')).toEqual({
      kind: 'plain',
      url: 'https://www.boardsesh.com/b/the-garage',
      visibility: 'unlisted',
      posterUrl: 'https://www.boardsesh.com/poster/b/the-garage',
    });
  });

  it.each(['followers', 'invite_only'] as const)('gives the owner of a %s board the invite link', (audience) => {
    expect(homeBoardShareTarget(homeBoard(), OWNER, audience)).toEqual({ kind: 'invite', boardUuid: 'board-1' });
  });

  it('gives an Only-me board no link at all', () => {
    expect(homeBoardShareTarget(homeBoard(), OWNER, 'only_me')).toBeNull();
  });

  it('waits for the owner audience rather than guessing', () => {
    expect(homeBoardShareTarget(homeBoard(), OWNER, undefined)).toBeNull();
  });

  it("never gives a follower an Invite-only board's link: the plain one would only 404 for a friend", () => {
    expect(homeBoardShareTarget(homeBoard(), 'a-follower', 'followers')).toBeNull();
    expect(homeBoardShareTarget(homeBoard(), null, 'invite_only')).toBeNull();
  });

  it('leaves spray walls to their own share rules', () => {
    expect(homeBoardShareTarget(homeBoard({ boardType: 'spray', isPublic: true }), OWNER, 'public')).toBeNull();
  });
});

describe('buildHomeBoardPosterUrl', () => {
  it.each([
    ['Public', { isPublic: true }],
    ['Unlisted', { isUnlisted: true }],
    ['Unlisted with a stale Public flag', { isPublic: true, isUnlisted: true }],
  ] as const)('prints the plain board link for a %s board', (_label, flags) => {
    expect(buildHomeBoardPosterUrl(homeBoard(flags))).toBe('https://www.boardsesh.com/poster/b/the-garage');
  });

  // Followers, Invite-only and Only me store the same two false flags. None of
  // them gets a poster: the plain link 404s for a stranger, and an invite token
  // taped to a wall is no longer an invite.
  it('has no poster for a board that is neither Public nor Unlisted', () => {
    expect(buildHomeBoardPosterUrl(homeBoard())).toBeNull();
  });

  it('never carries an invite token or any other query', () => {
    const url = buildHomeBoardPosterUrl(homeBoard({ isUnlisted: true }));
    expect(url).not.toContain('?');
    expect(url).not.toContain('invite');
  });

  it('leaves spray walls to their own builder', () => {
    expect(buildHomeBoardPosterUrl(homeBoard({ boardType: 'spray', isPublic: true }))).toBeNull();
  });

  it('has no poster without a board or a slug', () => {
    expect(buildHomeBoardPosterUrl(null)).toBeNull();
    expect(buildHomeBoardPosterUrl(undefined)).toBeNull();
    expect(buildHomeBoardPosterUrl(homeBoard({ slug: '', isPublic: true }))).toBeNull();
  });

  it('encodes the slug', () => {
    expect(buildHomeBoardPosterUrl(homeBoard({ slug: 'kilter#1', isPublic: true }))).toBe(
      'https://www.boardsesh.com/poster/b/kilter%231',
    );
  });
});

describe('share link URLs', () => {
  it('builds the tokened URL from the path the server returned', () => {
    expect(buildBoardShareUrl('/b/the-garage?invite=Ab3_dE-fGhIjKlMnOpQrSt')).toBe(
      'https://www.boardsesh.com/b/the-garage?invite=Ab3_dE-fGhIjKlMnOpQrSt',
    );
  });

  it('encodes the slug in the plain link', () => {
    expect(buildPlainBoardShareUrl('kilter#1')).toBe('https://www.boardsesh.com/b/kilter%231');
  });

  it('reads only a 22-character base64url token', () => {
    expect(isBoardInviteToken('Ab3_dE-fGhIjKlMnOpQrSt')).toBe(true);
    for (const value of ['', 'short', 'Ab3_dE-fGhIjKlMnOpQrSt0', 'Ab3_dE-fGhIjKlMnOpQr/t', undefined, ['x']]) {
      expect(isBoardInviteToken(value)).toBe(false);
    }
  });
});
