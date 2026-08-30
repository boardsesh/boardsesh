export const QUANTUM_MANIFEST_KIND = 30_078;
export const QUANTUM_MANIFEST_D_TAG = 'cruxcoach/quantum-db';
export const QUANTUM_MANIFEST_SIGNER = '70b2740bff77cf65743a7d6ffa5465b3a27105ae26123458cf5450eafb1bd68d';
export const QUANTUM_MANIFEST_VERSION = 1;
export const QUANTUM_MANIFEST_BOARD = 'quantum';
/** Declared snapshot provenance. It is an authenticated label, not proof of legal authorization. */
export const QUANTUM_MANIFEST_SOURCE = 'ewalls-authorized-snapshot';
export const QUANTUM_MANIFEST_COMPRESSION = 'zstd';
export const QUANTUM_CHUNK_NAME = 'quantum_snapshot_v1';
export const QUANTUM_CHUNK_TYPE = 'quantum';
export const QUANTUM_SQLITE_USER_VERSION = 1;
export const QUANTUM_DAEMON_INTERVAL_MINUTES = 360;

export const QUANTUM_DEFAULT_RELAYS = [
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://relay.wellorder.net',
  'wss://nos.lol',
  'wss://relay.oxtr.dev',
  'wss://blossom.cruxcoach.org/nostr',
] as const;

export const QUANTUM_DEFAULT_LIMITS = {
  maxManifestBytes: 64 * 1024,
  maxEventsPerRelay: 64,
  // The production path streams both files to disk, but validation still
  // materializes normalized rows. Keep the signed artifact itself bounded so
  // hostile SQLite text and index pages cannot create multi-GiB heap pressure.
  maxCompressedBytes: 64 * 1024 * 1024,
  maxDecompressedBytes: 256 * 1024 * 1024,
  maxMirrorUrls: 8,
  maxFutureEventSeconds: 5 * 60,
  relayTimeoutMs: 10_000,
  mirrorTimeoutMs: 60_000,
} as const;

export const QUANTUM_REQUIRED_COLUMNS = {
  quantum_models: [
    'model',
    'layout_id',
    'product_size_id',
    'name',
    'columns',
    'rows',
    'forced_type',
    'edge_left',
    'edge_right',
    'edge_bottom',
    'edge_top',
  ],
  quantum_diodes: ['model', 'diode_uuid', 'placement_id', 'led_node', 'autocad_id', 'hold_type', 'x', 'y', 'z'],
  quantum_routes: [
    'uuid',
    'name',
    'setter',
    'grade',
    'angle',
    'rating',
    'ascents',
    'plays',
    'created_at',
    'updated_at',
    'disabled',
    'campusing',
    'edge',
    'kickplate',
    'matching',
    'standard',
    'tags',
    'tips',
  ],
  quantum_route_models: ['route_uuid', 'model', 'app_uuid'],
  quantum_route_lights: ['route_uuid', 'model', 'diode_uuid', 'step'],
} as const;

export type QuantumTableName = keyof typeof QUANTUM_REQUIRED_COLUMNS;

export const QUANTUM_REQUIRED_COLUMN_TYPES: Readonly<
  Record<QuantumTableName, Readonly<Record<string, 'TEXT' | 'INTEGER' | 'REAL'>>>
> = {
  quantum_models: {
    model: 'TEXT',
    layout_id: 'INTEGER',
    product_size_id: 'INTEGER',
    name: 'TEXT',
    columns: 'INTEGER',
    rows: 'INTEGER',
    forced_type: 'TEXT',
    edge_left: 'REAL',
    edge_right: 'REAL',
    edge_bottom: 'REAL',
    edge_top: 'REAL',
  },
  quantum_diodes: {
    model: 'TEXT',
    diode_uuid: 'TEXT',
    placement_id: 'INTEGER',
    led_node: 'TEXT',
    autocad_id: 'TEXT',
    hold_type: 'TEXT',
    x: 'REAL',
    y: 'REAL',
    z: 'REAL',
  },
  quantum_routes: {
    uuid: 'TEXT',
    name: 'TEXT',
    setter: 'TEXT',
    grade: 'TEXT',
    angle: 'INTEGER',
    rating: 'REAL',
    ascents: 'INTEGER',
    plays: 'INTEGER',
    created_at: 'INTEGER',
    updated_at: 'INTEGER',
    disabled: 'INTEGER',
    campusing: 'INTEGER',
    edge: 'INTEGER',
    kickplate: 'INTEGER',
    matching: 'INTEGER',
    standard: 'INTEGER',
    tags: 'TEXT',
    tips: 'TEXT',
  },
  quantum_route_models: {
    route_uuid: 'TEXT',
    model: 'TEXT',
    app_uuid: 'TEXT',
  },
  quantum_route_lights: {
    route_uuid: 'TEXT',
    model: 'TEXT',
    diode_uuid: 'TEXT',
    step: 'INTEGER',
  },
};
