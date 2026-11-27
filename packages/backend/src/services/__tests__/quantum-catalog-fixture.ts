import { getQuantumSourceDiodeBindings, type QuantumSourceDiodeBinding } from '@boardsesh/board-constants/quantum';
import type { EwallsBootstrap, EwallsIdentifiedRecord, EwallsRecord } from '@boardsesh/quantum-sync';
import { db, type Database } from '../../db/client';
import { prepareEwallsCatalog, type PreparedQuantumCatalog } from '../ewalls-catalog-mapping';
import { loadEwallsCatalogState } from '../ewalls-catalog-state';
import { importPreparedEwallsCatalog } from '../quantum-catalog-import';

/**
 * Catalogue fixtures built through the production eWalls mapper, on the real
 * bundled geometry. Bindings are ordered by placement id, so the shared hole
 * (the lowest M placement) sorts before the XL-only holes in every frame.
 */
function requireBinding(binding: QuantumSourceDiodeBinding | undefined, label: string): QuantumSourceDiodeBinding {
  if (!binding) throw new Error(`Quantum fixture geometry has no ${label} diode`);
  return binding;
}

const LARGE_DIODE_UUIDS = new Set((getQuantumSourceDiodeBindings(9101, 9202) ?? []).map((diode) => diode.diodeUuid));
const XL_ONLY_BINDINGS = (getQuantumSourceDiodeBindings(9101, 9201) ?? []).filter(
  (diode) => !LARGE_DIODE_UUIDS.has(diode.diodeUuid),
);
/** On XL, L and M. */
const SHARED_DIODE = requireBinding(getQuantumSourceDiodeBindings(9101, 9203)?.[0], 'shared standard');
/** On XL only: a route through any of them fits no smaller standard size. */
const XL_ONLY_DIODES = [
  requireBinding(XL_ONLY_BINDINGS[0], 'first XL-only'),
  requireBinding(XL_ONLY_BINDINGS[1], 'second XL-only'),
  requireBinding(XL_ONLY_BINDINGS[2], 'third XL-only'),
] as const;
const S_FITNESS_DIODE = requireBinding(getQuantumSourceDiodeBindings(9104, 9204)?.[0], 'S Fitness');
const STANDARD_ROUTE_DIODES = [SHARED_DIODE, ...XL_ONLY_DIODES];

const QUANTUM_FIXTURE_ACCOUNT = 'catalogue-service';
const QUANTUM_FIXTURE_ROUTE_ID = '11111111-1111-4111-8111-111111111111';
export const QUANTUM_FIXTURE_SHARED_PLACEMENT = SHARED_DIODE.placementId;
export const QUANTUM_FIXTURE_XL_ONLY_PLACEMENTS = XL_ONLY_DIODES.map((diode) => diode.placementId);
/** Holds of the default route (steps 1, 2, 3, 2), in frame order. */
export const QUANTUM_FIXTURE_HOLDS = [
  { holdId: SHARED_DIODE.placementId, holdState: 'STARTING' },
  { holdId: XL_ONLY_DIODES[0].placementId, holdState: 'HAND' },
  { holdId: XL_ONLY_DIODES[1].placementId, holdState: 'FINISH' },
  { holdId: XL_ONLY_DIODES[2].placementId, holdState: 'HAND' },
] as const;
export const QUANTUM_FIXTURE_PLACEMENT_IDS = QUANTUM_FIXTURE_HOLDS.map((hold) => hold.holdId);
export const QUANTUM_FIXTURE_FRAMES =
  `p${SHARED_DIODE.placementId}r12p${XL_ONLY_DIODES[0].placementId}r13` +
  `p${XL_ONLY_DIODES[1].placementId}r14p${XL_ONLY_DIODES[2].placementId}r13`;

type LightStep = 1 | 2 | 3;
type StandardFit = 'big' | 'medium' | 'small';

/** One bootstrap acquisition of a single eWalls catalogue scope. */
export type QuantumFixture = Readonly<{
  checkpoint: string;
  forcedType: string;
  routes: readonly EwallsIdentifiedRecord[];
}>;

export type QuantumFixtureOptions = Readonly<{
  checkpoint?: string;
  routeId?: string;
  routeName?: string;
  angle?: number;
  grade?: string;
  /** eWalls route fit. The default, `big`, keeps the route on XL only. */
  minVariant?: StandardFit;
  /** One step per fixture diode, shared hole first. */
  steps?: readonly LightStep[];
}>;

const NO_CHANGES = { upsert: [], deleted: [] };

function diodeRecord(binding: QuantumSourceDiodeBinding): EwallsRecord {
  return { id: binding.diodeUuid, autocadId: binding.autocadId };
}

function quantumFixtureRoute(options: QuantumFixtureOptions = {}): EwallsIdentifiedRecord {
  const steps = options.steps ?? [1, 2, 3, 2];
  return {
    id: options.routeId ?? QUANTUM_FIXTURE_ROUTE_ID,
    name: options.routeName ?? 'Synthetic Quantum Route',
    type: 'big',
    minVariant: options.minVariant ?? 'big',
    disabled: false,
    grade: options.grade ?? '[12,13]',
    angle: options.angle ?? 40,
    rating: 4.5,
    ascents: 12,
    plays: 20,
    createdAt: '2023-11-14T22:13:20.000Z',
    // No updatedAt: revision fencing has its own tests, and a fixture without a
    // revision reaches the geometry and ownership checks on every import.
    routeSetter: { firstName: 'Synthetic', lastName: 'Setter' },
    campusing: true,
    edge: true,
    kickplate: true,
    matching: true,
    standard: true,
    tags: ['pinch', 'technical'],
    tips: 'Stay close to the wall.',
    lights: STANDARD_ROUTE_DIODES.slice(0, steps.length).map((diode, index) => ({
      diode: { id: diode.diodeUuid },
      step: steps[index],
    })),
  };
}

/** One XL-only route acquired through the XL catalogue scope. */
export function quantumCatalogFixture(options: QuantumFixtureOptions = {}): QuantumFixture {
  return { checkpoint: options.checkpoint ?? 'first', forcedType: 'big', routes: [quantumFixtureRoute(options)] };
}

/** One route on the shared hole only, fitting XL, L and M unless `minVariant` narrows it. */
export function quantumSharedRouteFixture(options: QuantumFixtureOptions = {}): QuantumFixture {
  return quantumCatalogFixture({ minVariant: 'small', ...options, steps: [1] });
}

/** The default route's id acquired through the S Fitness scope: a separate physical family. */
export function quantumSFitnessFixture(options: Pick<QuantumFixtureOptions, 'checkpoint'> = {}): QuantumFixture {
  return {
    checkpoint: options.checkpoint ?? 'first',
    forcedType: 'xsmall',
    routes: [
      {
        ...quantumFixtureRoute(),
        type: 'xsmall',
        minVariant: 'xsmall',
        lights: [{ diode: { id: S_FITNESS_DIODE.diodeUuid }, step: 1 }],
      },
    ],
  };
}

function quantumFixtureBatch(fixture: QuantumFixture): EwallsBootstrap {
  return {
    kind: 'bootstrap',
    baseCheckpoint: null,
    scope: { board: '', forcedType: fixture.forcedType },
    checkpoint: fixture.checkpoint,
    routes: { upsert: fixture.routes, deleted: [] },
    diodes: (fixture.forcedType === 'xsmall' ? [S_FITNESS_DIODE] : STANDARD_ROUTE_DIODES).map(diodeRecord),
    account: { ascents: NO_CHANGES, favorites: NO_CHANGES, projects: NO_CHANGES },
  };
}

/**
 * eWalls route ascents and ratings have unconfirmed semantics, so the mapper
 * keeps them in source metadata and leaves the stats aggregates empty. The
 * importer still blends upstream aggregates whenever a catalogue carries them,
 * so the fixture promotes those two source fields into each stats row.
 */
function withSourceAggregates(catalog: PreparedQuantumCatalog): PreparedQuantumCatalog {
  const metadataByClimb = new Map(catalog.climbs.map((climb) => [climb.uuid, climb.sourceMetadata]));
  return {
    ...catalog,
    stats: catalog.stats.map((stat) => {
      const metadata = metadataByClimb.get(stat.climbUuid);
      const ascents = typeof metadata?.ascents === 'number' ? metadata.ascents : null;
      const rating = typeof metadata?.rating === 'number' ? metadata.rating : null;
      return {
        ...stat,
        upstreamAscensionistCount: ascents,
        ascensionistCount: ascents,
        upstreamQualityAverage: rating,
        qualityAverage: rating,
      };
    }),
  };
}

export function prepareQuantumFixture(fixture: QuantumFixture, now: Date = new Date()) {
  const batch = quantumFixtureBatch(fixture);
  const prepared = prepareEwallsCatalog(batch, [], now);
  return { ...prepared, batch, catalog: withSourceAggregates(prepared.catalog) };
}

export async function importFixture(fixture: QuantumFixture, options: { database?: Database; now?: () => Date } = {}) {
  const database = options.database ?? db;
  const { batch, catalog, diodes, withdrawals } = prepareQuantumFixture(fixture, options.now?.());
  const prior = await loadEwallsCatalogState(database, batch.scope, QUANTUM_FIXTURE_ACCOUNT);
  return importPreparedEwallsCatalog(
    {
      batch,
      catalog,
      diodes,
      withdrawals,
      upstreamAccountId: QUANTUM_FIXTURE_ACCOUNT,
      expectedCheckpoint: prior?.checkpoint ?? null,
    },
    options,
  );
}
