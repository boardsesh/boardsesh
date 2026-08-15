import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseSetIds } from '@boardsesh/board-config';
import { normalizeSetIdsForCompare } from '@boardsesh/shared-schema';
import {
  boardConfigKey,
  chooseCanonicalBoard,
  chooseMetadataDonor,
  groupSerialClusters,
  isGenericBoardName,
  loserBoards,
  SYSTEM_USER_ID,
  type SerialBoardRow,
} from '../serial-dedupe';

function board(overrides: Partial<SerialBoardRow>): SerialBoardRow {
  return {
    id: 1,
    uuid: 'board-1',
    ownerId: 'owner-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '20,21',
    name: 'Kilter Board',
    gymId: null,
    latitude: null,
    longitude: null,
    locationName: null,
    hideLocation: false,
    isUnlisted: false,
    isPublic: true,
    serialNumber: 'SER-100',
    climbEventCount: 0,
    tickCount: 0,
    followCount: 0,
    ...overrides,
  };
}

void describe('boardConfigKey', () => {
  void it('treats reordered set_ids as the same config', () => {
    assert.equal(boardConfigKey(board({ setIds: '20,21' })), boardConfigKey(board({ setIds: '21,20' })));
  });

  void it('normalises set_ids (dedupe, trim, numeric sort) before comparing', () => {
    // Order, whitespace, duplicate tokens, and trailing commas must not split
    // an otherwise identical config into two keys (via @boardsesh/board-config
    // normaliseSetIds). Numeric — not lexicographic — sort: 10 sorts after 2.
    assert.equal(boardConfigKey(board({ setIds: '21, 20 ,20' })), boardConfigKey(board({ setIds: '20,21' })));
    assert.equal(boardConfigKey(board({ setIds: '5,,6,' })), boardConfigKey(board({ setIds: '6,5' })));
    assert.notEqual(boardConfigKey(board({ setIds: '2,10' })), boardConfigKey(board({ setIds: '2,1,0' })));
  });

  void it('distinguishes differing layout/size/type', () => {
    assert.notEqual(boardConfigKey(board({ layoutId: 1 })), boardConfigKey(board({ layoutId: 2 })));
    assert.notEqual(boardConfigKey(board({ sizeId: 10 })), boardConfigKey(board({ sizeId: 11 })));
    assert.notEqual(boardConfigKey(board({ boardType: 'kilter' })), boardConfigKey(board({ boardType: 'tension' })));
  });
});

void describe('groupSerialClusters', () => {
  void it('only clusters serials with more than one active board', () => {
    const clusters = groupSerialClusters([
      board({ id: 1, serialNumber: 'SER-A' }),
      board({ id: 2, serialNumber: 'SER-A' }),
      board({ id: 3, serialNumber: 'SER-SOLO' }),
    ]);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0]?.serial, 'SER-A');
    assert.equal(clusters[0]?.boards.length, 2);
    assert.equal(clusters[0]?.skipReason, null);
    assert.equal(clusters[0]?.configKey, boardConfigKey(board({})));
  });

  void it('flags clusters spanning distinct configs and leaves configKey null', () => {
    const clusters = groupSerialClusters([
      board({ id: 1, serialNumber: 'SER-MIX', layoutId: 1 }),
      board({ id: 2, serialNumber: 'SER-MIX', layoutId: 2 }),
    ]);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0]?.skipReason, 'distinct-configs');
    assert.equal(clusters[0]?.configKey, null);
  });

  void it('sorts clusters by serial for stable reporting', () => {
    const clusters = groupSerialClusters([
      board({ id: 1, serialNumber: 'SER-Z' }),
      board({ id: 2, serialNumber: 'SER-Z' }),
      board({ id: 3, serialNumber: 'SER-A' }),
      board({ id: 4, serialNumber: 'SER-A' }),
    ]);
    assert.deepEqual(
      clusters.map((cluster) => cluster.serial),
      ['SER-A', 'SER-Z'],
    );
  });
});

void describe('chooseCanonicalBoard', () => {
  function clusterOf(boards: SerialBoardRow[]) {
    return { serial: 'SER', boards, configKey: 'k', skipReason: null } as const;
  }

  void it('prefers most climb events', () => {
    const winner = chooseCanonicalBoard(
      clusterOf([
        board({ id: 1, climbEventCount: 3 }),
        board({ id: 2, climbEventCount: 9 }),
        board({ id: 3, climbEventCount: 1 }),
      ]),
    );
    assert.equal(winner?.id, 2);
  });

  void it('breaks a climb-event tie by tick count', () => {
    const winner = chooseCanonicalBoard(
      clusterOf([
        board({ id: 1, climbEventCount: 5, tickCount: 2 }),
        board({ id: 2, climbEventCount: 5, tickCount: 8 }),
      ]),
    );
    assert.equal(winner?.id, 2);
  });

  void it('breaks a tick tie by follow count', () => {
    const winner = chooseCanonicalBoard(
      clusterOf([
        board({ id: 1, climbEventCount: 5, tickCount: 3, followCount: 1 }),
        board({ id: 2, climbEventCount: 5, tickCount: 3, followCount: 4 }),
      ]),
    );
    assert.equal(winner?.id, 2);
  });

  void it('breaks a full tie by lowest id', () => {
    const winner = chooseCanonicalBoard(clusterOf([board({ id: 7 }), board({ id: 3 }), board({ id: 5 })]));
    assert.equal(winner?.id, 3);
  });

  void it('selects among public boards when a cluster mixes public and private rows', () => {
    const winner = chooseCanonicalBoard(
      clusterOf([
        board({ id: 1, isPublic: false, climbEventCount: 100 }),
        board({ id: 2, isPublic: true, climbEventCount: 2 }),
        board({ id: 3, isPublic: true, climbEventCount: 3 }),
      ]),
    );
    assert.equal(winner?.id, 3);
  });

  void it('keeps the existing ranking when every row is private', () => {
    const winner = chooseCanonicalBoard(
      clusterOf([
        board({ id: 1, isPublic: false, climbEventCount: 2 }),
        board({ id: 2, isPublic: false, climbEventCount: 3 }),
      ]),
    );
    assert.equal(winner?.id, 2);
  });
});

void describe('loserBoards', () => {
  void it('returns everything but the canonical, best-first', () => {
    const boards = [
      board({ id: 1, climbEventCount: 1 }),
      board({ id: 2, climbEventCount: 9 }),
      board({ id: 3, climbEventCount: 4 }),
    ];
    const cluster = { serial: 'SER', boards, configKey: 'k', skipReason: null } as const;
    const canonical = chooseCanonicalBoard(cluster);
    assert.ok(canonical);
    const losers = loserBoards(cluster, canonical);
    assert.deepEqual(
      losers.map((loser) => loser.id),
      [3, 1],
    );
  });
});

void describe('isGenericBoardName', () => {
  void it('matches default kilter names case-insensitively', () => {
    assert.equal(isGenericBoardName('Kilter Board', 'kilter'), true);
    assert.equal(isGenericBoardName('kilter board', 'kilter'), true);
    assert.equal(isGenericBoardName('  Kilter Board Original ', 'kilter'), true);
  });

  void it('matches default tension names', () => {
    assert.equal(isGenericBoardName('Tension Board', 'tension'), true);
    assert.equal(isGenericBoardName('Tension Board Original', 'tension'), true);
  });

  void it('matches only bare MoonBoard names case-insensitively', () => {
    assert.equal(isGenericBoardName(' MoonBoard ', 'moonboard'), true);
    assert.equal(isGenericBoardName('moonboard', 'moonboard'), true);
    assert.equal(isGenericBoardName('MoonBoard 2024', 'moonboard'), false);
    assert.equal(isGenericBoardName('Mini MoonBoard 2025', 'moonboard'), false);
    assert.equal(isGenericBoardName('My MoonBoard', 'moonboard'), false);
  });

  void it('treats gym-branded or bespoke names as specific', () => {
    assert.equal(isGenericBoardName('Movement Boulder — Kilter', 'kilter'), false);
    assert.equal(isGenericBoardName('Basecamp Tension 12x12', 'tension'), false);
    assert.equal(isGenericBoardName('Kilter Board', 'tension'), false);
  });
});

void describe('chooseMetadataDonor', () => {
  void it('prefers a loser with a gymId', () => {
    const donor = chooseMetadataDonor([
      board({ id: 1, gymId: null, ownerId: SYSTEM_USER_ID }),
      board({ id: 2, gymId: 55, ownerId: 'owner-2' }),
    ]);
    assert.equal(donor?.id, 2);
  });

  void it('prefers a system-owned loser when none have a gymId', () => {
    const donor = chooseMetadataDonor([
      board({ id: 1, gymId: null, ownerId: 'owner-1' }),
      board({ id: 2, gymId: null, ownerId: SYSTEM_USER_ID }),
    ]);
    assert.equal(donor?.id, 2);
  });

  void it('prefers system-owned within the gym-having pool', () => {
    const donor = chooseMetadataDonor([
      board({ id: 1, gymId: 10, ownerId: 'owner-1' }),
      board({ id: 2, gymId: 20, ownerId: SYSTEM_USER_ID }),
    ]);
    assert.equal(donor?.id, 2);
  });

  void it('falls back to lowest id', () => {
    const donor = chooseMetadataDonor([
      board({ id: 7, gymId: null, ownerId: 'owner-7' }),
      board({ id: 3, gymId: null, ownerId: 'owner-3' }),
    ]);
    assert.equal(donor?.id, 3);
  });

  void it('returns null with no losers', () => {
    assert.equal(chooseMetadataDonor([]), null);
  });

  void it('limits a public survivor to public metadata donors', () => {
    const donor = chooseMetadataDonor(
      [board({ id: 1, isPublic: false, gymId: 10 }), board({ id: 2, isPublic: true, gymId: null })],
      true,
    );
    assert.equal(donor?.id, 2);
  });

  void it('returns null when a public survivor has no public losers', () => {
    assert.equal(chooseMetadataDonor([board({ id: 1, isPublic: false, gymId: 10 })], true), null);
  });
});

// shared-schema re-implements set-id normalisation (`normalizeSetIdsForCompare`)
// because it cannot import @boardsesh/board-config (board-config depends on
// shared-schema — importing back would form a cycle). This parity suite is the
// tripwire: if either normaliser changes behaviour, the duplicate-serial UX and
// the dedupe's cluster grouping would silently disagree about which configs
// match. packages/db depends on BOTH packages, so the comparison lives here.
void describe('set-id normalisation parity (board-config vs shared-schema)', () => {
  const representativeInputs = ['1,2,3', '3,2,1', '26,27', ' 27 , 26 ', '1,,2', '20', '', '10,2,1', '007,7', 'a,b,a'];

  void it('normaliseSetIds and normalizeSetIdsForCompare agree on representative inputs', () => {
    for (const input of representativeInputs) {
      assert.equal(
        normalizeSetIdsForCompare(input),
        normaliseSetIds(input),
        `normalisers disagree for input: ${JSON.stringify(input)}`,
      );
    }
  });
});
