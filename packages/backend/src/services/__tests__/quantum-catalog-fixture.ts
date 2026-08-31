import type {
  QuantumDiodeRow,
  QuantumModelCode,
  QuantumModelRow,
  QuantumRouteLightRow,
  QuantumRouteModelRow,
  QuantumRouteRow,
  ValidatedQuantumSnapshot,
} from '@boardsesh/quantum-sync';

const MODEL_ROWS: readonly QuantumModelRow[] = [
  model('xl', 9101, 9201, 'XL', 15, 15, 'big'),
  model('l', 9102, 9202, 'L', 15, 12, 'medium'),
  model('m', 9103, 9203, 'M', 12, 12, 'small'),
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
  diode('l', 'diode-l-1', 7, 1, 1, 2),
  diode('m', 'diode-m-1', 7, 1, 1, 2),
  diode('s', 'diode-s-1', 7, 1, 1, 2),
  diode('belay', 'diode-belay-1', 7, 1, 1, 2),
];

export type QuantumFixtureOptions = Readonly<{
  eventId?: string;
  manifestCreatedAt?: number;
  appUuid?: string;
  routeUuid?: string;
  routeName?: string;
  grade?: string;
  disabled?: boolean;
  diodes?: readonly QuantumDiodeRow[];
  model?: QuantumModelCode;
  steps?: readonly number[];
}>;

export function quantumCatalogFixture(options: QuantumFixtureOptions = {}): ValidatedQuantumSnapshot {
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
    angle: 40,
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
    eventId: options.eventId ?? 'f'.repeat(64),
    eventPubkey: '7'.repeat(64),
    eventCreatedAt: options.manifestCreatedAt ?? 1_800_000_000,
    dTag: 'cruxcoach/quantum-db',
    board: 'quantum',
    source: 'ewalls-authorized-snapshot',
    manifestCreatedAt: options.manifestCreatedAt ?? 1_800_000_000,
    chunkName: 'quantum_snapshot_v1',
    chunkSha256: 'c'.repeat(64),
    compressedSize: 1_024,
    decompressedSha256: 'd'.repeat(64),
    decompressedSize: 4_096,
    selectedMirrorUrl: 'https://mirror.example/quantum.zst',
    rows: Object.freeze({
      models: MODEL_ROWS,
      diodes,
      routes: Object.freeze([route]),
      routeModels: Object.freeze([routeModel]),
      routeLights: Object.freeze(routeLights),
    }),
    summary: Object.freeze({
      models: MODEL_ROWS.length,
      diodes: diodes.length,
      routes: 1,
      routeModels: 1,
      routeLights: routeLights.length,
    }),
  });
}

export function quantumFixtureDiodes(): readonly QuantumDiodeRow[] {
  return DIODE_ROWS;
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
