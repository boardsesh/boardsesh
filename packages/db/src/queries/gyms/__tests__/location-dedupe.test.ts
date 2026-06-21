import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseCanonicalGymCandidate,
  distanceMeters,
  groupPhysicalGymCandidates,
  gymCompletenessScore,
  normalizeGymName,
  type CanonicalGymCandidate,
} from '../location-dedupe';

function candidate(overrides: Partial<CanonicalGymCandidate>): CanonicalGymCandidate {
  return {
    id: 1,
    uuid: 'gym-1',
    name: 'Sandbox Bouldering',
    address: null,
    contactEmail: null,
    contactPhone: null,
    description: null,
    imageUrl: null,
    latitude: -33.83541,
    longitude: 151.05309,
    createdAt: '2025-01-01T00:00:00.000Z',
    boardCount: 0,
    memberCount: 0,
    followerCount: 0,
    commentCount: 0,
    ...overrides,
  };
}

void describe('normalizeGymName', () => {
  void it('normalizes case and repeated whitespace', () => {
    assert.equal(normalizeGymName('  Sandbox   Bouldering\t'), 'sandbox bouldering');
  });
});

void describe('distanceMeters', () => {
  void it('returns small distances for near-identical coordinates', () => {
    assert.ok(distanceMeters(candidate({}), candidate({ latitude: -33.83542, longitude: 151.0531 })) < 2);
  });
});

void describe('chooseCanonicalGymCandidate', () => {
  void it('prefers the most complete gym row', () => {
    const sparseGym = candidate({ id: 1299, uuid: 'sparse', createdAt: '2024-01-01T00:00:00.000Z' });
    const richGym = candidate({
      id: 845,
      uuid: 'rich',
      address: 'A2/27-29 Fariola St, Silverwater, AU',
      createdAt: '2025-01-01T00:00:00.000Z',
    });

    assert.equal(chooseCanonicalGymCandidate([sparseGym, richGym])?.id, 845);
    assert.ok(gymCompletenessScore(richGym) > gymCompletenessScore(sparseGym));
  });

  void it('uses earliest creation date and then id as stable tie-breakers', () => {
    const olderGym = candidate({ id: 20, uuid: 'older', createdAt: '2023-01-01T00:00:00.000Z' });
    const newerGym = candidate({ id: 10, uuid: 'newer', createdAt: '2024-01-01T00:00:00.000Z' });
    const firstIdGym = candidate({ id: 5, uuid: 'first-id', createdAt: '2024-01-01T00:00:00.000Z' });
    const secondIdGym = candidate({ id: 6, uuid: 'second-id', createdAt: '2024-01-01T00:00:00.000Z' });

    assert.equal(chooseCanonicalGymCandidate([newerGym, olderGym])?.id, 20);
    assert.equal(chooseCanonicalGymCandidate([secondIdGym, firstIdGym])?.id, 5);
  });
});

void describe('groupPhysicalGymCandidates', () => {
  void it('groups same-name gyms within the physical match distance', () => {
    const kilterGym = candidate({ id: 845, uuid: 'kilter', address: 'A2/27-29 Fariola St, Silverwater, AU' });
    const tensionGym = candidate({ id: 1299, uuid: 'tension', latitude: -33.8354101, longitude: 151.0530901 });

    const clusters = groupPhysicalGymCandidates([tensionGym, kilterGym]);

    assert.equal(clusters.length, 1);
    assert.deepEqual(
      clusters[0]?.gyms.map((gym) => gym.id).sort((firstId, secondId) => firstId - secondId),
      [845, 1299],
    );
  });

  void it('does not group different names or far-away locations', () => {
    const sandboxGym = candidate({ id: 845, uuid: 'sandbox' });
    const anotherGymName = candidate({ id: 846, uuid: 'other-name', name: 'Another Bouldering' });
    const farSandboxGym = candidate({ id: 847, uuid: 'far', latitude: -33.84, longitude: 151.06 });

    assert.equal(groupPhysicalGymCandidates([sandboxGym, anotherGymName]).length, 0);
    assert.equal(groupPhysicalGymCandidates([sandboxGym, farSandboxGym]).length, 0);
  });

  void it('does not merge transitive chains that exceed the max cluster diameter', () => {
    const firstGym = candidate({ id: 1, uuid: 'first', latitude: 0, longitude: 0 });
    const middleGym = candidate({ id: 2, uuid: 'middle', latitude: 0, longitude: 0.00017 });
    const lastGym = candidate({ id: 3, uuid: 'last', latitude: 0, longitude: 0.00034 });

    const clusters = groupPhysicalGymCandidates([firstGym, middleGym, lastGym]);

    assert.equal(clusters.length, 1);
    assert.deepEqual(
      clusters[0]?.gyms.map((gym) => gym.id).sort((firstId, secondId) => firstId - secondId),
      [1, 2],
    );
  });
});
