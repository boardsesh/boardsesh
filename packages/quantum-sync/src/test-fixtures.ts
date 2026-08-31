import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { QUANTUM_MANIFEST_D_TAG, QUANTUM_MANIFEST_SIGNER } from './constants';
import { computeNostrEventId } from './nostr';
import type { NostrEvent } from './types';

export type SyntheticQuantumSqliteOptions = {
  userVersion?: number;
  autocadId?: string;
  routeLightStep?: number;
  omitRouteModelsUnique?: boolean;
  routeUuid?: string;
  appUuid?: string;
  xlForcedType?: string;
  diodeX?: number;
  diodeY?: number;
  routeTips?: string;
  extraSchemaObjectCount?: number;
  schemaMetadataPaddingBytes?: number;
};

export async function createSyntheticQuantumSqlite(options: SyntheticQuantumSqliteOptions = {}): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), 'boardsesh-quantum-test-'));
  const path = join(directory, 'synthetic.sqlite3');
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA user_version = ${options.userVersion ?? 1};
      CREATE TABLE quantum_models(
        model TEXT PRIMARY KEY, layout_id INTEGER, product_size_id INTEGER,
        name TEXT, columns INTEGER, rows INTEGER, forced_type TEXT,
        edge_left REAL, edge_right REAL, edge_bottom REAL, edge_top REAL
      );
      CREATE TABLE quantum_diodes(
        model TEXT, diode_uuid TEXT, placement_id INTEGER, led_node TEXT,
        autocad_id TEXT, hold_type TEXT, x REAL, y REAL, z REAL
      );
      CREATE TABLE quantum_routes(
        uuid TEXT PRIMARY KEY, name TEXT, setter TEXT, grade TEXT, angle INTEGER,
        rating REAL, ascents INTEGER, plays INTEGER, created_at INTEGER, updated_at INTEGER,
        disabled INTEGER, campusing INTEGER, edge INTEGER, kickplate INTEGER,
        matching INTEGER, standard INTEGER, tags TEXT, tips TEXT
      );
      CREATE TABLE quantum_route_models(
        route_uuid TEXT, model TEXT, app_uuid TEXT ${options.omitRouteModelsUnique ? '' : 'UNIQUE'}
      );
      CREATE TABLE quantum_route_lights(route_uuid TEXT, model TEXT, diode_uuid TEXT, step INTEGER);
    `);
    for (let objectIndex = 0; objectIndex < (options.extraSchemaObjectCount ?? 0); objectIndex += 1) {
      database.exec(`CREATE TABLE extra_schema_object_${objectIndex}(id INTEGER)`);
    }
    const schemaMetadataPaddingBytes = options.schemaMetadataPaddingBytes ?? 0;
    if (schemaMetadataPaddingBytes > 0) {
      database.exec(
        `CREATE VIEW extra_schema_metadata AS SELECT '${'x'.repeat(schemaMetadataPaddingBytes)}' AS payload`,
      );
    }

    const insertModel = database.prepare('INSERT INTO quantum_models VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const modelRows = [
      ['xl', 9101, 9201, 'XL', 15, 15, options.xlForcedType ?? 'big'],
      ['l', 9102, 9202, 'L', 15, 12, 'medium'],
      ['m', 9103, 9203, 'M', 12, 12, 'small'],
      ['s', 9104, 9204, 'S Fitness', 8, 12, 'xsmall'],
      ['belay', 9105, 9205, 'Belay', 8, 12, 'belay'],
    ] as const;
    for (const model of modelRows) insertModel.run(...model, 0, 100, 0, 100);

    const insertDiode = database.prepare('INSERT INTO quantum_diodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [index, model] of ['xl', 'l', 'm', 's', 'belay'].entries()) {
      insertDiode.run(
        model,
        `diode-${model}`,
        0,
        String(index),
        options.autocadId ?? String(index),
        'hold',
        options.diodeX ?? 1,
        options.diodeY ?? 2,
        3,
      );
    }

    database
      .prepare('INSERT INTO quantum_routes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        options.routeUuid ?? '11111111-1111-4111-8111-111111111111',
        'Synthetic Route',
        'Synthetic Setter',
        '[12,13]',
        40,
        4.5,
        2,
        3,
        1_700_000_000,
        1_700_000_100,
        0,
        0,
        0,
        0,
        1,
        1,
        '[]',
        options.routeTips ?? '',
      );
    database
      .prepare('INSERT INTO quantum_route_models VALUES (?, ?, ?)')
      .run(
        options.routeUuid ?? '11111111-1111-4111-8111-111111111111',
        'xl',
        options.appUuid ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      );
    database
      .prepare('INSERT INTO quantum_route_lights VALUES (?, ?, ?, ?)')
      .run(options.routeUuid ?? '11111111-1111-4111-8111-111111111111', 'xl', 'diode-xl', options.routeLightStep ?? 1);
  } finally {
    database.close();
  }

  try {
    return Uint8Array.from(await readFile(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function createSyntheticManifestEvent(input: {
  compressed: Uint8Array;
  createdAt?: number;
  url?: string;
  source?: string;
  dTag?: string;
  signer?: string;
  mutateManifest?: (manifest: Record<string, unknown>) => void;
}): NostrEvent {
  const createdAt = input.createdAt ?? 1_800_000_000;
  const manifest: Record<string, unknown> = {
    v: 1,
    board: 'quantum',
    source: input.source ?? 'ewalls-authorized-snapshot',
    created_at: createdAt,
    compression: 'zstd',
    chunks: [
      {
        name: 'quantum_snapshot_v1',
        type: 'quantum',
        sha256: createHash('sha256').update(input.compressed).digest('hex'),
        size: input.compressed.byteLength,
        urls: [input.url ?? 'https://mirror.example/quantum.zst'],
      },
    ],
  };
  input.mutateManifest?.(manifest);
  const eventWithoutFingerprint = {
    pubkey: input.signer ?? QUANTUM_MANIFEST_SIGNER,
    created_at: createdAt,
    kind: 30_078,
    tags: [['d', input.dTag ?? QUANTUM_MANIFEST_D_TAG]],
    content: JSON.stringify(manifest),
  } as const;
  return {
    ...eventWithoutFingerprint,
    id: computeNostrEventId(eventWithoutFingerprint),
    sig: 'a'.repeat(128),
  };
}
