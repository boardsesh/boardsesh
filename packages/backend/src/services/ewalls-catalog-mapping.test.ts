import { describe, expect, it } from 'vite-plus/test';
import type { EwallsBootstrap, EwallsDelta, EwallsRecord } from '@boardsesh/quantum-sync';
import {
  getQuantumBundledGeometry,
  getQuantumSourceDiodeBindings,
  QUANTUM_HARDWARE_FINGERPRINT,
  type QuantumSourceDiodeBinding,
} from '@boardsesh/board-constants/quantum';
import { BOULDER_GRADES } from '@boardsesh/board-constants/boulder-grade-mapping';
import { prepareEwallsCatalog, normalizeEwallsRouteId } from './ewalls-catalog-mapping';
import { quantumCanonicalClimbUuid } from './quantum-catalog-mapping';

const NOW = new Date('2026-11-19T18:00:00.000Z');
const ROUTE_ID = '11111111-1111-4111-8111-111111111111';
const SHARED = getQuantumSourceDiodeBindings(9101, 9203)!.slice(0, 3);
const EMPTY_CHANGES = { upsert: [], deleted: [] } as const;
const ACCOUNT = { ascents: EMPTY_CHANGES, favorites: EMPTY_CHANGES, projects: EMPTY_CHANGES };

function diode(binding: QuantumSourceDiodeBinding): EwallsRecord {
  return {
    id: binding.diodeUuid,
    autocadId: binding.autocadId,
    idLedNode: binding.idLedNode,
    type: binding.type,
    x: binding.x,
    y: binding.y,
    z: binding.z,
  };
}

function route(overrides: EwallsRecord = {}): EwallsRecord & { id: string } {
  return {
    id: ROUTE_ID,
    name: 'Synthetic eWalls climb',
    type: 'big',
    minVariant: 'small',
    angle: 35,
    grade: '[19]',
    disabled: false,
    lights: SHARED.map((binding, index) => ({ diode: { id: binding.diodeUuid }, step: index + 1 })),
    ...overrides,
  };
}

function bootstrap(
  sourceRoute = route(),
  diodes: readonly EwallsRecord[] | null = SHARED.map(diode),
  forcedType = 'big',
): EwallsBootstrap {
  return {
    kind: 'bootstrap',
    baseCheckpoint: null,
    scope: { board: '', forcedType },
    checkpoint: 'opaque-server-checkpoint',
    routes: { upsert: [sourceRoute], deleted: [] },
    diodes,
    account: ACCOUNT,
  };
}

describe('direct eWalls catalog normalization', () => {
  it('binds real bundled diode identities, retains the wire UUID, and maps the documented grade and light roles', () => {
    const sourceRoute = route({
      angle: '35',
      rating: '4.5',
      ascents: '12',
      plays: '20',
      createdAt: '2026-11-18T10:00:00+02:00',
      tags: ['technical', 'sloper'],
      tips: 'Synthetic beta',
      standard: true,
      edge: 0,
      routeSetter: { id: 'external-setter', firstName: 'Synthetic', lastName: 'Setter' },
      lights: [
        { diode: { id: SHARED[0]!.diodeUuid }, step: 1 },
        { diodeId: SHARED[1]!.diodeUuid, step: 2 },
        { id: SHARED[2]!.diodeUuid, step: 3 },
      ],
    });
    const prepared = prepareEwallsCatalog(bootstrap(sourceRoute), undefined, NOW);
    const climbUuid = quantumCanonicalClimbUuid(9101, ROUTE_ID);
    expect(prepared.upstreamRouteIds).toEqual([ROUTE_ID]);
    expect(prepared.catalog.climbs).toHaveLength(1);
    expect(prepared.catalog.climbs[0]).toMatchObject({
      uuid: climbUuid,
      controllerRouteUuid: ROUTE_ID,
      layoutId: 9101,
      compatibleSizeIds: [9201, 9202, 9203],
      angle: 35,
      setterId: null,
      userId: null,
      setterUsername: 'Synthetic Setter',
      createdAt: '2026-11-18T08:00:00.000Z',
      publishedAt: null,
      isListed: true,
      frames: SHARED.map((binding, index) => `p${binding.placementId}r${index + 12}`).join(''),
      characteristics: ['quantum_standard'],
    });
    expect(prepared.catalog.holds.map((hold) => hold.holdState)).toEqual(['STARTING', 'HAND', 'FINISH']);
    expect(prepared.catalog.aliases).toEqual([
      { aliasUuid: climbUuid, canonicalUuid: climbUuid },
      { aliasUuid: ROUTE_ID, canonicalUuid: climbUuid },
    ]);
    expect(prepared.catalog.stats[0]).toMatchObject({
      displayDifficulty: 21,
      difficultyAverage: 21,
      upstreamAscensionistCount: 12,
      ascensionistCount: 12,
      upstreamQualityAverage: 4.5,
      qualityAverage: 4.5,
      upstreamSyncedAt: NOW.toISOString(),
    });
    expect(
      BOULDER_GRADES.find((grade) => grade.difficulty_id === prepared.catalog.stats[0]!.displayDifficulty)
        ?.difficulty_name,
    ).toBe('6c+/V5');
    expect(prepared.catalog.climbs[0]!.sourceMetadata).toMatchObject({
      provider: 'ewalls',
      grade: '[19]',
      tags: ['technical', 'sloper'],
      plays: '20',
      ascents: '12',
      angle: '35',
    });
    expect(prepared.catalog.hardwareFingerprint).toBe(QUANTUM_HARDWARE_FINGERPRINT);
    expect(prepared.catalog.layouts.map((layout) => layout.id)).toEqual([9101, 9104, 9105]);
    expect(prepared.catalog.products.map((product) => product.id)).toEqual([91, 94, 95]);
    expect(prepared.catalog.leds).toHaveLength(3154);
    expect(prepared.catalog.holes).toHaveLength(2173);
  });

  it.each([
    ['big', [9201]],
    ['medium', [9201, 9202]],
    ['small', [9201, 9202, 9203]],
  ] as const)('honors route fit %s even when all holds also exist on smaller sizes', (minVariant, expectedSizes) => {
    const sourceRoute = route({ minVariant });
    // Acquisition scope is not a claim that the route fits that physical size.
    const prepared = prepareEwallsCatalog(bootstrap(sourceRoute, SHARED.map(diode), 'small'), [], NOW);
    expect(prepared.catalog.climbs[0]!.compatibleSizeIds).toEqual(expectedSizes);
  });

  it('intersects native fit with exact diode membership instead of assuming every smaller route fits', () => {
    const xl = getQuantumSourceDiodeBindings(9101, 9201)!;
    const largeIds = new Set(getQuantumSourceDiodeBindings(9101, 9202)!.map((binding) => binding.diodeUuid));
    const xlOnly = xl.find((binding) => !largeIds.has(binding.diodeUuid))!;
    const prepared = prepareEwallsCatalog(
      bootstrap(
        route({
          minVariant: 'small',
          lights: [{ diodeId: xlOnly.diodeUuid, step: 2 }],
        }),
        [diode(xlOnly)],
        'small',
      ),
      [],
      NOW,
    );
    expect(prepared.catalog.climbs[0]!.compatibleSizeIds).toEqual([9201]);
    const position = getQuantumBundledGeometry(9101, 9201)!.placements.find(
      (hold) => hold.placementId === xlOnly.placementId,
    )!;
    expect(prepared.catalog.climbs[0]).toMatchObject({
      edgeLeft: position.x,
      edgeRight: position.x,
      edgeTop: position.y,
      edgeBottom: position.y,
    });
  });

  it.each([
    ['xsmall', 9104, 9204],
    ['belay', 9105, 9205],
  ] as const)('keeps %s in its own family and product', (type, layoutId, sizeId) => {
    const binding = getQuantumSourceDiodeBindings(layoutId, sizeId)![0]!;
    const prepared = prepareEwallsCatalog(
      bootstrap(
        route({
          type,
          minVariant: type,
          lights: [{ diode: { id: binding.diodeUuid }, step: 2 }],
        }),
        [diode(binding)],
        type,
      ),
      [],
      NOW,
    );
    expect(prepared.catalog.climbs[0]).toMatchObject({
      uuid: quantumCanonicalClimbUuid(layoutId, ROUTE_ID),
      layoutId,
      compatibleSizeIds: [sizeId],
    });
    expect(() => prepareEwallsCatalog(bootstrap(route({ type, minVariant: type })), [], NOW)).toThrow(
      /another physical family/,
    );
  });

  it('requires a verified upstream UUID/address pair and ignores misleading ledId or placementId fields', () => {
    const known = SHARED[0]!;
    const input = bootstrap(route({ lights: [{ diodeId: known.diodeUuid, step: 2 }] }), [
      { ...diode(known), autocadId: known.autocadId + 1, ledId: known.autocadId, placementId: known.placementId },
    ]);
    expect(() => prepareEwallsCatalog(input, [], NOW)).toThrow(/wire address remap/);
    expect(() =>
      prepareEwallsCatalog(
        { ...input, diodes: [{ ...diode(known), id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] },
        [],
        NOW,
      ),
    ).toThrow(/UUID does not belong/);
    expect(() =>
      prepareEwallsCatalog(
        { ...input, diodes: [diode(known), { ...diode(known), id: known.diodeUuid.toUpperCase() }] },
        [],
        NOW,
      ),
    ).toThrow(/duplicate diode UUID/);
  });

  it.each([
    { x: 'not-a-number' },
    { x: SHARED[0]!.x + 0.01 },
    { y: SHARED[0]!.y + 0.01 },
    { idLedNode: 'changed' },
    { type: 'other' },
  ])('rejects supplied physical fields that contradict the fixed source map: %o', (changed) => {
    expect(() => prepareEwallsCatalog(bootstrap(route(), [{ ...diode(SHARED[0]!), ...changed }]), [], NOW)).toThrow(
      /diode .* changed/,
    );
  });

  it.each([undefined, null, '1', 0, -1, 4, 2.5])(
    'rejects unknown or missing step %s instead of guessing a hand hold',
    (step) => {
      expect(() =>
        prepareEwallsCatalog(bootstrap(route({ lights: [{ diodeId: SHARED[0]!.diodeUuid, step }] })), [], NOW),
      ).toThrow(/light step/);
    },
  );

  it('rejects missing, duplicate, or unverified route lights without truncating the climb', () => {
    for (const lights of [
      [],
      [{ step: 1 }],
      [{ diodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', step: 1 }],
      [
        { diodeId: SHARED[0]!.diodeUuid, step: 1 },
        { diodeId: SHARED[0]!.diodeUuid, step: 3 },
      ],
    ]) {
      expect(() => prepareEwallsCatalog(bootstrap(route({ lights })), [], NOW)).toThrow(/light|association/);
    }
    expect(() => prepareEwallsCatalog(bootstrap(route(), null), [], NOW)).toThrow(/no verified source binding/);
  });

  it('keeps every imported diode while the independent authoring/activation cap stays 92', () => {
    const bindings = getQuantumSourceDiodeBindings(9101, 9201)!.slice(0, 128);
    const prepared = prepareEwallsCatalog(
      bootstrap(
        route({
          minVariant: 'big',
          lights: bindings.map((binding) => ({ diodeId: binding.diodeUuid, step: 2 })),
        }),
        bindings.map(diode),
      ),
      [],
      NOW,
    );
    expect(prepared.catalog.holds).toHaveLength(128);
    expect(prepared.catalog.climbs[0]!.frames.match(/p\d+r\d+/g)).toHaveLength(128);
    expect(prepared.catalog.products[0]!.maxCountInFrame).toBe(92);
  });

  it('uses prior verified diode records on a delta, and never merges an incomplete replacement silently', () => {
    const initial = bootstrap();
    const delta: EwallsDelta = {
      ...initial,
      kind: 'delta',
      baseCheckpoint: initial.checkpoint,
      checkpoint: 'next',
      diodes: null,
    };
    const prior = SHARED.map(diode);
    expect(prepareEwallsCatalog(delta, prior, NOW).catalog.climbs[0]!.frames).toBe(
      prepareEwallsCatalog(initial, [], NOW).catalog.climbs[0]!.frames,
    );
    expect(prepareEwallsCatalog({ ...delta, diodes: [] }, prior, NOW).diodes).toEqual(prior);
    expect(() => prepareEwallsCatalog({ ...delta, diodes: prior.slice(0, 1) }, prior, NOW)).toThrow(
      /no verified source binding/,
    );
  });

  it('preserves unknown representations without inventing dates, zero counts, ratings, or angles', () => {
    const sourceRoute = route({
      angle: 'unknown',
      grade: { label: 'undocumented' },
      rating: 'NaN',
      ascents: '',
      createdAt: 1700000000,
      updatedAt: 'uninterpreted',
      publishedAt: '2026-11-18T10:00:00',
    });
    const prepared = prepareEwallsCatalog(bootstrap(sourceRoute), [], NOW);
    expect(prepared.catalog.stats).toEqual([]);
    expect(prepared.catalog.climbs[0]).toMatchObject({
      angle: null,
      createdAt: null,
      publishedAt: null,
      sourceMetadata: {
        angle: 'unknown',
        grade: { label: 'undocumented' },
        rating: 'NaN',
        ascents: '',
        createdAt: 1700000000,
      },
    });
    const withAngle = prepareEwallsCatalog(bootstrap({ ...sourceRoute, angle: -10 }), [], NOW);
    expect(withAngle.catalog.stats[0]).toMatchObject({
      angle: -10,
      displayDifficulty: null,
      difficultyAverage: null,
      ascensionistCount: null,
      upstreamAscensionistCount: null,
      qualityAverage: null,
      upstreamQualityAverage: null,
    });
    expect(JSON.stringify(withAngle.catalog)).not.toContain('NaN":');
  });

  it('accepts explicit zero values while rejecting out-of-range and nonnumeric values as unknown', () => {
    const prepared = prepareEwallsCatalog(bootstrap(route({ angle: 0, rating: 0, ascents: 0 })), [], NOW);
    expect(prepared.catalog.stats[0]).toMatchObject({ angle: 0, ascensionistCount: 0, qualityAverage: 0 });
    for (const invalid of [NaN, Infinity, true, '', ' ', '0x10', -1, 2.5, 2_147_483_648]) {
      const result = prepareEwallsCatalog(bootstrap(route({ ascents: invalid, rating: invalid })), [], NOW);
      expect(result.catalog.stats[0]!.ascensionistCount).toBeNull();
      if (invalid !== 2.5) expect(result.catalog.stats[0]!.qualityAverage).toBeNull();
    }
    expect(prepareEwallsCatalog(bootstrap(route({ angle: 91 })), [], NOW).catalog.climbs[0]!.angle).toBeNull();
  });

  it('keeps account enrichment and personal collection records out of the public catalog', () => {
    const input = bootstrap(
      route({
        ascents: [{ userId: 'PRIVATE_ACCOUNT_MARKER' }],
        rating: { user: 'PRIVATE_ACCOUNT_MARKER' },
        logged: true,
        userAscents: 'PRIVATE_ACCOUNT_MARKER',
        isFavourite: true,
        isProject: true,
        activatedBy: { email: 'PRIVATE_ACCOUNT_MARKER' },
        user: { id: 'PRIVATE_ACCOUNT_MARKER' },
      }),
    );
    const account = {
      ascents: { upsert: [{ id: 'PRIVATE_ACCOUNT_MARKER' }], deleted: [] },
      favorites: { upsert: [{ routeId: 'PRIVATE_ACCOUNT_MARKER' }], deleted: [] },
      projects: { upsert: [{ routeId: 'PRIVATE_ACCOUNT_MARKER' }], deleted: [] },
    };
    const prepared = prepareEwallsCatalog({ ...input, account }, [], NOW);
    expect(JSON.stringify(prepared.catalog)).not.toContain('PRIVATE_ACCOUNT_MARKER');
    expect(prepared.catalog.climbs[0]!.sourceMetadata).not.toHaveProperty('logged');
    expect(prepared.catalog.climbs[0]!.sourceMetadata).not.toHaveProperty('ascents');
    expect(prepared.catalog.climbs[0]!.sourceMetadata).not.toHaveProperty('rating');
    expect(prepared.catalog.climbs[0]!.userId).toBeNull();
    expect(prepareEwallsCatalog(bootstrap(route({ disabled: undefined })), [], NOW).catalog.climbs[0]!.isListed).toBe(
      false,
    );
    expect(prepareEwallsCatalog(bootstrap(route({ disabled: 'false' })), [], NOW).catalog.climbs[0]!.isListed).toBe(
      false,
    );
  });

  it('normalizes binary UUID representation without requiring a particular RFC UUID version', () => {
    const raw = 'ABCDEF0123456789ABCDEF0123456789';
    expect(normalizeEwallsRouteId(raw)).toBe('abcdef01-2345-6789-abcd-ef0123456789');
    const prepared = prepareEwallsCatalog(bootstrap(route({ id: raw })), [], NOW);
    expect(prepared.catalog.climbs[0]!.controllerRouteUuid).toBe(normalizeEwallsRouteId(raw));
    expect(prepared.catalog.climbs[0]!.sourceMetadata.id).toBe(raw);
    expect(() =>
      prepareEwallsCatalog(
        {
          ...bootstrap(),
          routes: { upsert: [route({ id: raw }), route({ id: normalizeEwallsRouteId(raw) })], deleted: [] },
        },
        [],
        NOW,
      ),
    ).toThrow(/duplicate route UUID/);
    for (const invalid of ['not-a-uuid', raw + '00', 'abcdef01---23456789abcdef0123456789'])
      expect(() => normalizeEwallsRouteId(invalid)).toThrow(/binary route\/diode UUID/);
  });

  it.each([false, true])(
    'rejects a source UUID colliding with another climb’s canonical alias, reverse order=%s',
    (reverse) => {
      const firstRoute = route();
      const collidingRoute = route({ id: quantumCanonicalClimbUuid(9101, ROUTE_ID) });
      const upsert = reverse ? [collidingRoute, firstRoute] : [firstRoute, collidingRoute];
      expect(() => prepareEwallsCatalog({ ...bootstrap(), routes: { upsert, deleted: [] } }, [], NOW)).toThrow(
        /alias names multiple canonical climbs/,
      );
    },
  );
});
