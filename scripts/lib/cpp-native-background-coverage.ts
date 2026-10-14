import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { GET_MY_BOARDS, QUEUE_UPDATES_SUBSCRIPTION } from '../../packages/mobile/src/lib/graphql/operations';
import { JOIN_SESSION } from '../../packages/shared/graphql/src/operations/queue-session';
import { CPP_BOOTSTRAP_PROFILE_QUERY, resolveBootstrapUpstream } from '../bootstrap-cpp-scenario';
import { canonicalCampaignDocument, NATIVE_CAMPAIGN_JOIN_QUERY } from './screenshot-campaign-session';
import { readCppPage } from './screenshot-cpp';
import {
  canonicalJson,
  finalizeRecordingFrozenNow,
  graphqlFixtureKey,
  sortedQueryString,
  staticFixtureKey,
  validateScreenshotFixtureManifest,
  type GraphqlFixtureFile,
  type ScreenshotFixtureManifest,
  type StaticManifestEntry,
} from './screenshot-fixtures';
import type { CppDetailRecordingOptions } from './cpp-detail-coverage';

const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (): never => {
  throw new Error('CPP native background coverage lacks exact owned source provenance');
};
const responseField = (fixture: GraphqlFixtureFile, field: string): Record<string, unknown> => {
  if (
    !object(fixture.response) ||
    fixture.response.errors !== undefined ||
    !object(fixture.response.data) ||
    !object(fixture.response.data[field])
  )
    return fail();
  return fixture.response.data[field];
};
export type NativeBackgroundSource = { file: string; sha256: string };
export type CppNativeBackgroundPlan = {
  accountUserId: string;
  sessionId: string;
  boardId: string;
  nativeJoin: { operationName: 'JoinSession'; query: string; variables: { sessionId: string; boardPath: string } };
  requests: string[];
  sourceFiles: string[];
};

/** Derive only the real primary queue's current and adjacent iOS thumbnail requests. */
export function resolveCppNativeBackgroundPlan(
  manifest: ScreenshotFixtureManifest,
  fixtures: readonly GraphqlFixtureFile[],
): CppNativeBackgroundPlan | null {
  if (manifest.capture?.cpp?.target !== 'spray') return null;
  const coverage = manifest.capture.cpp;
  const primary = readCppPage('spray').primaryBoard;
  const boardId = coverage.boardIds?.[primary.id];
  const sessionId = manifest.capture.sharedSessionId;
  if (
    manifest.flow !== 'app-store-cpp' ||
    !Number.isFinite(Date.parse(manifest.frozenNow)) ||
    !manifest.accountUserId ||
    !boardId ||
    !sessionId ||
    coverage.scenes.queue?.sessionId !== sessionId ||
    coverage.scenes.queue.boardId !== boardId ||
    coverage.scenes.search?.boardId !== boardId ||
    fixtures.length !== manifest.graphql.length
  )
    return fail();
  const sourceFiles = new Set<string>();
  function source(
    operation: string,
    query: string,
    match: (fixture: GraphqlFixtureFile) => boolean,
  ): GraphqlFixtureFile {
    const matches = fixtures.filter(
      (fixture) =>
        fixture.operationName === operation &&
        canonicalCampaignDocument(fixture.query) === canonicalCampaignDocument(query) &&
        match(fixture),
    );
    if (matches.length !== 1) return fail();
    const fixture = matches[0];
    const key = graphqlFixtureKey(fixture, digest);
    const entries = manifest.graphql.filter(
      (entry) => entry.operationName === operation && entry.variablesHash === key.variablesHash,
    );
    if (
      fixture.formatVersion !== 1 ||
      fixture.status !== 200 ||
      fixture.upstream !== manifest.upstream ||
      fixture.documentHash !== key.documentHash ||
      fixture.variablesHash !== key.variablesHash ||
      !Number.isFinite(Date.parse(fixture.recordedAt)) ||
      Date.parse(fixture.recordedAt) > Date.parse(manifest.frozenNow) ||
      entries.length !== 1 ||
      entries[0].documentHash !== key.documentHash ||
      entries[0].file !== `graphql/${operation}/${key.variablesHash.slice(0, 16)}.json`
    )
      return fail();
    sourceFiles.add(entries[0].file);
    return fixture;
  }
  const matching: Record<string, unknown>[] = [];
  for (const variables of [{}, { input: { limit: 50, offset: 0 } }]) {
    const rows = fixtures.filter(
      (fixture) =>
        fixture.operationName === 'GetMyBoards' &&
        canonicalCampaignDocument(fixture.query) === canonicalCampaignDocument(GET_MY_BOARDS) &&
        canonicalJson(fixture.variables) === canonicalJson(variables),
    );
    if (!rows.length) continue;
    const roster = source(
      'GetMyBoards',
      GET_MY_BOARDS,
      (fixture) => canonicalJson(fixture.variables) === canonicalJson(variables),
    );
    const boards = responseField(roster, 'myBoards').boards;
    if (!Array.isArray(boards)) return fail();
    const owned = boards.filter((board) => object(board) && board.uuid === boardId);
    if (owned.length > 1) return fail();
    if (owned.length === 1 && object(owned[0])) matching.push(owned[0]);
  }
  if (!matching.length) return fail();
  const identity = (board: Record<string, unknown>) =>
    canonicalJson(
      Object.fromEntries(
        ['uuid', 'boardType', 'ownerId', 'isPublic', 'canEdit', 'slug', 'layoutId', 'sizeId', 'setIds', 'angle'].map(
          (key) => [key, board[key]],
        ),
      ),
    );
  const board = matching[0];
  if (matching.some((row) => identity(row) !== identity(board))) return fail();
  if (
    board.boardType !== 'spray' ||
    board.ownerId !== manifest.accountUserId ||
    board.isPublic !== false ||
    board.canEdit !== true ||
    typeof board.slug !== 'string' ||
    !/^[a-z0-9-]+$/.test(board.slug) ||
    !Number.isSafeInteger(board.layoutId) ||
    Number(board.layoutId) < 1 ||
    !Number.isSafeInteger(board.sizeId) ||
    Number(board.sizeId) < 1 ||
    typeof board.setIds !== 'string' ||
    !/^\d+(,\d+)*$/.test(board.setIds) ||
    typeof board.angle !== 'number' ||
    !Number.isFinite(board.angle)
  )
    return fail();
  const originalJoin = source(
    'JoinSession',
    JOIN_SESSION,
    (fixture) => object(fixture.variables) && fixture.variables.sessionId === sessionId,
  );
  const joined = responseField(originalJoin, 'joinSession');
  if (
    !object(originalJoin.variables) ||
    originalJoin.variables.boardPath !== `/b/${board.slug}/${board.angle}` ||
    joined.boardPath !== originalJoin.variables.boardPath ||
    joined.id !== sessionId ||
    joined.isPublic !== false ||
    joined.isLeader !== true ||
    !Array.isArray(joined.users) ||
    !joined.users.some((user) => object(user) && user.userId === manifest.accountUserId && user.isLeader === true) ||
    !object(joined.queueState)
  )
    return fail();
  const queueFixture = source(
    'QueueUpdates',
    QUEUE_UPDATES_SUBSCRIPTION,
    (fixture) => canonicalJson(fixture.variables) === canonicalJson({ sessionId }),
  );
  const update = responseField(queueFixture, 'queueUpdates');
  if (update.__typename !== 'FullSync' || !object(update.state)) return fail();
  const state = update.state;
  if (
    !Array.isArray(state.queue) ||
    state.queue.length < 1 ||
    state.queue.length > 12 ||
    !object(state.currentClimbQueueItem) ||
    canonicalJson(state.queue) !== canonicalJson(joined.queueState.queue) ||
    canonicalJson(state.currentClimbQueueItem) !== canonicalJson(joined.queueState.currentClimbQueueItem)
  )
    return fail();
  const current = state.currentClimbQueueItem;
  const currentIndex = state.queue.findIndex((item) => object(item) && item.uuid === current.uuid);
  if (currentIndex < 0 || state.queue.filter((item) => object(item) && item.uuid === current.uuid).length !== 1)
    return fail();
  const requests = new Set<string>();
  for (const item of state.queue.slice(Math.max(0, currentIndex - 1), currentIndex + 2)) {
    if (!object(item) || !object(item.climb)) return fail();
    const climb = item.climb;
    if (
      climb.boardType !== 'spray' ||
      climb.layoutId !== board.layoutId ||
      climb.angle !== board.angle ||
      typeof climb.frames !== 'string' ||
      !/^(?:p\d+r\d+)+$/.test(climb.frames) ||
      climb.frames.length > 16384
    )
      return fail();
    const query = new URLSearchParams({
      board_name: 'spray',
      layout_id: String(board.layoutId),
      size_id: String(board.sizeId),
      set_ids: board.setIds,
      frames: climb.frames,
      thumbnail: '1',
      include_background: '1',
      dim_background: '0.18',
      render_mode: 'aura',
    });
    requests.add(`/api/internal/board-render?${sortedQueryString(query)}`);
  }
  return {
    accountUserId: manifest.accountUserId,
    sessionId,
    boardId,
    nativeJoin: {
      operationName: 'JoinSession',
      query: NATIVE_CAMPAIGN_JOIN_QUERY,
      variables: { sessionId, boardPath: `/spray/${String(board.layoutId)}/${String(board.sizeId)}/${board.setIds}/0` },
    },
    requests: [...requests].sort(),
    sourceFiles: [...sourceFiles].sort(),
  };
}

export function assertCppNativeJoinResponse(response: unknown, sessionId: string): void {
  if (
    !object(response) ||
    Object.keys(response).join(',') !== 'data' ||
    !object(response.data) ||
    Object.keys(response.data).join(',') !== 'joinSession' ||
    !object(response.data.joinSession)
  )
    return fail();
  const joined = response.data.joinSession;
  if (
    Object.keys(joined).sort().join(',') !== 'clientId,id' ||
    joined.id !== sessionId ||
    typeof joined.clientId !== 'string' ||
    !/^[\w-]{1,128}$/.test(joined.clientId)
  )
    return fail();
}

/** A recorded application failure, never an image, a fallback, or an inferred response. */
export function assertCppUnsupportedRenderBody(bytes: Buffer, contentType: string, status: number): void {
  if (status !== 400 || contentType !== 'application/json' || !bytes.length || bytes.length > 1024)
    throw new Error('CPP native render response is not the genuine supported negative contract');
  let body: unknown;
  try {
    body = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('CPP native render response is not JSON');
  }
  if (!object(body) || canonicalJson(body) !== canonicalJson({ error: 'Invalid board configuration' }))
    throw new Error('CPP native render response is not the expected application error');
}

export function assertCppNegativeStaticEntry(
  entry: StaticManifestEntry,
  bytes: Buffer,
  plan: CppNativeBackgroundPlan | null,
  sources: readonly NativeBackgroundSource[],
  frozenNow: string,
): void {
  if (!entry.response) return;
  const request = entry.query ? `${entry.path}?${entry.query}` : entry.path;
  if (
    !plan ||
    !Number.isFinite(Date.parse(frozenNow)) ||
    !plan.requests.includes(request) ||
    entry.file !== `static/${staticFixtureKey(entry.path, new URLSearchParams(entry.query), digest)}.json` ||
    entry.bytes !== bytes.length ||
    entry.response.sha256 !== digest(bytes) ||
    !Number.isFinite(Date.parse(entry.response.recordedAt)) ||
    Date.parse(entry.response.recordedAt) > Date.parse(frozenNow) ||
    canonicalJson(entry.response.sources) !== canonicalJson(sources)
  )
    return fail();
  assertCppUnsupportedRenderBody(bytes, entry.contentType, entry.response.status);
}

/** Shared archive, cache, retained-source and final-candidate boundary. Legacy images retain HTTP 200. */
export function assertCppNegativeFixtureFiles(manifestValue: unknown, read: (file: string) => Buffer): void {
  if (
    !object(manifestValue) ||
    !Array.isArray(manifestValue.static) ||
    !manifestValue.static.some((entry) => object(entry) && entry.response !== undefined)
  )
    return;
  const validated = validateScreenshotFixtureManifest(manifestValue);
  if (!validated.ok) return fail();
  const manifest = validated.manifest;
  const fixtures = manifest.graphql.map((entry) => JSON.parse(read(entry.file).toString('utf8')) as GraphqlFixtureFile);
  const plan = resolveCppNativeBackgroundPlan(manifest, fixtures);
  if (!plan) return fail();
  const sources = plan.sourceFiles.map((file) => ({ file, sha256: digest(read(file)) }));
  const requests = new Set<string>();
  for (const entry of manifest.static) {
    const request = `${entry.path}?${entry.query}`;
    if (requests.has(request)) return fail();
    requests.add(request);
    if (entry.response) {
      if (manifest.static.filter((candidate) => candidate.file === entry.file).length !== 1) return fail();
      assertCppNegativeStaticEntry(entry, read(entry.file), plan, sources, manifest.frozenNow);
    }
  }
}

export function readCppBackgroundFile(directory: string, file: string): Buffer {
  if (
    !/^(graphql|static)\/[\w./-]+$/.test(file) ||
    file.split('/').some((part) => !part || part === '.' || part === '..')
  )
    return fail();
  let path = directory;
  for (const part of file.split('/')) {
    path = join(path, part);
    if (lstatSync(path).isSymbolicLink()) return fail();
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > (file.startsWith('static/') ? 1024 : 8 * 1024 * 1024)) return fail();
  return readFileSync(path);
}

export async function fetchCppUnsupportedRender(
  upstream: string,
  request: string,
  plan: CppNativeBackgroundPlan,
  fetcher: typeof fetch = fetch,
) {
  if (!plan.requests.includes(request)) return fail();
  try {
    const startedAt = new Date().toISOString();
    const response = await fetcher(`${upstream}${request}`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    if (
      response.status !== 400 ||
      contentType !== 'application/json' ||
      !response.body ||
      (response.url && response.url !== `${upstream}${request}`) ||
      (response.headers.has('content-length') &&
        (!/^\d+$/.test(response.headers.get('content-length')!) ||
          Number(response.headers.get('content-length')) > 1024))
    ) {
      await response.body?.cancel();
      throw new Error('CPP native render response is not an eligible application failure');
    }
    const chunks: Uint8Array[] = [];
    const reader = response.body.getReader();
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 1024) throw new Error('CPP native render response exceeds its byte limit');
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = Buffer.concat(chunks);
    if (response.headers.has('content-length') && Number(response.headers.get('content-length')) !== bytes.length)
      return fail();
    assertCppUnsupportedRenderBody(bytes, contentType, response.status);
    return { bytes, contentType, startedAt, completedAt: new Date().toISOString(), sourceUrl: `${upstream}${request}` };
  } catch {
    throw new Error('CPP native render genuine response recording failed');
  }
}

function hashes(directory: string, prefix = ''): Map<string, string> {
  const entries = new Map<string, string>();
  for (const name of readdirSync(join(directory, prefix))) {
    const file = join(prefix, name),
      details = lstatSync(join(directory, file));
    if (details.isDirectory()) for (const [nested, hash] of hashes(directory, file)) entries.set(nested, hash);
    else if (details.isFile()) entries.set(file, digest(readFileSync(join(directory, file))));
    else throw new Error('CPP native recording has an unsupported file');
  }
  return entries;
}

async function authenticateNativeOwner(
  origin: string,
  options: CppDetailRecordingOptions,
  plan: CppNativeBackgroundPlan,
): Promise<string> {
  try {
    const auth = await fetch(`${origin}/auth/native/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: options.email, password: options.password }),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    if (!auth.ok) throw new Error('CPP native background authentication failed');
    const body: unknown = await auth.json();
    if (!object(body) || typeof body.jwt !== 'string') return fail();
    const jwt = body.jwt;
    const profile = await fetch(`${origin}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ query: CPP_BOOTSTRAP_PROFILE_QUERY, variables: {} }),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    const profileBody: unknown = await profile.json();
    if (
      !profile.ok ||
      !object(profileBody) ||
      profileBody.errors !== undefined ||
      !object(profileBody.data) ||
      !object(profileBody.data.profile) ||
      profileBody.data.profile.id !== plan.accountUserId
    )
      return fail();
    return jwt;
  } catch {
    throw new Error('CPP native background authentication failed');
  }
}

async function recordMinimalJoin(
  origin: string,
  options: CppDetailRecordingOptions,
  plan: CppNativeBackgroundPlan,
): Promise<void> {
  const jwt = await authenticateNativeOwner(origin, options, plan);
  await new Promise<void>((resolve, reject) => {
    const websocketUrl = new URL('/graphql', origin);
    websocketUrl.protocol = 'ws:';
    const socket = new WebSocket(websocketUrl, 'graphql-transport-ws', { maxPayload: 1024 * 1024 });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error('CPP native minimal join timed out')), 45_000);
    socket.on('error', () => finish(new Error('CPP native minimal join failed')));
    socket.on('close', () => {
      if (!settled) finish(new Error('CPP native minimal join closed early'));
    });
    socket.on('open', () => socket.send(JSON.stringify({ type: 'connection_init', payload: { authToken: jwt } })));
    socket.on('message', (raw) => {
      try {
        const contents = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const message: unknown = JSON.parse(contents.toString('utf8'));
        if (!object(message)) return fail();
        if (message.type === 'connection_ack')
          socket.send(JSON.stringify({ id: 'native-join', type: 'subscribe', payload: plan.nativeJoin }));
        else if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
        else if (message.type === 'next' && message.id === 'native-join') {
          assertCppNativeJoinResponse(message.payload, plan.sessionId);
          finish();
        } else if (message.type === 'error' || message.type === 'complete')
          finish(new Error('CPP native minimal join returned no valid response'));
      } catch {
        finish(new Error('CPP native minimal join response was rejected'));
      }
    });
  });
}

function recordedNativeJoin(
  manifest: ScreenshotFixtureManifest,
  read: (file: string) => Buffer,
  plan: CppNativeBackgroundPlan,
) {
  const key = graphqlFixtureKey(plan.nativeJoin, digest);
  const entries = manifest.graphql.filter(
    (entry) => entry.operationName === 'JoinSession' && entry.variablesHash === key.variablesHash,
  );
  if (!entries.length) return undefined;
  const entry = entries[0];
  if (
    entries.length !== 1 ||
    entry.documentHash !== key.documentHash ||
    entry.file !== `graphql/JoinSession/${key.variablesHash.slice(0, 16)}.json`
  )
    return fail();
  const fixture = JSON.parse(read(entry.file).toString('utf8')) as GraphqlFixtureFile;
  const actualKey = graphqlFixtureKey(fixture, digest);
  if (
    fixture.formatVersion !== 1 ||
    fixture.status !== 200 ||
    fixture.upstream !== manifest.upstream ||
    fixture.operationName !== 'JoinSession' ||
    actualKey.documentHash !== key.documentHash ||
    actualKey.variablesHash !== key.variablesHash ||
    fixture.documentHash !== key.documentHash ||
    fixture.variablesHash !== key.variablesHash ||
    !Number.isFinite(Date.parse(fixture.recordedAt)) ||
    Date.parse(fixture.recordedAt) > Date.parse(manifest.frozenNow)
  )
    return fail();
  assertCppNativeJoinResponse(fixture.response, plan.sessionId);
  return { entry, fixture };
}

/** Extend only a temporary verified recording; original records are immutable. */
export async function withCppNativeBackgroundCoverage<T>(
  input: string,
  options: CppDetailRecordingOptions,
  prepare: (recording: string) => Promise<T>,
): Promise<T> {
  const { createScreenshotBackend, readScreenshotFixtureManifest } = await import('./screenshot-backend');
  const original = readScreenshotFixtureManifest(input);
  if (!original) return fail();
  if (original.capture?.cpp?.target !== 'spray') return await prepare(input);
  const fixtures = original.graphql.map(
    (entry) => JSON.parse(readCppBackgroundFile(input, entry.file).toString('utf8')) as GraphqlFixtureFile,
  );
  const plan = resolveCppNativeBackgroundPlan(original, fixtures);
  if (!plan) return await prepare(input);
  const upstream = resolveBootstrapUpstream(options.upstream);
  if (upstream !== original.upstream || options.email !== original.accountEmail || !options.password) return fail();
  const originalHashes = hashes(input);
  const sources = plan.sourceFiles.map((file) => ({ file, sha256: originalHashes.get(file)! }));
  assertCppNegativeFixtureFiles(original, (file) => readCppBackgroundFile(input, file));
  const existingNative = recordedNativeJoin(original, (file) => readCppBackgroundFile(input, file), plan);
  const complete =
    existingNative &&
    plan.requests.every((request) =>
      original.static.some((entry) => entry.response && `${entry.path}?${entry.query}` === request),
    );
  if (complete) {
    await authenticateNativeOwner(upstream, options, plan);
    return await prepare(input);
  }
  const scratch = mkdtempSync(join(tmpdir(), 'boardsesh-cpp-native-background-'));
  const recording = join(scratch, 'recording');
  let recorder: ReturnType<typeof createScreenshotBackend> | undefined;
  try {
    cpSync(input, recording, { recursive: true, errorOnExist: true, force: false });
    let completed = structuredClone(original);
    if (!existingNative) {
      let rejected = false;
      recorder = createScreenshotBackend({
        mode: 'record',
        fixturesDir: recording,
        upstreamUrl: upstream,
        frozenNow: original.frozenNow,
        flow: original.flow,
        pseudonymise: true,
        nativeJoinRecording: plan.nativeJoin,
        log: (line) => {
          if (/UPSTREAM-ERROR|REDACTED|MISS /.test(line)) rejected = true;
          options.log?.(line);
        },
      });
      const port = await recorder.listen(0, '127.0.0.1');
      await recordMinimalJoin(`http://127.0.0.1:${port}`, options, plan);
      const stats = recorder.stats();
      await recorder.close();
      recorder = undefined;
      if (rejected || stats.misses || stats.redacted)
        throw new Error('CPP native recorder rejected an upstream response');
      const recorded = readScreenshotFixtureManifest(recording);
      if (!recorded) return fail();
      completed = recorded;
    } else {
      await authenticateNativeOwner(upstream, options, plan);
    }
    const key = graphqlFixtureKey(plan.nativeJoin, digest);
    const native = recordedNativeJoin(completed, (file) => readCppBackgroundFile(recording, file), plan);
    if (!native) throw new Error('CPP native minimal join was not genuinely recorded');
    const { entry: nativeEntry, fixture: nativeFixture } = native;
    const instants: string[] = [];
    for (const request of plan.requests) {
      const existing = completed.static.find((entry) => `${entry.path}?${entry.query}` === request);
      if (existing) {
        if (!existing.response) return fail();
        assertCppNegativeStaticEntry(
          existing,
          readFileSync(join(recording, existing.file)),
          plan,
          sources,
          completed.frozenNow,
        );
        continue;
      }
      const received = await fetchCppUnsupportedRender(upstream, request, plan);
      const url = new URL(request, upstream);
      const file = `static/${staticFixtureKey(url.pathname, url.searchParams, digest)}.json`;
      mkdirSync(join(recording, 'static'), { recursive: true });
      writeFileSync(join(recording, file), received.bytes, { flag: 'wx' });
      const recordedAt = new Date().toISOString();
      const entry: StaticManifestEntry = {
        path: url.pathname,
        query: sortedQueryString(url.searchParams),
        file,
        contentType: received.contentType,
        bytes: received.bytes.length,
        response: { status: 400, recordedAt, sha256: digest(received.bytes), sources },
      };
      completed.static.push(entry);
      instants.push(recordedAt);
      options.log?.(
        `CPP native unsupported render evidence: ${JSON.stringify({ request, ...received, bytes: received.bytes.length, file, ...entry.response })}`,
      );
    }
    completed.frozenNow = finalizeRecordingFrozenNow(completed.frozenNow, instants);
    for (const instant of instants)
      if (Date.parse(instant) > Date.parse(completed.recordedAt)) completed.recordedAt = instant;
    writeFileSync(join(recording, 'manifest.json'), JSON.stringify(completed, null, 2) + '\n');
    for (const [file, hash] of originalHashes)
      if (
        digest(readFileSync(join(input, file))) !== hash ||
        (file !== 'manifest.json' && digest(readFileSync(join(recording, file))) !== hash)
      )
        throw new Error('CPP native preparation changed an original file');
    if (hashes(input).size !== originalHashes.size)
      throw new Error('CPP native preparation changed original inventory');
    const incoming = completed.graphql.filter(
      (entry) => !original.graphql.some((previous) => canonicalJson(previous) === canonicalJson(entry)),
    );
    if (incoming.some((entry) => entry.file !== nativeEntry.file && entry.operationName !== 'CppBootstrapProfile'))
      return fail();
    for (const entry of incoming.filter((entry) => entry.operationName === 'CppBootstrapProfile')) {
      const fixture = JSON.parse(readCppBackgroundFile(recording, entry.file).toString('utf8')) as GraphqlFixtureFile;
      const expected = graphqlFixtureKey(
        { operationName: 'CppBootstrapProfile', query: CPP_BOOTSTRAP_PROFILE_QUERY, variables: {} },
        digest,
      );
      const actual = graphqlFixtureKey(fixture, digest);
      if (
        fixture.status !== 200 ||
        fixture.upstream !== upstream ||
        entry.documentHash !== expected.documentHash ||
        entry.variablesHash !== expected.variablesHash ||
        actual.documentHash !== expected.documentHash ||
        actual.variablesHash !== expected.variablesHash ||
        responseField(fixture, 'profile').id !== plan.accountUserId
      )
        return fail();
    }
    const stableMetadata = (manifest: ScreenshotFixtureManifest) => {
      const {
        recordedAt: _recordedAt,
        frozenNow: _frozenNow,
        graphql: _graphql,
        static: _static,
        ...stable
      } = manifest;
      return canonicalJson(stable);
    };
    if (
      stableMetadata(original) !== stableMetadata(completed) ||
      original.graphql.some(
        (entry) => !completed.graphql.some((candidate) => canonicalJson(entry) === canonicalJson(candidate)),
      ) ||
      original.static.some(
        (entry) => !completed.static.some((candidate) => canonicalJson(entry) === canonicalJson(candidate)),
      )
    )
      return fail();
    const completedFixtures = completed.graphql.map(
      (entry) => JSON.parse(readFileSync(join(recording, entry.file), 'utf8')) as GraphqlFixtureFile,
    );
    resolveCppNativeBackgroundPlan(completed, completedFixtures);
    assertCppNegativeFixtureFiles(completed, (file) => readCppBackgroundFile(recording, file));
    options.log?.(
      `CPP native minimal join evidence: ${JSON.stringify({ file: nativeEntry.file, sha256: digest(readFileSync(join(recording, nativeEntry.file))), documentHash: key.documentHash, variablesHash: key.variablesHash, recordedAt: nativeFixture.recordedAt, sources })}`,
    );
    return await prepare(recording);
  } finally {
    try {
      await recorder?.close();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
