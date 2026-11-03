// Relay mode (#7220) step 4: every connect path that would scan for a Relay
// mode MoonBoard another phone holds. Table over surface × link mode × holder
// state × flag, plus the one rule that differs from `relayHolderFor`.
import { describe, expect, it } from 'vitest';
import type { MoonboardLinkMode } from '@boardsesh/board-config';
import type { BoardConnectionHolder } from '@boardsesh/shared-schema';
import {
  RELAY_HOLDER_IDLE_MS,
  connectBlockedByRelayHolder,
  relayConnectBlockedResponseFor,
  type RelayConnectBlockedResponse,
  type RelayConnectGateInput,
  type RelayConnectSurface,
} from '../relay-holder';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const SAM: BoardConnectionHolder = {
  userId: 'sam',
  displayName: 'Sam',
  avatarUrl: null,
  lastSentAt: new Date(NOW - 60_000).toISOString(),
};
const IDLE_SAM: BoardConnectionHolder = { ...SAM, lastSentAt: new Date(NOW - RELAY_HOLDER_IDLE_MS - 1).toISOString() };

const SURFACES: ReadonlyArray<[RelayConnectSurface, RelayConnectBlockedResponse]> = [
  ['wall_kiosk', 'holder_line'],
  ['wall_empty_state', 'holder_line'],
  ['create_climb', 'holder_line_draft'],
  ['notification', 'holder_line'],
  ['picker_scan_again', 'holder_line'],
  ['picker_no_lights', 'holder_line'],
  ['move_to_board', 'relay'],
];

type Board = { name: string; boardType: string; linkMode: MoonboardLinkMode | null; relayBoard: boolean };
const BOARDS: Board[] = [
  { name: 'Relay mode MoonBoard', boardType: 'moonboard', linkMode: 'relay', relayBoard: true },
  { name: 'Several phones MoonBoard', boardType: 'moonboard', linkMode: 'multi', relayBoard: false },
  { name: 'MoonBoard with no link mode', boardType: 'moonboard', linkMode: null, relayBoard: false },
  { name: 'Kilter', boardType: 'kilter', linkMode: null, relayBoard: false },
];

type HolderState = { name: string; input: Partial<RelayConnectGateInput>; blocksOnRelayBoard: boolean };
const HOLDER_STATES: HolderState[] = [
  { name: 'no holder', input: { holder: null }, blocksOnRelayBoard: false },
  { name: 'this phone is linked (it holds the board)', input: { localConnected: true }, blocksOnRelayBoard: false },
  { name: 'another phone holds it, active', input: {}, blocksOnRelayBoard: true },
  { name: 'another phone holds it, idle past 15 min', input: { holder: IDLE_SAM }, blocksOnRelayBoard: false },
  { name: 'the path to that holder was lost (suppressed)', input: { suppressed: true }, blocksOnRelayBoard: false },
  {
    name: "this phone's own unreleased hold",
    input: { lastLocalHolderUserId: 'sam' },
    blocksOnRelayBoard: false,
  },
  {
    name: 'an anonymous holder',
    input: { holder: { userId: null, displayName: null, avatarUrl: null, lastSentAt: null } },
    blocksOnRelayBoard: true,
  },
];

function inputFor(board: Board, holderState: HolderState, flagEnabled: boolean): RelayConnectGateInput {
  return {
    flagEnabled,
    boardType: board.boardType,
    linkMode: board.linkMode,
    holder: SAM,
    localConnected: false,
    suppressed: false,
    lastLocalHolderUserId: null,
    now: NOW,
    ...holderState.input,
  };
}

const CASES = SURFACES.flatMap(([surface, response]) =>
  BOARDS.flatMap((board) =>
    HOLDER_STATES.flatMap((holderState) =>
      [true, false].map((flagEnabled) => ({
        label: `${surface} · ${board.name} · ${holderState.name} · flag ${flagEnabled ? 'on' : 'off'}`,
        surface,
        input: inputFor(board, holderState, flagEnabled),
        blocked: flagEnabled && board.relayBoard && holderState.blocksOnRelayBoard,
        response,
      })),
    ),
  ),
);

describe('connectBlockedByRelayHolder', () => {
  it('covers every surface, link mode, holder state and flag value', () => {
    expect(CASES).toHaveLength(SURFACES.length * BOARDS.length * HOLDER_STATES.length * 2);
  });

  it.each(CASES)('$label', ({ surface, input, blocked, response }) => {
    const gate = connectBlockedByRelayHolder(surface, input);
    if (!blocked) {
      expect(gate).toEqual({ blocked: false });
      return;
    }
    expect(gate).toEqual({ blocked: true, holder: input.holder, response });
  });

  it("blocks on a crewmate's hold too: the crew's queue lights through that phone", () => {
    // `relayHolderFor` hands a crewmate's hold to the session queue; the gate
    // has no session input at all, so a crewmate's phone still blocks a scan.
    const gate = connectBlockedByRelayHolder('wall_kiosk', inputFor(BOARDS[0], HOLDER_STATES[2], true));
    expect(gate.blocked).toBe(true);
  });

  it("the same account's other phone still blocks: the hold is that phone's link", () => {
    const gate = connectBlockedByRelayHolder('notification', {
      ...inputFor(BOARDS[0], HOLDER_STATES[2], true),
      lastLocalHolderUserId: null,
    });
    expect(gate).toEqual({ blocked: true, holder: SAM, response: 'holder_line' });
  });

  it('a holder with no lastSentAt counts as active', () => {
    const holder = { ...SAM, lastSentAt: null };
    const gate = connectBlockedByRelayHolder('wall_empty_state', {
      ...inputFor(BOARDS[0], HOLDER_STATES[2], true),
      holder,
    });
    expect(gate.blocked).toBe(true);
  });
});

describe('relayConnectBlockedResponseFor', () => {
  it.each(SURFACES)('%s answers %s', (surface, response) => {
    expect(relayConnectBlockedResponseFor(surface)).toBe(response);
  });
});
