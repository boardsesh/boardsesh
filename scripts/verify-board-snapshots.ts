/** Read-only R2 rehearsal gate. Every referenced object is downloaded and checked; storage is never written. */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CATALOG_SNAPSHOT_TABLES } from '../packages/db/src/catalog-snapshot';
import { ARTIFACT_SCHEMA_VERSION } from '../packages/shared/offline-sync/src/db/migrations';
import {
  parseSnapshotManifest,
  SNAPSHOT_MANIFEST_FORMAT_VERSION,
  type SnapshotManifest,
  type SnapshotTableStats,
} from '../packages/shared/offline-sync/src/sync/snapshot-manifest';

const PREFIXES = ['board-snapshots/v1', 'board-snapshots/v1-gzip', 'board-snapshots/v1-catalog'] as const;
const PUBLIC_BASE_URL = 'https://snapshots.boardsesh.com';
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 300_000;
const MAX_ARTIFACT_BYTES = 2 * 1024 ** 3;
const CURSOR_COLUMNS = {
  board_climbs: 'updated_at',
  board_climb_stats: 'updated_at',
  board_climb_grades: 'computed_at',
} as const;

export type VerificationOptions = {
  expectedManifest: SnapshotManifest;
  builtAfter: string;
};
export type StoredObject = {
  body: AsyncIterable<Uint8Array>;
  contentLength?: number;
  contentEncoding?: string;
  contentType?: string;
  cacheControl?: string;
};
export type VerificationDependencies = {
  readObject: (key: string) => Promise<StoredObject>;
  publicGet: (url: string, origin?: string) => Promise<Response>;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  report: (message: Record<string, unknown>) => void;
};
export type ArtifactToVerify = {
  key: string;
  url: string;
  bytes: number;
  uncompressedBytes?: number;
  contentEncoding: 'gzip' | 'identity';
  builtAt: string;
  schemaVersion: number;
  tables: Record<string, { rowCount: number } | SnapshotTableStats>;
  boardType?: string;
  layoutId?: number;
  /** Grades are checked against this verified main artifact, without loading UUIDs into memory. */
  mainArtifactKey?: string;
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Compare timestamp cursors without rounding their Postgres microseconds. */
export function timestampMicros(timestamp: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(timestamp);
  requireCondition(match && Number.isFinite(Date.parse(timestamp)), `Invalid UTC timestamp: ${timestamp}`);
  return BigInt(Date.parse(`${match[1]}Z`)) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}

function layoutKey(entry: { boardType: string; layoutId: number }): string {
  requireCondition(
    /^[a-z][a-z0-9-]*$/.test(entry.boardType) && entry.boardType !== 'spray',
    'Invalid public board type',
  );
  requireCondition(Number.isSafeInteger(entry.layoutId) && entry.layoutId >= 0, 'Invalid layout id');
  return `${entry.boardType}:${entry.layoutId}`;
}

function validatedLayoutKeys(manifest: SnapshotManifest): Set<string> {
  const layoutKeys = manifest.entries.map(layoutKey);
  const uniqueLayoutKeys = new Set(layoutKeys);
  requireCondition(uniqueLayoutKeys.size === layoutKeys.length, 'Manifest contains duplicate layouts');
  requireCondition(layoutKeys.length > 0, 'Manifest coverage is empty');
  return uniqueLayoutKeys;
}

export function assertCoverage(actual: SnapshotManifest, expected: SnapshotManifest): void {
  const actualKeys = validatedLayoutKeys(actual);
  for (const expectedKey of validatedLayoutKeys(expected)) {
    requireCondition(actualKeys.has(expectedKey), `Missing expected layout: ${expectedKey}`);
  }
}

function assertFresh(timestamp: string, builtAfter: string, now: number, label: string): void {
  const micros = timestampMicros(timestamp);
  requireCondition(micros >= timestampMicros(builtAfter), `${label} predates the controlled full export`);
  requireCondition(micros <= BigInt(now + 30_000) * 1000n, `${label} is in the future`);
}

function assertArtifact(
  artifact: ArtifactToVerify,
  prefix: string,
  base: string,
  options: VerificationOptions,
  now: number,
) {
  requireCondition(
    artifact.key.startsWith(`${prefix}/`) &&
      /^[A-Za-z0-9/_.-]+$/.test(artifact.key) &&
      artifact.key.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    `${prefix}: invalid artifact key`,
  );
  requireCondition(
    artifact.url === `${base}/${artifact.key}`,
    `${artifact.key}: URL must use the R2 public base and key`,
  );
  if (artifact.boardType !== undefined) {
    requireCondition(
      artifact.key.startsWith(`${prefix}/${artifact.boardType}/${artifact.layoutId}/`),
      `${artifact.key}: key does not match the labeled layout`,
    );
  }
  requireCondition(
    Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0 && artifact.bytes <= MAX_ARTIFACT_BYTES,
    `${artifact.key}: invalid stored bytes`,
  );
  requireCondition(
    artifact.uncompressedBytes === undefined ||
      (Number.isSafeInteger(artifact.uncompressedBytes) &&
        artifact.uncompressedBytes > 0 &&
        artifact.uncompressedBytes <= MAX_ARTIFACT_BYTES),
    `${artifact.key}: invalid decoded bytes`,
  );
  requireCondition(
    Number.isSafeInteger(artifact.schemaVersion) && artifact.schemaVersion > 0,
    `${artifact.key}: invalid schema`,
  );
  assertFresh(artifact.builtAt, options.builtAfter, now, artifact.key);
  for (const [tableName, stats] of Object.entries(artifact.tables)) {
    requireCondition(
      Number.isSafeInteger(stats.rowCount) && stats.rowCount >= 0,
      `${artifact.key}: invalid count for ${tableName}`,
    );
  }
}

function parseCatalogManifest(input: unknown): { generatedAt: string; artifact: ArtifactToVerify } {
  requireCondition(typeof input === 'object' && input !== null, 'Invalid catalog manifest');
  const manifest = input as Record<string, unknown>;
  requireCondition(
    manifest.formatVersion === 1 && typeof manifest.generatedAt === 'string',
    'Invalid catalog format/timestamp',
  );
  requireCondition(typeof manifest.artifact === 'object' && manifest.artifact !== null, 'Missing catalog artifact');
  const artifact = manifest.artifact as Record<string, unknown>;
  requireCondition(
    typeof artifact.key === 'string' &&
      typeof artifact.url === 'string' &&
      typeof artifact.bytes === 'number' &&
      typeof artifact.uncompressedBytes === 'number' &&
      artifact.contentEncoding === 'gzip' &&
      typeof artifact.builtAt === 'string' &&
      artifact.schemaVersion === 1 &&
      typeof artifact.tables === 'object' &&
      artifact.tables !== null,
    'Invalid catalog artifact metadata',
  );
  const tables = artifact.tables as Record<string, unknown>;
  const expectedTables = CATALOG_SNAPSHOT_TABLES.map(({ name }) => name);
  requireCondition(
    Object.keys(tables).length === expectedTables.length,
    'Catalog table coverage differs from the shared contract',
  );
  for (const tableName of expectedTables) {
    const stats = tables[tableName];
    requireCondition(
      typeof stats === 'object' && stats !== null && typeof (stats as Record<string, unknown>).rowCount === 'number',
      `Missing catalog table: ${tableName}`,
    );
  }
  return { generatedAt: manifest.generatedAt, artifact: artifact as unknown as ArtifactToVerify };
}

function assertHeaders(headers: Headers, manifest: boolean, label: string): void {
  requireCondition(headers.get('access-control-allow-origin') === '*', `${label}: missing constant wildcard CORS`);
  requireCondition(headers.has('cf-ray'), `${label}: response did not pass through Cloudflare`);
  const cacheControl = headers.get('cache-control') ?? '';
  requireCondition(
    manifest
      ? /(?:^|[,\s])max-age=300(?:$|[,\s])/.test(cacheControl)
      : /(?:^|[,\s])immutable(?:$|[,\s])/.test(cacheControl),
    `${label}: wrong cache-control`,
  );
  requireCondition(
    (headers.get('content-type') ?? '').split(';')[0] === (manifest ? 'application/json' : 'application/x-sqlite3'),
    `${label}: wrong content-type`,
  );
}

async function* timedBody(body: AsyncIterable<Uint8Array>, timeoutMs = REQUEST_TIMEOUT_MS) {
  // Destroy the actual SDK socket stream: the SDK send() abort handler alone
  // does not guarantee a deadline once response headers have arrived.
  const input = body instanceof Readable ? body : Readable.from(body);
  const timeout = setTimeout(() => input.destroy(new Error('Snapshot body download timed out')), timeoutMs);
  try {
    for await (const chunk of input) yield chunk as Uint8Array;
  } finally {
    clearTimeout(timeout);
    input.destroy();
  }
}

async function readLimitedBody(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of timedBody(body)) {
    bytes += chunk.byteLength;
    requireCondition(bytes <= MAX_MANIFEST_BYTES, 'Manifest exceeds the bounded JSON limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function responseBody(response: Response): AsyncIterable<Uint8Array> {
  requireCondition(response.ok && response.body, `Public GET failed: HTTP ${response.status}`);
  return Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
}

/** Sniff the stream; fetch may already have decoded Content-Encoding. Both paths check gzip CRC. */
export async function downloadDecoded(
  body: AsyncIterable<Uint8Array>,
  filePath: string,
  limits: { transferredBytes: number; decodedBytes: number; timeoutMs?: number },
) {
  const iterator = timedBody(body, limits.timeoutMs)[Symbol.asyncIterator]();
  try {
    const prefixChunks: Uint8Array[] = [];
    let prefixBytes = 0;
    while (prefixBytes < 2) {
      const next = await iterator.next();
      if (next.done) break;
      prefixChunks.push(next.value);
      prefixBytes += next.value.byteLength;
    }
    const prefix = Buffer.concat(prefixChunks);
    requireCondition(prefix.length <= limits.transferredBytes, 'Snapshot exceeds transferred byte limit');
    const gzip = prefix[0] === 0x1f && prefix[1] === 0x8b;
    let transferredBytes = prefix.length;
    async function* chunks() {
      try {
        yield prefix;
        for (;;) {
          const next = await iterator.next();
          if (next.done) return;
          transferredBytes += next.value.byteLength;
          requireCondition(transferredBytes <= limits.transferredBytes, 'Snapshot exceeds transferred byte limit');
          yield next.value;
        }
      } finally {
        await iterator.return(undefined);
      }
    }
    const digest = createHash('sha256');
    let decodedBytes = 0;
    const hashStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        decodedBytes += chunk.byteLength;
        if (decodedBytes > limits.decodedBytes) {
          callback(new Error('Snapshot exceeds decoded byte limit'));
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    const source = Readable.from(chunks());
    if (gzip) await pipeline(source, createGunzip(), hashStream, createWriteStream(filePath));
    else await pipeline(source, hashStream, createWriteStream(filePath));
    return { sha256: digest.digest('hex'), transferredBytes, decodedBytes: (await stat(filePath)).size, gzip };
  } finally {
    await iterator.return(undefined);
  }
}

/** Required tables come only from code-owned allowlists; no remote table name enters SQL. */
export function verifySqlite(
  filePath: string,
  artifact: ArtifactToVerify,
  catalog: boolean,
  mainArtifactPath?: string,
): void {
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    const integrity = database.prepare('PRAGMA quick_check').all();
    requireCondition(
      integrity.length === 1 && integrity[0].quick_check === 'ok',
      `${artifact.key}: SQLite quick_check failed`,
    );
    const allowedTables = catalog
      ? CATALOG_SNAPSHOT_TABLES.map(({ name }) => name)
      : artifact.key.endsWith('-grades.db')
        ? ['board_climb_grades']
        : ['board_climbs', 'board_climb_stats'];
    const tableNames = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name));
    requireCondition(
      tableNames.length === allowedTables.length + 1 &&
        tableNames.includes('snapshot_meta') &&
        allowedTables.every((name) => tableNames.includes(name)),
      `${artifact.key}: unexpected/missing SQLite tables`,
    );
    const metaRows = database.prepare('SELECT * FROM snapshot_meta').all();
    const expectedMetaRows =
      allowedTables.length + (metaRows.some((row) => row.table_name === 'sync_deletions') ? 1 : 0);
    requireCondition(metaRows.length === expectedMetaRows, `${artifact.key}: unexpected metadata tables`);
    if (!catalog) {
      requireCondition(
        artifact.boardType !== undefined && artifact.layoutId !== undefined,
        `${artifact.key}: missing layout scope`,
      );
      for (const tableName of allowedTables) {
        const outsideBoard = database
          .prepare(`SELECT count(*) AS count FROM ${tableName} WHERE board_type IS NULL OR board_type <> ?`)
          .get(artifact.boardType)?.count;
        requireCondition(outsideBoard === 0, `${artifact.key}: rows belong to another board`);
      }
      if (allowedTables.includes('board_climbs')) {
        const outsideLayout = database
          .prepare('SELECT count(*) AS count FROM board_climbs WHERE layout_id IS NULL OR layout_id <> ?')
          .get(artifact.layoutId)?.count;
        requireCondition(outsideLayout === 0, `${artifact.key}: rows belong to another layout`);
        const missingClimbs = database
          .prepare(
            'SELECT count(*) AS count FROM board_climb_stats AS stats WHERE NOT EXISTS (SELECT 1 FROM board_climbs AS climbs WHERE climbs.uuid = stats.climb_uuid AND climbs.board_type = stats.board_type)',
          )
          .get()?.count;
        requireCondition(missingClimbs === 0, `${artifact.key}: stats reference climbs outside this layout`);
      } else {
        requireCondition(mainArtifactPath, `${artifact.key}: missing verified main artifact for grades`);
        database.prepare('ATTACH DATABASE ? AS layout_artifact').run(mainArtifactPath);
        const missingClimbs = database
          .prepare(
            'SELECT count(*) AS count FROM board_climb_grades AS grades WHERE NOT EXISTS (SELECT 1 FROM layout_artifact.board_climbs AS climbs WHERE climbs.uuid = grades.climb_uuid AND climbs.board_type = grades.board_type)',
          )
          .get()?.count;
        requireCondition(missingClimbs === 0, `${artifact.key}: grades reference climbs outside this layout`);
      }
    }
    for (const tableName of allowedTables) {
      const meta = metaRows.find((row) => row.table_name === tableName);
      const expected = artifact.tables[tableName];
      requireCondition(meta && expected, `${artifact.key}: missing metadata for ${tableName}`);
      requireCondition(
        meta.format_version === (catalog ? 1 : SNAPSHOT_MANIFEST_FORMAT_VERSION) &&
          meta.schema_version === artifact.schemaVersion &&
          timestampMicros(String(meta.built_at)) === timestampMicros(artifact.builtAt),
        `${artifact.key}: format/schema/build mismatch for ${tableName}`,
      );
      requireCondition(
        catalog || artifact.schemaVersion >= ARTIFACT_SCHEMA_VERSION,
        `${artifact.key}: stale artifact schema`,
      );
      const actualCount = database.prepare(`SELECT count(*) AS count FROM ${tableName}`).get()?.count;
      requireCondition(
        actualCount === expected.rowCount && meta.row_count === expected.rowCount,
        `${artifact.key}: row count mismatch for ${tableName}`,
      );
      if (!catalog) {
        requireCondition('watermarkUpdatedAt' in expected, `${artifact.key}: missing table watermark`);
        const expectedMicros = timestampMicros(expected.watermarkUpdatedAt);
        requireCondition(
          timestampMicros(String(meta.watermark_updated_at)) === expectedMicros &&
            String(meta.watermark_sync_seq) === expected.watermarkSyncSeq,
          `${artifact.key}: manifest/meta watermark mismatch for ${tableName}`,
        );
        const cursorColumn = CURSOR_COLUMNS[tableName as keyof typeof CURSOR_COLUMNS];
        let maximumMicros = 0n;
        let maximumSeq = 0n;
        for (const row of database
          .prepare(`SELECT ${cursorColumn} AS cursor, CAST(sync_seq AS TEXT) AS seq FROM ${tableName}`)
          .iterate()) {
          const micros = timestampMicros(String(row.cursor));
          requireCondition(/^\d+$/.test(String(row.seq)), `${artifact.key}: invalid sync sequence`);
          const syncSeq = BigInt(String(row.seq));
          if (micros > maximumMicros || (micros === maximumMicros && syncSeq > maximumSeq)) {
            maximumMicros = micros;
            maximumSeq = syncSeq;
          }
        }
        requireCondition(
          maximumMicros === expectedMicros && maximumSeq === BigInt(expected.watermarkSyncSeq),
          `${artifact.key}: watermark does not match actual ${tableName} rows`,
        );
      }
    }
    const replay = metaRows.find((row) => row.table_name === 'sync_deletions');
    const liveMain = artifact.key.startsWith('board-snapshots/v1-gzip/') && !artifact.key.endsWith('-grades.db');
    requireCondition(!liveMain || replay, `${artifact.key}: missing live deletion replay boundary`);
    if (replay) {
      requireCondition(
        !catalog &&
          allowedTables.includes('board_climbs') &&
          replay.row_count === 0 &&
          String(replay.watermark_sync_seq) === '0' &&
          replay.format_version === SNAPSHOT_MANIFEST_FORMAT_VERSION &&
          replay.schema_version === artifact.schemaVersion &&
          timestampMicros(String(replay.built_at)) === timestampMicros(artifact.builtAt) &&
          timestampMicros(String(replay.watermark_updated_at)) <= timestampMicros(artifact.builtAt),
        `${artifact.key}: invalid deletion replay boundary`,
      );
    }
  } finally {
    database.close();
  }
}

export async function verifySnapshots(
  options: VerificationOptions,
  dependencies: VerificationDependencies,
): Promise<void> {
  const base = PUBLIC_BASE_URL;
  timestampMicros(options.builtAfter);
  requireCondition(parseSnapshotManifest(options.expectedManifest), 'Invalid trusted coverage manifest');
  validatedLayoutKeys(options.expectedManifest);
  const workDirectory = await mkdtemp(join(tmpdir(), 'boardsesh-snapshot-verify-'));
  let artifactCount = 0;
  let identityManifest: SnapshotManifest | undefined;
  const mainArtifactPaths = new Map<string, string>();
  try {
    for (const prefix of PREFIXES) {
      const key = `${prefix}/manifest.json`;
      const storedManifest = await dependencies.readObject(key);
      const signedBody = await readLimitedBody(storedManifest.body);
      requireCondition(
        storedManifest.contentType === 'application/json' && storedManifest.cacheControl?.includes('max-age=300'),
        `${key}: wrong signed manifest metadata`,
      );
      requireCondition(
        storedManifest.contentLength === undefined || storedManifest.contentLength === signedBody.length,
        `${key}: signed manifest length mismatch`,
      );
      // Reuse one fresh cache key for the entire export verification. Cloudflare
      // keys query values and Origin by default; changing the query per probe
      // would prevent warming, while the bare URL may retain the old 300s body.
      const manifestUrl = `${base}/${key}?verify=${encodeURIComponent(options.builtAfter)}`;
      let publicBody: Buffer | undefined;
      for (const origin of [undefined, 'https://app.boardsesh.com']) {
        const response = await dependencies.publicGet(manifestUrl, origin);
        assertHeaders(response.headers, true, key);
        publicBody = await readLimitedBody(responseBody(response));
        requireCondition(signedBody.equals(publicBody), `${key}: public manifest differs from signed S3 manifest`);
      }
      for (let attempt = 0; attempt < 13; attempt += 1) {
        const cached = await dependencies.publicGet(manifestUrl, 'https://app.boardsesh.com');
        assertHeaders(cached.headers, true, key);
        const cachedBody = await readLimitedBody(responseBody(cached));
        requireCondition(signedBody.equals(cachedBody), `${key}: cached manifest differs from signed S3 manifest`);
        if (cached.headers.get('cf-cache-status')?.toUpperCase() === 'HIT') break;
        requireCondition(attempt < 12, `${key}: manifest did not reach an edge cache HIT after 60 seconds`);
        await dependencies.sleep(5000);
      }
      const parsed: unknown = JSON.parse(publicBody!.toString('utf8'));
      const catalog = prefix === 'board-snapshots/v1-catalog';
      let artifacts: ArtifactToVerify[];
      let generatedAt: string;
      if (catalog) {
        const manifest = parseCatalogManifest(parsed);
        artifacts = [manifest.artifact];
        generatedAt = manifest.generatedAt;
      } else {
        const manifest = parseSnapshotManifest(parsed);
        requireCondition(manifest, `${key}: invalid shared manifest`);
        assertCoverage(manifest, options.expectedManifest);
        if (identityManifest) {
          assertCoverage(manifest, identityManifest);
          assertCoverage(identityManifest, manifest);
          for (const expectedEntry of options.expectedManifest.entries.filter((entry) => entry.grades)) {
            requireCondition(
              manifest.entries.find((entry) => layoutKey(entry) === layoutKey(expectedEntry))?.grades,
              `${key}: missing expected grades for ${layoutKey(expectedEntry)}`,
            );
          }
        } else identityManifest = manifest;
        generatedAt = manifest.generatedAt;
        artifacts = manifest.entries.flatMap((entry) => {
          requireCondition(
            entry.contentEncoding === (prefix.endsWith('v1-gzip') ? 'gzip' : 'identity'),
            `${entry.key}: wrong prefix encoding`,
          );
          if (!prefix.endsWith('v1-gzip'))
            requireCondition(!entry.grades, `${entry.key}: grades belong only in v1-gzip`);
          if (entry.grades)
            requireCondition(
              entry.grades.contentEncoding === 'gzip' && entry.grades.key.endsWith('-grades.db'),
              `${entry.grades.key}: wrong grades encoding/key`,
            );
          return [
            entry,
            ...(entry.grades
              ? [{ ...entry.grades, boardType: entry.boardType, layoutId: entry.layoutId, mainArtifactKey: entry.key }]
              : []),
          ];
        });
      }
      assertFresh(generatedAt, options.builtAfter, dependencies.now(), key);
      const keys = new Set<string>();
      for (const artifact of artifacts) {
        assertArtifact(artifact, prefix, base, options, dependencies.now());
        requireCondition(
          timestampMicros(artifact.builtAt) <= timestampMicros(generatedAt),
          `${artifact.key}: built after its manifest`,
        );
        requireCondition(!keys.has(artifact.key), `${artifact.key}: duplicate artifact reference`);
        keys.add(artifact.key);
        const stored = await dependencies.readObject(artifact.key);
        requireCondition(
          (stored.contentLength === undefined || stored.contentLength === artifact.bytes) &&
            stored.contentType === 'application/x-sqlite3' &&
            stored.cacheControl?.includes('immutable') &&
            (stored.contentEncoding ?? 'identity') === artifact.contentEncoding,
          `${artifact.key}: signed object metadata mismatch`,
        );
        const signedPath = join(workDirectory, `signed-${artifactCount}.db`);
        const maximumDecodedBytes = artifact.uncompressedBytes ?? MAX_ARTIFACT_BYTES;
        const signed = await downloadDecoded(stored.body, signedPath, {
          transferredBytes: artifact.bytes,
          decodedBytes: maximumDecodedBytes,
        });
        requireCondition(
          signed.transferredBytes === artifact.bytes && signed.gzip === (artifact.contentEncoding === 'gzip'),
          `${artifact.key}: stored bytes/encoding mismatch`,
        );
        requireCondition(
          artifact.uncompressedBytes === undefined || signed.decodedBytes === artifact.uncompressedBytes,
          `${artifact.key}: decoded size mismatch`,
        );
        verifySqlite(
          signedPath,
          artifact,
          catalog,
          artifact.mainArtifactKey ? mainArtifactPaths.get(artifact.mainArtifactKey) : undefined,
        );
        for (const origin of [undefined, 'https://app.boardsesh.com']) {
          const response = await dependencies.publicGet(artifact.url, origin);
          assertHeaders(response.headers, false, artifact.key);
          if (artifact.contentEncoding === 'gzip')
            requireCondition(
              response.headers.get('content-encoding') === 'gzip',
              `${artifact.key}: missing public gzip encoding`,
            );
          const publicResult = await downloadDecoded(responseBody(response), join(workDirectory, 'public.db'), {
            transferredBytes: Math.max(artifact.bytes, signed.decodedBytes),
            decodedBytes: signed.decodedBytes,
          });
          requireCondition(
            publicResult.sha256 === signed.sha256 && publicResult.decodedBytes === signed.decodedBytes,
            `${artifact.key}: public decoded bytes differ from signed S3 object`,
          );
        }
        artifactCount += 1;
        dependencies.report({
          status: 'verified',
          key: artifact.key,
          storedBytes: artifact.bytes,
          decodedBytes: signed.decodedBytes,
          decodedSha256: signed.sha256,
        });
        // Only the main file paired with a grades file survives until that grades check.
        const needsGrades = artifacts.some((candidate) => candidate.mainArtifactKey === artifact.key);
        if (needsGrades) mainArtifactPaths.set(artifact.key, signedPath);
        else await rm(signedPath);
        if (artifact.mainArtifactKey) {
          await rm(mainArtifactPaths.get(artifact.mainArtifactKey)!);
          mainArtifactPaths.delete(artifact.mainArtifactKey);
        }
        await rm(join(workDirectory, 'public.db'));
      }
      dependencies.report({ status: 'prefix-verified', prefix, generatedAt, artifacts: artifacts.length });
    }
    dependencies.report({
      status: 'passed',
      artifacts: artifactCount,
      publicBaseUrl: base,
      builtAfter: options.builtAfter,
    });
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

export function parseVerificationArgs(argv: string[]): { expectedManifestPath: string; builtAfter: string } {
  let expectedManifestPath = '';
  let builtAfter = '';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument !== '--expected-manifest' && argument !== '--built-after')
      throw new Error(`Unknown argument: ${argument}`);
    const argumentValue = argv[++index];
    requireCondition(argumentValue && !argumentValue.startsWith('--'), `${argument} requires a value`);
    if (argument === '--expected-manifest') expectedManifestPath = resolve(argumentValue);
    else builtAfter = argumentValue;
  }
  requireCondition(
    expectedManifestPath && builtAfter,
    'Required: --expected-manifest <trusted pre-export JSON> --built-after <UTC timestamp>',
  );
  timestampMicros(builtAfter);
  return { expectedManifestPath, builtAfter };
}

async function main(): Promise<void> {
  const argumentsParsed = parseVerificationArgs(process.argv.slice(2));
  const expectedManifestFile = await stat(argumentsParsed.expectedManifestPath);
  requireCondition(
    expectedManifestFile.isFile() && expectedManifestFile.size > 0 && expectedManifestFile.size <= MAX_MANIFEST_BYTES,
    'Trusted coverage manifest exceeds the bounded JSON limit or is not a file',
  );
  const expectedManifest = parseSnapshotManifest(
    JSON.parse(await readFile(argumentsParsed.expectedManifestPath, 'utf8')),
  );
  requireCondition(expectedManifest, 'Invalid trusted coverage manifest');
  const requiredEnvironment = (name: string): string => {
    const configured = process.env[name]?.trim();
    requireCondition(configured, `Missing environment variable: ${name}`);
    return configured;
  };
  const endpoint = new URL(requiredEnvironment('SNAPSHOTS_AWS_ENDPOINT_URL'));
  requireCondition(
    endpoint.protocol === 'https:' &&
      /^[a-z0-9]+\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname) &&
      endpoint.pathname === '/' &&
      !endpoint.port &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.search &&
      !endpoint.hash,
    'SNAPSHOTS_AWS_ENDPOINT_URL must be the R2 account endpoint',
  );
  const bucket = requiredEnvironment('SNAPSHOTS_S3_BUCKET_NAME');
  requireCondition(
    bucket === 'boardsesh-board-snapshots',
    'Verification requires the dedicated boardsesh-board-snapshots bucket',
  );
  const client = new S3Client({
    endpoint: endpoint.toString(),
    region: 'auto',
    forcePathStyle: true,
    credentials: {
      accessKeyId: requiredEnvironment('SNAPSHOTS_AWS_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnvironment('SNAPSHOTS_AWS_SECRET_ACCESS_KEY'),
    },
  });
  try {
    await verifySnapshots(
      { expectedManifest, builtAfter: argumentsParsed.builtAfter },
      {
        async readObject(key) {
          const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
            abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          requireCondition(response.Body, `${key}: missing signed S3 body`);
          return {
            body: response.Body as AsyncIterable<Uint8Array>,
            contentLength: response.ContentLength,
            contentEncoding: response.ContentEncoding,
            contentType: response.ContentType,
            cacheControl: response.CacheControl,
          };
        },
        publicGet: (url, origin) =>
          fetch(url, {
            redirect: 'error',
            headers: origin ? { Origin: origin } : {},
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }),
        sleep: (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
        now: Date.now,
        report: (message) => console.log(JSON.stringify(message)),
      },
    );
  } finally {
    client.destroy();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ status: 'failed', error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
}
