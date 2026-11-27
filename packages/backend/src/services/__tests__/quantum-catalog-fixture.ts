import { QUANTUM_HARDWARE_FINGERPRINT } from '@boardsesh/board-constants/quantum';
import { db, type Database } from '../../db/client';
import { loadEwallsCatalogState } from '../ewalls-catalog-state';
import { importPreparedEwallsCatalog } from '../quantum-catalog-import';
import { prepareQuantumCatalog } from '../quantum-catalog-mapping';
import type {
  QuantumDiodeRow,
  QuantumModelCode,
  QuantumModelRow,
  QuantumRouteLightRow,
  QuantumRouteModelRow,
  QuantumRouteRow,
  QuantumCatalogRows,
} from '@boardsesh/quantum-sync';

const MODEL_ROWS: readonly QuantumModelRow[] = [
  model('xl', 9101, 9201, 'XL', 15, 15, 'big'),
  model('l', 9101, 9202, 'L', 15, 12, 'medium'),
  model('m', 9101, 9203, 'M', 12, 12, 'small'),
  model('s', 9104, 9204, 'S Fitness', 8, 12, 'xsmall'),
  model('belay', 9105, 9205, 'Belay', 8, 12, 'belay'),
];

const DIODE_ROWS: readonly QuantumDiodeRow[] = [
  diode('xl', 'diode-xl-1', 7, 1, 1.2349, -2.3459),
  diode('xl', 'diode-xl-2', 8, 2, 4.999, 3.001),
  diode('xl', 'diode-xl-3', 9, 3, 3, 7),
  diode('xl', 'diode-xl-4', 10, 4, 2, 6),
  // Identical source placement ids across models are intentional. The importer
  // must namespace them by layout before writing the generic board PKs.
  { ...diode('xl', 'diode-xl-1', 7, 1, 1.2349, -2.3459), model: 'l' },
  { ...diode('xl', 'diode-xl-1', 7, 1, 1.2349, -2.3459), model: 'm' },
  diode('s', 'diode-s-1', 7, 1, 1, 2),
  diode('belay', 'diode-belay-1', 7, 1, 1, 2),
];

export type QuantumFixtureOptions = Readonly<{
  checkpoint?: string;
  appUuid?: string;
  routeUuid?: string;
  routeName?: string;
  angle?: number;
  grade?: string;
  disabled?: boolean;
  diodes?: readonly QuantumDiodeRow[];
  model?: QuantumModelCode;
  steps?: readonly number[];
}>;

export function quantumCatalogFixture(options: QuantumFixtureOptions = {}): {
  rows: QuantumCatalogRows;
  checkpoint: string;
} {
  const routeUuid = options.routeUuid ?? '11111111-1111-4111-8111-111111111111';
  const appUuid = options.appUuid ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const selectedModel = options.model ?? 'xl';
  const selectedDiodes = (options.diodes ?? DIODE_ROWS).filter((diodeRow) => diodeRow.model === selectedModel);
  const steps = options.steps ?? [1, 2, 3, 9];
  const route: QuantumRouteRow = {
    uuid: routeUuid,
    name: options.routeName ?? 'Synthetic Quantum Route',
    setter: 'Synthetic Setter',
    grade: options.grade ?? '[12,13]',
    angle: options.angle ?? 40,
    rating: 4.5,
    ascents: 12,
    plays: 20,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_100,
    disabled: options.disabled ?? false,
    campusing: true,
    edge: true,
    kickplate: true,
    matching: true,
    standard: true,
    tags: '["pinch","technical","pinch"]',
    tips: 'Stay close to the wall.',
  };
  const routeModel: QuantumRouteModelRow = { routeUuid, model: selectedModel, appUuid };
  const routeLights: QuantumRouteLightRow[] = selectedDiodes.slice(0, steps.length).map((diodeRow, index) => ({
    routeUuid,
    model: selectedModel,
    diodeUuid: diodeRow.diodeUuid,
    step: steps[index] ?? 2,
  }));
  const diodes = options.diodes ?? DIODE_ROWS;

  return Object.freeze({
    checkpoint: options.checkpoint ?? 'first',
    rows: Object.freeze({
      models: MODEL_ROWS,
      diodes,
      routes: Object.freeze([route]),
      routeModels: Object.freeze([routeModel]),
      routeLights: Object.freeze(routeLights),
    }),
  });
}

export function quantumFixtureDiodes(): readonly QuantumDiodeRow[] {
  return DIODE_ROWS;
}

export function quantumSharedRouteFixture(options: QuantumFixtureOptions = {}): {
  rows: QuantumCatalogRows;
  checkpoint: string;
} {
  const snapshot = quantumCatalogFixture({ ...options, steps: [1] });
  const routeUuid = snapshot.rows.routes[0]!.uuid;
  const light = snapshot.rows.routeLights[0]!;
  return {
    ...snapshot,
    rows: {
      ...snapshot.rows,
      routeModels: [
        { routeUuid, model: 'xl', appUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        { routeUuid, model: 'l', appUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        { routeUuid, model: 'm', appUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      ],
      routeLights: [
        { ...light, model: 'xl' },
        { ...light, model: 'l' },
        { ...light, model: 'm' },
      ],
    },
  };
}

function model(
  modelCode: QuantumModelCode,
  layoutId: number,
  productSizeId: number,
  name: string,
  columns: number,
  rows: number,
  forcedType: string,
): QuantumModelRow {
  return {
    model: modelCode,
    layoutId,
    productSizeId,
    name,
    columns,
    rows,
    forcedType,
    edgeLeft: 0,
    edgeRight: 10,
    edgeBottom: -5,
    edgeTop: 10,
  };
}

function diode(
  modelCode: QuantumModelCode,
  diodeUuid: string,
  placementId: number,
  autocadId: number,
  x: number,
  y: number,
): QuantumDiodeRow {
  return {
    model: modelCode,
    diodeUuid,
    placementId,
    ledNode: String(autocadId),
    autocadId,
    holdType: 'hold',
    x,
    y,
    z: 0,
  };
}

export async function importFixture(
  fixture: ReturnType<typeof quantumCatalogFixture>,
  options: { database?: Database; now?: () => Date } = {},
) {
  const scope = { board: '', forcedType: 'big' };
  const database = options.database ?? db;
  const prior = await loadEwallsCatalogState(database, scope, 'catalogue-service');
  const catalog = prepareQuantumCatalog(fixture, options.now?.());
  return importPreparedEwallsCatalog(
    {
      batch: {
        kind: 'bootstrap',
        scope,
        checkpoint: fixture.checkpoint,
        baseCheckpoint: null,
        routes: { upsert: fixture.rows.routes.map((route) => ({ id: route.uuid })), deleted: [] },
        diodes: null,
        account: {
          ascents: { upsert: [], deleted: [] },
          favorites: { upsert: [], deleted: [] },
          projects: { upsert: [], deleted: [] },
        },
      },
      catalog: { ...catalog, hardwareFingerprint: QUANTUM_HARDWARE_FINGERPRINT },
      diodes: [{ id: 'fixture-diode', autocadId: 1 }],
      upstreamAccountId: 'catalogue-service',
      expectedCheckpoint: prior?.checkpoint ?? null,
    },
    options,
  );
}
