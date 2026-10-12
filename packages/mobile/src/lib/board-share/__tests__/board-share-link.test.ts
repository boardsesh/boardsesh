import { describe, expect, it, vi } from 'vitest';
import type { HomeBoardShareBoard } from '../board-share-link';

vi.mock('../../env', () => ({ WEB_BASE_URL: 'https://www.boardsesh.com' }));

const { buildBoardShareUrl, buildPlainBoardShareUrl, homeBoardShareTarget, isBoardInviteToken } =
  await import('../board-share-link');

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
    });
  });

  it('hands out the plain link for an Unlisted board, which wins over a stale Public flag', () => {
    expect(homeBoardShareTarget(homeBoard({ isPublic: true, isUnlisted: true }), OWNER, 'unlisted')).toEqual({
      kind: 'plain',
      url: 'https://www.boardsesh.com/b/the-garage',
      visibility: 'unlisted',
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
