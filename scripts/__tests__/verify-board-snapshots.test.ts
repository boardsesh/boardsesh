import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { gzipSync, gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_SNAPSHOT_TABLES } from '../../packages/db/src/catalog-snapshot';
import { ARTIFACT_SCHEMA_VERSION } from '../../packages/shared/offline-sync/src/db/migrations';
import type {
  SnapshotManifest,
  SnapshotManifestEntry,
} from '../../packages/shared/offline-sync/src/sync/snapshot-manifest';
import {
  assertCoverage,
  downloadDecoded,
  parseVerificationArgs,
  timestampMicros,
  verifySnapshots,
  verifySqlite,
  type ArtifactToVerify,
  type VerificationDependencies,
} from '../verify-board-snapshots';

const BUILD_TIME = '2026-10-02T00:00:00.000Z';
const WATERMARK_TIME = '2026-10-01T00:00:00.000001Z';
const SEQUENCE = '9007199254740993';
const BASE = 'https://snapshots.boardsesh.com';
type FixtureObject = {
  contents: Buffer;
  contentType: string;
  contentEncoding: 'gzip' | 'identity';
  cacheControl: string;
};

let fixtureDirectory: string;
beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'snapshot-verifier-test-'));
});
afterEach(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

async function sqliteFixture(kind: 'main' | 'grades' | 'catalog'): Promise<Buffer> {
  const filePath = join(fixtureDirectory, `${kind}.db`);
  const database = new DatabaseSync(filePath);
  database.exec(
    `CREATE TABLE snapshot_meta (table_name TEXT PRIMARY KEY, row_count INTEGER, built_at TEXT, schema_version INTEGER, format_version INTEGER, watermark_updated_at TEXT, watermark_sync_seq TEXT)`,
  );
  const tables =
    kind === 'catalog'
      ? CATALOG_SNAPSHOT_TABLES.map(({ name }) => name)
      : kind === 'grades'
        ? ['board_climb_grades']
        : ['board_climbs', 'board_climb_stats'];
  for (const tableName of tables) {
    if (kind === 'catalog') {
      database.exec(`CREATE TABLE ${tableName} (id INTEGER); INSERT INTO ${tableName} VALUES (1)`);
    } else {
      const cursorColumn = kind === 'grades' ? 'computed_at' : 'updated_at';
      database.exec(
        `CREATE TABLE ${tableName} (uuid TEXT, climb_uuid TEXT, board_type TEXT, layout_id INTEGER, ${cursorColumn} TEXT, sync_seq INTEGER)`,
      );
      database
        .prepare(`INSERT INTO ${tableName} VALUES (?, ?, ?, ?, ?, ?)`)
        .run('climb-1', 'climb-1', 'kilter', 1, WATERMARK_TIME, BigInt(SEQUENCE));
    }
    database
      .prepare('INSERT INTO snapshot_meta VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        tableName,
        1,
        BUILD_TIME,
        kind === 'catalog' ? 1 : ARTIFACT_SCHEMA_VERSION,
        kind === 'catalog' ? 1 : 2,
        WATERMARK_TIME,
        SEQUENCE,
      );
  }
  if (kind === 'main')
    database
      .prepare('INSERT INTO snapshot_meta VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('sync_deletions', 0, BUILD_TIME, ARTIFACT_SCHEMA_VERSION, 2, WATERMARK_TIME, '0');
  database.close();
  return readFile(filePath);
}

async function fixture() {
  const objects = new Map<string, FixtureObject>();
  const main = await sqliteFixture('main');
  const grades = await sqliteFixture('grades');
  const catalog = await sqliteFixture('catalog');
  function artifact(prefix: string, contents: Buffer, kind: 'main' | 'grades' | 'catalog'): ArtifactToVerify {
    const key = `${prefix}/${kind === 'catalog' ? '' : 'kilter/1/'}2026-10-02T00-00-00-000Z${kind === 'grades' ? '-grades' : ''}.db`;
    const contentEncoding = prefix.endsWith('/v1') ? 'identity' : 'gzip';
    const stored = contentEncoding === 'gzip' ? gzipSync(contents) : contents;
    objects.set(key, {
      contents: stored,
      contentType: 'application/x-sqlite3',
      contentEncoding,
      cacheControl: 'public, max-age=31536000, immutable',
    });
    const tableNames =
      kind === 'catalog'
        ? CATALOG_SNAPSHOT_TABLES.map(({ name }) => name)
        : kind === 'grades'
          ? ['board_climb_grades']
          : ['board_climbs', 'board_climb_stats'];
    return {
      key,
      url: `${BASE}/${key}`,
      bytes: stored.length,
      uncompressedBytes: contents.length,
      contentEncoding,
      builtAt: BUILD_TIME,
      schemaVersion: kind === 'catalog' ? 1 : ARTIFACT_SCHEMA_VERSION,
      tables: Object.fromEntries(
        tableNames.map((tableName) => [
          tableName,
          kind === 'catalog'
            ? { rowCount: 1 }
            : { rowCount: 1, watermarkUpdatedAt: WATERMARK_TIME, watermarkSyncSeq: SEQUENCE },
        ]),
      ),
    };
  }
  const identity = {
    ...artifact('board-snapshots/v1', main, 'main'),
    boardType: 'kilter',
    layoutId: 1,
  } as SnapshotManifestEntry;
  const gzip = {
    ...artifact('board-snapshots/v1-gzip', main, 'main'),
    boardType: 'kilter',
    layoutId: 1,
    grades: artifact('board-snapshots/v1-gzip', grades, 'grades'),
  } as SnapshotManifestEntry;
  const catalogArtifact = artifact('board-snapshots/v1-catalog', catalog, 'catalog');
  const manifest = (entry: SnapshotManifestEntry): SnapshotManifest => ({
    formatVersion: 2,
    generatedAt: BUILD_TIME,
    entries: [entry],
  });
  function setManifest(prefix: string, contents: unknown) {
    objects.set(`${prefix}/manifest.json`, {
      contents: Buffer.from(JSON.stringify(contents)),
      contentType: 'application/json',
      contentEncoding: 'identity',
      cacheControl: 'public, max-age=300',
    });
  }
  setManifest('board-snapshots/v1', manifest(identity));
  setManifest('board-snapshots/v1-gzip', manifest(gzip));
  setManifest('board-snapshots/v1-catalog', { formatVersion: 1, generatedAt: BUILD_TIME, artifact: catalogArtifact });
  const publicGet = vi.fn(async (url: string, _origin?: string): Promise<Response> => {
    const key = new URL(url).pathname.slice(1);
    const object = objects.get(key);
    if (!object) return new Response(null, { status: 404 });
    return new Response(
      new Uint8Array(object.contentEncoding === 'gzip' ? gunzipSync(object.contents) : object.contents),
      {
        headers: {
          'Content-Type': object.contentType,
          'Content-Encoding': object.contentEncoding,
          'Cache-Control': object.cacheControl,
          'Access-Control-Allow-Origin': '*',
          'CF-Ray': 'fixture',
          'CF-Cache-Status': 'HIT',
        },
      },
    );
  });
  const report = vi.fn();
  const dependencies: VerificationDependencies = {
    async readObject(key) {
      const object = objects.get(key);
      if (!object) throw new Error(`Missing S3 object: ${key}`);
      return {
        body: Readable.from([object.contents]),
        contentLength: object.contents.length,
        contentType: object.contentType,
        contentEncoding: object.contentEncoding,
        cacheControl: object.cacheControl,
      };
    },
    publicGet,
    report,
    sleep: vi.fn(async () => {}),
    now: () => Date.parse('2026-10-02T00:01:00.000Z'),
  };
  return {
    objects,
    identity,
    gzip,
    catalogArtifact,
    setManifest,
    manifest,
    dependencies,
    publicGet,
    report,
    options: { expectedManifest: manifest(gzip), builtAfter: BUILD_TIME },
  };
}

describe('complete snapshot verification', () => {
  it('checks identity, gzip, grades and catalog through signed and both public request forms', async () => {
    const setup = await fixture();
    await verifySnapshots(setup.options, setup.dependencies);
    expect(setup.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'passed', artifacts: 4 }));
    for (const key of [setup.identity.key, setup.gzip.key, setup.gzip.grades!.key, setup.catalogArtifact.key]) {
      expect(setup.publicGet.mock.calls.filter(([url]) => url === `${BASE}/${key}`)).toHaveLength(2);
      expect(setup.publicGet).toHaveBeenCalledWith(`${BASE}/${key}`, undefined);
      expect(setup.publicGet).toHaveBeenCalledWith(`${BASE}/${key}`, 'https://app.boardsesh.com');
    }
  });

  it('accepts chunked signed bodies while rejecting an incorrect length header when present', async () => {
    const setup = await fixture();
    const readObject = setup.dependencies.readObject;
    setup.dependencies.readObject = async (key) => ({ ...(await readObject(key)), contentLength: undefined });
    await verifySnapshots(setup.options, setup.dependencies);
    expect(setup.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'passed', artifacts: 4 }));
    setup.dependencies.readObject = async (key) => ({
      ...(await readObject(key)),
      contentLength: setup.objects.get(key)!.contents.length + 1,
    });
    await expect(verifySnapshots(setup.options, setup.dependencies)).rejects.toThrow('signed manifest length mismatch');
  });

  it('still requires exact streamed artifact bytes when the signed length header is absent', async () => {
    const setup = await fixture();
    const readObject = setup.dependencies.readObject;
    setup.dependencies.readObject = async (key) => {
      const object = await readObject(key);
      return {
        ...object,
        contentLength: undefined,
        body:
          key === setup.identity.key ? Readable.from([setup.objects.get(key)!.contents.subarray(0, -1)]) : object.body,
      };
    };
    await expect(verifySnapshots(setup.options, setup.dependencies)).rejects.toThrow('stored bytes/encoding mismatch');
  });

  it('warms the same per-export query and Origin cache key after an initial MISS', async () => {
    const setup = await fixture();
    const publicGet = setup.dependencies.publicGet;
    const cacheKeys = new Set<string>();
    setup.dependencies.publicGet = vi.fn(async (url, origin) => {
      const response = await publicGet(url, origin);
      if (new URL(url).pathname.endsWith('/manifest.json')) {
        const cacheKey = `${url}:${origin ?? ''}`;
        response.headers.set('CF-Cache-Status', cacheKeys.has(cacheKey) ? 'HIT' : 'MISS');
        cacheKeys.add(cacheKey);
      }
      return response;
    });
    await verifySnapshots(setup.options, setup.dependencies);
    for (const prefix of ['v1', 'v1-gzip', 'v1-catalog']) {
      const manifestCalls = setup.publicGet.mock.calls.filter(
        ([url]) => new URL(url).pathname === `/board-snapshots/${prefix}/manifest.json`,
      );
      expect(manifestCalls).toHaveLength(3);
      expect(new Set(manifestCalls.map(([url]) => url))).toEqual(
        new Set([`${BASE}/board-snapshots/${prefix}/manifest.json?verify=${encodeURIComponent(BUILD_TIME)}`]),
      );
      expect(manifestCalls.map(([, origin]) => origin)).toEqual([
        undefined,
        'https://app.boardsesh.com',
        'https://app.boardsesh.com',
      ]);
    }
    expect(setup.dependencies.sleep).not.toHaveBeenCalled();
  });

  it('rejects empty and duplicate trusted coverage before downloading any object', async () => {
    const setup = await fixture();
    const readObject = vi.fn(setup.dependencies.readObject);
    setup.dependencies.readObject = readObject;
    const expectedManifest: SnapshotManifest = { ...setup.options.expectedManifest, entries: [] };
    await expect(verifySnapshots({ ...setup.options, expectedManifest }, setup.dependencies)).rejects.toThrow(
      'Manifest coverage is empty',
    );
    expectedManifest.entries = [setup.gzip, setup.gzip];
    await expect(verifySnapshots({ ...setup.options, expectedManifest }, setup.dependencies)).rejects.toThrow(
      'Manifest contains duplicate layouts',
    );
    expect(readObject).not.toHaveBeenCalled();
  });

  it('rejects omitted layouts and omitted grades from the trusted coverage baseline', async () => {
    const setup = await fixture();
    expect(() =>
      assertCoverage(setup.manifest(setup.identity), setup.manifest({ ...setup.identity, boardType: 'tension' })),
    ).toThrow('Missing expected layout');
    const { grades: _grades, ...missingGrades } = setup.gzip;
    setup.setManifest('board-snapshots/v1-gzip', setup.manifest(missingGrades));
    await expect(verifySnapshots(setup.options, setup.dependencies)).rejects.toThrow('missing expected grades');
  });

  it('rejects a valid object labeled as another layout', async () => {
    const setup = await fixture();
    setup.identity.key = setup.identity.key.replace('/kilter/1/', '/kilter/2/');
    setup.identity.url = `${BASE}/${setup.identity.key}`;
    setup.setManifest('board-snapshots/v1', setup.manifest(setup.identity));
    await expect(verifySnapshots(setup.options, setup.dependencies)).rejects.toThrow(
      'key does not match the labeled layout',
    );
  });

  it('rejects old artifacts even when the manifest was rewritten freshly', async () => {
    const setup = await fixture();
    setup.identity.builtAt = '2026-10-01T00:00:00.000Z';
    setup.setManifest('board-snapshots/v1', setup.manifest(setup.identity));
    await expect(verifySnapshots(setup.options, setup.dependencies)).rejects.toThrow(
      'predates the controlled full export',
    );
  });

  it('rejects a public body with different decoded bytes', async () => {
    const setup = await fixture();
    const original = setup.dependencies.publicGet;
    setup.dependencies.publicGet = async (url, origin) => {
      const response = await original(url, origin);
      if (url === setup.identity.url) {
        const contents = new Uint8Array(await response.arrayBuffer());
        contents[contents.length - 1] ^= 1;
        return new Response(contents, { headers: response.headers });
      }
      return response;
    };
    await expect(verifySnapshots(setup.options, setup.dependencies)).rejects.toThrow('public decoded bytes differ');
  });

  it('rejects count and watermark disagreement with the actual rows', async () => {
    const setup = await fixture();
    setup.identity.tables.board_climbs.watermarkSyncSeq = '9007199254740992';
    setup.setManifest('board-snapshots/v1', setup.manifest(setup.identity));
    await expect(verifySnapshots(setup.options, setup.dependencies)).rejects.toThrow(
      'manifest/meta watermark mismatch',
    );
    const artifact = {
      ...setup.identity,
      tables: { ...setup.identity.tables, board_climbs: { ...setup.identity.tables.board_climbs, rowCount: 2 } },
    };
    expect(() => verifySqlite(join(fixtureDirectory, 'main.db'), artifact, false)).toThrow('row count mismatch');
  });

  it('checks microsecond and bigint ordering against rows, including mixed precision', async () => {
    const setup = await fixture();
    const filePath = join(fixtureDirectory, 'main.db');
    const database = new DatabaseSync(filePath);
    database.prepare('UPDATE board_climbs SET updated_at = ?').run('2026-10-01T00:00:00.000002Z');
    database.close();
    expect(() => verifySqlite(filePath, setup.identity, false)).toThrow('watermark does not match actual');
    expect(timestampMicros('2026-10-01T00:00:00.5Z') > timestampMicros('2026-10-01T00:00:00.25Z')).toBe(true);
  });

  it('rejects rows from another layout and grades outside the main climb set', async () => {
    const setup = await fixture();
    const mainPath = join(fixtureDirectory, 'main.db');
    const mainDatabase = new DatabaseSync(mainPath);
    mainDatabase.exec('UPDATE board_climbs SET layout_id = 2');
    mainDatabase.close();
    expect(() => verifySqlite(mainPath, setup.identity, false)).toThrow('another layout');
    const gradePath = join(fixtureDirectory, 'grades.db');
    const gradesDatabase = new DatabaseSync(gradePath);
    gradesDatabase.exec("UPDATE board_climb_grades SET climb_uuid = 'outside'");
    gradesDatabase.close();
    expect(() =>
      verifySqlite(gradePath, { ...setup.gzip.grades!, boardType: 'kilter', layoutId: 1 }, false, mainPath),
    ).toThrow('grades reference climbs outside');
  });

  it('rejects missing deletion replay metadata and corrupt SQLite', async () => {
    const setup = await fixture();
    const filePath = join(fixtureDirectory, 'main.db');
    const database = new DatabaseSync(filePath);
    database.exec("DELETE FROM snapshot_meta WHERE table_name = 'sync_deletions'");
    database.close();
    expect(() => verifySqlite(filePath, setup.gzip, false)).toThrow('missing live deletion replay boundary');
    const file = await readFile(filePath);
    await expect(
      downloadDecoded(Readable.from([file.subarray(0, 100)]), join(fixtureDirectory, 'truncated.db'), {
        transferredBytes: file.length,
        decodedBytes: file.length,
      }),
    ).resolves.toBeDefined();
    expect(() => verifySqlite(join(fixtureDirectory, 'truncated.db'), setup.identity, false)).toThrow();
  });

  it('rejects missing CORS and limits cache probes instead of passing a cold edge', async () => {
    const setup = await fixture();
    const original = setup.dependencies.publicGet;
    setup.dependencies.publicGet = async (url, origin) => {
      const response = await original(url, origin);
      response.headers.set('CF-Cache-Status', 'MISS');
      return response;
    };
    await expect(verifySnapshots(setup.options, setup.dependencies)).rejects.toThrow('60 seconds');
    expect(setup.dependencies.sleep).toHaveBeenCalledTimes(12);
    setup.dependencies.publicGet = async (url, origin) => {
      const response = await original(url, origin);
      response.headers.delete('Access-Control-Allow-Origin');
      return response;
    };
    await expect(verifySnapshots(setup.options, setup.dependencies)).rejects.toThrow('wildcard CORS');
  });
});

describe('bounded decoding and CLI', () => {
  it('sniffs split gzip headers, validates CRC, and rejects transferred/decoded excess', async () => {
    const decoded = Buffer.from('SQLite format 3\0'.repeat(500));
    const compressed = gzipSync(decoded);
    const destination = join(fixtureDirectory, 'decoded.db');
    const limits = { transferredBytes: compressed.length, decodedBytes: decoded.length };
    await downloadDecoded(Readable.from([compressed.subarray(0, 1), compressed.subarray(1)]), destination, limits);
    expect(await readFile(destination)).toEqual(decoded);
    await expect(downloadDecoded(Readable.from([compressed.subarray(0, -2)]), destination, limits)).rejects.toThrow();
    await expect(
      downloadDecoded(Readable.from([compressed]), destination, { ...limits, decodedBytes: 10 }),
    ).rejects.toThrow('decoded byte limit');
    const oversizedSource = Readable.from([compressed]);
    await expect(downloadDecoded(oversizedSource, destination, { ...limits, transferredBytes: 1 })).rejects.toThrow(
      'transferred byte limit',
    );
    expect(oversizedSource.destroyed).toBe(true);
  });

  it('destroys a stalled body after the independent streaming deadline', async () => {
    const body = new Readable({ read() {} });
    await expect(
      downloadDecoded(body, join(fixtureDirectory, 'stall.db'), {
        transferredBytes: 100,
        decodedBytes: 100,
        timeoutMs: 10,
      }),
    ).rejects.toThrow('timed out');
    expect(body.destroyed).toBe(true);
  });

  it('requires a pre-export coverage file and UTC freshness boundary', () => {
    expect(() => parseVerificationArgs([])).toThrow('Required:');
    expect(() => parseVerificationArgs(['--expected-manifest', 'baseline.json', '--built-after', 'yesterday'])).toThrow(
      'Invalid UTC timestamp',
    );
    expect(parseVerificationArgs(['--', '--expected-manifest', 'baseline.json', '--built-after', BUILD_TIME])).toEqual({
      expectedManifestPath: expect.stringMatching(/baseline\.json$/),
      builtAfter: BUILD_TIME,
    });
  });
});
