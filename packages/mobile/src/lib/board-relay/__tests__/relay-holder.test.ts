// Relay mode (#7220): the one rule that decides whether this phone lights the
// wall through another phone, and when a relayed drive ends for its holder.
import { describe, expect, it } from 'vitest';
import type { BoardConnectionHolder } from '@boardsesh/shared-schema';
import {
  RELAY_HOLDER_IDLE_MS,
  relayHolderFor,
  relayHolderKeyOf,
  relayHolderNameOf,
  resolveRelayedDriveHolderExit,
  type RelayHolderInput,
} from '../relay-holder';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const SAM: BoardConnectionHolder = {
  userId: 'sam',
  displayName: 'Sam',
  avatarUrl: null,
  lastSentAt: new Date(NOW - 60_000).toISOString(),
};
const ANON: BoardConnectionHolder = { userId: null, displayName: null, avatarUrl: null, lastSentAt: null };
const IDLE_SAM: BoardConnectionHolder = { ...SAM, lastSentAt: new Date(NOW - RELAY_HOLDER_IDLE_MS - 1).toISOString() };

const BASE: RelayHolderInput = {
  flagEnabled: true,
  boardType: 'moonboard',
  linkMode: 'relay',
  holder: SAM,
  localConnected: false,
  sessionId: null,
  sessionMemberUserIds: new Set(),
  suppressed: false,
  now: NOW,
};

describe('relayHolderFor', () => {
  it.each<[string, Partial<RelayHolderInput>, BoardConnectionHolder | null]>([
    ['flag on, Relay mode MoonBoard, someone else holds it, not linked: relay', {}, SAM],
    ['flag off: today', { flagEnabled: false }, null],
    ['Several phones mode: today', { linkMode: 'multi' }, null],
    ['no link mode known: today', { linkMode: null }, null],
    ['a Kilter: today', { boardType: 'kilter', linkMode: null }, null],
    ['a Kilter that somehow carries relay: today', { boardType: 'kilter' }, null],
    ['this phone is linked: it is the holder', { localConnected: true }, null],
    ['no holder: Put on board connects', { holder: null }, null],
    ['an anonymous holder is another phone', { holder: ANON }, ANON],
    ['the same account on another phone relays (the server keys on the connection)', {}, SAM],
    ['the holder idles past 15 min: connect as today', { holder: IDLE_SAM }, null],
    [
      'a holder with no lastSentAt counts as active',
      { holder: { ...SAM, lastSentAt: null } },
      { ...SAM, lastSentAt: null },
    ],
    ['a lost path stays off until presence moves', { suppressed: true }, null],
    [
      'in a crew session with the holder a member: the queue relays, not this',
      { sessionId: 's1', sessionMemberUserIds: new Set(['sam']) },
      null,
    ],
    ['in a session, holder not a member: relay', { sessionId: 's1', sessionMemberUserIds: new Set(['kim']) }, SAM],
    ['in a session, anonymous holder: relay', { sessionId: 's1', holder: ANON }, ANON],
  ])('%s', (_scenario, overrides, expected) => {
    expect(relayHolderFor({ ...BASE, ...overrides })).toEqual(expected);
  });

  // Every combination of flag × link mode × holder × linked × in-session:
  // only one shape relays.
  it('relays only for flag on, relay mode, another holder, unlinked, outside the crew', () => {
    for (const flagEnabled of [true, false]) {
      for (const linkMode of ['relay', 'multi', null] as const) {
        for (const holder of [SAM, ANON, null]) {
          for (const localConnected of [true, false]) {
            for (const inCrew of [true, false]) {
              const result = relayHolderFor({
                ...BASE,
                flagEnabled,
                linkMode,
                holder,
                localConnected,
                sessionId: inCrew ? 's1' : null,
                sessionMemberUserIds: new Set(inCrew ? ['sam'] : []),
              });
              const crewHolds = inCrew && holder?.userId === 'sam';
              const expected =
                flagEnabled && linkMode === 'relay' && holder !== null && !localConnected && !crewHolds ? holder : null;
              expect(result).toEqual(expected);
            }
          }
        }
      }
    }
  });
});

describe('relayHolderKeyOf / relayHolderNameOf', () => {
  it('keys accounts and folds anonymous holders together', () => {
    expect(relayHolderKeyOf(SAM)).toBe('user:sam');
    expect(relayHolderKeyOf(ANON)).toBe('anon');
    expect(relayHolderKeyOf(null)).toBeNull();
  });

  it('names a named holder only', () => {
    expect(relayHolderNameOf(SAM)).toBe('Sam');
    expect(relayHolderNameOf(ANON)).toBeNull();
    expect(relayHolderNameOf({ ...SAM, displayName: '  ' })).toBeNull();
    expect(relayHolderNameOf(null)).toBeNull();
  });
});

describe('resolveRelayedDriveHolderExit', () => {
  const start = { startHolderKey: 'user:sam', startSeq: 4 };

  it.each<[string, BoardConnectionHolder | null, number, 'holder_left' | 'holder_changed' | null]>([
    ['the same holder: the drive goes on', SAM, 6, null],
    ['the holder cleared after the start: holder_left', null, 5, 'holder_left'],
    ['another phone took it after the start: holder_changed', { ...SAM, userId: 'kim' }, 5, 'holder_changed'],
    ['an anonymous phone took it: holder_changed', ANON, 5, 'holder_changed'],
    ['a change that predates the start ends nothing (#7234 rule)', null, 4, null],
    ['an older change read late ends nothing', { ...SAM, userId: 'kim' }, 3, null],
  ])('%s', (_scenario, holder, holderChangeSeq, expected) => {
    expect(resolveRelayedDriveHolderExit({ ...start, holder, holderChangeSeq })).toBe(expected);
  });
});
