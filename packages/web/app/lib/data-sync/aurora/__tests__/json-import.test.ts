import { describe, it, expect, vi } from 'vite-plus/test';
import {
  auroraExportSchema,
  normalizeTimestamp,
  generateJsonImportAuroraId,
  resolveLayoutName,
  buildCoordinateMap,
  convertHoldsToFrames,
  computeEdgesFromHolds,
  generateClimbImportUuid,
  normalizeAuroraExportClimbNameForResolution,
  normalizeBoardClimbNameForAuroraExportResolution,
  isClimbNameResolutionCandidateAllowed,
  doesBoardClimbNameMatchAuroraQuestionPlaceholder,
  resolveQuestionPlaceholderClimbNameForCandidates,
  type ClimbNameResolutionCandidate,
} from '../json-import';

// Mock server-only and DB modules to avoid server-component import errors
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/db/db', () => ({
  getDb: vi.fn(),
  getPool: vi.fn(),
}));
vi.mock('@boardsesh/db/schema', () => ({
  boardseshTicks: {},
  boardClimbs: {
    uuid: 'uuid',
    name: 'name',
    boardType: 'board_type',
    isListed: 'is_listed',
    isDraft: 'is_draft',
    userId: 'user_id',
    setterId: 'setter_id',
  },
  boardClimbStats: {
    climbUuid: 'climb_uuid',
    boardType: 'board_type',
    ascensionistCount: 'ascensionist_count',
  },
  playlists: {},
  playlistClimbs: {},
  playlistOwnership: {},
}));
vi.mock('@boardsesh/db/queries', () => ({
  populateDenormalizedColumns: vi.fn(),
}));
vi.mock('@boardsesh/board-config', () => ({
  fontGradeToDifficultyId: vi.fn(),
  BOARD_IMAGE_DIMENSIONS: {},
  SUPPORTED_BOARDS: ['kilter', 'tension'],
}));
vi.mock('@boardsesh/board-constants/product-sizes', () => ({
  LAYOUTS: {
    kilter: {
      1: { id: 1, name: 'Kilter Board Original', productId: 1 },
      8: { id: 8, name: 'Kilter Board Homewall', productId: 7 },
    },
    tension: {
      9: { id: 9, name: 'Original Layout', productId: 4 },
    },
    decoy: {
      2: { id: 2, name: 'Decoy Board', productId: 1 },
    },
    touchstone: {
      1: { id: 1, name: 'Touchstone Board', productId: 1 },
    },
    grasshopper: {
      1: { id: 1, name: 'Grasshopper Board', productId: 1 },
    },
    soill: {
      1: { id: 1, name: 'So iLL Board', productId: 1 },
    },
    moonboard: {},
  },
  HOLE_PLACEMENTS: {
    kilter: {
      '1-1': [
        [1131, null, 64, 32],
        [1233, null, 64, 80],
        [1270, null, 88, 96],
      ],
      '1-20': [
        [1464, null, 4, 4],
        [1447, null, 140, 4],
      ],
    },
    tension: {},
    decoy: {
      '2-1': [
        [2001, null, 10, 10],
        [2002, null, 20, 20],
      ],
    },
    touchstone: {
      '1-1': [
        [3001, null, 10, 10],
        [3002, null, 20, 20],
      ],
    },
    grasshopper: {
      '1-1': [
        [4001, null, 10, 10],
        [4002, null, 20, 20],
      ],
    },
    soill: {
      '1-1': [
        [5001, null, 10, 10],
        [5002, null, 20, 20],
      ],
    },
    moonboard: {},
  },
}));

// ---------------------------------------------------------------------------
// normalizeTimestamp
// ---------------------------------------------------------------------------

describe('normalizeTimestamp', () => {
  it('normalizes Aurora API format (no T, no Z) to ISO', () => {
    expect(normalizeTimestamp('2024-01-15 10:30:00')).toBe('2024-01-15T10:30:00.000Z');
  });

  it('normalizes ISO format to itself', () => {
    expect(normalizeTimestamp('2024-01-15T10:30:00.000Z')).toBe('2024-01-15T10:30:00.000Z');
  });

  it('normalizes Aurora export format with microseconds', () => {
    const result = normalizeTimestamp('2025-01-01 01:01:01.000001');
    expect(result).toBe('2025-01-01T01:01:01.000Z');
  });

  it('produces the same output for equivalent timestamps in different formats', () => {
    const fromDb = normalizeTimestamp('2024-01-15 10:30:00');
    const fromImport = normalizeTimestamp('2024-01-15T10:30:00.000Z');
    expect(fromDb).toBe(fromImport);
  });

  it('handles dates with timezone offsets', () => {
    const result = normalizeTimestamp('2024-01-15T10:30:00+02:00');
    expect(result).toBe('2024-01-15T08:30:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// generateJsonImportAuroraId
// ---------------------------------------------------------------------------

describe('generateJsonImportAuroraId', () => {
  it('produces deterministic IDs for same inputs', () => {
    const id1 = generateJsonImportAuroraId('user-1', 'uuid-1', 40, '2024-01-15T10:00:00.000Z', 'ascents');
    const id2 = generateJsonImportAuroraId('user-1', 'uuid-1', 40, '2024-01-15T10:00:00.000Z', 'ascents');
    expect(id1).toBe(id2);
  });

  it('produces different IDs for different users', () => {
    const id1 = generateJsonImportAuroraId('user-1', 'uuid-1', 40, '2024-01-15T10:00:00.000Z', 'ascents');
    const id2 = generateJsonImportAuroraId('user-2', 'uuid-1', 40, '2024-01-15T10:00:00.000Z', 'ascents');
    expect(id1).not.toBe(id2);
  });

  it('produces different IDs for different climb UUIDs', () => {
    const id1 = generateJsonImportAuroraId('user-1', 'uuid-1', 40, '2024-01-15T10:00:00.000Z', 'ascents');
    const id2 = generateJsonImportAuroraId('user-1', 'uuid-2', 40, '2024-01-15T10:00:00.000Z', 'ascents');
    expect(id1).not.toBe(id2);
  });

  it('produces different IDs for different angles', () => {
    const id1 = generateJsonImportAuroraId('user-1', 'uuid-1', 40, '2024-01-15T10:00:00.000Z', 'ascents');
    const id2 = generateJsonImportAuroraId('user-1', 'uuid-1', 45, '2024-01-15T10:00:00.000Z', 'ascents');
    expect(id1).not.toBe(id2);
  });

  it('produces different IDs for different timestamps', () => {
    const id1 = generateJsonImportAuroraId('user-1', 'uuid-1', 40, '2024-01-15T10:00:00.000Z', 'ascents');
    const id2 = generateJsonImportAuroraId('user-1', 'uuid-1', 40, '2024-01-15T11:00:00.000Z', 'ascents');
    expect(id1).not.toBe(id2);
  });

  it('produces different IDs for ascents vs bids', () => {
    const id1 = generateJsonImportAuroraId('user-1', 'uuid-1', 40, '2024-01-15T10:00:00.000Z', 'ascents');
    const id2 = generateJsonImportAuroraId('user-1', 'uuid-1', 40, '2024-01-15T10:00:00.000Z', 'bids');
    expect(id1).not.toBe(id2);
  });

  it('starts with json-import- prefix', () => {
    const id = generateJsonImportAuroraId('user-1', 'uuid-1', 40, '2024-01-15T10:00:00.000Z', 'ascents');
    expect(id).toMatch(/^json-import-[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// auroraExportSchema validation
// ---------------------------------------------------------------------------

describe('auroraExportSchema', () => {
  const minimalExport = {
    user: { username: 'testuser' },
  };

  it('accepts a minimal export with only user field', () => {
    const result = auroraExportSchema.safeParse(minimalExport);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ascents).toEqual([]);
      expect(result.data.attempts).toEqual([]);
      expect(result.data.circuits).toEqual([]);
    }
  });

  it('accepts a full export with all fields', () => {
    const full = {
      user: { username: 'testuser', email_address: 'test@example.com', created_at: '2024-01-01' },
      ascents: [
        {
          climb: 'Test Climb',
          angle: 40,
          count: 1,
          stars: 3,
          climbed_at: '2024-01-15 10:00:00',
          created_at: '2024-01-15 10:00:00',
          grade: '6c',
        },
      ],
      attempts: [
        {
          climb: 'Hard Climb',
          angle: 45,
          count: 3,
          climbed_at: '2024-01-15 11:00:00',
          created_at: '2024-01-15 11:00:00',
        },
      ],
      circuits: [
        {
          name: 'My Circuit',
          color: 'FF00FF',
          created_at: '2024-01-01',
          climbs: ['Climb A', 'Climb B'],
        },
      ],
      likes: [{ climb: 'Liked Climb', created_at: '2024-01-01' }],
      follows: [{ some: 'data' }],
      walls: [],
      blocks: [],
      beta_links: [],
      climbs: [
        {
          name: 'My Climb',
          layout: 'Kilter Board Original',
          created_at: '2024-01-01',
          holds: [{ x: 64, y: 80, role: 'start' }],
        },
      ],
      agreements: [{ name: 'privacy_policy' }],
    };

    const result = auroraExportSchema.safeParse(full);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ascents).toHaveLength(1);
      expect(result.data.attempts).toHaveLength(1);
      expect(result.data.circuits).toHaveLength(1);
      expect(result.data.likes).toHaveLength(1);
    }
  });

  it('rejects export without user.username', () => {
    const result = auroraExportSchema.safeParse({ user: {} });
    expect(result.success).toBe(false);
  });

  it('rejects ascent missing required fields', () => {
    const result = auroraExportSchema.safeParse({
      user: { username: 'test' },
      ascents: [{ climb: 'Test', angle: 40 }], // missing count, stars, climbed_at, created_at, grade
    });
    expect(result.success).toBe(false);
  });

  it('rejects attempt missing required fields', () => {
    const result = auroraExportSchema.safeParse({
      user: { username: 'test' },
      attempts: [{ climb: 'Test' }], // missing angle, count, climbed_at, created_at
    });
    expect(result.success).toBe(false);
  });

  it('defaults arrays to empty when not present', () => {
    const result = auroraExportSchema.safeParse({ user: { username: 'test' } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ascents).toEqual([]);
      expect(result.data.attempts).toEqual([]);
      expect(result.data.circuits).toEqual([]);
      expect(result.data.likes).toEqual([]);
    }
  });

  it('accepts export with empty arrays', () => {
    const result = auroraExportSchema.safeParse({
      user: { username: 'test' },
      ascents: [],
      attempts: [],
      circuits: [],
      likes: [],
    });
    expect(result.success).toBe(true);
  });

  it('ignores extra unknown fields in the export', () => {
    const result = auroraExportSchema.safeParse({
      user: { username: 'test' },
      some_future_field: [1, 2, 3],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dedup key consistency (integration-style unit test)
// ---------------------------------------------------------------------------

describe('dedup key consistency', () => {
  it('generates matching keys for same timestamp in different formats', () => {
    // This tests the exact scenario that was a bug: DB returns one format,
    // import code uses another, and they must match for dedup to work.
    const dbTimestamp = '2024-01-15 10:30:00'; // What Drizzle returns
    const importTimestamp = '2024-01-15T10:30:00.000Z'; // What new Date().toISOString() produces

    const dbNormalized = normalizeTimestamp(dbTimestamp);
    const importNormalized = normalizeTimestamp(importTimestamp);

    expect(dbNormalized).toBe(importNormalized);

    // Build keys as the actual code would
    const climbUuid = 'abc-123';
    const angle = 40;
    const dbKey = `${climbUuid}:${angle}:${dbNormalized}`;
    const importKey = `${climbUuid}:${angle}:${importNormalized}`;
    expect(dbKey).toBe(importKey);
  });

  it('generates matching keys for Aurora export format with microseconds', () => {
    const exportTimestamp = '2025-01-01 01:01:01.000001'; // Aurora export format
    const isoTimestamp = '2025-01-01T01:01:01.000Z';

    expect(normalizeTimestamp(exportTimestamp)).toBe(normalizeTimestamp(isoTimestamp));
  });

  it('auroraId is consistent regardless of input timestamp format', () => {
    const id1 = generateJsonImportAuroraId(
      'user-1',
      'uuid-1',
      40,
      normalizeTimestamp('2024-01-15 10:30:00'),
      'ascents',
    );
    const id2 = generateJsonImportAuroraId(
      'user-1',
      'uuid-1',
      40,
      normalizeTimestamp('2024-01-15T10:30:00.000Z'),
      'ascents',
    );
    expect(id1).toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// Aurora export climb name resolution
// ---------------------------------------------------------------------------

describe('Aurora export climb name resolution', () => {
  function candidate(
    overrides: Partial<ClimbNameResolutionCandidate> & Pick<ClimbNameResolutionCandidate, 'uuid' | 'name'>,
  ): ClimbNameResolutionCandidate {
    return {
      ascensionistCount: 0,
      isListed: true,
      isDraft: false,
      userId: null,
      ...overrides,
    };
  }

  it('normalizes Aurora question-mark placeholders to match DB emoji names', () => {
    expect(normalizeAuroraExportClimbNameForResolution('Friend Forever?')).toBe(
      normalizeBoardClimbNameForAuroraExportResolution('Friend Forever👭'),
    );
    expect(normalizeAuroraExportClimbNameForResolution('?sssshht, Kyle!')).toBe(
      normalizeBoardClimbNameForAuroraExportResolution('🤫sssshht, Kyle!'),
    );
    expect(normalizeAuroraExportClimbNameForResolution('????NEVER LET GO ROSE!????')).toBe(
      normalizeBoardClimbNameForAuroraExportResolution('🚢🌹🚢🌹NEVER LET GO ROSE!🌹🚢🌹🚢'),
    );
  });

  it('resolves exported names whose emoji were replaced by question marks', () => {
    expect(
      resolveQuestionPlaceholderClimbNameForCandidates('Friend Forever?', [
        candidate({ uuid: 'friend-forever', name: 'Friend Forever👭', ascensionistCount: 15178 }),
      ]),
    ).toBe('friend-forever');

    expect(
      resolveQuestionPlaceholderClimbNameForCandidates('?sssshht, Kyle!', [
        candidate({ uuid: 'sssshht-kyle', name: '🤫sssshht, Kyle!', ascensionistCount: 597 }),
      ]),
    ).toBe('sssshht-kyle');

    expect(
      resolveQuestionPlaceholderClimbNameForCandidates('????NEVER LET GO ROSE!????', [
        candidate({ uuid: 'rose', name: '🚢🌹🚢🌹NEVER LET GO ROSE!🌹🚢🌹🚢', ascensionistCount: 7711 }),
      ]),
    ).toBe('rose');
  });

  it('requires the DB candidate to contain emoji where Aurora exported question marks', () => {
    expect(doesBoardClimbNameMatchAuroraQuestionPlaceholder('Friend Forever?', 'Friend Forever👭')).toBe(true);
    expect(doesBoardClimbNameMatchAuroraQuestionPlaceholder('Friend Forever?', 'Friend Forever')).toBe(false);

    expect(
      resolveQuestionPlaceholderClimbNameForCandidates('Friend Forever?', [
        candidate({ uuid: 'plain-base-name', name: 'Friend Forever', ascensionistCount: 99999 }),
        candidate({ uuid: 'emoji-name', name: 'Friend Forever👭', ascensionistCount: 1 }),
      ]),
    ).toBe('emoji-name');
  });

  it('normalizes DB climb names before checking the question-mark placeholder positions', () => {
    expect(doesBoardClimbNameMatchAuroraQuestionPlaceholder('Friend Forever?', 'Ｆriend Forever👭')).toBe(true);
  });

  it('checks the candidate against the specific export question-mark pattern', () => {
    expect(doesBoardClimbNameMatchAuroraQuestionPlaceholder('A?B', 'A😀B')).toBe(true);
    expect(doesBoardClimbNameMatchAuroraQuestionPlaceholder('AB?', 'A😀B')).toBe(false);
  });

  it('does not fuzzy-match unrelated question-mark names', () => {
    expect(
      resolveQuestionPlaceholderClimbNameForCandidates('Dad?', [
        candidate({ uuid: 'dad-dancing', name: 'Dad Dancing 6a+' }),
        candidate({ uuid: 'hi-dad', name: 'Hi hungry, I’m dad.' }),
      ]),
    ).toBeNull();
  });

  it('allows exact delisted catalog rows but not another user-owned private climb', () => {
    expect(
      isClimbNameResolutionCandidateAllowed(
        candidate({ uuid: 'unlisted-catalog', name: 'Stige-spillet', isListed: false, userId: null }),
      ),
    ).toBe(true);

    expect(
      isClimbNameResolutionCandidateAllowed(
        candidate({ uuid: 'other-user-private', name: 'Private Project', isListed: false, userId: 'other-user' }),
        'current-user',
      ),
    ).toBe(false);
  });

  it('allows null isDraft catalog rows as non-draft matches', () => {
    expect(
      isClimbNameResolutionCandidateAllowed(
        candidate({ uuid: 'null-draft-catalog', name: 'Stige-spillet', isDraft: null, isListed: false, userId: null }),
      ),
    ).toBe(true);
  });

  it("allows the current user's own climbs but rejects another user's drafts", () => {
    expect(
      isClimbNameResolutionCandidateAllowed(
        candidate({ uuid: 'own-draft', name: 'Project', isDraft: true, isListed: false, userId: 'current-user' }),
        'current-user',
      ),
    ).toBe(true);

    expect(
      isClimbNameResolutionCandidateAllowed(
        candidate({ uuid: 'other-draft', name: 'Project', isDraft: true, isListed: false, userId: 'other-user' }),
        'current-user',
      ),
    ).toBe(false);
  });

  it('prefers listed public matches over unlisted catalog matches', () => {
    expect(
      resolveQuestionPlaceholderClimbNameForCandidates('Friend Forever?', [
        candidate({
          uuid: 'unlisted-popular',
          name: 'Friend Forever👭',
          ascensionistCount: 99999,
          isListed: false,
          userId: null,
        }),
        candidate({ uuid: 'listed-less-popular', name: 'Friend Forever👭', ascensionistCount: 1 }),
      ]),
    ).toBe('listed-less-popular');
  });

  it("prefers the current user's own climb over an unlisted catalog match", () => {
    expect(
      resolveQuestionPlaceholderClimbNameForCandidates(
        'Friend Forever?',
        [
          candidate({
            uuid: 'unlisted-catalog',
            name: 'Friend Forever👭',
            ascensionistCount: 99999,
            isListed: false,
            userId: null,
          }),
          candidate({
            uuid: 'own-climb',
            name: 'Friend Forever👭',
            ascensionistCount: 1,
            isDraft: true,
            isListed: false,
            userId: 'current-user',
          }),
        ],
        'current-user',
      ),
    ).toBe('own-climb');
  });
});

// ---------------------------------------------------------------------------
// resolveLayoutName
// ---------------------------------------------------------------------------

describe('resolveLayoutName', () => {
  it('resolves Kilter Board Original to layout ID 1', () => {
    expect(resolveLayoutName('kilter', 'Kilter Board Original')).toBe(1);
  });

  it('resolves Kilter Board Homewall to layout ID 8', () => {
    expect(resolveLayoutName('kilter', 'Kilter Board Homewall')).toBe(8);
  });

  it('resolves Tension Original Layout to layout ID 9', () => {
    expect(resolveLayoutName('tension', 'Original Layout')).toBe(9);
  });

  it('resolves Aurora board layouts for imported draft climbs', () => {
    expect(resolveLayoutName('decoy', 'Decoy Board')).toBe(2);
    expect(resolveLayoutName('touchstone', 'Touchstone Board')).toBe(1);
    expect(resolveLayoutName('grasshopper', 'Grasshopper Board')).toBe(1);
    expect(resolveLayoutName('soill', 'So iLL Board')).toBe(1);
  });

  it('returns null for unknown layout name', () => {
    expect(resolveLayoutName('kilter', 'Nonexistent Board')).toBeNull();
  });

  it('returns null for layout name on wrong board type', () => {
    expect(resolveLayoutName('tension', 'Kilter Board Original')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildCoordinateMap
// ---------------------------------------------------------------------------

describe('buildCoordinateMap', () => {
  it('returns a non-empty map for Kilter layout 1', () => {
    const coordMap = buildCoordinateMap('kilter', 1);
    expect(coordMap.size).toBeGreaterThan(0);
  });

  it('maps known coordinates to placement IDs', () => {
    const coordMap = buildCoordinateMap('kilter', 1);
    // (64, 32) should be in the Bolt Ons set for layout 1
    expect(coordMap.has('64,32')).toBe(true);
    expect(typeof coordMap.get('64,32')).toBe('number');
  });

  it('includes coordinates from multiple sets', () => {
    const coordMap = buildCoordinateMap('kilter', 1);
    // From set 1-1 (Bolt Ons)
    expect(coordMap.has('64,32')).toBe(true);
    // From set 1-20 (Screw Ons)
    expect(coordMap.has('4,4')).toBe(true);
  });

  it('returns empty map for nonexistent layout', () => {
    const coordMap = buildCoordinateMap('kilter', 9999);
    expect(coordMap.size).toBe(0);
  });

  it('caches results for repeated calls', () => {
    const map1 = buildCoordinateMap('kilter', 1);
    const map2 = buildCoordinateMap('kilter', 1);
    expect(map1).toBe(map2); // Same reference
  });
});

// ---------------------------------------------------------------------------
// convertHoldsToFrames
// ---------------------------------------------------------------------------

describe('convertHoldsToFrames', () => {
  it('converts holds to frames string with correct format', () => {
    const coordMap = new Map([
      ['64,80', 1233],
      ['88,96', 1270],
    ]);
    const holds = [
      { x: 64, y: 80, role: 'start' },
      { x: 88, y: 96, role: 'middle' },
    ];
    const result = convertHoldsToFrames(holds, coordMap, 'kilter');
    expect(result).toBe('p1233r42p1270r43');
  });

  it('uses correct role codes for kilter', () => {
    const coordMap = new Map([
      ['10,10', 1],
      ['20,20', 2],
      ['30,30', 3],
      ['40,40', 4],
    ]);
    const holds = [
      { x: 10, y: 10, role: 'start' },
      { x: 20, y: 20, role: 'middle' },
      { x: 30, y: 30, role: 'finish' },
      { x: 40, y: 40, role: 'foot' },
    ];
    const result = convertHoldsToFrames(holds, coordMap, 'kilter');
    expect(result).toBe('p1r42p2r43p3r44p4r45');
  });

  it('uses correct role codes for tension', () => {
    const coordMap = new Map([
      ['10,10', 1],
      ['20,20', 2],
      ['30,30', 3],
      ['40,40', 4],
    ]);
    const holds = [
      { x: 10, y: 10, role: 'start' },
      { x: 20, y: 20, role: 'middle' },
      { x: 30, y: 30, role: 'finish' },
      { x: 40, y: 40, role: 'foot' },
    ];
    const result = convertHoldsToFrames(holds, coordMap, 'tension');
    expect(result).toBe('p1r1p2r2p3r3p4r4');
  });

  it('skips holds with unresolvable coordinates', () => {
    const coordMap = new Map([['64,80', 1233]]);
    const holds = [
      { x: 64, y: 80, role: 'start' },
      { x: 999, y: 999, role: 'middle' }, // not in map
    ];
    const result = convertHoldsToFrames(holds, coordMap, 'kilter');
    expect(result).toBe('p1233r42');
  });

  it('skips holds with unknown role names', () => {
    const coordMap = new Map([
      ['10,10', 1],
      ['20,20', 2],
    ]);
    const holds = [
      { x: 10, y: 10, role: 'start' },
      { x: 20, y: 20, role: 'unknown_role' },
    ];
    const result = convertHoldsToFrames(holds, coordMap, 'kilter');
    expect(result).toBe('p1r42');
  });

  it('returns null for empty holds array', () => {
    const coordMap = new Map([['10,10', 1]]);
    expect(convertHoldsToFrames([], coordMap, 'kilter')).toBeNull();
  });

  it('returns null when no holds resolve', () => {
    const coordMap = new Map([['10,10', 1]]);
    const holds = [{ x: 999, y: 999, role: 'start' }];
    expect(convertHoldsToFrames(holds, coordMap, 'kilter')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeEdgesFromHolds
// ---------------------------------------------------------------------------

describe('computeEdgesFromHolds', () => {
  it('computes bounding box from hold coordinates', () => {
    const holds = [
      { x: 10, y: 20 },
      { x: 50, y: 80 },
      { x: 30, y: 40 },
    ];
    expect(computeEdgesFromHolds(holds)).toEqual({
      edgeLeft: 10,
      edgeRight: 50,
      edgeBottom: 20,
      edgeTop: 80,
    });
  });

  it('handles single hold', () => {
    const holds = [{ x: 25, y: 75 }];
    expect(computeEdgesFromHolds(holds)).toEqual({
      edgeLeft: 25,
      edgeRight: 25,
      edgeBottom: 75,
      edgeTop: 75,
    });
  });

  it('returns null for empty array', () => {
    expect(computeEdgesFromHolds([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// generateClimbImportUuid
// ---------------------------------------------------------------------------

describe('generateClimbImportUuid', () => {
  it('produces deterministic UUIDs', () => {
    const id1 = generateClimbImportUuid('user-1', 'kilter', 1, 'My Climb', '2024-01-01');
    const id2 = generateClimbImportUuid('user-1', 'kilter', 1, 'My Climb', '2024-01-01');
    expect(id1).toBe(id2);
  });

  it('starts with json-import-climb- prefix', () => {
    const id = generateClimbImportUuid('user-1', 'kilter', 1, 'My Climb', '2024-01-01');
    expect(id).toMatch(/^json-import-climb-[0-9a-f]{32}$/);
  });

  it('produces different UUIDs for different users', () => {
    const id1 = generateClimbImportUuid('user-1', 'kilter', 1, 'My Climb', '2024-01-01');
    const id2 = generateClimbImportUuid('user-2', 'kilter', 1, 'My Climb', '2024-01-01');
    expect(id1).not.toBe(id2);
  });

  it('produces different UUIDs for different climb names', () => {
    const id1 = generateClimbImportUuid('user-1', 'kilter', 1, 'Climb A', '2024-01-01');
    const id2 = generateClimbImportUuid('user-1', 'kilter', 1, 'Climb B', '2024-01-01');
    expect(id1).not.toBe(id2);
  });

  it('produces different UUIDs for different board types', () => {
    const id1 = generateClimbImportUuid('user-1', 'kilter', 1, 'My Climb', '2024-01-01');
    const id2 = generateClimbImportUuid('user-1', 'tension', 1, 'My Climb', '2024-01-01');
    expect(id1).not.toBe(id2);
  });

  it('produces different UUIDs for different timestamps', () => {
    const id1 = generateClimbImportUuid('user-1', 'kilter', 1, 'My Climb', '2024-01-01');
    const id2 = generateClimbImportUuid('user-1', 'kilter', 1, 'My Climb', '2024-06-01');
    expect(id1).not.toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// auroraExportSchema - climb validation
// ---------------------------------------------------------------------------

describe('auroraExportSchema - climb validation', () => {
  it('accepts climbs with valid holds', () => {
    const result = auroraExportSchema.safeParse({
      user: { username: 'test' },
      climbs: [
        {
          name: 'My Draft',
          layout: 'Kilter Board Original',
          created_at: '2024-01-01 00:00:00',
          is_draft: true,
          holds: [{ x: 64, y: 80, role: 'start' }],
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.climbs).toHaveLength(1);
      expect(result.data.climbs[0].name).toBe('My Draft');
    }
  });

  it('accepts climbs with is_draft null (published)', () => {
    const result = auroraExportSchema.safeParse({
      user: { username: 'test' },
      climbs: [
        {
          name: 'Published Climb',
          layout: 'Kilter Board Original',
          created_at: '2024-01-01',
          is_draft: null,
          holds: [{ x: 64, y: 80, role: 'start' }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts climbs with optional description', () => {
    const result = auroraExportSchema.safeParse({
      user: { username: 'test' },
      climbs: [
        {
          name: 'Described Climb',
          layout: 'Kilter Board Original',
          created_at: '2024-01-01',
          holds: [{ x: 10, y: 20, role: 'start' }],
          description: 'A fun climb',
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.climbs[0].description).toBe('A fun climb');
    }
  });

  it('defaults climbs to empty array when not present', () => {
    const result = auroraExportSchema.safeParse({ user: { username: 'test' } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.climbs).toEqual([]);
    }
  });

  it('rejects climb missing holds', () => {
    const result = auroraExportSchema.safeParse({
      user: { username: 'test' },
      climbs: [{ name: 'No Holds', layout: 'Kilter', created_at: '2024-01-01' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects climb with invalid hold (missing role)', () => {
    const result = auroraExportSchema.safeParse({
      user: { username: 'test' },
      climbs: [
        {
          name: 'Bad Hold',
          layout: 'Kilter',
          created_at: '2024-01-01',
          holds: [{ x: 10, y: 20 }], // missing role
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// New Aurora board draft-climb import support
// ---------------------------------------------------------------------------

describe('buildCoordinateMap for new Aurora boards', () => {
  it('builds coordinate maps for newly supported Aurora boards', () => {
    expect(buildCoordinateMap('decoy', 2).get('10,10')).toBe(2001);
    expect(buildCoordinateMap('touchstone', 1).get('10,10')).toBe(3001);
    expect(buildCoordinateMap('grasshopper', 1).get('10,10')).toBe(4001);
    expect(buildCoordinateMap('soill', 1).get('10,10')).toBe(5001);
  });
});

describe('convertHoldsToFrames for new Aurora boards', () => {
  const tensionStyleBoards = ['decoy', 'touchstone', 'grasshopper', 'soill'] as const;

  for (const boardType of tensionStyleBoards) {
    it(`uses Tension-style role codes for ${boardType}`, () => {
      const coordMap = new Map([
        ['10,10', 1],
        ['20,20', 2],
        ['30,30', 3],
        ['40,40', 4],
      ]);
      const holds = [
        { x: 10, y: 10, role: 'start' },
        { x: 20, y: 20, role: 'middle' },
        { x: 30, y: 30, role: 'finish' },
        { x: 40, y: 40, role: 'foot' },
      ];

      expect(convertHoldsToFrames(holds, coordMap, boardType)).toBe('p1r1p2r2p3r3p4r4');
    });
  }
});
