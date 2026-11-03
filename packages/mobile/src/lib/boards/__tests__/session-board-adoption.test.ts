import { afterEach, describe, expect, it } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import {
  ADOPTION_WINDOW_MS,
  clearSessionBoardAdoption,
  expectSessionBoardAdoption,
  fetchNamedSessionBoard,
  mayAdoptNamedSessionBoard,
  takeNamedSessionBoardAdoption,
} from '../session-board-adoption';

const board = (overrides: Partial<UserBoard>): UserBoard =>
  ({
    uuid: 'board-uuid',
    slug: 'board-slug',
    boardType: 'moonboard',
    layoutId: 3,
    sizeId: 1,
    setIds: '5,6',
    angle: 40,
    ...overrides,
  }) as UserBoard;

// The crewmate's own row, minted from the join screen's geometry path.
const crewCopy = board({ uuid: 'crew-copy', slug: 'crew-moonboard' });
// The owner's private home wall, named to the crew once they are in the roster.
const hostWall = board({ uuid: 'host-wall', slug: 'sams-garage', angle: 25 });

const lookup = async (slug: string) => (slug === hostWall.slug ? hostWall : null);

afterEach(() => clearSessionBoardAdoption());

describe('session board adoption (#7220)', () => {
  it('moves a crewmate who joined on geometry onto the named wall, at the path angle, once', () => {
    expectSessionBoardAdoption('session-1', crewCopy, lookup);
    expect(mayAdoptNamedSessionBoard('session-1', crewCopy)).toBe(true);
    expect(takeNamedSessionBoardAdoption('session-1', crewCopy, hostWall, 40)).toEqual({ ...hostWall, angle: 40 });
    // Spent: a later snapshot moves nobody.
    expect(mayAdoptNamedSessionBoard('session-1', crewCopy)).toBe(false);
    expect(takeNamedSessionBoardAdoption('session-1', crewCopy, hostWall, 40)).toBeNull();
  });

  it('keeps the wall’s own angle when the path carries none', () => {
    expectSessionBoardAdoption('session-1', crewCopy, lookup);
    expect(takeNamedSessionBoardAdoption('session-1', crewCopy, hostWall, undefined)).toBe(hostWall);
  });

  it('moves nobody without a join on geometry, or in another session', () => {
    expect(takeNamedSessionBoardAdoption('session-1', crewCopy, hostWall, 40)).toBeNull();
    expectSessionBoardAdoption('session-1', crewCopy, lookup);
    expect(takeNamedSessionBoardAdoption('session-2', crewCopy, hostWall, 40)).toBeNull();
  });

  it('respects a climber who picked another board since joining', () => {
    expectSessionBoardAdoption('session-1', crewCopy, lookup);
    const picked = board({ uuid: 'picked', slug: 'picked-wall' });
    expect(takeNamedSessionBoardAdoption('session-1', picked, hostWall, 40)).toBeNull();
  });

  it('never crosses to a wall with another configuration', () => {
    const refused = [board({ ...hostWall, sizeId: 2 }), board({ ...hostWall, boardType: 'kilter' })];
    for (const otherWall of refused) {
      expectSessionBoardAdoption('session-1', crewCopy, lookup);
      expect(takeNamedSessionBoardAdoption('session-1', crewCopy, otherWall, 40)).toBeNull();
    }
    // Set order alone is the same configuration.
    expectSessionBoardAdoption('session-1', crewCopy, lookup);
    expect(takeNamedSessionBoardAdoption('session-1', crewCopy, board({ ...hostWall, setIds: '6,5' }), 40)?.uuid).toBe(
      'host-wall',
    );
  });

  it('never adopts a shared per-config feed, a board it may not read, or the board it is on', () => {
    const sharedFeed = board({ ...hostWall, slug: 'presence-moonboard-3-1-0123456789abcdef0123' });
    for (const refused of [sharedFeed, null, crewCopy]) {
      expectSessionBoardAdoption('session-1', crewCopy, lookup);
      expect(takeNamedSessionBoardAdoption('session-1', crewCopy, refused, 40)).toBeNull();
    }
  });

  it('is spent by the first named path even when it moves nobody, so a later switch drags no one', () => {
    expectSessionBoardAdoption('session-1', crewCopy, lookup);
    expect(takeNamedSessionBoardAdoption('session-1', crewCopy, null, 40)).toBeNull();
    expect(mayAdoptNamedSessionBoard('session-1', crewCopy)).toBe(false);
    expect(takeNamedSessionBoardAdoption('session-1', crewCopy, hostWall, 40)).toBeNull();
  });

  it('lapses after the adoption window', () => {
    expectSessionBoardAdoption('session-1', crewCopy, lookup, 1_000);
    expect(mayAdoptNamedSessionBoard('session-1', crewCopy, 1_000 + ADOPTION_WINDOW_MS - 1)).toBe(true);
    expect(mayAdoptNamedSessionBoard('session-1', crewCopy, 1_000 + ADOPTION_WINDOW_MS)).toBe(false);
    expect(takeNamedSessionBoardAdoption('session-1', crewCopy, hostWall, 40, 1_000 + ADOPTION_WINDOW_MS)).toBeNull();
  });

  it('looks the wall up through the join’s own lookup, and through nothing without a join', async () => {
    expect(await fetchNamedSessionBoard('sams-garage')).toBeNull();
    expectSessionBoardAdoption('session-1', crewCopy, lookup);
    expect(await fetchNamedSessionBoard('sams-garage')).toBe(hostWall);
  });

  it('clears for its own session only', () => {
    expectSessionBoardAdoption('session-1', crewCopy, lookup);
    clearSessionBoardAdoption('session-2');
    expect(mayAdoptNamedSessionBoard('session-1', crewCopy)).toBe(true);
    clearSessionBoardAdoption('session-1');
    expect(mayAdoptNamedSessionBoard('session-1', crewCopy)).toBe(false);
  });
});
