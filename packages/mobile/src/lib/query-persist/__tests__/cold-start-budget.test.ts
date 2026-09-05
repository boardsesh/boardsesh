import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';
import { myBoardsQueryKey } from '../../graphql/query-keys';
import { dehydrateAllowlisted } from '../dehydrate';
import { PERSIST_TARGET_BYTES, PERSIST_MAX_ENTRY_BYTES, applyBudget, envelopeBytes } from '../budget';
import { PERSISTED_QUERY_RULES } from '../allowlist';

const OWNER = 'a1b2c3d4-e5f6-4789-abcd-0123456789ab';

// A board with every field the GraphQL type carries populated the way a real
// one is — long names, an owner avatar URL, set names, a location. Skimping on
// these would make the budget assertion measure a fixture rather than a phone.
function board(index: number, boardType: 'kilter' | 'tension'): UserBoard {
  return {
    __typename: 'UserBoard',
    angle: 40,
    boardId: 1000 + index,
    boardType,
    canEdit: true,
    commentCount: 12,
    createdAt: '2025-11-03T09:14:22.000Z',
    description: 'Home wall in the garage. 12x12 with the full commercial set, adjustable 20-50 degrees.',
    followerCount: 34,
    gymId: 77,
    gymName: 'Beta Bloc Amsterdam Noord',
    gymUuid: 'f0e1d2c3-b4a5-4968-8877-665544332211',
    hideLocation: false,
    isAngleAdjustable: true,
    isFollowedByMe: index % 2 === 0,
    isOwned: index % 2 === 1,
    isPublic: true,
    isUnlisted: false,
    latitude: 52.3791283,
    layoutId: 8,
    layoutName: 'Kilter Board Original Layout',
    locationName: 'Amsterdam, Noord-Holland, Netherlands',
    longitude: 4.9003269,
    name: `Beta Bloc ${boardType === 'kilter' ? 'Kilter' : 'Tension'} Board ${index + 1}`,
    ownerAvatarUrl: `https://images.boardsesh.com/avatars/${OWNER}/512.jpg`,
    ownerDisplayName: 'Marco de Jongh',
    ownerId: OWNER,
    serialNumber: `KB-2024-${1000 + index}`,
    setIds: '20,21,22,23',
    setNames: ['Original School Holds', 'Bolt Ons', 'Wooden Holds', 'Screw Ons'],
    sizeDescription: '12 x 12 with kickboard',
    sizeId: 17,
    sizeName: '12 x 12',
    slug: `beta-bloc-${boardType}-board-${index + 1}`,
    timerName: 'Rogue Echo Timer',
    totalAscents: 18422,
    uniqueClimbers: 431,
    uuid: `b0000000-0000-4000-8000-00000000000${index}`,
  } as unknown as UserBoard;
}

function grades(): unknown[] {
  // The full V0–V17 / 5.6–5.15 ladder both Aurora boards return.
  return Array.from({ length: 24 }, (_unused, index) => ({
    __typename: 'Grade',
    difficultyId: 10 + index,
    difficultyName: `V${index}`,
    frenchName: `${6 + Math.floor(index / 3)}${'abc'[index % 3]}+`,
    boardseshName: `V${index}`,
  }));
}

describe('cold-start budget', () => {
  // T-19: a realistically populated allowlisted cache — profile + 6 boards +
  // 3 gyms + 24 grades for two boards + ~9 angles for two boards — must fit the
  // 100 KB target. The synchronous MMKV read plus JSON.parse before first render
  // is what this bounds; the on-device gate measures what it costs.
  it('serializes a fully populated allowlisted cache under the 100 KB target', () => {
    const client = new QueryClient();

    client.setQueryData(['profile'], {
      __typename: 'Profile',
      id: OWNER,
      username: 'marcodejongh',
      name: 'Marco de Jongh',
      email: 'marco@example.com',
      avatarUrl: `https://images.boardsesh.com/avatars/${OWNER}/512.jpg`,
      bio: 'Kilter at 40, Tension at 10. Building Boardsesh in the evenings.',
      location: 'Amsterdam, Netherlands',
      createdAt: '2024-02-11T18:03:41.000Z',
      isPublic: true,
      followerCount: 212,
      followingCount: 178,
      totalAscents: 3841,
    });
    client.setQueryData(myBoardsQueryKey(), [
      board(0, 'kilter'),
      board(1, 'kilter'),
      board(2, 'kilter'),
      board(3, 'tension'),
      board(4, 'tension'),
      board(5, 'tension'),
    ]);
    client.setQueryData(
      ['myGyms'],
      [
        {
          __typename: 'Gym',
          id: 77,
          uuid: 'f0e1d2c3-b4a5-4968-8877-665544332211',
          name: 'Beta Bloc Amsterdam Noord',
          city: 'Amsterdam',
          country: 'Netherlands',
          memberCount: 843,
          role: 'member',
        },
        {
          __typename: 'Gym',
          id: 78,
          uuid: 'f0e1d2c3-b4a5-4968-8877-665544332212',
          name: 'Klimmuur Centraal',
          city: 'Amsterdam',
          country: 'Netherlands',
          memberCount: 1204,
          role: 'admin',
        },
        {
          __typename: 'Gym',
          id: 79,
          uuid: 'f0e1d2c3-b4a5-4968-8877-665544332213',
          name: 'Monk Bouldergym Rotterdam',
          city: 'Rotterdam',
          country: 'Netherlands',
          memberCount: 662,
          role: 'member',
        },
      ],
    );
    for (const boardType of ['kilter', 'tension'] as const) {
      client.setQueryData(['grades', boardType], grades());
      client.setQueryData(
        ['angles', boardType, 8],
        Array.from({ length: 9 }, (_unused, index) => 20 + index * 5),
      );
    }
    client.setQueryData(['publicProfile', OWNER], {
      __typename: 'PublicUserProfile',
      id: OWNER,
      username: 'marcodejongh',
      name: 'Marco de Jongh',
      avatarUrl: `https://images.boardsesh.com/avatars/${OWNER}/512.jpg`,
      bio: 'Kilter at 40, Tension at 10.',
      followerCount: 212,
      followingCount: 178,
      totalAscents: 3841,
      isFollowedByMe: false,
    });

    const entries = dehydrateAllowlisted(client, OWNER);
    // 1 profile + 1 myBoards + 1 myGyms + 2 grades + 2 angles + 1 publicProfile
    expect(entries).toHaveLength(8);

    const bytes = envelopeBytes(OWNER, Date.now(), entries);
    expect(bytes, `populated cold-start cache serialized to ${bytes} bytes`).toBeLessThan(PERSIST_TARGET_BYTES);

    // Nothing in a realistic cache should be anywhere near the per-entry cap
    // either, and no eviction should be needed to fit.
    const budgeted = applyBudget(
      entries.map((entry) => ({
        entry,
        priority: PERSISTED_QUERY_RULES.find((rule) => rule.head === entry.queryKey[0])?.priority ?? 0,
      })),
    );
    expect(budgeted.droppedOversize).toBe(0);
    expect(budgeted.droppedEvicted).toBe(0);
    for (const entry of entries) {
      expect(JSON.stringify(entry).length).toBeLessThan(PERSIST_MAX_ENTRY_BYTES);
    }
  });
});
