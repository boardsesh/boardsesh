import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MIN_OWNERSHIP_SPREAD_MINUTES,
  classifyCrossLinkedPlaylist,
  isDuplicateAccountEmailPair,
  isJsonImportCircuit,
  planCrossLinkedPlaylistRepairs,
  selectApplyablePlans,
  summarizeRepairPlans,
  type CrossLinkedPlaylist,
  type PlaylistOwnerRow,
} from './repair-cross-linked-playlists-helpers.js';

const CREATOR_AT = new Date('2026-03-29T10:00:00Z');
const ADOPTER_AT = new Date('2026-03-29T12:00:00Z');

function owner(overrides: Partial<PlaylistOwnerRow> = {}): PlaylistOwnerRow {
  return {
    userId: 'user-creator',
    userEmail: 'm.jongh88@gmail.com',
    role: 'owner',
    createdAt: CREATOR_AT,
    ...overrides,
  };
}

function playlist(overrides: Partial<CrossLinkedPlaylist> = {}): CrossLinkedPlaylist {
  return {
    playlistId: '101',
    playlistUuid: 'playlist-uuid-101',
    name: 'Warmups',
    boardType: 'kilter',
    auroraId: 'json-import-circuit-0123456789abcdef0123456789abcdef',
    kilterId: null,
    isPublic: false,
    climbCount: 7,
    owners: [owner(), owner({ userId: 'user-adopter', userEmail: 'test22@boardsesh.com', createdAt: ADOPTER_AT })],
    ...overrides,
  };
}

test('the creator is the earliest ownership row regardless of input order', () => {
  const reversedOrder = playlist({
    owners: [owner({ userId: 'user-adopter', userEmail: 'test22@boardsesh.com', createdAt: ADOPTER_AT }), owner()],
  });

  const plan = classifyCrossLinkedPlaylist(reversedOrder);

  assert.equal(plan.action, 'revoke-adopter');
  assert.equal(plan.cause, 'json-import');
  assert.equal(plan.creator?.userId, 'user-creator');
  assert.equal(plan.adopter?.userId, 'user-adopter');
  assert.equal(plan.spreadMinutes, 120);
});

test('case-variant emails are deferred to merge-accounts.ts instead of being revoked', () => {
  const plan = classifyCrossLinkedPlaylist(
    playlist({
      auroraId: 'circuit-uuid-from-aurora',
      owners: [
        owner({ userId: 'user-lower', userEmail: 'pmbmosk@gmail.com' }),
        owner({ userId: 'user-upper', userEmail: 'Pmbmosk@gmail.com', createdAt: ADOPTER_AT }),
      ],
    }),
  );

  assert.equal(plan.action, 'defer-to-account-merge');
  assert.equal(plan.cause, 'duplicate-accounts');
  assert.equal(plan.creator?.userId, 'user-lower');
  assert.equal(plan.adopter?.userId, 'user-upper');
});

test('a non-json-import circuit owned by two genuinely different people is refused', () => {
  const plan = classifyCrossLinkedPlaylist(
    playlist({
      auroraId: 'circuit-uuid-from-aurora',
      owners: [owner(), owner({ userId: 'user-other', userEmail: 'someone@example.com', createdAt: ADOPTER_AT })],
    }),
  );

  assert.equal(plan.action, 'refuse');
  assert.equal(plan.cause, 'unknown');
  // Creator/adopter are still reported so a human can decide.
  assert.equal(plan.creator?.userId, 'user-creator');
  assert.equal(plan.adopter?.userId, 'user-other');
});

test('a three-way cross-link is refused without picking a creator', () => {
  const plan = classifyCrossLinkedPlaylist(
    playlist({
      owners: [
        owner(),
        owner({ userId: 'user-adopter', userEmail: 'test22@boardsesh.com', createdAt: ADOPTER_AT }),
        owner({ userId: 'user-third', userEmail: 'third@example.com', createdAt: new Date('2026-03-30T12:00:00Z') }),
      ],
    }),
  );

  assert.equal(plan.action, 'refuse');
  assert.equal(plan.creator, null);
  assert.equal(plan.adopter, null);
  assert.match(plan.reason, /three-way/);
});

test('deliberate sharing (an editor or viewer row) is refused, not revoked', () => {
  const plan = classifyCrossLinkedPlaylist(
    playlist({
      owners: [
        owner(),
        owner({ userId: 'user-editor', userEmail: 'mate@example.com', role: 'editor', createdAt: ADOPTER_AT }),
      ],
    }),
  );

  assert.equal(plan.action, 'refuse');
  assert.match(plan.reason, /editor/);
});

test('ownership rows closer together than the threshold are refused', () => {
  const plan = classifyCrossLinkedPlaylist(
    playlist({
      owners: [
        owner(),
        owner({
          userId: 'user-adopter',
          userEmail: 'test22@boardsesh.com',
          createdAt: new Date(CREATOR_AT.getTime() + 5 * 60_000),
        }),
      ],
    }),
  );

  assert.equal(plan.action, 'refuse');
  assert.equal(plan.spreadMinutes, 5);
  assert.match(plan.reason, new RegExp(`threshold ${DEFAULT_MIN_OWNERSHIP_SPREAD_MINUTES} min`));
});

test('a sub-threshold duplicate-account pair is refused but still named as a merge candidate', () => {
  const plan = classifyCrossLinkedPlaylist(
    playlist({
      auroraId: 'circuit-uuid-from-aurora',
      owners: [
        owner({ userId: 'user-lower', userEmail: 'pmbmosk@gmail.com' }),
        owner({
          userId: 'user-upper',
          userEmail: 'Pmbmosk@gmail.com',
          createdAt: new Date(CREATOR_AT.getTime() + 60_000),
        }),
      ],
    }),
  );

  assert.equal(plan.action, 'refuse');
  assert.equal(plan.cause, 'duplicate-accounts');
  assert.match(plan.reason, /merge-accounts\.ts/);
});

test('the spread threshold is configurable', () => {
  const closePair = playlist({
    owners: [
      owner(),
      owner({
        userId: 'user-adopter',
        userEmail: 'test22@boardsesh.com',
        createdAt: new Date(CREATOR_AT.getTime() + 5 * 60_000),
      }),
    ],
  });

  assert.equal(classifyCrossLinkedPlaylist(closePair, { minSpreadMinutes: 1 }).action, 'revoke-adopter');
  assert.equal(classifyCrossLinkedPlaylist(closePair, { minSpreadMinutes: 60 }).action, 'refuse');
});

test('a single-owner playlist is refused rather than repaired', () => {
  const plan = classifyCrossLinkedPlaylist(playlist({ owners: [owner()] }));

  assert.equal(plan.action, 'refuse');
  assert.match(plan.reason, /not a cross-link/);
});

test('an unreadable created_at is refused instead of ordered arbitrarily', () => {
  const plan = classifyCrossLinkedPlaylist(
    playlist({
      owners: [
        owner(),
        owner({ userId: 'user-adopter', userEmail: 'test22@boardsesh.com', createdAt: new Date('not a date') }),
      ],
    }),
  );

  assert.equal(plan.action, 'refuse');
  assert.match(plan.reason, /created_at/);
});

test('isJsonImportCircuit only matches the importer prefix', () => {
  assert.equal(isJsonImportCircuit('json-import-circuit-abc'), true);
  assert.equal(isJsonImportCircuit('circuit-uuid-from-aurora'), false);
  assert.equal(isJsonImportCircuit(null), false);
});

test('isDuplicateAccountEmailPair ignores case and surrounding whitespace, but not a missing email', () => {
  assert.equal(isDuplicateAccountEmailPair('Pmbmosk@gmail.com', ' pmbmosk@gmail.com '), true);
  assert.equal(isDuplicateAccountEmailPair('a@example.com', 'b@example.com'), false);
  assert.equal(isDuplicateAccountEmailPair(null, 'a@example.com'), false);
  assert.equal(isDuplicateAccountEmailPair('a@example.com', null), false);
});

test('summarize and selectApplyablePlans keep merge candidates out unless opted in', () => {
  const plans = planCrossLinkedPlaylistRepairs([
    playlist(),
    playlist({
      playlistId: '102',
      playlistUuid: 'playlist-uuid-102',
      auroraId: 'circuit-uuid-from-aurora',
      owners: [
        owner({ userId: 'user-lower', userEmail: 'pmbmosk@gmail.com' }),
        owner({ userId: 'user-upper', userEmail: 'Pmbmosk@gmail.com', createdAt: ADOPTER_AT }),
      ],
    }),
    playlist({
      playlistId: '103',
      playlistUuid: 'playlist-uuid-103',
      auroraId: 'circuit-uuid-from-aurora',
      owners: [owner(), owner({ userId: 'user-other', userEmail: 'someone@example.com', createdAt: ADOPTER_AT })],
    }),
  ]);

  assert.deepEqual(summarizeRepairPlans(plans), {
    playlists: 3,
    ownershipRows: 6,
    revokeAdopter: 1,
    deferToAccountMerge: 1,
    refused: 1,
  });

  assert.deepEqual(
    selectApplyablePlans(plans, { includeMergeCandidates: false }).map((plan) => plan.playlist.playlistId),
    ['101'],
  );
  assert.deepEqual(
    selectApplyablePlans(plans, { includeMergeCandidates: true }).map((plan) => plan.playlist.playlistId),
    ['101', '102'],
  );
});

test('a duplicate ownership row for one user is refused, not treated as the adopter', () => {
  const plan = classifyCrossLinkedPlaylist(
    playlist({
      owners: [
        owner(),
        owner({ createdAt: new Date('2026-03-29T11:00:00Z') }),
        owner({ userId: 'user-adopter', userEmail: 'test22@boardsesh.com', createdAt: ADOPTER_AT }),
      ],
    }),
  );

  assert.equal(plan.action, 'refuse');
  assert.equal(plan.adopter, null);
  assert.match(plan.reason, /3 ownership rows for 2 users/);
});
