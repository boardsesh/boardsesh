import { describe, expect, it } from 'vitest';
import {
  MAX_OWNED_SPRAY_WALL_PINS,
  planOwnedSprayWallPins,
  type OwnedSprayWallPinBoard,
} from '../owned-spray-wall-pins';

const ME = 'user-me';
const SOMEONE = 'user-someone';

function wall(uuid: string, layoutId: number, ownerId: string): OwnedSprayWallPinBoard {
  return { uuid, boardType: 'spray', layoutId, sizeId: layoutId, ownerId };
}

const scopeKey = (layoutId: number) => `spray:${layoutId}:${layoutId}`;

function plan(
  boards: OwnedSprayWallPinBoard[],
  options: { ledger?: { userId: string; wallUuids: string[] } | null; enabled?: string[]; viewer?: string } = {},
) {
  return planOwnedSprayWallPins({
    boards,
    viewerUserId: options.viewer ?? ME,
    ledger: options.ledger ?? null,
    enabledScopeKeys: new Set(options.enabled ?? []),
  });
}

describe('planOwnedSprayWallPins', () => {
  // The owner never has to remember a switch for their own wall.
  it('pins every owned wall it has not seen and records it', () => {
    const mine = wall('wall-a', 101, ME);
    const result = plan([mine, wall('wall-b', 102, SOMEONE)]);
    expect(result.pin).toEqual([mine]);
    expect(result.unpin).toEqual([]);
    expect(result.ledger).toEqual({ userId: ME, wallUuids: ['wall-a'] });
  });

  // Somebody else's wall still needs the "Available offline" switch.
  it('leaves walls the climber follows but does not own alone', () => {
    expect(plan([wall('wall-b', 102, SOMEONE)])).toEqual({ pin: [], unpin: [], ledger: null });
  });

  it('only records an owned wall that is already on', () => {
    const result = plan([wall('wall-a', 101, ME)], { enabled: [scopeKey(101)] });
    expect(result.pin).toEqual([]);
    expect(result.ledger).toEqual({ userId: ME, wallUuids: ['wall-a'] });
  });

  // Pinned once: an owner who turns it off (My Boards, or Storage's Remove)
  // keeps it off.
  it('does not turn a wall back on that the owner turned off', () => {
    const result = plan([wall('wall-a', 101, ME)], { ledger: { userId: ME, wallUuids: ['wall-a'] } });
    expect(result).toEqual({ pin: [], unpin: [], ledger: null });
  });

  it('is a no-op on the second run, so the setting write it causes settles', () => {
    const first = plan([wall('wall-a', 101, ME)]);
    const second = plan([wall('wall-a', 101, ME)], { ledger: first.ledger, enabled: [scopeKey(101)] });
    expect(second).toEqual({ pin: [], unpin: [], ledger: null });
  });

  // A wall that is no longer the climber's is no longer theirs to keep.
  it('takes the download off a pinned wall the climber no longer owns', () => {
    const transferred = wall('wall-a', 101, SOMEONE);
    const result = plan([transferred], {
      ledger: { userId: ME, wallUuids: ['wall-a', 'wall-c'] },
      enabled: [scopeKey(101)],
    });
    expect(result.unpin).toEqual([transferred]);
    expect(result.ledger).toEqual({ userId: ME, wallUuids: ['wall-c'] });
  });

  it('drops a lost wall from the ledger without removing anything when it was already off', () => {
    const result = plan([wall('wall-a', 101, SOMEONE)], { ledger: { userId: ME, wallUuids: ['wall-a'] } });
    expect(result.unpin).toEqual([]);
    expect(result.ledger).toEqual({ userId: ME, wallUuids: [] });
  });

  // `myBoards` leaves archived walls out; they stay downloaded so they open offline.
  it('keeps a pinned wall that is missing from the list', () => {
    expect(plan([], { ledger: { userId: ME, wallUuids: ['archived-wall'] }, enabled: [scopeKey(101)] })).toEqual({
      pin: [],
      unpin: [],
      ledger: null,
    });
  });

  it('decides nothing for a wall whose owner is unknown', () => {
    const unknownOwner = { ...wall('wall-a', 101, ME), ownerId: '' };
    expect(plan([unknownOwner], { ledger: { userId: ME, wallUuids: ['wall-a'] } })).toEqual({
      pin: [],
      unpin: [],
      ledger: null,
    });
  });

  it('ignores catalogue boards the climber owns', () => {
    const kilter = { uuid: 'home-kilter', boardType: 'kilter', layoutId: 1, sizeId: 10, ownerId: ME };
    expect(plan([kilter])).toEqual({ pin: [], unpin: [], ledger: null });
  });

  // A shared phone: the next account's walls are its own to pin, and the last
  // account's opt-outs mean nothing to it.
  it("replaces another account's ledger rather than reading it", () => {
    const mine = wall('wall-a', 101, ME);
    const result = plan([mine], { ledger: { userId: SOMEONE, wallUuids: ['wall-a'] } });
    expect(result.pin).toEqual([mine]);
    expect(result.ledger).toEqual({ userId: ME, wallUuids: ['wall-a'] });
  });

  it("never unpins on another account's ledger", () => {
    const result = plan([wall('wall-a', 101, SOMEONE)], {
      ledger: { userId: SOMEONE, wallUuids: ['wall-a'] },
      enabled: [scopeKey(101)],
    });
    expect(result.unpin).toEqual([]);
    expect(result.ledger).toEqual({ userId: ME, wallUuids: [] });
  });

  it('keeps the newest walls when the ledger is full', () => {
    const full = Array.from({ length: MAX_OWNED_SPRAY_WALL_PINS }, (_unused, index) => `old-${index}`);
    const result = plan([wall('new-wall', 999, ME)], { ledger: { userId: ME, wallUuids: full } });
    expect(result.ledger?.wallUuids).toHaveLength(MAX_OWNED_SPRAY_WALL_PINS);
    expect(result.ledger?.wallUuids.at(-1)).toBe('new-wall');
    expect(result.ledger?.wallUuids).not.toContain('old-0');
  });
});
